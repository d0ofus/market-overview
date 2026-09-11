import { assessEodMembershipEvidence } from "./eod-membership-evidence";
import { captureOpenStorageDatabase } from "./eod-storage-capacity-renewal";
import type { FrozenInputs } from "./eod-runner";
import { verifyStorageConsumerBatch, type StorageAcceptanceCapture, type StorageConsumerCheckpoint,
  type StorageConsumerEvidence } from "./market-storage-acceptance";
import { composeStorageConsumerProof, loadStoragePlanConsumerProof, storagePopulationCompositeKey,
  storagePopulationExpansionKey, validateStorageConsumerComposite, type StorageCompositeConsumerEvidence } from "./market-storage-consumer-composite";
import { loadStorageMigrationCheckpoint, storageExecutionRevision, storageMigrationIdentity,
  type StorageMigrationRun } from "./market-storage-control";
import { canonicalStorageRows, storageHash, type StorageRow, type StorageTable } from "./market-storage-pages";
import { assertStoragePopulationSizing, loadStorageValidationPlan, type StoragePopulationPlan } from "./market-storage-population-plan";
import type { prepareStoragePreflight } from "./market-storage-preflight";
import { assertStorageVerificationCapture, type StorageVerificationEvidence } from "./market-storage-verification";
import type { Env } from "./types";

type PreparedSizing = Awaited<ReturnType<typeof prepareStoragePreflight>>;
export type StorageExpansionBaseline = { version: 1; migrationId: string; addedTickerHash: string;
  baselineHash: string; baselineCaptureHash: string; pointerRows: number; pointerPages: number;
  pointerHash: string; blockRows: number; blockPages: number; blockHash: string; checkedAt: string; evidenceHash: string };
export type StoragePopulationExpansionRecord = {
  version: 1; policy: "append-only-population-delta-v1"; migrationId: string; codeRevision: string;
  previousPlanHash: string; previousConsumerProofHash: string; previousTickerHash: string;
  addedTickers: string[]; nextTickerHash: string; nextInputsHash: string; sessionDate: string;
  originalCopyCaptureHash: string; sourceSnapshotHash: string; sourceAbsence: StorageExpansionBaseline;
  deltaCapture: StorageAcceptanceCapture; deltaEvidenceHash: string; sizingHash: string;
  createdAt: string; evidenceHash: string;
};
export type PreparedStoragePopulationExpansion = {
  record: StoragePopulationExpansionRecord; plan: StoragePopulationPlan;
  composite: StorageCompositeConsumerEvidence; sizing: { version: 1; planHash: string; prepared: PreparedSizing };
  records: Array<{ id: string; payload: string }>;
};
const digest = /^[a-f0-9]{64}$/;
const pointerTable: StorageTable = { name: "market_history_block_pointers", key: ["feed", "ticker", "calendar_year"],
  columns: ["feed", "ticker", "calendar_year", "block_id", "previous_block_id", "updated_at"], sql: "" };
const blockTable: StorageTable = { name: "market_history_blocks", key: ["id"], columns: ["id", "feed", "ticker", "calendar_year",
  "schema_version", "codec", "checksum", "row_count", "first_date", "last_date", "uncompressed_bytes", "created_at"], sql: "" };
function fail(reason: string): never { throw new Error(`storage-population-expansion-${reason}`); }
const same = async (left: unknown, right: unknown) => await storageHash(left) === await storageHash(right);
function addedPopulation(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100 || new Set(values).size !== values.length
    || values.some(value => typeof value !== "string" || !/^[A-Z0-9][A-Z0-9.^=/-]{0,39}$/.test(value))) fail("delta-population-invalid");
  return [...values].sort();
}
async function read<T>(ops: D1Database, key: string): Promise<T> {
  const text = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(key).first<string>("evidence_json");
  if (!text) fail("record-missing");
  try { return JSON.parse(text) as T; } catch { return fail("record-json-invalid"); }
}
async function checkpoint<T>(ops: D1Database, run: StorageMigrationRun, key: string, inputHash: string): Promise<T> {
  const saved = await loadStorageMigrationCheckpoint(ops, run.id, key);
  if (!saved || saved.inputHash !== inputHash) fail("baseline-checkpoint-missing-or-changed");
  return saved.payload as T;
}

/** Prove the frozen original source is a complete independent reference for
 * this delta. An archived-only observation cannot silently disappear: this
 * narrow path refuses any delta ticker in the original pointer inventory. */
export async function verifyStorageExpansionBaseline(ops: D1Database, run: StorageMigrationRun,
  addedInput: readonly string[], now = new Date()): Promise<StorageExpansionBaseline> {
  const added = addedPopulation(addedInput), identity = storageMigrationIdentity(run);
  type Baseline = { schemaVersion: number; identity: typeof identity; capture: { schemaHash: string; revision: number };
    captureHash: string; blockRows: number; blockPages: number; pointerRows: number; pointerPages: number; hash: string };
  type Cursor = { rows: number; pages: number; done: boolean; hash: string };
  const baseline = await checkpoint<Baseline>(ops, run, "history-baseline:complete", await storageHash([identity, "history-baseline-v1"]));
  const captured = await checkpoint<Baseline["capture"]>(ops, run, "history-baseline:capture", await storageHash([identity, "history-baseline-v1"]));
  const original = await loadStorageMigrationCheckpoint(ops, run.id, "verification:complete");
  const copy = original?.payload as StorageVerificationEvidence | undefined;
  if (!copy || !copy.verified || copy.schemaVersion !== 1 || original?.inputHash !== copy.captureHash
    || !await same(copy.identity, identity) || copy.archive.baselineHash !== baseline.hash
    || copy.archive.baselinePointerRows !== baseline.pointerRows || copy.archive.baselineBlockRows !== baseline.blockRows
    || baseline.schemaVersion !== 1 || !await same(baseline.identity, identity) || !await same(baseline.capture, captured)
    || baseline.captureHash !== await storageHash([identity, baseline.capture, "history-baseline-v1"])
    || !Number.isSafeInteger(baseline.pointerPages) || baseline.pointerPages < 1 || baseline.pointerPages > 200
    || !Number.isSafeInteger(baseline.pointerRows) || baseline.pointerRows < 0 || baseline.pointerRows > 10_000
    || !Number.isSafeInteger(baseline.blockPages) || baseline.blockPages < 1 || baseline.blockPages > 200
    || !Number.isSafeInteger(baseline.blockRows) || baseline.blockRows < 0 || baseline.blockRows > 10_000
    || copy.captureHash !== await storageHash([copy.identity, copy.sourceCapture, copy.targetCapture, copy.historyCapture,
      copy.archive.baselineHash, "verification-v1"])) fail("baseline-integrity");
  const pointers = await checkpoint<Cursor>(ops, run, "history-baseline:pointers:cursor", baseline.captureHash);
  const blocks = await checkpoint<Cursor>(ops, run, "history-baseline:blocks:cursor", baseline.captureHash);
  if (!pointers.done || pointers.rows !== baseline.pointerRows || pointers.pages !== baseline.pointerPages
    || !blocks.done || blocks.rows !== baseline.blockRows || blocks.pages !== baseline.blockPages
    || !digest.test(blocks.hash) || baseline.hash !== await storageHash([
      { rows: blocks.rows, hash: blocks.hash }, { rows: pointers.rows, hash: pointers.hash }])) fail("baseline-manifest-mismatch");
  let rows = 0, hash = await storageHash([]), previousKey = "";
  const excluded = new Set(added);
  for (let page = 0; page < baseline.pointerPages; page++) {
    const values = await checkpoint<StorageRow[]>(ops, run, `history-baseline:pointers:page:${page}`, baseline.captureHash);
    if (!Array.isArray(values) || values.length > 50 || (page < baseline.pointerPages - 1 && values.length !== 50)) fail("baseline-page-invalid");
    for (const value of values) {
      const key = JSON.stringify([value.feed, value.ticker, value.calendar_year]);
      if (typeof value.ticker !== "string" || typeof value.feed !== "string" || !Number.isSafeInteger(value.calendar_year)
        || (previousKey && key <= previousKey)) fail("baseline-pointer-order-invalid");
      if (excluded.has(value.ticker)) fail("original-archive-reference-required");
      previousKey = key;
    }
    hash = await storageHash([hash, canonicalStorageRows(pointerTable, values)]); rows += values.length;
  }
  if (rows !== pointers.rows || hash !== pointers.hash) fail("baseline-pointer-hash-mismatch");
  let blockRows = 0, blockHash = await storageHash([]), previousId = "";
  for (let page = 0; page < baseline.blockPages; page++) {
    const values = await checkpoint<StorageRow[]>(ops, run, `history-baseline:blocks:page:${page}`, baseline.captureHash);
    if (!Array.isArray(values) || values.length > 50 || (page < baseline.blockPages - 1 && values.length !== 50)) fail("baseline-page-invalid");
    for (const value of values) {
      if (typeof value.id !== "string" || !value.id || (previousId && value.id <= previousId)
        || typeof value.ticker !== "string") fail("baseline-block-order-invalid");
      if (excluded.has(value.ticker)) fail("original-archive-reference-required");
      previousId = value.id;
    }
    blockHash = await storageHash([blockHash, canonicalStorageRows(blockTable, values)]); blockRows += values.length;
  }
  if (blockRows !== blocks.rows || blockHash !== blocks.hash) fail("baseline-block-hash-mismatch");
  const unsigned = { version: 1 as const, migrationId: run.id, addedTickerHash: await storageHash(added),
    baselineHash: baseline.hash, baselineCaptureHash: baseline.captureHash, pointerRows: rows,
    pointerPages: baseline.pointerPages, pointerHash: hash, blockRows, blockPages: baseline.blockPages, blockHash, checkedAt: now.toISOString() };
  return { ...unsigned, evidenceHash: await storageHash(unsigned) };
}

export async function verifyStoragePopulationDelta(input: {
  ops: D1Database; run: StorageMigrationRun; previousPlan: StoragePopulationPlan;
  sourceEnv: Env; targetEnv: Env; capture: StorageAcceptanceCapture; addedTickers: readonly string[];
  assertCapture: () => Promise<void>; checkpoint?: StorageConsumerCheckpoint; maxTickers?: number;
}) {
  const added = addedPopulation(input.addedTickers), source = input.sourceEnv.MARKET_DATA_DB ?? input.sourceEnv.DB;
  const target = input.targetEnv.MARKET_DATA_DB, history = input.targetEnv.MARKET_HISTORY_DB;
  if (!target || !history || source === target || input.sourceEnv.MARKET_HISTORY_DB
    || !await same(input.capture.identity, storageMigrationIdentity(input.run))
    || !await same(input.capture.sourceCapture, input.previousPlan.capture.sourceCapture)
    || added.some(ticker => input.previousPlan.tickers.includes(ticker))) fail("delta-bindings-or-capture");
  const { captureHash, ...fields } = input.capture;
  if (captureHash !== await storageHash(fields)) fail("delta-capture-hash");
  await verifyStorageExpansionBaseline(input.ops, input.run, added);
  const assertCapture = async () => {
    await input.assertCapture();
    await assertStorageVerificationCapture(source, input.capture.identity, input.capture.sourceCapture);
    const [market, archive] = await Promise.all([captureOpenStorageDatabase(target), captureOpenStorageDatabase(history)]);
    if (!await same(market, input.capture.targetCapture) || !await same(archive, input.capture.historyCapture)) fail("delta-capture-changed");
  };
  return verifyStorageConsumerBatch({ sourceEnv: { ...input.sourceEnv, MARKET_DATA_DB: source, MARKET_HISTORY_DB: undefined },
    targetEnv: input.targetEnv, capture: input.capture, tickers: added, calendarDates: input.previousPlan.calendarDates,
    checkpoint: input.checkpoint, maxTickers: input.maxTickers ?? 10, assertCapture });
}

async function cleanPlan(ops: D1Database, value: StoragePopulationPlan): Promise<StoragePopulationPlan> {
  const { bootstrapInputs, sizingHash, ...plan } = value as StoragePopulationPlan & { bootstrapInputs?: unknown; sizingHash?: unknown };
  const { planHash, ...unsigned } = plan;
  if (!digest.test(planHash) || await storageHash(unsigned) !== planHash) fail("plan-integrity");
  if (bootstrapInputs !== undefined || sizingHash !== undefined) {
    const sizing = await read<{ prepared: PreparedSizing }>(ops, `storage-population-sizing:${planHash}`);
    if (!await same(bootstrapInputs, plan.inputs) || sizingHash !== sizing.prepared.hash) fail("derived-plan-mismatch");
  }
  return plan;
}

export async function prepareStoragePopulationExpansion(input: {
  ops: D1Database; run: StorageMigrationRun; previousPlan: StoragePopulationPlan; nextInputs: FrozenInputs;
  deltaCapture: StorageAcceptanceCapture; deltaEvidence: StorageConsumerEvidence; preparedSizing: PreparedSizing; now?: Date;
}): Promise<PreparedStoragePopulationExpansion> {
  const { ops, run } = input, now = input.now ?? new Date(), previous = await cleanPlan(ops, input.previousPlan);
  const current = await cleanPlan(ops, await loadStorageValidationPlan(ops, run));
  if (current.planHash !== previous.planHash || previous.populationExpansionHash || previous.codeRevision !== storageExecutionRevision(run)) fail("previous-plan-mismatch");
  const tickers = [...input.nextInputs.tickers].sort(), prior = new Set(previous.tickers), session = input.nextInputs.calendarDates.at(-1);
  const added = addedPopulation(tickers.filter(ticker => !prior.has(ticker)));
  if (!session || session <= previous.sessionDate || new Set(tickers).size !== tickers.length || tickers.length > 10_000
    || previous.tickers.some(ticker => !tickers.includes(ticker)) || !await same(previous.inputs.config, input.nextInputs.config)
    || previous.inputs.methodologyVersion !== input.nextInputs.methodologyVersion || input.nextInputs.memberships.length !== 5
    || new Set(input.nextInputs.memberships.map(row => row.universeId)).size !== 5
    || input.nextInputs.memberships.some(row => !assessEodMembershipEvidence(row, session, input.nextInputs.calendarDates, now).publishable
      || row.members.some(ticker => !tickers.includes(ticker)))) fail("append-inputs-invalid");
  const base = await loadStoragePlanConsumerProof(ops, run, previous);
  if (base.version !== 1) fail("nested-expansion-not-supported");
  const sourceAbsence = await verifyStorageExpansionBaseline(ops, run, added, now);
  const unsigned = { version: 1 as const, policy: "append-only-population-delta-v1" as const,
    migrationId: run.id, codeRevision: storageExecutionRevision(run), previousPlanHash: previous.planHash,
    previousConsumerProofHash: base.evidenceHash, previousTickerHash: await storageHash(previous.tickers), addedTickers: added,
    nextTickerHash: await storageHash(tickers), nextInputsHash: await storageHash(input.nextInputs), sessionDate: session,
    originalCopyCaptureHash: previous.originalCopyCaptureHash, sourceSnapshotHash: previous.sourceSnapshotHash,
    sourceAbsence, deltaCapture: input.deltaCapture, deltaEvidenceHash: input.deltaEvidence.evidenceHash,
    sizingHash: input.preparedSizing.hash, createdAt: now.toISOString() };
  const record = { ...unsigned, evidenceHash: await storageHash(unsigned) };
  const { planHash: _oldHash, ...old } = previous;
  const next = { ...old, inputs: input.nextInputs, tickers, sessionDate: session, createdAt: record.createdAt,
    predecessorPlanHash: previous.planHash, populationExpansionHash: record.evidenceHash };
  const plan = { ...next, planHash: await storageHash(next) };
  const sizing = { version: 1 as const, planHash: plan.planHash, prepared: input.preparedSizing };
  await assertStoragePopulationSizing(run, plan, sizing);
  const composite = await composeStorageConsumerProof({ capture: previous.capture, baselineTickers: previous.tickers, baseline: base,
    deltaCapture: input.deltaCapture, addedTickers: added, delta: input.deltaEvidence, expansionHash: record.evidenceHash, now });
  return { record, plan, composite, sizing, records: [
    { id: storagePopulationExpansionKey(record.evidenceHash), payload: JSON.stringify(record) },
    { id: storagePopulationCompositeKey(record.evidenceHash), payload: JSON.stringify(composite) },
    { id: `storage-population-plan:${run.id}:${plan.planHash}`, payload: JSON.stringify(plan) },
    { id: `storage-population-sizing:${plan.planHash}`, payload: JSON.stringify(sizing) },
  ] };
}

export async function validateStoredStoragePopulationExpansionProof(ops: D1Database, proof: StorageCompositeConsumerEvidence,
  capture: StorageAcceptanceCapture, tickers: readonly string[]): Promise<StoragePopulationExpansionRecord> {
  const record = await read<StoragePopulationExpansionRecord>(ops, storagePopulationExpansionKey(proof.expansionHash));
  const { evidenceHash, ...unsigned } = record;
  const { evidenceHash: absenceHash, ...absence } = record.sourceAbsence;
  const { captureHash, ...captureFields } = record.deltaCapture;
  if (record.version !== 1 || record.policy !== "append-only-population-delta-v1" || evidenceHash !== proof.expansionHash
    || await storageHash(unsigned) !== evidenceHash || record.migrationId !== capture.identity.id
    || record.nextTickerHash !== await storageHash([...tickers].sort()) || record.previousTickerHash !== await storageHash(proof.baseline.tickers)
    || record.previousConsumerProofHash !== proof.baseline.evidence.evidenceHash || record.deltaEvidenceHash !== proof.delta.evidence.evidenceHash
    || !await same(record.addedTickers, proof.delta.tickers) || !await same(record.deltaCapture, proof.delta.capture)
    || captureHash !== await storageHash(captureFields) || record.createdAt !== proof.composedAt
    || absenceHash !== await storageHash(absence) || record.sourceAbsence.migrationId !== record.migrationId
    || record.sourceAbsence.addedTickerHash !== await storageHash(record.addedTickers)
    || !/^[a-f0-9]{40}$/.test(record.codeRevision)
    || [record.previousPlanHash, record.previousTickerHash, record.nextTickerHash, record.nextInputsHash,
      record.originalCopyCaptureHash, record.sourceSnapshotHash, record.sizingHash].some(value => !digest.test(value))
    || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.sourceAbsence.checkedAt))
    || Date.parse(record.sourceAbsence.checkedAt) > Date.parse(record.createdAt)) fail("stored-proof-integrity");
  await validateStorageConsumerComposite(proof, capture, tickers);
  const parent = await cleanPlan(ops, await read<StoragePopulationPlan>(ops,
    `storage-population-plan:${record.migrationId}:${record.previousPlanHash}`));
  const original = await loadStorageMigrationCheckpoint(ops, record.migrationId, "consumer-parity:complete");
  if (parent.planHash !== record.previousPlanHash || parent.codeRevision !== record.codeRevision || parent.populationExpansionHash
    || parent.originalCopyCaptureHash !== record.originalCopyCaptureHash || parent.sourceSnapshotHash !== record.sourceSnapshotHash
    || !await same(parent.capture, capture) || !await same(parent.tickers, proof.baseline.tickers)
    || !original || original.inputHash !== capture.captureHash || !await same(original.payload, proof.baseline.evidence)) fail("stored-baseline-mismatch");
  return record;
}

export async function validateStoragePopulationExpansionLineage(ops: D1Database, run: StorageMigrationRun,
  childInput: StoragePopulationPlan, parentInput: StoragePopulationPlan): Promise<void> {
  const child = await cleanPlan(ops, childInput), parent = await cleanPlan(ops, parentInput);
  if (!child.populationExpansionHash || parent.populationExpansionHash || child.predecessorPlanHash !== parent.planHash
    || child.codeRevision !== parent.codeRevision || child.codeRevision !== storageExecutionRevision(run)
    || child.sessionDate <= parent.sessionDate || !await same(child.capture, parent.capture)
    || !await same(child.calendarDates, parent.calendarDates) || child.sourceSnapshotHash !== parent.sourceSnapshotHash
    || child.sourcePreflightHash !== parent.sourcePreflightHash || child.originalCopyCaptureHash !== parent.originalCopyCaptureHash
    || !await same(child.inputs.config, parent.inputs.config)) fail("lineage-mismatch");
  const proof = await read<StorageCompositeConsumerEvidence>(ops, storagePopulationCompositeKey(child.populationExpansionHash));
  const record = await validateStoredStoragePopulationExpansionProof(ops, proof, child.capture, child.tickers);
  if (record.previousPlanHash !== parent.planHash || record.nextInputsHash !== await storageHash(child.inputs)
    || record.codeRevision !== child.codeRevision || record.sessionDate !== child.sessionDate || record.createdAt !== child.createdAt
    || record.originalCopyCaptureHash !== child.originalCopyCaptureHash || record.sourceSnapshotHash !== child.sourceSnapshotHash
    || !await same(proof.baseline.tickers, parent.tickers)) fail("lineage-record-mismatch");
  const base = await loadStoragePlanConsumerProof(ops, run, parent);
  if (base.evidenceHash !== record.previousConsumerProofHash) fail("lineage-baseline-mismatch");
  const sizing = await read<{ version: 1; planHash: string; prepared: PreparedSizing }>(ops, `storage-population-sizing:${child.planHash}`);
  await assertStoragePopulationSizing(run, child, sizing);
  if (sizing.prepared.hash !== record.sizingHash) fail("lineage-sizing-mismatch");
}

/** Later same-union sessions may inherit the explicit expansion, but their
 * predecessor hashes cannot disguise a second unmeasured population change. */
export async function validateStoragePopulationExpansionPlan(ops: D1Database, run: StorageMigrationRun,
  value: StoragePopulationPlan): Promise<void> {
  let child = await cleanPlan(ops, value);
  const expansionHash = child.populationExpansionHash;
  if (!expansionHash || !digest.test(expansionHash)) fail("lineage-reference-missing");
  for (let depth = 0; depth < 32; depth++) {
    if (!child.predecessorPlanHash) fail("lineage-predecessor-missing");
    const parent = await cleanPlan(ops, await read<StoragePopulationPlan>(ops,
      `storage-population-plan:${run.id}:${child.predecessorPlanHash}`));
    if (!parent.populationExpansionHash) return validateStoragePopulationExpansionLineage(ops, run, child, parent);
    if (child.predecessorPlanHash !== parent.planHash || parent.populationExpansionHash !== expansionHash
      || child.populationExpansionHash !== expansionHash || parent.codeRevision !== child.codeRevision
      || child.codeRevision !== storageExecutionRevision(run) || parent.sessionDate >= child.sessionDate
      || !await same(parent.tickers, child.tickers) || !await same(parent.capture, child.capture)
      || !await same(parent.calendarDates, child.calendarDates) || parent.sourceSnapshotHash !== child.sourceSnapshotHash
      || parent.sourcePreflightHash !== child.sourcePreflightHash || parent.originalCopyCaptureHash !== child.originalCopyCaptureHash) fail("lineage-successor-mismatch");
    child = parent;
  }
  fail("lineage-too-deep");
}
