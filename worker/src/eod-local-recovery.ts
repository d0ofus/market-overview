import type { StorageMigrationRun } from "./market-storage-control";

export type LocalRecoveryResult = { status: "waiting" | "paused" | "completed"; stage: string; nextAttemptAt: string | null; reason: string };
export type LocalRecoveryDependencies = {
  assertCheckout(): Promise<void>;
  hasCompleteSnapshot(): Promise<boolean>;
  capture(): Promise<void>;
  hasStarted(): Promise<boolean>;
  analyzePreflight(): Promise<void>;
  start(): Promise<void>;
  loadMigration(): Promise<StorageMigrationRun>;
  prepareAcceptance(run: StorageMigrationRun): Promise<void>;
  accept(): Promise<void>;
  activate(): Promise<void>;
};

/** One bounded local attempt. Long copy/ingestion stages belong to the durable
 * GitHub coordinator, never a second local writer. Activation follows a fresh
 * durable acceptance read, including on retries after an interrupted deploy. */
export async function runLocalStorageRecovery(deps: LocalRecoveryDependencies, now = new Date()): Promise<LocalRecoveryResult> {
  await deps.assertCheckout();
  if (!await deps.hasStarted()) {
    if (!await deps.hasCompleteSnapshot()) await deps.capture();
    if (!await deps.hasCompleteSnapshot()) throw new Error("storage-local-snapshot-incomplete");
    await deps.analyzePreflight();
    await deps.assertCheckout();
    await deps.start();
  }
  let run = await deps.loadMigration();
  if (run.status === "completed") {
    await deps.activate(); // Completed replay independently verifies live bindings.
    return { status: "completed", stage: "public-cutover", nextAttemptAt: null, reason: "production-cutover-complete" };
  }
  if (run.status === "awaiting-evidence") {
    if (run.error_code !== "storage-final-acceptance-required") return {
      status: "paused", stage: run.stage, nextAttemptAt: null, reason: run.error_code ?? "storage-local-review-required",
    };
    await deps.prepareAcceptance(run);
    await deps.assertCheckout();
    await deps.accept();
    run = await deps.loadMigration();
    if (run.status !== "awaiting-cutover") throw new Error("storage-local-acceptance-not-persisted");
  }
  if (run.status === "awaiting-cutover") {
    if (run.lease_until && Date.parse(run.lease_until) > now.getTime()) throw new Error("storage-local-live-lease");
    await deps.assertCheckout();
    await deps.activate();
    const completed = await deps.loadMigration();
    if (completed.status !== "completed") throw new Error("storage-local-cutover-not-persisted");
    return { status: "completed", stage: "public-cutover", nextAttemptAt: null, reason: "production-cutover-complete" };
  }
  if (["aborted", "aborting"].includes(run.status)) return { status: "paused", stage: run.stage, nextAttemptAt: null, reason: run.status };
  return { status: "waiting", stage: run.stage, reason: "durable-github-stage-in-progress",
    nextAttemptAt: run.next_attempt_at && Date.parse(run.next_attempt_at) > now.getTime()
      ? run.next_attempt_at : new Date(now.getTime() + 30 * 60_000).toISOString() };
}

export function localRecoveryFailure(message: string, stage: string, now = new Date()): LocalRecoveryResult {
  if (/quota|budget|daily-read|daily-write|read-limit|write-limit|maximum.*rows/i.test(message)) {
    const reset = new Date(now); reset.setUTCHours(24, 5, 0, 0);
    return { status: "waiting", stage, nextAttemptAt: reset.toISOString(), reason: "storage-local-quota-deferred" };
  }
  if (/network|timeout|unavailable|http-(429|5\d\d)|logs.*pending|runtime-evidence-incomplete/i.test(message)) return {
    status: "waiting", stage, nextAttemptAt: new Date(now.getTime() + 30 * 60_000).toISOString(), reason: "storage-local-transient-retry",
  };
  return { status: "paused", stage, nextAttemptAt: null,
    reason: /^(?:storage|runtime|eod)-[a-z0-9-]{1,110}$/.test(message) ? message : "storage-local-review-required" };
}

/** Preserve a useful fixed operator failure instead of swallowing it in the
 * parent process. Only known capacity categories may cross this boundary. */
export function localRecoveryChildReason(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line) as { reason?: unknown };
      if (["storage-preflight-insufficient-headroom", "storage-preflight-insufficient-archive-headroom",
        "storage-start-free-account-capacity-exceeded"].includes(String(value?.reason))) return String(value.reason);
    } catch { /* Provider bodies and arbitrary stderr are never forwarded. */ }
  }
  return null;
}
