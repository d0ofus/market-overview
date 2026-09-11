import { z } from "zod";
import { storageHash } from "./market-storage-pages";
import { loadStorageMigration, storageMigrationIdentity, type StorageMigrationRun } from "./market-storage-control";
import { assertStorageExecutionRevision, storageExecutionKey, type StorageExecutionRecord } from "./market-storage-execution";
import { loadStorageValidationPlan, type StoragePopulationPlan } from "./market-storage-population-plan";
import { validateStorageConsumerEvidence, type StorageConsumerEvidence } from "./market-storage-acceptance";
import { assertStorageVerificationCapture, inspectStorageHistoryPointerIndexSchema, releaseStorageVerificationFence,
  releaseStorageHistoryVerificationFence, STORAGE_HISTORY_POINTER_INDEXES, type StorageHistoryPointerIndexAmendment } from "./market-storage-verification";
import { readEodBudgetStatus, resolveEodBudgetProfile } from "./eod-budget-profile";
import type { EodRun } from "./eod-coordinator";
import { EOD_PUBLICATION_SCOPES } from "./eod-publication-scopes";
import { EOD_CATALOG_SCOPE } from "./eod-catalog-service";
import { EOD_HISTORY_POINTER_INDEX_DDL, EOD_HISTORY_POINTER_INDEX_MAX_ROWS } from "./eod-d1-rest";
import { loadStorageIndexLoaderContinuation } from "./market-storage-history-index-continuation";

const hash=z.string().regex(/^[a-f0-9]{64}$/),sha=z.string().regex(/^[a-f0-9]{40}$/);
export const STORAGE_HISTORY_INDEX_RECOVERY_FROM_REVISION="b7ba8201d3be0a49997ec68759e75cd3fd7c2cb1";
const contractSchema=z.object({version:z.literal(1),policy:z.literal("history-index-only-bootstrap-recovery-v1"),fromRevision:z.literal(STORAGE_HISTORY_INDEX_RECOVERY_FROM_REVISION),codeRevision:sha,
  protectedFileCount:z.number().int().min(3),protectedManifestHash:hash,reviewedChangesHash:hash,beforeTreeHash:hash,afterTreeHash:hash,evidenceHash:hash}).strict();
export type StorageHistoryIndexCodeContract=z.infer<typeof contractSchema>;
type Checkpoint={checkpoint_key:string;input_hash:string;payload_json:string;updated_at:string};
type Physical={targetBytes:number;historyBytes:number;measuredAt:string};
type State={run:StorageMigrationRun;plan:StoragePopulationPlan;eod:EodRun;checkpoints:Checkpoint[];pointerText:string;planText:string;sizingText:string;
  targetRevision:number;inputClock:number;stateHash:string;checkpointManifestHash:string};
type Baseline={version:1;policy:"history-pointer-index-recovery-v1";migrationId:string;fromRevision:string;codeRevision:string;previousPlanHash:string;
  captureHash:string;codeContract:StorageHistoryIndexCodeContract;diffHash:string;stateHash:string;checkpointManifestHash:string;failedErrorMessage:string;
  history:StorageHistoryPointerIndexAmendment;pointerRows:number;targetRevision:number;inputClock:number;physical:Physical;queryPlan:string[];preparedAt:string;evidenceHash:string};
export type StorageHistoryIndexRecovery={version:1;policy:"history-pointer-index-recovery-v1";migrationId:string;fromRevision:string;codeRevision:string;
  previousPlanHash:string;planHash:string;captureHash:string;baselineHash:string;executionEvidenceHash:string;amendment:StorageHistoryPointerIndexAmendment;
  physical:Physical;queryPlan:string[];budget:Awaited<ReturnType<typeof readEodBudgetStatus>>;originalOwner:Checkpoint;approvedAt:string;evidenceHash:string};
export const STORAGE_HISTORY_INDEX_RECOVERY_DDL=EOD_HISTORY_POINTER_INDEX_DDL;
export const storageHistoryIndexRecoveryKey=(id:string,revision:string)=>`storage-history-index-recovery:${id}:${revision}`;
const baselineKey=(id:string,revision:string)=>`storage-history-index-baseline:${id}:${revision}`;
const read=(ops:D1Database,id:string)=>ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(id).first<string>("evidence_json");
const same=async(a:unknown,b:unknown)=>await storageHash(a)===await storageHash(b);
function fail(reason:string):never {throw new Error(`storage-history-index-recovery-${reason}`);}
function parse<T>(text:string|null):T {try {if(!text)fail("evidence-missing");return JSON.parse(text) as T;}catch {fail("evidence-invalid");}}
async function integrity<T extends {evidenceHash:string}>(value:T):Promise<T> {const {evidenceHash,...unsigned}=value;if(await storageHash(unsigned)!==evidenceHash)fail("evidence-integrity");return value;}
export type StorageHistoryIndexRecoveryInput={ops:D1Database;source:D1Database;target:D1Database;history:D1Database;migrationId:string;
  fromRevision:string;codeRevision:string;expectedPlanHash:string;changedFiles:string[];diffHash:string;codeContract:StorageHistoryIndexCodeContract;
  assertReviewedCheckout:()=>Promise<void>;assertNoWorkflowWriters:()=>Promise<void>;
  measurePhysical:()=>Promise<Physical>;now?:Date};

async function checkedCode(input:StorageHistoryIndexRecoveryInput):Promise<void> {
  const contract=contractSchema.safeParse(input.codeContract);
  if(!contract.success || contract.data.fromRevision!==input.fromRevision || contract.data.codeRevision!==input.codeRevision
    || input.fromRevision===input.codeRevision || !hash.safeParse(input.diffHash).success || !hash.safeParse(input.expectedPlanHash).success
    || !input.changedFiles.includes("worker/history-migrations/0003_history_pointer_indexes.sql"))fail("code-contract-invalid");
  await integrity(contract.data);await input.assertReviewedCheckout();await input.assertNoWorkflowWriters();
}
async function physical(input:StorageHistoryIndexRecoveryInput):Promise<Physical> {
  const value=await input.measurePhysical(),now=input.now ?? new Date(),age=now.getTime()-Date.parse(value.measuredAt);
  if(!Number.isFinite(age) || age<0 || age>300_000 || ![value.targetBytes,value.historyBytes].every(n=>Number.isSafeInteger(n)&&n>0&&n<350_000_000))fail("capacity-unavailable");
  return value;
}
async function paidHeadroom(ops:D1Database,now:Date) {
  const status=await readEodBudgetStatus(ops,resolveEodBudgetProfile("paid"),now),daily=status.daily,rolling=status.rolling31;
  if(status.unavailableReason || !daily || !rolling || ![daily.eodRowsRead,daily.eodRowsWritten,daily.reservedReads,daily.reservedWrites,
    daily.accountRowsRead,daily.accountRowsWritten].every(n=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0))fail("paid-budget-unavailable");
  const reads=50_000,writes=50_000;
  if(daily.eodRowsRead!+daily.reservedReads!+reads>status.limits.eodDaily.reads || daily.eodRowsWritten!+daily.reservedWrites!+writes>status.limits.eodDaily.writes
    || daily.accountRowsRead!+daily.reservedReads!+reads>status.limits.accountDaily.reads || daily.accountRowsWritten!+daily.reservedWrites!+writes>status.limits.accountDaily.writes
    || rolling.rowsRead+rolling.reservedReads+reads>status.limits.rolling31!.reads || rolling.rowsWritten+rolling.reservedWrites+writes>status.limits.rolling31!.writes)fail("paid-budget-exhausted");
  return status;
}
async function queryPlan(history:D1Database,indexed:boolean):Promise<string[]> {
  const rows=(await history.prepare(`EXPLAIN QUERY PLAN DELETE FROM market_history_blocks WHERE id=?
    AND NOT EXISTS(SELECT 1 FROM market_history_block_pointers WHERE feed=? AND ticker=? AND calendar_year=? AND (block_id=? OR previous_block_id=?))`)
    .bind("index-recovery-explain-only","sip","A",2025,"index-recovery-explain-only","index-recovery-explain-only").all<{detail:string}>()).results;
  const details=rows.map(row=>row.detail);
  if(!details.length || details.length>50 || details.some(row=>typeof row!=="string"))fail("query-plan-unavailable");
  const scans=details.filter(row=>/SCAN market_history_block_pointers\b/.test(row));
  if(indexed ? scans.length>0 || STORAGE_HISTORY_POINTER_INDEXES.some(index=>!details.some(row=>row.includes(index.name))) : scans.length!==2)fail("query-plan-mismatch");
  return details;
}
function failureReads(message:string|null|undefined):number {
  const match=/^eod-d1-query-budget-estimate-exceeded; reads=(\d+)\/20; writes=2\/8; statements=1; classes=delete-other$/.exec(message ?? "");
  if(!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1])<=20)fail("bootstrap-estimate-failure-required");
  return Number(match[1]);
}
async function countPointers(history:D1Database):Promise<number> {
  let count=0,after:[string,string,number]=["","",0];
  for(;;) {
    const page=(await history.prepare(`SELECT feed,ticker,calendar_year FROM market_history_block_pointers
      WHERE (feed,ticker,calendar_year)>(?,?,?) ORDER BY feed,ticker,calendar_year LIMIT 1000`)
      .bind(...after).all<{feed:string;ticker:string;calendar_year:number}>()).results;
    count+=page.length;if(count>EOD_HISTORY_POINTER_INDEX_MAX_ROWS)fail("pointer-count-exceeds-bound");
    if(page.length<1000)return count;const last=page.at(-1)!;after=[last.feed,last.ticker,last.calendar_year];
  }
}
async function state(input:StorageHistoryIndexRecoveryInput):Promise<State> {
  const ops=input.ops,now=input.now ?? new Date(),timestamp=now.toISOString(),run=await loadStorageMigration(ops,input.migrationId);
  if(!run || run.status!=="awaiting-evidence" || run.stage!=="bootstrap" || run.error_code!=="storage-query-estimate-exceeded"
    || !run.freeze_evidence_hash || run.freeze_authorized!==1 || run.lease_until && run.lease_until>timestamp || run.dispatch_token)fail("migration-state-mismatch");
  await assertStorageExecutionRevision(ops,run,input.fromRevision);
  const {bootstrapInputs:_inputs,sizingHash:_sizing,...plan}=await loadStorageValidationPlan(ops,run);
  if(plan.planHash!==input.expectedPlanHash)fail("selected-plan-mismatch");
  const eod=await ops.prepare("SELECT * FROM eod_runs WHERE id=?").bind(`eod:active:${plan.sessionDate}:daily`).first<EodRun>();
  if(!eod || eod.mode!=="active" || eod.purpose!=="daily" || eod.session_date!==plan.sessionDate || eod.status!=="retrying" || eod.stage!=="prices"
    || eod.error_code!=="resource-budget" || eod.dispatch_token
    || eod.lease_until && eod.lease_until>timestamp || !await same(parse(eod.input_json),plan.inputs))fail("bootstrap-estimate-failure-required");
  failureReads(eod.error_message);const progress=parse<{chunk?:number;symbols?:number;total?:number}>(eod.progress_json);
  if(progress.chunk!==0 || progress.symbols!==0 || progress.total!==Math.ceil(plan.tickers.length/25))fail("bootstrap-first-chunk-required");
  if(await ops.prepare(`SELECT 1 AS unsafe WHERE EXISTS(SELECT 1 FROM eod_checkpoints WHERE run_id=?)
    OR EXISTS(SELECT 1 FROM eod_runs WHERE lease_until>?) OR EXISTS(SELECT 1 FROM market_storage_migrations WHERE lease_until>?
      OR status IN ('dispatching','dispatched') OR (dispatch_token IS NOT NULL AND status NOT IN ('completed','aborted')))`)
    .bind(eod.id,timestamp,timestamp).first())fail("writer-or-feature-checkpoint-present");
  const checkpoints=(await ops.prepare("SELECT checkpoint_key,input_hash,payload_json,updated_at FROM market_storage_checkpoints WHERE migration_id=? ORDER BY checkpoint_key LIMIT 129")
    .bind(run.id).all<Checkpoint>()).results;
  const owner=checkpoints.find(row=>row.checkpoint_key==="bootstrap:owner"),consumer=checkpoints.find(row=>row.checkpoint_key==="consumer-parity:complete");
  if(checkpoints.length>128 || !owner || owner.input_hash!==plan.planHash || !consumer || consumer.input_hash!==plan.capture.captureHash
    || checkpoints.some(row=>row.checkpoint_key.startsWith("bootstrap")&&row.checkpoint_key!=="bootstrap:owner"))fail("bootstrap-owner-or-proof-mismatch");
  if(!await same(parse(owner.payload_json),{runId:eod.id,sessionDate:plan.sessionDate,targetDatabaseId:run.target_database_id}))fail("bootstrap-owner-mismatch");
  await validateStorageConsumerEvidence(parse<StorageConsumerEvidence>(consumer.payload_json),plan.capture,plan.tickers);
  await assertStorageVerificationCapture(input.source,storageMigrationIdentity(run),plan.capture.sourceCapture);
  // This is already-open tracked target state: never refreeze/redate the old consumer capture.
  const fence=await input.target.prepare("SELECT status,revision,released_at FROM market_storage_fence WHERE id='default'").first<{status:string;revision:number;released_at:string|null}>();
  if(!fence || fence.status!=="open" || fence.released_at!==null || !Number.isSafeInteger(fence.revision))fail("target-tracking-unavailable");
  await releaseStorageVerificationFence(input.target,storageMigrationIdentity(run),plan.capture.targetCapture);
  const inputClock=await input.target.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<number>("revision");
  if(!Number.isSafeInteger(inputClock)||inputClock===null)fail("input-clock-unavailable");
  if(await input.target.prepare("SELECT scope FROM eod_publication_pointers LIMIT 1").first())fail("accepted-publication-present");
  for(const scope of [...EOD_PUBLICATION_SCOPES,EOD_CATALOG_SCOPE]) {
    if(await input.target.prepare("SELECT id FROM eod_publications WHERE scope=? AND status='accepted' LIMIT 1").bind(scope).first())fail("accepted-publication-present");
  }
  const [pointerText,planText,sizingText]=await Promise.all([read(ops,`storage-population-current:${run.id}`),read(ops,`storage-population-plan:${run.id}:${plan.planHash}`),read(ops,`storage-population-sizing:${plan.planHash}`)]);
  if(pointerText!==JSON.stringify({planHash:plan.planHash}) || !planText || !sizingText || !await same(parse(planText),plan))fail("plan-record-mismatch");
  const checkpointManifestHash=await storageHash(checkpoints),stateHash=await storageHash({run,eod,checkpointManifestHash,pointerText,planText,sizingText,targetRevision:fence.revision,inputClock});
  return {run,plan,eod,checkpoints,pointerText,planText,sizingText,targetRevision:fence.revision,inputClock,stateHash,checkpointManifestHash};
}
async function baseline(input:StorageHistoryIndexRecoveryInput):Promise<Baseline> {
  const value=await integrity(parse<Baseline>(await read(input.ops,baselineKey(input.migrationId,input.codeRevision))));
  if(value.version!==1 || value.policy!=="history-pointer-index-recovery-v1" || value.migrationId!==input.migrationId || value.fromRevision!==input.fromRevision
    || value.codeRevision!==input.codeRevision || value.previousPlanHash!==input.expectedPlanHash || value.diffHash!==input.diffHash
    || !await same(value.codeContract,input.codeContract))fail("baseline-conflict");
  return value;
}
export async function prepareStorageHistoryIndexRecovery(input:StorageHistoryIndexRecoveryInput):Promise<Baseline> {
  await checkedCode(input);
  const old=await read(input.ops,baselineKey(input.migrationId,input.codeRevision));
  if(old){const saved=await baseline(input);if((await state(input)).stateHash!==saved.stateHash)fail("baseline-state-changed");return saved;}
  const initial=await state(input),inspection=await inspectStorageHistoryPointerIndexSchema(input.history,storageMigrationIdentity(initial.run),initial.plan.capture.historyCapture,
    {historyDatabaseId:initial.run.history_database_id,policy:"legacy"});
  const measured=await physical(input),explain=await queryPlan(input.history,false),pointerRows=await countPointers(input.history);
  // Billed rows include provider accounting details; do not invent a 2*N
  // equality from EXPLAIN. Bind the actual measured error, original scan plan
  // and independently bounded population, then require both indexed searches.
  await paidHeadroom(input.ops,input.now ?? new Date());await input.assertNoWorkflowWriters();
  if((await state(input)).stateHash!==initial.stateHash)fail("baseline-state-changed");
  const unsigned={version:1 as const,policy:"history-pointer-index-recovery-v1" as const,migrationId:initial.run.id,fromRevision:input.fromRevision,codeRevision:input.codeRevision,
    previousPlanHash:initial.plan.planHash,captureHash:initial.plan.capture.captureHash,codeContract:input.codeContract,diffHash:input.diffHash,stateHash:initial.stateHash,
    checkpointManifestHash:initial.checkpointManifestHash,failedErrorMessage:initial.eod.error_message!,history:inspection,pointerRows,targetRevision:initial.targetRevision,inputClock:initial.inputClock,physical:measured,queryPlan:explain,
    preparedAt:(input.now ?? new Date()).toISOString()};
  const saved={...unsigned,evidenceHash:await storageHash(unsigned)},key=baselineKey(input.migrationId,input.codeRevision),payload=JSON.stringify(saved);
  await input.ops.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING").bind(key,payload,saved.preparedAt).run();
  if(await read(input.ops,key)!==payload)fail("baseline-conflict");return saved;
}
export async function applyStorageHistoryPointerIndexes(input:StorageHistoryIndexRecoveryInput):Promise<StorageHistoryPointerIndexAmendment> {
  await checkedCode(input);const saved=await baseline(input),current=await state(input);
  if(current.stateHash!==saved.stateHash)fail("baseline-state-changed");
  // Lost DDL acknowledgement is safe only when the complete exact pair exists.
  const existing=await input.history.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name IN (?,?)")
    .bind(...STORAGE_HISTORY_POINTER_INDEXES.map(row=>row.name)).all();
  const inspection=await inspectStorageHistoryPointerIndexSchema(input.history,storageMigrationIdentity(current.run),current.plan.capture.historyCapture,
    {historyDatabaseId:current.run.history_database_id,policy:existing.results.length===2 ? "indexed" : "legacy"});
  if(inspection.revision!==saved.history.revision)fail("history-rows-changed");
  if(!existing.results.length) {
    if(await countPointers(input.history)!==saved.pointerRows)fail("history-rows-changed");
    await paidHeadroom(input.ops,input.now ?? new Date());await input.assertNoWorkflowWriters();
    if((await state(input)).stateHash!==saved.stateHash)fail("baseline-state-changed");
    await input.history.batch(STORAGE_HISTORY_INDEX_RECOVERY_DDL.map(sql=>input.history.prepare(sql)));
  }
  const result=await inspectStorageHistoryPointerIndexSchema(input.history,storageMigrationIdentity(current.run),current.plan.capture.historyCapture,
    {historyDatabaseId:current.run.history_database_id,policy:"indexed"});
  if(result.revision!==saved.history.revision)fail("history-rows-changed");await queryPlan(input.history,true);return result;
}

/** Separate post-first-chunk policy. It preserves actual partial archive writes,
 * every original proof and frozen input, and only clears the identified query
 * estimate failure once its two-index cause has been verified away. */
export async function approveStorageHistoryIndexRecovery(input:StorageHistoryIndexRecoveryInput):Promise<{execution:StorageExecutionRecord;plan:StoragePopulationPlan;recovery:StorageHistoryIndexRecovery}> {
  await checkedCode(input);const ops=input.ops,now=input.now ?? new Date(),stamp=now.toISOString(),run=await loadStorageMigration(ops,input.migrationId);
  if(run?.execution_revision===input.codeRevision) {
    const {bootstrapInputs:_inputs,sizingHash:_size,...plan}=await loadStorageValidationPlan(ops,run);
    const recovery=await integrity(parse<StorageHistoryIndexRecovery>(await read(ops,storageHistoryIndexRecoveryKey(run.id,input.codeRevision))));
    const execution=await assertStorageExecutionRevision(ops,run,input.codeRevision);
    if(!execution || execution.diffHash!==input.diffHash || recovery.previousPlanHash!==input.expectedPlanHash || recovery.fromRevision!==input.fromRevision
      || !await loadStorageHistoryIndexAmendment(ops,run,plan))fail("approval-replay-conflict");
    await assertStorageVerificationCapture(input.source,storageMigrationIdentity(run),plan.capture.sourceCapture);
    await releaseStorageVerificationFence(input.target,storageMigrationIdentity(run),plan.capture.targetCapture);
    await releaseStorageHistoryVerificationFence(input.history,storageMigrationIdentity(run),plan.capture.historyCapture,recovery.amendment);
    await physical(input);await paidHeadroom(ops,input.now ?? new Date());await queryPlan(input.history,true);
    return {execution,plan,recovery};
  }
  const before=await baseline(input),current=await state(input);
  if(current.stateHash!==before.stateHash)fail("baseline-state-changed");
  const amendment=await inspectStorageHistoryPointerIndexSchema(input.history,storageMigrationIdentity(current.run),current.plan.capture.historyCapture,
    {historyDatabaseId:current.run.history_database_id,policy:"indexed"});
  if(amendment.revision!==before.history.revision)fail("history-rows-changed");
  const measured=await physical(input),explain=await queryPlan(input.history,true),budget=await paidHeadroom(ops,input.now ?? new Date());
  const {planHash:_previousHash,...previous}=current.plan,planFields={...previous,predecessorPlanHash:current.plan.planHash,codeRevision:input.codeRevision,createdAt:stamp};
  const plan={...planFields,planHash:await storageHash(planFields)},sizing={...parse<Record<string,unknown>>(current.sizingText),planHash:plan.planHash};
  const executionFields={version:1 as const,policy:"preserve-storage-capture-execution-v1" as const,storageIdentity:storageMigrationIdentity(current.run),fromRevision:input.fromRevision,
    codeRevision:input.codeRevision,predecessorHash:current.run.execution_evidence_hash ?? null,sourceCapture:plan.capture.sourceCapture,
    freezeEvidenceHash:current.run.freeze_evidence_hash!,checkpointCount:current.checkpoints.length,checkpointManifestHash:current.checkpointManifestHash,
    changedFiles:[...input.changedFiles].sort(),diffHash:input.diffHash,approvedAt:stamp,
    storagePolicy:{hotSessions:90 as const,marketBytes:350_000_000 as const,archiveBytes:350_000_000 as const,databaseCount:10 as const,accountBytes:5_000_000_000 as const}};
  const execution={...executionFields,evidenceHash:await storageHash(executionFields)},owner=current.checkpoints.find(row=>row.checkpoint_key==="bootstrap:owner")!;
  const fields={version:1 as const,policy:"history-pointer-index-recovery-v1" as const,migrationId:current.run.id,fromRevision:input.fromRevision,codeRevision:input.codeRevision,
    previousPlanHash:current.plan.planHash,planHash:plan.planHash,captureHash:plan.capture.captureHash,baselineHash:before.evidenceHash,
    executionEvidenceHash:execution.evidenceHash,amendment,physical:measured,queryPlan:explain,budget,originalOwner:owner,approvedAt:stamp};
  const recovery={...fields,evidenceHash:await storageHash(fields)},key=storageHistoryIndexRecoveryKey(current.run.id,input.codeRevision);
  await input.assertReviewedCheckout();await input.assertNoWorkflowWriters();
  if((await state(input)).stateHash!==before.stateHash || (await inspectStorageHistoryPointerIndexSchema(input.history,storageMigrationIdentity(current.run),plan.capture.historyCapture,
    {historyDatabaseId:current.run.history_database_id,policy:"indexed"})).revision!==amendment.revision)fail("preapproval-state-changed");
  const records=[{id:key,value:recovery},{id:storageExecutionKey(current.run.id,input.codeRevision),value:execution},
    {id:`storage-population-plan:${current.run.id}:${plan.planHash}`,value:plan},{id:`storage-population-sizing:${plan.planHash}`,value:sizing}]
    .map(row=>({id:row.id,payload:JSON.stringify(row.value)}));
  const checkpoints=JSON.stringify(current.checkpoints.map(row=>[row.checkpoint_key,row.input_hash,row.payload_json,row.updated_at]));
  const queries:Array<{sql:string;params:unknown[]}>=[];
  queries.push({sql:`SELECT CASE WHEN
    EXISTS(SELECT 1 FROM market_storage_migrations WHERE id=? AND updated_at=? AND status='awaiting-evidence' AND stage='bootstrap'
      AND error_code='storage-query-estimate-exceeded' AND COALESCE(execution_revision,code_revision)=? AND execution_evidence_hash IS ?
      AND (lease_until IS NULL OR lease_until<=?) AND dispatch_token IS NULL)
    AND EXISTS(SELECT 1 FROM eod_runs WHERE id=? AND updated_at=? AND status='retrying' AND stage='prices' AND error_code='resource-budget'
      AND error_message=? AND input_json=? AND progress_json=? AND (lease_until IS NULL OR lease_until<=?) AND dispatch_token IS NULL)
    AND NOT EXISTS(SELECT 1 FROM eod_runs WHERE lease_until>?) AND NOT EXISTS(SELECT 1 FROM eod_checkpoints WHERE run_id=?)
    AND NOT EXISTS(SELECT 1 FROM market_storage_migrations WHERE lease_until>? OR status IN ('dispatching','dispatched')
      OR (dispatch_token IS NOT NULL AND status NOT IN ('completed','aborted')))
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=?
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=?
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=?
    AND (SELECT evidence_json FROM eod_rollout_evidence WHERE id=?)=?
    AND (SELECT COUNT(*) FROM market_storage_checkpoints WHERE migration_id=?)=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN market_storage_checkpoints actual ON actual.migration_id=?
      AND actual.checkpoint_key=json_extract(expected.value,'$[0]') WHERE actual.checkpoint_key IS NULL
      OR actual.input_hash<>json_extract(expected.value,'$[1]') OR actual.payload_json<>json_extract(expected.value,'$[2]') OR actual.updated_at<>json_extract(expected.value,'$[3]'))
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected JOIN eod_rollout_evidence actual ON actual.id=json_extract(expected.value,'$.id')
      WHERE actual.evidence_json<>json_extract(expected.value,'$.payload'))
    THEN 1 ELSE json_extract('storage-history-index-recovery-guard-rejected','$') END AS accepted`,params:[current.run.id,current.run.updated_at,input.fromRevision,
      current.run.execution_evidence_hash ?? null,stamp,current.eod.id,current.eod.updated_at,current.eod.error_message!,current.eod.input_json,current.eod.progress_json,stamp,stamp,current.eod.id,stamp,
      `storage-population-current:${current.run.id}`,current.pointerText,`storage-population-plan:${current.run.id}:${current.plan.planHash}`,current.planText,
      `storage-population-sizing:${current.plan.planHash}`,current.sizingText,baselineKey(current.run.id,input.codeRevision),JSON.stringify(before),
      current.run.id,current.checkpoints.length,checkpoints,current.run.id,JSON.stringify(records)]});
  for(const record of records)queries.push({sql:"INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",params:[record.id,record.payload,stamp]});
  queries.push({sql:"UPDATE eod_rollout_evidence SET evidence_json=?,updated_at=? WHERE id=? AND evidence_json=? RETURNING id",
    params:[JSON.stringify({planHash:plan.planHash}),stamp,`storage-population-current:${current.run.id}`,current.pointerText]});
  // Preserve payload and its original timestamp; the immutable audit retains the
  // exact former owner row, while this reference now names its reviewed executor.
  queries.push({sql:"UPDATE market_storage_checkpoints SET input_hash=? WHERE migration_id=? AND checkpoint_key='bootstrap:owner' AND input_hash=? RETURNING checkpoint_key",
    params:[plan.planHash,current.run.id,current.plan.planHash]});
  queries.push({sql:`UPDATE eod_runs SET status='queued',error_code=NULL,error_message=NULL,next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,updated_at=?
    WHERE id=? AND updated_at=? AND error_code='resource-budget' AND error_message=? RETURNING id`,params:[stamp,current.eod.id,current.eod.updated_at,current.eod.error_message!]});
  queries.push({sql:`UPDATE market_storage_migrations SET execution_revision=?,execution_evidence_hash=?,status='awaiting-evidence',
    error_code='storage-execution-github-pin-required',next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND updated_at=? RETURNING id`,
    params:[input.codeRevision,execution.evidenceHash,stamp,current.run.id,current.run.updated_at]});
  if(new TextEncoder().encode(JSON.stringify({batch:queries})).length>8_000_000)fail("transaction-payload-exceeds-bound");
  const result=await ops.batch(queries.map(row=>ops.prepare(row.sql).bind(...row.params)));
  if(result.slice(-4).some(row=>row.results.length!==1))fail("promotion-conflict");
  const latest=await loadStorageMigration(ops,current.run.id);
  if(!latest || !await loadStorageHistoryIndexAmendment(ops,latest,plan))fail("readback-conflict");return {execution,plan,recovery};
}

export async function loadStorageHistoryIndexAmendment(ops:D1Database,run:StorageMigrationRun,value:StoragePopulationPlan):Promise<StorageHistoryPointerIndexAmendment|null> {
  // loadStorageValidationPlan adds these two derived accessors. They are not
  // part of the immutable signed plan. Preserve all other fields so unknown
  // additions still fail the plan hash instead of being silently discarded.
  const {bootstrapInputs,sizingHash,...plan}=value as StoragePopulationPlan & {bootstrapInputs?:unknown;sizingHash?:unknown};
  if((bootstrapInputs!==undefined || sizingHash!==undefined)
    && (!hash.safeParse(sizingHash).success || !await same(bootstrapInputs,plan.inputs)))fail("derived-plan-mismatch");
  if(sizingHash!==undefined) {
    const sizing=parse<{planHash:string;prepared:{hash:string}}>(await read(ops,`storage-population-sizing:${plan.planHash}`));
    if(sizing.planHash!==plan.planHash || sizing.prepared?.hash!==sizingHash)fail("derived-plan-mismatch");
  }
  const text=await read(ops,storageHistoryIndexRecoveryKey(run.id,plan.codeRevision));
  if(!text) {
    const continuation=await loadStorageIndexLoaderContinuation(ops,run,plan);if(!continuation)return null;
    const amendment=await loadStorageHistoryIndexAmendment(ops,continuation.previousRun,continuation.previousPlan);
    if(!amendment||await storageHash(amendment)!==continuation.amendmentHash)fail("continued-amendment-mismatch");
    return amendment;
  }
  const recovery=await integrity(parse<StorageHistoryIndexRecovery>(text)),execution=await assertStorageExecutionRevision(ops,run,plan.codeRevision);
  const old=await integrity(parse<Baseline>(await read(ops,baselineKey(run.id,plan.codeRevision))));
  const previous=parse<StoragePopulationPlan>(await read(ops,`storage-population-plan:${run.id}:${recovery.previousPlanHash}`));
  let amended=plan;
  // Later target sessions may legitimately inherit the same capture/population.
  // Authenticate each immutable predecessor; never move the original amendment
  // date or treat a changed population/capture as covered by this index repair.
  for(let depth=0;amended.planHash!==recovery.planHash;depth++) {
    if(depth>=32||!amended.predecessorPlanHash)fail("amendment-plan-lineage-missing");
    const parent=parse<StoragePopulationPlan>(await read(ops,`storage-population-plan:${run.id}:${amended.predecessorPlanHash}`));
    const {planHash:childHash,...childFields}=amended,{planHash:parentHash,...parentFields}=parent;
    if(await storageHash(childFields)!==childHash || await storageHash(parentFields)!==parentHash || parentHash!==amended.predecessorPlanHash
      || parent.codeRevision!==plan.codeRevision || amended.codeRevision!==plan.codeRevision || parent.sessionDate>=amended.sessionDate
      || !await same(parent.capture,amended.capture) || !await same(parent.tickers,amended.tickers)
      || !await same(parent.calendarDates,amended.calendarDates) || parent.sourceSnapshotHash!==amended.sourceSnapshotHash
      || parent.sourcePreflightHash!==amended.sourcePreflightHash || parent.originalCopyCaptureHash!==amended.originalCopyCaptureHash)fail("amendment-plan-lineage-mismatch");
    amended=parent;
  }
  const {planHash:previousHash,...oldFields}=previous,{planHash:currentHash,...newFields}=amended;
  const expected={...oldFields,predecessorPlanHash:previousHash,codeRevision:plan.codeRevision,createdAt:amended.createdAt};
  if(recovery.version!==1 || recovery.policy!=="history-pointer-index-recovery-v1" || recovery.migrationId!==run.id || recovery.codeRevision!==plan.codeRevision
    || !execution || recovery.executionEvidenceHash!==execution.evidenceHash || recovery.fromRevision!==execution.fromRevision || recovery.planHash!==amended.planHash
    || recovery.baselineHash!==old.evidenceHash || old.previousPlanHash!==previousHash || old.codeRevision!==plan.codeRevision
    || old.migrationId!==run.id || old.fromRevision!==recovery.fromRevision || old.diffHash!==execution.diffHash || previous.codeRevision!==recovery.fromRevision
    || old.history.schemaHash!==old.history.legacySchemaHash || old.history.legacySchemaHash!==plan.capture.historyCapture.schemaHash
    || old.history.indexManifestHash!==recovery.amendment.indexManifestHash || old.history.snapshotRevision!==plan.capture.historyCapture.revision
    || recovery.originalOwner.checkpoint_key!=="bootstrap:owner" || recovery.originalOwner.input_hash!==previousHash
    || old.stateHash===undefined || old.captureHash!==plan.capture.captureHash || recovery.captureHash!==plan.capture.captureHash
    || await storageHash(oldFields)!==previousHash || await storageHash(newFields)!==currentHash || !await same(expected,newFields)
    || recovery.amendment.historyDatabaseId!==run.history_database_id || recovery.amendment.legacySchemaHash!==plan.capture.historyCapture.schemaHash
    || recovery.amendment.snapshotRevision!==plan.capture.historyCapture.revision || recovery.amendment.revision!==old.history.revision
    || recovery.amendment.schemaHash===recovery.amendment.legacySchemaHash || recovery.amendment.indexManifestHash!==await storageHash(STORAGE_HISTORY_POINTER_INDEXES))fail("amendment-integrity");
  return recovery.amendment;
}
