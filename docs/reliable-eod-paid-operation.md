# Paid processing with Free-compatible storage

Workers Paid is used to accelerate the existing EOD recovery and daily pipeline. The storage contract remains unchanged: 90 recent exchange sessions, lossless versioned history blocks, verified archive readback before pruning, and a 350 MB operating target for each recent-price and history database. Historical consumers continue to use the shared range reader. There is no elapsed observation requirement before activation.

## Resource profiles

`EOD_BUDGET_PROFILE` is explicitly configured in both the Worker and GitHub's `market-eod` environment. Missing configuration selects `free`; an unrecognized value fails closed. The setting does not purchase a subscription or infer billing entitlement.

| Application ceiling | Free | Paid |
| --- | ---: | ---: |
| EOD reads per UTC day | 2,500,000 | 1,000,000,000 |
| EOD writes per UTC day | 50,000 | 8,000,000 |
| Account reads per UTC day | 4,500,000 | 1,500,000,000 |
| Account writes per UTC day | 90,000 | 10,000,000 |
| Account reads over the current and previous 30 UTC days | Daily limits above | 20,000,000,000 |
| Account writes over the current and previous 30 UTC days | Daily limits above | 35,000,000 |

The rolling window conservatively covers any monthly subscription renewal period. Reservations and the greater of account analytics and the local usage ledger count toward admission. Missing or stale Paid-window telemetry defers work. Account analytics include other databases and workloads; moving calculations to GitHub does not exempt their D1 queries from billing.

These are operating ceilings, not a hard Cloudflare bill cap. Public traffic, unrelated products and independently running applications still require monitoring. The Paid allowances currently include 10 million Worker requests, 30 million CPU milliseconds, 25 billion D1 row reads, 50 million D1 row writes, and 5 GB of D1 storage per month. References: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

The scheduled Worker independently refreshes account analytics using `EOD_CLOUDFLARE_ACCOUNT_ID` and the server-side `EOD_ANALYTICS_TOKEN` secret. This runs before ingestion gates on the existing five-minute heartbeat, including weekends. A durable four-minute claim prevents duplicate collection, and failures keep usage unavailable with a bounded cooldown. Use a token scoped to account analytics where possible. GitHub runners also reconcile during long jobs. The public EOD status reads only the cached indexed ledgers and exposes the selected profile, daily/rolling usage, limits and any unavailable reason.

The deployed Worker uses an explicit 1,000 ms CPU limit. Runtime acceptance records the actual deployment, budget profile, CPU measurements and query counts. A Paid acceptance cannot be reused as proof of Free runtime compatibility.

## Resuming an existing recovery after code changes

The storage migration ID and original source-code revision identify the frozen source and copy checkpoints. They must remain unchanged after copying begins. A separately recorded execution revision authorizes reviewed implementation changes while preserving the source capture, archive content, target database and completed checkpoints. Promotion requires a quiescent writer and verified source identity. New publications and runtime measurements identify the actual executing revision.

## Daily code ownership

The `market-eod` environment variable `EOD_PRODUCTION_CODE_REVISION` pins both ordinary daily ingestion and the daily monitor to the exact approved code. Their workflow files still run from `main`, but checkout and `EOD_CODE_REVISION` use this pin. With no pin, the original `github.sha` checkout remains the fallback. Each runner verifies the declared revision against `git rev-parse HEAD`; the triggering main SHA never impersonates pinned execution.

Initial activation sets the pin to the accepted execution revision before enabling active ingestion. Final configuration recording advances it to the separately approved configuration commit only after checking the serving deployment, actual GitHub identities and the measured 90-session storage approval. It then verifies the real pin and pruning setting before recording completion. Later unrelated main commits do not move the EOD writer. Changing Worker/EOD code requires its own approval and deliberate pin update.

## Downgrade procedure

1. Complete recovery and optional repair bursts first. Keep normal daily processing and public reads on the same recent/archive layout.
2. Check account inventory: no more than ten databases, each below 500 MB, and less than 5 GB total. Preserve the stricter 350 MB recent/archive operating targets.
3. Measure account-wide normal daily reads and writes, including all scans and other workflows. Free operation must fit within the application's 4.5 million-read/90,000-write ceilings, leaving platform headroom.
4. Verify the actual HTTP and coordinator CPU/query measurements against the Free profile. Free's per-invocation limits can fail even when database sizes are small.
5. Change the Worker, runner and local recovery configuration to `free`, deploy and verify matching settings before downgrading billing. Optional repair jobs must defer when Free budgets are unavailable.
6. Keep the archive-aware readers and last accepted publications. A downgrade must never restore readers that lose archived history.

Database-format compatibility does not establish that the entire account's workload fits the Free tier. If current measurements fail the daily or runtime checks, optimize or reschedule the affected work before downgrading.

## Production acceptance

Recovery completes when the full copy and consumer parity pass, the latest eligible session has accepted Overview and independent Breadth publications, measured storage and deployed runtime checks pass, public readers use the verified target, and the final production configuration is recorded. Failures remain visible in Admin with the failed stage and actual retry state. A deployment or an accepted GitHub dispatch alone does not establish data readiness.
