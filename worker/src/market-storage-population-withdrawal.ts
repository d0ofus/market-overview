import { z } from "zod";
import { loadStorageMigration, storageMigrationIdentity } from "./market-storage-control";
import { assertStorageExecutionRevision } from "./market-storage-execution";
import { loadStoragePopulationPlan } from "./market-storage-population-plan";
import { assertStorageVerificationCapture } from "./market-storage-verification";
import { storageHash } from "./market-storage-pages";

const hash=z.string().regex(/^[a-f0-9]{64}$/),sha=z.string().regex(/^[a-f0-9]{40}$/);
const identity=z.object({id:z.string(),sourceDatabaseId:z.string().uuid(),targetDatabaseId:z.string().uuid(),
  historyDatabaseId:z.string().uuid(),sessionDate:z.string(),codeRevision:sha}).strict();
const captured=z.object({schemaHash:hash,revision:z.number().int().nonnegative().safe()}).strict();
const unsignedSchema=z.object({version:z.literal(1),policy:z.literal("withdraw-unbootstrapped-population-v1"),
  identity,executionRevision:sha,withdrawalRevision:sha,planHash:hash,planJsonHash:hash,sizingJsonHash:hash.nullable(),
  originalCopyCaptureHash:hash,runUpdatedAt:z.string(),withdrawnAt:z.string().datetime({offset:true}),
  capture:z.object({identity,captureHash:hash,sourceCapture:captured,targetCapture:captured,historyCapture:captured}).strict(),
}).strict();
const recordSchema=unsignedSchema.extend({evidenceHash:hash}).strict();
export type StoragePopulationWithdrawal=z.infer<typeof recordSchema>;
export const storagePopulationWithdrawalKey=(migrationId:string,planHash:string)=>`storage-population-withdrawal:${migrationId}:${planHash}`;
function fail(reason:string):never {throw new Error(`storage-population-withdrawal-${reason}`);}
const evidence=(ops:D1Database,id:string)=>ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(id).first<string>("evidence_json");

/** Explicit pre-bootstrap recovery only. The selected immutable plan remains
 * evidence of its original capture; only its mutable selection is withdrawn.
 * No run, price, capture, checkpoint, sizing or publication is modified. */
export async function withdrawStoragePopulationPlan(input:{
  ops:D1Database;source:D1Database;target:D1Database;history:D1Database;migrationId:string;expectedPlanHash:string;
  executionRevision:string;withdrawalRevision:string;assertReviewedCheckout:()=>Promise<void>;
  assertNoWorkflowWriters:()=>Promise<void>;now?:Date;
}):Promise<{status:"withdrawn"|"already-withdrawn";record:StoragePopulationWithdrawal}> {
  if(!hash.safeParse(input.expectedPlanHash).success || !sha.safeParse(input.executionRevision).success
    || !sha.safeParse(input.withdrawalRevision).success || input.executionRevision===input.withdrawalRevision) fail("identity-invalid");
  const now=input.now ?? new Date(),timestamp=now.toISOString(),ops=input.ops;
  await input.assertReviewedCheckout();await input.assertNoWorkflowWriters();
  const run=await loadStorageMigration(ops,input.migrationId);
  if(!run || run.status!=="awaiting-evidence" || run.stage!=="population-inputs"
    || run.error_code!=="storage-population-sizing-required" || run.lease_token!==null || run.lease_until!==null
    || run.dispatch_token!==null || run.freeze_authorized!==1 || !run.freeze_evidence_hash
    || !run.source_schema_hash || run.source_revision===null) fail("state-not-withdrawable");
  await assertStorageExecutionRevision(ops,run,input.executionRevision);
  const currentKey=`storage-population-current:${run.id}`,planKey=`storage-population-plan:${run.id}:${input.expectedPlanHash}`;
  const sizingKey=`storage-population-sizing:${input.expectedPlanHash}`,auditKey=storagePopulationWithdrawalKey(run.id,input.expectedPlanHash);
  const currentText=await evidence(ops,currentKey),planText=await evidence(ops,planKey),sizingText=await evidence(ops,sizingKey);
  const auditText=await evidence(ops,auditKey);
  if(!planText) fail("plan-missing");
  let retained:StoragePopulationWithdrawal|null=null;
  if(auditText!==null) {
    let value:unknown;try {value=JSON.parse(auditText);}catch {fail("audit-invalid");}
    const parsed=recordSchema.safeParse(value);if(!parsed.success)fail("audit-invalid");
    const {evidenceHash,...unsigned}=parsed.data;
    const {captureHash,...captureFields}=unsigned.capture;
    if(await storageHash(unsigned)!==evidenceHash || unsigned.planHash!==input.expectedPlanHash
      || unsigned.executionRevision!==input.executionRevision || unsigned.withdrawalRevision!==input.withdrawalRevision
      || unsigned.runUpdatedAt!==run.updated_at || await storageHash(unsigned.identity)!==await storageHash(storageMigrationIdentity(run))
      || unsigned.planJsonHash!==await storageHash(planText) || unsigned.sizingJsonHash!==(sizingText===null ? null : await storageHash(sizingText))
      || captureHash!==await storageHash(captureFields) || await storageHash(unsigned.capture.identity)!==await storageHash(unsigned.identity)
      || unsigned.capture.sourceCapture.schemaHash!==run.source_schema_hash || unsigned.capture.sourceCapture.revision!==run.source_revision) fail("audit-conflict");
    retained=parsed.data;
  }
  let record:StoragePopulationWithdrawal;
  if(currentText===null) {
    if(!retained)fail("selected-plan-required");
    record=retained;
  } else {
    const plan=await loadStoragePopulationPlan(ops,run);
    if(!plan || plan.planHash!==input.expectedPlanHash || currentText!==JSON.stringify({planHash:input.expectedPlanHash})) fail("selected-plan-mismatch");
    const unsigned=unsignedSchema.parse({version:1,policy:"withdraw-unbootstrapped-population-v1",identity:storageMigrationIdentity(run),
      executionRevision:input.executionRevision,withdrawalRevision:input.withdrawalRevision,planHash:plan.planHash,
      planJsonHash:await storageHash(planText),sizingJsonHash:sizingText===null ? null : await storageHash(sizingText),
      originalCopyCaptureHash:plan.originalCopyCaptureHash,runUpdatedAt:run.updated_at,withdrawnAt:timestamp,capture:plan.capture});
    record=retained ?? {...unsigned,evidenceHash:await storageHash(unsigned)};
    if(retained && (await storageHash(retained.capture)!==await storageHash(plan.capture)
      || retained.originalCopyCaptureHash!==plan.originalCopyCaptureHash)) fail("audit-conflict");
  }
  const assertSafe=async()=>{
    const unsafe=await ops.prepare(`SELECT 1 AS unsafe WHERE
      EXISTS(SELECT 1 FROM market_storage_checkpoints WHERE migration_id=? AND checkpoint_key>='bootstrap:' AND checkpoint_key<'bootstrap;')
      OR EXISTS(SELECT 1 FROM market_storage_checkpoints WHERE migration_id=? AND checkpoint_key>='consumer-parity:' AND checkpoint_key<'consumer-parity;')
      OR EXISTS(SELECT 1 FROM market_storage_migrations WHERE lease_until>? OR status IN ('dispatching','dispatched')
        OR (dispatch_token IS NOT NULL AND status NOT IN ('completed','aborted')))
      OR EXISTS(SELECT 1 FROM eod_runs WHERE lease_until>?)`).bind(run.id,run.id,timestamp,timestamp).first();
    if(unsafe)fail("writer-or-validation-present");
    await assertStorageVerificationCapture(input.source,record.identity,record.capture.sourceCapture);
    await assertStorageVerificationCapture(input.target,record.identity,record.capture.targetCapture);
    await assertStorageVerificationCapture(input.history,record.identity,record.capture.historyCapture);
  };
  await assertSafe();await input.assertReviewedCheckout();await input.assertNoWorkflowWriters();await assertSafe();
  if(currentText===null) {
    if(await evidence(ops,currentKey)!==null || await evidence(ops,auditKey)!==auditText)fail("replay-conflict");
    return {status:"already-withdrawn",record};
  }
  const guard=`EXISTS(SELECT 1 FROM market_storage_migrations m WHERE m.id=? AND m.updated_at=?
      AND m.status='awaiting-evidence' AND m.stage='population-inputs' AND m.error_code='storage-population-sizing-required'
      AND m.code_revision=? AND COALESCE(m.execution_revision,m.code_revision)=? AND m.execution_evidence_hash IS ?
      AND m.freeze_authorized=1 AND m.freeze_evidence_hash=? AND m.source_schema_hash=? AND m.source_revision=?
      AND m.source_database_id=? AND m.target_database_id=? AND m.history_database_id=?
      AND m.lease_token IS NULL AND m.lease_until IS NULL AND m.dispatch_token IS NULL)
    AND NOT EXISTS(SELECT 1 FROM market_storage_checkpoints WHERE migration_id=? AND checkpoint_key>='bootstrap:' AND checkpoint_key<'bootstrap;')
    AND NOT EXISTS(SELECT 1 FROM market_storage_checkpoints WHERE migration_id=? AND checkpoint_key>='consumer-parity:' AND checkpoint_key<'consumer-parity;')
    AND NOT EXISTS(SELECT 1 FROM market_storage_migrations WHERE lease_until>? OR status IN ('dispatching','dispatched')
      OR (dispatch_token IS NOT NULL AND status NOT IN ('completed','aborted')))
    AND NOT EXISTS(SELECT 1 FROM eod_runs WHERE lease_until>?)
    AND EXISTS(SELECT 1 FROM eod_rollout_evidence WHERE id=? AND evidence_json=?)
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?) IS ?`;
  const params=[run.id,run.updated_at,run.code_revision,input.executionRevision,run.execution_evidence_hash ?? null,
    run.freeze_evidence_hash,run.source_schema_hash,run.source_revision,run.source_database_id,run.target_database_id,run.history_database_id,
    run.id,run.id,timestamp,timestamp,planKey,planText,sizingKey,sizingText];
  const payload=JSON.stringify(record);
  const results=await ops.batch([
    ops.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) SELECT ?,?,? WHERE ${guard}
      AND EXISTS(SELECT 1 FROM eod_rollout_evidence WHERE id=? AND evidence_json=?)
      ON CONFLICT(id) DO NOTHING /* eod-population-withdrawal */`)
      .bind(auditKey,payload,record.withdrawnAt,...params,currentKey,currentText),
    ops.prepare(`DELETE FROM eod_rollout_evidence WHERE id=? AND evidence_json=? AND ${guard}
      AND EXISTS(SELECT 1 FROM eod_rollout_evidence WHERE id=? AND evidence_json=?) RETURNING id /* eod-population-withdrawal */`)
      .bind(currentKey,currentText,...params,auditKey,payload),
  ]);
  if(results[1]?.results.length!==1)fail("promotion-conflict");
  if(await evidence(ops,currentKey)!==null || await evidence(ops,auditKey)!==payload)fail("readback-conflict");
  return {status:"withdrawn",record};
}
