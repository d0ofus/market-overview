import type { Env } from "./types";
import { releaseStorageSourceFence } from "./market-storage-fence";
import { storageGitHubRevocationKey } from "./market-storage-github-revocation";

export type StorageMigrationIdentity = {
  id: string; sourceDatabaseId: string; targetDatabaseId: string; historyDatabaseId: string;
  sessionDate: string; codeRevision: string;
};
export type StorageMigrationRun = {
  id: string; source_database_id: string; target_database_id: string; history_database_id: string;
  session_date: string; code_revision: string;
  execution_revision?: string|null; execution_evidence_hash?: string|null;
  status: "queued"|"dispatching"|"dispatched"|"running"|"retrying"|"awaiting-evidence"|"awaiting-cutover"|"completed"|"aborting"|"aborted";
  stage: string; source_schema_hash: string|null; source_revision: number|null;
  freeze_authorized: number; freeze_evidence_hash: string|null;
  lease_token: string|null; lease_until: string|null; next_attempt_at: string|null;
  attempt: number; dispatch_token: string|null; dispatch_requested_at: string|null; github_run_id: string|null;
  progress_json: string; error_code: string|null; created_at: string; updated_at: string; completed_at: string|null;
};
export const STORAGE_LEASE_MS = 10 * 60_000;
const identifier = /^market-storage:[A-Za-z0-9][A-Za-z0-9._:-]{0,104}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hash = /^[a-f0-9]{64}$/i;
function validId(id: string): void { if (!identifier.test(id)) throw new Error("storage-migration-invalid-id"); }
function boundedJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (!json || new TextEncoder().encode(json).length > 64_000) throw new Error("storage-migration-checkpoint-too-large");
  return json;
}
function code(value: string): string {
  return /^[a-z0-9-]{1,100}$/.test(value) ? value : "storage-migration-failed";
}
export function storageMigrationIdentity(run: StorageMigrationRun): StorageMigrationIdentity {
  return {id:run.id,sourceDatabaseId:run.source_database_id,targetDatabaseId:run.target_database_id,
    historyDatabaseId:run.history_database_id,sessionDate:run.session_date,codeRevision:run.code_revision};
}
/** Copy/fence identities retain the original revision forever. Fresh runtime
 * and publication evidence uses the separately approved executor. */
export function storageExecutionRevision(run: StorageMigrationRun): string {
  return run.execution_revision ?? run.code_revision;
}
export function storageExecutionIdentity(run: StorageMigrationRun): StorageMigrationIdentity {
  return { ...storageMigrationIdentity(run), codeRevision: storageExecutionRevision(run) };
}
export async function loadStorageMigration(ops: D1Database, id: string): Promise<StorageMigrationRun|null> {
  validId(id);
  return ops.prepare("SELECT * FROM market_storage_migrations WHERE id=?").bind(id).first<StorageMigrationRun>();
}
export async function createStorageMigration(ops: D1Database, input: StorageMigrationIdentity, now = new Date()): Promise<StorageMigrationRun> {
  validId(input.id);
  const ids = [input.sourceDatabaseId,input.targetDatabaseId,input.historyDatabaseId].map((value) => value.toLowerCase());
  if (!ids.every((value) => uuid.test(value)) || new Set(ids).size !== 3) throw new Error("storage-migration-database-identity-invalid");
  const sessionTime=Date.parse(`${input.sessionDate}T00:00:00Z`);
  if (!/^[a-f0-9]{40,64}$/i.test(input.codeRevision) || !/^\d{4}-\d{2}-\d{2}$/.test(input.sessionDate)
    || !Number.isFinite(sessionTime) || new Date(sessionTime).toISOString().slice(0,10)!==input.sessionDate) throw new Error("storage-migration-identity-invalid");
  await ops.prepare(`INSERT INTO market_storage_migrations
    (id,source_database_id,target_database_id,history_database_id,session_date,code_revision,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(input.id,...ids,input.sessionDate,input.codeRevision,now.toISOString(),now.toISOString()).run();
  const run = await loadStorageMigration(ops,input.id);
  if (!run || run.source_database_id!==ids[0] || run.target_database_id!==ids[1] || run.history_database_id!==ids[2]
    || run.session_date!==input.sessionDate || run.code_revision!==input.codeRevision) throw new Error("storage-migration-identity-conflict");
  return run;
}
export async function claimStorageMigration(ops: D1Database,id: string, options: {githubRunId?: string;executionRevision?:string;now?: Date} = {}): Promise<{run:StorageMigrationRun;leaseToken:string}|null> {
  validId(id);
  const now=options.now ?? new Date(), timestamp=now.toISOString(), token=crypto.randomUUID();
  if (options.githubRunId !== undefined && !/^[1-9]\d{0,19}$/.test(options.githubRunId)) throw new Error("storage-migration-invalid-github-run");
  const revocationKey = options.githubRunId === undefined ? null : storageGitHubRevocationKey(options.githubRunId);
  const result=await ops.prepare(`UPDATE market_storage_migrations SET status='running',lease_token=?,lease_until=?,
    github_run_id=COALESCE(?,github_run_id),dispatch_token=NULL,updated_at=? WHERE id=?
    AND status IN ('queued','dispatching','dispatched','running','retrying')
    AND (? IS NULL OR COALESCE(execution_revision,code_revision)=?)
    AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM eod_rollout_evidence WHERE id=?))
    AND (lease_until IS NULL OR lease_until<=?) AND (next_attempt_at IS NULL OR next_attempt_at<=? OR status IN ('dispatching','dispatched'))`)
    .bind(token,new Date(now.getTime()+STORAGE_LEASE_MS).toISOString(),options.githubRunId ?? null,timestamp,id,
      options.executionRevision ?? null,options.executionRevision ?? null,revocationKey,revocationKey,timestamp,timestamp).run();
  const run=await loadStorageMigration(ops,id);
  if (!run) throw new Error("storage-migration-run-missing");
  return result.meta.changes ? {run,leaseToken:token} : null;
}
export async function heartbeatStorageMigration(ops:D1Database,id:string,token:string,now=new Date()): Promise<void> {
  const result=await ops.prepare(`UPDATE market_storage_migrations SET lease_until=?,updated_at=?
    WHERE id=? AND lease_token=? AND status='running' AND lease_until>?`)
    .bind(new Date(now.getTime()+STORAGE_LEASE_MS).toISOString(),now.toISOString(),id,token,now.toISOString()).run();
  if (!result.meta.changes) throw new Error("storage-migration-lease-lost");
}
export async function progressStorageMigration(ops:D1Database,id:string,token:string,stage:string,payload:unknown,now=new Date()): Promise<void> {
  if (!/^[a-z0-9-]{1,80}$/.test(stage)) throw new Error("storage-migration-stage-invalid");
  const result=await ops.prepare(`UPDATE market_storage_migrations SET stage=?,progress_json=?,updated_at=?,lease_until=?
    WHERE id=? AND lease_token=? AND status='running' AND lease_until>?`)
    .bind(stage,boundedJson(payload),now.toISOString(),new Date(now.getTime()+STORAGE_LEASE_MS).toISOString(),id,token,now.toISOString()).run();
  if (!result.meta.changes) throw new Error("storage-migration-lease-lost");
}
export async function recordStorageSourceCapture(ops:D1Database,id:string,token:string,capture:{schemaHash:string;revision:number},now=new Date()): Promise<void> {
  if (!hash.test(capture.schemaHash) || !Number.isSafeInteger(capture.revision) || capture.revision<0) throw new Error("storage-migration-capture-invalid");
  const result=await ops.prepare(`UPDATE market_storage_migrations SET source_schema_hash=?,source_revision=?,updated_at=?
    WHERE id=? AND lease_token=? AND status='running' AND lease_until>? AND freeze_authorized=1
    AND (source_schema_hash IS NULL OR (source_schema_hash=? AND (source_revision IS NULL OR source_revision=?)))`)
    .bind(capture.schemaHash,capture.revision,now.toISOString(),id,token,now.toISOString(),capture.schemaHash,capture.revision).run();
  if (!result.meta.changes) throw new Error("storage-migration-capture-conflict-or-lease-lost");
}
export async function saveStorageMigrationCheckpoint(ops:D1Database,id:string,token:string,input:{key:string;inputHash:string;payload:unknown},now=new Date()): Promise<void> {
  if (!/^[A-Za-z0-9:._/-]{1,180}$/.test(input.key) || !hash.test(input.inputHash)) throw new Error("storage-migration-checkpoint-invalid");
  const result=await ops.prepare(`INSERT INTO market_storage_checkpoints(migration_id,checkpoint_key,input_hash,payload_json,updated_at)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM market_storage_migrations WHERE id=? AND lease_token=? AND status='running' AND lease_until>?)
    ON CONFLICT(migration_id,checkpoint_key) DO UPDATE SET input_hash=excluded.input_hash,payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
    .bind(id,input.key,input.inputHash,boundedJson(input.payload),now.toISOString(),id,token,now.toISOString()).run();
  if (!result.meta.changes) throw new Error("storage-migration-lease-lost");
}
export async function loadStorageMigrationCheckpoint(ops:D1Database,id:string,key:string): Promise<{inputHash:string;payload:unknown}|null> {
  const row=await ops.prepare("SELECT input_hash AS inputHash,payload_json AS payload FROM market_storage_checkpoints WHERE migration_id=? AND checkpoint_key=?")
    .bind(id,key).first<{inputHash:string;payload:string}>();
  return row ? {inputHash:row.inputHash,payload:JSON.parse(row.payload) as unknown} : null;
}
export async function deferStorageMigration(ops:D1Database,id:string,token:string,errorCode:string,options:{quota?:boolean;now?:Date} = {}): Promise<void> {
  const now=options.now ?? new Date();
  const retry=options.quota ? new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1,0,5)) : new Date(now.getTime()+15*60_000);
  const result=await ops.prepare(`UPDATE market_storage_migrations SET status='retrying',error_code=?,next_attempt_at=?,
    lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='running'`)
    .bind(code(errorCode),retry.toISOString(),now.toISOString(),id,token).run();
  if (!result.meta.changes) throw new Error("storage-migration-lease-lost");
}
export async function markStorageMigrationReady(ops:D1Database,id:string,token:string,evidence:unknown,now=new Date()): Promise<void> {
  const result=await ops.prepare(`UPDATE market_storage_migrations SET status='awaiting-cutover',stage='verified',progress_json=?,
    lease_token=NULL,lease_until=NULL,next_attempt_at=NULL,error_code=NULL,updated_at=?
    WHERE id=? AND lease_token=? AND status='running' AND lease_until>? AND source_schema_hash IS NOT NULL AND source_revision IS NOT NULL
      AND freeze_authorized=1 AND freeze_evidence_hash IS NOT NULL`)
    .bind(boundedJson(evidence),now.toISOString(),id,token,now.toISOString()).run();
  if (!result.meta.changes) throw new Error("storage-migration-capture-missing-or-lease-lost");
}
/** Explicit operator approval of a measured preflight, separate from creating
 * a resumable run. The engine must check this flag before calling freeze. */
export async function authorizeStorageMigrationFreeze(ops:D1Database,id:string,input:{sourceDatabaseId:string;codeRevision:string;schemaHash:string;evidenceHash:string},now=new Date()):Promise<void> {
  if (!hash.test(input.schemaHash) || !hash.test(input.evidenceHash)) throw new Error("storage-migration-freeze-evidence-invalid");
  const result=await ops.prepare(`UPDATE market_storage_migrations SET freeze_authorized=1,freeze_evidence_hash=?,source_schema_hash=?,updated_at=?
    WHERE id=? AND source_database_id=? AND code_revision=? AND status IN ('queued','retrying','awaiting-evidence')
    AND (lease_until IS NULL OR lease_until<=?) AND (source_schema_hash IS NULL OR source_schema_hash=?)`)
    .bind(input.evidenceHash,input.schemaHash,now.toISOString(),id,input.sourceDatabaseId.toLowerCase(),input.codeRevision,now.toISOString(),input.schemaHash).run();
  if (!result.meta.changes) throw new Error("storage-migration-freeze-authorization-conflict");
}
export async function pauseStorageMigration(ops:D1Database,id:string,token:string,reason:string,progress:unknown,now=new Date()):Promise<void> {
  const result=await ops.prepare(`UPDATE market_storage_migrations SET status='awaiting-evidence',error_code=?,progress_json=?,
    lease_token=NULL,lease_until=NULL,next_attempt_at=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='running' AND lease_until>?`)
    .bind(code(reason),boundedJson(progress),now.toISOString(),id,token,now.toISOString()).run();
  if (!result.meta.changes) throw new Error("storage-migration-lease-lost");
}
export async function resumeStorageMigration(ops:D1Database,id:string,codeRevision:string,now=new Date()):Promise<void> {
  const result=await ops.prepare(`UPDATE market_storage_migrations SET status='queued',next_attempt_at=?,error_code=NULL,updated_at=?
    WHERE id=? AND code_revision=? AND status='awaiting-evidence' AND (lease_until IS NULL OR lease_until<=?)`)
    .bind(now.toISOString(),now.toISOString(),id,codeRevision,now.toISOString()).run();
  if (!result.meta.changes) throw new Error("storage-migration-resume-conflict");
}
/** Persist stage completion and release its owner directly into the next queue.
 * A separate pause/resume pair can strand work after quota/network interruption. */
export async function queueStorageMigrationStage(ops:D1Database,id:string,token:string,stage:string,progress:unknown,now=new Date()):Promise<void> {
  if (!/^[a-z0-9-]{1,80}$/.test(stage)) throw new Error("storage-migration-stage-invalid");
  const result=await ops.prepare(`UPDATE market_storage_migrations SET status='queued',stage=?,progress_json=?,
    next_attempt_at=?,error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=?
    WHERE id=? AND lease_token=? AND status='running' AND lease_until>?`)
    .bind(stage,boundedJson(progress),now.toISOString(),now.toISOString(),id,token,now.toISOString()).run();
  if (!result.meta.changes) throw new Error("storage-migration-lease-lost");
}
/** A bounded processing slice is successful checkpointed work. Preserve its
 * exact stage/progress and release only the healthy owner for automatic resume. */
export async function yieldStorageMigration(ops:D1Database,id:string,token:string,now=new Date()):Promise<void> {
  const result=await ops.prepare(`UPDATE market_storage_migrations SET status='queued',
    next_attempt_at=?,error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=?
    WHERE id=? AND lease_token=? AND status='running' AND lease_until>?`)
    .bind(now.toISOString(),now.toISOString(),id,token,now.toISOString()).run();
  if (!result.meta.changes) throw new Error("storage-migration-lease-lost");
}
/** Stops resumption before releasing the source. Interrupted aborts remain in
 * 'aborting' and can be replayed; a live copy lease or activated target forbids it. */
export async function abortStorageMigration(ops:D1Database,source:D1Database,id:string,
  confirmation:{sourceDatabaseId:string;sourceStillCanonical:true;targetNeverActivated:true},now=new Date()):Promise<void> {
  const run=await loadStorageMigration(ops,id);
  if (!run || run.source_database_id!==confirmation.sourceDatabaseId.toLowerCase()
    || confirmation.sourceStillCanonical!==true || confirmation.targetNeverActivated!==true || run.status==="completed") {
    throw new Error("storage-migration-abort-canonical-proof-required");
  }
  if (run.status==="aborted") return;
  const stopped=await ops.prepare(`UPDATE market_storage_migrations SET status='aborting',dispatch_token=NULL,next_attempt_at=NULL,updated_at=?
    WHERE id=? AND status<>'completed' AND status<>'aborted' AND (lease_until IS NULL OR lease_until<=?)`)
    .bind(now.toISOString(),id,now.toISOString()).run();
  if (!stopped.meta.changes) throw new Error("storage-migration-abort-live-lease");
  await releaseStorageSourceFence(source,storageMigrationIdentity(run),run.source_schema_hash ?? "",confirmation,now);
  await ops.prepare(`UPDATE market_storage_migrations SET status='aborted',lease_token=NULL,lease_until=NULL,updated_at=?,completed_at=?
    WHERE id=? AND status='aborting'`).bind(now.toISOString(),now.toISOString(),id).run();
}
/** The deployment command calls this only after independently verifying its
 * canonical target binding and retained frozen-source rollback evidence. */
export async function completeStorageMigration(ops:D1Database,id:string,input:{targetDatabaseId:string;codeRevision:string;cutoverEvidenceHash:string},now=new Date()):Promise<void> {
  if (!hash.test(input.cutoverEvidenceHash)) throw new Error("storage-migration-cutover-evidence-invalid");
  const result=await ops.prepare(`UPDATE market_storage_migrations SET status='completed',stage='cutover',
    progress_json=json_set(progress_json,'$.cutoverEvidenceHash',?),completed_at=?,updated_at=?
    WHERE id=? AND target_database_id=? AND COALESCE(execution_revision,code_revision)=? AND status='awaiting-cutover'`)
    .bind(input.cutoverEvidenceHash,now.toISOString(),now.toISOString(),id,input.targetDatabaseId.toLowerCase(),input.codeRevision).run();
  if (!result.meta.changes) throw new Error("storage-migration-cutover-not-ready");
}
export async function storageMigrationBlocksEod(env:Env): Promise<boolean> {
  if (!env.EOD_STORAGE_MIGRATION_ID) return false;
  if (!env.OPS_DB) throw new Error("storage-migration-ops-required");
  const run=await loadStorageMigration(env.OPS_DB,env.EOD_STORAGE_MIGRATION_ID);
  if (!run) throw new Error("storage-migration-run-missing");
  return !["completed","aborted"].includes(run.status);
}
export async function publicStorageMigrationStatus(env:Env):Promise<{
  id:string;status:StorageMigrationRun["status"];stage:string;failedStage:string|null;errorCode:string|null;
  nextAttemptAt:string|null;updatedAt:string;sessionDate:string;blocksEod:boolean;
  freezeAuthorized:boolean;sourceSnapshotCaptured:boolean;copiedRows:number|null;archivedRows:number|null;
}|null> {
  if (!env.EOD_STORAGE_MIGRATION_ID) return null;
  if (!env.OPS_DB) throw new Error("storage-migration-ops-required");
  const run=await loadStorageMigration(env.OPS_DB,env.EOD_STORAGE_MIGRATION_ID);
  if (!run) throw new Error("storage-migration-run-missing");
  let progress:Record<string,unknown>={};
  try {const value:unknown=JSON.parse(run.progress_json);if(value && typeof value==="object" && !Array.isArray(value))progress=value as Record<string,unknown>;} catch { /* Report metadata even if progress is corrupt. */ }
  const count=(value:unknown) => typeof value==="number" && Number.isSafeInteger(value) && value>=0 ? value : null;
  return {id:run.id,status:run.status,stage:run.stage,failedStage:run.error_code ? run.stage : null,errorCode:run.error_code,
    nextAttemptAt:run.next_attempt_at,updatedAt:run.updated_at,sessionDate:run.session_date,
    blocksEod:!["completed","aborted"].includes(run.status),freezeAuthorized:run.freeze_authorized===1,
    sourceSnapshotCaptured:run.source_revision!==null,copiedRows:run.stage==="tables" ? count(progress.rows) : null,
    archivedRows:count(progress.archivedRows) ?? (run.stage==="archives" ? count(progress.rows) : null)};
}
