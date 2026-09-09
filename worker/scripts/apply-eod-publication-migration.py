"""Apply only market migration 0008 through D1's atomic statement batch.

Python 3.11+. Dry-run by default; credentials are read only from the environment.
This bypasses the remote multi-statement string parser that rejects the triggers.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tomllib
from typing import Any
import urllib.error
import urllib.request


WORKER_ROOT = Path(__file__).resolve().parent.parent
MIGRATION_NAME = "0008_eod_publications.sql"
PRIOR_MIGRATIONS = (
    "0001_market_data.sql", "0002_operational_retention.sql", "0003_freshness_core.sql",
    "0004_post_close_job_provenance.sql", "0005_resumable_overview_current_refresh.sql",
    "0006_feature_input_provenance.sql", "0007_market_publication_state.sql",
)
TABLE_COLUMNS = {
    "market_calendar_refresh_state": {"id", "covered_start", "covered_end", "verified_at"},
    "eod_publications": {"id", "scope", "session_date", "revision", "input_hash", "methodology_version",
                         "payload_json", "payload_checksum", "payload_codec", "payload_base64", "status", "created_at", "accepted_at"},
    "eod_publication_pointers": {"scope", "publication_id", "session_date", "published_at"},
    "eod_input_revisions": {"feed", "ticker", "revision", "semantic_revision", "last_correction_revision",
                            "append_high_water_date", "append_epoch_start_revision", "append_epoch_start_date", "updated_at"},
    "eod_input_clock": {"id", "revision"},
    "eod_adjustment_repairs": {"feed", "ticker", "status", "owner_token", "start_date", "updated_at"},
    "eod_history_relocations": {"feed", "ticker", "date", "operation_id", "bar_identity"},
}
TRIGGERS = {
    "eod_revision_clock_insert", "eod_revision_clock_update", "eod_revision_clock_delete",
    "eod_bar_insert", "eod_bar_update", "eod_bar_delete",
}
NEW_OBJECTS = {**{name: "table" for name in TABLE_COLUMNS}, **{name: "trigger" for name in TRIGGERS},
               "idx_eod_publications_history": "index"}
ADDED_COLUMNS = {
    "alpaca_daily_bars": {"reported_volume", "reported_volume_collected_at"},
    "daily_market_features": {"input_revision"},
}
BASE_TABLES = {"alpaca_daily_bars", "daily_market_features", "d1_migrations"}
BASE_COLUMNS = {
    "alpaca_daily_bars": {"feed", "ticker", "date", "o", "h", "l", "c", "volume",
                          "source_provider", "adjustment", "observed_at", "fetched_at"},
    "daily_market_features": {"feed", "ticker", "session_date", "source_provider", "computed_at"},
}


class MigrationError(RuntimeError):
    pass


def without_comments(sql: str) -> str:
    return re.sub(r"(?m)^\s*--[^\r\n]*", "", sql).strip()


def parse_migration(source: str) -> list[str]:
    statements: list[str] = []
    pending = ""
    for character in source:
        pending += character
        if character == ";" and sqlite3.complete_statement(pending):
            statements.append(pending.strip())
            pending = ""
    if without_comments(pending):
        raise MigrationError("Migration has an incomplete trailing statement.")
    if len(statements) != 18:
        raise MigrationError("Only the reviewed 18-statement migration 0008 is supported.")
    objects: dict[str, str] = {}
    alterations: set[tuple[str, str]] = set()
    clock_inserts = 0
    for statement in statements:
        sql = without_comments(statement)
        created = re.match(r"CREATE (TABLE|INDEX|TRIGGER) IF NOT EXISTS (\w+)\b", sql)
        altered = re.fullmatch(r"ALTER TABLE (alpaca_daily_bars|daily_market_features) ADD COLUMN (\w+) (REAL|TEXT|INTEGER);", sql)
        if created:
            kind, name = created.group(1).lower(), created.group(2)
            if NEW_OBJECTS.get(name) != kind or name in objects:
                raise MigrationError("Unexpected or duplicate migration object.")
            objects[name] = kind
        elif altered:
            alterations.add((altered.group(1), altered.group(2)))
        elif sql == "INSERT INTO eod_input_clock(id,revision) VALUES('default',0) ON CONFLICT(id) DO NOTHING;":
            clock_inserts += 1
        else:
            raise MigrationError("Migration contains an unsupported top-level operation.")
    expected_alterations = {(table, column) for table, columns in ADDED_COLUMNS.items() for column in columns}
    if objects != NEW_OBJECTS or alterations != expected_alterations or clock_inserts != 1:
        raise MigrationError("Migration object/column manifest differs from reviewed 0008.")
    if sum(kind == "trigger" for kind in objects.values()) != 6:
        raise MigrationError("All six revision triggers are required.")
    return statements


def configured_target(account_id: str, database_id: str, config: dict[str, Any]) -> dict[str, str]:
    if not re.fullmatch(r"[a-fA-F0-9]{32}", account_id):
        raise MigrationError("An explicit valid Cloudflare account ID is required.")
    if not re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", database_id):
        raise MigrationError("An explicit valid market database UUID is required.")
    bindings = [binding for binding in config.get("d1_databases", []) if binding.get("binding") == "MARKET_DATA_DB"]
    if len(bindings) != 1 or bindings[0].get("database_id") != database_id:
        raise MigrationError("Database UUID must match worker/wrangler.toml MARKET_DATA_DB exactly.")
    name = bindings[0].get("database_name")
    if not isinstance(name, str) or not name:
        raise MigrationError("Configured market database name is missing.")
    return {"account_id": account_id, "database_id": database_id, "database_name": name}


class CloudflareClient:
    def __init__(self, target: dict[str, str], token: str):
        self.base = f"https://api.cloudflare.com/client/v4/accounts/{target['account_id']}/d1/database/{target['database_id']}"
        self.token = token
        self.rows_read = 0
        self.rows_written = 0

    def request(self, suffix: str = "", payload: dict[str, Any] | None = None) -> Any:
        request = urllib.request.Request(self.base + suffix,
            data=None if payload is None else json.dumps(payload).encode("utf8"),
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            method="GET" if payload is None else "POST")
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                body = json.load(response)
        except urllib.error.HTTPError as error:
            raise MigrationError(f"Cloudflare HTTP {error.code}; no automatic retry. Rerun dry-run to inspect migration state.") from None
        except (urllib.error.URLError, TimeoutError, ValueError):
            raise MigrationError("Cloudflare response unavailable or invalid; outcome may be unknown. Rerun dry-run before applying again.") from None
        if not isinstance(body, dict) or body.get("success") is not True or "result" not in body:
            raise MigrationError("Cloudflare request did not return a successful result; no automatic retry.")
        return body["result"]

    def identity(self) -> dict[str, Any]:
        result = self.request()
        if not isinstance(result, dict):
            raise MigrationError("Cloudflare database identity is malformed.")
        return result

    def batch(self, queries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # A JSON batch keeps each complete CREATE TRIGGER intact and includes
        # Wrangler's ledger insertion in the same D1 transaction.
        results = self.request("/query", {"batch": queries})
        if not isinstance(results, list) or len(results) != len(queries) or any(
            not isinstance(result, dict) or result.get("success") is not True for result in results
        ):
            raise MigrationError("D1 batch did not return every successful statement; inspect state before retrying.")
        for result in results:
            meta = result.get("meta", {})
            for field in ("rows_read", "rows_written"):
                value = meta.get(field)
                if type(value) is not int or value < 0:
                    raise MigrationError("D1 query usage metadata is incomplete; inspect state before retrying.")
                setattr(self, field, getattr(self, field) + value)
        return results


def preflight(client: Any) -> str:
    names = sorted(BASE_TABLES | set(NEW_OBJECTS))
    schema = client.batch([{"sql": f"SELECT name,type FROM sqlite_schema WHERE name IN ({','.join('?' for _ in names)})", "params": names}])[0]["results"]
    objects = {row["name"]: row["type"] for row in schema}
    if any(objects.get(name) != "table" for name in BASE_TABLES):
        raise MigrationError("Required market tables or Wrangler migration ledger are missing.")
    tables = sorted(set(TABLE_COLUMNS) | set(ADDED_COLUMNS))
    ledger_names = [*PRIOR_MIGRATIONS, MIGRATION_NAME]
    queries = [{"sql": f"SELECT name FROM d1_migrations WHERE name IN ({','.join('?' for _ in ledger_names)})", "params": ledger_names}]
    queries += [{"sql": f"PRAGMA table_info({table})", "params": []} for table in tables]
    results = client.batch(queries)
    ledger = [row["name"] for row in results[0]["results"]]
    if len(set(ledger)) != len(ledger) or not set(PRIOR_MIGRATIONS).issubset(ledger):
        raise MigrationError("Prior migrations 0001–0007 must each be recorded exactly once.")
    columns = {table: {row["name"] for row in result["results"]} for table, result in zip(tables, results[1:])}
    if any(not required.issubset(columns[table]) for table, required in BASE_COLUMNS.items()):
        raise MigrationError("Required prior market-schema columns are missing.")
    if MIGRATION_NAME in ledger:
        if any(objects.get(name) != kind for name, kind in NEW_OBJECTS.items()) or any(
            not required.issubset(columns[table]) for table, required in {**TABLE_COLUMNS, **ADDED_COLUMNS}.items()
        ):
            raise MigrationError("Migration ledger says applied but required objects/columns are missing; refusing to replay.")
        return "already-applied"
    if any(name in objects for name in NEW_OBJECTS) or any(columns[table] & added for table, added in ADDED_COLUMNS.items()):
        raise MigrationError("Partial migration schema exists without its ledger entry; inspect and reconcile manually.")
    return "pending"


def run(client: Any, target: dict[str, str], source: str, apply: bool = False) -> dict[str, Any]:
    statements = parse_migration(source)
    identity = client.identity()
    if identity.get("uuid") != target["database_id"] or identity.get("name") != target["database_name"]:
        raise MigrationError("Remote database UUID/name does not match the explicit configured target.")
    state = preflight(client)
    if state == "pending" and apply:
        queries = [{"sql": statement, "params": []} for statement in statements]
        queries.append({"sql": "INSERT INTO d1_migrations(name) VALUES(?)", "params": [MIGRATION_NAME]})
        client.batch(queries)
        if preflight(client) != "already-applied":
            raise MigrationError("Post-application verification did not establish the complete migration.")
        state = "applied"
    return {"status": state if state != "pending" else "dry-run", "migration": MIGRATION_NAME,
            "databaseId": target["database_id"], "databaseName": target["database_name"],
            "migrationStatements": len(statements), "triggerCount": len(TRIGGERS),
            "sourceSha256": hashlib.sha256(source.encode("utf8")).hexdigest(),
            "rowsRead": client.rows_read, "rowsWritten": client.rows_written}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account-id", default=os.environ.get("CLOUDFLARE_ACCOUNT_ID"))
    parser.add_argument("--database-id", required=True, help="Must match the checked-in MARKET_DATA_DB binding.")
    parser.add_argument("--token-env", default="CLOUDFLARE_API_TOKEN", help="Name of the environment variable holding the token.")
    parser.add_argument("--apply", action="store_true", help="Apply pending 0008 and its ledger row atomically; otherwise only verify.")
    args = parser.parse_args()
    try:
        config = tomllib.loads((WORKER_ROOT / "wrangler.toml").read_text(encoding="utf8"))
        target = configured_target(args.account_id or "", args.database_id, config)
        token = os.environ.get(args.token_env, "").strip()
        if not token:
            raise MigrationError("The selected token environment variable is empty.")
        source = (WORKER_ROOT / "market-data-migrations" / MIGRATION_NAME).read_text(encoding="utf8")
        print(json.dumps(run(CloudflareClient(target, token), target, source, args.apply), indent=2))
        return 0
    except (MigrationError, OSError, tomllib.TOMLDecodeError) as error:
        print(f"Migration stopped: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
