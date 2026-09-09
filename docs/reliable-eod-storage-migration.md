# Archive-first storage migration

This phase adds the transfer machinery and closes the remaining reader gaps. It does not treat a completed copy as a validated public EOD publication. The original `market_prices` database remains canonical until the full cutover checks pass.

## Sequence and operating boundaries

1. Capture a quota-metered, read-only logical snapshot for offline sizing. Its identity pins the account, source database, frozen EOD input and reviewed schema. It is explicitly non-atomic and cannot certify source completeness at cutover. Local snapshots and model databases are diagnostic artifacts; application history never depends on them.
2. Run [the capacity analyzer](reliable-eod-storage-analysis.md) with the complete shared ticker manifest and existing history database snapshot. Measure both 260/90-session layouts, index costs, archive revisions, both provider windows and publication growth. A provisional recommendation without growth evidence does not authorize cutover.
3. Provision an empty replacement D1 database only within the free account's database/storage limits. Apply Ops `0010_market_storage_migrations.sql` and source Market `0009_market_storage_fence.sql`. The latter adds an **open** singleton; it neither freezes writers nor installs per-table guards.
4. Create one immutable migration identity, pin its reviewed code revision, and record the measured preflight before authorizing source capture. Creation or workflow dispatch alone cannot freeze the source.
5. Freeze the source through reviewed guards covering every application table. This pauses writes to that database for a consistent copy; reads and workflows using other databases remain available. The freeze persists through runner interruption and UTC quota reset. Schedule this maintenance only after measuring the transfer work and available allowance. Do not silently leave a source frozen following an abandoned migration.
6. Copy all source feeds/security/year blocks into the history database. Preserve archive-only dates and existing immutable revisions; hot observations win for their exact dates, including reported volume, provenance and timestamps. Read back and decode every block and verify its active pointer. Seed the latest available bar at or before the frozen session for each feed/security into the replacement.
7. Copy every non-price application table in bounded primary-key pages. Verify exact row values after insertion; a conflicting destination row stops the copy. Preserve the Wrangler migration ledger. Install business triggers after data copy so seed inserts do not rewrite source revisions or invalidate copied catalogs. Target migration-fence metadata starts open and is not copied from the frozen source.
8. Independently verify every source/target table and archive checksum under durable source, target and history fences. Compare exact consumer outputs across the full frozen ticker population, including MAX, 520-session and five-year-buffer history. Each stage checkpoints and resumes within admission limits.
9. Record private target ownership before releasing target/history fences. Reconstruct accepted latest-session Overview, each independent breadth scope, and the shared catalog on the replacement. The source remains frozen and publicly bound. Normal ingestion runners defer while this migration owns storage, including jobs queued before the migration started.
10. Stop in `awaiting-evidence` for final measured publication growth, actual D1 physical size, billed usage and version-correlated Worker runtime checks. The runner does not change public bindings, prune the source or treat private publications as public delivery.

The source is never deleted by this runner. A quota failure records the next UTC reset; network/server failures and a 65-minute time slice resume from checkpoints. Verification failures pause for investigation. Copy writes are idempotent. Ten archive blocks may be replayed after interruption; duplicate blocks are verified and reused. Large non-price pages subdivide before the D1 value limit.

All REST access uses explicit database allowlists and the shared EOD admission ledger. Table/index DDL is an exact repository allowlist, never SQL supplied by a public endpoint. All writes, including index/checkpoint writes, count toward admission. Cloudflare control-plane migration commands are separate operator work and must also be included in account usage measurements. Actual D1 metadata settles query reservations; an estimate overrun stops work.

## Commands and workflow configuration

`npm run eod:storage -w worker -- <command>` is the operator/runner entry point. Commands use these server-side environment variables:

| Variable | Value |
| --- | --- |
| `EOD_STORAGE_MIGRATION_ID` | Unique `market-storage:<name>` |
| `CLOUDFLARE_ACCOUNT_ID` | Verified account ID |
| `CLOUDFLARE_EOD_D1_TOKEN` | Existing D1 credential; never a browser variable |
| `EOD_MARKET_DATABASE_ID` | Original source database ID during transfer |
| `EOD_STORAGE_SOURCE_DATABASE_ID` | Immutable original source ID; retained after canonical market ID changes |
| `EOD_STORAGE_TARGET_DATABASE_ID` | Distinct empty replacement database ID |
| `EOD_HISTORY_DATABASE_ID` | Existing history database ID |
| `EOD_OPS_DATABASE_ID` | Existing Ops database ID |
| `EOD_CORE_DATABASE_ID` | Distinct existing core DB; needed for private bootstrap configuration and memberships |
| `EOD_STORAGE_SESSION_DATE` | Frozen exchange session; needed for `create` |

The runner reads its actual checkout SHA with `git rev-parse HEAD`. Configure GitHub environment `market-eod` variable `EOD_STORAGE_CODE_REVISION` to that SHA before dispatch. The workflow itself always dispatches on `main`; its checkout remains pinned through a multi-day copy even when unrelated commits land on `main`. A checkout mismatch durably pauses the run.

The workflow `.github/workflows/eod-storage-migration.yml` uses input `migration_id`, the existing Cloudflare secrets, and the same `market-eod-writer` concurrency group as daily ingestion. It does not upload database snapshots or history artifacts.

`authorize` validates complete offline sizing, snapshot identity and frozen inputs before recording the source ID, exact code/schema hashes and preflight hash. Its conservative planning reserve is not final publication-growth evidence. It is separate from `create` and public/admin HTTP routes; replays retain the original evidence time and hash.

| Command | Result |
| --- | --- |
| `create`, `authorize` | Create identity, then validate preflight and permit a fenced relocation |
| `run`, `resume`, `status` | Execute one resumable stage, resume an explicit pause, or inspect durable progress |
| `reconstruct` | Requeue an already verified private target to reconstruct the latest exchange session |
| `sample-publications` | Export sanitized accepted payload samples to a local measurement input; no page publication changes |
| `accept` | Validate matching final growth/capacity/runtime evidence, persist a finite storage forecast and mark ready for cutover |
| `complete` | Verify the actual 100%-serving Worker version, target bindings and GitHub writer settings; record actual public activation and start monitored delivery |

Final acceptance requires `EOD_STORAGE_ANALYSIS_PATH`, `EOD_STORAGE_PUBLICATION_GROWTH_PATH`, `EOD_STORAGE_CUTOVER_EVIDENCE_PATH` and `EOD_STORAGE_RUNTIME_EVIDENCE_PATH`. Runtime acceptance recollects the matching recent invocation window from the authenticated Cloudflare API; a local JSON file alone is insufficient. Publication sampling uses `EOD_STORAGE_PUBLICATION_SAMPLES_PATH`. See [executable acceptance checks](reliable-eod-storage-acceptance.md). A completed old bootstrap cannot be substituted for the current owner or expected session.

Set Worker `EOD_STORAGE_MIGRATION_ID` only when the reviewed migration owns the market lane. The heartbeat then prioritizes this workflow and preserves existing EOD run records for later recovery. `awaiting-evidence` and `awaiting-cutover` do not repeatedly dispatch. Normal page reads cannot start a transfer. `/api/eod/status` and the admin EOD panel display migration mode, stage, error, row progress, capture state and next retry; unfinished migration keeps market readiness false.

## One-time start after capacity analysis

The local operator script `worker/scripts/start-storage-migration-once.ts` joins completed capacity analysis to the durable migration without changing the canonical public market binding. It requires inherited `EOD_STORAGE_START_APPROVED=true` and `EOD_STORAGE_EXPECTED_COMMIT=<exact committed and pushed 40-character SHA>`. The user must already have authorized this phase; the flag is a persisted operator instruction, not a substitute for missing capacity evidence. It can run through `node --import tsx worker/scripts/start-storage-migration-once.ts` from the repository root or from the opted-in local capacity retry helper.

Required non-secret configuration is `CLOUDFLARE_ACCOUNT_ID`, `EOD_MARKET_DATABASE_ID` (still the source), `EOD_HISTORY_DATABASE_ID`, `EOD_OPS_DATABASE_ID`, `STORAGE_SNAPSHOT_PATH`, `EOD_STORAGE_ANALYSIS_PATH`, `EOD_STORAGE_SNAPSHOT_IDENTITY_PATH` and `EOD_STORAGE_FROZEN_INPUT_PATH`. `EOD_STORAGE_SOURCE_DATABASE_ID`, when present, must equal the canonical source at this phase. Credentials are inherited through `CLOUDFLARE_EOD_D1_TOKEN`, `CLOUDFLARE_API_TOKEN` and optional `CLOUDFLARE_EOD_ANALYTICS_TOKEN`; GitHub CLI must already be authenticated. No local Alpaca secret is needed. The remote storage workflow obtains Alpaca credentials from `market-eod`.

The starter verifies a clean local `main`, the exact GitHub `main` SHA, unchanged evidence files, the frozen-input hash, and the same SQLite-backup hash used by the analyzer (including committed WAL state). The snapshot manifest's reviewed-schema hash and the live source fence hash have distinct purposes and are not equated. It independently reads the actual 100%-serving source Worker version, requiring source/history/Ops bindings, shadow mode and disabled public EOD reads. It performs admitted read-only source schema/fence checks and calls `prepareStoragePreflight` before provisioning. Account inventory must be complete and remain within ten D1 databases and 5 GB including the retained source and projected recent/archive destinations.

The target name and migration ID derive deterministically from the session and code SHA. A matching existing target can be reused only if empty or already owned by this exact durable migration. The source/target/history identity is persisted in Ops before initialization/authorization continues. The starter applies only the additive open history fence migration and its Wrangler ledger through reviewed, admitted SQL; a frozen or incompatible existing history fence blocks it. The existing storage CLI records the reviewed preflight and freeze authorization.

Only three `market-eod` variables are set: immutable `EOD_STORAGE_SOURCE_DATABASE_ID`, `EOD_STORAGE_TARGET_DATABASE_ID` and `EOD_STORAGE_CODE_REVISION`. `EOD_MARKET_DATABASE_ID` stays on the source. After Wrangler identity verification, the same Worker is deployed with `--keep-vars --var EOD_STORAGE_MIGRATION_ID:<id>`; its actual serving version is checked again for unchanged source bindings and the new coordinator ID. Only then is the storage workflow dispatched on `main`. A dispatch acknowledgement is recorded as accepted, never completed. The storage runner controls the actual freeze, verified copying, bootstrap and recovery under its durable leases.

Changed checkout, identity conflicts, missing evidence or exhausted quota stop this local attempt. A provisioned target is retained for deterministic resumption; nothing is deleted to hide a failed attempt. The ignored `worker/tmp/storage-start-once.json` is diagnostic only. Ops owns the migration identity/progress and production history stays in D1. This starter performs no public cutover, source pruning or legacy retirement.

## One-time public activation

After the durable migration reaches `awaiting-cutover`, use the canonical activation entry point from the repository root:

```powershell
$env:EOD_STORAGE_ACTIVATE_APPROVED = "true"
$env:EOD_STORAGE_EXPECTED_COMMIT = "<the accepted, committed and pushed 40-character SHA>"
node --import tsx worker/scripts/activate-storage-migration-once.ts
```

The prior user authorization covers execution; the explicit flag prevents accidental invocation from an ordinary diagnostic shell. Inherit the same Cloudflare credentials and migration/database IDs used for acceptance. `EOD_STORAGE_SOURCE_DATABASE_ID` is mandatory and immutable. GitHub `market-eod` must already contain the matching account, original source, target, history, Ops, core database and storage code revision variables. GitHub CLI must be authenticated. The script needs neither local Alpaca credentials nor a replacement secret file.

The command requires a clean local `main` and the exact same GitHub `main` SHA. It reads the accepted proof, bootstrap ownership, original source fence and current complete publication set through admitted D1 access. Immutable `active:<SHA>` authorizes the code revision; the independently stored `storage-cutover-proof:<hash>` authorizes the latest storage acceptance and is referenced by the migration's progress. A quota-interrupted acceptance may collect newer measurements, and reconstruction may produce a newer run/session, without rewriting the original code approval. Both records must remain valid and their own identities/hashes must match. Pending storage measurements expire after 24 hours and require renewed acceptance; completed replay retains their original dates. A live migration/EOD lease, changed accepted inputs, expired session, missing scope, mismatched database or missing durable approval stops activation. A local JSON success flag cannot authorize this step.

It inspects the actual 100%-serving Worker version, rejects mixed/staged deployments, checks auxiliary database bindings and the complete cron set, and verifies Wrangler authentication before changes. It updates only GitHub's canonical market database variable and runner mode, in that order. Normal ingestion stays blocked by the unfinished storage migration. The temporary `worker/tmp/storage-activation-<SHA>.jsonc` is generated from the complete tracked production TOML with the same Worker name, absolute entry/migration paths, existing queues and cron schedules, replacement market binding, active reads/writer, exact code/migration identifiers and pruning disabled. `--keep-vars` retains server-managed variables; existing secret bindings are preserved and checked after deployment. Credentials are never written into this generated file.

Each stage rechecks the accepted durable state. Only an actually serving matching target passes to the existing `complete` command, which records first observed public activation. If GitHub accepted a variable change, Cloudflare deployed, or Ops completed before the response was lost, rerunning the same command inspects those persisted states and resumes forward. It never redeploys the source or clears a failed stage to force success. A completed replay still verifies actual target bindings and GitHub settings. The local JSON journal is diagnostic only; it is not a production checkpoint. Quota exhaustion stops the attempt for the normal UTC-reset recovery path.

**Deployment ownership after cutover:** the checked-in `worker/wrangler.toml` still describes the original source configuration at the accepted SHA. Do not run a bare production `wrangler deploy` from it after activation; that could restore the old binding. For this approved SHA, use the guarded activation entry point to verify/recover cutover. A subsequent code deployment requires a reviewed canonical target configuration and approval for its new SHA, preserving the immutable source identity and archive-compatible readers. This command does not silently edit tracked configuration or claim that the old SHA approves future code.

## Cutover and rollback

Binding cutover requires `EOD_READ_ENABLED=true`, six complete accepted latest page publications and the full matching catalog, including compatibility tuples. See [reader parity requirements](archive-only-reader-parity.md). Copy completion cannot substitute for those checks. Reconstruct the latest session against the replacement while the original binding still serves dated data, then promote only after full-universe validation.

After `accept`, run the guarded public activation command above. It applies the replacement `MARKET_DATA_DB` binding, `EOD_RUNNER_MODE=active`, `EOD_READ_ENABLED=true`, and matching `EOD_CODE_REVISION`/`EOD_STORAGE_MIGRATION_ID`, preserving the immutable original source. It invokes `complete` only after those changes are actually serving; the completion gate rejects staged settings, split traffic and concurrent deployment changes. Pruning remains a separately gated maintenance action.

The measured retention model covers both SIP and Yahoo, with 260 or 90 recent sessions and a fixed future exchange-session horizon. A forecast does not renew itself merely because maintenance ran. Expiry, population growth and unexpectedly large retained windows require new measured evidence. The admin panel exposes this separately from database connectivity. [Monitoring](reliable-eod-monitoring.md) credits public delivery only after actual activation and requires finalized account-wide UTC usage, including weekends.

The replacement must also contain every original non-price table and the migration ledger. Final verification must check exact destination row counts/hashes and archived pointer IDs/checksums, not merely the number of copied rows or the source price clock. The preliminary logical snapshot and local codec tests are insufficient for this gate.

Population drift during a multi-day migration is a separate acceptance boundary. The private bootstrap refreshes the latest session's actual memberships and shared catalog, while acceptance requires its complete frozen ticker set to match the population used for preflight sizing and reader parity. New listings, removals or membership changes can therefore produce `storage-acceptance-publication-population-mismatch` and stop publication sampling/acceptance. This release deliberately fails closed: obtain new full-population sizing and parity evidence through a reviewed replan before proceeding. Do not trim current constituents to the older preflight population, substitute a different universe, or redate older source evidence to force a match. The copied source and archives remain preserved while that discrepancy is resolved.

Before target activation, explicit abort verifies that the original source is still canonical, the target has never accepted new writes and no live lease exists. `abortStorageMigration` stops resumption before releasing the fence; interrupted aborts can be replayed. After activation, rollback must reconcile new target writes and retain archive-compatible readers. Do not use the pre-activation abort path or restore an older hot-only application version.

## Remaining implementation and rollout phases

| Phase | Completion evidence |
| --- | --- |
| Storage transfer and bootstrap | Measured retention/growth choice; complete verified archives, source/target manifests and latest-session reconstruction within daily admission limits |
| Production validation | Full shared universe and all six scopes; reader/output parity; actual D1 sizes/reads/index writes and Worker CPU/query limits |
| Public cutover | Verified replacement binding, accepted publication pointers, dated coverage/reasons, commentary and refresh behavior on both pages |
| Historical recovery | Bounded corrections/backfills with date-appropriate membership; explicit gaps and unverified legacy results where evidence is absent |
| Monitoring and retirement | Ten consecutive trading sessions published within two hours of actual close and within agreed budgets; then retire replaced writers while preserving archive-compatible rollback |

Free-tier allowance can make initial transfer and reconstruction span multiple UTC days. The two-hour delivery target is measured during normal daily operation after bootstrap, and cannot be claimed from a successful workflow dispatch or a healthy database connection.
