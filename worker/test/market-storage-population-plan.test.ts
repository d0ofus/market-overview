import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { approveStoragePopulationSizing, loadStoragePopulationPlan, loadStorageValidationPlan, storeStoragePopulationPlan } from "../src/market-storage-population-plan";
import { prepareStoragePreflight } from "../src/market-storage-preflight";
import { authorizeStorageMigrationFreeze, claimStorageMigration, createStorageMigration, loadStorageMigration,
  recordStorageSourceCapture, saveStorageMigrationCheckpoint } from "../src/market-storage-control";
import { storageHash } from "../src/market-storage-pages";
import { EOD_METRICS_VERSION } from "../src/eod-metrics";
import type { FrozenInputs } from "../src/eod-runner";

const now = new Date("2026-09-11T04:00:00Z"), schemaHash="b".repeat(64), accountId="c".repeat(32);
const identity={id:"market-storage:test",sourceDatabaseId:"10000000-0000-4000-8000-000000000001",
  targetDatabaseId:"10000000-0000-4000-8000-000000000002",historyDatabaseId:"10000000-0000-4000-8000-000000000003",
  sessionDate:"2026-09-08",codeRevision:"a".repeat(40)};
const snapshotSource={accountId,sourceDatabaseId:identity.sourceDatabaseId,runId:"eod:shadow:2026-09-08:daily"};
async function analysis(tickers:string[]) {
  return {version:1,measuredAt:now.toISOString(),sessionDate:identity.sessionDate,
    source:{snapshotSha256:"d".repeat(64),schemaSha256:schemaHash,capture:{kind:"logical-d1-capacity-snapshot",completeDeclared:true,partialEstimate:false}},
    population:{count:tickers.length,sha256:await storageHash(tickers)},
    archive:{sourceRows:500,storageRoundTripPassed:true,withAdditionalCompleteRevisionAndTransientBytes:10_000_000},
    bootstrap:{recentRowsToInsert:2,nonPriceRowsPreserved:true,database:{physicalBytes:1_000_000}},
    retentionModels:([260,90] as const).map(hotSessions=>({hotSessions,sweepHeadroomSessions:10,sharedTickers:tickers.length,
      modeledSipRows:tickers.length*(hotSessions+10),modeledFallbackRows:tickers.length*(hotSessions+10),fallbackTickerReserve:tickers.length,
      database:{physicalBytes:100_000_000},publicationGrowthReserveBytes:0,projectedBytes:100_000_000,under350MB:true}))};
}

describe("immutable current population sizing and replay",{timeout:30_000},()=>{
  let storage:ReturnType<typeof createSqliteD1>;
  beforeEach(()=>{storage=createSqliteD1();storage.migrate("ops-migrations");},30_000);
  afterEach(()=>storage.dispose());
  const read=async(id:string)=>JSON.parse((await storage.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
    .bind(id).first<string>("evidence_json"))!);
  async function fixture() {
    const originalTickers=["AAA","BBB"],tickers=[...originalTickers,"NEW"];
    await createStorageMigration(storage.db,identity,now);
    const preflight=await prepareStoragePreflight({analysis:await analysis(originalTickers),identity,tickers:originalTickers,
      accountId,snapshotSource,sourceSchemaHash:schemaHash,hotSessions:90,now});
    await storage.db.prepare("INSERT INTO eod_rollout_evidence VALUES(?,?,?)").bind(`storage-preflight:${identity.id}`,
      JSON.stringify({...preflight,tickers:originalTickers,calendarDates:[identity.sessionDate]}),now.toISOString()).run();
    await authorizeStorageMigrationFreeze(storage.db,identity.id,{sourceDatabaseId:identity.sourceDatabaseId,codeRevision:identity.codeRevision,
      schemaHash,evidenceHash:preflight.hash},now);
    const owner=(await claimStorageMigration(storage.db,identity.id,{now}))!;
    const sourceCapture={schemaHash,revision:0},targetCapture={schemaHash,revision:1},historyCapture={schemaHash,revision:3};
    await recordStorageSourceCapture(storage.db,identity.id,owner.leaseToken,sourceCapture,now);
    const baselineHash="e".repeat(64);
    const originalCopyCaptureHash=await storageHash([identity,sourceCapture,targetCapture,historyCapture,baselineHash,"verification-v1"]);
    const baseline={schemaVersion:1,verified:true,identity,sourceCapture,targetCapture,historyCapture,captureHash:originalCopyCaptureHash,
      archive:{baselineHash}};
    await saveStorageMigrationCheckpoint(storage.db,identity.id,owner.leaseToken,
      {key:"verification:complete",inputHash:originalCopyCaptureHash,payload:baseline},now);
    const fields={identity,sourceCapture,targetCapture:{schemaHash,revision:2},historyCapture};
    const capture={...fields,captureHash:await storageHash(fields)};
    const inputs:FrozenInputs={config:{} as FrozenInputs["config"],tickers,calendarDates:["2026-09-04",identity.sessionDate,"2026-09-09","2026-09-10"],
      methodologyVersion:EOD_METRICS_VERSION,memberships:["sp500","nasdaq100","nasdaq","russell2000","overall"].map(universeId=>({
        universeId,versionId:`v:${universeId}`,source:"official",sourceType:"official",sourceUrl:null,sourceAsOfDate:"2026-09-10",
        verifiedAt:now.toISOString(),members:["AAA"]}))};
    const run=(await loadStorageMigration(storage.db,identity.id))!;
    const store={inputs,capture,originalCopyCaptureHash,leaseToken:owner.leaseToken,now};
    const plan=await storeStoragePopulationPlan(storage.db,run,store);
    const sizingInput={analysis:await analysis(tickers),accountId,snapshotSource,now};
    return {run,store,plan,sizingInput,preflight};
  }
  it("requires separately measured current membership while preserving original source/copy identity",async()=>{
    const f=await fixture();
    expect(f.plan.tickers).toEqual(["AAA","BBB","NEW"]);
    expect(f.plan.capture.identity.sessionDate).toBe("2026-09-08");
    expect(f.plan.sessionDate).toBe("2026-09-10");
    await expect(loadStorageValidationPlan(storage.db,f.run)).rejects.toThrow("sizing-required");
    await approveStoragePopulationSizing(storage.db,f.run,f.sizingInput);
    const valid=await loadStorageValidationPlan(storage.db,f.run);
    expect(valid.bootstrapInputs).toEqual(f.store.inputs);
    const sizing=await read(`storage-population-sizing:${f.plan.planHash}`);
    expect(sizing.prepared.evidence).toMatchObject({hotSessions:90,tickerCount:3,sourceSnapshotHash:f.preflight.evidence.sourceSnapshotHash});
    expect(await read(`storage-preflight:${identity.id}`)).toMatchObject({hash:f.preflight.hash,tickers:["AAA","BBB"]});
  });
  it("replays lost acknowledgments without replacing immutable plan, sizing dates, or hashes",async()=>{
    const f=await fixture(),hash=await approveStoragePopulationSizing(storage.db,f.run,f.sizingInput);
    const original=await read(`storage-population-sizing:${f.plan.planHash}`);
    const later=new Date(now.getTime()+1_000);
    expect(await storeStoragePopulationPlan(storage.db,f.run,{...f.store,now:later})).toEqual(f.plan);
    expect(await approveStoragePopulationSizing(storage.db,f.run,{...f.sizingInput,now:later,
      analysis:{...f.sizingInput.analysis,measuredAt:later.toISOString()}})).toBe(hash);
    expect(await read(`storage-population-sizing:${f.plan.planHash}`)).toEqual(original);
  });
  it("carries same-population historical sizing to a later session without redating parity or measurements",async()=>{
    const f=await fixture();await approveStoragePopulationSizing(storage.db,f.run,f.sizingInput);
    const original=await read(`storage-population-sizing:${f.plan.planHash}`);
    const inputs={...f.store.inputs,calendarDates:[...f.store.inputs.calendarDates.slice(1),"2026-09-11"]};
    const next=await storeStoragePopulationPlan(storage.db,f.run,{...f.store,inputs,predecessorPlanHash:f.plan.planHash});
    expect(next.planHash).not.toBe(f.plan.planHash);
    expect(next.capture).toEqual(f.plan.capture);
    expect(next.calendarDates).toEqual(f.plan.calendarDates);
    expect(next.inputs.calendarDates).toEqual(inputs.calendarDates);
    const valid=await loadStorageValidationPlan(storage.db,f.run);
    expect(valid.sizingHash).toBe(original.prepared.hash);
    expect(await read(`storage-population-sizing:${next.planHash}`)).toEqual({...original,planHash:next.planHash});
    expect(await storeStoragePopulationPlan(storage.db,f.run,{...f.store,inputs,predecessorPlanHash:f.plan.planHash,
      now:new Date(now.getTime()+1_000)})).toEqual(next);
  });
  it("never reuses predecessor sizing for changed securities or changed captured prices",async()=>{
    const f=await fixture();await approveStoragePopulationSizing(storage.db,f.run,f.sizingInput);
    const inputs={...f.store.inputs,calendarDates:[...f.store.inputs.calendarDates,"2026-09-11"],tickers:[...f.plan.tickers,"OTHER"]};
    await expect(storeStoragePopulationPlan(storage.db,f.run,{...f.store,inputs,predecessorPlanHash:f.plan.planHash})).rejects.toThrow("predecessor-mismatch");
    await expect(storeStoragePopulationPlan(storage.db,f.run,{...f.store,inputs:{...inputs,tickers:f.plan.tickers},predecessorPlanHash:f.plan.planHash,
      capture:{...f.plan.capture,captureHash:"f".repeat(64)}})).rejects.toThrow("predecessor-mismatch");
  });
  it("rejects self-consistent but wrongly bound sizing and a stale writer",async()=>{
    const f=await fixture();await approveStoragePopulationSizing(storage.db,f.run,f.sizingInput);
    const key=`storage-population-sizing:${f.plan.planHash}`,record=await read(key);
    record.prepared.evidence.identity.targetDatabaseId=identity.sourceDatabaseId;
    record.prepared.hash=await storageHash(record.prepared.evidence);
    await storage.db.prepare("UPDATE eod_rollout_evidence SET evidence_json=? WHERE id=?").bind(JSON.stringify(record),key).run();
    await expect(loadStorageValidationPlan(storage.db,f.run)).rejects.toThrow("sizing-required");
    await expect(storeStoragePopulationPlan(storage.db,f.run,{...f.store,leaseToken:"stale"})).rejects.toThrow("lease-lost");
  });
  it("validates the baseline payload and cannot authorize with a matching checkpoint label alone",async()=>{
    const f=await fixture();
    await storage.db.prepare("UPDATE market_storage_checkpoints SET payload_json='{}' WHERE migration_id=? AND checkpoint_key='verification:complete'")
      .bind(identity.id).run();
    await expect(loadStoragePopulationPlan(storage.db,f.run)).rejects.toThrow("original-copy-proof-mismatch");
  });
});
