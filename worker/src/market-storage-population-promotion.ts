import { storageFeatureCheckpointComparison, assertStorageAtomicParameters } from "./market-storage-atomic-manifest";
import { loadEodInputs, type FrozenInputs } from "./eod-runner";
import { expectedEodSession, EOD_PUBLICATION_SCOPES } from "./eod-coordinator";
import { EOD_CATALOG_SCOPE } from "./eod-catalog-service";
import { loadStorageMigration, storageExecutionRevision, storageMigrationIdentity } from "./market-storage-control";
import { assertStorageExecutionRevision } from "./market-storage-execution";
import { loadStorageValidationPlan, type StoragePopulationPlan } from "./market-storage-population-plan";
import { prepareStoragePopulationExpansion, validateStoragePopulationExpansionLineage,
  type PreparedStoragePopulationExpansion } from "./market-storage-population-expansion";
import { loadStorageHistoryIndexAmendment } from "./market-storage-history-index-recovery";
import { assertStorageVerificationCapture, inspectStorageHistoryPointerIndexSchema, releaseStorageVerificationFence } from "./market-storage-verification";
import { storageHash } from "./market-storage-pages";
import { decodeEodPayload } from "./eod-publication-codec";
import type { Env } from "./types";

type ExpansionInputs = Parameters<typeof prepareStoragePopulationExpansion>[0];
type Checkpoint = { checkpoint_key: string; input_hash: string; payload_json: string; updated_at: string };
type EodRow = Record<string,string|number|null> & {id:string;input_json:string;progress_json:string};
type Pointer = {scope:string;publication_id:string;session_date:string;published_at:string};
type Receipt = {version:1;policy:"promote-completed-bootstrap-population-v1";migrationId:string;codeRevision:string;
  previousPlanHash:string;planHash:string;expansionHash:string;executionHash:string;checkpointHash:string;checkpointCount:number;
  eodRunHash:string;featureHash:string;featureCount:number;publicationHash:string;originalOwner:Checkpoint;
  targetRevision:number;inputClock:number;historyRevision:number;physical:{targetBytes:number;historyBytes:number;measuredAt:string};
  promotedAt:string;evidenceHash:string};
export const storagePopulationPromotionKey = (id:string,previous:string)=>`storage-population-promotion:${id}:${previous}`;
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:null;
const digest=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const same=async(a:unknown,b:unknown)=>await storageHash(a)===await storageHash(b);
function fail(reason:string):never {throw new Error(`storage-population-promotion-${reason}`);}
function parse<T>(text:string|null):T {try {if(!text)fail("record-missing");return JSON.parse(text) as T;}catch{return fail("record-invalid");}}
const read=(ops:D1Database,id:string)=>ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(id).first<string>("evidence_json");
export type StoragePopulationPromotionInput = {
  env:Env;source:D1Database;migrationId:string;expectedPlanHash:string;
  deltaCapture:ExpansionInputs["deltaCapture"];deltaEvidence:ExpansionInputs["deltaEvidence"];preparedSizing:ExpansionInputs["preparedSizing"];
  assertReviewedCheckout:()=>Promise<void>;assertNoWorkflowWriters:()=>Promise<void>;assertDeltaCapture:()=>Promise<void>;
  measurePhysical:()=>Promise<{targetBytes:number;historyBytes:number;measuredAt:string}>;now?:Date;
};
/** The old owner and all old checkpoints remain byte-identical. The existing
 * pipeline alone archives that completed owner and claims the new dated run.
 * No member is admitted until fresh delta proof and full sizing are verified. */
export async function promoteStoragePopulationExpansion(input:StoragePopulationPromotionInput):Promise<{
  status:"promoted"|"already-promoted";plan:StoragePopulationPlan;receipt:Receipt;
}> {
  const {env}=input,ops=env.OPS_DB,target=env.MARKET_DATA_DB,history=env.MARKET_HISTORY_DB,now=input.now??new Date(),stamp=now.toISOString();
  if(!ops||!target||!history||!env.EOD_CODE_REVISION||!digest(input.expectedPlanHash))fail("bindings-invalid");
  await input.assertReviewedCheckout();
  const run=await loadStorageMigration(ops,input.migrationId);
  if(!run||storageExecutionRevision(run)!==env.EOD_CODE_REVISION)fail("execution-mismatch");
  const execution=await assertStorageExecutionRevision(ops,run,env.EOD_CODE_REVISION);if(!execution)fail("execution-required");
  const identity=storageMigrationIdentity(run),receiptKey=storagePopulationPromotionKey(run.id,input.expectedPlanHash);
  const {bootstrapInputs:_derived,sizingHash:_sizing,...selected}=await loadStorageValidationPlan(ops,run);
  const priorReceipt=await read(ops,receiptKey);
  if(priorReceipt) {
    const receipt=parse<Receipt>(priorReceipt),{evidenceHash,...fields}=receipt;
    const parent=parse<StoragePopulationPlan>(await read(ops,`storage-population-plan:${run.id}:${input.expectedPlanHash}`));
    if(receipt.version!==1||receipt.policy!=="promote-completed-bootstrap-population-v1"||!digest(evidenceHash)||await storageHash(fields)!==evidenceHash
      ||receipt.migrationId!==run.id||receipt.codeRevision!==env.EOD_CODE_REVISION||receipt.executionHash!==execution.evidenceHash
      ||receipt.previousPlanHash!==input.expectedPlanHash||receipt.planHash!==selected.planHash||receipt.expansionHash!==selected.populationExpansionHash)fail("replay-conflict");
    await validateStoragePopulationExpansionLineage(ops,run,selected,parent);
    await assertStorageVerificationCapture(input.source,identity,selected.capture.sourceCapture);
    if(!await loadStorageHistoryIndexAmendment(ops,run,selected))fail("amendment-missing");
    return {status:"already-promoted",plan:selected,receipt};
  }
  await input.assertNoWorkflowWriters();
  if(selected.planHash!==input.expectedPlanHash||selected.populationExpansionHash||run.status!=="awaiting-evidence"||run.stage!=="bootstrap"
    ||run.error_code!=="storage-population-expansion-required"||run.lease_token!==null||run.lease_until!==null||run.dispatch_token!==null
    ||run.freeze_authorized!==1)fail("completed-population-pause-required");
  const expected=await expectedEodSession(env,now);
  if(!expected||expected<=selected.sessionDate)fail("latest-session-required");
  const latestInputs:FrozenInputs=await loadEodInputs(env,expected);
  const oldRunId=`eod:active:${selected.sessionDate}:daily`,newRunId=`eod:active:${expected}:daily`;
  const eod=await ops.prepare("SELECT * FROM eod_runs WHERE id=?").bind(oldRunId).first<EodRow>();
  const progress=eod?object(parse(eod.progress_json)):null;
  if(!eod||eod.status!=="completed"||eod.mode!=="active"||eod.purpose!=="daily"||eod.session_date!==selected.sessionDate
    ||eod.lease_token!==null||eod.lease_until!==null||eod.dispatch_token!==null||typeof eod.completed_at!=="string"
    ||!Number.isFinite(Date.parse(eod.completed_at))||Date.parse(eod.completed_at)>now.getTime()||!await same(parse(eod.input_json),selected.inputs)
    ||!progress||progress.symbols!==selected.tickers.length||!Array.isArray(progress.published)||progress.published.length!==6
    ||progress.published.some(value=>typeof value!=="string")||new Set(progress.published).size!==6||typeof progress.catalogPublicationId!=="string")fail("older-owner-not-complete");
  const published=progress.published as string[];
  if(await ops.prepare("SELECT id FROM eod_runs WHERE id=?").bind(newRunId).first())fail("latest-run-already-exists");
  const checkpoints=(await ops.prepare("SELECT checkpoint_key,input_hash,payload_json,updated_at FROM market_storage_checkpoints WHERE migration_id=? ORDER BY checkpoint_key LIMIT 129")
    .bind(run.id).all<Checkpoint>()).results,owner=checkpoints.find(row=>row.checkpoint_key==="bootstrap:owner");
  if(checkpoints.length>128||!owner||owner.input_hash!==selected.planHash||!await same(parse(owner.payload_json),{
    runId:oldRunId,sessionDate:selected.sessionDate,targetDatabaseId:run.target_database_id}))fail("owner-mismatch");
  const features=(await ops.prepare("SELECT * FROM eod_checkpoints WHERE run_id=? ORDER BY chunk_key LIMIT 401").bind(oldRunId).all()).results;
  if(features.length>400)fail("feature-bound");
  const amendment=await loadStorageHistoryIndexAmendment(ops,run,selected);if(!amendment)fail("amendment-missing");
  const publications=async()=>{
    const pointers=(await target.prepare("SELECT scope,publication_id,session_date,published_at FROM eod_publication_pointers WHERE scope IN (SELECT value FROM json_each(?)) ORDER BY scope")
      .bind(JSON.stringify([...EOD_PUBLICATION_SCOPES,EOD_CATALOG_SCOPE])).all<Pointer>()).results;
    if(pointers.length!==7||new Set(pointers.map(row=>row.scope)).size!==7)fail("older-publications-incomplete");
    const rows:Array<{pointer:Pointer;rowHash:string}>=[];
    for(const pointer of pointers) {
      const value=await target.prepare("SELECT * FROM eod_publications WHERE id=?").bind(pointer.publication_id).first<Record<string,unknown>>();
      if(!value||value.scope!==pointer.scope||value.session_date!==selected.sessionDate||pointer.session_date!==selected.sessionDate||value.status!=="accepted"
        ||(pointer.scope===EOD_CATALOG_SCOPE?progress.catalogPublicationId!==pointer.publication_id:!published.includes(pointer.publication_id)))fail("older-publication-mismatch");
      const decoded=await decodeEodPayload({payload:String(value.payload_json),payloadCodec:value.payload_codec as string|null,payloadBase64:value.payload_base64 as string|null});
      if(await storageHash(decoded)!==value.payload_checksum)fail("older-publication-integrity");
      rows.push({pointer,rowHash:await storageHash(value)});
    }
    return rows;
  };
  const proveCurrent=async()=>{
    await input.assertNoWorkflowWriters();await input.assertDeltaCapture();
    if(await ops.prepare(`SELECT 1 AS unsafe WHERE EXISTS(SELECT 1 FROM eod_runs WHERE lease_until>?)
      OR EXISTS(SELECT 1 FROM market_storage_migrations WHERE lease_until>? OR status IN ('dispatching','dispatched')
        OR (dispatch_token IS NOT NULL AND status NOT IN ('completed','aborted')))` ).bind(stamp,stamp).first())fail("writer-present");
    await assertStorageVerificationCapture(input.source,identity,selected.capture.sourceCapture);
    await releaseStorageVerificationFence(target,identity,selected.capture.targetCapture);
    const market=await target.prepare("SELECT f.revision,c.revision AS inputClock FROM market_storage_fence f JOIN eod_input_clock c ON c.id='default' WHERE f.id='default'")
      .first<{revision:number;inputClock:number}>();
    const archive=await inspectStorageHistoryPointerIndexSchema(history,identity,selected.capture.historyCapture,{historyDatabaseId:run.history_database_id,policy:"indexed"});
    if(!market||!Number.isSafeInteger(market.revision)||market.revision<input.deltaCapture.targetCapture.revision
      ||market.inputClock!==eod.completed_input_clock||archive.schemaHash!==amendment.schemaHash||archive.indexManifestHash!==amendment.indexManifestHash)fail("current-capture-mismatch");
    return {market,archive,publications:await publications(),inputsHash:await storageHash(await loadEodInputs(env,expected))};
  };
  const measured=await proveCurrent();
  if(measured.inputsHash!==await storageHash(latestInputs))fail("latest-inputs-changed");
  const prepared:PreparedStoragePopulationExpansion=await prepareStoragePopulationExpansion({ops,run,previousPlan:selected,nextInputs:latestInputs,
    deltaCapture:input.deltaCapture,deltaEvidence:input.deltaEvidence,preparedSizing:input.preparedSizing,now});
  const physical=await input.measurePhysical(),age=(input.now??new Date()).getTime()-Date.parse(physical.measuredAt),reserve=input.preparedSizing.evidence.planningReserveBytes;
  if(!Number.isFinite(age)||age<0||age>300_000||!Number.isSafeInteger(reserve)||reserve<64_000_000
    ||physical.targetBytes>input.preparedSizing.evidence.projectedRecentBytes
    ||physical.historyBytes>input.preparedSizing.evidence.projectedArchiveBytes
    ||![physical.targetBytes,physical.historyBytes].every(bytes=>Number.isSafeInteger(bytes)&&bytes>0&&bytes<350_000_000)
    ||physical.targetBytes+reserve>=350_000_000)fail("current-capacity-unavailable");
  const fields:Omit<Receipt,"evidenceHash">={version:1,policy:"promote-completed-bootstrap-population-v1",migrationId:run.id,codeRevision:env.EOD_CODE_REVISION,
    previousPlanHash:selected.planHash,planHash:prepared.plan.planHash,expansionHash:prepared.record.evidenceHash,executionHash:execution.evidenceHash,
    checkpointHash:await storageHash(checkpoints),checkpointCount:checkpoints.length,eodRunHash:await storageHash(eod),
    featureHash:await storageHash(features),featureCount:features.length,publicationHash:await storageHash(measured.publications),originalOwner:owner,
    targetRevision:measured.market.revision,inputClock:measured.market.inputClock,historyRevision:measured.archive.revision,physical,promotedAt:stamp};
  const receipt={...fields,evidenceHash:await storageHash(fields)},records=[...prepared.records,{id:receiptKey,payload:JSON.stringify(receipt)}];
  const pointer=await read(ops,`storage-population-current:${run.id}`),previous=await read(ops,`storage-population-plan:${run.id}:${selected.planHash}`),sizing=await read(ops,`storage-population-sizing:${selected.planHash}`);
  if(pointer!==JSON.stringify({planHash:selected.planHash})||!previous||!await same(parse(previous),selected)||!sizing)fail("selected-record-changed");
  await input.assertReviewedCheckout();
  if(!await same(await proveCurrent(),measured)||await expectedEodSession(env,input.now??new Date())!==expected)fail("capture-changed");
  const featureComparison=storageFeatureCheckpointComparison(features,oldRunId);
  const columns=Object.keys(eod);if(columns.some(column=>!/^[a-z][a-z0-9_]*$/.test(column)))fail("run-schema-invalid");
  const equal=columns.map(column=>`actual.${column} IS json_extract(expected.value,'$.${column}')`).join(" AND ");
  const queries:Array<{sql:string;params:unknown[]}>= [{sql:`SELECT CASE WHEN EXISTS(SELECT 1 FROM market_storage_migrations WHERE id=? AND updated_at=?
      AND status='awaiting-evidence' AND stage='bootstrap' AND error_code='storage-population-expansion-required'
      AND COALESCE(execution_revision,code_revision)=? AND execution_evidence_hash=? AND lease_token IS NULL AND lease_until IS NULL AND dispatch_token IS NULL)
    AND EXISTS(SELECT 1 FROM json_each(?) expected JOIN eod_runs actual ON actual.id=? WHERE ${equal})
    AND NOT EXISTS(SELECT 1 FROM eod_runs WHERE id=? OR lease_until>?)
    AND NOT EXISTS(SELECT 1 FROM market_storage_migrations WHERE lease_until>? OR status IN ('dispatching','dispatched') OR (dispatch_token IS NOT NULL AND status NOT IN ('completed','aborted')))
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=? AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=?
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=?
    AND (SELECT COUNT(*) FROM market_storage_checkpoints WHERE migration_id=?)=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN market_storage_checkpoints actual ON actual.migration_id=? AND actual.checkpoint_key=json_extract(expected.value,'$.checkpoint_key')
      WHERE actual.checkpoint_key IS NULL OR actual.input_hash<>json_extract(expected.value,'$.input_hash') OR actual.payload_json<>json_extract(expected.value,'$.payload_json') OR actual.updated_at<>json_extract(expected.value,'$.updated_at'))
    AND (SELECT COUNT(*) FROM eod_checkpoints WHERE run_id=?)=?
    ${featureComparison.sql}
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected JOIN eod_rollout_evidence actual ON actual.id=json_extract(expected.value,'$.id') WHERE actual.evidence_json<>json_extract(expected.value,'$.payload'))
    THEN 1 ELSE json_extract('storage-population-promotion-guard-rejected','$') END AS accepted /* eod-population-withdrawal */`,params:[
      run.id,run.updated_at,env.EOD_CODE_REVISION,execution.evidenceHash,JSON.stringify([eod]),oldRunId,newRunId,stamp,stamp,
      `storage-population-current:${run.id}`,pointer,`storage-population-plan:${run.id}:${selected.planHash}`,previous,`storage-population-sizing:${selected.planHash}`,sizing,
      run.id,checkpoints.length,JSON.stringify(checkpoints),run.id,oldRunId,features.length,...featureComparison.params,JSON.stringify(records)]}];
  for(const row of records)queries.push({sql:"INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",params:[row.id,row.payload,stamp]});
  queries.push({sql:"UPDATE eod_rollout_evidence SET evidence_json=?,updated_at=? WHERE id=? AND evidence_json=? RETURNING id",
    params:[JSON.stringify({planHash:prepared.plan.planHash}),stamp,`storage-population-current:${run.id}`,pointer]});
  queries.push({sql:"UPDATE market_storage_migrations SET status='queued',error_code=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND updated_at=? RETURNING id",
    params:[stamp,stamp,run.id,run.updated_at]});
  if(new TextEncoder().encode(JSON.stringify({batch:queries})).length>8_000_000)fail("transaction-payload-exceeds-bound");
  assertStorageAtomicParameters(queries);
  const results=await ops.batch(queries.map(row=>ops.prepare(row.sql).bind(...row.params)));
  if(results.slice(-2).some(row=>row.results.length!==1))fail("promotion-conflict");
  const current=await loadStorageMigration(ops,run.id);if(!current)fail("readback-missing");
  const plan=await loadStorageValidationPlan(ops,current);
  if(plan.planHash!==prepared.plan.planHash||await read(ops,receiptKey)!==JSON.stringify(receipt)
    ||!await same(await ops.prepare("SELECT * FROM eod_runs WHERE id=?").bind(oldRunId).first(),eod)
    ||!await same((await ops.prepare("SELECT * FROM eod_checkpoints WHERE run_id=? ORDER BY chunk_key LIMIT 401").bind(oldRunId).all()).results,features)
    ||!await same((await ops.prepare("SELECT checkpoint_key,input_hash,payload_json,updated_at FROM market_storage_checkpoints WHERE migration_id=? ORDER BY checkpoint_key LIMIT 129").bind(run.id).all()).results,checkpoints)
    ||!await same(await proveCurrent(),measured))fail("post-promotion-state-changed");
  await validateStoragePopulationExpansionLineage(ops,current,plan,selected);
  return {status:"promoted",plan,receipt};
}
