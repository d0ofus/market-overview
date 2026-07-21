# `market_rs` Storage Rollout Runbook

This runbook separates additive code rollout from destructive storage cleanup. Applying a remote migration, deploying the Worker, changing rollout flags, deleting legacy tables, or switching a D1 binding each requires explicit approval.

## 1. Local release gate

From the repository root:

```powershell
npm run test -w worker
npm run test -w web
npx tsc --noEmit -p worker/tsconfig.json
npx tsc --noEmit -p web/tsconfig.json
npm run build -w worker
npm run build -w web
```

Confirm the release includes the new additive migration and has not edited migrations `0001` through `0007`:

```text
worker/scanner-cache-migrations/0008_rs_state_v2.sql
```

The safe initial flag state is:

```text
RS_STATE_V2_DUAL_WRITE_ENABLED=false
RS_STATE_V2_READ_ENABLED=false
RS_LEGACY_CACHE_WRITE_ENABLED=true
```

## 2. Remote preflight and migration

From `worker/`, run read-only checks and record the current Worker version, database size, and a D1 Time Travel bookmark:

```powershell
npx wrangler d1 execute market_rs --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('rs_scan_runs','vcp_scan_runs','rs_ratio_cache','relative_strength_config_state') ORDER BY name"
npx wrangler d1 execute market_rs --remote --command="SELECT 'rs_ratio_cache' AS table_name,COUNT(*) AS rows FROM rs_ratio_cache UNION ALL SELECT 'relative_strength_config_state',COUNT(*) FROM relative_strength_config_state UNION ALL SELECT 'rs_scan_run_tickers',COUNT(*) FROM rs_scan_run_tickers UNION ALL SELECT 'vcp_scan_run_tickers',COUNT(*) FROM vcp_scan_run_tickers"
npx wrangler d1 export market_rs --remote --output=../backups/market_rs-before-rs-v2.sql
```

Verify the export exists, is non-empty, and is outside the deploy bundle. Apply only migration `0008`; migrations `0001` through `0007` were historically managed as direct SQL files and must not be replayed against production:

```powershell
npx wrangler d1 execute market_rs --remote --file=./scanner-cache-migrations/0008_rs_state_v2.sql
```

Verify the additive tables:

```powershell
npx wrangler d1 execute market_rs --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('rs_state_latest','rs_state_v2_status') ORDER BY name"
```

Deploy with all three safe initial flag values unchanged. Confirm `/api/scans`, compiled scans, and exports still use the legacy path.

## 3. Retention canary

The maintenance lane now admits all six existing four-unit housekeeping jobs while preserving ten reserve units. Scanner retention deletes at most 1,000 child rows per statement and stops at 5,000 actual `meta.rows_written` per invocation.

Monitor `scanner cache retention completed` logs. The cursor may remain on a partially cleaned run; the next maintenance invocation must resume it. Validate that queued/running runs and the newest completed run per preset remain present:

```powershell
npx wrangler d1 execute market_rs --remote --command="SELECT status,COUNT(*) AS runs FROM rs_scan_runs GROUP BY status ORDER BY status"
npx wrangler d1 execute market_rs --remote --command="SELECT status,COUNT(*) AS runs FROM vcp_scan_runs GROUP BY status ORDER BY status"
npx wrangler d1 execute market_rs --remote --command="SELECT COUNT(*) AS rows FROM rs_scan_run_tickers"
npx wrangler d1 execute market_rs --remote --command="SELECT COUNT(*) AS rows FROM vcp_scan_run_tickers"
```

Do not manually bulk-delete the approximately 87,000 currently eligible child rows. Let bounded maintenance reclaim them over successive invocations.

## 4. Shadow parity

After retention is healthy, enable only:

```text
RS_STATE_V2_DUAL_WRITE_ENABLED=true
RS_STATE_V2_READ_ENABLED=false
RS_LEGACY_CACHE_WRITE_ENABLED=true
```

The compact path reads canonical split-adjusted bars from `MARKET_DATA_DB`, writes `rs_state_latest` plus `rs_features_latest`, and compares its output with the legacy result. `/scans` remains legacy-authoritative.

Inspect authenticated status and D1 diagnostics:

```text
GET /api/admin/scanner-cache/rs-cache-status
```

```powershell
npx wrangler d1 execute market_rs --remote --command="SELECT last_parity_at,checked_count,mismatch_count,last_details_json FROM rs_state_v2_status WHERE id=1"
npx wrangler d1 execute market_rs --remote --command="SELECT COUNT(*) AS states,MIN(latest_trading_date) AS oldest,MAX(latest_trading_date) AS newest FROM rs_state_latest"
npx wrangler d1 execute market_rs --remote --command="SELECT COUNT(*) AS features,MIN(trading_date) AS oldest,MAX(trading_date) AS newest FROM rs_features_latest WHERE status='computed'"
```

Promotion requires:

- A ten-session replay sample covering at least 500 long-history, new, sparse, missing-session, and split-affected symbols.
- Two full production scans on different completed sessions.
- At least 95% valid canonical-bar coverage.
- Exact inclusion, session, boolean, rating, and ranking parity.
- Zero numeric mismatches outside `1e-10`.

Any unexplained mismatch blocks cutover. Keep the legacy path authoritative while fixing or classifying it.

## 5. Read cutover and rollback

For the first cutover, retain dual/legacy writes:

```text
RS_STATE_V2_DUAL_WRITE_ENABLED=true
RS_STATE_V2_READ_ENABLED=true
RS_LEGACY_CACHE_WRITE_ENABLED=true
```

Run two complete scans. Require no fallback, parity mismatch, response-contract change, ranking change, or stale publication. Then disable legacy writes while retaining v2 reads:

```text
RS_STATE_V2_DUAL_WRITE_ENABLED=false
RS_STATE_V2_READ_ENABLED=true
RS_LEGACY_CACHE_WRITE_ENABLED=false
```

Observe for seven calendar days. During this state the legacy backfill endpoint returns HTTP 410 and empty `market_command` legacy fallbacks are disabled. Inactive compact state is pruned in bounded maintenance batches.

Rollback before destructive cleanup by restoring:

```text
RS_STATE_V2_DUAL_WRITE_ENABLED=false
RS_STATE_V2_READ_ENABLED=false
RS_LEGACY_CACHE_WRITE_ENABLED=true
```

Roll back the Worker version as well if code behavior, rather than data coverage, is at fault. Additive tables may remain during rollback.

## 6. Legacy cleanup after separate approval

After the seven-day gate, take a fresh export and Time Travel bookmark. Confirm source search finds no active runtime dependency beyond guarded legacy compatibility code:

```powershell
rg -n "rs_ratio_cache|relative_strength_latest_cache|relative_strength_config_state|rs_scan_rows_latest" src test
```

Prepare a new destructive migration for review; do not modify `0008`. It may drop these tables only after the search, parity record, response-contract tests, and rollback backup are approved:

```text
rs_ratio_cache
relative_strength_latest_cache
relative_strength_config_state
rs_scan_rows_latest
```

Measure D1 size again after 48 hours. The target is below 200 MiB. If it remains above 250 MiB, create a fresh compact D1 database, copy only retained tables, compare table counts and representative query results, and switch the existing `SCANNER_CACHE_DB` binding in a separately approved deployment. Keep the old database unchanged for rollback.
