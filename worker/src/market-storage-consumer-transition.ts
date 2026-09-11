import { z } from "zod";
import { storageHash } from "./market-storage-pages";
import { loadStorageMigration, storageMigrationIdentity, type StorageMigrationRun } from "./market-storage-control";
import { assertStorageExecutionRevision, storageExecutionKey, validateStorageExecutionEvidence, type StorageExecutionRecord } from "./market-storage-execution";
import { loadStorageValidationPlan, type StoragePopulationPlan } from "./market-storage-population-plan";
import { assertStorageVerificationCapture } from "./market-storage-verification";

const hash = z.string().regex(/^[a-f0-9]{64}$/), sha = z.string().regex(/^[a-f0-9]{40}$/);
const codeSchema = z.object({ version:z.literal(1),policy:z.literal("unchanged-consumers-bootstrap-body-v1"),fromRevision:sha,codeRevision:sha,
  protectedFileCount:z.number().int().min(3).max(20_000),protectedManifestHash:hash,runnerContractHash:hash,
  oldBootstrapBodyHash:hash,newBootstrapBodyHash:hash,operatorChangesHash:hash,beforeTreeHash:hash,afterTreeHash:hash,evidenceHash:hash }).strict();
export type StorageConsumerCodeContract = z.infer<typeof codeSchema>;
type Checkpoint = {checkpoint_key:string;input_hash:string;payload_json:string;updated_at:string};
export type StorageConsumerExecutionContinuation = {
  version:1;policy:"preserve-verified-consumers-before-bootstrap-v1";migrationId:string;fromRevision:string;codeRevision:string;
  previousPlanHash:string;planHash:string;previousPlanJsonHash:string;previousSizingJsonHash:string;
  captureHash:string;originalCopyCaptureHash:string;checkpointCount:number;checkpointManifestHash:string;
  codeContract:StorageConsumerCodeContract;executionEvidenceHash:string;continuedAt:string;evidenceHash:string;
};
export const storageConsumerContinuationKey = (id:string,revision:string) => `storage-consumer-continuation:${id}:${revision}`;
function fail(reason:string):never {throw new Error(`storage-consumer-transition-${reason}`);}
const read = (ops:D1Database,id:string) => ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(id).first<string>("evidence_json");
const same = async (a:unknown,b:unknown) => await storageHash(a) === await storageHash(b);

/** A separate policy from generic execution approval. Git must prove unchanged
 * consumer/input/schema implementation; all three price stores must still have
 * their exact frozen captures. Only future bootstrap behavior is changed.
 * Original plans, measurements, copy proof and consumer checkpoints are retained
 * byte-for-byte. The new plan records a new execution decision, not a new read. */
export async function approveStorageConsumerExecutionTransition(input:{
  ops:D1Database;source:D1Database;target:D1Database;history:D1Database;migrationId:string;
  fromRevision:string;codeRevision:string;expectedPlanHash:string;changedFiles:string[];diffHash:string;
  codeContract:StorageConsumerCodeContract;assertReviewedCheckout:()=>Promise<void>;assertNoWorkflowWriters:()=>Promise<void>;now?:Date;
}):Promise<{execution:StorageExecutionRecord;continuation:StorageConsumerExecutionContinuation;plan:StoragePopulationPlan}> {
  const now=input.now ?? new Date(),timestamp=now.toISOString(),ops=input.ops;
  const parsed=codeSchema.safeParse(input.codeContract);
  if(!parsed.success || !hash.safeParse(input.diffHash).success || !hash.safeParse(input.expectedPlanHash).success
    || parsed.data.fromRevision!==input.fromRevision || parsed.data.codeRevision!==input.codeRevision
    || input.fromRevision===input.codeRevision || !input.changedFiles.includes("worker/src/eod-runner.ts")) fail("code-contract-invalid");
  const {evidenceHash:codeHash,...codeUnsigned}=parsed.data;
  if(await storageHash(codeUnsigned)!==codeHash || parsed.data.oldBootstrapBodyHash===parsed.data.newBootstrapBodyHash) fail("code-contract-integrity");
  await input.assertReviewedCheckout();await input.assertNoWorkflowWriters();
  const run=await loadStorageMigration(ops,input.migrationId);
  if(!run || !["queued","retrying","running","awaiting-evidence"].includes(run.status) || run.stage!=="consumer-parity"
    || run.freeze_authorized!==1 || !run.freeze_evidence_hash || !run.source_schema_hash || run.source_revision===null) fail("state-not-transitionable");
  const currentKey=`storage-population-current:${run.id}`,auditKey=storageConsumerContinuationKey(run.id,input.codeRevision);
  const existing=await read(ops,auditKey);
  if(run.execution_revision===input.codeRevision) {
    if(!existing) fail("continuation-required");
    let audit:StorageConsumerExecutionContinuation;try {audit=JSON.parse(existing);}catch {fail("continuation-invalid");}
    const {evidenceHash,...unsigned}=audit;
    if(audit.version!==1 || audit.policy!=="preserve-verified-consumers-before-bootstrap-v1" || await storageHash(unsigned)!==evidenceHash
      || audit.migrationId!==run.id || audit.fromRevision!==input.fromRevision || audit.codeRevision!==input.codeRevision
      || audit.previousPlanHash!==input.expectedPlanHash || !await same(audit.codeContract,input.codeContract)) fail("continuation-conflict");
    const execution=await assertStorageExecutionRevision(ops,run,input.codeRevision);
    if(!execution || execution.evidenceHash!==audit.executionEvidenceHash || execution.diffHash!==input.diffHash) fail("execution-conflict");
    const {bootstrapInputs:_bootstrap,sizingHash:_sizing,...plan}=await loadStorageValidationPlan(ops,run);
    if(plan.planHash!==audit.planHash || plan.capture.captureHash!==audit.captureHash) fail("plan-changed");
    await assertFrozen(input,run,plan);await assertNoBootstrap(ops,run,timestamp);
    return {execution,continuation:audit,plan};
  }
  await assertStorageExecutionRevision(ops,run,input.fromRevision);
  const {bootstrapInputs:_inputs,sizingHash:_sizing,...previous}=await loadStorageValidationPlan(ops,run);
  if(previous.planHash!==input.expectedPlanHash) fail("selected-plan-mismatch");
  const previousKey=`storage-population-plan:${run.id}:${previous.planHash}`,previousSizingKey=`storage-population-sizing:${previous.planHash}`;
  const [pointerText,previousText,sizingText]=await Promise.all([read(ops,currentKey),read(ops,previousKey),read(ops,previousSizingKey)]);
  if(pointerText!==JSON.stringify({planHash:previous.planHash}) || !previousText || !sizingText
    || !await same(JSON.parse(previousText),previous)) fail("selected-plan-conflict");
  const checkpoints=(await ops.prepare(`SELECT checkpoint_key,input_hash,payload_json,updated_at FROM market_storage_checkpoints
    WHERE migration_id=? ORDER BY checkpoint_key LIMIT 129`).bind(run.id).all<Checkpoint>()).results;
  if(!checkpoints.length || checkpoints.length>128 || !checkpoints.some(row=>row.checkpoint_key.startsWith("consumer-parity:"))
    || checkpoints.some(row=>row.checkpoint_key.startsWith("bootstrap"))) fail("checkpoint-bound-or-stage");
  let checkpointManifestHash=await storageHash([]);
  for(const row of checkpoints) checkpointManifestHash=await storageHash([checkpointManifestHash,row.checkpoint_key,row.input_hash,await storageHash(row.payload_json)]);
  const {planHash:_oldHash,...previousFields}=previous;
  const planUnsigned={...previousFields,codeRevision:input.codeRevision,createdAt:timestamp};
  const plan:StoragePopulationPlan={...planUnsigned,planHash:await storageHash(planUnsigned)};
  // The prepared sizing object retains every original measurement date/value/hash.
  const sizing={...JSON.parse(sizingText) as Record<string,unknown>,planHash:plan.planHash};
  const unsignedExecution={version:1 as const,policy:"preserve-storage-capture-execution-v1" as const,storageIdentity:storageMigrationIdentity(run),
    fromRevision:input.fromRevision,codeRevision:input.codeRevision,predecessorHash:run.execution_evidence_hash ?? null,
    sourceCapture:previous.capture.sourceCapture,freezeEvidenceHash:run.freeze_evidence_hash,checkpointCount:checkpoints.length,checkpointManifestHash,
    changedFiles:[...input.changedFiles].sort(),diffHash:input.diffHash,approvedAt:timestamp,
    storagePolicy:{hotSessions:90 as const,marketBytes:350_000_000 as const,archiveBytes:350_000_000 as const,databaseCount:10 as const,accountBytes:5_000_000_000 as const}};
  const execution:StorageExecutionRecord={...unsignedExecution,evidenceHash:await storageHash(unsignedExecution)};
  const unsignedAudit={version:1 as const,policy:"preserve-verified-consumers-before-bootstrap-v1" as const,migrationId:run.id,
    fromRevision:input.fromRevision,codeRevision:input.codeRevision,previousPlanHash:previous.planHash,planHash:plan.planHash,
    previousPlanJsonHash:await storageHash(previousText),previousSizingJsonHash:await storageHash(sizingText),
    captureHash:previous.capture.captureHash,originalCopyCaptureHash:previous.originalCopyCaptureHash,
    checkpointCount:checkpoints.length,checkpointManifestHash,codeContract:input.codeContract,executionEvidenceHash:execution.evidenceHash,continuedAt:timestamp};
  const continuation={...unsignedAudit,evidenceHash:await storageHash(unsignedAudit)};
  const candidateRun={...run,execution_revision:input.codeRevision,execution_evidence_hash:execution.evidenceHash};
  await validateStorageExecutionEvidence(execution,candidateRun,input.codeRevision);
  await assertFrozen(input,run,previous);await assertNoBootstrap(ops,run,timestamp);
  await input.assertReviewedCheckout();await input.assertNoWorkflowWriters();
  await assertFrozen(input,run,previous);await assertNoBootstrap(ops,run,timestamp);
  const records=[{id:auditKey,value:continuation},{id:`storage-population-plan:${run.id}:${plan.planHash}`,value:plan},
    {id:`storage-population-sizing:${plan.planHash}`,value:sizing},{id:storageExecutionKey(run.id,input.codeRevision),value:execution}]
    .map(row=>({id:row.id,payload:JSON.stringify(row.value)}));
  const checkpointJson=JSON.stringify(checkpoints.map(row=>[row.checkpoint_key,row.input_hash,row.payload_json,row.updated_at]));
  const queries:Array<{sql:string;params:unknown[]}>=[];
  // D1 batch is one SQLite transaction. A malformed-JSON guard deliberately
  // aborts that entire transaction before writes when any captured state differs.
  // All manifest comparisons use the complete checkpoint PK; <=128 entries.
  queries.push({sql:`SELECT CASE WHEN
    EXISTS(SELECT 1 FROM market_storage_migrations WHERE id=? AND updated_at=? AND stage='consumer-parity'
      AND status=? AND code_revision=? AND COALESCE(execution_revision,code_revision)=? AND execution_evidence_hash IS ?
      AND freeze_authorized=1 AND freeze_evidence_hash=? AND source_schema_hash=? AND source_revision=?
      AND source_database_id=? AND target_database_id=? AND history_database_id=?
      AND (lease_until IS NULL OR lease_until<=?) AND dispatch_token IS NULL)
    AND NOT EXISTS(SELECT 1 FROM market_storage_migrations WHERE lease_until>? OR status IN ('dispatching','dispatched')
      OR (dispatch_token IS NOT NULL AND status NOT IN ('completed','aborted')))
    AND NOT EXISTS(SELECT 1 FROM eod_runs WHERE lease_until>? OR id=?)
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=?
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=?
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=?
    AND (SELECT COUNT(*) FROM market_storage_checkpoints WHERE migration_id=?)=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN market_storage_checkpoints actual
      ON actual.migration_id=? AND actual.checkpoint_key=json_extract(expected.value,'$[0]')
      WHERE actual.checkpoint_key IS NULL OR actual.input_hash<>json_extract(expected.value,'$[1]')
        OR actual.payload_json<>json_extract(expected.value,'$[2]') OR actual.updated_at<>json_extract(expected.value,'$[3]'))
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected JOIN eod_rollout_evidence actual ON actual.id=json_extract(expected.value,'$.id')
      WHERE actual.evidence_json<>json_extract(expected.value,'$.payload'))
    THEN 1 ELSE json_extract('storage-consumer-transition-guard-rejected','$') END AS accepted`,params:[
      run.id,run.updated_at,run.status,run.code_revision,input.fromRevision,run.execution_evidence_hash ?? null,
      run.freeze_evidence_hash,run.source_schema_hash,run.source_revision,run.source_database_id,run.target_database_id,run.history_database_id,
      timestamp,timestamp,timestamp,`eod:active:${previous.sessionDate}:daily`,currentKey,pointerText,previousKey,previousText,previousSizingKey,sizingText,
      run.id,checkpoints.length,checkpointJson,run.id,JSON.stringify(records)]});
  for(const record of records) queries.push({sql:"INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
    params:[record.id,record.payload,timestamp]});
  queries.push({sql:"UPDATE eod_rollout_evidence SET evidence_json=?,updated_at=? WHERE id=? AND evidence_json=? RETURNING id",
    params:[JSON.stringify({planHash:plan.planHash}),timestamp,currentKey,pointerText]});
  queries.push({sql:`UPDATE market_storage_migrations SET execution_revision=?,execution_evidence_hash=?,status='awaiting-evidence',
    error_code='storage-execution-github-pin-required',next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,updated_at=?
    WHERE id=? AND updated_at=? AND COALESCE(execution_revision,code_revision)=? RETURNING id`,
    params:[input.codeRevision,execution.evidenceHash,timestamp,run.id,run.updated_at,input.fromRevision]});
  if(new TextEncoder().encode(JSON.stringify({batch:queries})).length>8_000_000) fail("transaction-payload-exceeds-bound");
  const results=await ops.batch(queries.map(row=>ops.prepare(row.sql).bind(...row.params)));
  if(results.at(-1)?.results.length!==1 || results.at(-2)?.results.length!==1) fail("promotion-conflict");
  const saved=await loadStorageMigration(ops,run.id);
  if(!saved || (await assertStorageExecutionRevision(ops,saved,input.codeRevision))?.evidenceHash!==execution.evidenceHash
    || (await loadStorageValidationPlan(ops,saved)).planHash!==plan.planHash || await read(ops,auditKey)!==JSON.stringify(continuation)) fail("readback-conflict");
  return {execution,continuation,plan};
}

async function assertNoBootstrap(ops:D1Database,run:StorageMigrationRun,timestamp:string):Promise<void> {
  if(await ops.prepare(`SELECT 1 AS unsafe WHERE EXISTS(SELECT 1 FROM market_storage_checkpoints WHERE migration_id=?
      AND checkpoint_key>='bootstrap' AND checkpoint_key<'bootstraq')
    OR EXISTS(SELECT 1 FROM market_storage_migrations WHERE lease_until>? OR status IN ('dispatching','dispatched')
      OR (dispatch_token IS NOT NULL AND status NOT IN ('completed','aborted')))
    OR EXISTS(SELECT 1 FROM eod_runs WHERE lease_until>?)`).bind(run.id,timestamp,timestamp).first()) fail("writer-or-bootstrap-present");
}
async function assertFrozen(input:{source:D1Database;target:D1Database;history:D1Database},run:StorageMigrationRun,plan:StoragePopulationPlan):Promise<void> {
  const identity=storageMigrationIdentity(run);
  await assertStorageVerificationCapture(input.source,identity,plan.capture.sourceCapture);
  await assertStorageVerificationCapture(input.target,identity,plan.capture.targetCapture);
  await assertStorageVerificationCapture(input.history,identity,plan.capture.historyCapture);
}
