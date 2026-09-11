# Reliable EOD rollout

This is an operator runbook, not evidence of a completed cutover. New installations keep the runner disabled until provisioning is verified, then validate in shadow mode with publication reads and pruning disabled. Successful recovery promotes the verified target and records a separate canonical production configuration. Inspect Admin's EOD recovery record and the actual deployed Worker bindings for current state; a historical release entry or a successful deployment alone does not establish completion. See the [production release record](reliable-eod-production-release.md) for dated progress. Pruning and technical production acceptance remain gated; no elapsed observation period is required.

## Stage 1 — Inventory, capacity and shared quota

1. Confirm the Cloudflare account, plan, database inventory, current sizes and account-wide daily reads/writes. D1 allowances are shared with unrelated workflows. Existing earnings queries can exhaust the allowance before EOD starts; read [the shared-budget audit](d1-shared-budget-audit.md).
2. Verify the deployed migration ledger separately for core, market, Ops and history. Do not run the root `npm run dev` or `npm run seed`: they reset local data and are not a rollout path.
3. Prepare core space and write headroom before applying `0101_official_rates.sql` and `0102_earnings_catalog_lookup.sql`. The expression index adds approximately one entry per symbol; repeated attempts against a full database are not a capacity plan.
4. Provision the history database only after checking available database slots and aggregate storage. Bind its actual ID as `MARKET_HISTORY_DB`, with `migrations_dir="history-migrations"`. Never deploy a placeholder ID.
5. Measure occupied price-table/index bytes, price-row counts, retained-row counts, and representative gzip blocks including base64/index overhead and two retained revisions. Project market and history databases independently below 350 MB. Deleting SQLite rows need not shrink the physical file immediately.

Read-only inventory commands, run from `worker/`:

```powershell
npx wrangler d1 list
npx wrangler d1 info market_command
npx wrangler d1 info market_prices
npx wrangler d1 info market_ops
npx wrangler d1 migrations list market_prices --remote
npx wrangler d1 migrations list market_ops --remote
```

GraphQL `d1AnalyticsAdaptiveGroups` supplies account usage; query insights rank expensive SQL. Adaptive query-insights estimates do not reconcile exactly to aggregate usage and must not be treated as a billing ledger. Avoid broad SQL scans solely to measure quota.

## Stage 2 — Provision and validate with defaults off

Use the verified database names/IDs from Stage 1. The commands below mutate the specified infrastructure. Consult the production release record and live migration ledgers before running them; do not recreate an already provisioned database or replay applied ALTER TABLE migrations directly.

```powershell
npx wrangler d1 create market_history
# Add the returned real ID to the MARKET_HISTORY_DB binding before proceeding.
npx wrangler d1 migrations apply market_history --remote
npx wrangler d1 migrations apply market_prices --remote
npx wrangler d1 migrations apply market_ops --remote
npx wrangler d1 execute market_command --remote --file=migrations/0101_official_rates.sql
npx wrangler d1 execute market_command --remote --file=migrations/0102_earnings_catalog_lookup.sql
```

Core SQL is idempotent; verify migration history first because this repository's older core setup mixes direct SQL application and migration tooling. Market/Ops migrations must be applied in order, including market `0008` and Ops `0004`–`0009`. Verify the new tables, expression index and required bindings before enabling any runner.

During production rollout, remote Wrangler `d1 migrations apply` rejected market `0008` with `incomplete input: SQLITE_ERROR` while processing its trigger bodies. SQL whitespace fixes make the installed Wrangler splitter work locally, but the remote multi-statement string parser still fails. Use the narrow [0008 operator helper](../worker/scripts/apply-eod-publication-migration.py) for this migration. It uses Python 3.11+ and SQLite's statement-completion parser, sends all 18 complete statements plus the migration-ledger insertion in one D1 REST `{batch:[...]}` transaction, and never accepts an arbitrary SQL file.

From the repository root, with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` already set securely:

```powershell
# Read-only preflight is the default. This UUID must match MARKET_DATA_DB in worker/wrangler.toml.
python worker/scripts/apply-eod-publication-migration.py --database-id a6dedc93-6ffc-4793-9b3d-0ef47e29c4b8
# Apply only if preflight reports dry-run/pending and this target still needs migration 0008.
python worker/scripts/apply-eod-publication-migration.py --database-id a6dedc93-6ffc-4793-9b3d-0ef47e29c4b8 --apply
```

`--account-id` can select the account explicitly instead of the environment variable; `--token-env CLOUDFLARE_EOD_D1_TOKEN` selects an existing alternative secret variable without printing its value. The helper verifies the live database name/UUID, prior migration ledger and schema before applying. An already-applied migration becomes a verified read-only no-op. Partial schema, missing objects behind an applied ledger, or a mismatched target stop execution. HTTP/timeout failures are never automatically replayed; rerun the default read-only preflight to resolve an unknown outcome before attempting another application. The helper prints sanitized source identity and actual query read/write totals. Its schema/ledger probes are bounded and do not scan market history.

Create the GitHub environment `market-eod` and configure:

| Kind | Name | Purpose |
| --- | --- | --- |
| Environment variable | `CLOUDFLARE_ACCOUNT_ID` | Verified Cloudflare account |
| Environment variables | `EOD_CORE_DATABASE_ID`, `EOD_MARKET_DATABASE_ID`, `EOD_OPS_DATABASE_ID`, `EOD_HISTORY_DATABASE_ID` | Explicit runner database allowlist |
| Environment secret | `CLOUDFLARE_EOD_D1_TOKEN` | Account-scoped D1 access; analytics permission is also needed unless a separate analytics token is wired |
| Environment secrets | `ALPACA_API_KEY`, `ALPACA_API_SECRET` | SIP daily bars/calendar and asset catalog |
| Worker secret | `EOD_GITHUB_TOKEN` | Fine-grained access to this repository's Actions dispatch/read APIs |
| Optional Worker secret | `GEMINI_FREE_API_KEY` | Optional enrichment only; absence selects factual reports |

Use secret prompts or the platform UI; never put values in source, logs, command history or `NEXT_PUBLIC_*`. `EOD_GITHUB_REPOSITORY` and `EOD_GITHUB_WORKFLOW` must identify the same main-branch workflow. The REST adapter checks database IDs in software; do not mistake this for provider-enforced per-database token isolation.

The Node entrypoint and workflow accept an optional `CLOUDFLARE_EOD_ANALYTICS_TOKEN`; provision that environment secret if analytics access is separate from the D1 token. A key named “free” does not establish billing policy; verify the Gemini project/free allowance and keep paid features disabled. The new GitHub batch contains no AI credentials or AI calls.

Local validation before deployment:

```powershell
npm ci
npm run test -w worker
npm run test -w web
npx tsc --noEmit -p worker/tsconfig.json
npx tsc --noEmit -p web/tsconfig.json
npm run eod:typecheck -w worker
npm run build -w worker
npm run build -w web
```

A Worker build is a dry run. Deploy the validated Worker and web release with defaults still off only when the release is authorized. Confirm the public status endpoint reports disabled. No dedicated lint command exists.

## Stage 3 — Shadow publications and historical parity

Set `EOD_RUNNER_MODE="shadow"`; keep reads and pruning false. Cloudflare's five-minute coordinator dispatches GitHub work after the cached actual exchange close: first attempt +20 minutes, retry +50, final scheduled attempt +95, deadline +120. The runner uses a single workflow concurrency group and durable run/checkpoint state. Confirm early-close and holiday behavior from the exchange calendar; wall-clock Melbourne time does not determine a US session.

Shadow mode stores candidates without moving public pointers. `/api/eod/status` should remain not-ready for public delivery in shadow; this is expected. Inspect dated candidate payloads and source revisions by scope/session with bounded queries, then compare them with independently calculated exact-session inputs. The public page alone cannot validate shadow candidates. Use the publication decoder: SQL-visible JSON is a compact summary, while the complete immutable page payload is compressed and checksummed. The auxiliary `history:catalog` scope uses queryable compact tuples; it is required for full-population consumer compatibility and does not count as a seventh page scope.

For an explicit bounded run, create its durable run first through the authenticated endpoint; use the returned ID if dispatching manually:

```powershell
$eodHeaders = @{ Authorization = "Bearer $env:ADMIN_SECRET"; "Content-Type" = "application/json" }
$eodBody = @{ sessionDate = "YYYY-MM-DD"; purpose = "reconcile"; retry = $true } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$env:WORKER_ORIGIN/api/admin/eod/runs" -Headers $eodHeaders -Body $eodBody
# If a run exists but needs manual dispatch: gh workflow run eod-market-data.yml -f run_id=<returned-id> --ref main
```

Use a completed exchange session, never the literal placeholder. Backfills and maintenance use the same bounded quota admission and can span UTC resets. Initial archive/bootstrap work can exceed a day's free allowance; no same-day completion promise applies to bootstrap.

Routine weekend history repair ensures the most recent 520 exchange sessions and rechecks retained older history for corrections. It does not request 1400 sessions for every catalog security each week. A new `purpose="backfill"` request with no history options bootstraps the full catalog to 520 sessions. Daily and reconciliation runs always retain their full catalog scope; `historyTickers` and `historySessions` are rejected for daily, reconciliation and maintenance requests.

For a bounded deeper security-history request, use 1400 exchange sessions (at least 1300 plus a buffer when the security has that much valid history) and explicitly name between 1 and 100 symbols:

```powershell
$eodHistoryBody = @{
  sessionDate = "YYYY-MM-DD"
  purpose = "backfill"
  historyTickers = @("MSFT", "BRK.B")
  historySessions = 1400
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$env:WORKER_ORIGIN/api/admin/eod/runs" -Headers $eodHeaders -Body $eodHistoryBody
```

Use the application's security identities. Tickers are trimmed, uppercased, deduplicated and sorted; class punctuation is preserved. The only supported depths are 520 and 1400, and 1400 requires an explicit bounded list. A scoped request with only `historyTickers` defaults to 520. Both options omitted on an existing run resume its saved selection; explicitly supplying `historySessions=520` without tickers selects the full catalog. The authenticated response and `/api/eod/status` expose the saved `historyTickers` (null for full catalog) and `historySessions`.

The selection is stored before GitHub dispatch. Changing an idle or completed run's selection clears its frozen input/progress and requeues it; changing an active, leased or possibly still queued GitHub run returns HTTP 409 `history-request-busy`. Retry the saved request or wait for the active job to finish. Reading public pages or status does not enqueue history work. Missing sessions, verified listing dates and provider errors remain explicit; requesting 1400 sessions does not manufacture pre-listing history or guarantee provider coverage.

Check all Overview groups/rows, eleven sectors, missing instruments, exact return windows, intraday 52-week-high distance, history gaps, relative-strength date alignment, holdings dates and factual reports. Breadth closing-high metrics retain their documented closing-price definition; coverage/bounds and verified membership dates must remain visible. Index/ETF proxies must not be presented as identical universes.

Before any hot pruning, verify archive parity for `overview`, `breadth`, `correlation-5y`, `patterns-520`, `watchlist`, `relative-strength`, `scans`, `ticker-max`, `earnings-gaps`, and `coverage-and-repair`. Verify corrections, split rebasing, sparse history and archived-only reads. Local fixture success is not production parity proof.

## Stage 4 — Measured proof and controlled activation

Initial activation requires a measured full-catalog shadow run and validated cutover evidence. Retain the commit, session calendar/actual close, configuration/membership versions, six page scope IDs, the run progress `catalogPublicationId` reference, the completed input-clock watermark, row/metric coverage, provider errors, publication completion time, account quota samples and capacity measurements. No elapsed observation period is required before legacy retirement; current health and the technical acceptance gates remain mandatory.

Require the intended coverage thresholds, no unexplained input/value mismatch, no mislabeled dates/sources, and complete consumer parity. Ongoing scheduled delivery targets close +120 minutes; initial recovery completed after that deadline remains recorded as late. Activation requires current validated publications and the technical checks below, with no elapsed observation period. Simulate a failed provider, missing credentials, quota exhaustion, retry after UTC reset and duplicate dispatch using fixtures; confirm last accepted data remains explicitly dated. Confirm daily factual output appears after a new publication even without AI, and official rates/FOMC remain available independently of probability-provider failures.

Store the verified proof in Ops `eod_rollout_evidence`, ID `cutover`. The Node entrypoint must call `assertEodCutover(env, process.env.GITHUB_SHA)` before claiming an active run; a missing or mismatched revision/proof is an error, and shadow bypasses this gate. After the evidence passes, set `EOD_RUNNER_MODE="active"` and `EOD_READ_ENABLED="true"`; keep pruning false. Enqueue/complete an active run to establish public pointers. Recheck `/overview`, `/breadth`, `/api/eod/status`, and `/api/health/market-data`. Readiness requires current publications for all six scopes. Production source-access, capacity and SLA results remain unverified until observed.

The exact version-1 proof schema is exported as `eodCutoverEvidenceSchema` in `eod-rollout-service.ts`; unknown fields are rejected. Supply measured values, not a copied sample approval:

| Proof field | Required evidence |
| --- | --- |
| `version`, `codeRevision`, `methodologyVersion` | `1`, exact 40-character `GITHUB_SHA`, current `EOD_METRICS_VERSION` |
| `measuredAt`, `runId`, `sessionDate` | Measurement within 24 hours, completed daily run ID, matching session |
| `sharedTickers` | `{count,processed}` equal to all unique frozen run tickers and final progress, including catalog tickers outside the five overlapping universes |
| `fullUniverseCounts` | Five `{universeId,memberCount,attemptedCount,observedCount}` records matching frozen memberships and published metrics; all members attempted, 98% S&P500/95% others observed |
| `scopes` | Six unique `{scope,publicationId,sessionDate}` references recorded by that run; verified checksums, correct methodology/date and candidate-from-shadow or accepted status |
| `measurements` | `usageDate,eodRowsRead,eodRowsWritten,accountRowsRead,accountRowsWritten,httpCpuMs,coordinatorCpuMs,queriesPerInvocation,queryDurationMs,source` from actual telemetry |
| `limits` | Declared `httpCpuMs,coordinatorCpuMs,queriesPerInvocation,queryDurationMs`; cannot exceed Free ceilings 10ms/10ms/50/30,000ms; SQL duration must be strictly below its limit |
| `capacity`, `readers` | Exact measured `HistoryCapacityEvidence`/`HistoryReaderEvidence`; all consumer parity checks passed and both projected databases below 350MB |
| `retention` | `{hotSessions:260 or 90,sweepHeadroomSessions:at least 10}`; retained-row projection includes every shared ticker for the retained window plus quota-delayed weekly sweep headroom |

Measured EOD use must be ≤2.5m reads/50k writes and account use ≤4.5m/90k. Initial validation also checks recorded counters against these ceilings and verifies the completed global input watermark, including Yahoo revisions; counters can rise after a measurement. Changed inputs require a fresh validated shadow completion before initial approval. A successful check persists a checksummed durable approval under `active:<GITHUB_SHA>`, including the original proof/hash and approval timestamp. Later runs of that exact revision use this approval without expiring or redating the old measurement; live quota/capacity admission still applies on every run. A new code revision requires a new matching measured proof. The guard validates proof structure/reference consistency, not the truth of independently collected CPU telemetry. Initial CPU and full-population parity evidence remain independently collected; the ongoing history-capacity sampler described below does not manufacture those approvals. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Stage 5 — Optional pruning, steady state and rollback

Pruning requires `EOD_ARCHIVE_PRUNE_ENABLED="true"` and independent initial Ops evidence under `history-capacity`. The exact `HistoryMaintenanceProof` in `eod-history-capacity.ts` contains `version:1`, the actual 40-character `codeRevision`, original measured `capacity`, verified `readers`, `hotSessions` (260 by default; 90 only after measured proof), `sweepHeadroomSessions` of at least 10, and `population:{feed:"sip",tickers:[all shared tickers]}`. The initial population must match the complete runner input, and the retained-row projection must cover its full hot window plus sweep headroom. Initial capacity evidence must be at most 24 hours old and initial consumer parity at most 7 days old. Do not fabricate parity booleans, measurements or population counts.

The Node runner passes its actual `GITHUB_SHA` as `EOD_CODE_REVISION`. After validating the independent initial proof, maintenance records a checksummed durable approval at `history-approval:<SHA>`. That exact revision keeps the original reader parity timestamp; it does not require weekly reapproval or manual redating. A new code revision needs a matching independent proof. Automatic capacity collection never claims to have rerun consumer parity or the initial full-population validation.

`refreshHistoryMaintenanceEvidence` automatically refreshes physical database sizes from D1 query `meta.size_after`, samples archived encoded blocks, and counts at most the hot window for each security through indexed queries of at most 80 tickers. The full ~6,000-symbol, 260-session pass can consume up to ~1.56m hot-row reads plus metadata/checkpoint overhead, so it runs under the shared EOD admission budget. A checksummed `history-sample:<SHA>` cursor survives quota exhaustion; the next UTC allowance resumes unfinished or revision-changed symbols. Completed samples are reused when their input revisions still match, while physical size is always re-read. Results or measurement failures are recorded at `history-measurement:<SHA>` and also surface as the maintenance run's failure reason.

The fresh forecast includes the entire physical market file, remaining hot-window growth, at least 10 sessions of sweep headroom, and a conservative per-row allowance from the original measured table/index ratio and current encoded-row samples. Archive growth keeps the original independently measured projection, scales for population growth and reserves transient block space. Both bounds must remain below 350MB. Physical size is deliberately not reduced by assumed space reclamation: deleting SQLite rows need not shrink the file. Therefore the audited ~371MB market file cannot pass this conservative sampler solely because rows were pruned; it needs a separately verified storage remedy or supported occupied-page evidence. Missing physical-size metadata or insufficient headroom blocks pruning and records a retryable measurement failure. Production uses no unsupported `dbstat` scan or PRAGMA fallback; only the isolated SQLite test adapter derives physical bytes from page counts. See [D1 query metadata](https://developers.cloudflare.com/d1/worker-api/return-object/) and [supported SQL/PRAGMA statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/).

The GitHub environment variable `EOD_ARCHIVE_PRUNE_ENABLED` controls the Node process; a Worker-only variable cannot enable it. Every candidate hot deletion is preceded by verified archive write/read-back comparison, and a correction race retains the hot row. Archive storage is not globally expired.

Full-history catalog publications are retained in this pass, including older session metadata required by paused pattern/RS runs. Include their retained plaintext payloads and future growth in capacity forecasts; hot-price pruning does not reclaim catalog storage. No two-session catalog purge is enabled. An older catalog can survive proven strictly later-session appends using constant-size per-security semantic revision evidence. Historical inserts/updates/deletes, genuine archive revisions, unknown revision writers and pending repair fences invalidate that exception. The latest accepted catalog still requires exact input revisions. A lagging historical row fails closed when the evidence cannot exclude an append inside its requested session; it needs rebuilt dated metadata, never a fabricated zero count.

A replacement market database may start with only the latest session hot; older observations remain in the verified archive, and the 260/90-session hot window grows naturally. Bootstrap the complete canonical SIP catalog with `buildEodCatalogRow`/`encodeEodCatalogPayload`, including the additive `compatibility` rows (exact preceding observed date, five-day return and seven-observation window start), and preserve matching source revisions after seed writes. Holdings and full-universe sector rankings use this compact evidence instead of loading every archive in a Worker request. **Do not switch the production binding with `EOD_READ_ENABLED=false`, missing accepted latest overview/breadth publications, or missing/incomplete compatibility catalog.** The transfer stops at awaiting-evidence; the original database remains canonical until full reader parity and publication gates pass. Copy completion alone does not authorize the binding switch.

Monitor Admin → Operations for failed stage, retry/deadline, missing scopes, source errors, separate EOD counters and account totals. A clean EOD counter does not prove free account headroom. Keep unrelated Cloudflare workflows operating and measure their quota impact after the earnings index migration.

Before any GitHub dispatch check, the coordinator reads today's indexed EOD and shared-account quota ledgers. Known exhaustion, including reserved EOD usage or insufficient allowance for small control writes, defers the run to the next UTC day at 00:05 without calling GitHub. Healthy leases and later scheduled retries are preserved. Missing ledger data remains unknown and is checked by the runner's authoritative account sample and quota reservation; passing this small preflight does not establish capacity for the whole workload.

`/api/eod/status` also compares the singleton material-price input revision with the watermark captured before the most recent completed daily/reconciliation publication for the expected session. `inputCorrectionsPending=true` means stored price inputs changed after the published calculations, even when every displayed session date still matches. The coordinator queues one reconciliation without scanning full ticker manifests; existing runner leases and quota retry times remain in force. Old completed runs without a watermark require one reconciliation. An absent clock or completed delivery is unknown (`null`) and cannot report ready. Timestamp-only source metadata changes do not create corrections. Public status reads never enqueue or repair data.

Before retiring legacy writers/storage, run `assertEodRetirement` after current account analytics have been sampled. It retains `assertEodCutover`, independently collects present accepted publication/run/input-revision evidence and requires fresh current UTC quota within the same EOD/account limits. It uses policy `current-health-no-observation-v1` and monitor version 3. No elapsed sessions or hand-submitted multiday retirement record are required. Historical deadline and whole-day usage results remain visible diagnostics; their absence cannot be mistaken for current health. Actual cutover, capacity, coverage, runtime and archive-compatible rollback requirements remain unchanged.

Rollback: disable the writer with `EOD_RUNNER_MODE="disabled"`, keep `EOD_READ_ENABLED="true"` to serve the last validated publications, leave pruning false, and redeploy the configuration. Preserve accepted publications, source revisions, archives and durable run records for diagnosis; do not delete them to reset status. Previously pruned history still requires archive-aware readers. Disabling writes does not make an old publication current; its date/staleness remains visible.
