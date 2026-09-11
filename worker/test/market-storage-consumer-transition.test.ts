import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { authorizeStorageMigrationFreeze, claimStorageMigration, createStorageMigration, loadStorageMigration,
  pauseStorageMigration, progressStorageMigration, recordStorageSourceCapture, saveStorageMigrationCheckpoint } from "../src/market-storage-control";
import { freezeStorageSource, prepareStorageSourceFence } from "../src/market-storage-fence";
import { prepareStoragePreflight } from "../src/market-storage-preflight";
import { approveStoragePopulationSizing, loadStorageValidationPlan, storeStoragePopulationPlan } from "../src/market-storage-population-plan";
import { approveStorageConsumerExecutionTransition, storageConsumerContinuationKey } from "../src/market-storage-consumer-transition";
import { approveStorageExecutionTransition } from "../src/market-storage-execution";
import { validateStorageConsumerCodeTrees } from "../scripts/storage-consumer-code-contract";
import { createEodAdmission, createEodD1Database, estimateEodQueries, type EodSql } from "../src/eod-d1-rest";
import { storageHash } from "../src/market-storage-pages";
import { EOD_METRICS_VERSION } from "../src/eod-metrics";
import type { FrozenInputs } from "../src/eod-runner";

const next="b".repeat(40),accountId="c".repeat(32);
const identity={id:"market-storage:consumer-continuation-test",sourceDatabaseId:"10000000-0000-4000-8000-000000000001",
  targetDatabaseId:"10000000-0000-4000-8000-000000000002",historyDatabaseId:"10000000-0000-4000-8000-000000000003",
  sessionDate:"2026-09-08",codeRevision:"a".repeat(40)};
const oldRunner='import { loadMarketHistory } from "./market-history"; export type FrozenInputs = {tickers:string[]}; export const loadEodInputs = () => 1; export async function runEodBatch() { return 1; }';
const newRunner=oldRunner.replace("loadMarketHistory }","loadMarketHistory, marketHistoryBarsMateriallyEqual }").replace("return 1; }","return 2; }");
const tree=["worker/src/eod-runner.ts","worker/src/market-storage-acceptance.ts","worker/src/market-history.ts","package-lock.json"]
  .map((path,index)=>({path,mode:"100644",blob:String(index+1).repeat(40)}));
const codeInput=()=>({fromRevision:identity.codeRevision,codeRevision:next,before:tree,after:tree.map(row=>row.path.endsWith("eod-runner.ts") ? {...row,blob:"f".repeat(40)} : row),oldRunner,newRunner});

describe("unchanged consumer implementation contract",()=>{
  it("allows only a future batch body and the exact existing reader import",()=>{
    expect(validateStorageConsumerCodeTrees(codeInput())).toMatchObject({version:1,protectedFileCount:3});
    for(const changed of [newRunner.replace("tickers:string[]","tickers:number[]"),newRunner.replace("() => 1","() => 2"),
      newRunner.replace("loadMarketHistory,","loadMarketHistory as reader,"),newRunner.replace("marketHistoryBarsMateriallyEqual","differentExport")]) {
      expect(()=>validateStorageConsumerCodeTrees({...codeInput(),newRunner:changed})).toThrow();
    }
    expect(()=>validateStorageConsumerCodeTrees({...codeInput(),after:codeInput().after.map(row=>row.path.endsWith("market-history.ts") ? {...row,blob:"9".repeat(40)} : row)}))
      .toThrow("dependency-changed");
    expect(()=>validateStorageConsumerCodeTrees({...codeInput(),oldRunner:newRunner,newRunner:oldRunner})).toThrow("outside-bootstrap-body-changed");
  });
});

describe("pre-bootstrap consumer evidence execution continuation",{timeout:90_000},()=>{
  let source:ReturnType<typeof createSqliteD1>,target:ReturnType<typeof createSqliteD1>,history:ReturnType<typeof createSqliteD1>,ops:ReturnType<typeof createSqliteD1>;
  beforeEach(()=>{source=createSqliteD1();target=createSqliteD1();history=createSqliteD1();ops=createSqliteD1();
    source.migrate("market-data-migrations");target.migrate("market-data-migrations");history.migrate("history-migrations");ops.migrate("ops-migrations");});
  afterEach(()=>{source.dispose();target.dispose();history.dispose();ops.dispose();});
  async function fixture(population=1,checkpointCount=3) {
    const now=new Date(),stamp=now.toISOString();await createStorageMigration(ops.db,identity,now);
    const captures=[];
    for(const db of [source,target,history]) {const fence=await prepareStorageSourceFence(db.db);db.script(fence.statements.map(row=>row.sql).join("\n"));
      captures.push(await freezeStorageSource(db.db,identity,fence.schemaHash,now));}
    const [sourceCapture,targetCapture,historyCapture]=captures,schemaHash=sourceCapture.schemaHash;
    const tickers=Array.from({length:population},(_,index)=>`A${index.toString().padStart(5,"0")}`);
    const analysis={version:1,measuredAt:stamp,sessionDate:identity.sessionDate,
      source:{snapshotSha256:"d".repeat(64),schemaSha256:schemaHash,capture:{kind:"logical-d1-capacity-snapshot",completeDeclared:true,partialEstimate:false}},
      population:{count:population,sha256:await storageHash(tickers)},archive:{sourceRows:population,storageRoundTripPassed:true,withAdditionalCompleteRevisionAndTransientBytes:10_000_000},
      bootstrap:{recentRowsToInsert:population,nonPriceRowsPreserved:true,database:{physicalBytes:1_000_000}},
      retentionModels:([260,90] as const).map(hotSessions=>({hotSessions,sweepHeadroomSessions:10,sharedTickers:population,
        modeledSipRows:population*(hotSessions+10),modeledFallbackRows:population*(hotSessions+10),fallbackTickerReserve:population,
        database:{physicalBytes:100_000_000},publicationGrowthReserveBytes:0,projectedBytes:100_000_000,under350MB:true}))};
    const snapshotSource={accountId,sourceDatabaseId:identity.sourceDatabaseId,runId:"eod:shadow:2026-09-08:daily"};
    const preflight=await prepareStoragePreflight({analysis,identity,tickers,accountId,snapshotSource,sourceSchemaHash:schemaHash,hotSessions:90,now});
    await ops.db.prepare("INSERT INTO eod_rollout_evidence VALUES(?,?,?)").bind(`storage-preflight:${identity.id}`,
      JSON.stringify({...preflight,tickers,calendarDates:[identity.sessionDate]}),stamp).run();
    await authorizeStorageMigrationFreeze(ops.db,identity.id,{sourceDatabaseId:identity.sourceDatabaseId,codeRevision:identity.codeRevision,schemaHash,evidenceHash:preflight.hash},now);
    const owner=(await claimStorageMigration(ops.db,identity.id,{now}))!;await recordStorageSourceCapture(ops.db,identity.id,owner.leaseToken,sourceCapture,now);
    const baselineHash="e".repeat(64),originalCopyCaptureHash=await storageHash([identity,sourceCapture,targetCapture,historyCapture,baselineHash,"verification-v1"]);
    const proof={schemaVersion:1,verified:true,identity,sourceCapture,targetCapture,historyCapture,captureHash:originalCopyCaptureHash,archive:{baselineHash}};
    await saveStorageMigrationCheckpoint(ops.db,identity.id,owner.leaseToken,{key:"verification:complete",inputHash:originalCopyCaptureHash,payload:proof},now);
    const fields={identity,sourceCapture,targetCapture,historyCapture},capture={...fields,captureHash:await storageHash(fields)};
    await saveStorageMigrationCheckpoint(ops.db,identity.id,owner.leaseToken,{key:"consumer-parity:cursor",inputHash:capture.captureHash,
      payload:{nextTicker:Math.min(2160,population),tickerCount:population,actualConsumerOutput:"retained-with-original-provenance"}},now);
    for(let index=2;index<checkpointCount;index++) await saveStorageMigrationCheckpoint(ops.db,identity.id,owner.leaseToken,
      {key:`copy:${index.toString().padStart(3,"0")}`,inputHash:"f".repeat(64),payload:{rows:index,hash:"e".repeat(64)}},now);
    const inputs:FrozenInputs={config:{} as FrozenInputs["config"],tickers,calendarDates:[identity.sessionDate,"2026-09-10"],methodologyVersion:EOD_METRICS_VERSION,
      memberships:["sp500","nasdaq100","nasdaq","russell2000","overall"].map(universeId=>({universeId,versionId:`v:${universeId}`,
        source:"official",sourceType:"official",sourceUrl:null,sourceAsOfDate:"2026-09-10",verifiedAt:stamp,members:tickers}))};
    const run=(await loadStorageMigration(ops.db,identity.id))!;
    const plan=await storeStoragePopulationPlan(ops.db,run,{inputs,capture,originalCopyCaptureHash,leaseToken:owner.leaseToken,now});
    await approveStoragePopulationSizing(ops.db,run,{analysis,accountId,snapshotSource,now});
    await progressStorageMigration(ops.db,identity.id,owner.leaseToken,"consumer-parity",{processed:2160,total:population},now);
    await pauseStorageMigration(ops.db,identity.id,owner.leaseToken,"storage-run-time-slice-complete",{processed:2160,total:population},now);
    const input={ops:ops.db,source:source.db,target:target.db,history:history.db,migrationId:identity.id,expectedPlanHash:plan.planHash,
      fromRevision:identity.codeRevision,codeRevision:next,changedFiles:["worker/src/eod-runner.ts"],diffHash:"f".repeat(64),
      codeContract:validateStorageConsumerCodeTrees(codeInput()),assertReviewedCheckout:vi.fn(async()=>undefined),assertNoWorkflowWriters:vi.fn(async()=>undefined),now};
    return {plan,input,currentKey:`storage-population-current:${identity.id}`,auditKey:storageConsumerContinuationKey(identity.id,next)};
  }
  const snapshot=async()=>({run:await loadStorageMigration(ops.db,identity.id),
    checkpoints:(await ops.db.prepare("SELECT * FROM market_storage_checkpoints ORDER BY checkpoint_key").all()).results,
    evidence:(await ops.db.prepare("SELECT * FROM eod_rollout_evidence ORDER BY id").all()).results});

  it("preserves 6,319-symbol inputs and 84 actual checkpoint records within the admitted atomic envelope",async()=>{
    const f=await fixture(6319,84),before=await snapshot(),wire:EodSql[][]=[];
    const admission=createEodAdmission(ops.db,"continuation-wire",{now:()=>f.input.now});
    const checkedOps=createEodD1Database({accountId,databaseId:"10000000-0000-4000-8000-000000000004",token:"test-only",
      allowedDatabaseIds:["10000000-0000-4000-8000-000000000004"],admission,fetcher:async(_url,init)=>{
        const body=JSON.parse(String(init?.body)) as EodSql|{batch:EodSql[]};const queries="batch" in body ? body.batch : [body];
        if(queries.some(row=>row.sql.includes("storage-consumer-transition-guard-rejected")))wire.push(queries);
        return Response.json({success:true,result:await ops.db.batch(queries.map(row=>ops.db.prepare(row.sql).bind(...row.params)))});
      }});
    const result=await approveStorageConsumerExecutionTransition({...f.input,ops:checkedOps});await admission.flush();
    expect(wire).toHaveLength(1);expect(wire[0]).toHaveLength(7);
    expect(estimateEodQueries(wire[0])).toEqual({reads:2120,writes:48});
    expect(new TextEncoder().encode(JSON.stringify({batch:wire[0]})).length).toBeLessThan(8_000_000);
    expect((await snapshot()).checkpoints).toEqual(before.checkpoints);
    const oldSizing=JSON.parse(String(before.evidence.find(row=>row.id===`storage-population-sizing:${f.plan.planHash}`)?.evidence_json));
    const newSizing=JSON.parse((await ops.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
      .bind(`storage-population-sizing:${result.plan.planHash}`).first<string>("evidence_json"))!);
    expect(newSizing).toEqual({...oldSizing,planHash:result.plan.planHash});
    expect(result.plan.inputs).toEqual(f.plan.inputs);expect(result.plan.capture).toEqual(f.plan.capture);
    expect(result.plan.codeRevision).toBe(next);expect(result.plan.planHash).not.toBe(f.plan.planHash);
    expect((await loadStorageValidationPlan(ops.db,(await loadStorageMigration(ops.db,identity.id))!)).planHash).toBe(result.plan.planHash);
    const after=await snapshot();expect(await approveStorageConsumerExecutionTransition(f.input)).toEqual(result);expect(await snapshot()).toEqual(after);
  });

  it("recovers a committed but unacknowledged transition without redating evidence",async()=>{
    const f=await fixture(),batch=ops.db.batch.bind(ops.db);
    const lost={prepare:ops.db.prepare.bind(ops.db),batch:async(rows:D1PreparedStatement[])=>{await batch(rows);throw new Error("lost-response");}} as unknown as D1Database;
    await expect(approveStorageConsumerExecutionTransition({...f.input,ops:lost})).rejects.toThrow("lost-response");
    const after=await snapshot();expect((await approveStorageConsumerExecutionTransition(f.input)).execution.codeRevision).toBe(next);
    expect(await snapshot()).toEqual(after);
  });

  it("keeps generic transitions strict and rejects released captures, bootstrap ownership and workflow writers",async()=>{
    const f=await fixture(),before=await snapshot();
    await expect(approveStorageExecutionTransition(f.input)).rejects.toThrow("late-transition-requires-new-validation");
    for(const db of [source,target,history]) {
      await db.db.prepare("UPDATE market_storage_fence SET status='open' WHERE id='default'").run();
      await expect(approveStorageConsumerExecutionTransition(f.input)).rejects.toThrow("capture-changed");
      await db.db.prepare("UPDATE market_storage_fence SET status='frozen' WHERE id='default'").run();
    }
    await ops.db.prepare("INSERT INTO market_storage_checkpoints VALUES(?,?,?,?,?)").bind(identity.id,"bootstrap:owner","f".repeat(64),"{}",f.input.now.toISOString()).run();
    await expect(approveStorageConsumerExecutionTransition(f.input)).rejects.toThrow("checkpoint-bound-or-stage");
    await ops.db.prepare("DELETE FROM market_storage_checkpoints WHERE migration_id=? AND checkpoint_key='bootstrap:owner'").bind(identity.id).run();
    await expect(approveStorageConsumerExecutionTransition({...f.input,assertNoWorkflowWriters:async()=>{throw new Error("workflow-active");}})).rejects.toThrow("workflow-active");
    expect(await snapshot()).toEqual(before);
  });

  it.each(["run","cursor","new-checkpoint","pointer","sizing","lease","new-plan-conflict"])("atomically rejects a %s race before any evidence is transferred",async race=>{
    const f=await fixture(),batch=ops.db.batch.bind(ops.db);let afterRace:Awaited<ReturnType<typeof snapshot>>|undefined;
    const raced={prepare:ops.db.prepare.bind(ops.db),batch:async(rows:D1PreparedStatement[])=>{
      if(race==="run")await ops.db.prepare("UPDATE market_storage_migrations SET updated_at='changed' WHERE id=?").bind(identity.id).run();
      if(race==="cursor")await ops.db.prepare("UPDATE market_storage_checkpoints SET payload_json='{}' WHERE migration_id=? AND checkpoint_key='consumer-parity:cursor'").bind(identity.id).run();
      if(race==="new-checkpoint")await ops.db.prepare("INSERT INTO market_storage_checkpoints VALUES(?,?,?,?,?)").bind(identity.id,"bootstrap:owner","f".repeat(64),"{}",f.input.now.toISOString()).run();
      if(race==="pointer")await ops.db.prepare("UPDATE eod_rollout_evidence SET evidence_json='{}' WHERE id=?").bind(f.currentKey).run();
      if(race==="sizing")await ops.db.prepare("UPDATE eod_rollout_evidence SET evidence_json='{}' WHERE id=?").bind(`storage-population-sizing:${f.plan.planHash}`).run();
      if(race==="lease")await ops.db.prepare("INSERT INTO eod_runs(id,session_date,purpose,mode,status,lease_until,created_at,updated_at) VALUES('r','2026-09-10','daily','active','running',?,?,?)")
        .bind(new Date(Date.now()+60_000).toISOString(),f.input.now.toISOString(),f.input.now.toISOString()).run();
      if(race==="new-plan-conflict")await ops.db.prepare("INSERT INTO eod_rollout_evidence VALUES(?,?,?)").bind(f.auditKey,"{}",f.input.now.toISOString()).run();
      afterRace=await snapshot();return batch(rows);
    }} as unknown as D1Database;
    await expect(approveStorageConsumerExecutionTransition({...f.input,ops:raced})).rejects.toThrow();
    expect(await snapshot()).toEqual(afterRace);
  });
});

vi.mock("../src/eod-rest-request-limiter",()=>({pacedEodRestFetch:(_account:string,_token:string,fetcher:typeof fetch,url:RequestInfo|URL,
  init:RequestInit|(()=>RequestInit))=>fetcher(url,typeof init==="function" ? init() : init)}));
