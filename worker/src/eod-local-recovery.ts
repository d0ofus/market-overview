import type { StorageMigrationRun } from "./market-storage-control";
import { z } from "zod";
import { storageHash } from "./market-storage-pages";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const instant = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0,10) === value;
});
const populationManifest = z.object({ version: z.literal(1), planHash: z.string().regex(/^[a-f0-9]{64}$/),
  migrationId: z.string().regex(/^market-storage:[A-Za-z0-9._:-]+$/), codeRevision: z.string().regex(/^[a-f0-9]{40}$/),
  sessionDate: date, bootstrapSessionDate: date, tickers: z.array(z.string().regex(/^[A-Z0-9][A-Z0-9.^=/-]{0,39}$/)).min(1).max(10_000),
  tickerHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/** This small child-process contract selects a sizing artifact, not authority
 * to approve a plan. The runner separately validates the immutable Ops record. */
export async function parseLocalPopulationSizing(input: unknown, expected: {
  migrationId: string; codeRevision: string; originalSessionDate: string;
}): Promise<z.infer<typeof populationManifest>> {
  const parsed = populationManifest.safeParse(input);
  if (!parsed.success) throw new Error("storage-local-population-manifest-invalid");
  const plan = parsed.data, tickers = [...plan.tickers].sort();
  if (plan.migrationId !== expected.migrationId || plan.codeRevision !== expected.codeRevision || plan.sessionDate !== expected.originalSessionDate
    || plan.bootstrapSessionDate < plan.sessionDate || new Set(tickers).size !== tickers.length
    || JSON.stringify(tickers) !== JSON.stringify(plan.tickers) || await storageHash(tickers) !== plan.tickerHash) {
    throw new Error("storage-local-population-manifest-identity-conflict");
  }
  return plan;
}

export type LocalRecoveryResult = { status: "waiting" | "paused" | "completed"; stage: string; nextAttemptAt: string | null; reason: string };
export type LocalRecoveryDependencies = {
  assertCheckout(): Promise<void>;
  hasCompleteSnapshot(): Promise<boolean>;
  capture(): Promise<void>;
  hasStarted(): Promise<boolean>;
  analyzePreflight(): Promise<void>;
  start(): Promise<void>;
  loadMigration(): Promise<StorageMigrationRun>;
  preparePopulationSizing(run: StorageMigrationRun): Promise<void>;
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
    if (run.error_code === "storage-population-sizing-required") {
      if (run.lease_until && Date.parse(run.lease_until) > now.getTime()) throw new Error("storage-local-live-lease");
      await deps.assertCheckout();
      await deps.preparePopulationSizing(run);
      run = await deps.loadMigration();
      // Sizing resumes the existing durable copy/verification run. It does
      // not constitute reader, runtime, publication or cutover acceptance.
      if (!["queued", "dispatching", "dispatched", "running", "retrying"].includes(run.status)) throw new Error("storage-local-population-sizing-not-persisted");
      return { status: "waiting", stage: run.stage, reason: "current-population-sizing-accepted",
        nextAttemptAt: run.next_attempt_at && Date.parse(run.next_attempt_at) > now.getTime()
          ? run.next_attempt_at : new Date(now.getTime() + 30 * 60_000).toISOString() };
    }
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

/** Only an identified stale publication may restart its owned private run.
 * Changed membership/configuration or an invalid plan requires new evidence. */
export function localRecoveryRequiresBootstrapRefresh(output: string): boolean {
  const reasons = new Set(["storage-acceptance-completed-latest-run-required", "storage-acceptance-publication-inputs-changed",
    "storage-validation-bootstrap-latest-session-required"]);
  return output.split(/\r?\n/).some((line) => {
    if (reasons.has(line.trim())) return true;
    try {
      const value: unknown = JSON.parse(line);
      return value !== null && typeof value === "object" && "reason" in value
        && typeof value.reason === "string" && reasons.has(value.reason);
    } catch { return false; }
  });
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
