import base64
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "measure-eod-publication-growth.py"
spec = importlib.util.spec_from_file_location("publication_growth", SCRIPT)
growth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(growth)
analysis_spec = importlib.util.spec_from_file_location("storage_analysis", SCRIPT.with_name("analyze-eod-storage.py"))
analysis = importlib.util.module_from_spec(analysis_spec)
analysis_spec.loader.exec_module(analysis)


class PublicationGrowthTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="eod-publication-growth-test-")
        self.directory = Path(self.temporary.name)
        self.source = self.directory / "source.sqlite"
        self.samples_path = self.directory / "samples.json"
        self.revision = "a" * 40
        self.session = "2026-09-08"
        db = sqlite3.connect(self.source)
        try:
            for migration in sorted((SCRIPT.parents[1] / "market-data-migrations").glob("*.sql")):
                db.executescript(migration.read_text(encoding="utf-8"))
            # Use the actual schema's complete column contract, including SQL
            # summaries separate from the compressed full page payloads.
            columns = [row[1] for row in db.execute("PRAGMA table_info(eod_publications)")]
            rows = []
            for index, scope in enumerate(sorted(growth.SCOPES)):
                payload = {"asOfDate": self.session, "scope": scope, "text": "Measured actual payload " * 250,
                           "prices": list(range(500))}
                raw = growth.json_bytes(payload)
                is_catalog = scope == "history:catalog"
                value = {"id": hashlib.sha256(scope.encode()).hexdigest(), "scope": scope, "session_date": self.session,
                         "revision": 1, "input_hash": hashlib.sha256(str(index).encode()).hexdigest(),
                         "methodology_version": "sip-history-catalog-v1" if is_catalog else "eod-exact-session-v1",
                         "payload_json": raw.decode() if is_catalog else "{}", "payload_checksum": hashlib.sha256(raw).hexdigest(),
                         "payload_codec": "json" if is_catalog else "gzip-json-v1",
                         "payload_base64": None if is_catalog else base64.b64encode(gzip.compress(raw)).decode(),
                         "status": "accepted", "created_at": self.session + "T21:00:00Z", "accepted_at": self.session + "T21:01:00Z"}
                row = {column: value[column] for column in columns}
                rows.append(row)
                db.execute(f"INSERT INTO eod_publications VALUES({','.join('?' for _ in columns)})", list(row.values()))
            db.commit()
        finally:
            db.close()
        self.samples = {"version": 1, "identity": {"codeRevision": self.revision}, "tickerHash": "b" * 64,
                        "sourceSchemaHash": "c" * 64, "publicationEvidenceHash": "d" * 64, "rows": rows}
        self.save()

    def save(self):
        self.samples["samplesHash"] = hashlib.sha256(growth.json_bytes(self.samples["rows"])).hexdigest()
        self.samples_path.write_text(json.dumps(self.samples), encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def test_measures_real_rows_and_indexes_without_mutating_source(self):
        before = growth.digest_file(self.source)
        captured = self.directory / "analyzer-capture.sqlite"
        analysis.snapshot(self.source, captured).close()
        result = growth.measure(self.source, self.samples_path, self.revision, sets=8)
        self.assertEqual(result["publicationRows"], 56)
        self.assertEqual(result["forecastSessions"], 20)
        self.assertEqual(result["sourcePublicationIds"], [row["id"] for row in self.samples["rows"]])
        self.assertGreater(result["afterBytes"], result["beforeBytes"])
        self.assertEqual(result["sourceSnapshotSha256"], growth.digest_file(captured))
        self.assertEqual(growth.digest_file(self.source), before)

    def test_backup_hash_matches_analyzer_with_committed_wal(self):
        writer = sqlite3.connect(self.source)
        try:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("CREATE TABLE committed_wal_provenance(value TEXT)")
            writer.execute("INSERT INTO committed_wal_provenance VALUES('capture includes this committed page')")
            writer.commit()
            captured = self.directory / "analyzer-wal-capture.sqlite"
            analysis.snapshot(self.source, captured).close()
            original_hash = growth.digest_file(self.source)
            captured_hash = growth.digest_file(captured)
            self.assertNotEqual(original_hash, captured_hash)
            result = growth.measure(self.source, self.samples_path, self.revision)
            self.assertEqual(result["sourceSnapshotSha256"], captured_hash)
            self.assertEqual(growth.digest_file(self.source), original_hash)
            self.assertEqual(writer.execute("SELECT value FROM committed_wal_provenance").fetchone()[0],
                             "capture includes this committed page")
        finally:
            writer.close()

    def test_rejects_partial_wrong_revision_and_corrupted_payloads(self):
        with self.assertRaisesRegex(ValueError, "reviewed checkout"):
            growth.measure(self.source, self.samples_path, "f" * 40)
        row = self.samples["rows"].pop()
        self.save()
        with self.assertRaisesRegex(ValueError, "seven-scope"):
            growth.measure(self.source, self.samples_path, self.revision)
        self.samples["rows"].append(row)
        self.samples["rows"][0]["payload_checksum"] = "0" * 64
        self.save()
        with self.assertRaisesRegex(ValueError, "payload checksum"):
            growth.measure(self.source, self.samples_path, self.revision)

    def test_rejects_tampered_manifest_and_nonaccepted_rows(self):
        self.samples["samplesHash"] = "0" * 64
        self.samples_path.write_text(json.dumps(self.samples))
        with self.assertRaisesRegex(ValueError, "sample checksum"):
            growth.measure(self.source, self.samples_path, self.revision)
        self.samples["rows"][0]["status"] = "candidate"
        self.save()
        with self.assertRaisesRegex(ValueError, "accepted publications"):
            growth.measure(self.source, self.samples_path, self.revision)


if __name__ == "__main__":
    unittest.main()
