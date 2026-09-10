import assert from "node:assert/strict";
import test from "node:test";
import { buildEodRecoveryView } from "./eod-recovery-status";
import { getEodRecoveryStatus, type EodPublicationStatus, type EodRecoveryStatus } from "./api";

const checkedAt = "2026-09-15T22:00:00.000Z", now = Date.parse(checkedAt), activationRevision = "a".repeat(40), configurationRevision = "b".repeat(40);
function recovery(): EodRecoveryStatus {
  return { checkedAt, controller: { status: "completed", stage: "public-cutover", reason: "three-trading-session-monitoring-remains",
    nextAttemptAt: null, updatedAt: "2026-09-10T22:00:00.000Z", codeRevision: activationRevision, stale: false },
    activation: { activatedAt: "2026-09-10T21:00:00.000Z", codeRevision: activationRevision },
    configuration: { status: "recorded", codeRevision: configurationRevision, activationCodeRevision: activationRevision, recordedAt: "2026-09-10T22:00:00.000Z" } };
}
function publications(): EodPublicationStatus {
  return { mode: "active", ready: true, inputCorrectionsPending: false, runs: [], publications: [], monitoring: {
    version: 2, policyVersion: "three-trading-sessions-v1", checkedAt, requiredSessions: 3, consecutivePassedSessions: 3,
    usageFinalizationCutoff: "2026-09-15", newerSessions: [],
    eligibleForRetirement: true, latestEvaluatedSession: "2026-09-15", reasons: [], stale: false,
    sessions: ["2026-09-11", "2026-09-14", "2026-09-15"].map((sessionDate) => ({ sessionDate, deadlineAt: `${sessionDate}T22:00:00.000Z`,
      firstCompletePublicationAt: `${sessionDate}T21:00:00.000Z`, status: "passed", reasons: [] })),
    usageDays: [{ usageDate: "2026-09-12", status: "pending", reasons: ["informational-weekend-sample"], requiredForRetirement: false }],
  } };
}
const view = (changes: Partial<Parameters<typeof buildEodRecoveryView>[0]> = {}) => buildEodRecoveryView({ recovery: recovery(), publications: publications(), now, ...changes });

test("no data stays pending with a three-session target and unknown computer requirements", () => {
  const result = view({ recovery: null, publications: null });
  assert.equal(result.status, "pending"); assert.equal(result.requiredSessions, 3); assert.equal(result.monitoringCount, null);
  assert.equal(result.computerNeeded, "unknown"); assert.ok(result.milestones.every((row) => row.status === "pending"));
});
test("a completed local command and passed monitoring cannot stand in for configuration recording", () => {
  const status = recovery(); status.configuration = { status: "pending", codeRevision: null, activationCodeRevision: null, recordedAt: null };
  const result = view({ recovery: status });
  assert.equal(result.status, "pending"); assert.match(result.blocker!, /configuration has not been recorded/);
  assert.equal(result.milestones[1].status, "pending"); assert.equal(result.milestones[2].status, "complete"); assert.equal(result.computerNeeded, "yes");
});
test("verified follow-up configuration revision and three actual trading sessions complete independently", () => {
  const result = view();
  assert.equal(result.status, "complete"); assert.equal(result.blocker, null); assert.equal(result.computerNeeded, "no");
  assert.ok(result.milestones.every((row) => row.status === "complete"));
  assert.match(result.milestones[1].detail, /bbbbbbb/); assert.equal(result.reportFreshness, "current");
});
test("stale controller, stale monitoring and failures to refresh never show overall completion", () => {
  const status = recovery(); status.controller!.stale = true;
  assert.equal(view({ recovery: status }).status, "pending"); assert.equal(view({ recovery: status }).reportFreshness, "outdated");
  const data = publications(); data.monitoring!.stale = true;
  assert.notEqual(view({ publications: data }).status, "complete"); assert.equal(view({ publications: data }).milestones[2].status, "outdated");
  assert.equal(view({ recoveryError: "quota" }).computerNeeded, "unknown");
  assert.notEqual(view({ recoveryError: "quota" }).status, "complete");
  assert.equal(view({ publicationError: "quota" }).milestones[2].status, "outdated");
  assert.notEqual(view({ publicationError: "quota" }).status, "complete");
  assert.notEqual(view({ publications: null }).status, "complete");
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
test("legacy ten-session cached reports cannot satisfy the new policy", () => {
  const data = publications(); data.monitoring = { ...data.monitoring!, version: 1, policyVersion: undefined, requiredSessions: 10, consecutivePassedSessions: 10 };
  const result = view({ publications: data });
  assert.equal(result.status, "pending"); assert.equal(result.monitoringCount, null); assert.equal(result.requiredSessions, 3);
  assert.match(result.blocker!, /current three-trading-session policy/);
});
test("three-session reports must include the finalized-window metadata and cannot count newer sessions", () => {
  for (const patch of [{ usageFinalizationCutoff: undefined }, { usageFinalizationCutoff: null }, { usageFinalizationCutoff: "invalid" }, { newerSessions: undefined }]) {
    const data = publications(); data.monitoring = { ...data.monitoring!, ...patch };
    assert.equal(view({ publications: data }).status, "pending"); assert.equal(view({ publications: data }).monitoringCount, null);
  }
  const data = publications(); data.monitoring!.usageFinalizationCutoff = "2026-09-14";
  assert.notEqual(view({ publications: data }).status, "complete");
});
test("weekends add no progress and informational weekend usage does not block valid sessions", () => {
  assert.equal(view().status, "complete"); // Friday + Monday + Tuesday, despite pending Saturday usage.
  const data = publications(); data.monitoring!.sessions = data.monitoring!.sessions.slice(0, 2);
  data.monitoring!.consecutivePassedSessions = 2; data.monitoring!.eligibleForRetirement = false;
  assert.equal(view({ publications: data }).monitoringCount, 2); assert.equal(view({ publications: data }).status, "pending");
  const corrupt = publications(); corrupt.monitoring!.sessions[1].sessionDate = "2026-09-12";
  assert.notEqual(view({ publications: corrupt }).status, "complete");
});
test("newer sessions settling usage do not require waiting for a weekend, while delivery failures remain blocking", () => {
  const data = publications(); data.monitoring!.usageFinalizationCutoff = "2026-09-15";
  data.monitoring!.newerSessions = [{ sessionDate: "2026-09-16", deadlineAt: checkedAt, firstCompletePublicationAt: checkedAt, status: "pending", reasons: ["finalized-utc-usage-pending"] }];
  assert.equal(view({ publications: data }).status, "complete");
  data.monitoring!.newerSessions[0].status = "failed"; data.monitoring!.eligibleForRetirement = false;
  data.monitoring!.reasons = ["newer-session-delivery-failed"];
  assert.equal(view({ publications: data }).status, "pending"); assert.match(view({ publications: data }).blocker!, /newer trading session failed/);
});
test("missing readiness, input correction evidence or matching activation blocks a green result", () => {
  for (const patch of [{ ready: false }, { inputCorrectionsPending: true }, { inputCorrectionsPending: null }, { mode: "shadow" }]) {
    assert.notEqual(view({ publications: { ...publications(), ...patch } }).status, "complete");
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
