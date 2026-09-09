"""Isolated operator-helper tests. Never access a remote database or credentials."""
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch
import urllib.error


SCRIPT = Path(__file__).resolve().parents[1] / "apply-eod-publication-migration.py"
SPEC = importlib.util.spec_from_file_location("eod_migration", SCRIPT)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)
SOURCE = (helper.WORKER_ROOT / "market-data-migrations" / helper.MIGRATION_NAME).read_text(encoding="utf8")
TARGET = {"account_id": "a" * 32, "database_id": "11111111-2222-3333-4444-555555555555", "database_name": "market_prices"}


class LocalClient:
    def __init__(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.calls = []
        self.rows_read = 0
        self.rows_written = 0
        self.remote_identity = {"uuid": TARGET["database_id"], "name": TARGET["database_name"]}
        self.fail_ledger = False
        for name in helper.PRIOR_MIGRATIONS:
            self.db.executescript((helper.WORKER_ROOT / "market-data-migrations" / name).read_text(encoding="utf8"))
        self.db.execute("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT DEFAULT CURRENT_TIMESTAMP)")
        self.db.executemany("INSERT INTO d1_migrations(name) VALUES(?)", [(name,) for name in helper.PRIOR_MIGRATIONS])
        self.db.commit()

    def identity(self):
        return self.remote_identity

    def batch(self, queries):
        self.calls.append(queries)
        results = []
        self.db.execute("BEGIN")
        try:
            for query in queries:
                if self.fail_ledger and query["sql"].startswith("INSERT INTO d1_migrations"):
                    raise sqlite3.IntegrityError("Simulated ledger failure")
                before = self.db.total_changes
                cursor = self.db.execute(query["sql"], query["params"])
                rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
                read, written = len(rows), self.db.total_changes - before
                self.rows_read += read
                self.rows_written += written
                results.append({"success": True, "results": rows, "meta": {"rows_read": read, "rows_written": written}})
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return results


class MigrationHelperTests(unittest.TestCase):
    def setUp(self):
        self.client = LocalClient()

    def tearDown(self):
        self.client.db.close()

    def test_parser_keeps_all_six_triggers_complete_under_both_line_endings(self):
        # These spellings broke Wrangler's token heuristics. SQLite's own
        # completion parser must accept both before and after that workaround.
        for source in [SOURCE, SOURCE.replace("END ,", "END,").replace("= CASE", "=CASE")]:
            for ending in ["\n", "\r\n"]:
                statements = helper.parse_migration(source.replace("\r\n", "\n").replace("\n", ending))
                self.assertEqual(len(statements), 18)
                self.assertEqual(sum("CREATE TRIGGER" in sql for sql in statements), 6)

    def test_rejects_incomplete_and_unreviewed_operations(self):
        for source in [SOURCE + "SELECT 1", SOURCE + "SELECT 1;", SOURCE.replace("eod_bar_insert", "unexpected_trigger")]:
            with self.assertRaises(helper.MigrationError):
                helper.parse_migration(source)

    def test_target_must_match_explicit_configured_market_binding(self):
        config = {"d1_databases": [{"binding": "MARKET_DATA_DB", "database_id": TARGET["database_id"], "database_name": "market_prices"}]}
        self.assertEqual(helper.configured_target(TARGET["account_id"], TARGET["database_id"], config), TARGET)
        for account, database in [("bad", TARGET["database_id"]), (TARGET["account_id"], "bad"), (TARGET["account_id"], "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")]:
            with self.assertRaises(helper.MigrationError):
                helper.configured_target(account, database, config)

    def test_remote_identity_mismatch_stops_before_schema_queries(self):
        self.client.remote_identity["name"] = "market_command"
        with self.assertRaisesRegex(helper.MigrationError, "UUID/name"):
            helper.run(self.client, TARGET, SOURCE, apply=True)
        self.assertEqual(self.client.calls, [])

    def test_default_run_is_read_only(self):
        result = helper.run(self.client, TARGET, SOURCE)
        self.assertEqual(result["status"], "dry-run")
        self.assertEqual(result["rowsWritten"], 0)
        self.assertTrue(all(query["sql"].startswith(("SELECT", "PRAGMA table_info")) for call in self.client.calls for query in call))
        self.assertEqual(helper.preflight(self.client), "pending")

    def test_apply_is_one_atomic_batch_and_next_apply_is_a_verified_noop(self):
        self.assertEqual(helper.run(self.client, TARGET, SOURCE, apply=True)["status"], "applied")
        mutations = [call for call in self.client.calls if len(call) == 19]
        self.assertEqual(len(mutations), 1)
        self.assertEqual(mutations[0][-1], {"sql": "INSERT INTO d1_migrations(name) VALUES(?)", "params": [helper.MIGRATION_NAME]})
        calls_before = len(self.client.calls)
        self.assertEqual(helper.run(self.client, TARGET, SOURCE, apply=True)["status"], "already-applied")
        self.assertTrue(all(query["sql"].startswith(("SELECT", "PRAGMA table_info")) for call in self.client.calls[calls_before:] for query in call))

    def test_ledger_failure_rolls_back_all_migration_objects_and_columns(self):
        self.client.fail_ledger = True
        with self.assertRaises(sqlite3.IntegrityError):
            helper.run(self.client, TARGET, SOURCE, apply=True)
        self.assertEqual(helper.preflight(self.client), "pending")

    def test_missing_prior_migration_blocks_application(self):
        self.client.db.execute("DELETE FROM d1_migrations WHERE name=?", [helper.PRIOR_MIGRATIONS[-1]])
        self.client.db.commit()
        with self.assertRaisesRegex(helper.MigrationError, "0001–0007"):
            helper.run(self.client, TARGET, SOURCE, apply=True)

    def test_partial_schema_without_ledger_blocks_application(self):
        self.client.db.execute("ALTER TABLE alpaca_daily_bars ADD COLUMN reported_volume REAL")
        with self.assertRaisesRegex(helper.MigrationError, "Partial migration"):
            helper.run(self.client, TARGET, SOURCE, apply=True)

    def test_inconsistent_applied_ledger_is_not_a_successful_noop(self):
        helper.run(self.client, TARGET, SOURCE, apply=True)
        self.client.db.execute("DROP TRIGGER eod_bar_insert")
        with self.assertRaisesRegex(helper.MigrationError, "ledger says applied"):
            helper.run(self.client, TARGET, SOURCE)

    def test_client_sends_explicit_batch_object_and_reports_usage(self):
        client = helper.CloudflareClient(TARGET, "test-token-never-log")
        result = {"success": True, "result": [{"success": True, "results": [], "meta": {"rows_read": 3, "rows_written": 2}}]}
        with patch.object(helper.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(result).encode())) as request:
            client.batch([{"sql": "SELECT 1", "params": []}])
        self.assertEqual(json.loads(request.call_args.args[0].data), {"batch": [{"sql": "SELECT 1", "params": []}]})
        self.assertEqual((client.rows_read, client.rows_written), (3, 2))

    def test_network_error_is_not_retried_or_logged_with_secrets(self):
        client = helper.CloudflareClient(TARGET, "test-token-never-log")
        error = urllib.error.HTTPError(client.base, 503, "private upstream data", {}, None)
        with patch.object(helper.urllib.request, "urlopen", side_effect=error) as request:
            with self.assertRaises(helper.MigrationError) as raised:
                client.batch([{"sql": "SELECT 1", "params": []}])
        self.assertEqual(request.call_count, 1)
        self.assertNotIn("private", str(raised.exception))
        self.assertNotIn("test-token", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
