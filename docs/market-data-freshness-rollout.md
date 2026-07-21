# Market-Data Freshness Rollout Runbook

This runbook is intentionally not executable as a single script. Every remote mutation requires a separate approval, an operator review of the immediately preceding read-only checks, and confirmation that the target database name matches `worker/wrangler.toml`.

## 1. Local release gate

From the repository root, record the commit SHA and run:

```powershell
npm run test -w worker
npm run test -w web
npx tsc --noEmit -p worker/tsconfig.json
npx tsc --noEmit -p web/tsconfig.json
npm run build -w worker
npm run build -w web
```

Do not proceed if a new failure is unexplained. Normal automated tests must not need live provider credentials.

Review the four additive migrations and confirm no applied migration was edited:

```text
worker/market-data-migrations/0003_freshness_core.sql
worker/migrations/0092_market_data_freshness.sql
worker/scanner-cache-migrations/0007_retention_indexes.sql
worker/pattern-migrations/0005_completed_run_pointer.sql
```

The repository's full, fresh `market_command` migration chain currently has a pre-existing duplicate-column conflict at `0007_config_refresh_local_time.sql` because its column is already present in `0001_init.sql`. Migration `0092` has been validated against the required existing schema. Before applying it, use `wrangler d1 migrations list` and confirm the production migration ledger already records every expected migration through `0091`. If the ledger is incomplete, stop and repair that baseline in a separately reviewed change; do not bypass Wrangler's migration ledger with a raw execution of `0092`.

## 2. Remote preflight and recoverability

Run these read-only commands from `worker/` after approval:

```powershell
npx wrangler d1 execute market_command --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('universes','snapshots_meta','provider_usage_daily') ORDER BY name"
npx wrangler d1 execute market_prices --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('alpaca_daily_bars','market_data_daily_usage') ORDER BY name"
npx wrangler d1 execute market_rs --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('rs_scan_runs','vcp_scan_runs') ORDER BY name"
npx wrangler d1 execute market_patterns --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pattern_runs','pattern_scores_latest') ORDER BY name"
npx wrangler d1 migrations list market_command --remote
npx wrangler d1 migrations list market_prices --remote
```

Capture the current Worker deployment/version ID, cron triggers, D1 Time Travel bookmarks, and database sizes. Export logical backups to a new operator-controlled directory; never overwrite an earlier export:

```powershell
npx wrangler d1 export market_command --remote --output=../backups/market_command-before-freshness.sql
npx wrangler d1 export market_prices --remote --output=../backups/market_prices-before-freshness.sql
npx wrangler d1 export market_rs --remote --output=../backups/market_rs-before-freshness.sql
npx wrangler d1 export market_patterns --remote --output=../backups/market_patterns-before-freshness.sql
```

Verify the four files exist, are non-empty, and are outside the deploy bundle. If exports or Time Travel are unavailable, stop.

## 3. Migration order

Apply only after the backup and schema checks pass. The safe order is canonical market data, main application metadata, scanner indexes, then pattern publication pointer:

```powershell
npx wrangler d1 migrations apply market_prices --remote
npx wrangler d1 migrations apply market_command --remote
npx wrangler d1 execute market_rs --remote --file=./scanner-cache-migrations/0007_retention_indexes.sql
npx wrangler d1 execute market_patterns --remote --file=./pattern-migrations/0005_completed_run_pointer.sql
```

Stop on the first error. Confirm the two `migrations apply` commands list only the intended pending migration before accepting their confirmation prompt. Do not retry an `ALTER TABLE` migration until the exact remote schema and migration ledger have been inspected. The schemas are additive, so a code rollback does not require dropping the new tables or columns.

After migration, repeat the preflight checks and additionally verify:

```powershell
npx wrangler d1 execute market_prices --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('bar_coverage','daily_market_features','market_calendar_sessions') ORDER BY name"
npx wrangler d1 execute market_command --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('universe_versions','universe_version_members','overview_generations','overview_snapshot_pointer','data_readiness','refresh_jobs','provider_usage_minute','peer_metric_cache') ORDER BY name"
```

## 4. Worker canary

Deploy only with separate approval and the repository's normal release process. Do not change provider credentials or feature flags in the same release. Confirm the deployed triggers remain exactly:

```text
*/5 * * * *
*/15 * * * *
11,26,41,56 * * * *
```

For the first completed US session, watch the market lane from 15 minutes after the close until publication completes. Exact-session ingestion must remain globally ahead of historical gap repair. Each lane invocation may then attempt readiness-gated feature/breadth publication followed by overview publication; an incomplete attempt must retain the prior valid breadth row and pointed overview generation. Each invocation must process no more than four provider batches of at most 80 tickers.

Read-only health queries:

```powershell
npx wrangler d1 execute market_prices --remote --command="SELECT usage_date,bars_written,rows_read,rows_written FROM market_data_daily_usage ORDER BY usage_date DESC LIMIT 7"
npx wrangler d1 execute market_prices --remote --command="SELECT status,COUNT(*) AS tickers,MIN(observed_end) AS oldest_end,MAX(observed_end) AS newest_end FROM bar_coverage GROUP BY status ORDER BY status"
npx wrangler d1 execute market_command --remote --command="SELECT domain,scope,status,coverage_pct,expected_as_of_date,source_as_of_date,warning,updated_at FROM data_readiness ORDER BY domain,scope"
npx wrangler d1 execute market_command --remote --command="SELECT p.config_id,p.generation_id,g.status,g.as_of_date,g.coverage_pct,g.generated_at FROM overview_snapshot_pointer p JOIN overview_generations g ON g.id=p.generation_id"
npx wrangler d1 execute market_command --remote --command="SELECT status,COUNT(*) AS jobs,MIN(lease_expires_at) AS oldest_lease FROM refresh_jobs GROUP BY status ORDER BY status"
npx wrangler d1 execute market_command --remote --command="SELECT provider_key,request_count,updated_at FROM provider_usage_minute ORDER BY minute_bucket DESC,provider_key LIMIT 30"
```

The first canary fails if any of these occur:

- A rejected or partial overview generation moves the pointer.
- S&P 500 breadth is published below 98% coverage, another universe below 95%, or Yahoo repairs exceed 5%.
- A running job remains beyond its lease plus one market-lane interval.
- Normal daily work reaches 70,000 writes or 4 million reads; all market-data work must stop before 90,000 writes or 4.5 million reads.
- A database reaches 400 MB without warning or noncritical writes continue at 450 MB.
- Public dashboard, breadth, gappers, peer/sector, ticker, correlation, pattern-chart, or FedWatch GETs make provider requests or D1 writes.

Exercise one controlled provider failure in a non-production environment. The dashboard must return the prior pointed generation with stale/degraded metadata, and the last valid breadth row must remain intact.

## 5. Ten-session observation gate

Do not stop legacy bar mirroring or authorize legacy cleanup until ten consecutive trading sessions satisfy all of the following:

- Overview is within the 15-minute target for at least 99% of healthy-provider slots.
- Every pointed overview generation is ready; rejected candidates never replace a better generation.
- S&P 500 breadth coverage is at least 98% and every other promoted universe is at least 95%.
- Feature-based breadth matches the legacy formula fields within stored precision. The unit parity test must remain green, and daily production samples must compare advancers, decliners, moving-average percentages, highs/lows, and median returns.
- Universe versions are plausible. Large-change candidates remain rejected until the authenticated `POST /api/admin/universe-versions/:versionId/approve` action is deliberately used.
- Provider and D1 budgets, storage thresholds, lease recovery, and page response compatibility remain healthy.

The implementation uses a conservative 800-calendar-day canonical retention window, approximately 550 US sessions, for all canonical symbols during rollout. It deliberately defers per-consumer 320/550-day pruning because cross-database classification adds operational risk while `market_prices` is small. Revisit tiered pruning only after measured growth; never lower retention below the deepest active consumer's verified requirement.

## 6. Rollback

If code behavior is unhealthy, roll back to the captured prior Worker version using the normal Cloudflare rollback procedure. Keep the additive migrations in place; prior code ignores them. Restore the three prior cron definitions only if the code rollback does not restore them automatically.

If a universe was promoted incorrectly, promote the last known-good version by its stored member set through an explicitly reviewed admin action. Do not delete the diagnostic candidate.

If an overview candidate is bad, leave the pointer on the last-ready generation. If a bad generation was incorrectly promoted, update the pointer only after identifying a known-good ready generation and recording the incident; prefer a corrective code rollback over manual SQL.

Use D1 Time Travel or the verified logical export only for confirmed data corruption, not ordinary code rollback. Any restore is a separate destructive production action requiring explicit approval.

## 7. Legacy cleanup after approval

After the ten-session gate, stop legacy bar mirroring in a separate release. Retain `DB.daily_bars` unchanged for another 30 calendar days while checking ticker, correlation, sector trends, scans, RS/VCP, patterns, watchlists, and public response contracts.

Prepare, but do not execute, a deletion report containing row counts, oldest/latest dates, the final backup/Time Travel bookmark, and every remaining legacy reader found by:

```powershell
rg -n "FROM daily_bars|INTO daily_bars|UPDATE daily_bars" worker/src -g "*.ts"
```

Only the deliberate compatibility branches in `worker/src/daily-bars.ts` may remain before mirroring is disabled. Dropping or deleting legacy rows is a separate production change and is not authorized by this runbook.
