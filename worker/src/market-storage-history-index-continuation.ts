import { z } from "zod";
import { storageHash } from "./market-storage-pages";
import { loadStorageMigration,storageMigrationIdentity,type StorageMigrationRun } from "./market-storage-control";
import { assertStorageExecutionRevision,storageExecutionKey,type StorageExecutionRecord } from "./market-storage-execution";
import { loadStorageValidationPlan,type StoragePopulationPlan } from "./market-storage-population-plan";
import { loadStorageHistoryIndexAmendment,storageHistoryIndexRecoveryKey,type StorageHistoryIndexRecovery } from "./market-storage-history-index-recovery";
import { assertStorageVerificationCapture,inspectStorageHistoryPointerIndexSchema,releaseStorageVerificationFence,releaseStorageHistoryVerificationFence } from "./market-storage-verification";
import { EOD_PUBLICATION_SCOPES } from "./eod-publication-scopes";
import { EOD_CATALOG_SCOPE } from "./eod-catalog-service";
import type { EodRun } from "./eod-coordinator";
import { validateStorageConsumerEvidence,type StorageConsumerEvidence } from "./market-storage-acceptance";

export const STORAGE_INDEX_LOADER_PREVIOUS_REVISION="8b0622a30b986290920b7815c4abe00ef54fdf44";
const hash=z.string().regex(/^[a-f0-9]{64}$/),sha=z.string().regex(/^[a-f0-9]{40}$/);
const codeSchema=z.object({version:z.literal(1),policy:z.literal("index-amendment-loader-normalization-v1"),fromRevision:z.literal(STORAGE_INDEX_LOADER_PREVIOUS_REVISION),
  codeRevision:sha,protectedFileCount:z.number().int().min(4),protectedManifestHash:hash,loaderValidationHash:hash,reviewedChangesHash:hash,
  beforeTreeHash:hash,afterTreeHash:hash,evidenceHash:hash}).strict();
export type StorageIndexLoaderCodeContract=z.infer<typeof codeSchema>;
type Checkpoint={checkpoint_key:string;input_hash:string;payload_json:string;updated_at:string};
type Continuation={version:1;policy:"preserve-approved-index-amendment-loader-fix-v1";migrationId:string;fromRevision:string;codeRevision:string;
  previousPlanHash:string;planHash:string;previousExecutionHash:string;executionHash:string;recoveryEvidenceHash:string;amendmentHash:string;
  codeContract:StorageIndexLoaderCodeContract;checkpointManifestHash:string;originalOwner:Checkpoint;eodRunHash:string;
  targetRevision:number;inputClock:number;historyRevision:number;ledger:{id:number;name:string;applied_at:string};
  physical:{targetBytes:number;historyBytes:number;measuredAt:string};approvedAt:string;evidenceHash:string};
export const storageIndexLoaderContinuationKey=(id:string,revision:string)=>`storage-index-loader-continuation:${id}:${revision}`;
const read=(ops:D1Database,id:string)=>ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(id).first<string>("evidence_json");
function fail(reason:string):never{throw new Error(`storage-index-loader-continuation-${reason}`);}
function parse<T>(text:string|null):T{try{if(!text)fail("record-missing");return JSON.parse(text) as T;}catch{fail("record-invalid");}}
const same=async(a:unknown,b:unknown)=>await storageHash(a)===await storageHash(b);
async function verified<T extends {evidenceHash:string}>(value:T){const {evidenceHash,...fields}=value;if(await storageHash(fields)!==evidenceHash)fail("record-integrity");return value;}

/** A runtime bridge authenticates its own execution and the old immutable R14
 * plan/execution separately. The existing loader then validates the original
 * baseline/amendment through that prior identity; old dates are never copied. */
export async function loadStorageIndexLoaderContinuation(ops:D1Database,run:StorageMigrationRun,plan:StoragePopulationPlan):Promise<{
  previousRun:StorageMigrationRun;previousPlan:StoragePopulationPlan;amendmentHash:string;
}|null> {
  const text=await read(ops,storageIndexLoaderContinuationKey(run.id,plan.codeRevision));if(!text)return null;
  const record=await verified(parse<Continuation>(text)),execution=await assertStorageExecutionRevision(ops,run,plan.codeRevision);
  if(record.version!==1||record.policy!=="preserve-approved-index-amendment-loader-fix-v1"||record.migrationId!==run.id
    ||record.fromRevision!==STORAGE_INDEX_LOADER_PREVIOUS_REVISION||record.codeRevision!==plan.codeRevision||!execution
    ||record.executionHash!==execution.evidenceHash||execution.fromRevision!==record.fromRevision||execution.predecessorHash!==record.previousExecutionHash)fail("execution-mismatch");
  const previousRun={...run,execution_revision:record.fromRevision,execution_evidence_hash:record.previousExecutionHash};
  await assertStorageExecutionRevision(ops,previousRun,record.fromRevision);
  const recovery=await verified(parse<StorageHistoryIndexRecovery>(await read(ops,storageHistoryIndexRecoveryKey(run.id,record.fromRevision))));
  if(recovery.evidenceHash!==record.recoveryEvidenceHash||await storageHash(recovery.amendment)!==record.amendmentHash)fail("original-amendment-mismatch");
  let selected=plan;
  for(let depth=0;selected.planHash!==record.planHash;depth++) {
    if(depth>=32||!selected.predecessorPlanHash)fail("plan-lineage-missing");
    const parent=parse<StoragePopulationPlan>(await read(ops,`storage-population-plan:${run.id}:${selected.predecessorPlanHash}`));
    const {planHash:childHash,...childFields}=selected,{planHash:parentHash,...parentFields}=parent;
    if(await storageHash(childFields)!==childHash||await storageHash(parentFields)!==parentHash||parentHash!==selected.predecessorPlanHash
      ||parent.codeRevision!==plan.codeRevision||selected.codeRevision!==plan.codeRevision||parent.sessionDate>=selected.sessionDate
      ||!await same(parent.capture,selected.capture)||!await same(parent.tickers,selected.tickers)||!await same(parent.calendarDates,selected.calendarDates)
      ||parent.sourceSnapshotHash!==selected.sourceSnapshotHash||parent.sourcePreflightHash!==selected.sourcePreflightHash||parent.originalCopyCaptureHash!==selected.originalCopyCaptureHash)fail("plan-lineage-mismatch");
    selected=parent;
  }
  const previousPlan=parse<StoragePopulationPlan>(await read(ops,`storage-population-plan:${run.id}:${record.previousPlanHash}`));
  const {planHash:oldHash,...oldFields}=previousPlan,{planHash:currentHash,...currentFields}=selected;
  if(oldHash!==record.previousPlanHash||await storageHash(oldFields)!==oldHash||await storageHash(currentFields)!==currentHash
    ||previousPlan.codeRevision!==record.fromRevision||!await same({...oldFields,codeRevision:plan.codeRevision,predecessorPlanHash:oldHash,createdAt:selected.createdAt},currentFields)
    ||record.originalOwner.checkpoint_key!=="bootstrap:owner"||record.originalOwner.input_hash!==oldHash)fail("plan-integrity");
  return {previousRun,previousPlan,amendmentHash:record.amendmentHash};
}

export async function approveStorageIndexLoaderContinuation(input:{ops:D1Database;source:D1Database;target:D1Database;history:D1Database;
  migrationId:string;fromRevision:string;codeRevision:string;expectedPlanHash:string;changedFiles:string[];diffHash:string;codeContract:StorageIndexLoaderCodeContract;
  assertReviewedCheckout:()=>Promise<void>;assertNoWorkflowWriters:()=>Promise<void>;
  measurePhysical:()=>Promise<{targetBytes:number;historyBytes:number;measuredAt:string}>;now?:Date;
}):Promise<{execution:StorageExecutionRecord;plan:StoragePopulationPlan;continuation:Continuation}> {
  const parsed=codeSchema.safeParse(input.codeContract),now=input.now??new Date(),stamp=now.toISOString(),ops=input.ops;
  if(!parsed.success||input.fromRevision!==STORAGE_INDEX_LOADER_PREVIOUS_REVISION||parsed.data.fromRevision!==input.fromRevision
    ||parsed.data.codeRevision!==input.codeRevision||input.codeRevision===input.fromRevision||!hash.safeParse(input.diffHash).success||!hash.safeParse(input.expectedPlanHash).success)fail("code-contract-invalid");
  await verified(parsed.data);await input.assertReviewedCheckout();await input.assertNoWorkflowWriters();
  const run=await loadStorageMigration(ops,input.migrationId);if(!run)fail("migration-missing");
  if(run.execution_revision===input.codeRevision) {
    const {bootstrapInputs:_derived,sizingHash:_size,...plan}=await loadStorageValidationPlan(ops,run),continuation=await verified(parse<Continuation>(await read(ops,storageIndexLoaderContinuationKey(run.id,input.codeRevision))));
    const execution=await assertStorageExecutionRevision(ops,run,input.codeRevision);
    if(!execution||execution.diffHash!==input.diffHash||continuation.previousPlanHash!==input.expectedPlanHash||!await same(continuation.codeContract,input.codeContract))fail("replay-conflict");
    const amendment=await loadStorageHistoryIndexAmendment(ops,run,plan);if(!amendment)fail("original-amendment-missing");
    await assertStorageVerificationCapture(input.source,storageMigrationIdentity(run),plan.capture.sourceCapture);
    await releaseStorageVerificationFence(input.target,storageMigrationIdentity(run),plan.capture.targetCapture);
    await releaseStorageHistoryVerificationFence(input.history,storageMigrationIdentity(run),plan.capture.historyCapture,amendment);
    return {execution,plan,continuation};
  }
  if(!["retrying","awaiting-evidence"].includes(run.status)||run.stage!=="bootstrap"||run.error_code!=="storage-history-index-recovery-amendment-integrity"
    ||run.freeze_authorized!==1||!run.freeze_evidence_hash||run.dispatch_token||run.lease_until&&run.lease_until>stamp)fail("failed-loader-state-required");
  const priorExecution=await assertStorageExecutionRevision(ops,run,input.fromRevision);if(!priorExecution)fail("prior-execution-required");
  const {bootstrapInputs:_derived,sizingHash:_size,...previous}=await loadStorageValidationPlan(ops,run);
  if(previous.planHash!==input.expectedPlanHash)fail("selected-plan-mismatch");
  const recoveryText=await read(ops,storageHistoryIndexRecoveryKey(run.id,input.fromRevision)),recovery=await verified(parse<StorageHistoryIndexRecovery>(recoveryText));
  const amendment=await loadStorageHistoryIndexAmendment(ops,run,previous);if(!amendment||!await same(amendment,recovery.amendment))fail("original-amendment-missing");
  const baselineText=await read(ops,`storage-history-index-baseline:${run.id}:${input.fromRevision}`),baseline=await verified(parse<{evidenceHash:string;targetRevision:number;inputClock:number}>(baselineText));
  if(baseline.evidenceHash!==recovery.baselineHash)fail("original-baseline-mismatch");
  const eod=await ops.prepare("SELECT * FROM eod_runs WHERE id=?").bind(`eod:active:${previous.sessionDate}:daily`).first<EodRun>();
  const progress=eod?parse<{chunk:number;symbols:number;total:number}>(eod.progress_json):null;
  if(!eod||eod.status!=="queued"||eod.mode!=="active"||eod.stage!=="prices"||eod.purpose!=="daily"||eod.error_code!==null||eod.error_message!==null
    ||eod.next_attempt_at!==null||eod.dispatch_token||eod.lease_until&&eod.lease_until>stamp||!await same(parse(eod.input_json),previous.inputs)
    ||progress?.chunk!==0||progress.symbols!==0||progress.total!==Math.ceil(previous.tickers.length/25))fail("untouched-bootstrap-required");
  const checkpoints=(await ops.prepare("SELECT checkpoint_key,input_hash,payload_json,updated_at FROM market_storage_checkpoints WHERE migration_id=? ORDER BY checkpoint_key LIMIT 129")
    .bind(run.id).all<Checkpoint>()).results,owner=checkpoints.find(row=>row.checkpoint_key==="bootstrap:owner");
  if(checkpoints.length>128||!owner||owner.input_hash!==previous.planHash||checkpoints.some(row=>row.checkpoint_key.startsWith("bootstrap")&&row.checkpoint_key!=="bootstrap:owner")
    ||!await same(parse(owner.payload_json),{runId:eod.id,sessionDate:previous.sessionDate,targetDatabaseId:run.target_database_id}))fail("owner-or-checkpoints-changed");
  const consumers=checkpoints.find(row=>row.checkpoint_key==="consumer-parity:complete");
  if(!consumers||consumers.input_hash!==previous.capture.captureHash)fail("consumer-proof-missing");
  await validateStorageConsumerEvidence(parse<StorageConsumerEvidence>(consumers.payload_json),previous.capture,previous.tickers);
  const originalCheckpoints=checkpoints.map(row=>row.checkpoint_key==="bootstrap:owner"?recovery.originalOwner:row);
  if(originalCheckpoints.length!==priorExecution.checkpointCount||await storageHash(originalCheckpoints)!==priorExecution.checkpointManifestHash)fail("original-checkpoint-manifest-changed");
  const proveUnchanged=async()=>{
    await input.assertNoWorkflowWriters();
    if(await ops.prepare(`SELECT 1 AS unsafe WHERE EXISTS(SELECT 1 FROM eod_checkpoints WHERE run_id=?) OR EXISTS(SELECT 1 FROM eod_runs WHERE lease_until>?)
      OR EXISTS(SELECT 1 FROM market_storage_migrations WHERE lease_until>? OR status IN ('dispatching','dispatched')
        OR (dispatch_token IS NOT NULL AND status NOT IN ('completed','aborted')))` ).bind(eod.id,stamp,stamp).first())fail("writer-or-feature-checkpoint-present");
    await assertStorageVerificationCapture(input.source,storageMigrationIdentity(run),previous.capture.sourceCapture);
    await releaseStorageVerificationFence(input.target,storageMigrationIdentity(run),previous.capture.targetCapture);
    const target=await input.target.prepare(`SELECT f.revision AS revision,c.revision AS inputClock FROM market_storage_fence f
      JOIN eod_input_clock c ON c.id='default' WHERE f.id='default'`).first<{revision:number;inputClock:number}>();
    if(target?.revision!==baseline.targetRevision||target.inputClock!==baseline.inputClock)fail("target-inputs-changed");
    if(await input.target.prepare("SELECT scope FROM eod_publication_pointers LIMIT 1").first())fail("publication-present");
    for(const scope of [...EOD_PUBLICATION_SCOPES,EOD_CATALOG_SCOPE])if(await input.target.prepare("SELECT id FROM eod_publications WHERE scope=? AND status='accepted' LIMIT 1").bind(scope).first())fail("publication-present");
    const history=await inspectStorageHistoryPointerIndexSchema(input.history,storageMigrationIdentity(run),previous.capture.historyCapture,{historyDatabaseId:run.history_database_id,policy:"indexed"});
    const ledger=await input.history.prepare("SELECT id,name,applied_at FROM d1_migrations WHERE name=?").bind("0003_history_pointer_indexes.sql").first<{id:number;name:string;applied_at:string}>();
    const appliedAt=ledger?.applied_at.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)$/,"$1T$2Z");
    if(history.schemaHash!==amendment.schemaHash||history.indexManifestHash!==amendment.indexManifestHash||history.snapshotRevision!==amendment.snapshotRevision
      ||history.revision!==amendment.revision+1||!ledger||!Number.isSafeInteger(ledger.id)||!appliedAt||!Number.isFinite(Date.parse(appliedAt))
      ||Date.parse(appliedAt)<Date.parse(recovery.approvedAt)||Date.parse(appliedAt)>(input.now??new Date()).getTime())fail("history-ledger-only-change-required");
    return {target,history,ledger};
  };
  const measured=await proveUnchanged(),physical=await input.measurePhysical(),physicalAge=(input.now??new Date()).getTime()-Date.parse(physical.measuredAt);
  if(!Number.isFinite(physicalAge)||physicalAge<0||physicalAge>300_000||![physical.targetBytes,physical.historyBytes].every(value=>Number.isSafeInteger(value)&&value>0&&value<350_000_000))fail("capacity-unavailable");
  const [pointerText,previousText,sizingText]=await Promise.all([read(ops,`storage-population-current:${run.id}`),read(ops,`storage-population-plan:${run.id}:${previous.planHash}`),read(ops,`storage-population-sizing:${previous.planHash}`)]);
  if(pointerText!==JSON.stringify({planHash:previous.planHash})||!previousText||!sizingText||!await same(parse(previousText),previous))fail("plan-record-mismatch");
  const {planHash:_hash,...oldFields}=previous,planFields={...oldFields,predecessorPlanHash:previous.planHash,codeRevision:input.codeRevision,createdAt:stamp};
  const plan={...planFields,planHash:await storageHash(planFields)},sizing={...parse<Record<string,unknown>>(sizingText),planHash:plan.planHash};
  const checkpointManifestHash=await storageHash(checkpoints),executionFields={...priorExecution,fromRevision:input.fromRevision,codeRevision:input.codeRevision,
    predecessorHash:priorExecution.evidenceHash,checkpointCount:checkpoints.length,checkpointManifestHash,changedFiles:[...input.changedFiles].sort(),diffHash:input.diffHash,approvedAt:stamp};
  const {evidenceHash:_oldExecution,...unsignedExecution}=executionFields,execution={...unsignedExecution,evidenceHash:await storageHash(unsignedExecution)};
  const fields={version:1 as const,policy:"preserve-approved-index-amendment-loader-fix-v1" as const,migrationId:run.id,fromRevision:input.fromRevision,codeRevision:input.codeRevision,
    previousPlanHash:previous.planHash,planHash:plan.planHash,previousExecutionHash:priorExecution.evidenceHash,executionHash:execution.evidenceHash,
    recoveryEvidenceHash:recovery.evidenceHash,amendmentHash:await storageHash(amendment),codeContract:input.codeContract,checkpointManifestHash,originalOwner:owner,
    eodRunHash:await storageHash(eod),targetRevision:measured.target.revision,inputClock:measured.target.inputClock,historyRevision:measured.history.revision,
    ledger:measured.ledger,physical,approvedAt:stamp};
  const continuation={...fields,evidenceHash:await storageHash(fields)};
  await input.assertReviewedCheckout();if(!await same(await proveUnchanged(),measured))fail("capture-changed");
  const records=[{id:storageIndexLoaderContinuationKey(run.id,input.codeRevision),value:continuation},{id:storageExecutionKey(run.id,input.codeRevision),value:execution},
    {id:`storage-population-plan:${run.id}:${plan.planHash}`,value:plan},{id:`storage-population-sizing:${plan.planHash}`,value:sizing}].map(row=>({id:row.id,payload:JSON.stringify(row.value)}));
  const queries:Array<{sql:string;params:unknown[]}>=[];
  queries.push({sql:`SELECT CASE WHEN EXISTS(SELECT 1 FROM market_storage_migrations WHERE id=? AND updated_at=? AND status=? AND stage='bootstrap'
      AND error_code='storage-history-index-recovery-amendment-integrity' AND COALESCE(execution_revision,code_revision)=? AND execution_evidence_hash=?
      AND (lease_until IS NULL OR lease_until<=?) AND dispatch_token IS NULL)
    AND EXISTS(SELECT 1 FROM eod_runs WHERE id=? AND updated_at=? AND status='queued' AND stage='prices' AND input_json=? AND progress_json=?
      AND error_code IS NULL AND error_message IS NULL AND next_attempt_at IS NULL AND (lease_until IS NULL OR lease_until<=?) AND dispatch_token IS NULL)
    AND NOT EXISTS(SELECT 1 FROM eod_checkpoints WHERE run_id=?) AND NOT EXISTS(SELECT 1 FROM eod_runs WHERE lease_until>?)
    AND NOT EXISTS(SELECT 1 FROM market_storage_migrations WHERE lease_until>? OR status IN ('dispatching','dispatched') OR (dispatch_token IS NOT NULL AND status NOT IN ('completed','aborted')))
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=? AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=?
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=? AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=?
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=? AND (SELECT COUNT(*) FROM market_storage_checkpoints WHERE migration_id=?)=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN market_storage_checkpoints actual ON actual.migration_id=? AND actual.checkpoint_key=json_extract(expected.value,'$[0]')
      WHERE actual.checkpoint_key IS NULL OR actual.input_hash<>json_extract(expected.value,'$[1]') OR actual.payload_json<>json_extract(expected.value,'$[2]') OR actual.updated_at<>json_extract(expected.value,'$[3]'))
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected JOIN eod_rollout_evidence actual ON actual.id=json_extract(expected.value,'$.id') WHERE actual.evidence_json<>json_extract(expected.value,'$.payload'))
    THEN 1 ELSE json_extract('storage-index-loader-continuation-guard-rejected','$') END AS accepted`,params:[run.id,run.updated_at,run.status,input.fromRevision,priorExecution.evidenceHash,stamp,
      eod.id,eod.updated_at,eod.input_json,eod.progress_json,stamp,eod.id,stamp,stamp,`storage-population-current:${run.id}`,pointerText,
      `storage-population-plan:${run.id}:${previous.planHash}`,previousText,`storage-population-sizing:${previous.planHash}`,sizingText,
      storageHistoryIndexRecoveryKey(run.id,input.fromRevision),recoveryText,`storage-history-index-baseline:${run.id}:${input.fromRevision}`,baselineText,
      run.id,checkpoints.length,JSON.stringify(checkpoints.map(row=>[row.checkpoint_key,row.input_hash,row.payload_json,row.updated_at])),run.id,JSON.stringify(records)]});
  for(const row of records)queries.push({sql:"INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",params:[row.id,row.payload,stamp]});
  queries.push({sql:"UPDATE eod_rollout_evidence SET evidence_json=?,updated_at=? WHERE id=? AND evidence_json=? RETURNING id",params:[JSON.stringify({planHash:plan.planHash}),stamp,`storage-population-current:${run.id}`,pointerText]});
  queries.push({sql:"UPDATE market_storage_checkpoints SET input_hash=? WHERE migration_id=? AND checkpoint_key='bootstrap:owner' AND input_hash=? RETURNING checkpoint_key",params:[plan.planHash,run.id,previous.planHash]});
  queries.push({sql:`UPDATE market_storage_migrations SET execution_revision=?,execution_evidence_hash=?,status='awaiting-evidence',error_code='storage-execution-github-pin-required',
    lease_token=NULL,lease_until=NULL,next_attempt_at=NULL,updated_at=? WHERE id=? AND updated_at=? RETURNING id`,params:[input.codeRevision,execution.evidenceHash,stamp,run.id,run.updated_at]});
  if(new TextEncoder().encode(JSON.stringify({batch:queries})).length>8_000_000)fail("transaction-payload-exceeds-bound");
  const results=await ops.batch(queries.map(row=>ops.prepare(row.sql).bind(...row.params)));
  if(results.slice(-3).some(row=>row.results.length!==1))fail("promotion-conflict");
  const latest=await loadStorageMigration(ops,run.id);if(!latest||!await loadStorageHistoryIndexAmendment(ops,latest,plan))fail("readback-conflict");
  return {execution,plan,continuation};
}
