import { storageFeatureCheckpointComparison, assertStorageAtomicParameters } from "./market-storage-atomic-manifest";
import { z } from "zod";
import { storageHash } from "./market-storage-pages";
import { loadStorageMigration, storageMigrationIdentity, type StorageMigrationRun } from "./market-storage-control";
import { assertStorageExecutionRevision, storageExecutionKey, type StorageExecutionRecord } from "./market-storage-execution";
import { loadStorageValidationPlan, type StoragePopulationPlan } from "./market-storage-population-plan";
import { loadStorageHistoryIndexAmendment } from "./market-storage-history-index-recovery";
import { storageRepairExecutionKey } from "./market-storage-repair-execution";
import { captureStoragePopulationDelta, loadCompletedStoragePopulationDelta, loadStorageExpansionHistoryReceipt, type StorageExpansionHistoryReceipt } from "../scripts/eod-population-expansion-operator";
import type { StorageAcceptanceCapture } from "./market-storage-acceptance";
import type { FrozenInputs } from "./eod-runner";
import { storageFallbackModelValid } from "./eod-storage-layout";
import { validateStoragePopulationExpansionLineage } from "./market-storage-population-expansion";
import { assertStorageVerificationCapture, inspectStorageHistoryPointerIndexSchema, releaseStorageVerificationFence,
  releaseStorageHistoryVerificationFence } from "./market-storage-verification";
import { loadStoragePlanConsumerProof } from "./market-storage-consumer-composite";
import { EOD_PUBLICATION_SCOPES } from "./eod-publication-scopes";
import { EOD_CATALOG_SCOPE } from "./eod-catalog-service";
import { decodeEodPayload } from "./eod-publication-codec";

export const STORAGE_CAPACITY_EXECUTION_PREVIOUS_REVISION = "e52602a8a610711bff18426793b54623aadfdffa";
const hash = z.string().regex(/^[a-f0-9]{64}$/), sha = z.string().regex(/^[a-f0-9]{40}$/);
const codeSchema = z.object({ version: z.literal(1), policy: z.literal("completed-capacity-model-contracts-v1"),
  fromRevision: z.literal(STORAGE_CAPACITY_EXECUTION_PREVIOUS_REVISION), codeRevision: sha,
  protectedFileCount: z.number().int().min(4), protectedManifestHash: hash, integrationContractHash: hash,
  reviewedChangesHash: hash, beforeTreeHash: hash, afterTreeHash: hash, evidenceHash: hash }).strict();
export type StorageCapacityExecutionCodeContract = z.infer<typeof codeSchema>;
type Checkpoint = { checkpoint_key: string; input_hash: string; payload_json: string; updated_at: string };
type FeatureCheckpoint = { run_id: string; chunk_key: string; input_hash: string; payload_json: string; updated_at: string };
type EodRow = Record<string, string | number | null> & { id: string; input_json: string; progress_json: string; updated_at: string };
type Publication = { id: string; scope: string; session_date: string; status: string; payload_json: string;
  payload_checksum: string; payload_codec: string | null; payload_base64: string | null };
export type StorageCapacityFailure = { analysisHash:string; fileHash:string; measuredAt:string;
  sourceSnapshotHash:string; tickerHash:string; physicalArchiveBytes:number; projectedArchiveBytes:number;
  localSourceRows:number; verifiedCopySourceRows:number; sourceCountMismatch:boolean };
export type StorageCapacityResumeBoundary={status:"awaiting-evidence";errorCode:"storage-population-expansion-required";nextAttemptAt:null};
export function storageCapacityExecutionBoundary(run:Pick<StorageMigrationRun,"status"|"stage"|"error_code"|"next_attempt_at"|"updated_at">,
  eod:EodRow,progress:Record<string,unknown>,population:number,now:Date):StorageCapacityResumeBoundary {
  const updated=Date.parse(String(eod.updated_at)),completed=Date.parse(String(eod.completed_at)),migrationUpdated=Date.parse(run.updated_at);
  if(run.status!=="awaiting-evidence"||run.stage!=="bootstrap"||run.error_code!=="storage-population-expansion-required"||run.next_attempt_at!==null
    ||!Number.isFinite(migrationUpdated)||migrationUpdated>now.getTime()||eod.status!=="completed"||eod.mode!=="active"||eod.purpose!=="daily"
    ||!Number.isFinite(updated)||updated>now.getTime()||!Number.isFinite(completed)||completed>now.getTime()
    ||eod.next_attempt_at!==null||eod.error_code!==null||eod.stage!=="finished"
    ||!Number.isSafeInteger(eod.completed_input_clock)||progress.symbols!==population
    ||!Array.isArray(progress.published)||progress.published.length!==6||new Set(progress.published).size!==6
    ||progress.published.some(value=>typeof value!=="string")||typeof progress.catalogPublicationId!=="string")fail("completed-expansion-boundary-required");
  return {status:"awaiting-evidence",errorCode:"storage-population-expansion-required",nextAttemptAt:null};
}

type Pointer = { scope: string; publication_id: string; session_date: string; published_at: string };
export type StorageCapacityExecutionContinuation = { version: 1; policy: "preserve-completed-capacity-model-v1"; migrationId: string;
  fromRevision: string; codeRevision: string; previousPlanHash: string; planHash: string; previousExecutionHash: string;
  executionHash: string; predecessorAuditHash: string; amendmentHash: string; codeContract: StorageCapacityExecutionCodeContract;
  checkpointManifestHash: string; originalOwner: Checkpoint; eodRunHash: string; featureCheckpointCount: number;
  featureCheckpointManifestHash: string;
  publicationManifestHash: string; publications: Array<{ pointer: Pointer; rowHash: string }>;
  targetRevision: number; inputClock: number; historyRevision: number;
  resumeBoundary:StorageCapacityResumeBoundary;
  failure:StorageCapacityFailure; nextInputsHash:string; nextSessionDate:string; addedTickers:string[];
  capture:StorageAcceptanceCapture; historyReceipt:StorageExpansionHistoryReceipt;
  deltaManifest:Array<{id:string;payloadHash:string}>; deltaEvidenceHash:string; originalHistory:Checkpoint;
  failureBoundary:{migrationStatus:string;migrationError:string;migrationUpdatedAt:string;eodUpdatedAt:string};
  physical: { targetBytes: number; historyBytes: number; measuredAt: string }; approvedAt: string; evidenceHash: string };
export const storageCapacityExecutionKey = (id: string, revision: string) => `storage-capacity-execution:${id}:${revision}`;
const read = (ops: D1Database, id: string) => ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(id).first<string>("evidence_json");
async function assertOpenTarget(db:D1Database):Promise<void> {
  const row=await db.prepare("SELECT status,released_at FROM market_storage_fence WHERE id='default'").first<{status:string;released_at:string|null}>();
  if(row?.status!=="open"||row.released_at!==null)fail("target-tracking-not-open");
}
function fail(reason: string): never { throw new Error(`storage-capacity-execution-${reason}`); }
function parse<T>(text: string | null): T { try { if (!text) fail("record-missing"); return JSON.parse(text) as T; } catch { fail("record-invalid"); } }
const same = async (a: unknown, b: unknown) => await storageHash(a) === await storageHash(b);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
async function verified<T extends { evidenceHash: string }>(value: T): Promise<T> {
  const { evidenceHash, ...fields } = value;
  if (!hash.safeParse(evidenceHash).success || await storageHash(fields) !== evidenceHash) fail("record-integrity");
  return value;
}

/** Authenticate the completed R20 capacity-model revision without reassigning or redating
 * old storage, consumer, population, or publication evidence. */
export async function loadStorageCapacityExecution(ops: D1Database, run: StorageMigrationRun, plan: StoragePopulationPlan): Promise<{
  previousRun: StorageMigrationRun; previousPlan: StoragePopulationPlan; amendmentHash: string;
} | null> {
  const text = await read(ops, storageCapacityExecutionKey(run.id, plan.codeRevision));
  if (!text) return null;
  const record = await verified(parse<StorageCapacityExecutionContinuation>(text)), execution = await assertStorageExecutionRevision(ops, run, plan.codeRevision);
  if (record.version !== 1 || record.policy !== "preserve-completed-capacity-model-v1" || record.migrationId !== run.id
    || record.fromRevision !== STORAGE_CAPACITY_EXECUTION_PREVIOUS_REVISION || record.codeRevision !== plan.codeRevision || !execution
    || record.executionHash !== execution.evidenceHash || execution.fromRevision !== record.fromRevision
    || execution.predecessorHash !== record.previousExecutionHash || !codeSchema.safeParse(record.codeContract).success) fail("execution-mismatch");
  await verified(record.codeContract);
  if(!record.failureBoundary||record.failureBoundary.migrationStatus!=="awaiting-evidence"
    ||record.failureBoundary.migrationError!=="storage-population-expansion-required"
    ||!Number.isFinite(Date.parse(record.failureBoundary.migrationUpdatedAt))||!Number.isFinite(Date.parse(record.failureBoundary.eodUpdatedAt))
    ||record.resumeBoundary?.status!=="awaiting-evidence"||record.resumeBoundary.errorCode!=="storage-population-expansion-required"
    ||record.resumeBoundary.nextAttemptAt!==null||!hash.safeParse(record.nextInputsHash).success
    ||!Array.isArray(record.addedTickers)||record.addedTickers.length<1||record.addedTickers.length>100
    ||!record.failure||!hash.safeParse(record.failure.analysisHash).success||!hash.safeParse(record.failure.fileHash).success
    ||!Number.isSafeInteger(record.failure.localSourceRows)||record.failure.localSourceRows<=0
    ||!Number.isSafeInteger(record.failure.verifiedCopySourceRows)||record.failure.verifiedCopySourceRows<record.failure.localSourceRows
    ||record.failure.sourceCountMismatch!==(record.failure.localSourceRows!==record.failure.verifiedCopySourceRows)
    ||record.failure.projectedArchiveBytes<350_000_000
    ||record.failure.projectedArchiveBytes!==record.failure.physicalArchiveBytes*2+4*1024*1024)fail("failure-evidence-invalid");
  if (record.codeContract.codeRevision !== plan.codeRevision || record.codeContract.fromRevision !== record.fromRevision) fail("code-contract-invalid");
  const previousRun = { ...run, execution_revision: record.fromRevision, execution_evidence_hash: record.previousExecutionHash };
  await assertStorageExecutionRevision(ops, previousRun, record.fromRevision);
  const predecessor = await verified(parse<{ evidenceHash: string }>(await read(ops, storageRepairExecutionKey(run.id, record.fromRevision))));
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
  const receipt=await loadStorageExpansionHistoryReceipt(ops,{migrationId:run.id,codeRevision:record.fromRevision,previousPlanHash:previousPlan.planHash,
    nextInputsHash:record.nextInputsHash,captureHash:record.capture.captureHash,historyDatabaseId:run.history_database_id});
  const delta=await loadCompletedStoragePopulationDelta({ops,migrationId:run.id,previousPlanHash:previousPlan.planHash,nextInputsHash:record.nextInputsHash,
    capture:record.capture,addedTickers:record.addedTickers});
  if(!await same(receipt,record.historyReceipt)||delta.evidence.evidenceHash!==record.deltaEvidenceHash
    ||!await same(await Promise.all(delta.records.map(async row=>({id:row.id,payloadHash:await storageHash(row.payload)}))),record.deltaManifest)
    ||record.originalHistory.checkpoint_key!==`bootstrap-history:${previousPlan.sessionDate}`
    ||record.originalHistory.input_hash!==previousPlan.planHash||record.originalHistory.payload_json!==record.originalOwner.payload_json)fail("capture-reuse-integrity");
  return { previousRun, previousPlan, amendmentHash: record.amendmentHash };
}

export type StorageCapacityExecutionApprovalInput = { ops: D1Database; source: D1Database; target: D1Database; history: D1Database;
  migrationId: string; fromRevision: string; codeRevision: string; expectedPlanHash: string; changedFiles: string[]; diffHash: string;
  codeContract: StorageCapacityExecutionCodeContract; assertReviewedCheckout: () => Promise<void>; assertNoWorkflowWriters: () => Promise<void>;
  measurePhysical: () => Promise<{ targetBytes: number; historyBytes: number; measuredAt: string }>;
  loadCurrentInputs:()=>Promise<FrozenInputs>; failedAnalysis:unknown; failedAnalysisFileHash:string;
  assertCapturedArtifact:(receipt:StorageExpansionHistoryReceipt)=>Promise<{historyFileHash:string;analysisFileHash:string}>; now?: Date;
};
/** Admit only an actual legacy capacity-model failure after the old owner
 * completed. All price/consumer evidence remains under its original identity. */
export async function approveStorageCapacityExecution(input: StorageCapacityExecutionApprovalInput): Promise<{
  execution: StorageExecutionRecord; plan: StoragePopulationPlan; continuation: StorageCapacityExecutionContinuation;
}> {
  const now = input.now ?? new Date(), stamp = now.toISOString(), ops = input.ops, parsed = codeSchema.safeParse(input.codeContract);
  if (!parsed.success || input.fromRevision !== STORAGE_CAPACITY_EXECUTION_PREVIOUS_REVISION || parsed.data.codeRevision !== input.codeRevision
    || input.codeRevision === input.fromRevision || !hash.safeParse(input.diffHash).success || !hash.safeParse(input.expectedPlanHash).success
    || !hash.safeParse(input.failedAnalysisFileHash).success
    || !input.changedFiles.includes("worker/scripts/analyze-eod-storage.py") || !input.changedFiles.includes("worker/src/eod-storage-layout.ts")) fail("code-contract-invalid");
  await verified(parsed.data); await input.assertReviewedCheckout(); await input.assertNoWorkflowWriters();
  const run = await loadStorageMigration(ops, input.migrationId);
  if (!run) fail("migration-missing");
  if (run.execution_revision === input.codeRevision) {
    const { bootstrapInputs: _derived, sizingHash: _size, ...plan } = await loadStorageValidationPlan(ops, run);
    const continuation = await verified(parse<StorageCapacityExecutionContinuation>(await read(ops, storageCapacityExecutionKey(run.id, input.codeRevision))));
    const execution = await assertStorageExecutionRevision(ops, run, input.codeRevision);
    if (!execution || execution.diffHash !== input.diffHash || continuation.previousPlanHash !== input.expectedPlanHash
      || continuation.failure.fileHash!==input.failedAnalysisFileHash || !await same(continuation.codeContract, input.codeContract)) fail("replay-conflict");
    const amendment = await loadStorageHistoryIndexAmendment(ops, run, plan);
    if (!amendment) fail("original-amendment-missing");
    await assertStorageVerificationCapture(input.source, storageMigrationIdentity(run), plan.capture.sourceCapture);
    await assertOpenTarget(input.target);
    await releaseStorageVerificationFence(input.target, storageMigrationIdentity(run), plan.capture.targetCapture);
    await inspectStorageHistoryPointerIndexSchema(input.history, storageMigrationIdentity(run),plan.capture.historyCapture,{historyDatabaseId:run.history_database_id,policy:"indexed"});
    await releaseStorageHistoryVerificationFence(input.history, storageMigrationIdentity(run), plan.capture.historyCapture, amendment);
    const artifacts=await input.assertCapturedArtifact(continuation.historyReceipt);
    if(artifacts.historyFileHash!==continuation.historyReceipt.fileHash||artifacts.analysisFileHash!==continuation.failure.fileHash)fail("replay-artifact-conflict");
    return { execution, plan, continuation };
  }
  if (run.status !== "awaiting-evidence" || run.error_code!=="storage-population-expansion-required" || run.stage !== "bootstrap" || run.freeze_authorized !== 1
    || !run.freeze_evidence_hash || run.dispatch_token !== null || run.lease_token !== null || run.lease_until !== null
    || run.next_attempt_at!==null) fail("released-completed-expansion-required");
  const priorExecution = await assertStorageExecutionRevision(ops, run, input.fromRevision);
  if (!priorExecution) fail("prior-execution-required");
  const { bootstrapInputs: _derived, sizingHash: _size, ...previous } = await loadStorageValidationPlan(ops, run);
  if (previous.planHash !== input.expectedPlanHash) fail("selected-plan-mismatch");
  const predecessorText = await read(ops, storageRepairExecutionKey(run.id, input.fromRevision));
  const predecessor = await verified(parse<{ evidenceHash: string; originalOwner: Checkpoint }>(predecessorText));
  const amendment = await loadStorageHistoryIndexAmendment(ops, run, previous);
  if (!amendment) fail("original-amendment-missing");
  const eod = await ops.prepare("SELECT * FROM eod_runs WHERE id=?").bind(`eod:active:${previous.sessionDate}:daily`).first<EodRow>();
  const progress = eod ? object(parse(eod.progress_json)) : null, total = Math.ceil(previous.inputs.tickers.length / 25);
  if(!eod||eod.session_date!==previous.sessionDate||eod.lease_token!==null||eod.lease_until!==null||eod.dispatch_token!==null||!progress
    ||!await same(parse(eod.input_json),previous.inputs))fail("completed-expansion-boundary-required");
  const boundary=storageCapacityExecutionBoundary(run,eod,progress,previous.tickers.length,now);
  const checkpoints = (await ops.prepare("SELECT checkpoint_key,input_hash,payload_json,updated_at FROM market_storage_checkpoints WHERE migration_id=? ORDER BY checkpoint_key LIMIT 129")
    .bind(run.id).all<Checkpoint>()).results, owner = checkpoints.find(row => row.checkpoint_key === "bootstrap:owner");
  if (checkpoints.length > 128 || !owner || owner.input_hash !== previous.planHash

    || !await same(parse(owner.payload_json), { runId: eod.id, sessionDate: previous.sessionDate, targetDatabaseId: run.target_database_id })) fail("owner-or-checkpoints-changed");
  const consumers = checkpoints.find(row => row.checkpoint_key === "consumer-parity:complete");
  if (!consumers || consumers.input_hash !== previous.capture.captureHash) fail("consumer-proof-missing");
  await loadStoragePlanConsumerProof(ops, run, previous);
  const originalHistory=checkpoints.find(row=>row.checkpoint_key===`bootstrap-history:${previous.sessionDate}`);
  if(!originalHistory||originalHistory.input_hash!==previous.planHash||originalHistory.payload_json!==owner.payload_json
    ||checkpoints.some(row=>row.checkpoint_key.startsWith("bootstrap")&&!['bootstrap:owner',`bootstrap-history:${previous.sessionDate}`].includes(row.checkpoint_key)))fail("completed-history-required");
  const nextInputs=await input.loadCurrentInputs(),nextInputsHash=await storageHash(nextInputs),nextSession=nextInputs.calendarDates.at(-1);
  const addedTickers=nextInputs.tickers.filter(ticker=>!previous.tickers.includes(ticker)).sort();
  if((!nextSession||!/^\d{4}-\d{2}-\d{2}$/.test(nextSession)||nextSession<=previous.sessionDate)||!addedTickers.length||addedTickers.length>100
    ||new Set(nextInputs.tickers).size!==nextInputs.tickers.length||previous.tickers.some(ticker=>!nextInputs.tickers.includes(ticker))
    ||!await same(nextInputs.config,previous.inputs.config))fail("append-inputs-required");
  if(await ops.prepare("SELECT id FROM eod_runs WHERE id=?").bind(`eod:active:${nextSession!}:daily`).first())fail("latest-run-already-exists");
  const features = (await ops.prepare("SELECT run_id,chunk_key,input_hash,payload_json,updated_at FROM eod_checkpoints WHERE run_id=? ORDER BY chunk_key LIMIT 401")
    .bind(eod.id).all<FeatureCheckpoint>()).results;
  if (!features.length || features.length > Math.min(400, total) || features.some(row => row.run_id !== eod.id
    || !/^features:(0|[1-9]\d*)$/.test(row.chunk_key) || Number(row.chunk_key.slice(9)) >= total || !hash.safeParse(row.input_hash).success)) fail("feature-checkpoint-bound");
  if(features.length!==total)fail("feature-checkpoint-manifest-incomplete");
  const publicationSnapshot = async () => {
    const pointers = (await input.target.prepare("SELECT scope,publication_id,session_date,published_at FROM eod_publication_pointers WHERE scope IN (SELECT value FROM json_each(?)) ORDER BY scope")
      .bind(JSON.stringify([...EOD_PUBLICATION_SCOPES, EOD_CATALOG_SCOPE])).all<Pointer>()).results;
    if (pointers.length!==7||new Set(pointers.map(row=>row.scope)).size!==7) fail("all-completed-publications-required");
    const values: StorageCapacityExecutionContinuation["publications"] = [];
    for (const pointer of pointers) {
      const row = await input.target.prepare("SELECT * FROM eod_publications WHERE id=?").bind(pointer.publication_id).first<Publication>();
      if (!row || row.id !== pointer.publication_id || row.scope !== pointer.scope || row.session_date !== previous.sessionDate
        || pointer.session_date !== row.session_date || row.status !== "accepted"
        ||(pointer.scope===EOD_CATALOG_SCOPE?progress.catalogPublicationId!==pointer.publication_id:!(progress.published as string[]).includes(pointer.publication_id))) fail("publication-integrity");
      const payload = await decodeEodPayload({ payload: row.payload_json, payloadCodec: row.payload_codec, payloadBase64: row.payload_base64 });
      if (await storageHash(payload) !== row.payload_checksum) fail("publication-checksum");
      if (row.scope === "overview:default" && !Array.isArray(object(payload)?.sections)) fail("overview-payload-invalid");
      values.push({ pointer, rowHash: await storageHash(row) });
    }
    return values;
  };
  const proveUnchanged = async () => {
    await input.assertNoWorkflowWriters();
    if (await ops.prepare(`SELECT 1 AS unsafe WHERE EXISTS(SELECT 1 FROM eod_runs WHERE lease_until>?)
      OR EXISTS(SELECT 1 FROM market_storage_migrations WHERE lease_until>? OR status IN ('dispatching','dispatched')
        OR (dispatch_token IS NOT NULL AND status NOT IN ('completed','aborted')))` ).bind(stamp, stamp).first()) fail("writer-present");
    await assertStorageVerificationCapture(input.source, storageMigrationIdentity(run), previous.capture.sourceCapture);
    await assertOpenTarget(input.target);
    await releaseStorageVerificationFence(input.target, storageMigrationIdentity(run), previous.capture.targetCapture);
    const target = await input.target.prepare("SELECT f.revision AS revision,c.revision AS inputClock FROM market_storage_fence f JOIN eod_input_clock c ON c.id='default' WHERE f.id='default'")
      .first<{ revision: number; inputClock: number }>();
    const history = await inspectStorageHistoryPointerIndexSchema(input.history, storageMigrationIdentity(run), previous.capture.historyCapture,
      { historyDatabaseId: run.history_database_id, policy: "indexed" });
    if (!target || !Number.isSafeInteger(target.revision) || !Number.isSafeInteger(target.inputClock)
      || history.schemaHash !== amendment.schemaHash || history.indexManifestHash !== amendment.indexManifestHash
      || history.snapshotRevision !== amendment.snapshotRevision || history.revision < amendment.revision) fail("tracked-capture-invalid");
    const captured=await captureStoragePopulationDelta({source:input.source,target:input.target,history:input.history,run,previousPlan:previous,amendment});
    if(target.inputClock!==eod.completed_input_clock||await storageHash(await input.loadCurrentInputs())!==nextInputsHash)fail("capture-inputs-changed");
    return { target, history, captured, publications: await publicationSnapshot() };
  };
  const measured = await proveUnchanged(), physical = await input.measurePhysical(), physicalAge = (input.now ?? new Date()).getTime() - Date.parse(physical.measuredAt);
  if (!Number.isFinite(physicalAge) || physicalAge < 0 || physicalAge > 300_000
    || ![physical.targetBytes, physical.historyBytes].every(value => Number.isSafeInteger(value) && value > 0 && value < 350_000_000)) fail("capacity-unavailable");
  const receipt=await loadStorageExpansionHistoryReceipt(ops,{migrationId:run.id,codeRevision:input.fromRevision,previousPlanHash:previous.planHash,
    nextInputsHash,captureHash:measured.captured.capture.captureHash,historyDatabaseId:run.history_database_id});
  if(!receipt)fail("completed-history-receipt-required");
  const artifacts=await input.assertCapturedArtifact(receipt);
  if(artifacts.historyFileHash!==receipt.fileHash||artifacts.analysisFileHash!==input.failedAnalysisFileHash)fail("captured-artifact-mismatch");
  const delta=await loadCompletedStoragePopulationDelta({ops,migrationId:run.id,previousPlanHash:previous.planHash,nextInputsHash,
    capture:measured.captured.capture,addedTickers});
  const receiptIdentity={migrationId:run.id,codeRevision:input.fromRevision,previousPlanHash:previous.planHash,nextInputsHash,
    captureHash:measured.captured.capture.captureHash,historyDatabaseId:run.history_database_id};
  const readonlyRecords=[...delta.records,{id:`storage-expansion-history:${await storageHash(receiptIdentity)}`,payload:JSON.stringify(receipt)}];
  const wholeCopy=checkpoints.find(row=>row.checkpoint_key==="verification:complete");
  const copyRows=object(object(wholeCopy?parse(wholeCopy.payload_json):null)?.prices)?.sourceRows;
  if(!Number.isSafeInteger(copyRows)||Number(copyRows)<=0)fail("verified-copy-count-required");
  const failure=await validateStorageCapacityFailure(input.failedAnalysis,input.failedAnalysisFileHash,previous,nextInputs,receipt,now,Number(copyRows));
  const [pointerText, previousText, sizingText] = await Promise.all([read(ops, `storage-population-current:${run.id}`),
    read(ops, `storage-population-plan:${run.id}:${previous.planHash}`), read(ops, `storage-population-sizing:${previous.planHash}`)]);
  if (pointerText !== JSON.stringify({ planHash: previous.planHash }) || !previousText || !sizingText || !await same(parse(previousText), previous)) fail("plan-record-mismatch");
  const { planHash: _hash, ...oldFields } = previous, planFields = { ...oldFields, predecessorPlanHash: previous.planHash, codeRevision: input.codeRevision, createdAt: stamp };
  const plan = { ...planFields, planHash: await storageHash(planFields) }, sizing = { ...parse<Record<string, unknown>>(sizingText), planHash: plan.planHash };
  const checkpointManifestHash = await storageHash(checkpoints), executionFields = { ...priorExecution, fromRevision: input.fromRevision, codeRevision: input.codeRevision,
    predecessorHash: priorExecution.evidenceHash, checkpointCount: checkpoints.length, checkpointManifestHash, changedFiles: [...input.changedFiles].sort(), diffHash: input.diffHash, approvedAt: stamp };
  const { evidenceHash: _oldExecution, ...unsignedExecution } = executionFields, execution = { ...unsignedExecution, evidenceHash: await storageHash(unsignedExecution) };
  const fields: Omit<StorageCapacityExecutionContinuation, "evidenceHash"> = { version: 1, policy: "preserve-completed-capacity-model-v1", migrationId: run.id,
    fromRevision: input.fromRevision, codeRevision: input.codeRevision, previousPlanHash: previous.planHash, planHash: plan.planHash,
    previousExecutionHash: priorExecution.evidenceHash, executionHash: execution.evidenceHash, predecessorAuditHash: predecessor.evidenceHash,
    amendmentHash: await storageHash(amendment), codeContract: input.codeContract, checkpointManifestHash, originalOwner: owner,
    eodRunHash: await storageHash(eod), featureCheckpointCount: features.length, featureCheckpointManifestHash: await storageHash(features),
    publicationManifestHash: await storageHash(measured.publications), publications: measured.publications, targetRevision: measured.target.revision,
    inputClock: measured.target.inputClock, historyRevision: measured.history.revision, resumeBoundary:boundary,
    failureBoundary:{migrationStatus:run.status,migrationError:run.error_code!,migrationUpdatedAt:run.updated_at,eodUpdatedAt:eod.updated_at},
    failure,nextInputsHash,nextSessionDate:nextSession!,addedTickers,capture:measured.captured.capture,historyReceipt:receipt,
    deltaManifest:await Promise.all(delta.records.map(async row=>({id:row.id,payloadHash:await storageHash(row.payload)}))),
    deltaEvidenceHash:delta.evidence.evidenceHash,originalHistory,physical, approvedAt: stamp };
  const continuation = { ...fields, evidenceHash: await storageHash(fields) };
  await input.assertReviewedCheckout();
  if (!await same(await proveUnchanged(), measured)||!await same(await input.assertCapturedArtifact(receipt),artifacts)) fail("capture-changed");
  const records = [{ id: storageCapacityExecutionKey(run.id, input.codeRevision), value: continuation },
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
      AND lease_token IS NULL AND lease_until IS NULL AND dispatch_token IS NULL AND next_attempt_at IS ?)
    AND EXISTS(SELECT 1 FROM json_each(?) expected JOIN eod_runs actual ON actual.id=? WHERE ${eodEqual})
    AND NOT EXISTS(SELECT 1 FROM eod_runs WHERE lease_until>?)
    AND NOT EXISTS(SELECT 1 FROM eod_runs WHERE id=?)
    AND NOT EXISTS(SELECT 1 FROM market_storage_migrations WHERE lease_until>? OR status IN ('dispatching','dispatched') OR (dispatch_token IS NOT NULL AND status NOT IN ('completed','aborted')))
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=? AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=?
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=? AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=?
    AND (SELECT COUNT(*) FROM market_storage_checkpoints WHERE migration_id=?)=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN market_storage_checkpoints actual ON actual.migration_id=? AND actual.checkpoint_key=json_extract(expected.value,'$[0]')
      WHERE actual.checkpoint_key IS NULL OR actual.input_hash<>json_extract(expected.value,'$[1]') OR actual.payload_json<>json_extract(expected.value,'$[2]') OR actual.updated_at<>json_extract(expected.value,'$[3]'))
    AND (SELECT COUNT(*) FROM eod_checkpoints WHERE run_id=?)=?
    ${featureComparison.sql}
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN eod_rollout_evidence actual ON actual.id=json_extract(expected.value,'$.id')
      WHERE actual.id IS NULL OR actual.evidence_json<>json_extract(expected.value,'$.payload'))
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected JOIN eod_rollout_evidence actual ON actual.id=json_extract(expected.value,'$.id') WHERE actual.evidence_json<>json_extract(expected.value,'$.payload'))
    THEN 1 ELSE json_extract('storage-capacity-execution-guard-rejected','$') END AS accepted /* eod-population-withdrawal */`, params: [
    run.id, run.updated_at, run.status, run.error_code, input.fromRevision, priorExecution.evidenceHash, run.next_attempt_at, JSON.stringify([eod]), eod.id, stamp, `eod:active:${nextSession!}:daily`, stamp,
    `storage-population-current:${run.id}`, pointerText, `storage-population-plan:${run.id}:${previous.planHash}`, previousText,
    `storage-population-sizing:${previous.planHash}`, sizingText, storageRepairExecutionKey(run.id, input.fromRevision), predecessorText,
    run.id, checkpoints.length, JSON.stringify(checkpoints.map(row => [row.checkpoint_key, row.input_hash, row.payload_json, row.updated_at])), run.id,
    eod.id, features.length, ...featureComparison.params, JSON.stringify(readonlyRecords), JSON.stringify(records)] }];
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

/** Restore the original expansion pause after the exact GitHub pin is verified.
 * New sizing and the existing guarded population promotion remain mandatory. */
export async function resumeStorageCapacityExecution(ops:D1Database,id:string,codeRevision:string):Promise<void> {
  const run=await loadStorageMigration(ops,id);if(!run)fail("migration-missing");
  const execution=await assertStorageExecutionRevision(ops,run,codeRevision),record=await verified(parse<StorageCapacityExecutionContinuation>(await read(ops,storageCapacityExecutionKey(id,codeRevision))));
  const boundary=record.resumeBoundary;
  if(!execution||record.executionHash!==execution.evidenceHash||record.codeRevision!==codeRevision||record.migrationId!==id||!boundary
    ||boundary.status!=="awaiting-evidence"||boundary.errorCode!=="storage-population-expansion-required"||boundary.nextAttemptAt!==null)fail("resume-boundary-invalid");
  if(run.status===boundary.status&&run.error_code===boundary.errorCode&&run.next_attempt_at===boundary.nextAttemptAt)return;
  const result=await ops.prepare(`UPDATE market_storage_migrations SET status=?,error_code=?,next_attempt_at=?,updated_at=?
    WHERE id=? AND execution_revision=? AND execution_evidence_hash=? AND status='awaiting-evidence'
      AND error_code='storage-execution-github-pin-required' AND lease_token IS NULL AND lease_until IS NULL AND dispatch_token IS NULL RETURNING id`)
    .bind(boundary.status,boundary.errorCode,boundary.nextAttemptAt,new Date().toISOString(),id,codeRevision,execution.evidenceHash).all();
  if(result.results.length!==1)fail("resume-boundary-conflict");
}


export async function validateStorageCapacityFailure(value:unknown,fileHash:string,previous:StoragePopulationPlan,
  next:FrozenInputs,receipt:StorageExpansionHistoryReceipt,now:Date,verifiedCopySourceRows?:number):Promise<StorageCapacityFailure> {
  const report=object(value),source=object(report?.source),capture=object(source?.capture),population=object(report?.population),
    archive=object(report?.archive),database=object(archive?.database),fallback=object(archive?.fallbackReserve);
  const measuredAt=String(report?.measuredAt),measured=Date.parse(measuredAt),physical=database?.physicalBytes,projected=archive?.withAdditionalCompleteRevisionAndTransientBytes;
  if(!report||report.version!==1||report.sessionDate!==previous.capture.identity.sessionDate
    ||source?.snapshotSha256!==previous.sourceSnapshotHash||capture?.kind!=="logical-d1-capacity-snapshot"||capture.completeDeclared!==true||capture.partialEstimate!==false
    ||population?.count!==next.tickers.length||population.sha256!==await storageHash([...next.tickers].sort())
    ||!hash.safeParse(source?.schemaSha256).success||report.storageOnlyRecommendedHotSessions!==null
    ||!Array.isArray(report.retentionModels)||report.retentionModels.length!==2
    ||new Set(report.retentionModels.map(row=>object(row)?.hotSessions)).size!==2
    ||report.retentionModels.some(row=>![90,260].includes(Number(object(row)?.hotSessions))||!storageFallbackModelValid(report,row,next.tickers.length))
    ||archive?.storageRoundTripPassed!==true||!Number.isSafeInteger(archive.sourceRows)||Number(archive.sourceRows)<=0
    ||fallback?.storage!=="archive-only-bounded-v1"||fallback.roundTripPassed!==true||fallback.physicalBytesAfter!==physical
    ||!Number.isSafeInteger(physical)||Number(physical)<=0||projected!==Number(physical)*2+4*1024*1024||Number(projected)<350_000_000
    ||!hash.safeParse(fileHash).success||!Number.isFinite(measured)||measured>now.getTime()||measured<Date.parse(receipt.capturedAt))fail("actual-legacy-capacity-failure-required");
  const copied=verifiedCopySourceRows??Number(archive.sourceRows);
  if(!Number.isSafeInteger(copied)||copied<Number(archive.sourceRows))fail("verified-copy-count-invalid");
  return {analysisHash:await storageHash(report),fileHash,measuredAt,sourceSnapshotHash:String(source.snapshotSha256),tickerHash:String(population.sha256),
    physicalArchiveBytes:Number(physical),projectedArchiveBytes:Number(projected),localSourceRows:Number(archive.sourceRows),verifiedCopySourceRows:copied,sourceCountMismatch:copied!==archive.sourceRows};
}

/** Resolve original capture artifacts through an approved executor bridge.
 * Returned receipt and delta are the original immutable records, not new proof. */
export async function loadStorageCapacityCaptureReuse(ops:D1Database,run:StorageMigrationRun,plan:StoragePopulationPlan):Promise<{
  continuation:StorageCapacityExecutionContinuation; previousPlan:StoragePopulationPlan;
  receipt:StorageExpansionHistoryReceipt; delta:Awaited<ReturnType<typeof loadCompletedStoragePopulationDelta>>;
}|null> {
  const {bootstrapInputs,sizingHash,...plain}=plan as StoragePopulationPlan & {bootstrapInputs?:unknown;sizingHash?:unknown};
  if(bootstrapInputs!==undefined||sizingHash!==undefined) {
    const loaded=await loadStorageValidationPlan(ops,run);
    if(loaded.planHash!==plain.planHash||loaded.sizingHash!==sizingHash||!await same(bootstrapInputs,loaded.inputs))fail("reuse-derived-plan-mismatch");
  }
  const ancestor=await loadStorageCapacityExecution(ops,run,plain);if(!ancestor)return null;
  const continuation=await verified(parse<StorageCapacityExecutionContinuation>(await read(ops,storageCapacityExecutionKey(run.id,plan.codeRevision))));
  const delta=await loadCompletedStoragePopulationDelta({ops,migrationId:run.id,previousPlanHash:ancestor.previousPlan.planHash,
    nextInputsHash:continuation.nextInputsHash,capture:continuation.capture,addedTickers:continuation.addedTickers});
  return {continuation,previousPlan:ancestor.previousPlan,receipt:continuation.historyReceipt,delta};
}
