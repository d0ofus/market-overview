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

The daily runner always reconciles at least the latest five exchange sessions, even when the only missing bar is today's close. Missing earlier price anchors extend the split-adjusted price request. Ordinary raw share-volume collection stays within the five-session reconciliation window; older stored raw observations retain their original collection times, and older unknown raw volume remains null. Explicit corporate-action repair retains its full-window behavior. An unchanged observation keeps its stored provenance and does not create another archive revision or a duplicate hot-table row merely because it was fetched again.

A planned 65-minute storage-bootstrap yield makes its owned EOD run immediately eligible to resume. It does not impose the provider-failure cooldown. When that same approved bootstrap resumes, a complete chunk with valid current prices and daily returns may retain unavailable 200-day metrics as null instead of repeating the completed price work. Ticker sets, input revisions and calendar signatures must still match. Ordinary retries, changed inputs, reconciliation runs and real current-session failures continue to recheck prices; quota and provider cooldowns are unchanged.

### Archive pointer index recovery

History migration `0003_history_pointer_indexes.sql` indexes both foreign-key columns on `market_history_block_pointers`. Without these indexes, SQLite scans the entire pointer table twice when deleting an obsolete block, even though the explicit delete selects one block by its primary key. The additional indexes preserve foreign-key validation and are included in the measured storage model.

For the already captured, first-chunk bootstrap failure, `worker/scripts/recover-storage-history-indexes.ts` provides a separate `prepare`, `apply`, then `approve` protocol. Run it from clean, reviewed, pushed `main` with the original migration/database identities, previous execution revision and selected plan hash. Preparation records the real failure, unchanged source/target/history revisions, completed consumer proofs, physical sizes and query plan. Application admits only the two exact indexes, with an explicit populated-index build allowance and a bounded pointer count. Approval verifies the indexed query plan, current Paid headroom and physical capacity before recording an immutable schema amendment and advancing the executor pin.

This recovery preserves the original copy and consumer proof dates, pending price repairs and partial bootstrap writes. It does not repeat completed parity checks, rewrite the original schema capture, or clear unrelated provider/quota failures. The final full-population capacity measurement must include the indexes before public cutover. Subsequent session plans may inherit the amendment only through authenticated, immutable lineage with the same capture and ticker population.

The runtime validation reader adds `bootstrapInputs` and `sizingHash` to its returned plan. The amendment loader validates those derived values and excludes them from the immutable plan hash; unknown additional fields still fail validation. `worker/scripts/continue-storage-history-indexes.ts` handles the specifically reviewed correction to this integration. It preserves the original index approval through a separate executor continuation, verifies the complete checkpoint manifest and the recorded index migration, and updates only the plan, owner and executor references. It leaves the queued price run intact.

## Daily code ownership

The `market-eod` environment variable `EOD_PRODUCTION_CODE_REVISION` pins both ordinary daily ingestion and the daily monitor to the exact approved code. Their workflow files still run from `main`, but checkout and `EOD_CODE_REVISION` use this pin. With no pin, the original `github.sha` checkout remains the fallback. Each runner verifies the declared revision against `git rev-parse HEAD`; the triggering main SHA never impersonates pinned execution.

Initial activation sets the pin to the accepted execution revision before enabling active ingestion. Final configuration recording advances it to the separately approved configuration commit only after checking the serving deployment, actual GitHub identities and the measured 90-session storage approval. It then verifies the real pin and pruning setting before recording completion. Later unrelated main commits do not move the EOD writer. Changing Worker/EOD code requires its own approval and deliberate pin update.

## Capacity renewal

The `EOD storage capacity renewal` workflow checks the approved production population and remaining measured forecast at 00:17, 12:17 and 14:17 UTC daily. The 00:17 attempt can use newly accepted EOD publications and refreshed memberships. It shares the EOD writer concurrency group and checks out the approved production revision. A renewal is due when membership changes or five exchange sessions remain in the forecast. Before public cutover the job is inactive.

Renewal captures the current recent/history databases through admitted, bounded reads and checks their write revisions before, during and after capture. Disposable local SQLite files preserve the real schema and indexes for measurement. An independently flattened archive reference verifies the full current population through the historical reader contracts. Actual accepted publication payloads supply the growth model. Only a successful current measurement can advance the capacity approval; it cannot approve different application code or alter the 90-session storage policy.

The admin storage panel reports renewal progress, failures and the next eligible retry. An interrupted or inconsistent capture is discarded and measured again; the previous approval retains its original dates. Quota exhaustion defers further attempts until the next UTC budget window. These temporary measurement files are not application history and are not uploaded as Actions artifacts. Failure to renew does not fabricate new headroom or extend an expired forecast.

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

## Auxiliary source correctness

Active daily commentary follows the accepted EOD session and publication revisions. A later-dated premarket placeholder cannot hide it. Weekly inputs select one report per session; a failed current attempt remains separate from a dated older successful report. Public FOMC reads use stored official material, while scheduled refresh remains responsible for collection.

RateProbability attempts have durable ownership and cooldowns, including a 24-hour pause after HTTP 403. Dated last-good estimates remain visible only for applicable meetings, independently of official policy facts and EFFR. Holdings validation rejects mixed-fund lists and inconsistent weights, preserves explicit percentage units, and identifies physical bullion separately from equities.

EATZ's last trading session was April 30, 2026, and liquidation proceeds were distributed on May 7. The configured instrument and its historical prices remain retained; current prices are unavailable and its contaminated holdings cache is quarantined. This is a closed fund, not an ingestion outage. Sources: [issuer announcement](https://www.sec.gov/Archives/edgar/data/1408970/000182912626003345/advisorshares-eatz_497.htm), [OCC liquidation confirmation](https://infomemo.theocc.com/infomemos?number=58928).
