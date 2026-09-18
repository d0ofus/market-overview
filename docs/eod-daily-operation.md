# Daily Overview and Breadth operation

GitHub Actions owns daily prices, calculations and retention. Cloudflare's five-minute heartbeat coordinates the existing workflow and serves immutable publications. No local recovery controller or observation period is required.

## Schedule and recovery

- Actual New York exchange close +20 minutes starts the daily job. +50/+95 minutes resume failed work when no live runner owns it. +120 minutes records delivery outcome.
- Each five-minute heartbeat refreshes the bounded current-health report. The independent daily monitor finalizes historical usage; a daily report alone cannot keep a five-minute health check current.
- The next trading morning reconciles current prices and corrections. Retention starts at 07:00 New York time when no daily/reconciliation job is due, and resumes a saved selection after interruption.
- GitHub retains its 80-minute job ceiling. Retention checkpoints at most 500 bars and yields after 70 minutes. It never fetches provider history. Broad historical expansion is manual and outside daily delivery.
- Alpaca SIP is primary; Yahoo's bounded fallback serves missing current prices/adjacent-session returns. A missing long metric stays null and does not consume all fallback capacity or invalidate an otherwise complete daily checkpoint.

## Storage and limits

The recent-price window is 90 sessions. The shared reader combines it with retained lossless archive blocks. Every relocation verifies its archive write and checksum before exact conditional deletion; failed repairs are isolated. Accepted publications and archived price history are retained.

Normal recovery inserts missing recent sessions directly into the hot table. Only genuinely older inputs go through archive promotion during ingestion. The compact one-close bootstrap path remains confined to private storage migrations.

`paid-daily-v2` uses a 2 GB per-database operating ceiling, a 3.5 GB account warning and a 4.5 GB stop for optional growth. All account databases, including the original frozen source, count. Usage admission retains 20 billion reads / 35 million writes over 31 days. These are application limits, not a guarantee against charges from unrelated account activity. A Free downgrade requires separate size/usage verification.

## Release and production record

`worker/scripts/activate-eod-daily.ts` reuses the original dated full-copy and reader evidence. It verifies preserved observations, tracked corrections, current range-reader parity, schemas, accepted publications and physical storage. It stores a versioned release in the existing Ops evidence table; it does not reconstruct historical populations.

Run `check` for bounded live validation. After tests and a clean main commit, `prepare` saves the release. Deploy that exact commit, then set the `market-eod` environment variables to the same commit/databases and active/read/prune modes. Set `EOD_STORAGE_POLICY=paid-daily-v2` to disable the superseded capacity-renewal workflow; the independent operating monitor still samples live capacity.

`activate` verifies deployed Worker bindings and GitHub variables before completing the migration and enqueueing the latest eligible session. `record` requires current health and a completed real retention cycle before saving `recovery:production-configuration` and `daily-release-production:<commit>`.

The GitHub runner remains pinned to the approved backend commit. UI-only main commits can deploy independently. Backend, schema or reader changes require validating and preparing their new release identity before updating the runner pin.

The manual `EOD retention qualification` workflow measures the archive phase across the full active catalog using one existing SIP close per available security. It retains the hot copies, checks archive read-back and unchanged input revisions, and uses the normal writer concurrency group and Paid admission ledger. It makes no provider requests. Its result combines measured archive time, the measured real retention cycle and a five-minute deletion margin against the 80-minute ceiling. This is a bounded performance qualification, not a claim that thousands of hot rows were deleted when only a smaller real backlog existed. Results and resumable checkpoints are stored in Ops under `retention-qualification:<production-commit>:<session>`; the operator-tool commit is recorded separately from the deployed application commit.

The Vercel project build-skip command must exit 1 when Git history is unavailable (`git diff --quiet ... 2>/dev/null || exit 1`). `.vercelignore` excludes Git metadata, so a raw Git error must not fail the deployment before the web build starts.

## What to inspect

Admin → EOD Publications shows expected/displayed session, per-scope coverage, run errors, retry eligibility, account usage, measured storage and retention progress. Overview and Breadth keep their actual publication dates and unavailable fields. A completed deployment alone does not establish fresh data.

Before target writes, an interrupted cutover leaves the migration paused and source frozen. After target writes, stop the new writer if necessary and retain last-good publications. Any application rollback must continue using the target and archive-compatible readers; do not switch back to the obsolete source database.
