import assert from "node:assert/strict";
import test from "node:test";
import { buildEodRecoveryView } from "./eod-recovery-status";
import { getEodRecoveryStatus, type EodPublicationStatus, type EodRecoveryStatus } from "./api";

const checkedAt = "2026-09-15T22:00:00.000Z", now = Date.parse(checkedAt), activationRevision = "a".repeat(40), configurationRevision = "b".repeat(40);
function recovery(): EodRecoveryStatus {
  return { checkedAt, controller: { status: "completed", stage: "public-cutover", reason: "production-cutover-complete",
    nextAttemptAt: null, updatedAt: "2026-09-10T22:00:00.000Z", codeRevision: activationRevision, stale: false },
    activation: { activatedAt: "2026-09-10T21:00:00.000Z", codeRevision: activationRevision },
    configuration: { status: "recorded", codeRevision: configurationRevision, activationCodeRevision: activationRevision, recordedAt: "2026-09-10T22:00:00.000Z" } };
}
function publications(): EodPublicationStatus {
  return { mode: "active", ready: true, expectedSession: "2026-09-15", inputCorrectionsPending: false, runs: [], publications: [], monitoring: {
    version: 3, policyVersion: "current-health-no-observation-v1", checkedAt, requiredSessions: 0, consecutivePassedSessions: 0,
    usageFinalizationCutoff: "2026-09-15", newerSessions: [],
    eligibleForRetirement: true, latestEvaluatedSession: "2026-09-15", reasons: [], stale: false,
    currentHealth: { checkedAt, codeRevision: configurationRevision, status: "passed", expectedSession: "2026-09-15",
      publicationCount: 6, missingScopes: [], completedRunId: "run-current", inputCorrectionsPending: false, reasons: [],
      usageDate: "2026-09-15", quotaSampledAt: checkedAt,
      quota: { eodRowsRead: 100, eodRowsWritten: 10, accountRowsRead: 1000, accountRowsWritten: 100, reservedReads: 0, reservedWrites: 0 } },
    sessions: ["2026-09-11", "2026-09-14", "2026-09-15"].map((sessionDate) => ({ sessionDate, deadlineAt: `${sessionDate}T22:00:00.000Z`,
      firstCompletePublicationAt: `${sessionDate}T21:00:00.000Z`, status: "passed", reasons: [] })),
    usageDays: [{ usageDate: "2026-09-12", status: "pending", reasons: ["informational-weekend-sample"], requiredForRetirement: false }],
  } };
}
const view = (changes: Partial<Parameters<typeof buildEodRecoveryView>[0]> = {}) => buildEodRecoveryView({ recovery: recovery(), publications: publications(), now, ...changes });

test("cloud delivery needs no local controller and uses configured Paid quota limits", () => {
  const data = publications();
  data.budget = { profile: "paid", usageDate: "2026-09-15", daily: null, unavailableReason: null,
    limits: { eodDaily: { reads: 1_000_000_000, writes: 8_000_000 }, accountDaily: { reads: 1_500_000_000, writes: 10_000_000 },
      rolling31: { reads: 20_000_000_000, writes: 35_000_000 }, runtime: { httpCpuMs: 1000, coordinatorCpuMs: 1000, queriesPerInvocation: 300, queryDurationMs: 30_000 } },
    rolling31: { windowStart: "2026-08-16", windowEnd: "2026-09-15", sampledAt: checkedAt, rowsRead: 10_000_000,
      rowsWritten: 100_000, reservedReads: 0, reservedWrites: 0 } };
  Object.assign(data.monitoring!.currentHealth!.quota!, { eodRowsRead: 5_000_000, accountRowsRead: 6_000_000 });
  data.dailyOperation = { codeRevision: activationRevision, approvedAt: checkedAt, hotSessions: 90,
    storage: { status: "ready", checkedAt, accountBytes: 1_400_000_000, marketBytes: 140_000_000, historyBytes: 170_000_000,
      limits: { accountWarningBytes: 3_500_000_000, accountOptionalStopBytes: 4_500_000_000 } }, maintenance: null };
  const status = recovery(); status.configuration.status = "pending";
  assert.equal(view({ recovery: status, publications: data }).computerNeeded, "no");
  assert.equal(view({ recovery: status, publications: data }).currentHealth, "passed");
  data.budget.rolling31!.rowsWritten = 35_000_001;
  assert.equal(view({ publications: data }).currentHealth, "unverified");
});

test("no data stays pending without an observation requirement or invented health", () => {
  const result = view({ recovery: null, publications: null });
  assert.equal(result.status, "pending"); assert.equal(result.requiredSessions, 0); assert.equal(result.monitoringCount, null);
  assert.equal(result.currentHealth, "unverified");
  assert.equal(result.computerNeeded, "unknown"); assert.ok(result.milestones.every((row) => row.status === "pending"));
});
test("a completed local command and passed monitoring cannot stand in for configuration recording", () => {
  const status = recovery(); status.configuration = { status: "pending", codeRevision: null, activationCodeRevision: null, recordedAt: null };
  const result = view({ recovery: status });
  assert.equal(result.status, "pending"); assert.match(result.blocker!, /configuration has not been recorded/);
  assert.equal(result.milestones[1].status, "pending"); assert.equal(result.currentHealth, "passed"); assert.equal(result.computerNeeded, "yes");
});
test("verified cutover and follow-up configuration complete without an observation period", () => {
  const result = view();
  assert.equal(result.status, "complete"); assert.equal(result.blocker, null); assert.equal(result.computerNeeded, "no");
  assert.ok(result.milestones.every((row) => row.status === "complete"));
  assert.match(result.milestones[1].detail, /bbbbbbb/); assert.equal(result.reportFreshness, "current");
});
test("stale controller cannot verify completion; unavailable health does not undo recorded recovery", () => {
  const status = recovery(); status.controller!.stale = true;
  assert.equal(view({ recovery: status }).status, "pending"); assert.equal(view({ recovery: status }).reportFreshness, "outdated");
  const data = publications(); data.monitoring!.stale = true;
  assert.equal(view({ publications: data }).status, "complete"); assert.equal(view({ publications: data }).currentHealth, "unverified");
  assert.equal(view({ recoveryError: "quota" }).computerNeeded, "unknown");
  assert.notEqual(view({ recoveryError: "quota" }).status, "complete");
  assert.equal(view({ publicationError: "quota" }).currentHealth, "unverified");
  assert.equal(view({ publicationError: "quota" }).status, "complete");
  assert.equal(view({ publications: null }).status, "complete");
});
test("controller progress remains visible when publication status is unavailable", () => {
  const status = recovery(); status.controller = { ...status.controller!, status: "running", stage: "bootstrap", updatedAt: checkedAt, reason: "durable-github-stage-in-progress" };
  status.configuration.status = "pending";
  const result = view({ recovery: status, publications: null, publicationError: "daily read quota" });
  assert.equal(result.status, "running"); assert.match(result.blocker!, /GitHub recovery job/); assert.equal(result.stage, "Rebuilding the latest session");
  assert.equal(result.computerNeeded, "yes");
});
test("paused controller and configuration mismatches are explicit blockers", () => {
  const status = recovery(); status.controller!.status = "paused"; status.controller!.reason = "storage-local-review-required";
  assert.equal(view({ recovery: status }).status, "paused"); assert.match(view({ recovery: status }).blocker!, /paused for review/);
  status.controller!.status = "completed"; status.configuration.activationCodeRevision = "wrong";
  assert.equal(view({ recovery: status }).status, "paused"); assert.equal(view({ recovery: status }).milestones[1].status, "blocked");
});
test("an outdated pause keeps its specific dated blocker and does not imply an always-on computer clears capacity", () => {
  for (const reason of ["storage-preflight-insufficient-headroom", "storage-preflight-insufficient-archive-headroom", "storage-start-free-account-capacity-exceeded"]) {
    const status = recovery(); status.controller = { ...status.controller!, status: "paused", stage: "capacity-analysis", reason, stale: true };
    status.configuration.status = "pending"; status.activation = null;
    const result = view({ recovery: status, publicationError: "quota", recoveryError: "unavailable" });
    assert.equal(result.status, "paused"); assert.equal(result.reportFreshness, "outdated");
    assert.match(result.blocker!, /storage/); assert.match(result.blocker!, /Last reported 2026-09-10/); assert.match(result.blocker!, /unverified/);
    assert.equal(result.computerNeeded, "when recovery resumes"); assert.match(result.computerDetail, /Keeping it on does not clear this capacity pause/);
    assert.equal(result.stage, "Checking database capacity"); assert.notEqual(result.milestones[1].status, "complete");
  }
});
test("waiting reports show the actual next retry and never invent a completed stage", () => {
  const status = recovery(); status.controller = { ...status.controller!, status: "waiting", reason: "storage-local-quota-deferred", nextAttemptAt: "2026-09-16T00:05:00.000Z" };
  const result = view({ recovery: status });
  assert.equal(result.status, "pending"); assert.equal(result.nextRetry, status.controller.nextAttemptAt); assert.match(result.blocker!, /quota reset/);
});
test("old three- and ten-session caches cannot establish current health or undo recorded cutover", () => {
  for (const requiredSessions of [3, 10]) {
    const data = publications(); data.monitoring = { ...data.monitoring!, version: 2, policyVersion: "three-trading-sessions-v1", requiredSessions, consecutivePassedSessions: requiredSessions };
    const result = view({ publications: data });
    assert.equal(result.status, "complete"); assert.equal(result.monitoringCount, null); assert.equal(result.requiredSessions, 0);
    assert.equal(result.currentHealth, "unverified");
  }
});

test("empty observation history needs no waiting period; missing current evidence remains unverified", () => {
  const data = publications(); data.monitoring!.sessions = []; data.monitoring!.usageDays = [];
  data.monitoring!.newerSessions = []; data.monitoring!.usageFinalizationCutoff = null;
  assert.equal(view({ publications: data }).status, "complete"); assert.equal(view({ publications: data }).currentHealth, "passed");
  data.monitoring!.currentHealth = null;
  assert.equal(view({ publications: data }).status, "complete"); assert.equal(view({ publications: data }).currentHealth, "unverified");
});

test("historical deadline failures and unsettled days remain informational after current delivery recovers", () => {
  const data = publications(); data.monitoring!.newerSessions = [{ sessionDate: "2026-09-15", deadlineAt: checkedAt,
    firstCompletePublicationAt: checkedAt, status: "failed", reasons: ["first-publication-deadline-missed-or-invalid"] }];
  data.monitoring!.operationalReasons = ["newer-session-delivery-failed"];
  assert.equal(view({ publications: data }).status, "complete"); assert.equal(view({ publications: data }).currentHealth, "passed");
});

test("aged quota evidence does not reset recorded recovery or claim current health", () => {
  const data = publications(); data.monitoring!.currentHealth!.quotaSampledAt = "2026-09-15T21:00:00.000Z";
  assert.equal(view({ publications: data }).status, "complete"); assert.equal(view({ publications: data }).currentHealth, "unverified");
  data.monitoring!.currentHealth!.quotaSampledAt = checkedAt;
  data.monitoring!.currentHealth!.quota!.reservedWrites = 90_000;
  assert.equal(view({ publications: data }).status, "complete"); assert.notEqual(view({ publications: data }).currentHealth, "passed");
});

test("missing readiness or input revisions blocks current health; mismatched activation blocks recovery", () => {
  for (const patch of [{ ready: false }, { inputCorrectionsPending: true }, { inputCorrectionsPending: null }, { mode: "shadow" }]) {
    assert.notEqual(view({ publications: { ...publications(), ...patch } }).currentHealth, "passed");
    assert.equal(view({ publications: { ...publications(), ...patch } }).status, "complete");
  }
  const status = recovery(); status.controller!.codeRevision = "different";
  assert.notEqual(view({ recovery: status }).status, "complete");
  assert.notEqual(view({ recovery: { ...recovery(), checkedAt: "invalid" } }).status, "complete");
});

test("recovery API uses the same-origin authenticated admin proxy, never a public Worker request", async (context) => {
  const calls: Array<{ path: RequestInfo | URL; init?: RequestInit }> = [];
  context.mock.method(globalThis, "fetch", async (path: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path, init }); return Response.json(recovery());
  });
  const signal = AbortSignal.timeout(1000);
  assert.deepEqual(await getEodRecoveryStatus({ signal }), recovery());
  assert.equal(calls[0].path, "/api/admin/eod/recovery-status");
  assert.equal(calls[0].init?.credentials, "same-origin"); assert.equal(calls[0].init?.cache, "no-store"); assert.equal(calls[0].init?.signal, signal);
});
