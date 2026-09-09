import { eodCutoverEvidenceSchema, validateEodCutoverEvidence } from "./eod-rollout-service";
import { storageHash } from "./market-storage-pages";
import { storageMigrationIdentity, type StorageMigrationIdentity, type StorageMigrationRun } from "./market-storage-control";
import type { StoragePublicationEvidence } from "./market-storage-acceptance";

export type StorageActivationInput = { identity: StorageMigrationIdentity; opsDatabaseId: string };
export type StorageActivationState = { run: StorageMigrationRun; proofHash: string; activationRecorded: boolean };
export type StorageServingState = { side: "source" | "target"; versionId: string; deploymentId: string };
export type StorageActivationDependencies = {
  assertCheckout(): Promise<void>;
  loadState(): Promise<StorageActivationState>;
  verifyPublications(state: StorageActivationState): Promise<void>;
  inspectServing(): Promise<StorageServingState>;
  verifyGitHub(): Promise<{ marketDatabaseId: string; mode: "shadow" | "active" }>;
  setGitHubVariable(name: "EOD_MARKET_DATABASE_ID" | "EOD_RUNNER_MODE", value: string): Promise<void>;
  authenticate(): Promise<void>;
  deployTarget(expectedSource: StorageServingState): Promise<void>;
  verifyPublicTarget(): Promise<void>;
  complete(): Promise<void>;
  journal(stage: string): Promise<void>;
};
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Read-only integrity check. Only the existing acceptance command creates an
 * approval; this orchestrator cannot manufacture acceptance from a local file. */
export async function validateStorageActivationState(input: StorageActivationInput, run: StorageMigrationRun,
  approvalInput: unknown, storageProofInput: unknown, activationInput: unknown, now = new Date()): Promise<StorageActivationState> {
  if (await storageHash(storageMigrationIdentity(run)) !== await storageHash(input.identity)
    || !["awaiting-cutover", "completed"].includes(run.status) || run.freeze_authorized !== 1
    || !hash(run.source_schema_hash) || !hash(run.freeze_evidence_hash) || !Number.isSafeInteger(run.source_revision)
    || run.source_revision === null || run.source_revision < 0) throw new Error("storage-activate-durable-run-not-ready");
  if (run.status !== "completed" && (run.lease_token !== null || (run.lease_until !== null
    && (!Number.isFinite(Date.parse(run.lease_until)) || Date.parse(run.lease_until) > now.getTime())))) {
    throw new Error("storage-activate-live-lease");
  }
  const approval = object(approvalInput), parsed = eodCutoverEvidenceSchema.safeParse(approval?.proof);
  if (!approval || approval.version !== 1 || approval.codeRevision !== input.identity.codeRevision || !parsed.success
    || parsed.data.codeRevision !== input.identity.codeRevision || approval.methodologyVersion !== parsed.data.methodologyVersion
    || typeof approval.approvedAt !== "string" || !Number.isFinite(Date.parse(approval.approvedAt))
    || Date.parse(approval.approvedAt) > now.getTime() || await storageHash(approval.proof) !== approval.proofHash) {
    throw new Error("storage-activate-durable-approval-invalid");
  }
  let accepted: Record<string, unknown> | null;
  try { accepted = object(JSON.parse(run.progress_json)); } catch { accepted = null; }
  // Code approval is intentionally immutable across repeated acceptance and
  // reconstruction. The latest storage acceptance has its own immutable proof.
  const storageProof = object(storageProofInput), latest = eodCutoverEvidenceSchema.safeParse(storageProof?.proof);
  if (!accepted || !storageProof || storageProof.version !== 1 || !latest.success || !hash(storageProof.proofHash)
    || storageProof.proofHash !== accepted?.cutoverProofHash
    || accepted.storageCutoverProofId !== `storage-cutover-proof:${storageProof.proofHash}`
    || await storageHash(storageProof.proof) !== storageProof.proofHash
    || await storageHash(storageProof.identity) !== await storageHash(input.identity)
    || storageProof.runId !== latest.data.runId || storageProof.sessionDate !== latest.data.sessionDate
    || latest.data.codeRevision !== input.identity.codeRevision || !hash(storageProof.provenanceHash)
    || !object(storageProof.provenance) || await storageHash(storageProof.provenance) !== storageProof.provenanceHash
    || object(storageProof.provenance)?.proofHash !== storageProof.proofHash
    || await storageHash(object(storageProof.provenance)?.identity) !== await storageHash(input.identity)
    || typeof storageProof.acceptedAt !== "string" || !Number.isFinite(Date.parse(storageProof.acceptedAt))
    || Date.parse(storageProof.acceptedAt) > now.getTime() || Date.parse(storageProof.acceptedAt) < Date.parse(latest.data.measuredAt)) {
    throw new Error("storage-activate-storage-proof-invalid");
  }
  // Initial activation requires still-current physical/runtime measurements.
  // A completed replay validates their original semantics without redating them.
  try { validateEodCutoverEvidence(storageProof.proof, input.identity.codeRevision,
    run.status === "completed" ? new Date(latest.data.measuredAt) : now); }
  catch { throw new Error("storage-activate-storage-proof-expired-or-invalid"); }
  const publications = object(accepted?.publications) as StoragePublicationEvidence | null;
  if (!accepted || accepted.version !== 1 || !hash(accepted.runtimeEvidenceHash)
    || accepted.publicBindingChanged !== false || !publications || publications.version !== 1
    || publications.runId !== latest.data.runId || publications.sessionDate !== latest.data.sessionDate
    || await storageHash(publications.identity) !== await storageHash(input.identity)
    || !Array.isArray(publications.scopes) || publications.scopes.length !== 7
    || new Set(publications.scopes.map((scope) => scope.scope)).size !== 7
    || new Set(publications.scopes.map((scope) => scope.id)).size !== 7
    || latest.data.scopes.some((scope) => !publications.scopes.some((actual) => actual.scope === scope.scope && actual.id === scope.publicationId))) {
    throw new Error("storage-activate-accepted-proof-mismatch");
  }
  const { evidenceHash, ...unsigned } = publications;
  if (await storageHash(unsigned) !== evidenceHash) throw new Error("storage-activate-publication-evidence-invalid");
  const activation = object(activationInput);
  if (activationInput !== null && (!activation || activation.version !== 1 || activation.codeRevision !== input.identity.codeRevision
    || activation.marketDatabaseId !== input.identity.targetDatabaseId || typeof activation.activatedAt !== "string"
    || !Number.isFinite(Date.parse(activation.activatedAt)) || Date.parse(activation.activatedAt) > now.getTime())) {
    throw new Error("storage-activate-recorded-activation-conflict");
  }
  if (run.status === "completed" && (!activation || !hash(accepted.cutoverEvidenceHash))) throw new Error("storage-activate-completion-evidence-missing");
  return { run, proofHash: storageProof.proofHash as string, activationRecorded: activation !== null };
}

/** Actual GitHub/Cloudflare state is the replay journal. No rollback deploy is
 * issued: once the target serves, recovery only verifies it and completes Ops. */
export async function activateStorageMigrationOnce(input: StorageActivationInput, deps: StorageActivationDependencies) {
  const ids = [input.identity.sourceDatabaseId, input.identity.targetDatabaseId, input.identity.historyDatabaseId, input.opsDatabaseId];
  if (!ids.every((id) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) || new Set(ids).size !== 4
    || !/^[a-f0-9]{40}$/.test(input.identity.codeRevision)) throw new Error("storage-activate-identity-invalid");
  await deps.assertCheckout();
  let state = await deps.loadState();
  const proofHash = state.proofHash;
  let serving = await deps.inspectServing();
  let github = await deps.verifyGitHub();
  const validateGithub = () => {
    if (![input.identity.sourceDatabaseId, input.identity.targetDatabaseId].includes(github.marketDatabaseId)
      || !["shadow", "active"].includes(github.mode)
      || (github.marketDatabaseId === input.identity.sourceDatabaseId && github.mode === "active")) {
      throw new Error("storage-activate-github-state-conflict");
    }
  };
  validateGithub();
  if (state.run.status === "completed") {
    if (serving.side !== "target" || github.marketDatabaseId !== input.identity.targetDatabaseId || github.mode !== "active") {
      throw new Error("storage-activate-completed-binding-drift");
    }
    await deps.verifyPublicTarget();
    return { status: "already-completed" as const, targetDatabaseId: input.identity.targetDatabaseId, versionId: serving.versionId };
  }
  if (state.activationRecorded && serving.side !== "target") throw new Error("storage-activate-recorded-target-no-longer-serving");
  const recheck = async () => {
    await deps.assertCheckout();
    state = await deps.loadState();
    if (state.run.status !== "awaiting-cutover" || state.proofHash !== proofHash) throw new Error("storage-activate-durable-state-changed");
  };
  await deps.verifyPublications(state);
  await deps.authenticate();
  await recheck();
  github = await deps.verifyGitHub(); validateGithub();
  if (github.marketDatabaseId !== input.identity.targetDatabaseId) {
    await deps.setGitHubVariable("EOD_MARKET_DATABASE_ID", input.identity.targetDatabaseId);
    await deps.journal("github-target-set").catch(() => undefined);
  }
  await recheck();
  github = await deps.verifyGitHub(); validateGithub();
  if (github.marketDatabaseId !== input.identity.targetDatabaseId) throw new Error("storage-activate-github-target-not-persisted");
  if (github.mode !== "active") {
    await deps.setGitHubVariable("EOD_RUNNER_MODE", "active");
    await deps.journal("github-active-set").catch(() => undefined);
  }
  await recheck();
  github = await deps.verifyGitHub();
  if (github.marketDatabaseId !== input.identity.targetDatabaseId || github.mode !== "active") throw new Error("storage-activate-github-not-active");
  const current = await deps.inspectServing();
  if (serving.side === "target" && current.side !== "target") throw new Error("storage-activate-target-regressed");
  serving = current;
  if (serving.side === "source") {
    await deps.verifyPublications(state);
    await recheck();
    await deps.deployTarget(serving);
    await deps.journal("target-deployment-requested").catch(() => undefined);
  }
  serving = await deps.inspectServing();
  if (serving.side !== "target") throw new Error("storage-activate-target-not-serving");
  await deps.verifyPublicTarget();
  await recheck();
  await deps.complete();
  const completed = await deps.loadState();
  if (completed.run.status !== "completed" || !completed.activationRecorded) throw new Error("storage-activate-completion-not-persisted");
  await deps.verifyPublicTarget();
  await deps.journal("completed").catch(() => undefined);
  return { status: "completed" as const, targetDatabaseId: input.identity.targetDatabaseId, versionId: serving.versionId };
}
