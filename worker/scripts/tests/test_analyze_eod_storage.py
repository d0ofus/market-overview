"""Offline fixtures only: no Cloudflare/provider calls and no real credentials."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "analyze-eod-storage.py"
SPEC = importlib.util.spec_from_file_location("eod_storage_analysis", SCRIPT)
analysis = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(analysis)


class OfflineStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="eod-offline-fixture-")
        self.path = Path(self.temporary.name) / "source.sqlite"
        self.db = sqlite3.connect(self.path)
        for migration in sorted((analysis.ROOT / "market-data-migrations").glob("*.sql")):
            self.db.executescript(migration.read_text(encoding="utf8"))
        self.db.execute("CREATE TABLE retained_custom_state(id TEXT PRIMARY KEY,value TEXT)")
        self.db.execute("CREATE INDEX retained_custom_state_value ON retained_custom_state(value)")
        self.db.execute("INSERT INTO retained_custom_state VALUES('owned','do not discard')")
        for feed, ticker, day in [
            ("sip", "AAA", "2025-12-31"), ("sip", "AAA", "2026-09-07"), ("sip", "AAA", "2026-09-08"),
            ("sip", "BBB", "2024-01-02"), ("iex", "AAA", "2026-09-08"),
            ("repair-yahoo", "AAA", "2025-12-31"),
        ]:
            self.db.execute("""INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume,reported_volume,source_provider,
              adjustment,observed_at,fetched_at,reported_volume_collected_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
              (feed,ticker,day,10.125,11.25,9.25,10.5,1234.5,4321.0,"yahoo" if feed=="repair-yahoo" else "alpaca",
               "split","2026-09-09T01:00:00Z","2026-09-09T01:00:00Z","2026-09-09T01:00:00Z"))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.temporary.cleanup()

    def test_archive_first_analysis_uses_real_codec_and_keeps_source_unchanged(self):
        before = analysis.digest_file(self.path)
        report = analysis.analyze(self.path, ["AAA", "MISSING"], "2026-09-08", publication_reserve=1_000_000)
        self.assertEqual(analysis.digest_file(self.path), before)
        self.assertEqual(report["archive"]["sourceRows"], 6)
        self.assertEqual(report["archive"]["checkedSourceRows"], 6)
        self.assertEqual(report["archive"]["sourceRowsByFeed"], {"iex":1,"repair-yahoo":1,"sip":4})
        self.assertTrue(report["archive"]["storageRoundTripPassed"])
        self.assertEqual(report["bootstrap"]["recentRowsToInsert"], 4)
        self.assertIn("retained_custom_state", report["bootstrap"]["database"]["objects"])
        self.assertIn("retained_custom_state_value", report["bootstrap"]["database"]["objects"])
        self.assertEqual([model["modeledSipRows"] for model in report["retentionModels"]], [540,200])
        self.assertEqual([model["modeledFallbackRows"] for model in report["retentionModels"]], [540,200])
        self.assertEqual([model["preservedOtherFeedOrNonSharedSeedRows"] for model in report["retentionModels"]], [3,3])
        self.assertEqual(report["population"]["targetSessionSipMissing"], ["MISSING"])
        self.assertFalse(report["consumerParity"]["verified"])
        self.assertFalse(report["productionAcceptance"]["verified"])
        for model in report["retentionModels"]:
            self.assertEqual(model["projectedBytes"], model["database"]["physicalBytes"]+1_000_000)
            self.assertGreater(model["database"]["priceTableAndIndexBytes"], 0)

    def test_seed_preserves_all_schema_objects_and_nonprice_rows(self):
        self.db.row_factory = sqlite3.Row
        seed = analysis.make_seed(self.db, Path(self.temporary.name)/"seed.sqlite", "2026-09-08")
        try:
            original = list(self.db.execute("SELECT name,type,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name"))
            rebuilt = list(seed.execute("SELECT name,type,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name"))
            self.assertEqual(original, rebuilt)
            self.assertEqual(seed.execute("SELECT value FROM retained_custom_state").fetchone()[0], "do not discard")
            self.assertEqual(list(seed.execute("SELECT * FROM eod_input_revisions ORDER BY feed,ticker")),
                             list(self.db.execute("SELECT * FROM eod_input_revisions ORDER BY feed,ticker")))
        finally:
            seed.close()

    def test_full_population_manifest_accepts_frozen_run_and_rejects_duplicates(self):
        path = Path(self.temporary.name)/"tickers.json"
        path.write_text(json.dumps({"input_json": json.dumps({"tickers":["AAA","BRK.B","MISSING"]})}))
        self.assertEqual(analysis.load_tickers(path), ["AAA","BRK.B","MISSING"])
        path.write_text(json.dumps(["AAA","aaa"]))
        with self.assertRaises(analysis.AnalysisError):
            analysis.load_tickers(path)

    def test_incompatible_source_columns_fail_before_any_archive_claim(self):
        self.db.execute("ALTER TABLE alpaca_daily_bars ADD COLUMN unknown_payload TEXT")
        self.db.commit()
        with self.assertRaisesRegex(analysis.AnalysisError, "incompatible columns"):
            analysis.analyze(self.path, ["AAA"], "2026-09-08")

    def test_report_includes_existing_archive_and_verifies_its_blocks(self):
        history = Path(self.temporary.name)/"history.sqlite"
        archive = sqlite3.connect(history)
        archive.row_factory = sqlite3.Row
        archive.executescript((analysis.ROOT/"history-migrations/0001_history.sql").read_text())
        self.db.row_factory = sqlite3.Row
        codec = analysis.Codec()
        try:
            analysis.archive_all(self.db, archive, codec, "2026-09-09T01:00:00Z")
        finally:
            codec.close()
            archive.close()
        before = analysis.digest_file(history)
        report = analysis.analyze(self.path, ["AAA"], "2026-09-08", history_path=history)
        self.assertGreater(report["archive"]["existingBlocksVerified"], 0)
        self.assertEqual(report["archive"]["newBlocks"], 0)
        self.assertEqual(analysis.digest_file(history), before)

    def test_archive_orphan_pointer_outside_source_population_is_rejected(self):
        history = sqlite3.connect(":memory:")
        history.row_factory = sqlite3.Row
        history.executescript((analysis.ROOT/"history-migrations/0001_history.sql").read_text())
        history.execute("""INSERT INTO market_history_block_pointers(feed,ticker,calendar_year,block_id)
          VALUES('sip','NOT_IN_SOURCE',2020,'missing-block')""")
        try:
            with self.assertRaisesRegex(analysis.AnalysisError, "pointed block"):
                analysis.archive_all(self.db, history, None, "2026-09-09T01:00:00Z")
        finally:
            history.close()

    def test_logical_snapshot_metadata_excludes_local_bookkeeping_and_refuses_partial(self):
        self.db.execute("CREATE TABLE _storage_snapshot_progress(name TEXT PRIMARY KEY,complete INTEGER)")
        tables = [row[0] for row in self.db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'_storage_snapshot_progress'")]
        self.db.executemany("INSERT INTO _storage_snapshot_progress VALUES(?,1)", [(name,) for name in tables])
        self.db.commit()
        metadata = Path(str(self.path)+".metadata.json")
        metadata.write_text(json.dumps({"complete":False,"consistentFrozenCapture":False}))
        with self.assertRaisesRegex(analysis.AnalysisError, "incomplete"):
            analysis.analyze(self.path, ["AAA"], "2026-09-08")
        partial = analysis.analyze(self.path, ["AAA"], "2026-09-08", allow_partial=True, fallback_reserve=0)
        self.assertIsNone(partial["storageOnlyRecommendedHotSessions"])
        self.assertTrue(partial["source"]["capture"]["partialEstimate"])
        self.assertNotIn("_storage_snapshot_progress", partial["source"]["database"]["objects"])
        self.assertEqual(partial["retentionModels"][0]["modeledFallbackRows"], 0)
        metadata.write_text(json.dumps({"complete":True,"consistentFrozenCapture":False}))
        report = analysis.analyze(self.path, ["AAA"], "2026-09-08")
        self.assertFalse(report["source"]["capture"]["partialEstimate"])
        self.assertFalse(report["source"]["capture"]["remoteCaptureConsistencyVerified"])
        self.assertTrue(self.db.execute("SELECT 1 FROM sqlite_schema WHERE name='_storage_snapshot_progress'").fetchone())

    def test_logical_snapshot_missing_table_checkpoint_is_incomplete_even_with_complete_sidecar(self):
        self.db.execute("CREATE TABLE _storage_snapshot_progress(name TEXT PRIMARY KEY,complete INTEGER)")
        self.db.commit()
        Path(str(self.path)+".metadata.json").write_text(json.dumps({"complete":True}))
        with self.assertRaisesRegex(analysis.AnalysisError, "incomplete"):
            analysis.analyze(self.path, ["AAA"], "2026-09-08")

    def test_file_page_mapper_includes_overflow_interior_without_rowid_and_free_pages(self):
        path = Path(self.temporary.name)/"pages.sqlite"
        db = sqlite3.connect(path)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA page_size=1024")
            db.executescript("""CREATE TABLE wide_rows(id INTEGER PRIMARY KEY,value TEXT);
              CREATE INDEX wide_index ON wide_rows(value);
              CREATE TABLE keyed_rows(id TEXT PRIMARY KEY,value TEXT) WITHOUT ROWID;""")
            rows = [(index, f"{index:08d}:" + "x"*4500) for index in range(300)]
            db.executemany("INSERT INTO wide_rows VALUES(?,?)", rows)
            db.executemany("INSERT INTO keyed_rows VALUES(?,?)", rows)
            db.execute("DELETE FROM wide_rows WHERE id<100")
            db.commit()
            sizes = analysis.btree_sizes(db)
            page_count = db.execute("PRAGMA page_count").fetchone()[0]
            free_pages = db.execute("PRAGMA freelist_count").fetchone()[0]
            self.assertGreater(free_pages, 0)
            self.assertEqual(sum(sizes.values()) + free_pages*1024, page_count*1024)
            for name in ("wide_rows", "wide_index", "keyed_rows"):
                self.assertGreater(sizes[name], 500_000)
            try:
                reference = {row["name"]:row["bytes"] for row in db.execute("SELECT name,SUM(pgsize) AS bytes FROM dbstat GROUP BY name")}
            except sqlite3.OperationalError:
                reference = None
            if reference is not None:
                self.assertEqual(sizes, reference)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
