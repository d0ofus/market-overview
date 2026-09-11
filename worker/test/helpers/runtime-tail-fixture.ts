import { RUNTIME_TAIL_ROUTES, type RuntimeTailAttempt } from "../../src/eod-runtime-tail-evidence";
import type { RuntimeEvidenceIdentity } from "../../src/eod-runtime-evidence";
export const tailUuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const tailIdentity: RuntimeEvidenceIdentity = { probeId: "tail-fixture", workerName: "market-eod-probe-fixture", workerVersion: tailUuid(1),
  codeRevision: "a".repeat(40), targetDatabaseId: tailUuid(2), historyDatabaseId: tailUuid(3), opsDatabaseId: tailUuid(4), coreDatabaseId: tailUuid(5) };
export const tailWindow = { from: Date.parse("2026-09-11T01:00:01Z"), to: Date.parse("2026-09-11T01:01:00Z") };
export function tailAttempt(): RuntimeTailAttempt {
  return { version: 1, identity: tailIdentity, publicationHash: "b".repeat(64), validationPlanHash: "c".repeat(64),
    connectedAt: "2026-09-11T01:00:00.000Z", probeUntil: "2026-09-11T03:00:00.000Z",
    requests: RUNTIME_TAIL_ROUTES.map((route, i) => ({ route, nonce: tailUuid(i + 20) })) };
}
export function tailVersion() {
  const bindings = { DB: tailIdentity.coreDatabaseId, MARKET_DATA_DB: tailIdentity.targetDatabaseId,
    MARKET_HISTORY_DB: tailIdentity.historyDatabaseId, OPS_DB: tailIdentity.opsDatabaseId, EOD_READ_ENABLED: "true",
    EOD_RUNTIME_CANDIDATE_ONLY: "true", EOD_RUNTIME_PROBE_ID: tailIdentity.probeId, EOD_CODE_REVISION: tailIdentity.codeRevision,
    EOD_RUNTIME_TARGET_DATABASE_ID: tailIdentity.targetDatabaseId };
  return { id: tailIdentity.workerVersion, resources: { bindings: Object.entries(bindings).map(([name, value]) =>
    ["DB", "MARKET_DATA_DB", "MARKET_HISTORY_DB", "OPS_DB"].includes(name) ? { name, type: "d1", id: value } : { name, type: "plain_text", text: value }) } };
}
export function tailFrame(i = 0) {
  const route = RUNTIME_TAIL_ROUTES[i], requestId = String(i + 1).padStart(16, "0");
  const summary = { event: "eod-runtime-probe-v1", probeId: tailIdentity.probeId, sampleId: tailUuid(i + 10),
    category: i === 4 ? "coordinator" : "http", route, codeRevision: tailIdentity.codeRevision, workerVersion: tailIdentity.workerVersion,
    targetDatabaseId: tailIdentity.targetDatabaseId, eodReadEnabled: true, startedAt: "2026-09-11T01:00:02.000Z",
    finishedAt: "2026-09-11T01:00:03.000Z", outcome: "ok", complete: true, cpuSource: "cloudflare-invocation-log-required",
    stats: { queries: 10 + i, rowsRead: 100, rowsWritten: 5, maxQueryDurationMs: i + 0.5, missingMetadata: 0, failedQueries: 0 } };
  return { scriptName: tailIdentity.workerName, scriptVersion: { id: tailIdentity.workerVersion }, cpuTime: i + 1, wallTime: 10000,
    outcome: "ok", truncated: false, eventTimestamp: tailWindow.from + 1000, exceptions: [],
    logs: [{ message: [summary] }], event: { request: { url: `https://${tailIdentity.workerName}.test.workers.dev${route}`,
      method: i === 4 ? "POST" : "GET", headers: { "Cf-Ray": requestId, "X-Eod-Runtime-Request-Id": tailUuid(i + 20),
        Authorization: "private-test-secret", Cookie: "private-cookie" } }, response: { status: 200 } } };
}
