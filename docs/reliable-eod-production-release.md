# Reliable EOD production release

Release started 9 September 2026, Australia/Sydney. Production deployment was explicitly authorized. This record distinguishes deployed infrastructure from the remaining live acceptance gates.

## 9 September credential follow-up and first shadow attempt

GitHub CLI workflow authorization is now complete. The user rotated the Alpaca pair in `market-command-worker` and added both environment secrets to `market-eod`; secret names were verified without retrieving values. The Worker's GitHub dispatch token was refreshed. Commit `d52f2e9c813320ed6cc3483186fd66025b22f0ce` published the executable `.github/workflows/eod-market-data.yml`; its Vercel Production deployment reported success.

The first durable run, `eod:shadow:2026-09-08:daily`, was created through the shared coordinator and dispatched as [GitHub run 34352578719](https://github.com/d0ofus/market-overview/actions/runs/34352578719). GitHub authenticated with Alpaca and refreshed verified exchange-calendar coverage from 2020-08-30 through 2027-01-27. This proves calendar authentication, not complete SIP price coverage or successful publication.

The attempt stopped during input loading with 93,321 recorded EOD reads and 40,579 writes, released its reservations and recorded a retry. It exposed two concrete bootstrap defects:

- The official IWM file, dated 4 September, contains three placeholder `-` rows explicitly marked `NO MARKET (E.G. UNLISTED)`: an Arcellx CVR and two OmniAb private vesting positions. Ticker validation ran before the existing non-market exclusion. Reordering only that exclusion now produces 1,944 members from 1,958 source equity rows, preserving three duplicate occurrences, 14 excluded positions and unresolved-identifier diagnostics. Listed malformed identifiers still fail. The fetched issuer payload SHA-256 is `bcd873cca76af13cc1c7aa65f5eaa3ac26f8e2745cc417f6202d6dcc9657005b`.
- The historical membership join used 26,497 actual D1 reads against a generic 25,000 reservation. The corrected query scopes versions to the five core universes, guards their maximum populations and receives its own conservative reservation; daily limits are unchanged. Safe errors now include query classes and actual/reserved counts. A subsequent admitted live input load passed for all **5,921 unique shared tickers** and all five historical memberships. Retained-version growth can still trigger a measured overrun; the reservation is not a claim that historical growth is mathematically bounded.

A separate regression fixes missing durable run IDs incorrectly returning a successful no-op. Completed or leased duplicate runs remain harmless. No historical memberships were backdated, no accepted page pointers were changed and no history was pruned. Initial bootstrap can span UTC quotas; it does not establish steady-state close-plus-two-hours performance.

Commit `94f6a9bd2601b3d7cc6dae63f0455ecfea0bb3d4` shipped the bootstrap fixes and Vercel reported success. The full Worker suite passed **151 files / 1,136 tests** with four parallel processes after the first run hit local timeouts. Worker and runner typechecks and the Worker build passed. The unchanged web suite also passed 96 tests and its typecheck; no web runtime code changed in this follow-up.

The resumed [daily run 34354249011](https://github.com/d0ofus/market-overview/actions/runs/34354249011) reached price ingestion. Its Alpaca SIP history requests returned HTTP 200 with no authentication or rate-limit failures. The Cloudflare cron independently dispatched [reconciliation run 34354388012](https://github.com/d0ofus/market-overview/actions/runs/34354388012), confirming the deployed dispatch credential and workflow path. Both runs stopped before admitting work that exceeded remaining daily write headroom and saved **2026-09-10T00:05:00Z** for automatic retry. At 13:02 UTC the EOD ledger held 304,393 reads / 47,010 writes and no outstanding reservations. The account analytics sample held 1,909,538 reads / 69,703 writes; this sample can lag current use. No page publication has been accepted yet.

Live polling also exposed the calendar lookup's `OR` query plan: 3,027 D1 reads per expected-session lookup. An equivalent explicit date range used **3 reads**, with the same September 8 result and SQL time falling from 0.6572 ms to 0.083 ms. The final coordinator regression covers the actual primary-key query plan, holidays, early closes, New York midnight and winter offsets. All 51 coordinator cases passed (one temporary SQLite setup failure passed on isolated rerun); both typechecks and the Worker build passed after this change.

Worker version **`cd1a83e8-1ccb-4aa8-a01e-997891e43ee2`** is deployed with `EOD_RUNNER_MODE="shadow"`, publication reads false and pruning false. Existing schedules and queue bindings were retained. `/api/health` returned 200 with all four databases connected; `/api/eod/status` returned shadow mode, `ready:false`, visible quota deferral and the saved next retry. Shadow scheduling is operational; public delivery is not active.

The final market file measured **375,291,904 bytes**, and history measured 53,248 bytes. Market storage remains above the 350 MB activation gate. A supported storage remedy with archive parity and measured full-population headroom is still required before active cutover; deleting rows cannot be credited as physical compaction. The earlier deployment record below describes the initial disabled state.

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
# 2026-09-09 storage migration implementation

The next storage phase adds a reviewed-schema, resumable archive-first copy runner, a dedicated GitHub workflow, persistent source fencing and checkpoints, quota-aware recovery, and visible admin/readiness state. It preserves all source feeds and non-price tables, seeds only the latest available bar per feed/security at or before the frozen session, copies the Wrangler migration ledger, and installs business triggers after copying revision state. Copy completion stops before cutover for independent verification.

The remaining hot-only reader dependencies were corrected. A compact catalog supplement supports exact holding predecessors and sector trends; cutover requires the full supplement. Exact-date planning checks hot rows first (6 Market queries and no Archive queries for the 6,000-symbol fixture). Archive latest-date manifests reject mismatched security/year/format metadata.

Remote additive migrations applied successfully: Ops `0010_market_storage_migrations.sql` and Market `0009_market_storage_fence.sql`. The source fence remains **open**, with no guard triggers installed. No source history has been deleted and no replacement binding or public EOD cutover has occurred in this phase.

Validation: full Worker suite **156 files / 1,173 tests passed**; all web library suites passed; Worker/web/runner typechecks and both builds passed. The final archive-manifest integrity test also passed. Updated control/copy tests passed across focused runs; one five-second Python/SQLite harness timeout was resolved with a scoped timeout and successful isolated rerun. No lint command exists.

The live capacity capture is a metered, read-only, resumable logical snapshot. It is explicitly non-atomic and is diagnostic evidence only. Existing history was captured separately (24 blocks and 24 pointers); actual full-population modeling and the production copy remain separate acceptance work. See [migration sequence and remaining phases](reliable-eod-storage-migration.md), [capacity analysis](reliable-eod-storage-analysis.md), and [reader parity](archive-only-reader-parity.md).
