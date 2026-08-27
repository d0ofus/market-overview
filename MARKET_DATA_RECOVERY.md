# Market Data Recovery Runbook

This runbook covers the production cutover from core-owned market state to the three-database layout. Keep `MARKET_PIPELINE_MODE = "paused"` until every paused-stage check passes.

## Database ownership

- `market_command` (`DB`) stores application and user-owned state.
- `market_prices` (`MARKET_DATA_DB`) stores Alpaca assets/bars, repair history, features, source-generated universes, and published Overview/Breadth generations.
- `market_ops` (`OPS_DB`) stores provider reservations and outcomes, pipeline/retry state, source-sync state, capacity samples, and D1 usage accounting.

Production has `MARKET_DATA_DB_REQUIRED=true` and `OPS_DB_REQUIRED=true`. Missing bindings or migrations are hard health failures; market pipelines never fall back to core.

## Paused-stage deployment

From `worker/`:

```powershell
npx wrangler d1 migrations apply market_ops --remote
npx wrangler d1 migrations apply market_prices --remote
node ./scripts/seed-market-ops.mjs --confirm "SEED MARKET OPS COUNTERS"
node ./scripts/backfill-market-publication-state.mjs --confirm "COPY MARKET PUBLICATION STATE TO market_prices"
npx wrangler deploy
```

Verify `/api/health` reports all three databases and `pipelineMode: "paused"`. Verify current Overview and Breadth reads continue to return a published generation or an explicit missing/stale diagnostic. A manual update must return a recorded run ID without contacting a provider.

## Legacy-bar recovery

Run the audit first:

```powershell
npm run legacy-daily-bars:cleanup -w worker --
npm run legacy-daily-bars:cleanup -w worker -- --drop-preflight
```

The destructive mode requires the exact database confirmation:

```powershell
npm run legacy-daily-bars:cleanup -w worker -- --archive-and-drop --confirm market_command
```

The command refuses to drop unless strict market-data mode is enabled, Worker source has no core `daily_bars` dependency, canonical market history is at least as new, every active Overview ticker and SPY/QQQ/IWM have 260 Alpaca SIP split-adjusted sessions, and each active Breadth universe meets its publication coverage gate. It creates a Time Travel bookmark, exports and checksums the legacy table, records schema/index metadata and protected sampled-row hashes, then runs core write, OPS reservation, and market read canaries. A failed post-drop gate automatically restores the Time Travel bookmark.

Archive manifests and state files are written below `worker/tmp/` by default and must be copied to immutable external storage before they are treated as the production recovery record.

Apply core migration `0100_post_close_publication_target.sql` after writable capacity is restored. It changes existing installations from a 35-minute to a 30-minute post-close start.

## Canary and activation

Change `MARKET_PIPELINE_MODE` to `canary`, deploy, and call the authenticated `POST /api/admin/market-pipeline/canary` endpoint for a bounded 80-ticker provider/storage cohort. Canary mode does not run scheduled publication or move public generation pointers. Confirm stored provenance is Alpaca/SIP/split for bars and exact-session Alpaca/IEX for any snapshot fallbacks. If the canary reaches a D1 daily budget guard, leave the deployment in `canary`, wait for the recorded UTC reset time, and rerun it before activating.

Change the mode to `active` only after the canary succeeds. Process the expected session first and observe two completed US sessions before removing legacy compatibility reads. Do not activate when any database is critical, an active universe is beyond its source-age ceiling, or current-session coverage is below 98% for S&P/Overview or 95% for the other Breadth universes.

## Failure behavior

- Failed candidates never move publication pointers; dashboards display the last valid generation with its actual session, trading-session age, coverage, source mix, and concrete error.
- Overview accepts only exact-session Alpaca SIP completed daily bars or exact-session Alpaca IEX snapshot fallbacks. Yahoo is never an Overview current source.
- Yahoo rows are labeled `repair-yahoo`, are historical only, and may supply no more than 5% of a Breadth feature input.
- Provider reservations occur atomically in OPS before network calls. OPS failure returns `provider-budget-unavailable`/`ops-db-unavailable`; exhausted reservations return `provider-budget-exhausted`.
- Detailed OPS data is retained for 14 days, aggregates for 90 days, and cleanup runs in bounded batches.

If the post-drop database remains unwritable after Cloudflare updates storage accounting, stop with the pipeline paused and build `market_command_v2` from current migrations excluding the retired legacy market table. Copy and validate all remaining tables before changing the `DB` binding; keep the original database and Time Travel bookmark until the replacement passes all protected-count/hash and write canaries.
