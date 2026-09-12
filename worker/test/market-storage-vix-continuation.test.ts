import { afterEach,describe,expect,it,vi } from "vitest";
import { createStorageIndexDatabases,seedStorageIndexRecovery,identity,next,accountId } from "./helpers/storage-index-recovery";
import { prepareStorageHistoryIndexRecovery,applyStorageHistoryPointerIndexes,approveStorageHistoryIndexRecovery,
  loadStorageHistoryIndexAmendment } from "../src/market-storage-history-index-recovery";
import { approveStorageIndexLoaderContinuation,type StorageIndexLoaderCodeContract } from "../src/market-storage-history-index-continuation";
import { approveStorageVixContinuation,approveStorageVixQuarantineContinuation,STORAGE_VIX_PREVIOUS_REVISION,
  STORAGE_VIX_QUARANTINE_PREVIOUS_REVISION,storageVixContinuationKey,type StorageVixCodeContract,
  type StorageVixQuarantineCodeContract } from "../src/market-storage-vix-continuation";
import { approveStoragePopulationExecution,resumeStoragePopulationExecution,storagePopulationExecutionKey,STORAGE_POPULATION_EXECUTION_PREVIOUS_REVISION,
  type StoragePopulationExecutionCodeContract } from "../src/market-storage-population-execution";
import { approveStorageListingExecution,resumeStorageListingExecution,storageListingExecutionKey,STORAGE_LISTING_EXECUTION_PREVIOUS_REVISION,
  type StorageListingExecutionCodeContract } from "../src/market-storage-listing-execution";
import { approveStorageRepairExecution,resumeStorageRepairExecution,storageRepairExecutionKey,STORAGE_REPAIR_EXECUTION_PREVIOUS_REVISION, type StorageRepairExecutionCodeContract } from "../src/market-storage-repair-execution";
import { approveStorageCapacityExecution,resumeStorageCapacityExecution,loadStorageCapacityCaptureReuse,storageCapacityExecutionKey,
  STORAGE_CAPACITY_EXECUTION_PREVIOUS_REVISION,type StorageCapacityExecutionCodeContract } from "../src/market-storage-capacity-execution";
import { runStoragePopulationDeltaProof,storeStorageExpansionHistoryReceipt,loadCompletedStoragePopulationDelta } from "../scripts/eod-population-expansion-operator";
import { loadStorageMigration,resumeStorageMigration,claimStorageMigration } from "../src/market-storage-control";
import { loadStorageValidationPlan,type StoragePopulationPlan } from "../src/market-storage-population-plan";
import { promoteStoragePopulationExpansion } from "../src/market-storage-population-promotion";
import { loadStoragePlanConsumerProof } from "../src/market-storage-consumer-composite";
import { captureOpenStorageDatabase } from "../src/eod-storage-capacity-renewal";
import { prepareStoragePreflight } from "../src/market-storage-preflight";
import { authenticateStoragePopulationArchiveContext } from "../src/eod-current-archive-validation";
import { EOD_CURRENT_ARCHIVE_FORECAST_POLICY,type StorageCurrentArchiveContext } from "../src/eod-storage-layout";
import { EOD_PUBLICATION_SCOPES } from "../src/eod-coordinator";
import { EOD_CATALOG_SCOPE } from "../src/eod-catalog-service";
import { runStoragePipeline } from "../src/market-storage-pipeline";
import { storageHash } from "../src/market-storage-pages";
import { encodeEodPayload,decodeEodPayload } from "../src/eod-publication-codec";
import { storeEodPublication } from "../src/eod-publication-service";
import { computeEodTickerMetrics,EOD_METRICS_VERSION } from "../src/eod-metrics";
import { buildEodCatalogRow } from "../src/eod-catalog-service";
import { createEodD1Database,estimateEodQueries,type EodSql } from "../src/eod-d1-rest";
import * as eodRunner from "../src/eod-runner";
import { registerListingEvidence, loadFrozenListingEvidence } from "../src/eod-listing-evidence";
import type { Env } from "../src/types";

const revision=STORAGE_VIX_QUARANTINE_PREVIOUS_REVISION,quarantineRevision=STORAGE_POPULATION_EXECUTION_PREVIOUS_REVISION,populationRevision=STORAGE_LISTING_EXECUTION_PREVIOUS_REVISION,listingRevision=STORAGE_REPAIR_EXECUTION_PREVIOUS_REVISION,
  repairRevision=STORAGE_CAPACITY_EXECUTION_PREVIOUS_REVISION,capacityRevision="c".repeat(40),stamp="2026-09-11T14:00:00.000Z";
type Databases=ReturnType<typeof createStorageIndexDatabases>;
let databases:Databases|undefined;
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();if(databases)Object.values(databases).forEach(db=>db.dispose());databases=undefined;});

async function prepared() {
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(stamp));
  const dbs=databases=createStorageIndexDatabases(),{source,target,history,ops}=dbs;
  history.script(`CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name VARCHAR(255) UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
    INSERT INTO d1_migrations(name,applied_at) VALUES('0001_history.sql','2026-09-08 00:00:00'),('0002_market_storage_fence.sql','2026-09-08 00:00:00');`);
  const tickers=["VIX","SPY",...Array.from({length:6317},(_,i)=>`A${String(i).padStart(5,"0")}`)];
  tickers[153]="RSHO";tickers[6125]="BNRG";
  const f=await seedStorageIndexRecovery(dbs,{tickers,checkpointCount:84,copyComplete:true,authenticBaseline:true,copySourceRows:1_990_234});
  await ops.db.prepare("INSERT INTO provider_budget_counters(provider_key,window_kind,window_bucket,request_count,updated_at) VALUES('yahoo','day','2026-09-11',7,?)")
    .bind(stamp).run();
  await prepareStorageHistoryIndexRecovery(f.input);await applyStorageHistoryPointerIndexes(f.input);
  const amendment=await approveStorageHistoryIndexRecovery(f.input);
  await history.db.prepare("INSERT INTO d1_migrations(name,applied_at) VALUES('0003_history_pointer_indexes.sql',?)").bind(stamp).run();
  await ops.db.prepare("UPDATE market_storage_migrations SET error_code='storage-history-index-recovery-amendment-integrity' WHERE id=?").bind(identity.id).run();
  const fields:Omit<StorageIndexLoaderCodeContract,"evidenceHash">={version:1,policy:"index-amendment-loader-normalization-v1",fromRevision:next,
    codeRevision:STORAGE_VIX_PREVIOUS_REVISION,protectedFileCount:4,protectedManifestHash:"1".repeat(64),loaderValidationHash:"2".repeat(64),
    reviewedChangesHash:"3".repeat(64),beforeTreeHash:"4".repeat(64),afterTreeHash:"5".repeat(64)};
  const bridge=await approveStorageIndexLoaderContinuation({...f.input,fromRevision:next,codeRevision:STORAGE_VIX_PREVIOUS_REVISION,
    expectedPlanHash:amendment.plan.planHash,codeContract:{...fields,evidenceHash:await storageHash(fields)}});
  const calendar=bridge.plan.inputs.calendarDates,features=[];
  for(let chunk=0;chunk<Math.ceil(tickers.length/25);chunk++) {
    const own=tickers.slice(chunk*25,chunk*25+25),metrics=own.map(ticker=>[ticker,computeEodTickerMetrics({ticker,targetSession:bridge.plan.sessionDate,
      calendarDates:calendar,bars:ticker==="VIX" || ticker==="RSHO" ? [] : calendar.map(sessionDate=>({ticker,sessionDate,close:100,high:101,low:99,open:100,
        reportedVolume:100,sourceProvider:"alpaca" as const,priceBasis:"split" as const,sourceFeed:"sip"}))})]);
    const payload=await encodeEodPayload({features:metrics,catalogRows:own.map(ticker=>buildEodCatalogRow(ticker,[],0)),
      revisions:own.flatMap(ticker=>["sip","yahoo-eod"].map(feed=>({feed,ticker,revision:0}))),errors:own.includes("VIX")?{VIX:"yahoo-session-timezone-mismatch"}:{}});
    features.push({key:`features:${chunk}`,payload:JSON.stringify(payload)});
  }
  await ops.db.batch(features.map(row=>ops.db.prepare("INSERT INTO eod_checkpoints(run_id,chunk_key,input_hash,payload_json,updated_at) VALUES(?,?,?,?,?)")
    .bind(f.eodId,row.key,"7".repeat(64),row.payload,stamp)));
  const env={DB:{} as D1Database,MARKET_DATA_DB:target.db,MARKET_HISTORY_DB:history.db,OPS_DB:ops.db,
    EOD_RUNNER_MODE:"active",EOD_READ_ENABLED:"true",EOD_ARCHIVE_PRUNE_ENABLED:"false",EOD_CODE_REVISION:revision} as Env;
  await storeEodPublication(env,{scope:"overview:default",sessionDate:bridge.plan.sessionDate,inputHash:"8".repeat(64),methodologyVersion:EOD_METRICS_VERSION,
    payload:{asOfDate:bridge.plan.sessionDate,sections:[{groups:[{rows:[{ticker:"VIX",price:null,change1d:null},
      {ticker:"RSHO",price:null,change1d:null},{ticker:"SPY",price:100,change1d:0}]}]}]},promote:true,revisions:[]});
  target.script(`INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source) VALUES('2026-09-10','09:30','16:00','alpaca');
    INSERT INTO market_calendar_refresh_state VALUES('default','2026-01-01','2026-12-31','2026-09-11T14:00:00.000Z');`);
  await ops.db.prepare("UPDATE eod_runs SET status='retrying',error_code='runner-error',error_message='storage-run-time-slice-complete',next_attempt_at=?,progress_json=? WHERE id=?")
    .bind(stamp,JSON.stringify({chunk:252,total:253,symbols:6319}),f.eodId).run();
  await ops.db.prepare("UPDATE market_storage_migrations SET status='queued',error_code=NULL,next_attempt_at=? WHERE id=?").bind(stamp,identity.id).run();
  const contractFields:Omit<StorageVixCodeContract,"evidenceHash">={version:1,policy:"vix-chicago-identity-only-v1",fromRevision:STORAGE_VIX_PREVIOUS_REVISION,
    codeRevision:revision,protectedFileCount:4,protectedManifestHash:"1".repeat(64),providerContractHash:"2".repeat(64),loaderContractHash:"3".repeat(64),
    reviewedChangesHash:"4".repeat(64),beforeTreeHash:"5".repeat(64),afterTreeHash:"6".repeat(64)};
  const input={...f.input,history:history.db,fromRevision:STORAGE_VIX_PREVIOUS_REVISION,codeRevision:revision,expectedPlanHash:bridge.plan.planHash,
    changedFiles:["worker/src/eod-price-provider.ts"],diffHash:"9".repeat(64),codeContract:{...contractFields,evidenceHash:await storageHash(contractFields)}};
  return {input,env,plan:bridge.plan,eodId:f.eodId,amendment:amendment.recovery.amendment,analysis:f.analysis,snapshotSource:f.snapshotSource};
}

describe("VIX identity correction preserves the actual private bootstrap",()=>{
  it("rejects writer/checkpoint races, preserves 253 encoded checkpoints and Overview through both VIX continuations, and resumes the real amended pipeline",{timeout:360_000},async()=>{
    const f=await prepared(),{source,target,history,ops}=databases!;
    const snapshots=async()=>({eod:await ops.db.prepare("SELECT * FROM eod_runs WHERE id=?").bind(f.eodId).first(),
      features:(await ops.db.prepare("SELECT * FROM eod_checkpoints WHERE run_id=? ORDER BY chunk_key").bind(f.eodId).all()).results,
      proofs:(await ops.db.prepare("SELECT * FROM market_storage_checkpoints WHERE checkpoint_key<>'bootstrap:owner' ORDER BY checkpoint_key").all()).results,
      publications:(await target.db.prepare("SELECT * FROM eod_publications ORDER BY id").all()).results,
      pointers:(await target.db.prepare("SELECT * FROM eod_publication_pointers ORDER BY scope").all()).results,
      history:(await history.db.prepare("SELECT * FROM market_history_blocks ORDER BY id").all()).results,
      repairs:(await target.db.prepare("SELECT * FROM eod_adjustment_repairs ORDER BY feed,ticker").all()).results,
      targetFence:await target.db.prepare("SELECT * FROM market_storage_fence WHERE id='default'").first(),
      historyFence:await history.db.prepare("SELECT * FROM market_storage_fence WHERE id='default'").first(),
      inputClock:await target.db.prepare("SELECT * FROM eod_input_clock WHERE id='default'").first(),
      revisions:(await target.db.prepare("SELECT * FROM eod_input_revisions ORDER BY feed,ticker").all()).results,
      usage:(await ops.db.prepare("SELECT * FROM eod_usage ORDER BY usage_date").all()).results,
      accountUsage:(await ops.db.prepare("SELECT * FROM eod_account_usage ORDER BY usage_date").all()).results,
      providerCounters:(await ops.db.prepare("SELECT * FROM provider_budget_counters ORDER BY provider_key,window_kind,window_bucket").all()).results,
      sourceFence:await source.db.prepare("SELECT * FROM market_storage_fence WHERE id='default'").first()});
    const before=await snapshots();expect(before.features).toHaveLength(253);
    await ops.db.prepare("UPDATE eod_runs SET lease_until=? WHERE id=?").bind("2026-09-11T14:10:00.000Z",f.eodId).run();
    await expect(approveStorageVixContinuation(f.input)).rejects.toThrow("planned-slice-required");
    await ops.db.prepare("UPDATE eod_runs SET lease_until=NULL WHERE id=?").bind(f.eodId).run();
    const feature=before.features.find(row=>row.chunk_key==="features:1")!;
    const batch=ops.db.batch.bind(ops.db),raced={prepare:ops.db.prepare.bind(ops.db),batch:async(statements:D1PreparedStatement[])=>{
      await ops.db.prepare("UPDATE eod_checkpoints SET payload_json='{}' WHERE run_id=? AND chunk_key='features:1'").bind(f.eodId).run();
      return batch(statements);
    }} as unknown as D1Database;
    await expect(approveStorageVixContinuation({...f.input,ops:raced})).rejects.toThrow("malformed JSON");
    expect(await ops.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(storageVixContinuationKey(identity.id,revision)).first()).toBeNull();
    await ops.db.prepare("UPDATE eod_checkpoints SET payload_json=? WHERE run_id=? AND chunk_key='features:1'").bind(feature.payload_json,f.eodId).run();
    // The fixed REST envelope must reject an oversized preserved checkpoint
    // manifest before submitting any approval mutation.
    const noPromotion=vi.fn(async()=>{throw new Error("unexpected-oversized-promotion");});
    await ops.db.prepare("UPDATE eod_checkpoints SET payload_json=? WHERE run_id=? AND chunk_key='features:1'")
      .bind(JSON.stringify({retained:"x".repeat(7_000_000)}),f.eodId).run();
    await expect(approveStorageVixContinuation({...f.input,ops:{prepare:ops.db.prepare.bind(ops.db),batch:noPromotion} as unknown as D1Database}))
      .rejects.toThrow("transaction-payload-exceeds-bound");
    expect(noPromotion).not.toHaveBeenCalled();
    await ops.db.prepare("UPDATE eod_checkpoints SET payload_json=? WHERE run_id=? AND chunk_key='features:1'").bind(feature.payload_json,f.eodId).run();
    const wire:EodSql[][]=[];
    const rest=createEodD1Database({accountId,token:"test",databaseId:"10000000-0000-4000-8000-000000000004",allowedDatabaseIds:["10000000-0000-4000-8000-000000000004"],
      admission:async queries=>{const estimate=estimateEodQueries(queries);return async usage=>{expect(usage.rowsRead).toBeLessThanOrEqual(estimate.reads);expect(usage.rowsWritten).toBeLessThanOrEqual(estimate.writes);};},
      fetcher:async(_url,init)=>{const body=JSON.parse(String(init?.body)) as EodSql|{batch:EodSql[]},queries="batch" in body?body.batch:[body];
        for(const query of queries){expect(query.params.length).toBeLessThanOrEqual(100);for(const value of query.params)if(typeof value==="string")expect(Buffer.byteLength(value)).toBeLessThanOrEqual(2_000_000);}
        if(queries.some(row=>/storage-(vix-continuation|population-execution|listing-execution|repair-execution|capacity-execution|population-promotion)-guard-rejected/.test(row.sql)))wire.push(queries);
        return Response.json({success:true,result:await batch(queries.map(row=>ops.db.prepare(row.sql).bind(...row.params)))});}});
    const lost={prepare:rest.prepare.bind(rest),batch:async(statements:D1PreparedStatement[])=>{await rest.batch(statements);throw new Error("vix-lost-ack");}} as unknown as D1Database;
    await expect(approveStorageVixContinuation({...f.input,ops:lost})).rejects.toThrow("vix-lost-ack");
    const result=await approveStorageVixContinuation({...f.input,ops:rest});
    expect(wire).toHaveLength(1);expect(wire[0]).toHaveLength(8);
    expect(new TextEncoder().encode(JSON.stringify({batch:wire[0]})).length).toBeLessThan(8_000_000);
    expect(result.continuation.featureCheckpointCount).toBe(253);
    expect(result.continuation.vixCheckpoint.status).toBe("null-refetch-required");
    expect(result.plan.capture).toEqual(f.plan.capture);expect(result.plan.inputs).toEqual(f.plan.inputs);
    expect(await snapshots()).toEqual(before);
    const actualRun=(await loadStorageMigration(ops.db,identity.id))!,validation=await loadStorageValidationPlan(ops.db,actualRun);
    expect(await loadStorageHistoryIndexAmendment(ops.db,actualRun,validation)).toEqual(f.amendment);
    const v1Row=await ops.db.prepare("SELECT * FROM eod_rollout_evidence WHERE id=?").bind(storageVixContinuationKey(identity.id,revision)).first();
    // A separately reviewed VIX calendar correction must preserve the v1
    // approval, the completed feature bytes, and the original index proof.
    await ops.db.prepare("UPDATE market_storage_migrations SET status='queued',stage='bootstrap',error_code=NULL,next_attempt_at=? WHERE id=?")
      .bind(stamp,identity.id).run();
    const v2Fields:Omit<StorageVixQuarantineCodeContract,"evidenceHash">={version:2,policy:"vix-sessions-rsho-dated-alias-only-v2",
      fromRevision:revision,codeRevision:quarantineRevision,protectedFileCount:4,protectedManifestHash:"1".repeat(64),
      providerContractHash:"2".repeat(64),writerContractHash:"3".repeat(64),reviewedChangesHash:"4".repeat(64),
      beforeTreeHash:"5".repeat(64),afterTreeHash:"6".repeat(64)};
    const v2Input={...f.input,fromRevision:revision,codeRevision:quarantineRevision,expectedPlanHash:result.plan.planHash,
      codeContract:{...v2Fields,evidenceHash:await storageHash(v2Fields)}};
    await ops.db.prepare("UPDATE eod_runs SET lease_until=? WHERE id=?").bind("2026-09-11T14:10:00.000Z",f.eodId).run();
    await expect(approveStorageVixQuarantineContinuation(v2Input)).rejects.toThrow("planned-slice-required");
    await ops.db.prepare("UPDATE eod_runs SET lease_until=NULL WHERE id=?").bind(f.eodId).run();
    const rshoCheckpoint=before.features.find(row=>row.chunk_key==="features:6")!;
    const rshoEncoded=JSON.parse(String(rshoCheckpoint.payload_json));
    const rshoPayload=await decodeEodPayload({...rshoEncoded,payload:"{}"}) as {features:Array<[string,{price:number|null;change1d:number|null}]>};
    const rshoFeature=rshoPayload.features.find(([ticker])=>ticker==="RSHO")![1];
    expect(rshoFeature).toMatchObject({price:null,change1d:null});
    rshoFeature.price=100;rshoFeature.change1d=0;
    await ops.db.prepare("UPDATE eod_checkpoints SET payload_json=? WHERE run_id=? AND chunk_key='features:6'")
      .bind(JSON.stringify(await encodeEodPayload(rshoPayload)),f.eodId).run();
    await expect(approveStorageVixQuarantineContinuation(v2Input)).rejects.toThrow("rsho-checkpoint-not-refetchable");
    await ops.db.prepare("UPDATE eod_checkpoints SET payload_json=? WHERE run_id=? AND chunk_key='features:6'")
      .bind(rshoCheckpoint.payload_json,f.eodId).run();
    await expect(approveStorageVixQuarantineContinuation({...v2Input,ops:raced})).rejects.toThrow("malformed JSON");
    expect(await ops.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
      .bind(storageVixContinuationKey(identity.id,quarantineRevision)).first()).toBeNull();
    await ops.db.prepare("UPDATE eod_checkpoints SET payload_json=? WHERE run_id=? AND chunk_key='features:1'").bind(feature.payload_json,f.eodId).run();
    await expect(approveStorageVixQuarantineContinuation({...v2Input,ops:lost})).rejects.toThrow("vix-lost-ack");
    const v2=await approveStorageVixQuarantineContinuation({...v2Input,ops:rest});
    expect(wire).toHaveLength(2);expect(wire[1]).toHaveLength(8);
    expect(new TextEncoder().encode(JSON.stringify({batch:wire[1]})).length).toBeLessThan(8_000_000);
    expect(v2.continuation).toMatchObject({version:2,policy:"preserve-bootstrap-vix-sessions-rsho-alias-v2",
      predecessorAuditHash:result.continuation.evidenceHash,featureCheckpointCount:253,vixCheckpoint:{status:"null-refetch-required"},
      rshoCheckpoint:{key:"features:6",status:"null-refetch-required"}});
    expect(v2.plan.capture).toEqual(f.plan.capture);expect(v2.plan.inputs).toEqual(f.plan.inputs);
    expect(await snapshots()).toEqual(before);
    expect(await ops.db.prepare("SELECT * FROM eod_rollout_evidence WHERE id=?").bind(storageVixContinuationKey(identity.id,revision)).first()).toEqual(v1Row);
    const v2Run=(await loadStorageMigration(ops.db,identity.id))!,v2Validation=await loadStorageValidationPlan(ops.db,v2Run);
    expect(await loadStorageHistoryIndexAmendment(ops.db,v2Run,v2Validation)).toEqual(f.amendment);
    const v2Record=await ops.db.prepare("SELECT * FROM eod_rollout_evidence WHERE id=?").bind(storageVixContinuationKey(identity.id,quarantineRevision)).first();
    const catalogId=await storeEodPublication({...f.env,EOD_CODE_REVISION:quarantineRevision},{scope:EOD_CATALOG_SCOPE,sessionDate:v2.plan.sessionDate,
      inputHash:"b".repeat(64),methodologyVersion:EOD_METRICS_VERSION,payload:{sessionDate:v2.plan.sessionDate,rows:[]},promote:true,revisions:[]});
    const oldOverview=await target.db.prepare("SELECT publication_id FROM eod_publication_pointers WHERE scope='overview:default'").first<string>("publication_id");
    await ops.db.prepare("UPDATE eod_runs SET status='retrying',stage='finished',error_code='incomplete-publication',next_attempt_at='2026-09-11T14:15:00.000Z',updated_at=?,progress_json=? WHERE id=?")
      .bind(stamp,JSON.stringify({symbols:6319,published:[oldOverview],catalogPublicationId:catalogId}),f.eodId).run();
    await ops.db.prepare("UPDATE market_storage_migrations SET status='retrying',stage='bootstrap',error_code='storage-bootstrap-incomplete',next_attempt_at='2026-09-11T14:15:00.000Z',updated_at=? WHERE id=?")
      .bind(stamp,identity.id).run();
    const beforePopulation=await snapshots();
    const executionFields:Omit<StoragePopulationExecutionCodeContract,"evidenceHash">={version:1,policy:"append-only-population-contracts-v1",
      fromRevision:quarantineRevision,codeRevision:populationRevision,protectedFileCount:4,protectedManifestHash:"1".repeat(64),
      integrationContractHash:"2".repeat(64),reviewedChangesHash:"3".repeat(64),beforeTreeHash:"4".repeat(64),afterTreeHash:"5".repeat(64)};
    const executionInput={...f.input,fromRevision:quarantineRevision,codeRevision:populationRevision,expectedPlanHash:v2.plan.planHash,
      changedFiles:["worker/src/market-storage-population-expansion.ts"],codeContract:{...executionFields,evidenceHash:await storageHash(executionFields)}};
    await ops.db.prepare("UPDATE eod_runs SET lease_until=? WHERE id=?").bind("2026-09-11T14:10:00.000Z",f.eodId).run();
    await expect(approveStoragePopulationExecution(executionInput)).rejects.toThrow("planned-slice-required");
    await ops.db.prepare("UPDATE eod_runs SET lease_until=NULL WHERE id=?").bind(f.eodId).run();
    await expect(approveStoragePopulationExecution({...executionInput,ops:raced})).rejects.toThrow("malformed JSON");
    expect(await ops.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
      .bind(storagePopulationExecutionKey(identity.id,populationRevision)).first()).toBeNull();
    await ops.db.prepare("UPDATE eod_checkpoints SET payload_json=? WHERE run_id=? AND chunk_key='features:1'").bind(feature.payload_json,f.eodId).run();
    await expect(approveStoragePopulationExecution({...executionInput,ops:lost})).rejects.toThrow("vix-lost-ack");
    const population=await approveStoragePopulationExecution({...executionInput,ops:rest});
    expect(wire).toHaveLength(3);expect(wire[2]).toHaveLength(8);
    expect(new TextEncoder().encode(JSON.stringify({batch:wire[2]})).length).toBeLessThan(8_000_000);
    expect(population.continuation).toMatchObject({version:1,policy:"preserve-bootstrap-population-contracts-v1",
      predecessorAuditHash:v2.continuation.evidenceHash,featureCheckpointCount:253});
    expect(population.plan.capture).toEqual(v2.plan.capture);expect(population.plan.inputs).toEqual(v2.plan.inputs);
    expect(await snapshots()).toEqual(beforePopulation);
    expect(await ops.db.prepare("SELECT * FROM eod_rollout_evidence WHERE id=?").bind(storageVixContinuationKey(identity.id,quarantineRevision)).first()).toEqual(v2Record);
    const populationRun=(await loadStorageMigration(ops.db,identity.id))!,populationValidation=await loadStorageValidationPlan(ops.db,populationRun);
    expect(await loadStorageHistoryIndexAmendment(ops.db,populationRun,populationValidation)).toEqual(f.amendment);
    const {planHash:oldHash,...oldFields}=population.plan,successorFields={...oldFields,sessionDate:"2026-09-11",predecessorPlanHash:oldHash,
      inputs:{...oldFields.inputs,calendarDates:[...oldFields.inputs.calendarDates,"2026-09-11"]}};
    const successor:StoragePopulationPlan={...successorFields,planHash:await storageHash(successorFields)};
    await ops.db.prepare("INSERT INTO eod_rollout_evidence VALUES(?,?,?)").bind(`storage-population-plan:${identity.id}:${successor.planHash}`,JSON.stringify(successor),stamp).run();
    expect(await loadStorageHistoryIndexAmendment(ops.db,populationRun,successor)).toEqual(f.amendment);
    await expect(loadStorageHistoryIndexAmendment(ops.db,populationRun,{...successor,tickers:["WRONG"]})).rejects.toThrow("lineage-mismatch");
    await resumeStoragePopulationExecution(ops.db,identity.id,populationRevision);
    expect(await ops.db.prepare("SELECT status,error_code,next_attempt_at FROM market_storage_migrations WHERE id=?").bind(identity.id).first())
      .toEqual({status:"retrying",error_code:"storage-bootstrap-incomplete",next_attempt_at:"2026-09-11T14:15:00.000Z"});
    expect(await snapshots()).toEqual(beforePopulation);
    vi.setSystemTime(new Date("2026-09-11T14:15:00.000Z"));
    const listingFields:Omit<StorageListingExecutionCodeContract,"evidenceHash">={version:1,policy:"optional-listing-evidence-contracts-v1",
      fromRevision:populationRevision,codeRevision:listingRevision,protectedFileCount:4,protectedManifestHash:"1".repeat(64),
      integrationContractHash:"2".repeat(64),reviewedChangesHash:"3".repeat(64),beforeTreeHash:"4".repeat(64),afterTreeHash:"5".repeat(64)};
    const listingInput={...f.input,now:new Date(),fromRevision:populationRevision,codeRevision:listingRevision,expectedPlanHash:population.plan.planHash,
      changedFiles:["worker/src/eod-listing-evidence.ts"],codeContract:{...listingFields,evidenceHash:await storageHash(listingFields)},
      measurePhysical:async()=>({targetBytes:1_000_000,historyBytes:1_000_000,measuredAt:new Date().toISOString()})};
    // Listing wiring cannot use R18's incomplete-publication exception.
    await expect(approveStorageListingExecution(listingInput)).rejects.toThrow("released-bootstrap-slice-required");
    await ops.db.prepare("UPDATE market_storage_migrations SET status='queued',error_code=NULL,next_attempt_at=?,updated_at=? WHERE id=?")
      .bind(new Date().toISOString(),new Date().toISOString(),identity.id).run();
    await ops.db.prepare("UPDATE eod_runs SET status='retrying',stage='prices',error_code='runner-error',error_message='storage-run-time-slice-complete',next_attempt_at=?,updated_at=?,progress_json=? WHERE id=?")
      .bind(new Date().toISOString(),new Date().toISOString(),JSON.stringify({chunk:252,total:253,symbols:6319}),f.eodId).run();
    const beforeListing=await snapshots(),oldPopulationRecord=await ops.db.prepare("SELECT * FROM eod_rollout_evidence WHERE id=?")
      .bind(storagePopulationExecutionKey(identity.id,populationRevision)).first();
    expect(Object.hasOwn(JSON.parse(String(beforeListing.eod!.input_json)),"listingEvidence")).toBe(false);
    await expect(approveStorageListingExecution({...listingInput,ops:raced})).rejects.toThrow("malformed JSON");
    expect(await ops.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
      .bind(storageListingExecutionKey(identity.id,listingRevision)).first()).toBeNull();
    await ops.db.prepare("UPDATE eod_checkpoints SET payload_json=? WHERE run_id=? AND chunk_key='features:1'").bind(feature.payload_json,f.eodId).run();
    await expect(approveStorageListingExecution({...listingInput,ops:lost})).rejects.toThrow("vix-lost-ack");
    const listing=await approveStorageListingExecution({...listingInput,ops:rest});
    expect(listing.continuation.featureCheckpointCount).toBe(253);expect(listing.plan.inputs).toEqual(population.plan.inputs);
    expect(listing.plan.capture).toEqual(population.plan.capture);expect(await snapshots()).toEqual(beforeListing);
    expect(await ops.db.prepare("SELECT * FROM eod_rollout_evidence WHERE id=?")
      .bind(storagePopulationExecutionKey(identity.id,populationRevision)).first()).toEqual(oldPopulationRecord);
    expect(wire).toHaveLength(4);expect(wire[3]).toHaveLength(8);
    const listingRun=(await loadStorageMigration(ops.db,identity.id))!,listingPlan=await loadStorageValidationPlan(ops.db,listingRun);
    expect(await loadStorageHistoryIndexAmendment(ops.db,listingRun,listingPlan)).toEqual(f.amendment);
    await resumeStorageListingExecution(ops.db,identity.id,listingRevision);
    expect(await ops.db.prepare("SELECT status,error_code,next_attempt_at FROM market_storage_migrations WHERE id=?").bind(identity.id).first())
      .toEqual({status:"queued",error_code:null,next_attempt_at:"2026-09-11T14:15:00.000Z"});
    expect(await snapshots()).toEqual(beforeListing);
    const claimed=await claimStorageMigration(ops.db,identity.id,{executionRevision:listingRevision});expect(claimed).not.toBeNull();
    const run=vi.spyOn(eodRunner,"runEodBatch").mockRejectedValue(new Error("vix-real-price-boundary"));
    const install=vi.fn(async()=>{throw new Error("unexpected-install");});
    await expect(runStoragePipeline({source:source.db,target:target.db,history:history.db,ops:ops.db,run:claimed!.run,leaseToken:claimed!.leaseToken,
      installSourceFence:install,installTargetFence:install,installHistoryFence:install,bootstrapEnv:{...f.env,EOD_CODE_REVISION:listingRevision},bootstrapFailureDb:ops.db})).rejects.toThrow("vix-real-price-boundary");
    expect(run).toHaveBeenCalledOnce();expect(run.mock.calls[0][3]?.storageInputs).toEqual(f.plan.inputs);expect(install).not.toHaveBeenCalled();
    // Exact R19 incomplete-repair admission preserves all prices and fences.
    vi.setSystemTime(new Date("2026-09-11T14:31:00.000Z"));
    await ops.db.prepare("UPDATE market_storage_migrations SET status='awaiting-evidence',stage='bootstrap',error_code='storage-copy-verification-failed',lease_token=NULL,lease_until=NULL,dispatch_token=NULL,next_attempt_at=NULL,updated_at='2026-09-11T14:15:00.000Z' WHERE id=?").bind(identity.id).run();
    await ops.db.prepare("UPDATE eod_runs SET status='retrying',stage='prices',error_code='runner-error',error_message='adjustment-repair-incomplete',lease_token=NULL,lease_until=NULL,dispatch_token=NULL,completed_at=NULL,completed_input_clock=NULL,next_attempt_at='2026-09-11T14:30:00.000Z',updated_at='2026-09-11T14:15:00.000Z',progress_json=? WHERE id=?")
      .bind(JSON.stringify({chunk:245,total:253,symbols:6125}),f.eodId).run();
    await target.db.prepare("INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,updated_at,owner_token) VALUES('sip','BNRG','pending','2026-01-02','2026-09-11T14:15:00.000Z','preserved-r19-owner')").run();
    for(const scope of EOD_PUBLICATION_SCOPES.filter(scope=>scope!=="overview:default").slice(0,3))await storeEodPublication({...f.env,EOD_CODE_REVISION:listingRevision},
      {scope,sessionDate:listing.plan.sessionDate,inputHash:await storageHash(["partial",scope]),methodologyVersion:EOD_METRICS_VERSION,payload:{asOfDate:listing.plan.sessionDate,scope},promote:true,revisions:[]});
    const repairFields:Omit<StorageRepairExecutionCodeContract,"evidenceHash">={version:1,policy:"incomplete-repair-quarantine-contracts-v1",fromRevision:listingRevision,
      codeRevision:repairRevision,protectedFileCount:4,protectedManifestHash:"1".repeat(64),integrationContractHash:"2".repeat(64),reviewedChangesHash:"3".repeat(64),beforeTreeHash:"4".repeat(64),afterTreeHash:"5".repeat(64)};
    const repairInput={...f.input,now:new Date(),fromRevision:listingRevision,codeRevision:repairRevision,expectedPlanHash:listing.plan.planHash,repairTicker:"BNRG",
      changedFiles:["worker/src/eod-runner.ts","worker/src/eod-catalog-service.ts"],codeContract:{...repairFields,evidenceHash:await storageHash(repairFields)},
      measurePhysical:async()=>({targetBytes:1_000_000,historyBytes:1_000_000,measuredAt:new Date().toISOString()})};
    const beforeRepair=await snapshots(),oldListingRecord=await ops.db.prepare("SELECT * FROM eod_rollout_evidence WHERE id=?").bind(storageListingExecutionKey(identity.id,listingRevision)).first();
    expect(beforeRepair.pointers).toHaveLength(5);
    await expect(approveStorageRepairExecution({...repairInput,repairTicker:"SPY"})).rejects.toThrow("repair-ticker-outside-failed-chunk");
    await ops.db.prepare("UPDATE eod_runs SET lease_until='2026-09-11T14:40:00.000Z' WHERE id=?").bind(f.eodId).run();
    await expect(approveStorageRepairExecution(repairInput)).rejects.toThrow("incomplete-repair-boundary-required");
    await ops.db.prepare("UPDATE eod_runs SET lease_until=NULL WHERE id=?").bind(f.eodId).run();
    const lastFeature=beforeRepair.features.find(row=>row.chunk_key==="features:252")!;
    const lastPageRace={prepare:ops.db.prepare.bind(ops.db),batch:async(statements:D1PreparedStatement[])=>{
      await ops.db.prepare("UPDATE eod_checkpoints SET payload_json='{}' WHERE run_id=? AND chunk_key='features:252'").bind(f.eodId).run();return batch(statements);
    }} as unknown as D1Database;
    await expect(approveStorageRepairExecution({...repairInput,ops:lastPageRace})).rejects.toThrow("malformed JSON");
    expect(await ops.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(storageRepairExecutionKey(identity.id,repairRevision)).first()).toBeNull();
    await ops.db.prepare("UPDATE eod_checkpoints SET payload_json=? WHERE run_id=? AND chunk_key='features:252'").bind(lastFeature.payload_json,f.eodId).run();
    await expect(approveStorageRepairExecution({...repairInput,ops:lost})).rejects.toThrow("vix-lost-ack");
    const repair=await approveStorageRepairExecution({...repairInput,ops:rest});
    expect(wire).toHaveLength(5);expect(wire[4]).toHaveLength(8);
    expect(repair.continuation.featureCheckpointCount).toBe(253);expect(repair.continuation.repairRows).toEqual(beforeRepair.repairs.filter(row=>row.ticker==="BNRG"));
    expect(repair.continuation.failureBoundary).toMatchObject({migrationStatus:"awaiting-evidence",migrationError:"storage-copy-verification-failed",eodError:"adjustment-repair-incomplete"});
    expect(await snapshots()).toEqual(beforeRepair);
    expect(await ops.db.prepare("SELECT * FROM eod_rollout_evidence WHERE id=?").bind(storageListingExecutionKey(identity.id,listingRevision)).first()).toEqual(oldListingRecord);
    const repairRun=(await loadStorageMigration(ops.db,identity.id))!,repairPlan=await loadStorageValidationPlan(ops.db,repairRun);
    expect(await loadStorageHistoryIndexAmendment(ops.db,repairRun,repairPlan)).toEqual(f.amendment);
    await resumeStorageRepairExecution(ops.db,identity.id,repairRevision);
    expect(await ops.db.prepare("SELECT status,error_code,next_attempt_at FROM market_storage_migrations WHERE id=?").bind(identity.id).first())
      .toEqual({status:"queued",error_code:null,next_attempt_at:"2026-09-11T14:30:00.000Z"});
    expect(await snapshots()).toEqual(beforeRepair);
    // Once the real older owner is completed, a separately captured append-only
    // delta can be promoted without rewriting any of the original proofs.
    vi.setSystemTime(new Date("2026-09-11T21:00:00.000Z"));
    const expansionStamp=new Date().toISOString();
    target.script("INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source) VALUES('2026-09-11','09:30','16:00','alpaca');");
    const expandedEnv={...f.env,EOD_CODE_REVISION:repairRevision};
    for(const scope of [...EOD_PUBLICATION_SCOPES,EOD_CATALOG_SCOPE].filter(value=>value!=="overview:default")) {
      await storeEodPublication(expandedEnv,{scope,sessionDate:repair.plan.sessionDate,inputHash:await storageHash(scope),
        methodologyVersion:EOD_METRICS_VERSION,payload:{asOfDate:repair.plan.sessionDate,scope},promote:true,revisions:[]});
    }
    const pointers=(await target.db.prepare("SELECT scope,publication_id FROM eod_publication_pointers ORDER BY scope").all<{scope:string;publication_id:string}>()).results;
    const clock=(await target.db.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<number>("revision"))!;
    await ops.db.prepare("UPDATE market_storage_migrations SET status='awaiting-evidence',stage='bootstrap',error_code='storage-population-expansion-required',lease_token=NULL,lease_until=NULL,dispatch_token=NULL,next_attempt_at=NULL,updated_at=? WHERE id=?")
      .bind(expansionStamp,identity.id).run();
    const added=Array.from({length:11},(_,i)=>i===0?"GOLS":`ZZDELTA${i.toString().padStart(2,"0")}`),allTickers=[...repair.plan.tickers,...added].sort();
    // Synthetic text exercises the exact reviewed fund/date identity, not a
    // generic document that could confuse a unit with a common-stock listing.
    const listingQuote="Gabelli Opportunities in Live and Sports ETF (GOLS) is now trading. Article published January 2, 2026.";
    const oldDailyBytes=await ops.db.prepare("SELECT * FROM eod_runs WHERE id=?").bind(f.eodId).first();
    await registerListingEvidence(ops.db,{version:1,event:"initial-listing",security:{ticker:added[0],issuerName:"Gabelli Opportunities in Live and Sports ETF",
      exchange:"NYSE Arca",assetClass:"etf",priorSymbols:[]},listingDate:"2026-01-02",sourcePublishedDate:"2026-01-02",
      effectiveFromSession:"2026-09-11",sourceUrl:"https://gabelli.com/research/gabelli-introduces-gols-a-new-way-to-access-the-global-sports-economy/",
      sourceDateText:"January 2, 2026",sourcePublishedDateText:"January 2, 2026",sourceQuote:listingQuote,supersedesHash:null},`<p>${listingQuote}</p>`,
      {ticker:added[0]!,issuerName:"Gabelli Opportunities in Live and Sports ETF",exchange:"NYSE Arca",assetClass:"etf",firstRetainedDate:null},
      repairRevision,new Date(expansionStamp));
    expect(await loadFrozenListingEvidence(expandedEnv,allTickers,"2026-09-10")).toBeUndefined();
    const listingEvidence=await loadFrozenListingEvidence(expandedEnv,allTickers,"2026-09-11");expect(listingEvidence?.entries).toHaveLength(1);
    expect(await ops.db.prepare("SELECT * FROM eod_runs WHERE id=?").bind(f.eodId).first()).toEqual(oldDailyBytes);
    expect(await target.db.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<number>("revision")).toBe(clock);
    const nextInputs:eodRunner.FrozenInputs={...repair.plan.inputs,tickers:allTickers,listingEvidence,calendarDates:[...repair.plan.inputs.calendarDates,"2026-09-11"],
      memberships:["sp500-core","nasdaq-core","nyse-core","russell2000-core","overall-market-proxy"].map(universeId=>({universeId,
        versionId:`actual:${universeId}:2026-09-11`,source:"public-fixture",sourceType:universeId==="sp500-core"?"public-index-constituents-proxy":
          universeId==="russell2000-core"?"official-etf-holdings-proxy":"public-common-stock-proxy",sourceUrl:null,
        sourceAsOfDate:universeId==="sp500-core"?null:"2026-09-11",verifiedAt:expansionStamp,members:allTickers}))};
    const currentInputs=vi.spyOn(eodRunner,"loadEodInputs").mockResolvedValue(nextInputs);
    const marketCapture=await captureOpenStorageDatabase(target.db),historyCapture=await captureOpenStorageDatabase(history.db);
    const captureFields={identity,sourceCapture:repair.plan.capture.sourceCapture,targetCapture:marketCapture,historyCapture};
    const capture={...captureFields,captureHash:await storageHash(captureFields)};
    const assertCapture=async()=>{expect(await captureOpenStorageDatabase(target.db)).toEqual(marketCapture);expect(await captureOpenStorageDatabase(history.db)).toEqual(historyCapture);};
    const current=(await loadStorageMigration(ops.db,identity.id))!;
    const nextInputsHash=await storageHash(nextInputs);
    const deltaInput={ops:ops.db,run:current,previousPlan:repair.plan,nextInputsHash,sourceEnv:{...expandedEnv,DB:source.db,
      MARKET_DATA_DB:source.db,MARKET_HISTORY_DB:undefined},targetEnv:expandedEnv,capture,addedTickers:added,assertCapture,assertQuiescence:async()=>undefined,maxPages:1};
    const partialDelta=await runStoragePopulationDeltaProof(deltaInput);expect(partialDelta.evidence).toBeNull();
    const delta=await runStoragePopulationDeltaProof(deltaInput);
    expect(delta.evidence?.tickerCount).toBe(11);expect(Object.keys(delta.evidence!.checks)).toHaveLength(10);
    const analysis={...f.analysis,measuredAt:expansionStamp,population:{count:6330,sha256:await storageHash(allTickers)},
      retentionModels:f.analysis.retentionModels.map(model=>({...model,sharedTickers:6330,modeledSipRows:6330*(model.hotSessions+10),
        modeledFallbackRows:6330*(model.hotSessions+10),fallbackTickerReserve:6330}))};
    const sizing=await prepareStoragePreflight({analysis,identity,tickers:allTickers,accountId,snapshotSource:f.snapshotSource,
      sourceSchemaHash:repair.plan.capture.sourceCapture.schemaHash,hotSessions:90});
    const promotionInput={env:expandedEnv,source:source.db,migrationId:identity.id,expectedPlanHash:repair.plan.planHash,
      deltaCapture:capture,deltaEvidence:delta.evidence!,preparedSizing:sizing,assertReviewedCheckout:vi.fn(async()=>undefined),
      assertNoWorkflowWriters:vi.fn(async()=>undefined),assertDeltaCapture:assertCapture,measurePhysical:async()=>({
        targetBytes:1_000_000,historyBytes:1_000_000,measuredAt:expansionStamp})};
    await expect(promoteStoragePopulationExpansion(promotionInput)).rejects.toThrow("older-owner-not-complete");
    // Completion leaves its historical error message intact in production.
    await ops.db.prepare("UPDATE eod_runs SET status='completed',stage='finished',lease_token=NULL,lease_until=NULL,dispatch_token=NULL,error_code=NULL,next_attempt_at=NULL,completed_at=?,completed_input_clock=?,progress_json=? WHERE id=?")
      .bind(expansionStamp,clock,JSON.stringify({chunk:253,total:253,symbols:6319,published:pointers.filter(row=>row.scope!==EOD_CATALOG_SCOPE).map(row=>row.publication_id),
        catalogPublicationId:pointers.find(row=>row.scope===EOD_CATALOG_SCOPE)!.publication_id}),f.eodId).run();
    await ops.db.prepare(`INSERT INTO market_storage_checkpoints(migration_id,checkpoint_key,input_hash,payload_json,updated_at)
      SELECT migration_id,?,input_hash,payload_json,? FROM market_storage_checkpoints WHERE migration_id=? AND checkpoint_key='bootstrap:owner'`)
      .bind(`bootstrap-history:${repair.plan.sessionDate}`,expansionStamp,identity.id).run();
    const baselineBeforeCapacity=await snapshots();
    const archiveContents={blocks:(await history.db.prepare("SELECT * FROM market_history_blocks ORDER BY id").all()).results,
      pointers:(await history.db.prepare("SELECT * FROM market_history_block_pointers ORDER BY feed,ticker,calendar_year").all()).results};
    const historyFileHash=await storageHash(archiveContents);
    const receipt=await storeStorageExpansionHistoryReceipt(ops.db,{migrationId:identity.id,codeRevision:repairRevision,
      previousPlanHash:repair.plan.planHash,nextInputsHash,captureHash:capture.captureHash,historyDatabaseId:identity.historyDatabaseId},
      {directory:"synthetic-real-schema-capacity-fixture",file:"history-1.sqlite",rows:archiveContents.blocks.length+archiveContents.pointers.length,
        hash:historyFileHash,fileHash:historyFileHash,capturedAt:expansionStamp});
    const oldDelta=await loadCompletedStoragePopulationDelta({ops:ops.db,migrationId:identity.id,previousPlanHash:repair.plan.planHash,
      nextInputsHash,capture,addedTickers:added});expect(oldDelta.records).toHaveLength(2);
    // This explicitly synthetic failure uses the actual observed legacy report
    // counters. It is authorization to revise the model, never a passing model.
    const physicalArchiveBytes=191_549_440;
    const failedAnalysis={...analysis,storageOnlyRecommendedHotSessions:null,
      archive:{sourceRows:1_989_616,storageRoundTripPassed:true,database:{physicalBytes:physicalArchiveBytes},
        withAdditionalCompleteRevisionAndTransientBytes:387_293_184,
        fallbackReserve:{storage:"archive-only-bounded-v1",capacityTickers:1000,totalReservedTickers:1000,existingTickers:0,
          existingTickersOutsidePopulation:0,modeledAdditionalTickers:1000,sessions:320,modeledRows:320_000,roundTripPassed:true,
          measurementMethod:"sqlite-real-history-codec-v1",tickerHash:await storageHash(allTickers.slice(0,1000)),
          physicalBytesBefore:164_438_016,physicalBytesAfter:physicalArchiveBytes}},
      retentionModels:analysis.retentionModels.map(model=>({...model,fallbackStorage:"archive-only-bounded-v1",fallbackTickerReserve:1000,modeledFallbackRows:0}))};
    const failedAnalysisFileHash=await storageHash(failedAnalysis);
    const capacityFields:Omit<StorageCapacityExecutionCodeContract,"evidenceHash">={version:1,policy:"completed-capacity-model-contracts-v1",
      fromRevision:repairRevision,codeRevision:capacityRevision,protectedFileCount:4,protectedManifestHash:"1".repeat(64),integrationContractHash:"2".repeat(64),
      reviewedChangesHash:"3".repeat(64),beforeTreeHash:"4".repeat(64),afterTreeHash:"5".repeat(64)};
    const capacityInput={...f.input,now:new Date(),fromRevision:repairRevision,codeRevision:capacityRevision,expectedPlanHash:repair.plan.planHash,
      changedFiles:["worker/scripts/analyze-eod-storage.py","worker/src/eod-storage-layout.ts"],diffHash:"a".repeat(64),
      codeContract:{...capacityFields,evidenceHash:await storageHash(capacityFields)},loadCurrentInputs:async()=>nextInputs,
      failedAnalysis,failedAnalysisFileHash,assertCapturedArtifact:async(value:typeof receipt)=>{expect(value).toEqual(receipt);return {historyFileHash,analysisFileHash:failedAnalysisFileHash};},
      measurePhysical:async()=>({targetBytes:1_000_000,historyBytes:1_000_000,measuredAt:expansionStamp})};
    await expect(approveStorageCapacityExecution({...capacityInput,assertCapturedArtifact:async()=>({historyFileHash:"0".repeat(64),analysisFileHash:failedAnalysisFileHash})}))
      .rejects.toThrow("captured-artifact-mismatch");
    await expect(approveStorageCapacityExecution({...capacityInput,ops:raced})).rejects.toThrow("malformed JSON");
    expect(await ops.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(storageCapacityExecutionKey(identity.id,capacityRevision)).first()).toBeNull();
    await ops.db.prepare("UPDATE eod_checkpoints SET payload_json=? WHERE run_id=? AND chunk_key='features:1'").bind(feature.payload_json,f.eodId).run();
    await expect(approveStorageCapacityExecution({...capacityInput,ops:lost})).rejects.toThrow("vix-lost-ack");
    const capacity=await approveStorageCapacityExecution({...capacityInput,ops:rest});
    expect(capacity.continuation.failure).toMatchObject({localSourceRows:1_989_616,verifiedCopySourceRows:1_990_234,sourceCountMismatch:true,
      projectedArchiveBytes:387_293_184,physicalArchiveBytes});
    expect(capacity.continuation.featureCheckpointCount).toBe(253);
    expect(capacity.plan.inputs).toEqual(repair.plan.inputs);expect(capacity.plan.capture).toEqual(repair.plan.capture);
    expect(await snapshots()).toEqual(baselineBeforeCapacity);
    expect(wire).toHaveLength(6);expect(wire[5]).toHaveLength(8);
    expect(Buffer.byteLength(JSON.stringify({batch:wire[5]}))).toBeLessThan(8_000_000);
    const capacityRun=(await loadStorageMigration(ops.db,identity.id))!,capacityPlan=await loadStorageValidationPlan(ops.db,capacityRun);
    expect(await loadStorageHistoryIndexAmendment(ops.db,capacityRun,capacityPlan)).toEqual(f.amendment);
    const reuse=await loadStorageCapacityCaptureReuse(ops.db,capacityRun,capacityPlan);
    expect(reuse?.receipt).toEqual(receipt);expect(reuse?.delta).toEqual(oldDelta);
    expect(reuse?.continuation.originalHistory).toEqual(capacity.continuation.originalHistory);
    const finalDelta=oldDelta.records.at(-1)!;
    await ops.db.prepare("UPDATE eod_rollout_evidence SET evidence_json='{}' WHERE id=?").bind(finalDelta.id).run();
    await expect(loadStorageCapacityCaptureReuse(ops.db,capacityRun,capacityPlan)).rejects.toThrow("completed-delta-integrity");
    await ops.db.prepare("UPDATE eod_rollout_evidence SET evidence_json=? WHERE id=?").bind(finalDelta.payload,finalDelta.id).run();
    await resumeStorageCapacityExecution(ops.db,identity.id,capacityRevision);
    expect(await ops.db.prepare("SELECT status,error_code,next_attempt_at FROM market_storage_migrations WHERE id=?").bind(identity.id).first())
      .toEqual({status:"awaiting-evidence",error_code:"storage-population-expansion-required",next_attempt_at:null});
    expect(await snapshots()).toEqual(baselineBeforeCapacity);
    // Only the separate full-population sizing supplied below can authorize
    // expansion. The failed legacy report is retained in its original receipt.
    const capacityPromotion={...promotionInput,env:{...expandedEnv,EOD_CODE_REVISION:capacityRevision},expectedPlanHash:capacity.plan.planHash};
    const priorExpansion=await snapshots(),priorOwner=await ops.db.prepare("SELECT * FROM market_storage_checkpoints WHERE migration_id=? AND checkpoint_key='bootstrap:owner'").bind(identity.id).first();
    await expect(promoteStoragePopulationExpansion({...capacityPromotion,env:{...capacityPromotion.env,OPS_DB:raced}})).rejects.toThrow("malformed JSON");
    await ops.db.prepare("UPDATE eod_checkpoints SET payload_json=? WHERE run_id=? AND chunk_key='features:1'").bind(feature.payload_json,f.eodId).run();
    await expect(promoteStoragePopulationExpansion({...capacityPromotion,env:{...capacityPromotion.env,OPS_DB:lost}})).rejects.toThrow("vix-lost-ack");
    const promoted=await promoteStoragePopulationExpansion({...capacityPromotion,env:{...capacityPromotion.env,OPS_DB:rest}});
    expect(promoted.status).toBe("already-promoted");expect(promoted.plan.tickers).toHaveLength(6330);
    expect(promoted.plan.inputs.listingEvidence).toEqual(listingEvidence);expect(Object.hasOwn(repair.plan.inputs,"listingEvidence")).toBe(false);
    expect(wire).toHaveLength(7);expect(wire[6]).toHaveLength(8);
    expect(new TextEncoder().encode(JSON.stringify({batch:wire[6]})).length).toBeLessThan(8_000_000);
    expect(promoted.plan.capture).toEqual(repair.plan.capture);
    expect(await snapshots()).toEqual(priorExpansion);
    expect(await ops.db.prepare("SELECT * FROM market_storage_checkpoints WHERE migration_id=? AND checkpoint_key='bootstrap:owner'").bind(identity.id).first()).toEqual(priorOwner);
    const promotedRun=(await loadStorageMigration(ops.db,identity.id))!,promotedPlan=await loadStorageValidationPlan(ops.db,promotedRun);
    const composite=await loadStoragePlanConsumerProof(ops.db,promotedRun,promotedPlan);
    // The final acceptance boundary resolves the original immutable capture
    // through the expanded plan; an otherwise well-shaped local context alone
    // cannot substitute another file, receipt, or authorization.
    const contextFields:Omit<StorageCurrentArchiveContext,"evidenceHash">={version:1,policy:EOD_CURRENT_ARCHIVE_FORECAST_POLICY,
      historySnapshotSha256:receipt.fileHash,historyCaptureHash:receipt.captureHash,historyCapturedAt:receipt.capturedAt,
      historyReceiptHash:receipt.evidenceHash,historyPhysicalBytes:capacity.continuation.physical.historyBytes,
      historyPhysicalMeasuredAt:capacity.continuation.physical.measuredAt,sourceSnapshotSha256:promotedPlan.sourceSnapshotHash,
      copySourceRows:capacity.continuation.failure.verifiedCopySourceRows,forecastSessionDate:promotedPlan.sessionDate,
      calendarDates:promotedPlan.inputs.calendarDates,forecastCalendarDates:Array.from({length:40},(_,index)=>
        new Date(Date.parse(`${promotedPlan.sessionDate}T00:00:00Z`)+(index+1)*86400_000).toISOString().slice(0,10)),
      tickerHash:await storageHash([...promotedPlan.tickers].sort()),
      authorization:{kind:"population-expansion",codeRevision:promotedPlan.codeRevision,evidenceHash:promotedPlan.populationExpansionHash!}};
    const context={...contextFields,evidenceHash:await storageHash(contextFields)};
    await expect(authenticateStoragePopulationArchiveContext(ops.db,identity.id,context)).resolves.toBeUndefined();
    await expect(authenticateStoragePopulationArchiveContext(ops.db,identity.id,{...context,historyReceiptHash:"0".repeat(64)}))
      .rejects.toThrow("storage-current-archive-authorization-mismatch");
    await expect(authenticateStoragePopulationArchiveContext(ops.db,identity.id,{...context,authorization:{...context.authorization,evidenceHash:"0".repeat(64)}}))
      .rejects.toThrow("storage-current-archive-authorization-mismatch");
    expect(composite.version).toBe(2);expect(composite.tickerCount).toBe(6330);
    if(composite.version!==2)throw new Error("expected-composite");
    expect(composite.baseline.evidence.completedAt).toBe(stamp);expect(composite.delta.evidence.completedAt).toBe(expansionStamp);
    expect(composite.delta.tickers).toEqual(added);expect(composite.baseline.tickers).toEqual(repair.plan.tickers);
    expect(await loadStorageHistoryIndexAmendment(ops.db,promotedRun,promotedPlan)).toEqual(f.amendment);
    const immutableCapacityRow=await ops.db.prepare("SELECT * FROM eod_rollout_evidence WHERE id=?")
      .bind(storageCapacityExecutionKey(identity.id,capacityRevision)).first();
    const nextClaim=await claimStorageMigration(ops.db,identity.id,{executionRevision:capacityRevision});expect(nextClaim).not.toBeNull();
    run.mockClear();run.mockRejectedValue(new Error("capacity-real-latest-price-boundary"));
    await expect(runStoragePipeline({source:source.db,target:target.db,history:history.db,ops:ops.db,run:nextClaim!.run,leaseToken:nextClaim!.leaseToken,
      installSourceFence:install,installTargetFence:install,installHistoryFence:install,bootstrapEnv:capacityPromotion.env,bootstrapFailureDb:ops.db}))
      .rejects.toThrow("capacity-real-latest-price-boundary");
    expect(run).toHaveBeenCalledOnce();expect(run.mock.calls[0][1]).toBe("eod:active:2026-09-11:daily");
    expect(run.mock.calls[0][3]?.storageInputs).toEqual(nextInputs);expect(install).not.toHaveBeenCalled();
    const afterLatestClaim=await snapshots();
    for(const key of ["eod","features","publications","pointers","history","repairs","inputClock","revisions","sourceFence","usage","accountUsage","providerCounters"] as const)
      expect(afterLatestClaim[key]).toEqual(priorExpansion[key]);
    expect(afterLatestClaim.proofs.filter(row=>!String(row.checkpoint_key).startsWith("bootstrap-history:")))
      .toEqual(priorExpansion.proofs.filter(row=>!String(row.checkpoint_key).startsWith("bootstrap-history:")));
    expect(await ops.db.prepare("SELECT * FROM eod_rollout_evidence WHERE id=?").bind(storageCapacityExecutionKey(identity.id,capacityRevision)).first())
      .toEqual(immutableCapacityRow);
    expect((await loadStorageCapacityCaptureReuse(ops.db,(await loadStorageMigration(ops.db,identity.id))!,promotedPlan))?.continuation.originalHistory)
      .toEqual(capacity.continuation.originalHistory);
    currentInputs.mockRestore();

  });
});
vi.mock("../src/eod-rest-request-limiter",()=>({pacedEodRestFetch:(_account:string,_token:string,fetcher:typeof fetch,url:RequestInfo|URL,init:RequestInit|(()=>RequestInit))=>fetcher(url,typeof init==="function"?init():init)}));
