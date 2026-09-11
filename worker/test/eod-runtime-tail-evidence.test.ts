import { describe, expect, it, vi } from "vitest";
import { buildRuntimeTailEvidence, claimRuntimeTailAttempt, loadRuntimeTailReceipt, sanitizeRuntimeTailEvent,
  storeRuntimeTailReceipt, verifyRuntimeLiveVersion, runtimeTailReceiptId } from "../src/eod-runtime-tail-evidence";
import { validateRuntimeEvidence } from "../src/eod-runtime-evidence";
import { eodHash } from "../src/eod-publication-service";
import { tailAttempt, tailFrame, tailIdentity, tailVersion, tailWindow } from "./helpers/runtime-tail-fixture";
import { createSqliteD1 } from "./helpers/sqlite-d1";

async function evidence() {
  const events = Array.from({ length: 5 }, (_, i) => sanitizeRuntimeTailEvent(tailFrame(i), tailIdentity));
  const input = { identity: tailIdentity, version: tailVersion(), attempt: tailAttempt(), events,
    responses: events.map(row => ({ nonce: row.nonce, requestId: row.sample.requestId + "-SYD" })), window: tailWindow,
    closedAt: "2026-09-11T01:01:01.000Z", collectedAt: "2026-09-11T01:01:02.000Z" };
  return { input, artifact: await buildRuntimeTailEvidence(input) };
}
describe("trusted live-tail receipt", () => {
  it("keeps real platform CPU maxima, final D1 counters and exact correlation, discarding raw secrets", async () => {
    const { artifact } = await evidence();
    expect(artifact.source).toBe("cloudflare-workers-live-tail-receipt");
    expect(artifact.measurements).toEqual({ httpCpuMs: 4, coordinatorCpuMs: 5, queriesPerInvocation: 14, queryDurationMs: 4.5 });
    expect(await validateRuntimeEvidence(artifact, tailIdentity)).toEqual(artifact);
    for (const hidden of ["private-test-secret", "private-cookie", "headers", "wallTime", "wss:"]) expect(JSON.stringify(artifact)).not.toContain(hidden);
  });
  it.each(["cpu-missing", "cpu-negative", "wrong-version", "failed", "truncated", "exception", "missing-summary", "duplicate-summary", "ambiguous-header"])("rejects %s", kind => {
    const frame = tailFrame();
    if (kind === "cpu-missing") delete (frame as Partial<typeof frame>).cpuTime;
    if (kind === "cpu-negative") frame.cpuTime = -1;
    if (kind === "wrong-version") frame.scriptVersion.id = "wrong";
    if (kind === "failed") frame.outcome = "exceededCpu";
    if (kind === "truncated") frame.truncated = true;
    if (kind === "exception") (frame.exceptions as unknown[]).push({ message: "sensitive" });
    if (kind === "missing-summary") frame.logs = [];
    if (kind === "duplicate-summary") frame.logs.push(frame.logs[0]);
    if (kind === "ambiguous-header") Object.assign(frame.event.request.headers, { "cf-ray": "0000000000000001" });
    expect(() => sanitizeRuntimeTailEvent(frame, tailIdentity)).toThrow("runtime-tail-");
  });
  it("refuses missing, duplicate, mismatched response IDs and samples outside the connected window", async () => {
    const { input } = await evidence();
    await expect(buildRuntimeTailEvidence({ ...input, events: input.events.slice(0, 4) })).rejects.toThrow("exact-five");
    await expect(buildRuntimeTailEvidence({ ...input, events: [input.events[0], ...input.events.slice(0, 4)] })).rejects.toThrow("exact-five");
    const changed = structuredClone(input); changed.responses[0].requestId = "9999999999999999";
    await expect(buildRuntimeTailEvidence(changed)).rejects.toThrow("correlation-mismatch");
    await expect(buildRuntimeTailEvidence({ ...input, attempt: { ...input.attempt, connectedAt: "2026-09-11T01:00:02.000Z" } })).rejects.toThrow("window-invalid");
  });
  it("loads immutable Ops evidence, refuses an imported artifact without a receipt, and retains original collection time on replay", async () => {
    const sqlite = createSqliteD1(); sqlite.migrate("ops-migrations");
    try {
      const { artifact, input } = await evidence(), expected = { publicationHash: input.attempt.publicationHash, validationPlanHash: input.attempt.validationPlanHash };
      await expect(loadRuntimeTailReceipt(sqlite.db, tailIdentity, expected)).rejects.toThrow("durable-receipt-missing");
      await claimRuntimeTailAttempt(sqlite.db, input.attempt);
      await expect(claimRuntimeTailAttempt(sqlite.db, input.attempt)).rejects.toThrow("already-claimed");
      const configurationHash = await eodHash({ probeId: tailIdentity.probeId, until: Date.parse(input.attempt.probeUntil),
        codeRevision: tailIdentity.codeRevision, workerVersion: tailIdentity.workerVersion, targetDatabaseId: tailIdentity.targetDatabaseId });
      await sqlite.db.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?)")
        .bind(`eod-runtime-counter:${tailIdentity.probeId}`, JSON.stringify({ claimed: 5, configurationHash }), artifact.collectedAt).run();
      await sqlite.db.batch(artifact.samples.map(sample => sqlite.db.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?)")
        .bind(`eod-runtime:${tailIdentity.probeId}:${sample.summary.sampleId}`, JSON.stringify({ ...sample.summary, complete: false,
          measurementStage: "before-final-control-settlement" }), sample.summary.finishedAt)));
      expect(await storeRuntimeTailReceipt(sqlite.db, artifact)).toEqual(artifact);
      expect((await loadRuntimeTailReceipt(sqlite.db, tailIdentity, expected)).collectedAt).toBe(artifact.collectedAt);
      expect(await storeRuntimeTailReceipt(sqlite.db, artifact)).toEqual(artifact);
      await expect(loadRuntimeTailReceipt(sqlite.db, tailIdentity, { ...expected, publicationHash: "d".repeat(64) })).rejects.toThrow("identity-conflict");
      const changed = structuredClone(artifact); changed.collectedAt = "2026-09-11T01:01:03.000Z";
      const { evidenceHash: _, ...body } = changed; changed.evidenceHash = await eodHash(body);
      await expect(storeRuntimeTailReceipt(sqlite.db, changed)).rejects.toThrow("identity-conflict");
      expect(await sqlite.db.prepare("SELECT COUNT(*) AS count FROM eod_rollout_evidence WHERE id=?").bind(runtimeTailReceiptId(tailIdentity)).first("count")).toBe(1);
      await sqlite.db.prepare("UPDATE eod_rollout_evidence SET evidence_json=json_set(evidence_json,'$.claimed',6) WHERE id=?").bind(`eod-runtime-counter:${tailIdentity.probeId}`).run();
      await expect(loadRuntimeTailReceipt(sqlite.db, tailIdentity, expected)).rejects.toThrow("counter-incomplete");
    } finally { sqlite.dispose(); }
  }, 30_000);
  it("checks the actual single 100% deployment and fails auth without replaying restricted endpoints", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => Response.json({ success: true, result: String(url).endsWith("deployments")
      ? { deployments: [{ versions: [{ version_id: tailIdentity.workerVersion, percentage: 100 }] }] } : tailVersion() }));
    const input = { accountId: "a".repeat(32), token: "test-token", identity: tailIdentity, fetcher };
    await expect(verifyRuntimeLiveVersion(input)).resolves.toEqual(tailVersion());
    fetcher.mockResolvedValueOnce(Response.json({ success: true, result: { deployments: [{ versions: [{ version_id: tailIdentity.workerVersion, percentage: 50 }] }] } }));
    await expect(verifyRuntimeLiveVersion(input)).rejects.toThrow("exclusive-version-changed");
    fetcher.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(verifyRuntimeLiveVersion(input)).rejects.toThrow("http-403");
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("telemetry"))).toBe(false);
  });
});
