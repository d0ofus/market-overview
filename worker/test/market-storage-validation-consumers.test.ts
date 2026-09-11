import { describe, expect, it } from "vitest";
import { assertStorageAcceptedValidationPlan, validateStorageValidationBootstrap,
  type StorageValidationPlanReference } from "../src/market-storage-validation-consumers";
import { storageHash } from "../src/market-storage-pages";

const target = "00000000-0000-4000-8000-000000000002", sessionDate = "2026-09-11";
const plan: StorageValidationPlanReference = {
  planHash: "a".repeat(64), sessionDate, tickers: ["AAA", "BBB", "NEW"], sourceSnapshotHash: "b".repeat(64),
  capture: { identity: { id: "market-storage:test", sourceDatabaseId: "00000000-0000-4000-8000-000000000001",
    targetDatabaseId: target, historyDatabaseId: "00000000-0000-4000-8000-000000000003",
    codeRevision: "c".repeat(40), sessionDate: "2026-09-08" }, captureHash: "d".repeat(64),
    sourceCapture: { revision: 0, schemaHash: "e".repeat(64) }, targetCapture: { revision: 10, schemaHash: "e".repeat(64) },
    historyCapture: { revision: 3, schemaHash: "f".repeat(64) } },
};
const bootstrap = () => ({ inputHash: plan.planHash, payload: { runId: `eod:active:${sessionDate}:daily`, sessionDate, targetDatabaseId: target } });
async function acceptance() {
  const proof = { sessionDate }, proofHash = await storageHash(proof);
  const provenance = { validationPlanHash: plan.planHash, captureHash: plan.capture.captureHash,
    sourceSnapshotSha256: plan.sourceSnapshotHash, proofHash };
  const record = { proof, proofHash, provenance, provenanceHash: await storageHash(provenance) };
  const progress = { validationPlanHash: plan.planHash, cutoverProofHash: proofHash, storageCutoverProofId: `storage-cutover-proof:${proofHash}`,
    publications: { tickerHash: await storageHash([...plan.tickers].sort()), tickerCount: plan.tickers.length, sessionDate } };
  return { progress, record };
}

describe("current population plan validation consumers", () => {
  it("uses the current plan session while preserving the older copy identity", async () => {
    const result = await validateStorageValidationBootstrap(plan, { complete: bootstrap(), owner: bootstrap(), targetDatabaseId: target, expectedSession: sessionDate });
    expect(result.sessionDate).toBe(sessionDate);
    expect(plan.capture.identity.sessionDate).toBe("2026-09-08");
    const { progress, record } = await acceptance();
    await expect(assertStorageAcceptedValidationPlan(plan, progress, record)).resolves.toBeUndefined();
  });

  it("rejects an old same-session bootstrap that is bound to the copy capture", async () => {
    const old = { ...bootstrap(), inputHash: plan.capture.captureHash };
    await expect(validateStorageValidationBootstrap(plan, { complete: old, owner: old, targetDatabaseId: target, expectedSession: sessionDate }))
      .rejects.toThrow("bootstrap-plan-mismatch");
  });

  it("requests a later session only for an otherwise valid completed bootstrap", async () => {
    const input = { complete: bootstrap(), owner: bootstrap(), targetDatabaseId: target, expectedSession: sessionDate };
    await expect(validateStorageValidationBootstrap(plan, { ...input, expectedSession: "2026-09-14" })).rejects.toThrow("bootstrap-latest-session-required");
    await expect(validateStorageValidationBootstrap(plan, { ...input, expectedSession: "2026-09-10" })).rejects.toThrow("bootstrap-plan-mismatch");
    await expect(validateStorageValidationBootstrap(plan, { ...input, expectedSession: "2026-99-99" })).rejects.toThrow("bootstrap-plan-mismatch");
    await expect(validateStorageValidationBootstrap(plan, { ...input, owner: { ...bootstrap(), inputHash: "f".repeat(64) } })).rejects.toThrow("bootstrap-plan-mismatch");
    await expect(validateStorageValidationBootstrap(plan, { ...input, targetDatabaseId: "wrong" })).rejects.toThrow("bootstrap-plan-mismatch");
    await expect(validateStorageValidationBootstrap(plan, { ...input, expectedSession: "2026-09-14", targetDatabaseId: "wrong" })).rejects.toThrow("bootstrap-plan-mismatch");
  });

  it("rejects a new unaccepted plan, including a changed population with the old plan hash", async () => {
    const { progress, record } = await acceptance();
    for (const replacement of [{ ...plan, planHash: "1".repeat(64) }, { ...plan, tickers: ["AAA", "BBB", "OTHER"] },
      { ...plan, tickers: ["AAA", "BBB"] }, { ...plan, tickers: ["AAA", "AAA", "NEW"] }]) {
      await expect(assertStorageAcceptedValidationPlan(replacement, progress, record)).rejects.toThrow("accepted-plan-mismatch");
    }
  });

  it("binds the refreshed capture and original physical snapshot separately", async () => {
    const { progress, record } = await acceptance();
    await expect(assertStorageAcceptedValidationPlan({ ...plan, sourceSnapshotHash: "1".repeat(64) }, progress, record)).rejects.toThrow("accepted-plan-mismatch");
    await expect(assertStorageAcceptedValidationPlan({ ...plan, capture: { ...plan.capture, captureHash: "1".repeat(64) } }, progress, record)).rejects.toThrow("accepted-plan-mismatch");
  });

  it("rejects proof/provenance tampering and missing immutable plan linkage", async () => {
    const { progress, record } = await acceptance();
    await expect(assertStorageAcceptedValidationPlan(plan, progress, { ...record, proof: { sessionDate: "2026-09-08" } })).rejects.toThrow("accepted-plan-mismatch");
    await expect(assertStorageAcceptedValidationPlan(plan, progress, { ...record, provenanceHash: "1".repeat(64) })).rejects.toThrow("accepted-plan-mismatch");
    await expect(assertStorageAcceptedValidationPlan(plan, { ...progress, validationPlanHash: undefined }, record)).rejects.toThrow("accepted-plan-mismatch");
    const missing = { ...record.provenance, validationPlanHash: undefined };
    await expect(assertStorageAcceptedValidationPlan(plan, progress, { ...record, provenance: missing, provenanceHash: await storageHash(missing) })).rejects.toThrow("accepted-plan-mismatch");
  });
});
