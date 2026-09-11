import { storageHash } from "./market-storage-pages";
import type { StorageAcceptanceCapture } from "./market-storage-acceptance";

export type StorageValidationPlanReference = {
  planHash: string; capture: StorageAcceptanceCapture; sourceSnapshotHash: string;
  tickers: readonly string[]; sessionDate: string;
};
type Checkpoint = { inputHash: string; payload: unknown } | null;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const session = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;

/** An older completed bootstrap cannot authorize a newly sized population,
 * even when both populations use the same session and original copy record. */
export async function validateStorageValidationBootstrap(plan: Pick<StorageValidationPlanReference, "planHash" | "sessionDate">, input: {
  complete: Checkpoint; owner: Checkpoint; targetDatabaseId: string; expectedSession: string;
}): Promise<{ runId: string; sessionDate: string; targetDatabaseId: string }> {
  const completed = object(input.complete?.payload), owner = object(input.owner?.payload);
  if (!digest(plan.planHash) || !session(plan.sessionDate) || !session(input.expectedSession) || plan.sessionDate > input.expectedSession
    || input.complete?.inputHash !== plan.planHash || input.owner?.inputHash !== plan.planHash || !completed || !owner
    || await storageHash(completed) !== await storageHash(owner) || completed.targetDatabaseId !== input.targetDatabaseId
    || completed.sessionDate !== plan.sessionDate || completed.runId !== `eod:active:${plan.sessionDate}:daily`) {
    throw new Error("storage-validation-bootstrap-plan-mismatch");
  }
  if (plan.sessionDate < input.expectedSession) throw new Error("storage-validation-bootstrap-latest-session-required");
  return { runId: completed.runId as string, sessionDate: plan.sessionDate, targetDatabaseId: input.targetDatabaseId };
}

/** Plan selection is distinct from acceptance. Final activation and config
 * recording must resolve the exact immutable plan used by the accepted proof,
 * never a newer selected plan or the migration's original ticker manifest. */
export async function assertStorageAcceptedValidationPlan(plan: StorageValidationPlanReference, progressInput: unknown,
  storageProofInput: unknown): Promise<void> {
  const progress = object(progressInput), record = object(storageProofInput), provenance = object(record?.provenance);
  const publications = object(progress?.publications), proof = object(record?.proof);
  const tickerHash = await storageHash([...plan.tickers].sort());
  if (!digest(plan.planHash) || !digest(plan.capture.captureHash) || !digest(plan.sourceSnapshotHash)
    || !plan.tickers.length || new Set(plan.tickers).size !== plan.tickers.length
    || progress?.validationPlanHash !== plan.planHash || provenance?.validationPlanHash !== plan.planHash
    || provenance?.captureHash !== plan.capture.captureHash || provenance?.sourceSnapshotSha256 !== plan.sourceSnapshotHash
    || publications?.tickerHash !== tickerHash || publications?.tickerCount !== plan.tickers.length
    || publications?.sessionDate !== plan.sessionDate || proof?.sessionDate !== plan.sessionDate
    || !digest(record?.proofHash) || record.proofHash !== progress?.cutoverProofHash
    || progress?.storageCutoverProofId !== `storage-cutover-proof:${record.proofHash}`
    || await storageHash(record.proof) !== record.proofHash || await storageHash(provenance) !== record.provenanceHash
    || provenance?.proofHash !== record.proofHash) {
    throw new Error("storage-validation-accepted-plan-mismatch");
  }
}
