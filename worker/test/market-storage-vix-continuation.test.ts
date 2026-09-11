import { afterEach,describe,expect,it,vi } from "vitest";
import { createStorageIndexDatabases,seedStorageIndexRecovery,identity,next,accountId } from "./helpers/storage-index-recovery";
import { prepareStorageHistoryIndexRecovery,applyStorageHistoryPointerIndexes,approveStorageHistoryIndexRecovery,
  loadStorageHistoryIndexAmendment } from "../src/market-storage-history-index-recovery";
import { approveStorageIndexLoaderContinuation,type StorageIndexLoaderCodeContract } from "../src/market-storage-history-index-continuation";
import { approveStorageVixContinuation,approveStorageVixQuarantineContinuation,STORAGE_VIX_PREVIOUS_REVISION,
  STORAGE_VIX_QUARANTINE_PREVIOUS_REVISION,storageVixContinuationKey,type StorageVixCodeContract,
  type StorageVixQuarantineCodeContract } from "../src/market-storage-vix-continuation";
import { loadStorageMigration,resumeStorageMigration,claimStorageMigration } from "../src/market-storage-control";
import { loadStorageValidationPlan,type StoragePopulationPlan } from "../src/market-storage-population-plan";
import { runStoragePipeline } from "../src/market-storage-pipeline";
import { storageHash } from "../src/market-storage-pages";
import { encodeEodPayload,decodeEodPayload } from "../src/eod-publication-codec";
import { storeEodPublication } from "../src/eod-publication-service";
import { computeEodTickerMetrics,EOD_METRICS_VERSION } from "../src/eod-metrics";
import { buildEodCatalogRow } from "../src/eod-catalog-service";
import { createEodD1Database,estimateEodQueries,type EodSql } from "../src/eod-d1-rest";
import * as eodRunner from "../src/eod-runner";
import type { Env } from "../src/types";

const revision=STORAGE_VIX_QUARANTINE_PREVIOUS_REVISION,quarantineRevision="e".repeat(40),stamp="2026-09-11T14:00:00.000Z";
type Databases=ReturnType<typeof createStorageIndexDatabases>;
let databases:Databases|undefined;
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();if(databases)Object.values(databases).forEach(db=>db.dispose());databases=undefined;});

async function prepared() {
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(stamp));
  const dbs=databases=createStorageIndexDatabases(),{source,target,history,ops}=dbs;
  history.script(`CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name VARCHAR(255) UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
    INSERT INTO d1_migrations(name,applied_at) VALUES('0001_history.sql','2026-09-08 00:00:00'),('0002_market_storage_fence.sql','2026-09-08 00:00:00');`);
  const tickers=["VIX","SPY",...Array.from({length:6317},(_,i)=>`A${String(i).padStart(5,"0")}`)];
  tickers[153]="RSHO";
  const f=await seedStorageIndexRecovery(dbs,{tickers,checkpointCount:84,copyComplete:true});
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
  return {input,env,plan:bridge.plan,eodId:f.eodId,amendment:amendment.recovery.amendment};
}

describe("VIX identity correction preserves the actual private bootstrap",()=>{
  it("rejects writer/checkpoint races, preserves 253 encoded checkpoints and Overview through both VIX continuations, and resumes the real amended pipeline",{timeout:240_000},async()=>{
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
        if(queries.some(row=>row.sql.includes("storage-vix-continuation-guard-rejected")))wire.push(queries);
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
    const {planHash:oldHash,...oldFields}=v2.plan,successorFields={...oldFields,sessionDate:"2026-09-11",predecessorPlanHash:oldHash,
      inputs:{...oldFields.inputs,calendarDates:[...oldFields.inputs.calendarDates,"2026-09-11"]}};
    const successor:StoragePopulationPlan={...successorFields,planHash:await storageHash(successorFields)};
    await ops.db.prepare("INSERT INTO eod_rollout_evidence VALUES(?,?,?)").bind(`storage-population-plan:${identity.id}:${successor.planHash}`,JSON.stringify(successor),stamp).run();
    expect(await loadStorageHistoryIndexAmendment(ops.db,v2Run,successor)).toEqual(f.amendment);
    await expect(loadStorageHistoryIndexAmendment(ops.db,v2Run,{...successor,tickers:["WRONG"]})).rejects.toThrow("lineage-mismatch");
    await resumeStorageMigration(ops.db,identity.id,identity.codeRevision);
    const claimed=await claimStorageMigration(ops.db,identity.id,{executionRevision:quarantineRevision});expect(claimed).not.toBeNull();
    const run=vi.spyOn(eodRunner,"runEodBatch").mockRejectedValue(new Error("vix-real-price-boundary"));
    const install=vi.fn(async()=>{throw new Error("unexpected-install");});
    await expect(runStoragePipeline({source:source.db,target:target.db,history:history.db,ops:ops.db,run:claimed!.run,leaseToken:claimed!.leaseToken,
      installSourceFence:install,installTargetFence:install,installHistoryFence:install,bootstrapEnv:{...f.env,EOD_CODE_REVISION:quarantineRevision},bootstrapFailureDb:ops.db})).rejects.toThrow("vix-real-price-boundary");
    expect(run).toHaveBeenCalledOnce();expect(run.mock.calls[0][3]?.storageInputs).toEqual(f.plan.inputs);expect(install).not.toHaveBeenCalled();
  });
});
vi.mock("../src/eod-rest-request-limiter",()=>({pacedEodRestFetch:(_account:string,_token:string,fetcher:typeof fetch,url:RequestInfo|URL,init:RequestInit|(()=>RequestInit))=>fetcher(url,typeof init==="function"?init():init)}));
