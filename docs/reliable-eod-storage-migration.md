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
8. Stop in `awaiting-evidence`. Independently verify complete source/target table manifests, source capture, all archive pointers/checksums, actual destination capacity, full historical consumer outputs, latest-session publications and billed usage. The copy runner cannot switch bindings, prune the source or fabricate these results.

The source is never deleted by this runner. A quota failure records the next UTC reset; network/server failures and a 65-minute time slice resume from checkpoints. Verification failures pause for investigation. Copy writes are idempotent. Ten archive blocks may be replayed after interruption; duplicate blocks are verified and reused. Large non-price pages subdivide before the D1 value limit.

All REST access uses explicit database allowlists and the shared EOD admission ledger. Table/index DDL is an exact repository allowlist, never SQL supplied by a public endpoint. All writes, including index/checkpoint writes, count toward admission. Cloudflare control-plane migration commands are separate operator work and must also be included in account usage measurements. Actual D1 metadata settles query reservations; an estimate overrun stops work.

## Commands and workflow configuration

`npm run eod:storage -w worker -- create|status|run|resume` is the operator/runner entry point. Commands use these server-side environment variables:

| Variable | Value |
| --- | --- |
| `EOD_STORAGE_MIGRATION_ID` | Unique `market-storage:<name>` |
| `CLOUDFLARE_ACCOUNT_ID` | Verified account ID |
| `CLOUDFLARE_EOD_D1_TOKEN` | Existing D1 credential; never a browser variable |
| `EOD_MARKET_DATABASE_ID` | Original source database ID during transfer |
| `EOD_STORAGE_TARGET_DATABASE_ID` | Distinct empty replacement database ID |
| `EOD_HISTORY_DATABASE_ID` | Existing history database ID |
| `EOD_OPS_DATABASE_ID` | Existing Ops database ID |
| `EOD_STORAGE_SESSION_DATE` | Frozen exchange session; needed for `create` |

The runner reads its actual checkout SHA with `git rev-parse HEAD`. Configure GitHub environment `market-eod` variable `EOD_STORAGE_CODE_REVISION` to that SHA before dispatch. The workflow itself always dispatches on `main`; its checkout remains pinned through a multi-day copy even when unrelated commits land on `main`. A checkout mismatch durably pauses the run.

The workflow `.github/workflows/eod-storage-migration.yml` uses input `migration_id`, the existing Cloudflare secrets, and the same `market-eod-writer` concurrency group as daily ingestion. It does not upload database snapshots or history artifacts.

`authorizeStorageMigrationFreeze` is an operator-only module function: it records the source ID, exact code/schema hashes and the hash of reviewed preflight evidence. It is intentionally separate from `create` and from public/admin HTTP routes. Call `resumeStorageMigration` only after that evidence is complete. Do not manufacture an evidence hash simply to advance the state.

Set Worker `EOD_STORAGE_MIGRATION_ID` only when the reviewed migration owns the market lane. The heartbeat then prioritizes this workflow and preserves existing EOD run records for later recovery. `awaiting-evidence` and `awaiting-cutover` do not repeatedly dispatch. Normal page reads cannot start a transfer. `/api/eod/status` and the admin EOD panel display migration mode, stage, error, row progress, capture state and next retry; unfinished migration keeps market readiness false.

## Cutover and rollback

Binding cutover requires `EOD_READ_ENABLED=true`, six complete accepted latest page publications and the full matching catalog, including compatibility tuples. See [reader parity requirements](archive-only-reader-parity.md). Copy completion cannot substitute for those checks. Reconstruct the latest session against the replacement while the original binding still serves dated data, then promote only after full-universe validation.

The replacement must also contain every original non-price table and the migration ledger. Final verification must check exact destination row counts/hashes and archived pointer IDs/checksums, not merely the number of copied rows or the source price clock. The preliminary logical snapshot and local codec tests are insufficient for this gate.

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
