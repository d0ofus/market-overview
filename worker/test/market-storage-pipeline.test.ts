import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { storageHash } from "../src/market-storage-pages";
import type { StorageMigrationRun } from "../src/market-storage-control";
import type { StorageVerificationEvidence } from "../src/market-storage-verification";
import type { Env } from "../src/types";

const mocks=vi.hoisted(() => ({copy:vi.fn(),baseline:vi.fn(),verify:vi.fn(),assertCapture:vi.fn(),release:vi.fn(),consumer:vi.fn(),validate:vi.fn(),
  load:vi.fn(),save:vi.fn(),queue:vi.fn(),pause:vi.fn(),progress:vi.fn(),heartbeat:vi.fn(),expected:vi.fn(),enqueue:vi.fn(),batch:vi.fn(),
  plan:vi.fn(),validationPlan:vi.fn(),storePlan:vi.fn(),freeze:vi.fn(),inputs:vi.fn(),refresh:vi.fn(),calendar:vi.fn(),correct:vi.fn(),
  indexAmendment:vi.fn(),releaseIndexedHistory:vi.fn()}));
vi.mock("../src/market-storage-copy",()=>({runStorageCopy:mocks.copy}));
vi.mock("../src/market-storage-verification",()=>({captureStorageHistoryBaseline:mocks.baseline,runStorageVerification:mocks.verify,
  assertStorageVerificationCapture:mocks.assertCapture,releaseStorageVerificationFence:mocks.release,
  releaseStorageHistoryVerificationFence:mocks.releaseIndexedHistory,freezeStorageVerificationTarget:mocks.freeze}));
vi.mock("../src/market-storage-acceptance",()=>({verifyStorageConsumerBatch:mocks.consumer,validateStorageConsumerEvidence:mocks.validate}));
vi.mock("../src/market-storage-control",async (original)=>({...await original<typeof import("../src/market-storage-control")>(),
  loadStorageMigrationCheckpoint:mocks.load,saveStorageMigrationCheckpoint:mocks.save,queueStorageMigrationStage:mocks.queue,
  pauseStorageMigration:mocks.pause,progressStorageMigration:mocks.progress,heartbeatStorageMigration:mocks.heartbeat}));
vi.mock("../src/eod-coordinator",()=>({expectedEodSession:mocks.expected,enqueueEodRun:mocks.enqueue}));
vi.mock("../src/eod-runner",()=>({runEodBatch:mocks.batch,loadEodInputs:mocks.inputs}));
vi.mock("../src/eod",()=>({refreshBreadthUniverseMemberships:mocks.refresh}));
vi.mock("../src/market-calendar-cache",()=>({ensureMarketCalendarCoverage:mocks.calendar}));
vi.mock("../src/market-storage-bootstrap-correction",()=>({requeueStorageBootstrapCorrection:mocks.correct}));
vi.mock("../src/market-storage-history-index-recovery",()=>({loadStorageHistoryIndexAmendment:mocks.indexAmendment}));
vi.mock("../src/market-storage-population-plan",()=>({loadStoragePopulationPlan:mocks.plan,
  loadStorageValidationPlan:mocks.validationPlan,storeStoragePopulationPlan:mocks.storePlan}));
import { runStoragePipeline } from "../src/market-storage-pipeline";

describe("storage stage orchestration and private bootstrap recovery",()=>{
  const identity={id:"market-storage:stages",sourceDatabaseId:"11111111-1111-1111-1111-111111111111",
    targetDatabaseId:"22222222-2222-2222-2222-222222222222",historyDatabaseId:"33333333-3333-3333-3333-333333333333",
    sessionDate:"2026-09-08",codeRevision:"a".repeat(40)};
  let checkpoints:Map<string,{inputHash:string;payload:unknown}>,runs:Map<string,Record<string,unknown>>;
  let input:Parameters<typeof runStoragePipeline>[0],capture:StorageVerificationEvidence;
  let query:ReturnType<typeof vi.fn>;
  let plan:{planHash:string;predecessorPlanHash?:string;sessionDate:string;capture:StorageVerificationEvidence;tickers:string[];
    calendarDates:string[];originalCopyCaptureHash:string;bootstrapInputs:Record<string,unknown>};
  const planHash="9".repeat(64);
  beforeEach(async()=>{
    vi.useFakeTimers();vi.setSystemTime("2026-09-09T22:30:00Z");
    Object.values(mocks).forEach((mock)=>mock.mockReset());
    checkpoints=new Map();runs=new Map();
    const source={} as D1Database,target={} as D1Database,history={} as D1Database,core={} as D1Database;
    const evidence={sourceSchemaHash:"b".repeat(64),sourceSnapshotHash:"c".repeat(64),tickerHash:await storageHash(["SPY"]),
      identity,productionAcceptance:false,hotSessions:260};
    const hash=await storageHash(evidence),record={hash,evidence,tickers:["SPY"],calendarDates:[identity.sessionDate]};
    query=vi.fn((sql:string,params:unknown[])=>{
      if(sql.includes("SELECT evidence_json"))return {evidence_json:JSON.stringify(record)};
      if(sql.includes("FROM eod_runs"))return runs.get(String(params[0])) ?? null;
      throw new Error(`unexpected-test-query:${sql}`);
    });
    const ops={prepare:(sql:string)=>({bind:(...params:unknown[])=>({first:async()=>query(sql,params)})})} as unknown as D1Database;
    const run={id:identity.id,source_database_id:identity.sourceDatabaseId,target_database_id:identity.targetDatabaseId,
      history_database_id:identity.historyDatabaseId,session_date:identity.sessionDate,code_revision:identity.codeRevision,
      source_schema_hash:evidence.sourceSchemaHash,source_revision:7,freeze_authorized:1,freeze_evidence_hash:hash,status:"running"} as StorageMigrationRun;
    capture={schemaVersion:1,verified:true,identity,captureHash:"d".repeat(64),sourceCapture:{schemaHash:evidence.sourceSchemaHash,revision:7},
      targetCapture:{schemaHash:"e".repeat(64),revision:0},historyCapture:{schemaHash:"f".repeat(64),revision:3},
      tables:[],prices:{sourceRows:3,hotRows:1,hash:"a".repeat(64)},archive:{pointerRows:2,blockRows:3,hash:"b".repeat(64),baselinePointerRows:1,baselineBlockRows:1,baselineHash:"c".repeat(64)},
      verifiedAt:new Date().toISOString(),remainingLiveGates:["consumer-parity"]};
    input={source,target,history,ops,run,leaseToken:"lease",installSourceFence:vi.fn(),installTargetFence:vi.fn(),installHistoryFence:vi.fn(),
      bootstrapEnv:{DB:core,MARKET_DATA_DB:target,MARKET_HISTORY_DB:history,OPS_DB:ops,EOD_RUNNER_MODE:"active",EOD_ARCHIVE_PRUNE_ENABLED:"false"} as Env,
      bootstrapFailureDb:{} as D1Database};
    plan={planHash,sessionDate:"2026-09-09",capture,tickers:["SPY"],calendarDates:record.calendarDates,
      originalCopyCaptureHash:capture.captureHash,bootstrapInputs:{tickers:["SPY"]}};
    mocks.plan.mockImplementation(async()=>plan);mocks.validationPlan.mockImplementation(async()=>plan);
    mocks.indexAmendment.mockResolvedValue(null);
    mocks.freeze.mockResolvedValue(capture.targetCapture);
    mocks.inputs.mockResolvedValue({tickers:["SPY"],calendarDates:["2026-09-08","2026-09-09"],memberships:
      ["sp500-core","nasdaq-core","nyse-core","russell2000-core","overall-market-proxy"].map(universeId=>({
        universeId,versionId:universeId,sourceType:universeId==="sp500-core" ? "wikipedia-derived-public-proxy"
          : universeId==="russell2000-core" ? "official-etf-holdings-proxy" : "public-common-stock-proxy",
        sourceAsOfDate:"2026-09-09",verifiedAt:"2026-09-09T20:00:00Z",members:["SPY"]}))});
    mocks.storePlan.mockImplementation(async(_ops:unknown,_run:unknown,value:{predecessorPlanHash?:string;inputs:Record<string,unknown>})=>{
      plan={...plan,planHash:"8".repeat(64),predecessorPlanHash:value.predecessorPlanHash,
        sessionDate:(value.inputs.calendarDates as string[]).at(-1)!,bootstrapInputs:value.inputs};return plan;
    });
    mocks.load.mockImplementation(async(_db:unknown,_id:string,key:string)=>checkpoints.get(key)??null);
    mocks.save.mockImplementation(async(_db:unknown,_id:string,_token:string,value:{key:string;inputHash:string;payload:unknown})=>{
      checkpoints.set(value.key,{inputHash:value.inputHash,payload:value.payload});
    });
    mocks.copy.mockResolvedValue("copy-complete");mocks.verify.mockResolvedValue(capture);
    mocks.expected.mockResolvedValue("2026-09-09");mocks.batch.mockImplementation(async(_env:unknown,id:string)=>{
      runs.set(id,{status:"completed",session_date:id.split(":")[2],mode:"active",purpose:"daily"});
      return {status:"completed",published:[]};
    });
    mocks.enqueue.mockImplementation(async(_env:unknown,date:string)=>({id:`eod:active:${date}:daily`,session_date:date,status:"queued",next_attempt_at:null}));
    mocks.correct.mockImplementation(async(_env:unknown,request:{runId:string;sessionDate:string})=>({id:request.runId,session_date:request.sessionDate,status:"queued",next_attempt_at:null}));
  });
  afterEach(()=>vi.useRealTimers());
  const verified=()=>{
    checkpoints.set("copy-complete",{inputHash:"a".repeat(64),payload:{}});
    checkpoints.set("verification:complete",{inputHash:capture.captureHash,payload:capture});
  };
  const ready=()=>{verified();checkpoints.set("consumer-parity:complete",{inputHash:capture.captureHash,payload:{complete:true}});};
  const owner=(date="2026-09-08")=>({runId:`eod:active:${date}:daily`,sessionDate:date,targetDatabaseId:identity.targetDatabaseId});

  it("does not freeze any database before measured preflight authorization",async()=>{
    input.run.freeze_authorized=0;
    expect(await runStoragePipeline(input)).toBe("awaiting-evidence");
    expect(mocks.pause).toHaveBeenCalledWith(input.ops,identity.id,"lease","storage-capacity-preflight-required",{sourceFrozen:false});
    expect(mocks.baseline).not.toHaveBeenCalled();expect(mocks.release).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
  });
  it("uses one total time slice and retains ownership until atomic successor queue",async()=>{
    mocks.baseline.mockImplementation(async()=>{vi.setSystemTime(Date.now()+30_000);});
    expect(await runStoragePipeline({...input,deadlineMs:60_000})).toBe("queued");
    expect(mocks.baseline.mock.calls[0][0].deadlineMs).toBe(60_000);
    expect(mocks.copy.mock.calls[0][0]).toMatchObject({deadlineMs:30_000,retainLeaseOnComplete:true});
    expect(mocks.pause).not.toHaveBeenCalled();expect(mocks.queue).toHaveBeenCalledTimes(1);
  });
  it("does not start copy after baseline consumed its allotted time",async()=>{
    mocks.baseline.mockImplementation(async()=>{vi.setSystemTime(Date.now()+60_000);});
    await expect(runStoragePipeline({...input,deadlineMs:60_000})).rejects.toThrow("time-slice-complete");
    expect(mocks.copy).not.toHaveBeenCalled();expect(mocks.queue).not.toHaveBeenCalled();
  });
  it("queues completed verification atomically and leaves resumable proof if queue fails",async()=>{
    checkpoints.set("copy-complete",{inputHash:"a".repeat(64),payload:{}});
    mocks.verify.mockImplementation(async()=>{checkpoints.set("verification:complete",{inputHash:capture.captureHash,payload:capture});return capture;});
    mocks.queue.mockRejectedValueOnce(new Error("eod-d1-budget-exhausted"));
    await expect(runStoragePipeline(input)).rejects.toThrow("budget-exhausted");
    expect(checkpoints.has("verification:complete")).toBe(true);expect(mocks.pause).not.toHaveBeenCalled();
  });
  it("validates bootstrap bindings and original source before either fence release",async()=>{
    ready();input.bootstrapEnv!.MARKET_DATA_DB=input.source;
    await expect(runStoragePipeline(input)).rejects.toThrow("binding-conflict");
    expect(mocks.assertCapture).toHaveBeenCalledWith(input.source,identity,capture.sourceCapture);
    expect(mocks.release).not.toHaveBeenCalled();expect(checkpoints.has("bootstrap:owner")).toBe(false);
  });
  it("prepares the actual larger population on the private target, then waits for measured sizing",async()=>{
    verified();mocks.plan.mockResolvedValue(null);
    const memberships=["sp500-core","nasdaq-core","nyse-core","russell2000-core","overall-market-proxy"].map(universeId=>({
      universeId,versionId:universeId,sourceType:universeId==="sp500-core" ? "wikipedia-derived-public-proxy"
        : universeId==="russell2000-core" ? "official-etf-holdings-proxy" : "public-common-stock-proxy",
      sourceAsOfDate:"2026-09-09",verifiedAt:"2026-09-09T20:00:00Z",members:["SPY","NEW"]}));
    mocks.inputs.mockResolvedValue({tickers:["SPY","NEW"],calendarDates:["2026-09-08","2026-09-09"],memberships});
    mocks.validationPlan.mockRejectedValue(new Error("storage-population-sizing-required"));
    expect(await runStoragePipeline(input)).toBe("awaiting-evidence");
    expect(mocks.refresh).toHaveBeenCalledWith(input.bootstrapEnv);
    expect(mocks.storePlan.mock.calls[0][2]).toMatchObject({inputs:{tickers:["SPY","NEW"]},originalCopyCaptureHash:capture.captureHash});
    expect(mocks.freeze.mock.calls.every(([db])=>db===input.target)).toBe(true);
    expect(mocks.release.mock.calls.every(([db])=>db===input.target)).toBe(true);
    expect(mocks.pause).toHaveBeenCalledWith(input.ops,identity.id,"lease","storage-population-sizing-required",expect.any(Object));
    expect(mocks.batch).not.toHaveBeenCalled();expect(mocks.consumer).not.toHaveBeenCalled();
    expect(checkpoints.get("verification:complete")?.payload).toBe(capture);
  });
  it("refreezes membership-only target preparation after an upstream failure",async()=>{
    verified();mocks.plan.mockResolvedValue(null);mocks.refresh.mockRejectedValue(new Error("membership-source-timeout"));
    await expect(runStoragePipeline(input)).rejects.toThrow("membership-source-timeout");
    expect(mocks.freeze).toHaveBeenCalledTimes(2);expect(mocks.storePlan).not.toHaveBeenCalled();
    expect(mocks.release.mock.calls.map(([db])=>db)).toEqual([input.target]);
    expect(mocks.batch).not.toHaveBeenCalled();
  });
  it("persists bootstrap ownership before releasing either fence and resumes a partial release",async()=>{
    ready();let fail=true;
    mocks.release.mockImplementation(async(db:D1Database)=>{
      expect(checkpoints.has("bootstrap:owner")).toBe(true);
      if(db===input.target && fail){fail=false;throw new Error("d1-request-timeout");}
    });
    await expect(runStoragePipeline(input)).rejects.toThrow("d1-request-timeout");
    expect(mocks.batch).not.toHaveBeenCalled();mocks.assertCapture.mockClear();
    expect(await runStoragePipeline(input)).toBe("awaiting-evidence");
    // The original source is still asserted. Target/history now may be open, so
    // their old captures are preserved as baseline evidence rather than reused.
    expect(mocks.assertCapture.mock.calls.every(([db])=>db===input.source)).toBe(true);
    expect(checkpoints.get("bootstrap:complete")?.payload).toMatchObject(owner("2026-09-09"));
  });
  it("uses an authenticated index amendment only for history while retaining source and consumer proofs",async()=>{
    ready();const amendment={legacySchemaHash:capture.historyCapture.schemaHash,schemaHash:"2".repeat(64)};
    mocks.indexAmendment.mockResolvedValue(amendment);
    expect(await runStoragePipeline(input)).toBe("awaiting-evidence");
    expect(mocks.indexAmendment).toHaveBeenCalledWith(input.ops,input.run,plan);
    expect(mocks.releaseIndexedHistory).toHaveBeenCalledWith(input.history,identity,capture.historyCapture,amendment);
    expect(mocks.release.mock.calls.map(([db])=>db)).toEqual([input.target]);
    expect(mocks.assertCapture).toHaveBeenCalledWith(input.source,identity,capture.sourceCapture);
    expect(mocks.consumer).not.toHaveBeenCalled();
    expect(checkpoints.get("verification:complete")?.payload).toBe(capture);
    expect(mocks.batch).toHaveBeenCalledOnce();
  });
  it("does not release either store or invoke prices when index amendment authentication fails",async()=>{
    ready();mocks.indexAmendment.mockRejectedValue(new Error("storage-history-index-amendment-invalid"));
    await expect(runStoragePipeline(input)).rejects.toThrow("amendment-invalid");
    expect(mocks.release).not.toHaveBeenCalled();expect(mocks.releaseIndexedHistory).not.toHaveBeenCalled();
    expect(mocks.batch).not.toHaveBeenCalled();expect(checkpoints.has("bootstrap:complete")).toBe(false);
  });
  it("does not release the market store or invoke prices when the actual amended history schema differs",async()=>{
    ready();mocks.indexAmendment.mockResolvedValue({schemaHash:"2".repeat(64)});
    mocks.releaseIndexedHistory.mockRejectedValue(new Error("storage-history-index-amendment-schema-changed"));
    await expect(runStoragePipeline(input)).rejects.toThrow("amendment-schema-changed");
    expect(mocks.release).not.toHaveBeenCalled();expect(mocks.batch).not.toHaveBeenCalled();
    expect(checkpoints.get("verification:complete")?.payload).toBe(capture);
  });
  it("rolls over only a completed older owner and preserves dated bootstrap history",async()=>{
    ready();plan.sessionDate="2026-09-08";const previous=owner();checkpoints.set("bootstrap:owner",{inputHash:planHash,payload:previous});
    runs.set(previous.runId,{status:"completed",session_date:previous.sessionDate,mode:"active",purpose:"daily"});
    expect(await runStoragePipeline(input)).toBe("awaiting-evidence");
    expect(checkpoints.get("bootstrap-history:2026-09-08")?.payload).toEqual(previous);
    expect(checkpoints.get("bootstrap:owner")?.payload).toEqual(owner("2026-09-09"));
    expect(mocks.batch.mock.calls[0][1]).toBe("eod:active:2026-09-09:daily");
  });
  it("finishes an incomplete older owner before queueing latest-session recovery",async()=>{
    ready();plan.sessionDate="2026-09-08";const previous=owner();checkpoints.set("bootstrap:owner",{inputHash:planHash,payload:previous});
    runs.set(previous.runId,{status:"retrying",session_date:previous.sessionDate,mode:"active",purpose:"daily"});
    expect(await runStoragePipeline(input)).toBe("queued");
    expect(mocks.batch.mock.calls[0][1]).toBe(previous.runId);
    expect(checkpoints.get("bootstrap:owner")?.payload).toEqual(previous);
    expect(checkpoints.has("bootstrap:complete")).toBe(false);
    expect(mocks.queue).toHaveBeenCalledWith(input.ops,identity.id,"lease","storage-latest-bootstrap-required",expect.objectContaining({completedSession:previous.sessionDate}));
  });
  it("rejects collisions with unrelated active runs instead of taking their ownership",async()=>{
    ready();runs.set("eod:active:2026-09-09:daily",{id:"eod:active:2026-09-09:daily"});
    await expect(runStoragePipeline(input)).rejects.toThrow("existing-active-run");
    expect(mocks.release).not.toHaveBeenCalled();expect(mocks.batch).not.toHaveBeenCalled();
  });
  it("requires actual durable EOD completion instead of trusting a returned completion status",async()=>{
    ready();mocks.batch.mockResolvedValue({status:"completed",published:[]});
    await expect(runStoragePipeline(input)).rejects.toThrow("completion-not-persisted");
    expect(checkpoints.has("bootstrap:complete")).toBe(false);
  });
  it("rebuilds a completed private run after the clock helper detects a correction",async()=>{
    ready();const current=owner("2026-09-09");
    checkpoints.set("bootstrap:owner",{inputHash:planHash,payload:current});
    runs.set(current.runId,{status:"completed",session_date:current.sessionDate,mode:"active",purpose:"daily"});
    mocks.enqueue.mockResolvedValue({id:current.runId,status:"completed"});
    expect(await runStoragePipeline(input)).toBe("awaiting-evidence");
    expect(mocks.correct).toHaveBeenCalledWith(input.bootstrapEnv,expect.objectContaining({
      planHash,plannedInputs:plan.bootstrapInputs,runId:current.runId}));
    expect(mocks.batch).toHaveBeenCalledWith(input.bootstrapEnv,current.runId,input.bootstrapFailureDb,
      expect.objectContaining({hotSessions:90,storageInputs:plan.bootstrapInputs}));
    expect(checkpoints.get("bootstrap:complete")?.inputHash).toBe(planHash);
  });
  it("retains a completed private run when its actual input clock is unchanged",async()=>{
    ready();const current=owner("2026-09-09");
    checkpoints.set("bootstrap:owner",{inputHash:planHash,payload:current});
    runs.set(current.runId,{status:"completed",session_date:current.sessionDate,mode:"active",purpose:"daily"});
    mocks.enqueue.mockResolvedValue({id:current.runId,status:"completed"});
    mocks.correct.mockResolvedValue({id:current.runId,status:"completed"});
    expect(await runStoragePipeline(input)).toBe("awaiting-evidence");
    expect(mocks.batch).not.toHaveBeenCalled();
    expect(checkpoints.get("bootstrap:complete")?.inputHash).toBe(planHash);
  });
  it("passes a cooperative time limit to the writer and never records completion after interruption",async()=>{
    ready();mocks.batch.mockImplementation(async(_env:unknown,_run:string,_db:unknown,options:{assertContinue:()=>void})=>{
      options.assertContinue();vi.setSystemTime(Date.now()+65*60_000);options.assertContinue();return {status:"completed"};
    });
    await expect(runStoragePipeline(input)).rejects.toThrow("time-slice-complete");
    expect(checkpoints.has("bootstrap:complete")).toBe(false);
  });
  it("stops bootstrap cooperatively when the migration lease heartbeat is lost",async()=>{
    ready();mocks.heartbeat.mockRejectedValue(new Error("storage-migration-lease-lost"));
    mocks.batch.mockImplementation(async(_env:unknown,_run:string,_db:unknown,options:{assertContinue:()=>void})=>{
      await vi.advanceTimersByTimeAsync(60_000);options.assertContinue();return {status:"completed"};
    });
    await expect(runStoragePipeline(input)).rejects.toThrow("lease-lost");
    expect(checkpoints.has("bootstrap:complete")).toBe(false);expect(vi.getTimerCount()).toBe(0);
  });
});
