"""Offline EOD archive-first storage analysis. Python 3.11+, Node and npm dependencies.

Reads local SQLite snapshots only. Generated capacity-model rows are never
market observations, and temporary databases are never deployment artifacts.
"""
from __future__ import annotations

import argparse
import base64
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
TARGET_BYTES = 350_000_000
TRANSIENT_ARCHIVE_BYTES = 4 * 1024 * 1024
FALLBACK_LAYOUT = "archive-only-bounded-v1"
FALLBACK_CAPACITY = 1_000
FALLBACK_SESSIONS = 320
BAR_FIELDS = ("feed", "ticker", "date", "o", "h", "l", "c", "volume", "fetched_at",
              "source_provider", "adjustment", "observed_at", "reported_volume", "reported_volume_collected_at")
BLOCK_FIELDS = ("id", "feed", "ticker", "calendar_year", "schema_version", "codec", "checksum", "row_count",
                "first_date", "last_date", "uncompressed_bytes", "payload_base64", "created_at", "verified_at")


class AnalysisError(RuntimeError):
    pass


def identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def digest_file(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def load_tickers(path: Path) -> list[str]:
    payload = json.loads(path.read_text(encoding="utf8"))
    if isinstance(payload, dict) and "input_json" in payload:
        payload = json.loads(payload["input_json"]) if isinstance(payload["input_json"], str) else payload["input_json"]
    if isinstance(payload, dict):
        payload = payload.get("tickers")
    if not isinstance(payload, list) or not payload or any(not isinstance(value, str) or not value.strip() for value in payload):
        raise AnalysisError("Provide the frozen full shared ticker list, not a page-only selection.")
    normalized = [value.strip().upper() for value in payload]
    if len(set(normalized)) != len(normalized):
        raise AnalysisError("Frozen shared ticker list contains duplicate security identities.")
    return sorted(normalized)


def snapshot(source: Path, destination: Path) -> sqlite3.Connection:
    if not source.is_file():
        raise AnalysisError(f"Local SQLite snapshot does not exist: {source.name}")
    original = sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)
    result = sqlite3.connect(destination)
    result.row_factory = sqlite3.Row
    try:
        # SQLite backup includes any committed WAL state and creates one
        # consistent analysis snapshot without modifying the source file.
        original.backup(result)
    finally:
        original.close()
    return result


def measure(db: sqlite3.Connection) -> dict[str, Any]:
    method = "sqlite-dbstat"
    try:
        sizes = {row["name"]: row["bytes"] for row in db.execute("SELECT name,SUM(pgsize) AS bytes FROM dbstat GROUP BY name")}
    except sqlite3.Error:
        # Windows' standard Python SQLite build omits DBSTAT. The serialized
        # consistent local database still provides exact B-tree/overflow pages.
        sizes = btree_sizes(db)
        method = "sqlite-file-btree-and-overflow-pages"
    page_size = db.execute("PRAGMA page_size").fetchone()[0]
    page_count = db.execute("PRAGMA page_count").fetchone()[0]
    free_pages = db.execute("PRAGMA freelist_count").fetchone()[0]
    price_objects = ["alpaca_daily_bars", *[row[0] for row in db.execute("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='alpaca_daily_bars'")]]
    return {"measurementMethod": method, "physicalBytes": page_size * page_count, "occupiedBytes": sum(sizes.values()),
            "freePageBytes": page_size * free_pages, "pageSize": page_size,
            "nonBtreeAllocatedBytes": page_size * (page_count - free_pages) - sum(sizes.values()),
            "priceTableAndIndexBytes": sum(sizes.get(name, 0) for name in price_objects),
            "objects": sizes}


def btree_sizes(db: sqlite3.Connection) -> dict[str, int]:
    """Exact local page ownership per https://sqlite.org/fileformat2.html.

    Includes table/index interior, leaf and overflow pages. Freelist and pointer
    map pages are reported separately by measure(), never assigned to a table.
    serialize() includes committed WAL state and performs no filesystem writes.
    """
    image = db.serialize()
    if image[:16] != b"SQLite format 3\x00":
        raise AnalysisError("Snapshot has an invalid SQLite file header.")
    page_size = int.from_bytes(image[16:18], "big")
    if page_size == 1:
        page_size = 65536
    usable = page_size - image[20]
    if page_size < 512 or page_size > 65536 or page_size & (page_size-1) or len(image) % page_size or usable < 480:
        raise AnalysisError("Snapshot has an unsupported SQLite page layout.")
    pages = len(image) // page_size
    owners: set[int] = set()

    def page(number: int) -> memoryview:
        if number < 1 or number > pages or number in owners:
            raise AnalysisError("Snapshot page ownership is invalid, overlapping or cyclic.")
        owners.add(number)
        return memoryview(image)[(number-1)*page_size:number*page_size]

    def integer(value: memoryview, offset: int, length: int) -> int:
        if offset < 0 or offset + length > usable:
            raise AnalysisError("Snapshot cell pointer exceeds its page.")
        return int.from_bytes(value[offset:offset+length], "big")

    def varint(value: memoryview, offset: int) -> tuple[int, int]:
        result = 0
        for index in range(9):
            byte = integer(value, offset+index, 1)
            if index == 8:
                return (result << 8) | byte, offset+9
            result = (result << 7) | (byte & 127)
            if byte < 128:
                return result, offset+index+1
        raise AnalysisError("Invalid SQLite varint.")

    def tree(root: int) -> int:
        before = len(owners)
        pending = [root]
        while pending:
            number = pending.pop()
            value = page(number)
            header = 100 if number == 1 else 0
            kind = integer(value, header, 1)
            if kind not in (2, 5, 10, 13):
                raise AnalysisError("Snapshot contains an unsupported B-tree page type.")
            interior = kind in (2, 5)
            cells = integer(value, header+3, 2)
            if interior:
                pending.append(integer(value, header+8, 4))
            for index in range(cells):
                offset = integer(value, header+(12 if interior else 8)+2*index, 2)
                if interior:
                    pending.append(integer(value, offset, 4))
                    offset += 4
                if kind == 5:
                    continue
                payload, offset = varint(value, offset)
                if kind == 13:
                    _, offset = varint(value, offset)
                maximum = usable-35 if kind == 13 else ((usable-12)*64//255)-23
                if payload <= maximum:
                    continue
                minimum = ((usable-12)*32//255)-23
                local = minimum + (payload-minimum) % (usable-4)
                if local > maximum:
                    local = minimum
                next_page = integer(value, offset+local, 4)
                remaining = payload-local
                while remaining > 0:
                    overflow = page(next_page)
                    next_page = integer(overflow, 0, 4)
                    remaining -= usable-4
                if next_page != 0:
                    raise AnalysisError("Snapshot overflow chain exceeds its declared payload.")
        return (len(owners)-before)*page_size

    result = {"sqlite_schema": tree(1)}
    for row in db.execute("SELECT name,rootpage FROM sqlite_schema WHERE rootpage>0 ORDER BY name"):
        result[row["name"]] = tree(row["rootpage"])
    free_pages = db.execute("PRAGMA freelist_count").fetchone()[0]
    if len(owners)+free_pages > pages:
        raise AnalysisError("Snapshot page accounting exceeds the database size.")
    return result


class Codec:
    def __init__(self):
        executable = shutil.which("node")
        if executable is None:
            raise AnalysisError("Node is required to run the application's actual archive codec.")
        self.process = subprocess.Popen([executable, "--import", "tsx", str(ROOT / "scripts/eod-storage-codec.ts")],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf8", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def call(self, request: dict[str, Any]) -> dict[str, Any]:
        assert self.process.stdin and self.process.stdout
        try:
            self.process.stdin.write(json.dumps(request, separators=(",", ":"), allow_nan=False) + "\n")
            self.process.stdin.flush()
            line = self.process.stdout.readline()
            if not line:
                raise AnalysisError("Local archive-codec process stopped. Run npm install and verify Node compatibility.")
            result = json.loads(line)
        except (BrokenPipeError, ValueError) as error:
            raise AnalysisError("A source row or codec response is invalid; analysis did not establish lossless storage.") from error
        if result.get("error"):
            raise AnalysisError(f"Archive codec rejected a source block: {result['error']}")
        return result

    def close(self):
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        if self.process.stdout:
            self.process.stdout.close()


def bar_value(row: sqlite3.Row) -> dict[str, Any]:
    return {"ticker": row["ticker"], "date": row["date"], **{field: row[field] for field in ("o", "h", "l", "c", "volume")},
            "reportedVolume": row["reported_volume"], "reportedVolumeCollectedAt": row["reported_volume_collected_at"],
            "feed": row["feed"], "sourceProvider": row["source_provider"], "adjustment": row["adjustment"],
            "observedAt": row["observed_at"], "fetchedAt": row["fetched_at"]}


def block_value(row: sqlite3.Row) -> dict[str, Any]:
    return {"id": row["id"], "feed": row["feed"], "ticker": row["ticker"], "calendarYear": row["calendar_year"],
            "schemaVersion": row["schema_version"], "codec": row["codec"], "checksum": row["checksum"],
            "rowCount": row["row_count"], "firstDate": row["first_date"], "lastDate": row["last_date"],
            "uncompressedBytes": row["uncompressed_bytes"], "payloadBase64": row["payload_base64"]}


def archive_all(source: sqlite3.Connection, archive: sqlite3.Connection, codec: Codec, measured_at: str) -> dict[str, Any]:
    # A corrupt pointer outside the source's current security/year groups must
    # also fail; otherwise the archive could contain inaccessible old history.
    invalid_pointer = archive.execute("""SELECT p.ticker FROM market_history_block_pointers p
      LEFT JOIN market_history_blocks b ON b.id=p.block_id
      LEFT JOIN market_history_blocks previous ON previous.id=p.previous_block_id
      WHERE b.id IS NULL OR b.verified_at IS NULL OR b.feed<>p.feed OR b.ticker<>p.ticker
        OR b.calendar_year<>p.calendar_year OR (p.previous_block_id IS NOT NULL AND
          (previous.id IS NULL OR previous.verified_at IS NULL OR previous.feed<>p.feed
            OR previous.ticker<>p.ticker OR previous.calendar_year<>p.calendar_year)) LIMIT 1""").fetchone()
    if invalid_pointer:
        raise AnalysisError("Existing archive contains an unverified, missing or mismatched pointed block.")
    existing_blocks = 0
    for block in archive.execute("SELECT * FROM market_history_blocks"):
        codec.call({"block": block_value(block)})
        existing_blocks += 1
    source_rows = checked_rows = blocks_created = 0
    feeds: dict[str, int] = {}
    group: list[sqlite3.Row] = []

    def store_group():
        nonlocal checked_rows, blocks_created
        if not group:
            return
        first = group[0]
        year = int(first["date"][:4])
        pointer = archive.execute("SELECT block_id FROM market_history_block_pointers WHERE feed=? AND ticker=? AND calendar_year=?",
                                  (first["feed"], first["ticker"], year)).fetchone()
        values: dict[str, dict[str, Any]] = {}
        if pointer:
            prior = archive.execute("SELECT * FROM market_history_blocks WHERE id=?", (pointer[0],)).fetchone()
            if prior is None or not prior["verified_at"]:
                raise AnalysisError("Existing archive contains an unverified or missing pointed block.")
            values.update((bar["date"], bar) for bar in codec.call({"block": block_value(prior)})["bars"])
        # Mirrors the shared reader: hot observations override same-date archive
        # observations. The old immutable block remains present as history.
        source_bars = [bar_value(row) for row in group]
        values.update((bar["date"], bar) for bar in source_bars)
        bars = [values[key] for key in sorted(values)]
        result = codec.call({"bars": bars})
        if result.get("equal") is not True:
            raise AnalysisError("Archive normalization changed source values or identities; storage equality failed.")
        block = result["block"]
        sql_values = (block["id"], block["feed"], block["ticker"], year, block["schemaVersion"], block["codec"],
                      block["checksum"], block["rowCount"], block["firstDate"], block["lastDate"], block["uncompressedBytes"],
                      block["payloadBase64"], measured_at, measured_at)
        inserted = archive.execute(f"INSERT OR IGNORE INTO market_history_blocks({','.join(BLOCK_FIELDS)}) VALUES({','.join('?' for _ in BLOCK_FIELDS)})", sql_values)
        blocks_created += max(0, inserted.rowcount)
        stored = archive.execute("SELECT * FROM market_history_blocks WHERE id=?", (block["id"],)).fetchone()
        read_back = codec.call({"block": block_value(stored)})["bars"]
        if read_back != bars:
            raise AnalysisError("Archive SQLite read-back does not match the encoded source values.")
        archive.execute("""INSERT INTO market_history_block_pointers(feed,ticker,calendar_year,block_id,previous_block_id,updated_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(feed,ticker,calendar_year) DO UPDATE SET
            previous_block_id=CASE WHEN block_id<>excluded.block_id THEN block_id ELSE previous_block_id END,
            block_id=excluded.block_id,updated_at=excluded.updated_at""",
          (first["feed"], first["ticker"], year, block["id"], pointer[0] if pointer and pointer[0] != block["id"] else None, measured_at))
        checked_rows += len(source_bars)

    for row in source.execute("SELECT * FROM alpaca_daily_bars ORDER BY feed,ticker,date"):
        if group and (row["feed"], row["ticker"], row["date"][:4]) != (group[0]["feed"], group[0]["ticker"], group[0]["date"][:4]):
            store_group()
            group = []
        group.append(row)
        source_rows += 1
        feeds[row["feed"]] = feeds.get(row["feed"], 0) + 1
    store_group()
    archive.commit()
    archive.execute("VACUUM")
    size = measure(archive)
    encoded = archive.execute("SELECT COUNT(*) AS blocks,COALESCE(SUM(length(payload_base64)),0) AS encoded,COALESCE(SUM(uncompressed_bytes),0) AS plain FROM market_history_blocks").fetchone()
    gzip_bytes = sum(len(base64.b64decode(row[0], validate=True)) for row in archive.execute("SELECT payload_base64 FROM market_history_blocks"))
    active = archive.execute("SELECT COUNT(*) FROM market_history_block_pointers").fetchone()[0]
    # Doubles the measured complete archive, including indexes/pointers, to
    # reserve an additional complete revision. Existing revisions stay intact;
    # this bound is intentionally conservative when a snapshot already has two.
    reserve = size["physicalBytes"] * 2 + TRANSIENT_ARCHIVE_BYTES
    return {"sourceRows": source_rows, "sourceRowsByFeed": feeds, "checkedSourceRows": checked_rows,
            "existingBlocksVerified": existing_blocks, "newBlocks": blocks_created, "storedBlocks": encoded["blocks"], "activeBlocks": active,
            "gzipPayloadBytes": gzip_bytes, "base64PayloadBytes": encoded["encoded"], "uncompressedPayloadBytes": encoded["plain"],
            "database": size, "withAdditionalCompleteRevisionAndTransientBytes": reserve,
            "reserveDefinition": "Twice measured full archive physical size plus 4 MiB; preserves all existing immutable revisions.",
            "storageRoundTripPassed": checked_rows == source_rows, "consumerParityVerified": False}


def remove_triggers(db: sqlite3.Connection) -> list[str]:
    triggers = list(db.execute("SELECT name,sql FROM sqlite_schema WHERE type='trigger'"))
    for row in triggers:
        db.execute(f"DROP TRIGGER {identifier(row[0])}")
    return [row["sql"] for row in triggers]


def archive_fallback_model(archive: sqlite3.Connection, codec: Codec, tickers: list[str], session: str,
                           measured_at: str, capacity: int = FALLBACK_CAPACITY) -> dict[str, Any]:
    """Disposable full-capacity fixture; never provider observations or a copy.

    Vary full-width OHLC/volume values per security/date so gzip cannot obtain
    an unrealistically small forecast from repeated constant prices. Every old
    immutable block stays present, including orphaned revisions and symbols
    outside the current shared population. Slots are enforced by the writer.
    """
    existing = {row[0] for row in archive.execute("SELECT DISTINCT ticker FROM market_history_blocks WHERE feed='yahoo-eod'")}
    if len(existing) > capacity:
        raise AnalysisError("Existing Yahoo archive identities exceed the enforced fallback capacity; no history was removed.")
    selected = sorted(set(tickers) - existing, key=lambda ticker: (-len(ticker), ticker))[:max(0, capacity-len(existing))]
    population = sorted(existing | set(selected))
    if not population:
        raise AnalysisError("The bounded fallback fixture requires a nonempty population.")
    before = measure(archive)["physicalBytes"]
    # Width/year distribution follows weekday session slots, with forty future
    # sessions plus twenty extra observations beyond the initial 260 window.
    cursor = date.fromisoformat(session)
    future = 0
    while future < 40:
        cursor += timedelta(days=1)
        future += cursor.weekday() < 5
    dates: list[str] = []
    while len(dates) < FALLBACK_SESSIONS:
        if cursor.weekday() < 5:
            dates.append(cursor.isoformat())
        cursor -= timedelta(days=1)
    timestamp = session + "T23:59:59.999Z"
    for ticker in population:
        groups: dict[str, list[dict[str, Any]]] = {}
        for day in reversed(dates):
            noise = hashlib.sha256(f"storage-fallback-fixture:{ticker}:{day}".encode()).digest()
            numbers = [int.from_bytes(noise[index:index+8], "big") / 2**64 for index in (0, 8, 16, 24)]
            opening, close = 100 + numbers[0]*100, 100 + numbers[1]*100
            bar = {"ticker": ticker, "date": day, "o": opening, "h": max(opening,close)+numbers[2]*10,
                   "l": min(opening,close)-numbers[3]*10, "c": close, "volume": int.from_bytes(noise[:4], "big"),
                   "reportedVolume": None, "feed": "yahoo-eod", "sourceProvider": "yahoo", "adjustment": "split",
                   "observedAt": timestamp, "fetchedAt": timestamp}
            groups.setdefault(day[:4], []).append(bar)
        for year, incoming in groups.items():
            pointer = archive.execute("SELECT block_id FROM market_history_block_pointers WHERE feed='yahoo-eod' AND ticker=? AND calendar_year=?", (ticker,year)).fetchone()
            merged: dict[str, dict[str, Any]] = {}
            if pointer:
                stored = archive.execute("SELECT * FROM market_history_blocks WHERE id=?", (pointer[0],)).fetchone()
                if not stored:
                    raise AnalysisError("Fallback fixture encountered a missing existing pointed block.")
                merged.update((bar["date"],bar) for bar in codec.call({"block":block_value(stored)})["bars"])
            # Existing observations remain intact in old immutable revisions;
            # the synthetic next revision measures fully populated allocation.
            merged.update((bar["date"],bar) for bar in incoming)
            bars = [merged[day] for day in sorted(merged)]
            encoded = codec.call({"bars":bars})
            if encoded.get("equal") is not True:
                raise AnalysisError("Fallback fixture codec round-trip failed.")
            block = encoded["block"]
            values = (block["id"],block["feed"],block["ticker"],int(year),block["schemaVersion"],block["codec"],
                      block["checksum"],block["rowCount"],block["firstDate"],block["lastDate"],block["uncompressedBytes"],
                      block["payloadBase64"],measured_at,measured_at)
            archive.execute(f"INSERT OR IGNORE INTO market_history_blocks({','.join(BLOCK_FIELDS)}) VALUES({','.join('?' for _ in BLOCK_FIELDS)})",values)
            stored = archive.execute("SELECT * FROM market_history_blocks WHERE id=?",(block["id"],)).fetchone()
            if codec.call({"block":block_value(stored)})["bars"] != bars:
                raise AnalysisError("Stored fallback fixture failed lossless read-back.")
            archive.execute("""INSERT INTO market_history_block_pointers(feed,ticker,calendar_year,block_id,previous_block_id,updated_at)
              VALUES('yahoo-eod',?,?,?,?,?) ON CONFLICT(feed,ticker,calendar_year) DO UPDATE SET
                block_id=excluded.block_id,previous_block_id=excluded.previous_block_id,updated_at=excluded.updated_at""",
              (ticker,int(year),block["id"],pointer[0] if pointer else None,measured_at))
    archive.commit()
    # No VACUUM after inserts: preserve real allocation/slack from growth.
    after = measure(archive)
    return {"storage":FALLBACK_LAYOUT,"capacityTickers":capacity,"existingTickers":len(existing),
            "existingTickersOutsidePopulation":len(existing-set(tickers)),"modeledAdditionalTickers":len(selected),
            "totalReservedTickers":len(population),"tickerHash":hashlib.sha256(json.dumps(population,separators=(",",":")).encode()).hexdigest(),
            "sessions":FALLBACK_SESSIONS,"modeledRows":len(population)*FALLBACK_SESSIONS,
            "physicalBytesBefore":before,"physicalBytesAfter":after["physicalBytes"],"database":after,
            "roundTripPassed":True,"measurementMethod":"sqlite-real-history-codec-v1"}


def make_seed(source: sqlite3.Connection, path: Path, session: str) -> sqlite3.Connection:
    result = sqlite3.connect(path)
    result.row_factory = sqlite3.Row
    source.backup(result)
    # Only this private disposable copy is changed. Revisions/publications and
    # all non-price rows remain unchanged; actual writers are never invoked.
    triggers = remove_triggers(result)
    result.execute("""DELETE FROM alpaca_daily_bars AS b WHERE b.date>?
      OR EXISTS(SELECT 1 FROM alpaca_daily_bars newer WHERE newer.feed=b.feed AND newer.ticker=b.ticker
        AND newer.date>b.date AND newer.date<=?)""", (session, session))
    for sql in triggers:
        result.execute(sql)
    result.commit()
    result.execute("VACUUM")
    return result


def capacity_model(seed: sqlite3.Connection, path: Path, tickers: list[str], session: str, hot: int, headroom: int,
                   publication_reserve: int, fallback_tickers: list[str], archived_fallback_tickers: int | None = None) -> dict[str, Any]:
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    try:
        seed.backup(db)
        triggers = remove_triggers(db)
        db.execute("DELETE FROM alpaca_daily_bars WHERE feed='sip' AND ticker IN (SELECT value FROM json_each(?))", (json.dumps(tickers),))
        db.execute("DELETE FROM alpaca_daily_bars WHERE feed='yahoo-eod' AND ticker IN (SELECT value FROM json_each(?))", (json.dumps(fallback_tickers),))
        preserved_rows = db.execute("SELECT COUNT(*) FROM alpaca_daily_bars").fetchone()[0]
        columns = [row["name"] for row in db.execute("PRAGMA table_info(alpaca_daily_bars)")]
        # Capacity fixtures use full-width non-null numeric fields and populated
        # collection timestamps. These are NEVER returned as market history.
        dates = [(date.fromisoformat(session) - timedelta(days=offset)).isoformat() for offset in range(hot + headroom)]
        timestamp = session + "T23:59:59.999Z"
        sql = f"INSERT INTO alpaca_daily_bars({','.join(identifier(column) for column in columns)}) VALUES({','.join('?' for _ in columns)})"
        state_fallback_tickers = tickers if archived_fallback_tickers is not None else fallback_tickers
        for feed, ticker in [("sip", ticker) for ticker in tickers] + [("yahoo-eod", ticker) for ticker in state_fallback_tickers]:
            base = {"feed": feed, "ticker": ticker, "o": 123.456789, "h": 125.123456, "l": 121.123456, "c": 124.123456,
                    "volume": 123456789.125, "reported_volume": 123456789.125,
                    "fetched_at": timestamp, "observed_at": timestamp, "reported_volume_collected_at": timestamp,
                    "source_provider": "alpaca" if feed == "sip" else "yahoo", "adjustment": "split"}
            if feed == "sip" or archived_fallback_tickers is None:
                db.executemany(sql, [tuple({**base, "date": day}[column] for column in columns) for day in dates])
            # Include compact per-security state even for currently missing
            # catalog symbols. These rows are storage fixtures, never evidence.
            db.execute("""INSERT OR REPLACE INTO eod_input_revisions(feed,ticker,revision,semantic_revision,
              last_correction_revision,append_high_water_date,append_epoch_start_revision,append_epoch_start_date,updated_at)
              VALUES(?,?,1000000,1000000,1000000,?,1000000,?,?)""", (feed,ticker,session,dates[-1],timestamp))
            db.execute("""INSERT OR REPLACE INTO eod_adjustment_repairs(feed,ticker,status,owner_token,start_date,updated_at)
              VALUES(?,?,'complete',NULL,?,?)""", (feed,ticker,dates[-1],timestamp))
        for sql in triggers:
            db.execute(sql)
        db.commit()
        db.execute("VACUUM")
        size = measure(db)
        return {"hotSessions": hot, "sweepHeadroomSessions": headroom, "sharedTickers": len(tickers),
                "modeledSipRows": len(tickers) * (hot + headroom), "database": size,
                "fallbackTickerReserve": len(fallback_tickers) if archived_fallback_tickers is None else archived_fallback_tickers,
                "modeledFallbackRows": len(fallback_tickers) * (hot + headroom),
                **({"fallbackStorage":FALLBACK_LAYOUT} if archived_fallback_tickers is not None else {}),
                "preservedOtherFeedOrNonSharedSeedRows": preserved_rows,
                "publicationGrowthReserveBytes": publication_reserve,
                "projectedBytes": size["physicalBytes"] + publication_reserve,
                "under350MB": size["physicalBytes"] + publication_reserve < TARGET_BYTES,
                "basis": "Measured disposable database with actual schema/indexes and full-width representative rows for every frozen ticker; not analytical observations."}
    finally:
        db.close()


def capture_metadata(source: sqlite3.Connection, source_path: Path, allow_partial: bool) -> dict[str, Any]:
    metadata_path = Path(str(source_path) + ".metadata.json")
    bookkeeping = source.execute("SELECT 1 FROM sqlite_schema WHERE name='_storage_snapshot_progress'").fetchone()
    if not metadata_path.is_file():
        if bookkeeping:
            raise AnalysisError("Logical snapshot metadata sidecar is missing; completeness is unknown.")
        return {"kind": "local-sqlite-backup", "remoteCaptureConsistencyVerified": False, "partialEstimate": False,
                "excludedLocalTables": []}
    metadata = json.loads(metadata_path.read_text(encoding="utf8"))
    if not isinstance(metadata, dict) or not isinstance(metadata.get("complete"), bool):
        raise AnalysisError("Logical snapshot metadata has no valid completeness declaration.")
    incomplete = not metadata["complete"]
    if bookkeeping:
        table_names = {row[0] for row in source.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'_storage_snapshot_progress'")}
        finished = {row[0] for row in source.execute("SELECT name FROM _storage_snapshot_progress WHERE complete=1")}
        incomplete = incomplete or not table_names.issubset(finished)
    if incomplete and not allow_partial:
        raise AnalysisError("Logical snapshot is incomplete. Wait for completion or explicitly use --allow-partial-estimate.")
    if bookkeeping:
        source.execute("DROP TABLE _storage_snapshot_progress")
        source.commit()
        source.execute("VACUUM")
    return {"kind": "logical-d1-capacity-snapshot", "completeDeclared": metadata["complete"],
            "remoteCaptureConsistencyVerified": False, "consistentFrozenCaptureDeclared": metadata.get("consistentFrozenCapture") is True,
            "cutoverEvidence": False, "finishedAt": metadata.get("finishedAt"), "partialEstimate": incomplete,
            "excludedLocalTables": ["_storage_snapshot_progress"] if bookkeeping else []}


def analyze(source_path: Path, tickers: list[str], session: str, history_path: Path | None = None,
            headroom: int = 10, publication_reserve: int = 0, fallback_reserve: int | None = None,
            allow_partial: bool = False) -> dict[str, Any]:
    if date.fromisoformat(session).isoformat() != session or headroom < 10 or publication_reserve < 0:
        raise AnalysisError("Use an ISO session date, at least 10 sessions of sweep headroom and a nonnegative publication reserve.")
    if not tickers or len(set(tickers)) != len(tickers):
        raise AnalysisError("All unique frozen shared tickers are required.")
    archive_only = fallback_reserve is None
    fallback_reserve = len(tickers) if fallback_reserve is None else fallback_reserve
    if fallback_reserve < 0 or fallback_reserve > len(tickers):
        raise AnalysisError("Fallback reserve must be between zero and the full shared population.")
    fallback_tickers = sorted(tickers, key=lambda ticker: (-len(ticker), ticker))[:fallback_reserve]
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    with tempfile.TemporaryDirectory(prefix="market-eod-capacity-") as temporary:
        workspace = Path(temporary)
        source = snapshot(source_path, workspace / "source.sqlite")
        archive = snapshot(history_path, workspace / "archive.sqlite") if history_path else sqlite3.connect(workspace / "archive.sqlite")
        archive.row_factory = sqlite3.Row
        seed = None
        codec = None
        try:
            original_snapshot_hash = digest_file(workspace / "source.sqlite")
            capture = capture_metadata(source, source_path, allow_partial)
            actual = {row["name"] for row in source.execute("PRAGMA table_info(alpaca_daily_bars)")}
            if actual != set(BAR_FIELDS):
                raise AnalysisError(f"Source must use migrated 0008 bar schema; incompatible columns: {sorted(actual ^ set(BAR_FIELDS))}")
            if not history_path:
                for migration in sorted((ROOT / "history-migrations").glob("*.sql")):
                    archive.executescript(migration.read_text(encoding="utf8"))
            else:
                # Existing snapshots may predate the additive FK indexes. The
                # disposable model must include their real pages and insertion
                # cost without altering the supplied historical evidence file.
                archive.executescript((ROOT / "history-migrations/0003_history_pointer_indexes.sql").read_text(encoding="utf8"))
            source_size = measure(source)
            schema = [dict(row) for row in source.execute("SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name")]
            codec = Codec()
            archive_result = archive_all(source, archive, codec, now)
            if archive_only:
                fallback = archive_fallback_model(archive,codec,tickers,session,now)
                archive_result["sourceOnlyDatabase"] = archive_result["database"]
                archive_result["database"] = fallback.pop("database")
                archive_result["fallbackReserve"] = fallback
                archive_result["withAdditionalCompleteRevisionAndTransientBytes"] = fallback["physicalBytesAfter"]*2+TRANSIENT_ARCHIVE_BYTES
                archive_result["reserveDefinition"] = "Twice measured archive including preserved revisions and enforced bounded Yahoo population plus 4 MiB; fixtures are not market observations."
            seed = make_seed(source, workspace / "seed.sqlite", session)
            seed_size = measure(seed)
            seed_rows = seed.execute("SELECT COUNT(*) FROM alpaca_daily_bars").fetchone()[0]
            observed = {row[0] for row in seed.execute("SELECT ticker FROM alpaca_daily_bars WHERE feed='sip' AND date=?", (session,))}
            models = [capacity_model(seed, workspace / f"retention-{hot}.sqlite", tickers, session, hot, headroom,
                                     publication_reserve, [] if archive_only else fallback_tickers,
                                     archive_result["fallbackReserve"]["totalReservedTickers"] if archive_only else None) for hot in (260, 90)]
            recommendation = next((model["hotSessions"] for model in models if model["under350MB"]
                                   and archive_result["withAdditionalCompleteRevisionAndTransientBytes"] < TARGET_BYTES
                                   and not capture["partialEstimate"]), None)
            return {"version": 1, "measuredAt": now, "sessionDate": session,
                    "source": {"snapshotSha256": original_snapshot_hash, "database": source_size, "capture": capture,
                               "schemaSha256": hashlib.sha256(json.dumps(schema, sort_keys=True).encode()).hexdigest()},
                    "population": {"count": len(tickers), "sha256": hashlib.sha256(json.dumps(tickers, separators=(",", ":")).encode()).hexdigest(),
                                   "targetSessionSipMissing": sorted(set(tickers) - observed)},
                    "archive": archive_result,
                    "bootstrap": {"strategy": "Archive every existing bar; seed only latest observed bar at or before target per feed/security.",
                                  "recentRowsToInsert": seed_rows, "database": seed_size, "nonPriceRowsPreserved": True,
                                  "actualBilledWritesKnown": False},
                    "retentionModels": models, "storageOnlyRecommendedHotSessions": recommendation,
                    "consumerParity": {"verified": False, "reason": "Encoding/storage equality is not full workflow/output parity."},
                    "productionAcceptance": {"verified": False, "required": ["Remote populated database sizes and index/write costs",
                        "Actual consumer parity for all historical workflows", "Publication-growth reserve independently measured",
                        "Source/calendar/membership correctness and real runner budgets/CPU", "Concurrent-writer catch-up before binding cutover"]},
                    "limitations": ["Models retain existing non-price rows but do not forecast unrelated workflow growth.",
                        "All shared SIP tickers retain hot history; Yahoo uses a lossless archive capped at 1000 securities with explicit missing coverage beyond capacity." if archive_only else
                        "Both SIP and Yahoo price windows are reserved for every shared ticker." if fallback_reserve == len(tickers) else
                        "Fallback population is an operator assumption, not a bound implied by the daily Yahoo request limit.",
                        "Representative capacity rows are temporary synthetic storage fixtures, never financial observations.",
                        "A logical snapshot is non-atomic unless independently fenced; captured-row equality does not prove complete production-history preservation.",
                        "Local SQLite sizes do not prove Cloudflare physical size or billed usage.",
                        "No existing history snapshot supplied; independently verify destination archive was empty." if not history_path else
                        "Existing archive included and checksummed; obsolete immutable blocks were preserved conservatively.",
                        "No future publication reserve supplied; capacity selection is provisional." if publication_reserve == 0 else
                        "Publication reserve is an explicit operator assumption and must have independent evidence."]}
        finally:
            if codec:
                codec.close()
            if seed:
                seed.close()
            archive.close()
            source.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-sqlite", type=Path, required=True)
    parser.add_argument("--history-sqlite", type=Path)
    parser.add_argument("--tickers-json", type=Path, required=True)
    parser.add_argument("--session-date", required=True)
    parser.add_argument("--sweep-headroom-sessions", type=int, default=10)
    parser.add_argument("--publication-growth-reserve-bytes", type=int, default=0)
    parser.add_argument("--fallback-ticker-reserve", type=int, help="Diagnostic legacy dual-hot model override; default measures the enforced bounded Yahoo archive layout.")
    parser.add_argument("--allow-partial-estimate", action="store_true", help="Allow incomplete logical captures for estimates only; never recommend retention or certify parity.")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        inputs = [args.source_sqlite, Path(str(args.source_sqlite) + ".metadata.json"), args.tickers_json,
                  *([args.history_sqlite] if args.history_sqlite else [])]
        if args.output.resolve() in [path.resolve() for path in inputs]:
            raise AnalysisError("Output must not overwrite any input snapshot or ticker manifest.")
        report = analyze(args.source_sqlite, load_tickers(args.tickers_json), args.session_date, args.history_sqlite,
                         args.sweep_headroom_sessions, args.publication_growth_reserve_bytes,
                         args.fallback_ticker_reserve, args.allow_partial_estimate)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf8")
        print(json.dumps({"report": str(args.output.resolve()), "sourceRows": report["archive"]["sourceRows"],
                          "bootstrapHotRows": report["bootstrap"]["recentRowsToInsert"],
                          "storageOnlyRecommendedHotSessions": report["storageOnlyRecommendedHotSessions"], "productionAcceptanceVerified": False}))
        return 0
    except (AnalysisError, OSError, ValueError, sqlite3.Error) as error:
        print(f"Offline analysis stopped: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
