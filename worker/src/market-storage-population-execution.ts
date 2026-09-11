import { storageFeatureCheckpointComparison, assertStorageAtomicParameters } from "./market-storage-atomic-manifest";
import { z } from "zod";
import { storageHash } from "./market-storage-pages";
import { loadStorageMigration, storageMigrationIdentity, type StorageMigrationRun } from "./market-storage-control";
import { assertStorageExecutionRevision, storageExecutionKey, type StorageExecutionRecord } from "./market-storage-execution";
import { loadStorageValidationPlan, type StoragePopulationPlan } from "./market-storage-population-plan";
import { loadStorageHistoryIndexAmendment } from "./market-storage-history-index-recovery";
import { storageVixContinuationKey } from "./market-storage-vix-continuation";
import { validateStoragePopulationExpansionLineage } from "./market-storage-population-expansion";
import { assertStorageVerificationCapture, inspectStorageHistoryPointerIndexSchema, releaseStorageVerificationFence,
  releaseStorageHistoryVerificationFence } from "./market-storage-verification";
import { validateStorageConsumerEvidence, type StorageConsumerEvidence } from "./market-storage-acceptance";
import { EOD_PUBLICATION_SCOPES } from "./eod-publication-scopes";
import { EOD_CATALOG_SCOPE } from "./eod-catalog-service";
import { decodeEodPayload } from "./eod-publication-codec";

export const STORAGE_POPULATION_EXECUTION_PREVIOUS_REVISION = "d7a95ec213bf1fb2309f1a582d226c3239a2f4e6";
const hash = z.string().regex(/^[a-f0-9]{64}$/), sha = z.string().regex(/^[a-f0-9]{40}$/);
const codeSchema = z.object({ version: z.literal(1), policy: z.literal("append-only-population-contracts-v1"),
  fromRevision: z.literal(STORAGE_POPULATION_EXECUTION_PREVIOUS_REVISION), codeRevision: sha,
  protectedFileCount: z.number().int().min(4), protectedManifestHash: hash, integrationContractHash: hash,
  reviewedChangesHash: hash, beforeTreeHash: hash, afterTreeHash: hash, evidenceHash: hash }).strict();
export type StoragePopulationExecutionCodeContract = z.infer<typeof codeSchema>;
type Checkpoint = { checkpoint_key: string; input_hash: string; payload_json: string; updated_at: string };
type FeatureCheckpoint = { run_id: string; chunk_key: string; input_hash: string; payload_json: string; updated_at: string };
type EodRow = Record<string, string | number | null> & { id: string; input_json: string; progress_json: string; updated_at: string };
type Publication = { id: string; scope: string; session_date: string; status: string; payload_json: string;
  payload_checksum: string; payload_codec: string | null; payload_base64: string | null };
export type StoragePopulationResumeBoundary={status:"queued"|"retrying";errorCode:string|null;nextAttemptAt:string};
export function storagePopulationExecutionBoundary(run:Pick<StorageMigrationRun,"status"|"stage"|"error_code"|"next_attempt_at"|"updated_at">,
  eod:EodRow,progress:Record<string,unknown>,population:number,now:Date):{kind:"prices"|"publication"|"incomplete";resume:StoragePopulationResumeBoundary} {
  const total=Math.ceil(population/25),next=Date.parse(String(eod.next_attempt_at)),updated=Date.parse(String(eod.updated_at)),
    migrationNext=Date.parse(String(run.next_attempt_at)),migrationUpdated=Date.parse(run.updated_at);
  if(eod.status!=="retrying"||eod.mode!=="active"||eod.purpose!=="daily"||!Number.isFinite(next)||!Number.isFinite(updated)||updated>now.getTime()
    ||!Number.isFinite(migrationNext)||!Number.isFinite(migrationUpdated)||migrationUpdated>now.getTime())fail("planned-slice-required");
  const planned=run.status==="queued"&&run.error_code===null&&migrationNext<=now.getTime()&&next<=now.getTime()
    &&eod.error_code==="runner-error"&&eod.error_message==="storage-run-time-slice-complete";
  let kind:"prices"|"publication"|"incomplete";
  if(planned&&eod.stage==="prices"&&progress.total===total&&Number.isSafeInteger(progress.chunk)&&Number(progress.chunk)>=0
    &&Number(progress.chunk)<total&&Number.isSafeInteger(progress.symbols)&&Number(progress.symbols)>=0&&Number(progress.symbols)<=population)kind="prices";
  else if(planned&&eod.stage==="publication"&&progress.symbols===population)kind="publication";
  else if(run.status==="retrying"&&run.error_code==="storage-bootstrap-incomplete"&&migrationNext-migrationUpdated===900_000
    &&eod.stage==="finished"&&eod.error_code==="incomplete-publication"&&next-updated>=900_000&&next-updated<=901_000
    &&eod.completed_at===null&&eod.completed_input_clock===null&&progress.symbols===population
    &&Array.isArray(progress.published)&&progress.published.length<6&&new Set(progress.published).size===progress.published.length
    &&progress.published.every(value=>typeof value==="string")&&typeof progress.catalogPublicationId==="string")kind="incomplete";
  else return fail("planned-slice-required");
  return {kind,resume:{status:run.status as "queued"|"retrying",errorCode:run.error_code,nextAttemptAt:run.next_attempt_at!}};
}

type Pointer = { scope: string; publication_id: string; session_date: string; published_at: string };
export type StoragePopulationExecutionContinuation = { version: 1; policy: "preserve-bootstrap-population-contracts-v1"; migrationId: string;
  fromRevision: string; codeRevision: string; previousPlanHash: string; planHash: string; previousExecutionHash: string;
  executionHash: string; predecessorAuditHash: string; amendmentHash: string; codeContract: StoragePopulationExecutionCodeContract;
  checkpointManifestHash: string; originalOwner: Checkpoint; eodRunHash: string; featureCheckpointCount: number;
  featureCheckpointManifestHash: string;
  publicationManifestHash: string; publications: Array<{ pointer: Pointer; rowHash: string }>;
  targetRevision: number; inputClock: number; historyRevision: number;
  resumeBoundary:StoragePopulationResumeBoundary;
  physical: { targetBytes: number; historyBytes: number; measuredAt: string }; approvedAt: string; evidenceHash: string };
export const storagePopulationExecutionKey = (id: string, revision: string) => `storage-population-execution:${id}:${revision}`;
const read = (ops: D1Database, id: string) => ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(id).first<string>("evidence_json");
function fail(reason: string): never { throw new Error(`storage-population-execution-${reason}`); }
function parse<T>(text: string | null): T { try { if (!text) fail("record-missing"); return JSON.parse(text) as T; } catch { fail("record-invalid"); } }
const same = async (a: unknown, b: unknown) => await storageHash(a) === await storageHash(b);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
async function verified<T extends { evidenceHash: string }>(value: T): Promise<T> {
  const { evidenceHash, ...fields } = value;
  if (!hash.safeParse(evidenceHash).success || await storageHash(fields) !== evidenceHash) fail("record-integrity");
  return value;
}

/** Authenticate R18 against its actual R17 predecessor. Existing loaders then
 * authenticate the immutable R17/R16/R15/R14 chain. Future population links need
 * their own separately dated append-only proof; no original evidence is redated. */
export async function loadStoragePopulationExecution(ops: D1Database, run: StorageMigrationRun, plan: StoragePopulationPlan): Promise<{
  previousRun: StorageMigrationRun; previousPlan: StoragePopulationPlan; amendmentHash: string;
} | null> {
  const text = await read(ops, storagePopulationExecutionKey(run.id, plan.codeRevision));
  if (!text) return null;
  const record = await verified(parse<StoragePopulationExecutionContinuation>(text)), execution = await assertStorageExecutionRevision(ops, run, plan.codeRevision);
  if (record.version !== 1 || record.policy !== "preserve-bootstrap-population-contracts-v1" || record.migrationId !== run.id
    || record.fromRevision !== STORAGE_POPULATION_EXECUTION_PREVIOUS_REVISION || record.codeRevision !== plan.codeRevision || !execution
    || record.executionHash !== execution.evidenceHash || execution.fromRevision !== record.fromRevision
    || execution.predecessorHash !== record.previousExecutionHash || !codeSchema.safeParse(record.codeContract).success) fail("execution-mismatch");
  await verified(record.codeContract);
  if (record.codeContract.codeRevision !== plan.codeRevision || record.codeContract.fromRevision !== record.fromRevision) fail("code-contract-invalid");
  const previousRun = { ...run, execution_revision: record.fromRevision, execution_evidence_hash: record.previousExecutionHash };
  await assertStorageExecutionRevision(ops, previousRun, record.fromRevision);
  const predecessor = await verified(parse<{ evidenceHash: string }>(await read(ops, storageVixContinuationKey(run.id, record.fromRevision))));
  if (predecessor.evidenceHash !== record.predecessorAuditHash) fail("predecessor-audit-mismatch");
  let selected = plan;
  for (let depth = 0; selected.planHash !== record.planHash; depth++) {
    if (depth >= 32 || !selected.predecessorPlanHash) fail("plan-lineage-missing");
    const parent = parse<StoragePopulationPlan>(await read(ops, `storage-population-plan:${run.id}:${selected.predecessorPlanHash}`));
    const { planHash: childHash, ...childFields } = selected, { planHash: parentHash, ...parentFields } = parent;
    if (selected.populationExpansionHash && selected.populationExpansionHash !== parent.populationExpansionHash) {
      await validateStoragePopulationExpansionLineage(ops, run, selected, parent);
    } else {
      if (await storageHash(childFields) !== childHash || await storageHash(parentFields) !== parentHash || parentHash !== selected.predecessorPlanHash
        || parent.codeRevision !== plan.codeRevision || selected.codeRevision !== plan.codeRevision || parent.sessionDate >= selected.sessionDate
        || !await same(parent.capture, selected.capture) || !await same(parent.tickers, selected.tickers) || !await same(parent.calendarDates, selected.calendarDates)
        || parent.sourceSnapshotHash !== selected.sourceSnapshotHash || parent.sourcePreflightHash !== selected.sourcePreflightHash
        || parent.originalCopyCaptureHash !== selected.originalCopyCaptureHash) fail("plan-lineage-mismatch");
    }
    selected = parent;
  }
  const previousPlan = parse<StoragePopulationPlan>(await read(ops, `storage-population-plan:${run.id}:${record.previousPlanHash}`));
  const { planHash: oldHash, ...oldFields } = previousPlan, { planHash: currentHash, ...currentFields } = selected;
  if (oldHash !== record.previousPlanHash || await storageHash(oldFields) !== oldHash || await storageHash(currentFields) !== currentHash
    || previousPlan.codeRevision !== record.fromRevision
    || !await same({ ...oldFields, codeRevision: plan.codeRevision, predecessorPlanHash: oldHash, createdAt: selected.createdAt }, currentFields)
    || record.originalOwner.checkpoint_key !== "bootstrap:owner" || record.originalOwner.input_hash !== oldHash) fail("plan-integrity");
  return { previousRun, previousPlan, amendmentHash: record.amendmentHash };
}

export type StoragePopulationExecutionApprovalInput = { ops: D1Database; source: D1Database; target: D1Database; history: D1Database;
  migrationId: string; fromRevision: string; codeRevision: string; expectedPlanHash: string; changedFiles: string[]; diffHash: string;
  codeContract: StoragePopulationExecutionCodeContract; assertReviewedCheckout: () => Promise<void>; assertNoWorkflowWriters: () => Promise<void>;
  measurePhysical: () => Promise<{ targetBytes: number; historyBytes: number; measuredAt: string }>; now?: Date;
};
/** Code admission only: no new members, price writes, feature invalidation or
 * population-proof promotion. Expansion needs its independent completed-run proof. */
export async function approveStoragePopulationExecution(input: StoragePopulationExecutionApprovalInput): Promise<{
  execution: StorageExecutionRecord; plan: StoragePopulationPlan; continuation: StoragePopulationExecutionContinuation;
}> {
  const now = input.now ?? new Date(), stamp = now.toISOString(), ops = input.ops, parsed = codeSchema.safeParse(input.codeContract);
  if (!parsed.success || input.fromRevision !== STORAGE_POPULATION_EXECUTION_PREVIOUS_REVISION || parsed.data.codeRevision !== input.codeRevision
    || input.codeRevision === input.fromRevision || !hash.safeParse(input.diffHash).success || !hash.safeParse(input.expectedPlanHash).success
    || !input.changedFiles.includes("worker/src/market-storage-population-expansion.ts")) fail("code-contract-invalid");
  await verified(parsed.data); await input.assertReviewedCheckout(); await input.assertNoWorkflowWriters();
  const run = await loadStorageMigration(ops, input.migrationId);
  if (!run) fail("migration-missing");
  if (run.execution_revision === input.codeRevision) {
    const { bootstrapInputs: _derived, sizingHash: _size, ...plan } = await loadStorageValidationPlan(ops, run);
    const continuation = await verified(parse<StoragePopulationExecutionContinuation>(await read(ops, storagePopulationExecutionKey(run.id, input.codeRevision))));
    const execution = await assertStorageExecutionRevision(ops, run, input.codeRevision);
    if (!execution || execution.diffHash !== input.diffHash || continuation.previousPlanHash !== input.expectedPlanHash
      || !await same(continuation.codeContract, input.codeContract)) fail("replay-conflict");
    const amendment = await loadStorageHistoryIndexAmendment(ops, run, plan);
    if (!amendment) fail("original-amendment-missing");
    await assertStorageVerificationCapture(input.source, storageMigrationIdentity(run), plan.capture.sourceCapture);
    await releaseStorageVerificationFence(input.target, storageMigrationIdentity(run), plan.capture.targetCapture);
    await releaseStorageHistoryVerificationFence(input.history, storageMigrationIdentity(run), plan.capture.historyCapture, amendment);
    return { execution, plan, continuation };
  }
  if (!["queued","retrying"].includes(run.status) || run.stage !== "bootstrap" || run.freeze_authorized !== 1
    || !run.freeze_evidence_hash || run.dispatch_token !== null || run.lease_token !== null || run.lease_until !== null
    || !run.next_attempt_at || !Number.isFinite(Date.parse(run.next_attempt_at))) fail("released-bootstrap-slice-required");
  const priorExecution = await assertStorageExecutionRevision(ops, run, input.fromRevision);
  if (!priorExecution) fail("prior-execution-required");
  const { bootstrapInputs: _derived, sizingHash: _size, ...previous } = await loadStorageValidationPlan(ops, run);
  if (previous.planHash !== input.expectedPlanHash) fail("selected-plan-mismatch");
  const predecessorText = await read(ops, storageVixContinuationKey(run.id, input.fromRevision));
  const predecessor = await verified(parse<{ evidenceHash: string; originalOwner: Checkpoint }>(predecessorText));
  const amendment = await loadStorageHistoryIndexAmendment(ops, run, previous);
  if (!amendment) fail("original-amendment-missing");
  const eod = await ops.prepare("SELECT * FROM eod_runs WHERE id=?").bind(`eod:active:${previous.sessionDate}:daily`).first<EodRow>();
  const progress = eod ? object(parse(eod.progress_json)) : null, total = Math.ceil(previous.inputs.tickers.length / 25);
  if(!eod||eod.session_date!==previous.sessionDate||eod.lease_token!==null||eod.lease_until!==null||eod.dispatch_token!==null||!progress
    ||!await same(parse(eod.input_json),previous.inputs))fail("planned-slice-required");
  const boundary=storagePopulationExecutionBoundary(run,eod,progress,previous.tickers.length,now);
  const checkpoints = (await ops.prepare("SELECT checkpoint_key,input_hash,payload_json,updated_at FROM market_storage_checkpoints WHERE migration_id=? ORDER BY checkpoint_key LIMIT 129")
    .bind(run.id).all<Checkpoint>()).results, owner = checkpoints.find(row => row.checkpoint_key === "bootstrap:owner");
  if (checkpoints.length > 128 || !owner || owner.input_hash !== previous.planHash
    || checkpoints.some(row => row.checkpoint_key.startsWith("bootstrap") && row.checkpoint_key !== "bootstrap:owner")
    || !await same(parse(owner.payload_json), { runId: eod.id, sessionDate: previous.sessionDate, targetDatabaseId: run.target_database_id })) fail("owner-or-checkpoints-changed");
  const consumers = checkpoints.find(row => row.checkpoint_key === "consumer-parity:complete");
  if (!consumers || consumers.input_hash !== previous.capture.captureHash) fail("consumer-proof-missing");
  await validateStorageConsumerEvidence(parse<StorageConsumerEvidence>(consumers.payload_json), previous.capture, previous.tickers);
  const originalCheckpoints = checkpoints.map(row => row.checkpoint_key === "bootstrap:owner" ? predecessor.originalOwner : row);
  if (originalCheckpoints.length !== priorExecution.checkpointCount || await storageHash(originalCheckpoints) !== priorExecution.checkpointManifestHash) fail("original-checkpoint-manifest-changed");
  const features = (await ops.prepare("SELECT run_id,chunk_key,input_hash,payload_json,updated_at FROM eod_checkpoints WHERE run_id=? ORDER BY chunk_key LIMIT 401")
    .bind(eod.id).all<FeatureCheckpoint>()).results;
  if (!features.length || features.length > Math.min(400, total) || features.some(row => row.run_id !== eod.id
    || !/^features:(0|[1-9]\d*)$/.test(row.chunk_key) || Number(row.chunk_key.slice(9)) >= total || !hash.safeParse(row.input_hash).success)) fail("feature-checkpoint-bound");
  if(boundary.kind!=="prices"&&features.length!==total)fail("finished-checkpoint-manifest-incomplete");
  const publicationSnapshot = async () => {
    const pointers = (await input.target.prepare("SELECT scope,publication_id,session_date,published_at FROM eod_publication_pointers WHERE scope IN (SELECT value FROM json_each(?)) ORDER BY scope")
      .bind(JSON.stringify([...EOD_PUBLICATION_SCOPES, EOD_CATALOG_SCOPE])).all<Pointer>()).results;
    if (!pointers.some(row => row.scope === "overview:default") || pointers.length > 7) fail("accepted-overview-required");
    const values: StoragePopulationExecutionContinuation["publications"] = [];
    for (const pointer of pointers) {
      const row = await input.target.prepare("SELECT * FROM eod_publications WHERE id=?").bind(pointer.publication_id).first<Publication>();
      if (!row || row.id !== pointer.publication_id || row.scope !== pointer.scope || row.session_date !== previous.sessionDate
        || pointer.session_date !== row.session_date || row.status !== "accepted") fail("publication-integrity");
      const payload = await decodeEodPayload({ payload: row.payload_json, payloadCodec: row.payload_codec, payloadBase64: row.payload_base64 });
      if (await storageHash(payload) !== row.payload_checksum) fail("publication-checksum");
      if (row.scope === "overview:default" && !Array.isArray(object(payload)?.sections)) fail("overview-payload-invalid");
      values.push({ pointer, rowHash: await storageHash(row) });
    }
    if(boundary.kind==="incomplete"&&(!values.some(value=>value.pointer.scope===EOD_CATALOG_SCOPE&&value.pointer.publication_id===progress.catalogPublicationId)
      ||(progress.published as string[]).some(id=>!values.some(value=>value.pointer.scope!==EOD_CATALOG_SCOPE&&value.pointer.publication_id===id))))fail("finished-publication-manifest-mismatch");
    return values;
  };
  const proveUnchanged = async () => {
    await input.assertNoWorkflowWriters();
    if (await ops.prepare(`SELECT 1 AS unsafe WHERE EXISTS(SELECT 1 FROM eod_runs WHERE lease_until>?)
      OR EXISTS(SELECT 1 FROM market_storage_migrations WHERE lease_until>? OR status IN ('dispatching','dispatched')
        OR (dispatch_token IS NOT NULL AND status NOT IN ('completed','aborted')))` ).bind(stamp, stamp).first()) fail("writer-present");
    await assertStorageVerificationCapture(input.source, storageMigrationIdentity(run), previous.capture.sourceCapture);
    await releaseStorageVerificationFence(input.target, storageMigrationIdentity(run), previous.capture.targetCapture);
    const target = await input.target.prepare("SELECT f.revision AS revision,c.revision AS inputClock FROM market_storage_fence f JOIN eod_input_clock c ON c.id='default' WHERE f.id='default'")
      .first<{ revision: number; inputClock: number }>();
    const history = await inspectStorageHistoryPointerIndexSchema(input.history, storageMigrationIdentity(run), previous.capture.historyCapture,
      { historyDatabaseId: run.history_database_id, policy: "indexed" });
    if (!target || !Number.isSafeInteger(target.revision) || !Number.isSafeInteger(target.inputClock)
      || history.schemaHash !== amendment.schemaHash || history.indexManifestHash !== amendment.indexManifestHash
      || history.snapshotRevision !== amendment.snapshotRevision || history.revision < amendment.revision) fail("tracked-capture-invalid");
    return { target, history, publications: await publicationSnapshot() };
  };
  const measured = await proveUnchanged(), physical = await input.measurePhysical(), physicalAge = (input.now ?? new Date()).getTime() - Date.parse(physical.measuredAt);
  if (!Number.isFinite(physicalAge) || physicalAge < 0 || physicalAge > 300_000
    || ![physical.targetBytes, physical.historyBytes].every(value => Number.isSafeInteger(value) && value > 0 && value < 350_000_000)) fail("capacity-unavailable");
  const [pointerText, previousText, sizingText] = await Promise.all([read(ops, `storage-population-current:${run.id}`),
    read(ops, `storage-population-plan:${run.id}:${previous.planHash}`), read(ops, `storage-population-sizing:${previous.planHash}`)]);
  if (pointerText !== JSON.stringify({ planHash: previous.planHash }) || !previousText || !sizingText || !await same(parse(previousText), previous)) fail("plan-record-mismatch");
  const { planHash: _hash, ...oldFields } = previous, planFields = { ...oldFields, predecessorPlanHash: previous.planHash, codeRevision: input.codeRevision, createdAt: stamp };
  const plan = { ...planFields, planHash: await storageHash(planFields) }, sizing = { ...parse<Record<string, unknown>>(sizingText), planHash: plan.planHash };
  const checkpointManifestHash = await storageHash(checkpoints), executionFields = { ...priorExecution, fromRevision: input.fromRevision, codeRevision: input.codeRevision,
    predecessorHash: priorExecution.evidenceHash, checkpointCount: checkpoints.length, checkpointManifestHash, changedFiles: [...input.changedFiles].sort(), diffHash: input.diffHash, approvedAt: stamp };
  const { evidenceHash: _oldExecution, ...unsignedExecution } = executionFields, execution = { ...unsignedExecution, evidenceHash: await storageHash(unsignedExecution) };
  const fields: Omit<StoragePopulationExecutionContinuation, "evidenceHash"> = { version: 1, policy: "preserve-bootstrap-population-contracts-v1", migrationId: run.id,
    fromRevision: input.fromRevision, codeRevision: input.codeRevision, previousPlanHash: previous.planHash, planHash: plan.planHash,
    previousExecutionHash: priorExecution.evidenceHash, executionHash: execution.evidenceHash, predecessorAuditHash: predecessor.evidenceHash,
    amendmentHash: await storageHash(amendment), codeContract: input.codeContract, checkpointManifestHash, originalOwner: owner,
    eodRunHash: await storageHash(eod), featureCheckpointCount: features.length, featureCheckpointManifestHash: await storageHash(features),
    publicationManifestHash: await storageHash(measured.publications), publications: measured.publications, targetRevision: measured.target.revision,
    inputClock: measured.target.inputClock, historyRevision: measured.history.revision, resumeBoundary:boundary.resume, physical, approvedAt: stamp };
  const continuation = { ...fields, evidenceHash: await storageHash(fields) };
  await input.assertReviewedCheckout();
  if (!await same(await proveUnchanged(), measured)) fail("capture-changed");
  const records = [{ id: storagePopulationExecutionKey(run.id, input.codeRevision), value: continuation },
    { id: storageExecutionKey(run.id, input.codeRevision), value: execution }, { id: `storage-population-plan:${run.id}:${plan.planHash}`, value: plan },
    { id: `storage-population-sizing:${plan.planHash}`, value: sizing }].map(row => ({ id: row.id, payload: JSON.stringify(row.value) }));
  const featureComparison=storageFeatureCheckpointComparison(features,eod.id);
  const columns = Object.keys(eod);
  if (columns.some(column => !/^[a-z][a-z0-9_]*$/.test(column))) fail("run-schema-invalid");
  // Compare every actual EOD field without rewriting any of them. Bind the row
  // once: repeating its full frozen inputs per column would exceed D1's envelope.
  const eodEqual = columns.map(column => `actual.${column} IS json_extract(expected.value,'$.${column}')`).join(" AND ");
  const queries: Array<{ sql: string; params: unknown[] }> = [{ sql: `SELECT CASE WHEN EXISTS(SELECT 1 FROM market_storage_migrations WHERE id=? AND updated_at=?
      AND status=? AND stage='bootstrap' AND error_code IS ? AND COALESCE(execution_revision,code_revision)=? AND execution_evidence_hash=?
      AND lease_token IS NULL AND lease_until IS NULL AND dispatch_token IS NULL AND next_attempt_at=?)
    AND EXISTS(SELECT 1 FROM json_each(?) expected JOIN eod_runs actual ON actual.id=? WHERE ${eodEqual})
    AND NOT EXISTS(SELECT 1 FROM eod_runs WHERE lease_until>?)
    AND NOT EXISTS(SELECT 1 FROM market_storage_migrations WHERE lease_until>? OR status IN ('dispatching','dispatched') OR (dispatch_token IS NOT NULL AND status NOT IN ('completed','aborted')))
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=? AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=?
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=? AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=?
    AND (SELECT COUNT(*) FROM market_storage_checkpoints WHERE migration_id=?)=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN market_storage_checkpoints actual ON actual.migration_id=? AND actual.checkpoint_key=json_extract(expected.value,'$[0]')
      WHERE actual.checkpoint_key IS NULL OR actual.input_hash<>json_extract(expected.value,'$[1]') OR actual.payload_json<>json_extract(expected.value,'$[2]') OR actual.updated_at<>json_extract(expected.value,'$[3]'))
    AND (SELECT COUNT(*) FROM eod_checkpoints WHERE run_id=?)=?
    ${featureComparison.sql}
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected JOIN eod_rollout_evidence actual ON actual.id=json_extract(expected.value,'$.id') WHERE actual.evidence_json<>json_extract(expected.value,'$.payload'))
    THEN 1 ELSE json_extract('storage-population-execution-guard-rejected','$') END AS accepted /* eod-population-withdrawal */`, params: [
    run.id, run.updated_at, run.status, run.error_code, input.fromRevision, priorExecution.evidenceHash, run.next_attempt_at, JSON.stringify([eod]), eod.id, stamp, stamp,
    `storage-population-current:${run.id}`, pointerText, `storage-population-plan:${run.id}:${previous.planHash}`, previousText,
    `storage-population-sizing:${previous.planHash}`, sizingText, storageVixContinuationKey(run.id, input.fromRevision), predecessorText,
    run.id, checkpoints.length, JSON.stringify(checkpoints.map(row => [row.checkpoint_key, row.input_hash, row.payload_json, row.updated_at])), run.id,
    eod.id, features.length, ...featureComparison.params, JSON.stringify(records)] }];
  for (const row of records) queries.push({ sql: "INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING", params: [row.id, row.payload, stamp] });
  queries.push({ sql: "UPDATE eod_rollout_evidence SET evidence_json=?,updated_at=? WHERE id=? AND evidence_json=? RETURNING id", params: [JSON.stringify({ planHash: plan.planHash }), stamp, `storage-population-current:${run.id}`, pointerText] });
  queries.push({ sql: "UPDATE market_storage_checkpoints SET input_hash=? WHERE migration_id=? AND checkpoint_key='bootstrap:owner' AND input_hash=? RETURNING checkpoint_key", params: [plan.planHash, run.id, previous.planHash] });
  queries.push({ sql: `UPDATE market_storage_migrations SET execution_revision=?,execution_evidence_hash=?,status='awaiting-evidence',error_code='storage-execution-github-pin-required',
    lease_token=NULL,lease_until=NULL,next_attempt_at=NULL,updated_at=? WHERE id=? AND updated_at=? RETURNING id`, params: [input.codeRevision, execution.evidenceHash, stamp, run.id, run.updated_at] });
  if (new TextEncoder().encode(JSON.stringify({ batch: queries })).length > 8_000_000) fail("transaction-payload-exceeds-bound");
  assertStorageAtomicParameters(queries);
  const results = await ops.batch(queries.map(row => ops.prepare(row.sql).bind(...row.params)));
  if (results.slice(-3).some(row => row.results.length !== 1)) fail("promotion-conflict");
  const latest = await loadStorageMigration(ops, run.id);
  if (!latest || !await loadStorageHistoryIndexAmendment(ops, latest, plan)) fail("readback-conflict");
  if (!await same(await ops.prepare("SELECT * FROM eod_runs WHERE id=?").bind(eod.id).first(), eod)
    || !await same((await ops.prepare("SELECT run_id,chunk_key,input_hash,payload_json,updated_at FROM eod_checkpoints WHERE run_id=? ORDER BY chunk_key LIMIT 401").bind(eod.id).all()).results, features)
    || !await same(await proveUnchanged(), measured)) fail("post-promotion-data-changed");
  return { execution, plan, continuation };
}

/** Restore only the authenticated pre-approval scheduler boundary after the
 * CLI has verified the exact GitHub pin. The EOD retry/error row is untouched. */
export async function resumeStoragePopulationExecution(ops:D1Database,id:string,codeRevision:string):Promise<void> {
  const run=await loadStorageMigration(ops,id);if(!run)fail("migration-missing");
  const execution=await assertStorageExecutionRevision(ops,run,codeRevision),record=await verified(parse<StoragePopulationExecutionContinuation>(await read(ops,storagePopulationExecutionKey(id,codeRevision))));
  const boundary=record.resumeBoundary;
  if(!execution||record.executionHash!==execution.evidenceHash||record.codeRevision!==codeRevision||record.migrationId!==id||!boundary
    ||!["queued","retrying"].includes(boundary.status)||!Number.isFinite(Date.parse(boundary.nextAttemptAt))
    ||(boundary.status==="queued"?boundary.errorCode!==null:boundary.errorCode!=="storage-bootstrap-incomplete"))fail("resume-boundary-invalid");
  if(run.status===boundary.status&&run.error_code===boundary.errorCode&&run.next_attempt_at===boundary.nextAttemptAt)return;
  const result=await ops.prepare(`UPDATE market_storage_migrations SET status=?,error_code=?,next_attempt_at=?,updated_at=?
    WHERE id=? AND execution_revision=? AND execution_evidence_hash=? AND status='awaiting-evidence'
      AND error_code='storage-execution-github-pin-required' AND lease_token IS NULL AND lease_until IS NULL AND dispatch_token IS NULL RETURNING id`)
    .bind(boundary.status,boundary.errorCode,boundary.nextAttemptAt,new Date().toISOString(),id,codeRevision,execution.evidenceHash).all();
  if(result.results.length!==1)fail("resume-boundary-conflict");
}
