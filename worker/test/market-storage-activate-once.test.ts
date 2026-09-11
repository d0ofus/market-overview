import { describe, expect, it, vi } from "vitest";
import { activateStorageMigrationOnce, validateStorageActivationState, type StorageActivationDependencies, type StorageActivationState } from "../src/market-storage-activate-once";
import { EOD_PUBLICATION_SCOPES } from "../src/eod-coordinator";
import { EOD_METRICS_VERSION } from "../src/eod-metrics";
import { EOD_CATALOG_SCOPE } from "../src/eod-catalog-service";
import { storageHash } from "../src/market-storage-pages";
import type { EodCutoverEvidence } from "../src/eod-rollout-service";
import type { StorageMigrationRun } from "../src/market-storage-control";
import { MARKET_HISTORY_REQUIRED_CONSUMERS } from "../src/eod-history-maintenance";
import type { StorageExecutionRecord } from "../src/market-storage-execution";

const identity = { id: "market-storage:test", sourceDatabaseId: "10000000-0000-4000-8000-000000000001",
  targetDatabaseId: "10000000-0000-4000-8000-000000000002", historyDatabaseId: "10000000-0000-4000-8000-000000000003",
  sessionDate: "2026-09-08", codeRevision: "a".repeat(40) };
const input = { identity, opsDatabaseId: "10000000-0000-4000-8000-000000000004" }, stamp = "2026-09-09T00:00:00Z";
async function fixture() {
  const proof: EodCutoverEvidence = { version: 1, codeRevision: identity.codeRevision, methodologyVersion: EOD_METRICS_VERSION,
    measuredAt: stamp, sessionDate: identity.sessionDate, runId: "eod:active:2026-09-08:daily", sharedTickers: { count: 60, processed: 60 },
    fullUniverseCounts: EOD_PUBLICATION_SCOPES.slice(1).map((scope) => ({ universeId: scope.slice(8) as EodCutoverEvidence["fullUniverseCounts"][number]["universeId"],
      memberCount: 10, attemptedCount: 10, observedCount: 10 })),
    scopes: EOD_PUBLICATION_SCOPES.map((scope) => ({ scope, publicationId: `p-${scope}`, sessionDate: identity.sessionDate })),
    measurements: { usageDate: identity.sessionDate, eodRowsRead: 1000, eodRowsWritten: 1000, accountRowsRead: 2000, accountRowsWritten: 2000,
      httpCpuMs: 1, coordinatorCpuMs: 1, queriesPerInvocation: 1, queryDurationMs: 1, source: "real measurements" },
    limits: { httpCpuMs: 10, coordinatorCpuMs: 10, queriesPerInvocation: 50, queryDurationMs: 30000 },
    capacity: { measuredAt: stamp, marketDatabaseBytes: 1000, priceTableAndIndexBytes: 800, priceRows: 200, retainedPriceRows: 16200,
      archiveDatabaseBytes: 100, additionalArchiveBytes: 100 },
    readers: { contractVersion: 1, checkedAt: stamp, consumers: [...MARKET_HISTORY_REQUIRED_CONSUMERS], parityPassed: true },
    retention: { hotSessions: 260, sweepHeadroomSessions: 10 } };
  const proofHash = await storageHash(proof), approval = { version: 1, codeRevision: identity.codeRevision,
    methodologyVersion: EOD_METRICS_VERSION, approvedAt: stamp, proofHash, proof };
  const unsigned = { version: 1, identity, runId: proof.runId, sessionDate: proof.sessionDate, inputClock: 1,
    tickerHash: "b".repeat(64), tickerCount: 60, checkedAt: stamp,
    scopes: [...EOD_PUBLICATION_SCOPES, EOD_CATALOG_SCOPE].map((scope) => ({ scope, id: `p-${scope}`, revision: 1, checksum: "c".repeat(64) })),
    membershipHash: "d".repeat(64), catalogHash: "e".repeat(64) };
  const accepted = { version: 1, publications: { ...unsigned, evidenceHash: await storageHash(unsigned) },
    cutoverProofHash: proofHash, storageCutoverProofId: `storage-cutover-proof:${proofHash}`, runtimeEvidenceHash: "f".repeat(64), publicBindingChanged: false };
  const provenance = { identity, proofHash };
  const storageProof = { version: 1, identity, runId: proof.runId, sessionDate: proof.sessionDate,
    proofHash, proof, provenance, provenanceHash: await storageHash(provenance), acceptedAt: stamp };
  const run = { id: identity.id, source_database_id: identity.sourceDatabaseId, target_database_id: identity.targetDatabaseId,
    history_database_id: identity.historyDatabaseId, session_date: identity.sessionDate, code_revision: identity.codeRevision,
    status: "awaiting-cutover", freeze_authorized: 1, source_schema_hash: "1".repeat(64), freeze_evidence_hash: "2".repeat(64),
    source_revision: 1, lease_token: null, lease_until: null, progress_json: JSON.stringify(accepted) } as StorageMigrationRun;
  return { run, approval, accepted, storageProof, now: new Date("2026-09-09T01:00:00Z") };
}
async function refreshStorageProof(f: Awaited<ReturnType<typeof fixture>>, update: (proof: EodCutoverEvidence) => void) {
  const proof = structuredClone(f.storageProof.proof); update(proof);
  const proofHash = await storageHash(proof), provenance = { identity, proofHash };
  f.storageProof = { ...f.storageProof, runId: proof.runId, sessionDate: proof.sessionDate,
    proof, proofHash, provenance, provenanceHash: await storageHash(provenance), acceptedAt: proof.measuredAt };
  f.accepted.cutoverProofHash = proofHash; f.accepted.storageCutoverProofId = `storage-cutover-proof:${proofHash}`;
  f.accepted.publications.runId = proof.runId; f.accepted.publications.sessionDate = proof.sessionDate;
  for (const scope of proof.scopes) f.accepted.publications.scopes.find((row) => row.scope === scope.scope)!.id = scope.publicationId;
  const { evidenceHash: _oldHash, ...unsigned } = f.accepted.publications;
  f.accepted.publications.evidenceHash = await storageHash(unsigned); f.run.progress_json = JSON.stringify(f.accepted);
}
async function protocol() {
  const setup = await fixture();
  let state: StorageActivationState = await validateStorageActivationState(input, setup.run, setup.approval, setup.storageProof, null, setup.now);
  let side: "source" | "target" = "source", marketDatabaseId = identity.sourceDatabaseId, mode: "shadow" | "active" = "shadow";
  let productionCodeRevision: string | null = null;
  const events: string[] = [];
  const deps: StorageActivationDependencies = {
    assertCheckout: vi.fn(async () => undefined), loadState: vi.fn(async () => structuredClone(state)),
    verifyPublications: vi.fn(async () => { events.push("publications"); }),
    inspectServing: vi.fn(async () => ({ side, versionId: `${side}-version`, deploymentId: `${side}-deployment` })),
    verifyGitHub: vi.fn(async () => ({ marketDatabaseId, mode, productionCodeRevision })),
    setGitHubVariable: vi.fn(async (name, value) => { events.push(name); if (name === "EOD_MARKET_DATABASE_ID") marketDatabaseId = value; else if (name === "EOD_PRODUCTION_CODE_REVISION") productionCodeRevision = value; else mode = value as "active"; }),
    authenticate: vi.fn(async () => { events.push("authenticate"); }),
    deployTarget: vi.fn(async () => { events.push("deploy"); side = "target"; }),
    verifyPublicTarget: vi.fn(async () => { events.push("verify-target"); if (side !== "target") throw new Error("wrong target"); }),
    complete: vi.fn(async () => { events.push("complete"); state = { ...state, activationRecorded: true, run: { ...state.run, status: "completed" } }; }),
    journal: vi.fn(async () => undefined),
  };
  return { deps, events, state, setState: (value: StorageActivationState) => { state = value; },
    setServing: (value: "source" | "target") => { side = value; },
    setGitHub: (id: string, value: "shadow" | "active") => { marketDatabaseId = id; mode = value; productionCodeRevision = value === "active" ? identity.codeRevision : null; },
    setPin: (value: string | null) => { productionCodeRevision = value; } };
}
describe("durable activation evidence", () => {
  it("accepts fresh execution proofs while retaining the original capture revision and requiring its lineage", async () => {
    const f = await fixture(), nextIdentity = { ...identity, codeRevision: "b".repeat(40) };
    const unsigned: Omit<StorageExecutionRecord, "evidenceHash"> = { version: 1, policy: "preserve-storage-capture-execution-v1",
      storageIdentity: identity, fromRevision: identity.codeRevision, codeRevision: nextIdentity.codeRevision, predecessorHash: null,
      sourceCapture: { schemaHash: f.run.source_schema_hash!, revision: f.run.source_revision! }, freezeEvidenceHash: f.run.freeze_evidence_hash!,
      checkpointCount: 1, checkpointManifestHash: "3".repeat(64), changedFiles: ["worker/src/eod-budget-profile.ts"], diffHash: "4".repeat(64), approvedAt: stamp,
      storagePolicy: { hotSessions: 90, marketBytes: 350_000_000, archiveBytes: 350_000_000, databaseCount: 10, accountBytes: 5_000_000_000 } };
    const executionApproval = { ...unsigned, evidenceHash: await storageHash(unsigned) };
    f.run.execution_revision = nextIdentity.codeRevision; f.run.execution_evidence_hash = executionApproval.evidenceHash;
    const proof = { ...f.storageProof.proof, codeRevision: nextIdentity.codeRevision, retention: { hotSessions: 90 as const, sweepHeadroomSessions: 10 } };
    const proofHash = await storageHash(proof), provenance = { identity: nextIdentity, proofHash };
    f.approval = { ...f.approval, codeRevision: nextIdentity.codeRevision, proof, proofHash };
    f.storageProof = { ...f.storageProof, identity: nextIdentity, proof, proofHash, provenance, provenanceHash: await storageHash(provenance) };
    f.accepted.publications.identity = nextIdentity;
    const { evidenceHash: _previous, ...pub } = f.accepted.publications;
    f.accepted.publications.evidenceHash = await storageHash(pub);
    f.accepted.cutoverProofHash = proofHash; f.accepted.storageCutoverProofId = `storage-cutover-proof:${proofHash}`;
    f.run.progress_json = JSON.stringify(f.accepted);
    const state = await validateStorageActivationState({ ...input, identity: nextIdentity, executionApproval }, f.run, f.approval, f.storageProof, null, f.now);
    expect(state.run.code_revision).toBe(identity.codeRevision); expect(state.proofHash).toBe(proofHash);
    await expect(validateStorageActivationState({ ...input, identity: nextIdentity }, f.run, f.approval, f.storageProof, null, f.now))
      .rejects.toThrow("storage-execution-record-invalid");
  });
  it("accepts refreshed storage measurements after a quota interruption without replacing original code approval", async () => {
    const f = await fixture(), originalCodeApproval = JSON.stringify(f.approval);
    await refreshStorageProof(f, (proof) => { proof.measuredAt = "2026-09-09T00:30:00Z"; proof.measurements.eodRowsRead += 10; });
    expect(f.storageProof.proofHash).not.toBe(f.approval.proofHash);
    const state = await validateStorageActivationState(input, f.run, f.approval, f.storageProof, null, f.now);
    expect(state.proofHash).toBe(f.storageProof.proofHash); expect(JSON.stringify(f.approval)).toBe(originalCodeApproval);
  });
  it("accepts a newer reconstructed run and session under the same code approval", async () => {
    const f = await fixture();
    await refreshStorageProof(f, (proof) => {
      proof.sessionDate = "2026-09-09"; proof.runId = "eod:active:2026-09-09:daily";
      proof.measuredAt = "2026-09-10T00:00:00Z"; proof.capacity.measuredAt = proof.measuredAt;
      proof.readers.checkedAt = proof.measuredAt; proof.measurements.usageDate = proof.sessionDate;
      proof.scopes = proof.scopes.map((scope) => ({ ...scope, publicationId: `${scope.publicationId}-new`, sessionDate: proof.sessionDate }));
    });
    const state = await validateStorageActivationState(input, f.run, f.approval, f.storageProof, null, new Date("2026-09-10T01:00:00Z"));
    expect(state.proofHash).toBe(f.storageProof.proofHash); expect(f.approval.proof.runId).not.toBe(f.storageProof.proof.runId);
  });
  it("does not substitute the old code proof for absent or mismatched latest storage evidence", async () => {
    const f = await fixture();
    await expect(validateStorageActivationState(input, f.run, f.approval, null, null, f.now)).rejects.toThrow("storage-proof-invalid");
    const oldStorage = structuredClone(f.storageProof);
    await refreshStorageProof(f, (proof) => { proof.measurements.eodRowsRead += 1; });
    await expect(validateStorageActivationState(input, f.run, f.approval, oldStorage, null, f.now)).rejects.toThrow("storage-proof-invalid");
    const wrong = { ...f.storageProof, provenance: { ...f.storageProof.provenance, identity: { ...identity, targetDatabaseId: identity.sourceDatabaseId } } };
    wrong.provenanceHash = await storageHash(wrong.provenance);
    await expect(validateStorageActivationState(input, f.run, f.approval, wrong, null, f.now)).rejects.toThrow("storage-proof-invalid");
  });
  it("expires pending storage acceptance after 24 hours while preserving completed replay", async () => {
    const f = await fixture(), later = new Date("2026-09-12T00:00:00Z");
    await expect(validateStorageActivationState(input, f.run, f.approval, f.storageProof, null, later)).rejects.toThrow("storage-proof-expired-or-invalid");
    f.run.status = "completed"; f.run.progress_json = JSON.stringify({ ...f.accepted, cutoverEvidenceHash: "0".repeat(64) });
    const activation = { version: 1, codeRevision: identity.codeRevision, marketDatabaseId: identity.targetDatabaseId, activatedAt: stamp };
    expect((await validateStorageActivationState(input, f.run, f.approval, f.storageProof, activation, later)).activationRecorded).toBe(true);
  });
  it("requires accepted durable proof and allows old durable code approval without redating it", async () => {
    const f = await fixture();
    f.approval.approvedAt = "2026-09-06T00:00:00Z";
    expect((await validateStorageActivationState(input, f.run, f.approval, f.storageProof, null, f.now)).proofHash).toBe(f.storageProof.proofHash);
  });
  it.each(["source_database_id", "target_database_id", "history_database_id", "code_revision"] as const)("rejects mismatched durable %s", async (field) => {
    const f = await fixture(); f.run[field] = "wrong";
    await expect(validateStorageActivationState(input, f.run, f.approval, f.storageProof, null, f.now)).rejects.toThrow("durable-run-not-ready");
  });
  it.each(["queued", "running", "aborted", "awaiting-evidence"] as const)("rejects status %s", async (status) => {
    const f = await fixture(); f.run.status = status;
    await expect(validateStorageActivationState(input, f.run, f.approval, f.storageProof, null, f.now)).rejects.toThrow("durable-run-not-ready");
  });
  it("rejects live or malformed leases before deployment", async () => {
    for (const lease of ["2026-09-09T02:00:00Z", "invalid"]) {
      const f = await fixture(); f.run.lease_until = lease;
      await expect(validateStorageActivationState(input, f.run, f.approval, f.storageProof, null, f.now)).rejects.toThrow("live-lease");
    }
  });
  it("rejects missing approval and tampered proof or accepted publication hashes", async () => {
    const f = await fixture();
    await expect(validateStorageActivationState(input, f.run, null, f.storageProof, null, f.now)).rejects.toThrow("durable-approval-invalid");
    await expect(validateStorageActivationState(input, f.run, { ...f.approval, proofHash: "0".repeat(64) }, f.storageProof, null, f.now)).rejects.toThrow("durable-approval-invalid");
    f.accepted.publications.inputClock = 9; f.run.progress_json = JSON.stringify(f.accepted);
    await expect(validateStorageActivationState(input, f.run, f.approval, f.storageProof, null, f.now)).rejects.toThrow("publication-evidence-invalid");
  });
  it("requires matching completion and public activation evidence on completed replay", async () => {
    const f = await fixture(); f.run.status = "completed";
    await expect(validateStorageActivationState(input, f.run, f.approval, f.storageProof, null, f.now)).rejects.toThrow("completion-evidence-missing");
    f.run.progress_json = JSON.stringify({ ...f.accepted, cutoverEvidenceHash: "0".repeat(64) });
    const activation = { version: 1, activatedAt: stamp, codeRevision: identity.codeRevision, marketDatabaseId: identity.targetDatabaseId };
    expect((await validateStorageActivationState(input, f.run, f.approval, f.storageProof, activation, f.now)).activationRecorded).toBe(true);
    await expect(validateStorageActivationState(input, f.run, f.approval, f.storageProof, { ...activation, marketDatabaseId: identity.sourceDatabaseId }, f.now)).rejects.toThrow("recorded-activation-conflict");
  });
});
describe("recoverable activation stages", () => {
  it("verifies publications, authenticates, sets target then mode, deploys and verifies before completing", async () => {
    const f = await protocol();
    expect(await activateStorageMigrationOnce(input, f.deps)).toMatchObject({ status: "completed", versionId: "target-version" });
    expect(f.events).toEqual(["publications", "authenticate", "EOD_PRODUCTION_CODE_REVISION", "EOD_MARKET_DATABASE_ID", "EOD_RUNNER_MODE", "publications", "deploy", "verify-target", "complete", "verify-target"]);
  });
  it.each(["EOD_PRODUCTION_CODE_REVISION", "EOD_MARKET_DATABASE_ID", "EOD_RUNNER_MODE"] as const)("resumes after %s persisted but response was lost", async (failure) => {
    const f = await protocol(), original = f.deps.setGitHubVariable;
    let fail = true;
    f.deps.setGitHubVariable = vi.fn(async (name, value) => { await original(name, value); if (name === failure && fail) { fail = false; throw new Error("response-lost"); } });
    await expect(activateStorageMigrationOnce(input, f.deps)).rejects.toThrow("response-lost");
    expect(f.deps.deployTarget).not.toHaveBeenCalled();
    expect(await activateStorageMigrationOnce(input, f.deps)).toMatchObject({ status: "completed" });
    expect(f.deps.setGitHubVariable).toHaveBeenCalledTimes(3);
  });
  it("does not redeploy when target became active before deployment response failed", async () => {
    const f = await protocol();
    f.deps.deployTarget = vi.fn(async () => { f.setServing("target"); throw new Error("response-lost"); });
    await expect(activateStorageMigrationOnce(input, f.deps)).rejects.toThrow("response-lost");
    expect(await activateStorageMigrationOnce(input, f.deps)).toMatchObject({ status: "completed" });
    expect(f.deps.deployTarget).toHaveBeenCalledTimes(1);
  });
  it("verifies completed actual target before accepting a lost completion response", async () => {
    const f = await protocol(), complete = f.deps.complete;
    f.deps.complete = vi.fn(async () => { await complete(); throw new Error("response-lost"); });
    await expect(activateStorageMigrationOnce(input, f.deps)).rejects.toThrow("response-lost");
    expect(await activateStorageMigrationOnce(input, f.deps)).toMatchObject({ status: "already-completed" });
    expect(f.deps.complete).toHaveBeenCalledTimes(1); expect(f.deps.deployTarget).toHaveBeenCalledTimes(1);
    f.setServing("source");
    await expect(activateStorageMigrationOnce(input, f.deps)).rejects.toThrow("completed-binding-drift");
  });
  it("fails closed on source-active GitHub state, proof failure and authentication failure", async () => {
    const f = await protocol(); f.setGitHub(identity.sourceDatabaseId, "active");
    await expect(activateStorageMigrationOnce(input, f.deps)).rejects.toThrow("github-state-conflict");
    f.setGitHub(identity.sourceDatabaseId, "shadow"); vi.mocked(f.deps.verifyPublications).mockRejectedValueOnce(new Error("missing-session"));
    await expect(activateStorageMigrationOnce(input, f.deps)).rejects.toThrow("missing-session");
    vi.mocked(f.deps.authenticate).mockRejectedValueOnce(new Error("not-authorized"));
    await expect(activateStorageMigrationOnce(input, f.deps)).rejects.toThrow("not-authorized");
    expect(f.deps.setGitHubVariable).not.toHaveBeenCalled(); expect(f.deps.deployTarget).not.toHaveBeenCalled();
  });
  it("rejects changed proof between stages and never completes unverified target", async () => {
    const f = await protocol(), original = f.deps.setGitHubVariable;
    f.deps.setGitHubVariable = vi.fn(async (name, value) => { await original(name, value); f.setState({ ...f.state, proofHash: "9".repeat(64) }); });
    await expect(activateStorageMigrationOnce(input, f.deps)).rejects.toThrow("durable-state-changed");
    expect(f.deps.deployTarget).not.toHaveBeenCalled(); expect(f.deps.complete).not.toHaveBeenCalled();
  });
  it("reconciles a previously deployed target without ever issuing a source deploy", async () => {
    const f = await protocol(); f.setServing("target"); f.setGitHub(identity.targetDatabaseId, "shadow");
    expect(await activateStorageMigrationOnce(input, f.deps)).toMatchObject({ status: "completed" });
    expect(f.deps.deployTarget).not.toHaveBeenCalled(); expect(f.deps.setGitHubVariable).toHaveBeenCalledWith("EOD_RUNNER_MODE", "active");
  });
  it("refuses an unrelated production pin and requires the approved pin to persist before changing database or mode", async () => {
    const conflict = await protocol(); conflict.setPin("f".repeat(40));
    await expect(activateStorageMigrationOnce(input, conflict.deps)).rejects.toThrow("github-state-conflict");
    expect(conflict.deps.setGitHubVariable).not.toHaveBeenCalled();
    const missing = await protocol(); missing.deps.setGitHubVariable = vi.fn(async () => undefined);
    await expect(activateStorageMigrationOnce(input, missing.deps)).rejects.toThrow("github-production-revision-not-persisted");
    expect(missing.deps.setGitHubVariable).toHaveBeenCalledTimes(1);
    expect(missing.deps.deployTarget).not.toHaveBeenCalled();
  });
});
