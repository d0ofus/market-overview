import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { authorizeStorageMigrationFreeze, claimStorageMigration, createStorageMigration, loadStorageMigration,
  pauseStorageMigration, progressStorageMigration, recordStorageSourceCapture, saveStorageMigrationCheckpoint } from "../src/market-storage-control";
import { freezeStorageSource, prepareStorageSourceFence } from "../src/market-storage-fence";
import { prepareStoragePreflight } from "../src/market-storage-preflight";
import { approveStoragePopulationSizing, storeStoragePopulationPlan } from "../src/market-storage-population-plan";
import { storagePopulationWithdrawalKey, withdrawStoragePopulationPlan } from "../src/market-storage-population-withdrawal";
import { approveStorageExecutionTransition } from "../src/market-storage-execution";
import { createEodAdmission, createEodD1Database, estimateEodQueries, type EodSql } from "../src/eod-d1-rest";
import { storageHash } from "../src/market-storage-pages";
import { EOD_METRICS_VERSION } from "../src/eod-metrics";
import type { FrozenInputs } from "../src/eod-runner";

const now=new Date("2026-09-11T09:50:00Z"),next="b".repeat(40),accountId="c".repeat(32);
const identity={id:"market-storage:withdraw-test",sourceDatabaseId:"10000000-0000-4000-8000-000000000001",
  targetDatabaseId:"10000000-0000-4000-8000-000000000002",historyDatabaseId:"10000000-0000-4000-8000-000000000003",
  sessionDate:"2026-09-08",codeRevision:"a".repeat(40)};

describe("explicit unbootstrapped population withdrawal",{timeout:60_000},()=>{
  let source:ReturnType<typeof createSqliteD1>,target:ReturnType<typeof createSqliteD1>,history:ReturnType<typeof createSqliteD1>,ops:ReturnType<typeof createSqliteD1>;
  beforeEach(()=>{
    source=createSqliteD1();target=createSqliteD1();history=createSqliteD1();ops=createSqliteD1();
    source.migrate("market-data-migrations");target.migrate("market-data-migrations");history.migrate("history-migrations");ops.migrate("ops-migrations");
  });
  afterEach(()=>{source.dispose();target.dispose();history.dispose();ops.dispose();});
  async function fixture() {
    await createStorageMigration(ops.db,identity,now);
    const captures=[];
    for(const db of [source,target,history]) {
      const planned=await prepareStorageSourceFence(db.db);
      db.script(planned.statements.map(row=>row.sql).join("\n"));
      captures.push(await freezeStorageSource(db.db,identity,planned.schemaHash,now));
    }
    const [sourceCapture,targetCapture,historyCapture]=captures,schemaHash=sourceCapture.schemaHash,tickers=["AAA"];
    const analysis={version:1,measuredAt:now.toISOString(),sessionDate:identity.sessionDate,
      source:{snapshotSha256:"d".repeat(64),schemaSha256:schemaHash,capture:{kind:"logical-d1-capacity-snapshot",completeDeclared:true,partialEstimate:false}},
      population:{count:1,sha256:await storageHash(tickers)},archive:{sourceRows:1,storageRoundTripPassed:true,withAdditionalCompleteRevisionAndTransientBytes:10_000_000},
      bootstrap:{recentRowsToInsert:1,nonPriceRowsPreserved:true,database:{physicalBytes:1_000_000}},
      retentionModels:([260,90] as const).map(hotSessions=>({hotSessions,sweepHeadroomSessions:10,sharedTickers:1,
        modeledSipRows:hotSessions+10,modeledFallbackRows:hotSessions+10,fallbackTickerReserve:1,
        database:{physicalBytes:100_000_000},publicationGrowthReserveBytes:0,projectedBytes:100_000_000,under350MB:true}))};
    const snapshotSource={accountId,sourceDatabaseId:identity.sourceDatabaseId,runId:"eod:shadow:2026-09-08:daily"};
    const preflight=await prepareStoragePreflight({analysis,identity,tickers,accountId,snapshotSource,sourceSchemaHash:schemaHash,hotSessions:90,now});
    await ops.db.prepare("INSERT INTO eod_rollout_evidence VALUES(?,?,?)").bind(`storage-preflight:${identity.id}`,
      JSON.stringify({...preflight,tickers,calendarDates:[identity.sessionDate]}),now.toISOString()).run();
    await authorizeStorageMigrationFreeze(ops.db,identity.id,{sourceDatabaseId:identity.sourceDatabaseId,codeRevision:identity.codeRevision,schemaHash,evidenceHash:preflight.hash},now);
    const owner=(await claimStorageMigration(ops.db,identity.id,{now}))!;
    await recordStorageSourceCapture(ops.db,identity.id,owner.leaseToken,sourceCapture,now);
    const baselineHash="e".repeat(64),originalCopyCaptureHash=await storageHash([identity,sourceCapture,targetCapture,historyCapture,baselineHash,"verification-v1"]);
    const proof={schemaVersion:1,verified:true,identity,sourceCapture,targetCapture,historyCapture,captureHash:originalCopyCaptureHash,archive:{baselineHash}};
    await saveStorageMigrationCheckpoint(ops.db,identity.id,owner.leaseToken,{key:"verification:complete",inputHash:originalCopyCaptureHash,payload:proof},now);
    await saveStorageMigrationCheckpoint(ops.db,identity.id,owner.leaseToken,{key:"copy-complete",inputHash:"f".repeat(64),payload:{retained:true}},now);
    const fields={identity,sourceCapture,targetCapture,historyCapture},capture={...fields,captureHash:await storageHash(fields)};
    const inputs:FrozenInputs={config:{} as FrozenInputs["config"],tickers,calendarDates:[identity.sessionDate,"2026-09-10"],methodologyVersion:EOD_METRICS_VERSION,
      memberships:["sp500","nasdaq100","nasdaq","russell2000","overall"].map(universeId=>({universeId,versionId:`v:${universeId}`,
        source:"official",sourceType:"official",sourceUrl:null,sourceAsOfDate:"2026-09-10",verifiedAt:now.toISOString(),members:tickers}))};
    const run=(await loadStorageMigration(ops.db,identity.id))!;
    const plan=await storeStoragePopulationPlan(ops.db,run,{inputs,capture,originalCopyCaptureHash,leaseToken:owner.leaseToken,now});
    await approveStoragePopulationSizing(ops.db,run,{analysis,accountId,snapshotSource,now});
    await progressStorageMigration(ops.db,identity.id,owner.leaseToken,"population-inputs",{planHash:plan.planHash},now);
    await pauseStorageMigration(ops.db,identity.id,owner.leaseToken,"storage-population-sizing-required",{planHash:plan.planHash},now);
    const input={ops:ops.db,source:source.db,target:target.db,history:history.db,migrationId:identity.id,expectedPlanHash:plan.planHash,
      executionRevision:identity.codeRevision,withdrawalRevision:next,assertReviewedCheckout:vi.fn(async()=>undefined),assertNoWorkflowWriters:vi.fn(async()=>undefined),now};
    return {plan,input,currentKey:`storage-population-current:${identity.id}`,auditKey:storagePopulationWithdrawalKey(identity.id,plan.planHash)};
  }
  const snapshot=async()=>({run:await loadStorageMigration(ops.db,identity.id),
    checkpoints:(await ops.db.prepare("SELECT * FROM market_storage_checkpoints ORDER BY checkpoint_key").all()).results,
    evidence:(await ops.db.prepare("SELECT * FROM eod_rollout_evidence ORDER BY id").all()).results});

  it("withdraws only the selected pointer, retains all evidence, and enables the unchanged execution guard",async()=>{
    const f=await fixture(),before=await snapshot();
    const statements:EodSql[][]=[],admission=createEodAdmission(ops.db,"withdraw-wire",{now:()=>now});
    const checkedOps=createEodD1Database({accountId,databaseId:"10000000-0000-4000-8000-000000000004",token:"test-only",
      allowedDatabaseIds:["10000000-0000-4000-8000-000000000004"],admission,fetcher:async(_url,init)=>{
        const body=JSON.parse(String(init?.body)) as EodSql|{batch:EodSql[]};
        const queries="batch" in body ? body.batch : [body];
        if(queries.some(row=>row.sql.includes("eod-population-withdrawal")))statements.push(queries);
        const result=await ops.db.batch(queries.map(row=>ops.db.prepare(row.sql).bind(...row.params)));
        return Response.json({success:true,result});
      }});
    const result=await withdrawStoragePopulationPlan({...f.input,ops:checkedOps});
    await admission.flush();
    expect(result.status).toBe("withdrawn");
    expect(estimateEodQueries(statements[0])).toEqual({reads:8_000,writes:32});
    expect(statements[0]).toHaveLength(2);
    const after=await snapshot();
    expect(after.run).toEqual(before.run);expect(after.checkpoints).toEqual(before.checkpoints);
    expect(after.evidence.filter(row=>row.id!==f.auditKey)).toEqual(before.evidence.filter(row=>row.id!==f.currentKey));
    expect(f.input.assertReviewedCheckout).toHaveBeenCalledTimes(2);expect(f.input.assertNoWorkflowWriters).toHaveBeenCalledTimes(2);
    expect(await withdrawStoragePopulationPlan({...f.input,now:new Date(now.getTime()+30_000)})).toEqual({status:"already-withdrawn",record:result.record});
    expect(await snapshot()).toEqual(after);
    const approved=await approveStorageExecutionTransition({ops:ops.db,source:source.db,migrationId:identity.id,
      fromRevision:identity.codeRevision,codeRevision:next,changedFiles:["worker/src/eod-runner.ts"],diffHash:"f".repeat(64),
      assertReviewedCheckout:async()=>undefined,assertNoWorkflowWriters:async()=>undefined,now});
    expect(approved.codeRevision).toBe(next);
  });

  it("recovers an ambiguous successful response without replacing the withdrawal audit",async()=>{
    const f=await fixture(),batch=ops.db.batch.bind(ops.db);
    const lost={prepare:ops.db.prepare.bind(ops.db),batch:async(rows:D1PreparedStatement[])=>{await batch(rows);throw new Error("lost-response");}} as unknown as D1Database;
    await expect(withdrawStoragePopulationPlan({...f.input,ops:lost})).rejects.toThrow("lost-response");
    const after=await snapshot();
    expect((await withdrawStoragePopulationPlan(f.input)).status).toBe("already-withdrawn");expect(await snapshot()).toEqual(after);
  });

  it("rejects the wrong plan/executor, any consumer/bootstrap checkpoint, and active workflow evidence",async()=>{
    const f=await fixture(),before=await snapshot();
    await expect(withdrawStoragePopulationPlan({...f.input,expectedPlanHash:"f".repeat(64)})).rejects.toThrow("plan-missing");
    await expect(withdrawStoragePopulationPlan({...f.input,executionRevision:"c".repeat(40)})).rejects.toThrow("revision-not-approved");
    await expect(withdrawStoragePopulationPlan({...f.input,assertNoWorkflowWriters:async()=>{throw new Error("workflow-writer-active");}})).rejects.toThrow("writer-active");
    for(const key of ["bootstrap:owner","consumer-parity:cursor"]) {
      await ops.db.prepare("INSERT INTO market_storage_checkpoints VALUES(?,?,?,?,?)").bind(identity.id,key,"f".repeat(64),"{}",now.toISOString()).run();
      await expect(withdrawStoragePopulationPlan(f.input)).rejects.toThrow("writer-or-validation-present");
      await ops.db.prepare("DELETE FROM market_storage_checkpoints WHERE migration_id=? AND checkpoint_key=?").bind(identity.id,key).run();
    }
    expect(await snapshot()).toEqual(before);
  });

  it.each(["source","target","history"] as const)("requires the actual frozen %s capture",async which=>{
    const f=await fixture();
    await ({source,target,history}[which]).db.prepare("UPDATE market_storage_fence SET revision=revision+1 WHERE id='default'").run();
    await expect(withdrawStoragePopulationPlan(f.input)).rejects.toThrow("capture-changed");
    expect(await ops.db.prepare("SELECT 1 FROM eod_rollout_evidence WHERE id=?").bind(f.currentKey).first()).not.toBeNull();
    expect(await ops.db.prepare("SELECT 1 FROM eod_rollout_evidence WHERE id=?").bind(f.auditKey).first()).toBeNull();
  });

  it.each(["run","consumer","eod-owner","pointer","sizing"])("atomically refuses a %s race after final checks",async race=>{
    const f=await fixture(),batch=ops.db.batch.bind(ops.db);
    const raced={prepare:ops.db.prepare.bind(ops.db),batch:async(rows:D1PreparedStatement[])=>{
      if(race==="run")await ops.db.prepare("UPDATE market_storage_migrations SET updated_at=? WHERE id=?").bind("changed",identity.id).run();
      if(race==="consumer")await ops.db.prepare("INSERT INTO market_storage_checkpoints VALUES(?,?,?,?,?)").bind(identity.id,"consumer-parity:cursor","f".repeat(64),"{}",now.toISOString()).run();
      if(race==="eod-owner")await ops.db.prepare("INSERT INTO eod_runs(id,session_date,purpose,mode,status,lease_until,created_at,updated_at) VALUES('r','2026-09-10','daily','active','running',?,?,?)")
        .bind(new Date(now.getTime()+60_000).toISOString(),now.toISOString(),now.toISOString()).run();
      if(race==="pointer")await ops.db.prepare("UPDATE eod_rollout_evidence SET evidence_json='{}' WHERE id=?").bind(f.currentKey).run();
      if(race==="sizing")await ops.db.prepare("UPDATE eod_rollout_evidence SET evidence_json='{}' WHERE id=?").bind(`storage-population-sizing:${f.plan.planHash}`).run();
      return batch(rows);
    }} as unknown as D1Database;
    await expect(withdrawStoragePopulationPlan({...f.input,ops:raced})).rejects.toThrow("promotion-conflict");
    expect(await ops.db.prepare("SELECT 1 FROM eod_rollout_evidence WHERE id=?").bind(f.currentKey).first()).not.toBeNull();
    expect(await ops.db.prepare("SELECT 1 FROM eod_rollout_evidence WHERE id=?").bind(f.auditKey).first()).toBeNull();
  });
});

vi.mock("../src/eod-rest-request-limiter",()=>({pacedEodRestFetch:(_account:string,_token:string,fetcher:typeof fetch,url:RequestInfo|URL,
  init:RequestInit|(()=>RequestInit))=>fetcher(url,typeof init==="function" ? init() : init)}));
