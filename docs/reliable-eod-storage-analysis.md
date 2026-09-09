# Offline EOD storage analysis

`worker/scripts/analyze-eod-storage.py` measures a local market SQLite snapshot and the application's actual archive codec. It makes no Cloudflare, GitHub or provider requests. It creates disposable local databases and emits a JSON report. Its output is capacity evidence, not approval to prune, switch bindings or publish data.

## Run the analyzer

Requirements: Python 3.11 or later, Node with the repository's installed `tsx` dependency, and enough temporary disk space for several copies of the source and the populated models. Windows Python builds without SQLite `dbstat` are supported. The fallback page-accounting reader loads one SQLite image into memory, so allow memory beyond the largest database file.

From the repository root, after the logical snapshot extraction has completed:

```powershell
python worker/scripts/analyze-eod-storage.py `
  --source-sqlite worker/tmp/eod-storage-source.sqlite `
  --tickers-json worker/tmp/eod-storage-source.sqlite.tickers.json `
  --session-date 2026-09-08 `
  --output worker/tmp/eod-storage-analysis.json
```

Use the target session from the frozen EOD run; the date above is an example. The ticker manifest accepts a JSON string array, an object containing `tickers`, or an object containing the runner's `input_json`. Supply the entire frozen shared ingestion universe, including unsupported and currently missing symbols. The analyzer validates uniqueness and reports its count/hash; it cannot independently prove an arbitrary supplied list is the complete configured universe.

If a destination archive already contains data, add `--history-sqlite <local-history-snapshot>`. Omitting it models an empty archive and leaves an explicit limitation requiring that assumption to be verified. Existing immutable archive revisions are retained in the measurement.

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `--sweep-headroom-sessions` | `10` | Additional retained rows per modeled security/feed beyond 260 or 90; values below 10 are rejected. |
| `--fallback-ticker-reserve` | Entire shared population | Securities with a coexisting full Yahoo EOD window. A smaller number is an explicit operator assumption. A 250-request daily limit does not bound the accumulated number of fallback securities. |
| `--publication-growth-reserve-bytes` | `0` | Additional bytes beyond existing copied publication tables/indexes. Zero gives a baseline report with a provisional capacity selection. Production acceptance needs a measured growth allowance and operating horizon. |
| `--allow-partial-estimate` | Off | Allows an incomplete logical extraction for diagnostic estimates only. Such a report never recommends a retention choice or certifies parity. |

The sidecar `<source>.metadata.json` is detected automatically. For logical captures, the analyzer requires its `complete` declaration and completed extraction checkpoints for every captured application table. It excludes `_storage_snapshot_progress` and its index from the measured application schema, only in its private copy. Missing metadata or incomplete checkpoints fail by default. A completed unfenced logical capture remains non-atomic: concurrent inserts, edits and deletes may not all appear in the same logical state. A local SQLite backup provides consistency only for the captured local file.

New logical extractions also write an immutable `<source>.identity.json`. The extraction helper pins the account, source database UUID, frozen run ID, reviewed schema hash and exact frozen-input hash. It verifies the live source schema against the reviewed manifest and the existing local schema before initialization/resume. Changed identities, inputs, ticker manifests or local DDL fail without overwriting existing manifests. A preexisting capture without identity is rejected; use a new output path or obtain a separately reviewed adoption of the known capture. The helper does not infer identity from whatever environment happens to be present on restart.

For a one-time local retry after a quota reset, `worker/scripts/resume-storage-capacity-once.ps1` accepts `-ExpectedCommit <full SHA>` and `-AfterUtc <ISO timestamp>`. It inherits the snapshot helper's required environment variables and credentials, verifies the clean pinned checkout before and after waiting, resumes capture once, and runs preliminary analysis using `worker/tmp/eod-storage-history.sqlite`. `-ValidateOnly` checks configuration without waiting or making API calls. The helper writes ignored status/log files under `worker/tmp/`; it requires the computer to remain running, does not survive reboot, and pauses if the checkout changes. Without `EOD_STORAGE_START_APPROVED=true`, it stops at capacity analysis. With that explicit operator opt-in, completed analysis can invoke `start-storage-migration-once.ts`, which independently validates the complete report, actual source schema/bindings, account headroom, snapshot backup checksum, frozen inputs and pinned GitHub main before provisioning an empty target, recording/authorizing the durable migration and dispatching it. This opt-in authorizes source fencing and the verified relocation workflow; it does not enable public EOD reads, change the canonical market binding or delete the source. See the [one-time start protocol](reliable-eod-storage-migration.md#one-time-start-after-capacity-analysis). The default zero publication-growth reserve and earlier history snapshot remain preliminary; final production acceptance requires independent measured evidence.

## What is measured

1. Snapshot the local input through SQLite's read-only backup API, including committed WAL data. Record the snapshot and application-schema hashes. Source files are never modified.
2. Measure real tables, indexes, overflow pages, free pages and total local file size. Use `dbstat` when available; otherwise traverse the SQLite B-tree and overflow pages according to the [SQLite file format](https://www.sqlite.org/fileformat2.html). Pointer-map and other allocated non-B-tree pages remain separately reported. These are local measurements, not unsupported remote D1 PRAGMA calls.
3. Group every captured source bar by feed/security/year, including securities outside the active ingestion population. Use the actual TypeScript `encodeMarketHistoryBlock` and `decodeMarketHistoryBlock` functions. Verify existing block checksums and current/previous pointer identity. Merge current hot rows over matching archive dates, preserving all other archived dates and older immutable revisions. Persist blocks in a temporary database using the real history schema, read them back, decode them and compare every captured field.
4. Record uncompressed JSON, gzip and base64 payload bytes, plus the real archive table/index/pointer size. Reserve a conservative second complete archive revision plus 4 MiB of transient capacity. This covers the captured history and an additional correction revision; it does not predict indefinitely accumulating future years or missing backfill history.
5. Build a separate actual bootstrap model containing only each feed/security's latest existing bar at or before the target date. Keep every non-price application row and schema object. Report the recent-row insert count independently from future retention. No prices, timestamps or provenance are invented in this bootstrap measurement.
6. Populate disposable 260+10 and 90+10 capacity models for every frozen shared ticker, using the source's actual schema and indexes. By default, reserve both full SIP and full Yahoo EOD windows. Preserve other feed/non-shared seed rows and existing auxiliary data; include compact revision and repair-state rows for the modeled population. Use full-width numeric fields and populated timestamps to avoid sizing partially populated rows. These synthetic capacity fixtures are never written to a deployable artifact, exposed as market history or used to calculate financial metrics. Their dates are row-width fixtures, not an exchange-calendar reconstruction.
7. Add the explicit future publication reserve and compare both the recent model and conservative archive reserve against **350,000,000 bytes**. Return a storage-only 260/90 choice, or null if neither fits or the capture is partial. Existing auxiliary rows are included; unrelated future auxiliary growth requires its own allowance.

This implements the archive-first sizing strategy: preserve all existing observations in the shared archive, then seed only the latest actual bar per security/feed into a fresh recent database. The chosen recent retention is an upper bound; hot history grows with future daily ingestion. This avoids copying a fully populated 260-session recent table solely to recreate history already preserved in the archive. It does not eliminate the archive/index/pointer writes, metadata copying, source fencing, catch-up verification or free-tier admission checks required for an actual migration.

## Evidence boundaries and remaining gates

The report deliberately separates three claims:

- `archive.storageRoundTripPassed`: the captured bar fields survived the real encoder, SQLite storage and decoder without loss. This is equality of captured rows, not proof that an unfenced capture contains every production revision.
- `consumerParity.verified`: always false. Actual outputs must still be compared for ticker chart MAX, 520-session OHLCV/patterns, five-year correlation including its fetch buffer, RS, scans and watchlist analysis through archive-compatible readers. A codec checksum is not a workflow parity result.
- `productionAcceptance.verified`: always false. Local SQLite size does not prove D1 physical size, billed reads/index writes, runtime limits, complete source membership/calendar history, or safe concurrent-writer cutover. Inspect the JSON limitations before consuming a recommended retention.

Retain the measured JSON and snapshot manifest as operator evidence. Do not commit production market data, local database files, generated synthetic models or credentials. The temporary model databases are deleted automatically; production history must not depend on this report or local extraction artifacts.

The actual migration must independently verify the destination identity, archive read-back, schema/index parity, all non-price state, the frozen source revision and catch-up, actual destination sizes and remaining account allowance. Cloudflare documents the database/free-tier limits in [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and supported transfer behavior in [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/). An offline SQLite measurement does not establish that deleting rows will shrink an existing remote D1 file.

## Focused verification

```powershell
python worker/scripts/tests/test_analyze_eod_storage.py
npm run test -w worker -- test/eod-storage-analyzer.test.ts
```

Fixtures use real market/history migration schemas and the real archive codec. They cover all-feed preservation, missing population members, fallback capacity, schema/index and non-price parity, source immutability, existing archive reuse, orphan pointers, logical snapshot completeness, local bookkeeping exclusion, and exact page ownership across interior/overflow/WITHOUT ROWID/free pages. They make no live provider or D1 calls.
