#!/usr/bin/env python3
"""Measure publication growth in an ephemeral SQLite copy of the real schema.

The seven sampled rows must come from collectStoragePublicationGrowthSamples.
Synthetic IDs only prevent fixture uniqueness conflicts. Payloads remain exact
accepted bytes. This command never opens a network or mutates its input database.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile

SCOPES = {"overview:default", "breadth:sp500-core", "breadth:nasdaq-core", "breadth:nyse-core",
          "breadth:russell2000-core", "breadth:overall-market-proxy", "history:catalog"}
HASH = re.compile(r"^[a-f0-9]{64}$")


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", value):
        raise ValueError("Invalid publication schema identifier")
    return '"' + value + '"'


def measure(source_path: Path, samples_path: Path, code_revision: str, sets: int = 8,
            forecast_sessions: int = 20, revisions: int = 2) -> dict:
    if not 2 <= sets <= 64 or not 20 <= forecast_sessions <= 1300 or not 2 <= revisions <= 10:
        raise ValueError("Sizing fixture or finite forecast exceeds supported bounds")
    if samples_path.stat().st_size > 16_000_000:
        raise ValueError("Publication sample artifact exceeds its bounded size")
    samples = json.loads(samples_path.read_text(encoding="utf-8-sig"))
    rows = samples.get("rows", [])
    identity = samples.get("identity", {})
    if samples.get("version") != 1 or identity.get("codeRevision") != code_revision:
        raise ValueError("Publication samples must match the reviewed checkout")
    for name in ("tickerHash", "sourceSchemaHash", "publicationEvidenceHash", "samplesHash"):
        if not HASH.fullmatch(samples.get(name, "")):
            raise ValueError("Missing publication sample provenance")
    if hashlib.sha256(json_bytes(rows)).hexdigest() != samples["samplesHash"]:
        raise ValueError("Publication sample checksum mismatch")
    if len(rows) != 7 or {row.get("scope") for row in rows} != SCOPES or len({row.get("id") for row in rows}) != 7:
        raise ValueError("One complete seven-scope publication set is required")
    sessions = {row.get("session_date") for row in rows}
    if len(sessions) != 1 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", next(iter(sessions)) or ""):
        raise ValueError("Publication samples must share their actual session")
    for row in rows:
        if row.get("status") != "accepted" or not row.get("accepted_at") or not HASH.fullmatch(row.get("payload_checksum", "")):
            raise ValueError("Only checked accepted publications can size the forecast")
        codec = row.get("payload_codec")
        if codec == "json":
            payload = row["payload_json"].encode("utf-8")
        elif codec == "gzip-json-v1":
            if len(row["payload_base64"]) > 1_500_000:
                raise ValueError("Compressed publication exceeds its bounded size")
            with gzip.GzipFile(fileobj=io.BytesIO(base64.b64decode(row["payload_base64"], validate=True))) as stream:
                payload = stream.read(8_000_001)
        else:
            raise ValueError("Unsupported publication codec")
        if len(payload) > 8_000_000 or hashlib.sha256(payload).hexdigest() != row["payload_checksum"]:
            raise ValueError("Stored publication payload checksum mismatch")
        json.loads(payload)
    source_hash = digest_file(source_path)
    source = sqlite3.connect(source_path.resolve().as_uri() + "?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    try:
        schema = source.execute("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='eod_publications' AND sql IS NOT NULL ORDER BY type DESC,name").fetchall()
        tables = [row for row in schema if row["type"] == "table"]
        if len(tables) != 1:
            raise ValueError("Real eod_publications table schema is required")
        with tempfile.TemporaryDirectory(prefix="market-eod-publication-growth-") as temporary:
            fixture = Path(temporary) / "fixture.sqlite"
            db = sqlite3.connect(fixture)
            try:
                db.execute(tables[0]["sql"])
                for item in schema:
                    if item["type"] == "index":
                        db.execute(item["sql"])
                columns = [row[1] for row in db.execute("PRAGMA table_info(eod_publications)")]
                if any(set(row) != set(columns) for row in rows):
                    raise ValueError("Stored publication rows do not match the real schema")
                insert = f"INSERT INTO eod_publications({','.join(identifier(column) for column in columns)}) VALUES({','.join('?' for _ in columns)})"
                # Retain existing rows to measure B-tree/index growth at the
                # existing publication population, not an empty tiny database.
                db.executemany(insert, source.execute(f"SELECT {','.join(identifier(column) for column in columns)} FROM eod_publications"))
                db.commit()
                db.execute("VACUUM")
                before = db.execute("PRAGMA page_size").fetchone()[0] * db.execute("PRAGMA page_count").fetchone()[0]
                for number in range(sets):
                    for row in rows:
                        fixture_row = dict(row)
                        fixture_row["id"] = hashlib.sha256(f"storage-fixture:{number}:{row['id']}".encode()).hexdigest()
                        fixture_row["input_hash"] = hashlib.sha256(f"storage-fixture-input:{number}:{row['input_hash']}".encode()).hexdigest()
                        fixture_row["revision"] = int(row["revision"]) + number + 1
                        db.execute(insert, [fixture_row[column] for column in columns])
                db.commit()
                # Preserve actual allocation/slack after insert; no post-insert
                # VACUUM makes the increment more optimistic than D1 writes.
                after = db.execute("PRAGMA page_size").fetchone()[0] * db.execute("PRAGMA page_count").fetchone()[0]
            finally:
                db.close()
            if after <= before:
                raise ValueError("No positive allocated growth was observed; increase fixture sets")
            result = {"version": 1, "measuredAt": datetime.now(timezone.utc).isoformat(), "codeRevision": code_revision,
                      "tickerHash": samples["tickerHash"], "schemaHash": samples["sourceSchemaHash"],
                      "fixtureSha256": digest_file(fixture), "beforeBytes": before, "afterBytes": after,
                      "measurementMethod": "sqlite-real-publication-schema-v1", "sourceSnapshotSha256": source_hash,
                      "sourcePublicationIds": [row["id"] for row in rows],
                      "sourcePublicationChecksums": [row["payload_checksum"] for row in rows],
                      "sourceSessionDate": next(iter(sessions)), "samplesHash": samples["samplesHash"],
                      "publicationEvidenceHash": samples["publicationEvidenceHash"], "completeSessionSets": sets,
                      "publicationRows": sets * 7, "forecastSessions": forecast_sessions, "revisionsPerSession": revisions}
    finally:
        source.close()
    if digest_file(source_path) != source_hash:
        raise ValueError("Source snapshot changed during measurement")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema-sqlite", type=Path, required=True)
    parser.add_argument("--samples-json", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fixture-sets", type=int, default=8)
    parser.add_argument("--forecast-sessions", type=int, default=20)
    parser.add_argument("--revisions-per-session", type=int, default=2)
    args = parser.parse_args()
    try:
        code_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
        if not re.fullmatch(r"[a-f0-9]{40}", code_revision):
            raise ValueError("Could not identify the reviewed checkout")
        if args.output.resolve() in {args.schema_sqlite.resolve(), args.samples_json.resolve()}:
            raise ValueError("Output must not overwrite a source artifact")
        result = measure(args.schema_sqlite, args.samples_json, code_revision, args.fixture_sets,
                         args.forecast_sessions, args.revisions_per_session)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        reserve = ((result["afterBytes"] - result["beforeBytes"] + result["completeSessionSets"] - 1)
                   // result["completeSessionSets"]) * result["forecastSessions"] * result["revisionsPerSession"]
        print(json.dumps({"report": str(args.output.resolve()), "publicationGrowthReserveBytes": reserve,
                          "forecastSessions": args.forecast_sessions, "productionAcceptanceVerified": False}))
        return 0
    except (ValueError, OSError, sqlite3.Error, json.JSONDecodeError, subprocess.SubprocessError) as error:
        print(json.dumps({"error": str(error)[:250]}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
