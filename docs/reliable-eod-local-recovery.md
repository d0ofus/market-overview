# Restartable rollout execution

`worker/scripts/continue-storage-rollout.ts` executes one bounded attempt at the authorized production rollout. GitHub continues to own the long transfer and ingestion stages. The local controller completes capacity capture, performs offline sizing, starts the fenced migration, waits for its durable GitHub stages, then collects actual publication-growth and protected runtime evidence, builds the strict cutover proof, accepts it, and invokes the guarded public activation command. It never fabricates a passed stage from a dispatch response.

The controller requires a clean pinned `main` checkout and a version-1 JSON configuration under `worker/tmp/` containing `codeRevision`, `afterUtc`, `accountId`, the original `sourceDatabaseId`, `historyDatabaseId`, `opsDatabaseId`, `coreDatabaseId`, `snapshotPath`, `historySnapshotPath`, `frozenRunId` and explicit `autoActivate:true`. Configuration contains no credentials. Set the source from the verified original database; the canonical GitHub market ID changes only through accepted public activation.

The controller checks current account-wide analytics before D1 work and retains the existing shared admission limits for every database operation. Quota failures wait until 00:05 UTC on the next day. Transient failures retry after 30 minutes; mismatched identities, hashes, incomplete coverage or failed validation pause for investigation. It does not repeatedly retry a failed measurement or discard unsupported members. A fresh complete snapshot is required before provisioning.

Publication evidence is stored in separate ignored directories by code revision, session and actual sample hash. Retrying a different session or correction cannot silently reuse another payload's growth artifact. Runtime collection uses the authenticated Cloudflare API again at acceptance. The accepted proof is rebuilt from current recorded inputs rather than trusting a manually edited JSON file. Actual 100% serving Worker bindings and GitHub canonical settings are checked before marking the migration complete.

## Windows task

After committing and pushing the reviewed implementation, write the nonsecret configuration to `worker/tmp/storage-recovery-config.json`. Validate and register:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File worker/scripts/register-storage-recovery-task.ps1 -ConfigurationPath "$PWD/worker/tmp/storage-recovery-config.json" -ValidateOnly
powershell -NoProfile -ExecutionPolicy Bypass -File worker/scripts/register-storage-recovery-task.ps1 -ConfigurationPath "$PWD/worker/tmp/storage-recovery-config.json"
```

The task uses the current user's interactive logon, requests wake-up, starts when a scheduled launch was missed, and retries every 30 minutes for 14 days. It also runs after that user logs in. It reads the user's already configured `CLOUDFLARE_API_TOKEN` environment variable after restart; the token is never embedded in the task or JSON. GitHub CLI must remain authorized for that user. The computer must be powered on and the user logged in; waking from sleep depends on Windows and device settings. A reboot no longer loses the schedule. Concurrent task instances are rejected, and an orphan process lock is recovered after restart.

Inspect `worker/tmp/storage-recovery-status.json` for the stage, sanitized reason, actual next attempt and pinned code revision. Successful child commands append sanitized summaries to `worker/tmp/storage-recovery.log`. A validation pause requires resolving the cause and deliberately resetting that local pause or providing a newly reviewed configuration; elapsed time is not approval. The previous one-time waiting-process helper remains available but should not run concurrently with this controller.

The local task disables itself only after a successful invocation writes a fresh completion status for the configured code revision and synchronizes that report to Admin. Replaying a completed rollout still verifies actual public bindings; cached local completion is insufficient. GitHub's daily operating evidence and the Worker heartbeat then continue independently. No elapsed observation period is required before legacy retirement. Current verified health and technical cutover requirements still apply; historical operating telemetry remains visible. Historical reconstruction with missing point-in-time membership remains a gap, not an invented publication. The controller does not delete the original database or historical publications.

## Daily Admin check

Open `/admin` and inspect the EOD recovery summary. It separates durable recovery/public cutover and recorded production configuration from current operational health. A recovery-status fetch error, stale controller report or absent configuration evidence cannot verify completion. A stale quota sample makes current health unverified without undoing recorded recovery. A successful Vercel deployment or scheduled-task exit is not recovery evidence.

`publish-storage-recovery-status.ts` synchronizes only the sanitized local status fields to the existing Ops evidence table; it does not upload snapshots, local paths, provider payloads or credentials. The task runs this after each attempt, including paused no-op attempts, and the controller also publishes stage changes. Replaying an identical report preserves its original observation time. Account quota is checked before publishing; if D1 is unavailable, the local report remains and Admin reports missing/outdated information. There is no extra database or schema migration.

The final configuration milestone is separate from local completion. `record-storage-production-config.ts` must verify the actual current GitHub commit, checked-in canonical bindings, serving Worker, active approval and original completed migration before recording it. A later configuration commit may have a different revision from the original activation. The original activation time and revision remain historical evidence.
