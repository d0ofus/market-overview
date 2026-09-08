# Reliable EOD production release

Release started 9 September 2026, Australia/Sydney. Production deployment was explicitly authorized. This record distinguishes deployed infrastructure from the remaining live acceptance gates.

## Source and validation

- Implementation commit: `88f8bdc`, based on synchronized GitHub main `7696763`.
- Provisioned history binding: `73cb9e1`.
- Archive health diagnostics: `14a35de`; nine focused tests and Worker typecheck passed.
- Earlier implementation validation: 1080 Worker tests, 30 final focused tests, 96 web tests, all three TypeScript checks, Worker dry-run build and production web build passed. See [implementation review](reliable-eod-implementation.md).

## Provisioned infrastructure

The existing Cloudflare account is `5ddf4343b603f05fed83f9e102b4b553`. Its ninth D1 database, `market_history`, was created with ID `62b61de4-4920-475b-98b6-7b656d4f0a39`. The other databases were retained. No history was pruned.

The GitHub environment `market-eod` exists with the account ID, four explicit database IDs, pruning disabled, and the Cloudflare D1 token configured as a secret. The token's account analytics permission was verified without exposing its value. Alpaca environment secrets and the Worker GitHub dispatch secret remain pending.

## Deployment state

At 23:29 UTC on 8 September, the implementation is committed on local `main`, but the GitHub push is blocked by the existing OAuth login lacking `workflow` scope. Browser authorization was requested. No new Vercel deployment or Worker deployment has occurred yet.

The application release is being published separately under the existing repository permission. Its tree excludes only the new `.github/workflows/eod-market-data.yml`; that file and the complete original commit history are retained on local branch `release/eod-complete`. The workflow must be added after GitHub authorization, before enabling the runner. This does not bypass or change the protected workflow under the current credential.

Production D1 queries are blocked by Cloudflare's exhausted daily read allowance. The 8 September account analytics sample reported 28,119,352 rows read and 13,250 written; this is analytics evidence, while the live query API's quota error establishes the current block. SQL migration is deferred until the 9 September UTC reset. An explicit, idempotent attempt to install core migration `0102` is queued for 00:00:10 UTC; other migrations follow only after schema verification.

Required migration order before Worker deployment: earnings index `0102`, core `0101`, market through `0008`, Ops through `0009`, and history `0001`. Binding the history database activates archive queries in existing shared readers even when the EOD writer is disabled, so its schema must exist first. The checked-in writer, publication reads and pruning remain disabled.

## Acceptance still outstanding

The market database's measured physical size is 371,277,824 bytes, above the agreed 350 MB acceptance ceiling. Deleting rows does not prove physical compaction. Full-universe capacity/headroom, consumer parity, live provider coverage, actual billed usage and Worker CPU/query limits must pass before active publication ownership. No measured proof or acceptance approval has been fabricated.

Ten consecutive real trading sessions meeting the actual-close-plus-two-hours deadline and agreed budgets are required before retiring the legacy implementation. A deployed release, healthy database connection or successful dispatch does not establish those conditions. Follow the [rollout runbook](reliable-eod-rollout.md) for recovery, activation and archive-compatible rollback.
