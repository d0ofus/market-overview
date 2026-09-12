import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import type { Env } from "../src/types";

const mocks=vi.hoisted(() => ({alpaca:vi.fn(),load:vi.fn(),archive:vi.fn(),repair:vi.fn()}));
vi.mock("../src/eod-price-provider",() => ({EodPriceProvider:class {alpaca=mocks.alpaca;symbolErrors=new Map();}}));
vi.mock("../src/market-history",() => ({loadMarketHistory:mocks.load,archiveMarketHistoryBars:mocks.archive,
  marketHistoryBarsMateriallyEqual:(a:{c:number},b:{c:number}) => a.c===b.c}));
vi.mock("../src/eod-price-repair",() => ({repairEodSecurity:mocks.repair}));
import { runEodHistoryWork } from "../src/eod-history-runner";
import * as capacity from "../src/eod-history-capacity";
import * as maintenance from "../src/eod-history-maintenance";
import * as storageCapacity from "../src/eod-storage-history-capacity";
import { loadEodDeepHistoryBudget } from "../src/eod-deep-history-admission";

describe("bounded durable history requests",{timeout:30_000},() => {
  let market:ReturnType<typeof createSqliteD1>,ops:ReturnType<typeof createSqliteD1>,history:ReturnType<typeof createSqliteD1>,env:Env;
  const session="2026-09-04";
  const calendar=Array.from({length:1600},(_,index) => {
    const date=new Date(`${session}T00:00:00Z`);date.setUTCDate(date.getUTCDate()-1599+index);return date.toISOString().slice(0,10);
  });
  const input=() => ({runId:"history-test",sessionDate:session,tickers:["SPY"],calendarDates:calendar,progress:vi.fn().mockResolvedValue(undefined)});
  const bar=(ticker:string,date=session) => ({ticker,date,c:100,o:100,h:101,l:99,volume:100,reportedVolume:100,
    feed:"sip",sourceProvider:"alpaca",adjustment:"split",observedAt:`${session}T21:00:00Z`,fetchedAt:`${session}T21:00:00Z`});
  beforeEach(() => {
    vi.clearAllMocks();market=createSqliteD1();ops=createSqliteD1();history=createSqliteD1();
    market.migrate("market-data-migrations");ops.migrate("ops-migrations");history.migrate("history-migrations");
    env={DB:market.db,MARKET_DATA_DB:market.db,MARKET_HISTORY_DB:history.db,OPS_DB:ops.db} as Env;
    vi.spyOn(storageCapacity,"refreshApprovedStorageHistoryCapacity").mockResolvedValue({sample:{proofHash:"fixture"}} as NonNullable<Awaited<ReturnType<typeof storageCapacity.refreshApprovedStorageHistoryCapacity>>>);
    vi.spyOn(storageCapacity,"loadStorageHistoryMaintenanceApproval").mockResolvedValue({proofHash:"fixture",proof:{
      tickers:["SPY","QQQ","BNRG","AAA","BBB","CCC","DDD",...Array.from({length:101},(_,index)=>`SEC${index}`)]}} as NonNullable<Awaited<ReturnType<typeof storageCapacity.loadStorageHistoryMaintenanceApproval>>>);
    mocks.load.mockResolvedValue([]);mocks.archive.mockResolvedValue({revisionChanges:[]});mocks.repair.mockResolvedValue({bars:[],revisions:[]});
    mocks.alpaca.mockImplementation(async (tickers:string[]) => tickers.map((ticker) => bar(ticker)));
  },30_000);
  afterEach(() => {vi.restoreAllMocks();market.dispose();ops.dispose();history.dispose();});

  it("defaults full-population history to520 and reports missing coverage without inferring listing age",async () => {
    const result=await runEodHistoryWork(env,input());
    expect(mocks.alpaca).toHaveBeenCalledWith(["SPY"],calendar.at(-520),session);
    expect(result.historySessions).toBe(520);
    expect(result.missing.SPY).toContain("519 expected sessions unavailable");
  });
  it("supports selected1400-session correlation history with its fetch buffer",async () => {
    const result=await runEodHistoryWork(env,{...input(),historySessions:1400});
    expect(mocks.alpaca).toHaveBeenCalledWith(["SPY"],calendar.at(-1400),session);
    expect(result.historySessions).toBe(1400);
  });
  it("keeps whole 1400-session requests and defers the second security without shortening it",async () => {
    const work={...input(),tickers:["AAA","BBB"],historySessions:1400 as const};
    const result=await runEodHistoryWork(env,work);
    expect(mocks.alpaca).toHaveBeenCalledWith(["AAA"],calendar.at(-1400),session);
    expect(mocks.alpaca.mock.calls.every(([tickers])=>!tickers.includes("BBB"))).toBe(true);
    expect(result.deepWork).toMatchObject({maxSecurities:4,maxObservations:2500,chargedObservations:1400,admittedSecurities:1,
      deferred:{BBB:"weekly-history-budget-deferred"},blocked:{}});
    expect(result.deepWork.nextAttemptAt).toMatch(/T00:00:00.000Z$/);
    await runEodHistoryWork(env,work);
    expect((await loadEodDeepHistoryBudget(ops.db)).observations).toBe(1400);
  });
  it("charges the full retained repair span rather than only the requested 520 sessions",async () => {
    await market.db.prepare("INSERT INTO eod_adjustment_repairs(feed,ticker,status,owner_token,start_date,updated_at) VALUES('sip','SPY','pending','owner',?,?)")
      .bind(calendar[0],`${session}T21:00:00Z`).run();
    mocks.load.mockResolvedValue(calendar.slice(-520).map(date=>bar("SPY",date)));
    const result=await runEodHistoryWork(env,input());
    expect(mocks.repair).toHaveBeenCalledTimes(1);
    expect(result.deepWork.chargedObservations).toBe(1600);
  });
  it("retains exact weekly deferrals when resuming after an interrupted earlier chunk",async () => {
    const tickers=Array.from({length:11},(_,index)=>`SEC${index}`),work={...input(),tickers};
    await expect(runEodHistoryWork(env,{...work,progress:async(_stage,value)=>{
      if((value as {nextTicker:number}).nextTicker===10)throw new Error("planned-interruption");
    }})).rejects.toThrow("planned-interruption");
    const saved=JSON.parse((await ops.db.prepare("SELECT payload_json FROM eod_checkpoints WHERE run_id=? AND chunk_key='history:cursor'")
      .bind(work.runId).first<string>("payload_json"))!);
    expect(saved).toMatchObject({nextTicker:10,missing:{SEC9:"weekly-history-budget-deferred"}});
    const resumed=await runEodHistoryWork(env,work);
    expect(resumed.deepWork.deferred).toEqual(Object.fromEntries(tickers.slice(4).map(ticker=>[ticker,"weekly-history-budget-deferred"])));
    expect(resumed.deepWork.nextAttemptAt).not.toBeNull();
    expect(resumed.deepWork.chargedObservations).toBe(2080);
    expect(resumed.missing.SEC0).toContain("519 expected sessions unavailable");
    expect(resumed.deepWork.deferred.SEC0).toBeUndefined();
  });
  it("does not promise next-week repair when one retained span exceeds the hard weekly maximum",async () => {
    const full=Array.from({length:2502},(_,index)=>new Date(Date.parse(`${session}T00:00:00Z`)-(2501-index)*86400_000).toISOString().slice(0,10));
    await market.db.prepare("INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source) SELECT value,'09:30','16:00','fixture' FROM json_each(?)")
      .bind(JSON.stringify(full)).run();
    await market.db.prepare("INSERT INTO eod_adjustment_repairs(feed,ticker,status,owner_token,start_date,updated_at) VALUES('sip','SPY','pending','owner',?,?)")
      .bind(full[0],`${session}T21:00:00Z`).run();
    const result=await runEodHistoryWork(env,input());
    expect(result.deepWork).toMatchObject({chargedObservations:0,nextAttemptAt:null,
      blocked:{SPY:"history-request-exceeds-weekly-capacity"}});
    expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.alpaca).not.toHaveBeenCalled();
    expect(await market.db.prepare("SELECT status,start_date FROM eod_adjustment_repairs WHERE feed='sip' AND ticker='SPY'").first())
      .toEqual({status:"pending",start_date:full[0]});
  });
  it("does no deep provider work without a current capacity approval",async () => {
    vi.mocked(storageCapacity.refreshApprovedStorageHistoryCapacity).mockResolvedValue(null);
    await expect(runEodHistoryWork(env,input())).rejects.toThrow("capacity-approval-required");
    expect(mocks.alpaca).not.toHaveBeenCalled();expect(mocks.repair).not.toHaveBeenCalled();
    expect((await loadEodDeepHistoryBudget(ops.db)).observations).toBe(0);
  });
  it("keeps a selected identity outside the approved population visibly blocked without provider work",async () => {
    const result=await runEodHistoryWork(env,{...input(),tickers:["UNMEASURED"],historySessions:1400});
    expect(result).toMatchObject({historySessions:1400,coverageStatus:"partial",missing:{UNMEASURED:"history-population-capacity-required"},
      deepWork:{chargedObservations:0,nextAttemptAt:null,blocked:{UNMEASURED:"history-population-capacity-required"}}});
    expect(mocks.alpaca).not.toHaveBeenCalled();expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.load).toHaveBeenCalledWith(env,expect.objectContaining({tickers:[]}));
  });
  it("prunes the complete population even when the weekly deep-work budget defers members",async () => {
    const tickers=Array.from({length:10},(_,index)=>`SEC${index}`);
    vi.spyOn(capacity,"refreshHistoryMaintenanceEvidence").mockResolvedValue({hotSessions:90,feeds:["sip"],capacity:{},readers:{},sample:{}} as never);
    const prune=vi.spyOn(maintenance,"archiveAndPruneMarketHistory").mockResolvedValue({status:"complete",cursor:null,archivedRows:0,deletedRows:0,concurrentCorrections:0});
    vi.spyOn(maintenance,"cleanupUnpointedHistoryBlocks").mockResolvedValue({status:"complete",cursor:null,deletedBlocks:0});
    const result=await runEodHistoryWork({...env,EOD_ARCHIVE_PRUNE_ENABLED:"true"},{...input(),tickers,reconcileHistory:true});
    expect(result.deepWork.chargedObservations).toBe(2080);
    expect(Object.keys(result.deepWork.deferred)).toHaveLength(6);
    expect(prune).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({tickers}));
  });
  it("rejects broad1400-session expansion before provider work",async () => {
    await expect(runEodHistoryWork(env,{...input(),historySessions:1400,tickers:Array.from({length:101},(_,i) => `S${i}`)}))
      .rejects.toThrow("selection-exceeds-bound");
    expect(mocks.alpaca).not.toHaveBeenCalled();
  });
  it("invalidates a completed cursor when explicit selection or depth changes",async () => {
    await runEodHistoryWork(env,input());mocks.alpaca.mockClear();
    await runEodHistoryWork(env,{...input(),tickers:["QQQ"],historySessions:1400});
    expect(mocks.alpaca).toHaveBeenCalledWith(["QQQ"],calendar.at(-1400),session);
  });
  it("invalidates a completed cursor when the official calendar grid changes",async () => {
    await runEodHistoryWork(env,input());mocks.alpaca.mockClear();
    await runEodHistoryWork(env,{...input(),calendarDates:calendar.filter((date) => date!==calendar.at(-10))});
    expect(mocks.alpaca).toHaveBeenCalled();
    expect(mocks.alpaca.mock.calls[0][1]).toBe(calendar.at(-521));
  });
  it("replays an interrupted storage batch before advancing its durable cursor",async () => {
    mocks.archive.mockRejectedValueOnce(new Error("d1-quota-exhausted"));
    await expect(runEodHistoryWork(env,input())).rejects.toThrow("d1-quota-exhausted");
    expect(await ops.db.prepare("SELECT COUNT(*) as n FROM eod_checkpoints").first()).toEqual({n:0});
    await runEodHistoryWork(env,input());
    expect(mocks.archive).toHaveBeenCalledTimes(2);
    const checkpoint=await ops.db.prepare("SELECT payload_json FROM eod_checkpoints").first<{payload_json:string}>();
    expect(JSON.parse(checkpoint!.payload_json)).toMatchObject({pricesDone:true,nextTicker:1});
  });
  it("does not fetch a complete requested window or invent deep calendar coverage",async () => {
    mocks.load.mockResolvedValue(calendar.slice(-520).map((date) => bar("SPY",date)));
    await runEodHistoryWork(env,input());
    expect(mocks.alpaca).not.toHaveBeenCalled();
    await expect(runEodHistoryWork(env,{...input(),historySessions:1400,calendarDates:calendar.slice(-520)}))
      .rejects.toThrow("deep-calendar-incomplete");
  });
  it("uses the selected90-session hot repair window while retaining520-session analytical history",async () => {
    mocks.load.mockResolvedValue(calendar.slice(-520).map((date) => bar("SPY",date)));
    await market.db.prepare("INSERT INTO eod_adjustment_repairs(feed,ticker,status,owner_token,start_date,updated_at) VALUES('sip','SPY','pending','fixture','2025-01-01','2026-09-08T00:00:00Z')").run();
    await runEodHistoryWork(env,{...input(),hotSessions:90});
    expect(mocks.repair).toHaveBeenCalledWith(env,expect.anything(),"SPY",session,calendar.at(-90));
  });
  it("isolates an incomplete repair, preserves its fence and resumes its coverage later",async () => {
    const fence={feed:"sip",ticker:"BNRG",status:"pending",owner_token:"original-owner",start_date:"2025-04-14",updated_at:"2026-09-04T21:00:00Z"};
    await market.db.prepare("INSERT INTO eod_adjustment_repairs(feed,ticker,status,owner_token,start_date,updated_at) VALUES(?,?,?,?,?,?)")
      .bind(fence.feed,fence.ticker,fence.status,fence.owner_token,fence.start_date,fence.updated_at).run();
    mocks.repair.mockRejectedValueOnce(new Error("adjustment-repair-incomplete"));
    mocks.load.mockImplementation(async (_env:Env,query:{tickers:string[]}) => {
      expect(query.tickers).not.toContain("BNRG");
      return query.tickers.flatMap(ticker => calendar.slice(-520).map(date => bar(ticker,date)));
    });
    const work={...input(),tickers:["BNRG","SPY"]};
    expect(await runEodHistoryWork(env,work)).toMatchObject({coverageStatus:"partial",missing:{BNRG:"adjustment-repair-incomplete"}});
    expect(mocks.alpaca).not.toHaveBeenCalled();
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(await market.db.prepare("SELECT * FROM eod_adjustment_repairs WHERE ticker='BNRG'").first()).toEqual(fence);
    const checkpoint=JSON.parse((await ops.db.prepare("SELECT payload_json FROM eod_checkpoints WHERE chunk_key='history:cursor'")
      .first<string>("payload_json"))!);
    expect(checkpoint).toMatchObject({pricesDone:true,nextTicker:2,missing:{BNRG:"adjustment-repair-incomplete"}});
    mocks.repair.mockImplementationOnce(async () => {
      await market.db.prepare("UPDATE eod_adjustment_repairs SET status='complete',owner_token=NULL WHERE ticker='BNRG'").run();
      return {bars:[],revisions:[]};
    });
    mocks.load.mockImplementation(async (_env:Env,query:{tickers:string[]}) => query.tickers.flatMap(ticker => calendar.slice(-520).map(date => bar(ticker,date))));
    expect(await runEodHistoryWork(env,work)).toMatchObject({coverageStatus:"complete",missing:{}});
    expect(mocks.repair).toHaveBeenCalledTimes(2);
  });
  it.each(["d1-quota-exhausted","d1-network-error","adjustment-repair-already-owned","adjustment-repair-fence-lost"])("does not quarantine %s",async error => {
    await market.db.prepare("INSERT INTO eod_adjustment_repairs(feed,ticker,status,owner_token,start_date,updated_at) VALUES('sip','SPY','pending','owner','2025-01-01','2026-09-04T21:00:00Z')").run();
    mocks.repair.mockRejectedValueOnce(new Error(error));
    await expect(runEodHistoryWork(env,input())).rejects.toThrow(error);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.alpaca).not.toHaveBeenCalled();
    expect(await ops.db.prepare("SELECT COUNT(*) as n FROM eod_checkpoints").first()).toEqual({n:0});
  });
  it("does not archive a changed adjustment basis when its full replacement is incomplete",async () => {
    mocks.load.mockResolvedValue([{...bar("SPY",calendar.at(-2)!),c:50}]);
    mocks.alpaca.mockResolvedValue([bar("SPY",calendar.at(-2)!),bar("SPY")]);
    mocks.repair.mockRejectedValueOnce(new Error("adjustment-repair-incomplete"));
    expect(await runEodHistoryWork(env,input())).toMatchObject({coverageStatus:"partial",missing:{SPY:"adjustment-repair-incomplete"}});
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });
  it("resumes the Yahoo retention cursor without repeating completed SIP pruning",async () => {
    mocks.load.mockResolvedValue(calendar.slice(-520).map((date) => bar("SPY",date)));
    const evidence=vi.spyOn(capacity,"refreshHistoryMaintenanceEvidence").mockResolvedValue({hotSessions:90,feeds:["sip","yahoo-eod"],capacity:{},readers:{},sample:{}} as never);
    const prune=vi.spyOn(maintenance,"archiveAndPruneMarketHistory")
      .mockResolvedValueOnce({status:"complete",cursor:null,archivedRows:1,deletedRows:1,concurrentCorrections:0})
      .mockResolvedValueOnce({status:"partial",cursor:{tickerIndex:0,afterDate:"2025-01-01"},archivedRows:500,deletedRows:500,concurrentCorrections:0})
      .mockRejectedValueOnce(new Error("eod-d1-budget-exhausted"));
    const cleanup=vi.spyOn(maintenance,"cleanupUnpointedHistoryBlocks").mockResolvedValue({status:"complete",cursor:null,deletedBlocks:0});
    try {
      const work={...input(),reconcileHistory:true};
      const enabled={...env,EOD_ARCHIVE_PRUNE_ENABLED:"true"};
      await expect(runEodHistoryWork(enabled,work)).rejects.toThrow("budget-exhausted");
      const saved=await ops.db.prepare("SELECT payload_json FROM eod_checkpoints WHERE chunk_key='history:cursor'").first<string>("payload_json");
      expect(JSON.parse(saved!)).toMatchObject({pricesDone:true,pruneFeed:"yahoo-eod",pruneFeedsDone:["sip"],pruneCursor:{tickerIndex:0,afterDate:"2025-01-01"}});
      prune.mockClear().mockResolvedValue({status:"complete",cursor:null,archivedRows:2,deletedRows:2,concurrentCorrections:0});
      await runEodHistoryWork(enabled,work);
      expect(prune).toHaveBeenCalledTimes(1);
      expect(prune).toHaveBeenCalledWith(enabled,expect.objectContaining({feed:"yahoo-eod",hotSessions:90,cursor:{tickerIndex:0,afterDate:"2025-01-01"}}));
    } finally {evidence.mockRestore();prune.mockRestore();cleanup.mockRestore();}
  });
  it("preserves validated older history when the target session is unavailable",async () => {
    mocks.alpaca.mockResolvedValue([bar("SPY",calendar.at(-2)!)]);
    const result=await runEodHistoryWork(env,input());
    expect(mocks.archive).toHaveBeenCalledWith(env,[expect.objectContaining({date:calendar.at(-2)})]);
    expect(result.coverageStatus).toBe("partial");
    expect(result.missing.SPY).toContain("history-target-session-unavailable");
  });
  it("measures coverage over retained and newly stored observations, not only the latest response",async () => {
    mocks.load.mockResolvedValue(calendar.slice(-520,-1).map((date) => bar("SPY",date)));
    const result=await runEodHistoryWork(env,input());
    expect(result.missing).toEqual({});
    expect(result.coverageStatus).toBe("complete");
  });
  it("resumes previously partial attempts and clears diagnostics when missing coverage recovers",async () => {
    expect((await runEodHistoryWork(env,input())).coverageStatus).toBe("partial");
    mocks.alpaca.mockClear();
    mocks.load.mockResolvedValue(calendar.slice(-520,-1).map((date) => bar("SPY",date)));
    const result=await runEodHistoryWork(env,input());
    expect(mocks.alpaca).toHaveBeenCalledWith(["SPY"],calendar.at(-520),session);
    expect(result.missing).toEqual({});
  });
  it("clears old gap diagnostics without provider work when another writer completed the window",async () => {
    await runEodHistoryWork(env,input());mocks.alpaca.mockClear();
    mocks.load.mockResolvedValue(calendar.slice(-520).map((date) => bar("SPY",date)));
    const result=await runEodHistoryWork(env,input());
    expect(mocks.alpaca).not.toHaveBeenCalled();
    expect(result.missing).toEqual({});
  });
  it.each(["unordered","duplicate","future","missing-target"] as const)("rejects a %s session grid before provider work",async (kind) => {
    const dates=[...calendar];
    if (kind==="unordered") [dates[1],dates[2]]=[dates[2]!,dates[1]!];
    if (kind==="duplicate") dates[2]=dates[1]!;
    if (kind==="future") dates.push("2026-09-05");
    if (kind==="missing-target") dates.pop();
    await expect(runEodHistoryWork(env,{...input(),calendarDates:dates})).rejects.toThrow("invalid-grid");
    expect(mocks.alpaca).not.toHaveBeenCalled();
  });
});
