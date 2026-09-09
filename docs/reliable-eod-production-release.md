# Reliable EOD production release

Release started 9 September 2026, Australia/Sydney. Production deployment was explicitly authorized. This record distinguishes deployed infrastructure from the remaining live acceptance gates.

## Source and validation

- Implementation commit: `88f8bdc`, based on synchronized GitHub main `7696763`.
- Provisioned history binding: `73cb9e1`.
- Archive health diagnostics: `14a35de`; nine focused tests and Worker typecheck passed.
- Final release validation: **150 Worker files / 1127 tests passed**, including the REST/migration regressions and an operator test that runs 12 isolated Python cases. All three TypeScript checks and the Worker build passed. The web's 96 tests and production build passed; no frontend code changed in the deployment follow-up. See [implementation review](reliable-eod-implementation.md).

## Provisioned infrastructure

The existing Cloudflare account is `5ddf4343b603f05fed83f9e102b4b553`. Its ninth D1 database, `market_history`, was created with ID `62b61de4-4920-475b-98b6-7b656d4f0a39`. The other databases were retained. No history was pruned.

The GitHub environment `market-eod` exists with the account ID, four explicit database IDs, pruning disabled, and the Cloudflare D1 token configured as a secret. The token's account analytics permission was verified without exposing its value. The Worker `EOD_GITHUB_TOKEN` dispatch secret is configured. GitHub environment secrets `ALPACA_API_KEY` and `ALPACA_API_SECRET` remain pending; existing Worker secrets were preserved.

## Deployment state

Application commit `913ffe2f539d6c4315281f18ded98b183de2af80` was pushed to GitHub `main`. Vercel's Production deployment `6339300506` reported success at 23:36:06 UTC on 8 September. The production application is [market-overview-nu.vercel.app](https://market-overview-nu.vercel.app); [deployment details](https://vercel.com/cryptonerdo123-2385s-projects/market-overview/FmXAeFWaRUgsaPibaeT7ojpkhbpQ) identify the deployed revision.

The application release excludes the new `.github/workflows/eod-market-data.yml` because the existing GitHub OAuth login lacks `workflow` scope. Browser authorization expired before completion. The exact pending workflow is available as a [non-executing template](workflows/eod-market-data.yml), and the complete original commit history is retained on local branch `release/eod-complete`. Add the workflow after GitHub authorization, before enabling the runner.

Production D1 queries were blocked by the exhausted 8 September read allowance. The account analytics sample reported 28,119,352 rows read and 13,250 written. Work resumed after the 9 September UTC reset. Core index `0102` succeeded at 00:00:10 UTC: 20,297 rows read, 10,120 written. A production `EXPLAIN QUERY PLAN` confirmed `SEARCH symbols USING INDEX idx_symbols_upper_ticker`, replacing the repeated catalog scan.

All required migrations were applied and their schemas verified before Worker deployment:

| Database | Applied migration | Verification |
| --- | --- | --- |
| `market_command` | `0102`, then `0101` | Index query plan, official-rate table and XLC configuration |
| `market_ops` | `0004` through `0009` | Ledger plus history-selection and completion-watermark columns |
| `market_history` | `0001` | Ledger plus immutable-block and pointer tables |
| `market_prices` | `0008` | Ledger, seven new tables, six triggers and three added columns |

The market migration exposed a SQL-splitting defect: Wrangler's remote multi-statement path returned `incomplete input`, and both attempts rolled back completely. Sending 18 complete statements plus the migration-ledger insert through the documented atomic REST batch succeeded at 00:06:24 UTC, using 244 reads and 30 writes. The release adds regression coverage and an explicit migration helper. Separately, a harmless live request exposed the runner's incorrect bare-array REST envelope; D1 requires `{batch:[...]}`. Independent parameter bindings and result ordering were verified live before fixing that adapter.

The corrected TypeScript adapter itself subsequently passed a live two-statement check with independent bindings, using zero rows read/written. The new operator helper verified the production migration as `already-applied`, using 96 reads and zero writes. Quota and capacity failures retain static, sanitized error categories so the runner still defers exhausted resources until the next UTC day. These integration checks do not establish full-universe ingestion cost or historical parity.

Worker version `f80758aa-2d8e-4a51-9cc8-ae78cbc7146a` was uploaded inactive, then promoted to 100% of `market-command-worker` traffic after schema checks. Cloudflare accepted the package and all bindings; the three existing cron schedules already matched configuration. The checked-in writer, publication reads and pruning remain disabled. The existing GitHub check for the older, separate Worker `market-overview` failed on this commit and on its predecessor; the actual application backend was deployed directly. Its build logs require Cloudflare Builds permissions unavailable to the current token.

The deployment follow-up changes the Node-only REST adapter, migration tooling/tests and release documentation. The Worker runtime source remains the version already deployed above, and its final build passed.

Live verification after deployment:

- `/api/health`: HTTP 200, all four databases connected, market storage visibly at warning level.
- `/api/eod/status`: HTTP 200, `mode:"disabled"`, `ready:false`.
- `/api/health/market-data`: HTTP 503 while EOD is disabled, correctly distinct from database connectivity.
- `/api/dashboard`: HTTP 200, all three sections returned; last-good session remains **2026-08-24**, expected **2026-09-08**.
- `/api/breadth/dashboard?historyLimit=1`: HTTP 200, all five universes returned and explicitly stale at **2026-08-05**.
- `/api/weekly-market-review/latest`: HTTP 200; the existing failed Gemini attempt remains visible.

At 00:09 UTC, account analytics reported 238,632 reads and 11,617 writes for the new UTC day. This includes application/deployment work and can lag current use; it is not evidence of a completed EOD run or its steady-state cost.

## Acceptance still outstanding

After schema migration, the market database's measured physical size is **371,331,072 bytes**, above the agreed 350 MB acceptance ceiling; the new history database is 36,864 bytes. Deleting rows does not prove physical compaction. Full-universe capacity/headroom, consumer parity, live provider coverage, actual billed usage and Worker CPU/query limits must pass before active publication ownership. No measured proof or acceptance approval has been fabricated. The release is deployed, but fresh EOD publication is not yet operational.

Ten consecutive real trading sessions meeting the actual-close-plus-two-hours deadline and agreed budgets are required before retiring the legacy implementation. A deployed release, healthy database connection or successful dispatch does not establish those conditions. Follow the [rollout runbook](reliable-eod-rollout.md) for recovery, activation and archive-compatible rollback.
