"""Real codec/schema forecast fixtures; every price below is synthetic."""
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from test_analyze_eod_storage import analysis


class CurrentArchiveForecastTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="eod-current-model-")
        self.path = Path(self.tmp.name)
        self.source = sqlite3.connect(self.path / "source.sqlite")
        self.source.execute("CREATE TABLE alpaca_daily_bars(feed TEXT,ticker TEXT,date TEXT)")
        self.source.execute("INSERT INTO alpaca_daily_bars VALUES('sip','AAA','2026-12-01')")
        self.source.commit()
        self.archive = sqlite3.connect(self.path / "history.sqlite")
        self.archive.row_factory = sqlite3.Row
        for migration in sorted((analysis.ROOT / "history-migrations").glob("*.sql")):
            self.archive.executescript(migration.read_text())
        self.codec = analysis.Codec()

    def tearDown(self):
        self.codec.close()
        self.source.close()
        self.archive.close()
        self.tmp.cleanup()

    def block(self, day, value):
        bars = [{"ticker":"AAA","date":day,"o":value,"h":value+1,"l":value-1,"c":value,
                 "volume":10,"reportedVolume":None,"feed":"sip","sourceProvider":"alpaca","adjustment":"split",
                 "observedAt":"2026-09-01T00:00:00.000Z","fetchedAt":"2026-09-01T00:00:00.000Z"}]
        block = self.codec.call({"bars":bars})["block"]
        values = (block["id"],"sip","AAA",int(day[:4]),block["schemaVersion"],block["codec"],block["checksum"],block["rowCount"],
                  block["firstDate"],block["lastDate"],block["uncompressedBytes"],block["payloadBase64"],"2026-09-01T00:00:00Z","2026-09-01T00:00:00Z")
        self.archive.execute(f"INSERT INTO market_history_blocks({','.join(analysis.BLOCK_FIELDS)}) VALUES({','.join('?' for _ in values)})",values)
        return block["id"]

    def context(self):
        cursor = date(2026,12,1)
        dates = []
        while len(dates) < 1400:
            if cursor.weekday() < 5:
                dates.append(cursor.isoformat())
            cursor -= timedelta(days=1)
        future=[]
        cursor=date(2026,12,1)
        while len(future)<40:
            cursor+=timedelta(days=1)
            if cursor.weekday()<5:
                future.append(cursor.isoformat())
        unsigned = {"version":1,"policy":analysis.CURRENT_ARCHIVE_POLICY,"historySnapshotSha256":analysis.digest_file(self.path/"history.sqlite"),
          "historyCaptureHash":"a"*64,"historyCapturedAt":"2026-09-01T00:00:00Z","historyReceiptHash":"b"*64,
          "historyPhysicalBytes":(self.path/"history.sqlite").stat().st_size+4096,"historyPhysicalMeasuredAt":"2026-09-01T01:00:00Z",
          "sourceSnapshotSha256":analysis.digest_file(self.path/"source.sqlite"),"copySourceRows":2,"forecastSessionDate":"2026-12-01",
          "calendarDates":sorted(dates),"forecastCalendarDates":future,"tickerHash":hashlib.sha256(b'["AAA"]').hexdigest(),
          "authorization":{"kind":"population-expansion","evidenceHash":"c"*64,"codeRevision":"d"*40}}
        return {**unsigned,"evidenceHash":hashlib.sha256(json.dumps(unsigned,separators=(",",":")).encode()).hexdigest()}

    def test_two_generations_preserve_orphans_and_old_dates_with_real_indexes_and_allocation(self):
        old = self.block("2020-01-02",10)
        previous = self.block("2020-01-02",11)
        orphan = self.block("2019-01-02",12)
        self.archive.execute("INSERT INTO market_history_block_pointers VALUES('sip','AAA',2020,?,?,?)",(old,previous,"2026-09-01T00:00:00Z"))
        self.archive.execute("CREATE TABLE retained_slack(value BLOB)")
        self.archive.execute("INSERT INTO retained_slack VALUES(zeroblob(1000000))")
        self.archive.execute("DELETE FROM retained_slack")
        self.archive.commit()
        before = analysis.measure(self.archive)
        trace = []
        self.archive.set_trace_callback(trace.append)
        result = analysis.archive_current_forecast(self.source,self.archive,self.codec,["AAA"],self.context(),"2026-09-12T00:00:00Z")
        model = result["currentArchiveForecast"]
        self.assertEqual((result["sourceRows"],result["verifiedCopySourceRows"],result["checkedSourceRows"]),(1,2,0))
        self.assertFalse(result["sourceOverlayApplied"])
        self.assertEqual(model["existingOrphanBlocks"],1)
        self.assertEqual(model["preservedOrphanBlocks"],1)
        self.assertTrue(self.archive.execute("SELECT 1 FROM market_history_blocks WHERE id=?",(orphan,)).fetchone())
        self.assertFalse(self.archive.execute("SELECT 1 FROM market_history_blocks WHERE id=?",(previous,)).fetchone())
        self.assertEqual(model["primaryModeledSessions"],300)
        self.assertEqual(model["fallbackModeledSessions"],320)
        self.assertEqual(model["futureRevisionGenerations"],2)
        self.assertGreater(model["phases"][1]["insertedBlocks"],model["phases"][0]["insertedBlocks"])
        self.assertEqual(model["baselinePhysicalBytes"],before["physicalBytes"])
        self.assertEqual(model["liveAllocationAllowanceBytes"],4096)
        self.assertGreaterEqual(model["physicalPeakBytes"],before["physicalBytes"])
        self.assertGreater(model["baselineFreePageBytes"],0)
        self.assertFalse(any("VACUUM" in sql.upper() for sql in trace))
        for name in ("idx_market_history_pointers_block_id","idx_market_history_pointers_previous_block_id"):
            self.assertGreater(result["database"]["objects"][name],0)
        pointers = self.archive.execute("SELECT p.calendar_year,b.row_count,p.previous_block_id FROM market_history_block_pointers p JOIN market_history_blocks b ON b.id=p.block_id WHERE p.feed='sip'").fetchall()
        self.assertIn(2027,[row[0] for row in pointers])
        self.assertIn(2020,[row[0] for row in pointers])
        self.assertEqual(sum(row[1] for row in pointers),1440+model["deepHistory"]["retainedSpanExtraSessionSlots"])
        self.assertEqual(model["deepHistory"]["reservedObservations"],1400+model["deepHistory"]["retainedSpanExtraSessionSlots"])
        self.assertGreater(model["deepHistory"]["retainedSpanExtraSessionSlots"],0)
        self.assertEqual(model["deepHistory"]["reservedRequestedObservations"],22500)
        self.assertTrue(all(row[2] for row in pointers))
        future_blocks=self.archive.execute("""SELECT b.* FROM market_history_block_pointers p
          JOIN market_history_blocks b ON b.id=p.block_id WHERE p.feed='sip' AND p.calendar_year=2027""").fetchall()
        future_bars=[bar for block in future_blocks for bar in self.codec.call({"block":analysis.block_value(block)})["bars"]]
        self.assertTrue(future_bars)
        for bar in future_bars:
            self.assertEqual(bar["observedAt"][:10],bar["date"])
            self.assertGreater(bar["reportedVolumeCollectedAt"],bar["observedAt"])
        self.assertGreater(len({bar["observedAt"] for bar in future_bars}),1)

    def test_invalid_current_pointer_is_rejected_before_forecasting(self):
        self.archive.execute("PRAGMA foreign_keys=OFF")
        self.archive.execute("INSERT INTO market_history_block_pointers VALUES('sip','AAA',2026,'missing',NULL,'2026-09-01')")
        self.archive.commit()
        with self.assertRaisesRegex(analysis.AnalysisError,"invalid current/previous"):
            analysis.archive_current_forecast(self.source,self.archive,self.codec,["AAA"],self.context(),"2026-09-12T00:00:00Z")

    def test_context_binds_actual_file_and_separates_copy_count(self):
        self.archive.commit()
        context = self.context()
        path = self.path / "context.json"
        path.write_text(json.dumps(context))
        self.assertEqual(analysis.current_archive_context(path,self.path/"history.sqlite",context["sourceSnapshotSha256"],["AAA"])["copySourceRows"],2)
        context["copySourceRows"] = 3
        path.write_text(json.dumps(context))
        with self.assertRaises(analysis.AnalysisError):
            analysis.current_archive_context(path,self.path/"history.sqlite",context["sourceSnapshotSha256"],["AAA"])

    def test_full_analyzer_current_mode_preserves_inputs_and_cold_source_count(self):
        source_path=self.path/"complete-source.sqlite"
        db=sqlite3.connect(source_path)
        for migration in sorted((analysis.ROOT/"market-data-migrations").glob("*.sql")):
            db.executescript(migration.read_text())
        db.execute("""INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume,fetched_at,
          source_provider,adjustment,observed_at,reported_volume,reported_volume_collected_at)
          VALUES('sip','AAA','2026-12-01',10,11,9,10,100,'2026-12-01T23:00:00Z',
          'alpaca','split','2026-12-01T23:00:00Z',NULL,NULL)""")
        db.commit();db.close()
        self.archive.commit()
        context=self.context()
        normalized=self.path/"normalized-source.sqlite"
        clone=analysis.snapshot(source_path,normalized)
        clone.close()
        context["sourceSnapshotSha256"]=analysis.digest_file(normalized)
        context.pop("evidenceHash")
        context["evidenceHash"]=hashlib.sha256(json.dumps(context,separators=(",",":")).encode()).hexdigest()
        context_path=self.path/"integrated-context.json"
        context_path.write_text(json.dumps(context))
        before=(analysis.digest_file(source_path),analysis.digest_file(self.path/"history.sqlite"))
        result=analysis.analyze(source_path,["AAA"],"2026-12-01",self.path/"history.sqlite",current_archive_context_path=context_path)
        self.assertEqual((result["archive"]["sourceRows"],result["archive"]["verifiedCopySourceRows"]),(1,2))
        self.assertFalse(result["archive"]["sourceOverlayApplied"])
        self.assertEqual(result["archive"]["currentArchiveForecast"]["context"],context)
        self.assertEqual([row["hotSessions"] for row in result["retentionModels"]],[260,90])
        self.assertEqual(before,(analysis.digest_file(source_path),analysis.digest_file(self.path/"history.sqlite")))


if __name__ == "__main__":
    unittest.main()
