# Reliable EOD implementation review

Implementation date: 9 September 2026, Australia/Sydney. The implementation was developed on `feat/reliable-eod-pipeline`, based on synchronized GitHub main `7696763`, then committed as `88f8bdc` and fast-forwarded into local `main`. Deployment was subsequently authorized; see the [production release record](reliable-eod-production-release.md) for current infrastructure, migration and deployment status. No hot-history deletion or legacy retirement has occurred.

## Five review stages

| Stage | Main implementation | Review focus |
| --- | --- | --- |
| 1. Contracts and regression fixtures | [Metrics](../worker/src/eod-metrics.ts), [price providers](../worker/src/eod-price-provider.ts), Worker `eod-*.test.ts` and web freshness/series tests | Exact exchange-session anchors, coherent split-adjusted windows, nullable fields, independent metric coverage, raw-volume provenance, provider identity and bounded failure handling. |
| 2. Storage compatibility | [Shared history reader](../worker/src/market-history.ts), [catalog metadata](../worker/src/eod-catalog-service.ts), [guarded retention](../worker/src/eod-history-maintenance.ts), market `0008` and history `0001` migrations | Lossless blocks and read-back checksums; hot/archive parity; correction fences; all retained MAX history; 520-session consumers and selected 1400-session requests; full-population Pattern/RS prefilters without decompressing thousands of archives in a Worker. |
| 3. Batch pipeline | [Runner](../worker/src/eod-runner.ts), [Node entrypoint](../worker/scripts/eod-runner.ts), [workflow](../.github/workflows/eod-market-data.yml), [coordinator](../worker/src/eod-coordinator.ts), [D1 admission](../worker/src/eod-d1-rest.ts) | Full shared catalog, frozen membership/configuration, actual-close scheduling, durable leases/checkpoints, dispatch acknowledgement versus completion, shared provider limits and UTC quota deferral. |
| 4. Pages and supporting sources | [Publication readers](../worker/src/eod-publication-service.ts), [breadth reader](../worker/src/breadth-dashboard-service.ts), [holdings quotes](../worker/src/eod-holdings-quotes.ts), [official rates](../worker/src/official-rates-service.ts), [factual reports](../worker/src/factual-market-report.ts), web page/components changes | All configured rows and sections; eleven sectors; accurate proxy labels; null values and chart gaps; independently dated memberships/holdings; factual commentary; official policy/EFFR; optional rate probabilities/AI; visible-tab polling and completed-refresh invalidation. |
| 5. Recovery and cutover controls | [Rollout gates](../worker/src/eod-rollout-service.ts), [capacity measurement](../worker/src/eod-history-capacity.ts), [history jobs](../worker/src/eod-history-runner.ts), [operator runbook](reliable-eod-rollout.md) | Same-session correction recovery, independent immutable publication pointers, retained per-session revisions, capacity/parity proof, quota-aware maintenance, monitored retirement requirements and archive-compatible rollback. Live execution of this stage remains pending. |

The six page scopes publish independently. The auxiliary `history:catalog` publication contains compact full-population metadata for other workflows; it is recorded separately from the six page publication IDs. A completed run records its input-clock watermark before the final source-guarded publication, so later corrections remain detectable. Shadow candidates receive the same final revision checks.

Verified archival relocation changes storage location without pretending prices changed. Genuine price corrections, historical inserts, renames/moves, deletes and archive repairs invalidate the relevant inputs. Older catalog snapshots survive only provably later append-only changes; ambiguous changes fail visibly. Catalog history is retained for paused and date-specific consumers, and its storage growth must be included in rollout measurements.

## Validation performed

- Final Worker suite after production integration fixes: **150 files, 1127 tests passed**, with process exit code 0. This includes REST batch contracts, atomic rollback, migration parsing and the operator helper.
- The migration helper's **12 isolated Python tests passed**; its production read-only check verified the already-applied schema using 96 reads and zero writes.
- Web suite: **96 tests passed**.
- Worker, web and Node batch-runner TypeScript checks passed.
- Worker dry-run build and production web build passed. The web build generated 34 static pages.
- Git diff whitespace checks passed. No dedicated lint command exists.

SQLite fixtures apply the real migrations and exercise publication transactions, weekly report queries, archive parity, correction races, neutral relocation, failed-transaction rollback, interrupted stages and catalog queries for 6000 securities. Provider tests use controlled fixtures for calendars, price adjustment/identity, pagination, rate limits, errors and missing data. These checks do not establish production Cloudflare CPU, billed query usage, source availability or delivery times. The web build reported an existing stale Browserslist dataset advisory.

## Live acceptance still required

The checked-in runner is configured for shadow validation; publication reads and pruning remain disabled. The history database has been provisioned and its real binding committed; schema and deployment status are tracked in the [production release record](reliable-eod-production-release.md). Follow the [rollout runbook](reliable-eod-rollout.md) for migration order, secrets, shadow validation, bounded reconstruction, activation and rollback.

The audit measured the existing market database at approximately **371 MB**, above the **350 MB** acceptance target. Deleting SQLite rows does not establish that its physical file has shrunk. Resolve and measure that storage constraint before activation/pruning; include existing retained history, indexes, publication/catalog storage, archive revisions and forecast growth. The [shared-budget audit](d1-shared-budget-audit.md) also identifies pre-existing account-wide read pressure and the earnings lookup index included in this change.

Before active ownership, collect a full-universe shadow run with actual D1 billed reads/writes, Worker CPU/query measurements, provider/session validation and consumer parity. The guard requires a matching code revision and recorded publication references; it cannot manufacture live measurements. Before retiring the replaced implementation, verify current accepted publications, input revisions and fresh quota evidence under the unchanged technical cutover limits. The user removed the elapsed observation period on 11 September 2026. Historical session delivery and finalized usage remain operational diagnostics, including weekends and holidays; they are no longer a retirement waiting period.

Rollback keeps archive-aware readers and accepted publications, disables the new writer, and leaves pruning off. Missing or corrected inputs remain explicit recovery states rather than being converted into zero values or marked current because the database is reachable.
