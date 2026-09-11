import { storageHash } from "./market-storage-pages";
import { loadStorageMigrationCheckpoint, storageExecutionRevision, storageMigrationIdentity, type StorageMigrationRun } from "./market-storage-control";
import { prepareStoragePreflight } from "./market-storage-preflight";
import { loadStoragePreflight } from "./market-storage-pipeline";
import type { StorageAcceptanceCapture } from "./market-storage-acceptance";
import type { FrozenInputs } from "./eod-runner";
import { EOD_METRICS_VERSION } from "./eod-metrics";
import type { StorageVerificationEvidence } from "./market-storage-verification";

export type StoragePopulationPlan = {
  version: 1; planHash: string; codeRevision: string; sourcePreflightHash: string; sourceSnapshotHash: string;
  originalCopyCaptureHash: string; createdAt: string; sessionDate: string; inputs: FrozenInputs;
  capture: StorageAcceptanceCapture; tickers: string[]; calendarDates: string[];
  predecessorPlanHash?: string;
};
export type StorageValidationPlan = StoragePopulationPlan & { bootstrapInputs: FrozenInputs; sizingHash: string };
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function fail(reason: string): never { throw new Error(`storage-population-${reason}`); }
const key = (run: StorageMigrationRun, hash: string) => `storage-population-plan:${run.id}:${hash}`;
async function read<T>(ops: D1Database, id: string): Promise<T | null> {
  const value = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(id).first<string>("evidence_json");
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return fail("stored-json-invalid"); }
}
function assertInputs(plan: StoragePopulationPlan): void {
  if (!plan.inputs || !Array.isArray(plan.tickers) || !Array.isArray(plan.inputs.tickers) || !Array.isArray(plan.inputs.calendarDates)
    || !Array.isArray(plan.calendarDates) || !Array.isArray(plan.inputs.memberships)
    || plan.inputs.methodologyVersion !== EOD_METRICS_VERSION || !plan.tickers.length || plan.tickers.length > 10_000
    || new Set(plan.tickers).size !== plan.tickers.length || plan.tickers.some((ticker) => !/^[A-Z0-9][A-Z0-9.^=/-]{0,39}$/.test(ticker))
    || plan.inputs.tickers.length !== plan.tickers.length || [...plan.inputs.tickers].sort().join("\n") !== plan.tickers.join("\n")
    || plan.inputs.calendarDates.at(-1) !== plan.sessionDate || plan.calendarDates.at(-1) !== plan.capture.identity.sessionDate
    || plan.inputs.memberships.length !== 5 || new Set(plan.inputs.memberships.map((row) => row.universeId)).size !== 5
    || plan.inputs.memberships.some((row) => !Array.isArray(row.members) || !row.members.length || new Set(row.members).size !== row.members.length
      || row.members.some((ticker) => !plan.tickers.includes(ticker)))
    || [plan.inputs.calendarDates,plan.calendarDates].some((dates)=>!dates.length || dates.some((date,index)=>
      !/^\d{4}-\d{2}-\d{2}$/.test(date) || (index>0 && date<=dates[index-1])))
    || plan.sessionDate<plan.capture.identity.sessionDate || !Number.isFinite(Date.parse(plan.createdAt))) fail("inputs-incomplete");
}
async function assertPlan(ops:D1Database,run:StorageMigrationRun,plan:StoragePopulationPlan):Promise<void> {
  const {planHash,...unsigned}=plan;
  if (plan.version !== 1 || !digest(planHash) || await storageHash(unsigned) !== planHash
    || plan.codeRevision !== storageExecutionRevision(run) || plan.sourcePreflightHash !== run.freeze_evidence_hash
    || !digest(plan.originalCopyCaptureHash) || !digest(plan.sourceSnapshotHash) || !plan.capture
    || await storageHash(plan.capture.identity) !== await storageHash(storageMigrationIdentity(run))
    || plan.capture.sourceCapture.schemaHash !== run.source_schema_hash || plan.capture.sourceCapture.revision !== run.source_revision
    || [plan.capture.sourceCapture,plan.capture.targetCapture,plan.capture.historyCapture].some(row=>!digest(row.schemaHash)
      || !Number.isSafeInteger(row.revision) || row.revision<0)) fail("record-integrity");
  const {captureHash,...captureFields}=plan.capture;
  if (captureHash!==await storageHash(captureFields)) fail("capture-integrity");
  assertInputs(plan);
  const preflight=await loadStoragePreflight(ops,run);
  if(plan.sourceSnapshotHash!==preflight.evidence.sourceSnapshotHash) fail("source-snapshot-mismatch");
  const baseline=await loadStorageMigrationCheckpoint(ops,run.id,"verification:complete"), proof=baseline?.payload as StorageVerificationEvidence|undefined;
  if(!proof || proof.schemaVersion!==1 || !proof.verified || !proof.archive || !digest(proof.archive.baselineHash)
    || baseline?.inputHash!==plan.originalCopyCaptureHash || proof.captureHash!==baseline.inputHash
    || await storageHash(proof.identity)!==await storageHash(storageMigrationIdentity(run))
    || await storageHash(proof.sourceCapture)!==await storageHash(plan.capture.sourceCapture)
    || proof.captureHash!==await storageHash([proof.identity,proof.sourceCapture,proof.targetCapture,proof.historyCapture,proof.archive.baselineHash,"verification-v1"])) fail("original-copy-proof-mismatch");
}
type Sizing = {version:number;planHash:string;prepared:Awaited<ReturnType<typeof prepareStoragePreflight>>};
async function assertSizing(run:StorageMigrationRun,plan:StoragePopulationPlan,sizing:Sizing|null):Promise<Sizing> {
  const evidence=sizing?.prepared?.evidence;
  if (!sizing || sizing.version!==1 || sizing.planHash!==plan.planHash || !evidence
    || await storageHash(evidence)!==sizing.prepared.hash || evidence.version!==1 || evidence.purpose!=="relocation-preflight"
    || evidence.productionAcceptance!==false || evidence.sourceCaptureComplete!==false
    || await storageHash(evidence.identity)!==await storageHash(storageMigrationIdentity(run))
    || evidence.sourceSchemaHash!==run.source_schema_hash || evidence.hotSessions!==90
    || evidence.tickerHash!==await storageHash(plan.tickers) || evidence.tickerCount!==plan.tickers.length
    || evidence.sourceSnapshotHash!==plan.sourceSnapshotHash || !digest(evidence.analysisHash)
    || !Number.isFinite(Date.parse(evidence.preparedAt)) || evidence.planningReserveBytes<64_000_000
    || [evidence.projectedRecentBytes,evidence.projectedArchiveBytes,evidence.bootstrapBytes].some(value=>
      !Number.isSafeInteger(value) || value<=0 || value>=350_000_000)
    || evidence.bootstrapBytes+evidence.planningReserveBytes>=350_000_000) fail("sizing-required");
  return sizing;
}
export async function storeStoragePopulationPlan(ops: D1Database, run: StorageMigrationRun, input: {
  inputs: FrozenInputs; capture: StorageAcceptanceCapture; originalCopyCaptureHash: string; leaseToken: string; predecessorPlanHash?:string; now?: Date;
}): Promise<StoragePopulationPlan> {
  const preflight = await loadStoragePreflight(ops, run), now = input.now ?? new Date();
  if(!await ops.prepare("SELECT 1 FROM market_storage_migrations WHERE id=? AND lease_token=? AND lease_until>? AND status='running'")
    .bind(run.id,input.leaseToken,now.toISOString()).first()) fail("lease-lost");
  const previous=await loadStoragePopulationPlan(ops,run);
  if(previous && await storageHash(previous.inputs)===await storageHash(input.inputs)
    && await storageHash(previous.capture)===await storageHash(input.capture) && previous.originalCopyCaptureHash===input.originalCopyCaptureHash
    && (input.predecessorPlanHash===undefined || previous.predecessorPlanHash===input.predecessorPlanHash)) return previous;
  let inherited:Sizing|undefined;
  if(input.predecessorPlanHash!==undefined) {
    if(!previous || previous.planHash!==input.predecessorPlanHash || await storageHash(previous.capture)!==await storageHash(input.capture)
      || previous.originalCopyCaptureHash!==input.originalCopyCaptureHash || previous.sourceSnapshotHash!==preflight.evidence.sourceSnapshotHash
      || await storageHash(previous.tickers)!==await storageHash([...input.inputs.tickers].sort())
      || previous.sessionDate>=(input.inputs.calendarDates.at(-1) ?? "")) fail("predecessor-mismatch");
    inherited=await assertSizing(run,previous,await read<Sizing>(ops,`storage-population-sizing:${previous.planHash}`));
  }
  const unsigned = { version: 1 as const, codeRevision: storageExecutionRevision(run), sourcePreflightHash: preflight.hash,
    sourceSnapshotHash: preflight.evidence.sourceSnapshotHash, originalCopyCaptureHash: input.originalCopyCaptureHash,
    createdAt: now.toISOString(), sessionDate: input.inputs.calendarDates.at(-1)!, inputs: input.inputs, capture: input.capture,
    tickers: [...input.inputs.tickers].sort(), calendarDates: inherited ? [...previous!.calendarDates]
      : input.inputs.calendarDates.filter((date) => date <= run.session_date),
    ...(input.predecessorPlanHash ? {predecessorPlanHash:input.predecessorPlanHash} : {}) };
  const plan: StoragePopulationPlan = { ...unsigned, planHash: await storageHash(unsigned) }; assertInputs(plan);
  if (await storageHash(input.capture.identity) !== await storageHash(storageMigrationIdentity(run))
    || input.capture.sourceCapture.schemaHash !== run.source_schema_hash || input.capture.sourceCapture.revision !== run.source_revision) fail("source-capture-conflict");
  await assertPlan(ops,run,plan);
  const payload = JSON.stringify(plan), timestamp = now.toISOString();
  const results = await ops.batch([
    ops.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) SELECT ?,?,? WHERE EXISTS(
      SELECT 1 FROM market_storage_migrations WHERE id=? AND lease_token=? AND lease_until>? AND status='running')
      ON CONFLICT(id) DO NOTHING`).bind(key(run,plan.planHash),payload,timestamp,run.id,input.leaseToken,timestamp),
    ops.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) SELECT ?,?,? WHERE EXISTS(
      SELECT 1 FROM market_storage_migrations WHERE id=? AND lease_token=? AND lease_until>? AND status='running')
      ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,updated_at=excluded.updated_at
      WHERE eod_rollout_evidence.evidence_json=? RETURNING id`)
      .bind(`storage-population-current:${run.id}`,JSON.stringify({planHash:plan.planHash}),timestamp,run.id,input.leaseToken,timestamp,
        previous ? JSON.stringify({planHash:previous.planHash}) : null),
    ...(inherited ? [ops.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) SELECT ?,?,? WHERE EXISTS(
      SELECT 1 FROM market_storage_migrations WHERE id=? AND lease_token=? AND lease_until>? AND status='running')
      ON CONFLICT(id) DO NOTHING`).bind(`storage-population-sizing:${plan.planHash}`,
        JSON.stringify({...inherited,planHash:plan.planHash}),timestamp,run.id,input.leaseToken,timestamp)] : []),
  ]);
  if (results[1].results.length !== 1) fail("lease-lost");
  if(await storageHash(await read(ops,key(run,plan.planHash)))!==await storageHash(plan)) fail("record-write-conflict");
  if(inherited && (await assertSizing(run,plan,await read<Sizing>(ops,`storage-population-sizing:${plan.planHash}`))).prepared.hash!==inherited.prepared.hash) fail("sizing-conflict");
  return plan;
}
export async function loadStoragePopulationPlan(ops: D1Database, run: StorageMigrationRun): Promise<StoragePopulationPlan | null> {
  const pointer = await read<{planHash:string}>(ops,`storage-population-current:${run.id}`);
  if (!pointer) return null;
  if (!digest(pointer.planHash)) fail("pointer-invalid");
  const plan = await read<StoragePopulationPlan>(ops,key(run,pointer.planHash));
  if (!plan) fail("record-missing");
  if(plan.planHash!==pointer.planHash) fail("record-integrity");
  await assertPlan(ops,run,plan);
  return plan;
}
export async function approveStoragePopulationSizing(ops: D1Database, run: StorageMigrationRun, input: {
  analysis: unknown; accountId: string; snapshotSource: {accountId:string;sourceDatabaseId:string;runId:string}; now?: Date;
}): Promise<string> {
  const plan = await loadStoragePopulationPlan(ops,run); if (!plan) fail("plan-required");
  if(input.snapshotSource.accountId!==input.accountId || input.snapshotSource.sourceDatabaseId!==run.source_database_id
    || !input.snapshotSource.runId.includes(`:${run.session_date}:`)) fail("sizing-identity-or-retention");
  const existing=await read<Sizing>(ops,`storage-population-sizing:${plan.planHash}`);
  // An acknowledged immutable approval remains the same physical measurement.
  // Re-running the local analyzer after a lost response cannot redate it.
  if(existing) return (await assertSizing(run,plan,existing)).prepared.hash;
  const prepared = await prepareStoragePreflight({ ...input, identity:storageMigrationIdentity(run),tickers:plan.tickers,
    sourceSchemaHash:run.source_schema_hash!,hotSessions:90 });
  if (prepared.evidence.sourceSnapshotHash !== plan.sourceSnapshotHash || prepared.evidence.hotSessions !== 90) fail("sizing-identity-or-retention");
  const record = {version:1,planHash:plan.planHash,prepared}, payload=JSON.stringify(record);
  await ops.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING")
    .bind(`storage-population-sizing:${plan.planHash}`,payload,(input.now ?? new Date()).toISOString()).run();
  const stored=await assertSizing(run,plan,await read<Sizing>(ops,`storage-population-sizing:${plan.planHash}`));
  if((await loadStoragePopulationPlan(ops,run))?.planHash!==plan.planHash) fail("sizing-plan-changed");
  return stored.prepared.hash;
}
export async function loadStorageValidationPlan(ops: D1Database, run: StorageMigrationRun): Promise<StorageValidationPlan> {
  const plan = await loadStoragePopulationPlan(ops,run); if (!plan) fail("plan-required");
  const sizing = await assertSizing(run,plan,await read<Sizing>(ops,`storage-population-sizing:${plan.planHash}`));
  return {...plan,bootstrapInputs:plan.inputs,sizingHash:sizing.prepared.hash};
}
