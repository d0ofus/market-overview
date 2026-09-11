import { STORAGE_CONSUMER_CONTRACTS, validateStorageConsumerEvidence, type StorageAcceptanceCapture,
  type StorageConsumerEvidence } from "./market-storage-acceptance";
import { loadStorageMigrationCheckpoint, type StorageMigrationRun } from "./market-storage-control";
import { storageHash } from "./market-storage-pages";
import type { StoragePopulationPlan } from "./market-storage-population-plan";

export type StorageCompositeConsumerEvidence = Omit<StorageConsumerEvidence, "version"> & {
  version: 2; policy: "disjoint-population-reader-proofs-v1"; expansionHash: string; composedAt: string;
  baseline: { tickers: string[]; evidence: StorageConsumerEvidence };
  delta: { tickers: string[]; capture: StorageAcceptanceCapture; evidence: StorageConsumerEvidence };
};
export type StorageConsumerProof = StorageConsumerEvidence | StorageCompositeConsumerEvidence;
export const storagePopulationCompositeKey = (hash: string) => `storage-population-composite:${hash}`;
export const storagePopulationExpansionKey = (hash: string) => `storage-population-expansion:${hash}`;
const digest = /^[a-f0-9]{64}$/;
function fail(reason: string): never { throw new Error(`storage-consumer-composite-${reason}`); }
function sorted(values: readonly string[]): string[] {
  if (!Array.isArray(values) || !values.length || values.length > 10_000 || new Set(values).size !== values.length
    || values.some(value => typeof value !== "string" || !/^[A-Z0-9][A-Z0-9.^=/-]{0,39}$/.test(value))) fail("population-invalid");
  return [...values].sort();
}
async function read(ops: D1Database, key: string): Promise<unknown> {
  const text = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(key).first<string>("evidence_json");
  if (!text) fail("record-missing");
  try { return JSON.parse(text) as unknown; } catch { return fail("record-json-invalid"); }
}

/** Each child retains its actual date and capture. This composition is a new
 * proof format, never a manufactured continuation of a v1 rolling hash. */
export async function composeStorageConsumerProof(input: {
  capture: StorageAcceptanceCapture; baselineTickers: readonly string[]; baseline: StorageConsumerEvidence;
  deltaCapture: StorageAcceptanceCapture; addedTickers: readonly string[]; delta: StorageConsumerEvidence;
  expansionHash: string; now?: Date;
}): Promise<StorageCompositeConsumerEvidence> {
  const baseline = sorted(input.baselineTickers), added = sorted(input.addedTickers), baselineSet = new Set(baseline);
  if (added.length > 100 || added.some(ticker => baselineSet.has(ticker)) || !digest.test(input.expansionHash)
    || await storageHash(input.capture.identity) !== await storageHash(input.deltaCapture.identity)
    || await storageHash(input.capture.sourceCapture) !== await storageHash(input.deltaCapture.sourceCapture)
    || input.deltaCapture.targetCapture.schemaHash !== input.capture.targetCapture.schemaHash
    || input.deltaCapture.targetCapture.revision < input.capture.targetCapture.revision
    || input.deltaCapture.historyCapture.revision < input.capture.historyCapture.revision) fail("partition-invalid");
  const tickers = sorted([...baseline, ...added]);
  await validateStorageConsumerEvidence(input.baseline, input.capture, baseline);
  await validateStorageConsumerEvidence(input.delta, input.deltaCapture, added);
  const now = input.now ?? new Date(), times = [input.baseline.completedAt, input.delta.completedAt].map(Date.parse);
  if (times.some(value => !Number.isFinite(value) || value > now.getTime())) fail("child-date-invalid");
  const checks = {} as StorageConsumerEvidence["checks"];
  for (const consumer of STORAGE_CONSUMER_CONTRACTS) {
    const left = input.baseline.checks[consumer], right = input.delta.checks[consumer];
    const observations = left.observations + right.observations;
    if (!Number.isSafeInteger(observations)) fail("count-overflow");
    checks[consumer] = { tickers: tickers.length, observations,
      hash: await storageHash(["disjoint-population-reader-proofs-v1", consumer, left.hash, right.hash]) };
  }
  const sum = (key: keyof StorageConsumerEvidence["history"]) => {
    const left = input.baseline.history[key] ?? 0, right = input.delta.history[key] ?? 0;
    if (![left, right].every(value => Number.isSafeInteger(value) && value >= 0) || left > baseline.length || right > added.length) fail("history-count-invalid");
    return left + right;
  };
  const unsigned = { version: 2 as const, policy: "disjoint-population-reader-proofs-v1" as const,
    expansionHash: input.expansionHash, composedAt: now.toISOString(),
    inputHash: await storageHash(["disjoint-population-reader-proofs-v1", input.expansionHash, input.baseline.inputHash, input.delta.inputHash]),
    tickerHash: await storageHash(tickers), tickerCount: tickers.length, nextTicker: tickers.length,
    outputHash: await storageHash(["disjoint-population-reader-proofs-v1", input.baseline.outputHash, input.delta.outputHash]),
    checks, history: { missing: sum("missing"), shorterThan520: sum("shorterThan520"), shorterThan1330: sum("shorterThan1330"),
      pendingRepair: sum("pendingRepair") },
    // The common rollout reader-age field remains the oldest actual check.
    completedAt: new Date(Math.min(...times)).toISOString(), captureHash: input.capture.captureHash,
    identity: input.capture.identity, readerContractVersion: input.baseline.readerContractVersion,
    baseline: { tickers: baseline, evidence: input.baseline },
    delta: { tickers: added, capture: input.deltaCapture, evidence: input.delta } };
  return { ...unsigned, evidenceHash: await storageHash(unsigned) };
}

export async function validateStorageConsumerComposite(proof: StorageCompositeConsumerEvidence,
  capture: StorageAcceptanceCapture, tickers: readonly string[]): Promise<void> {
  if (proof.version !== 2 || proof.policy !== "disjoint-population-reader-proofs-v1" || !Number.isFinite(Date.parse(proof.composedAt))) fail("format-invalid");
  const actual = await composeStorageConsumerProof({ capture, baselineTickers: proof.baseline.tickers, baseline: proof.baseline.evidence,
    deltaCapture: proof.delta.capture, addedTickers: proof.delta.tickers, delta: proof.delta.evidence,
    expansionHash: proof.expansionHash, now: new Date(proof.composedAt) });
  if (await storageHash(actual) !== await storageHash(proof) || proof.tickerHash !== await storageHash(sorted(tickers))) fail("integrity");
}

/** Composite acceptance additionally requires the immutable operator record.
 * Caller-supplied, self-hashed JSON cannot substitute for that stored evidence. */
export async function validateStorageConsumerProof(proof: StorageConsumerProof, capture: StorageAcceptanceCapture,
  tickers: readonly string[], ops?: D1Database): Promise<void> {
  if (proof.version === 1) return validateStorageConsumerEvidence(proof, capture, tickers);
  await validateStorageConsumerComposite(proof, capture, tickers);
  if (!ops) fail("stored-approval-required");
  const stored = await read(ops, storagePopulationCompositeKey(proof.expansionHash));
  if (await storageHash(stored) !== await storageHash(proof)) fail("stored-proof-mismatch");
  const { validateStoredStoragePopulationExpansionProof } = await import("./market-storage-population-expansion");
  await validateStoredStoragePopulationExpansionProof(ops, proof, capture, tickers);
}

export async function loadStoragePlanConsumerProof(ops: D1Database, run: StorageMigrationRun,
  plan: StoragePopulationPlan): Promise<StorageConsumerProof> {
  let proof: StorageConsumerProof;
  if (plan.populationExpansionHash) {
    proof = await read(ops, storagePopulationCompositeKey(plan.populationExpansionHash)) as StorageCompositeConsumerEvidence;
    if (proof.version !== 2 || proof.expansionHash !== plan.populationExpansionHash) fail("plan-reference-mismatch");
  } else {
    const checkpoint = await loadStorageMigrationCheckpoint(ops, run.id, "consumer-parity:complete");
    if (!checkpoint || checkpoint.inputHash !== plan.capture.captureHash) fail("legacy-proof-missing");
    proof = checkpoint.payload as StorageConsumerEvidence;
  }
  await validateStorageConsumerProof(proof, plan.capture, plan.tickers, ops);
  return proof;
}
