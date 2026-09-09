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

describe("bounded durable history requests",{timeout:30_000},() => {
  let market:ReturnType<typeof createSqliteD1>,ops:ReturnType<typeof createSqliteD1>,env:Env;
  const session="2026-09-04";
  const calendar=Array.from({length:1600},(_,index) => {
    const date=new Date(`${session}T00:00:00Z`);date.setUTCDate(date.getUTCDate()-1599+index);return date.toISOString().slice(0,10);
  });
  const input=() => ({runId:"history-test",sessionDate:session,tickers:["SPY"],calendarDates:calendar,progress:vi.fn().mockResolvedValue(undefined)});
  const bar=(ticker:string,date=session) => ({ticker,date,c:100,o:100,h:101,l:99,volume:100,reportedVolume:100,
    feed:"sip",sourceProvider:"alpaca",adjustment:"split",observedAt:`${session}T21:00:00Z`,fetchedAt:`${session}T21:00:00Z`});
  beforeEach(() => {
    vi.clearAllMocks();market=createSqliteD1();ops=createSqliteD1();
    market.migrate("market-data-migrations");ops.migrate("ops-migrations");
    env={DB:market.db,MARKET_DATA_DB:market.db,MARKET_HISTORY_DB:market.db,OPS_DB:ops.db} as Env;
    mocks.load.mockResolvedValue([]);mocks.archive.mockResolvedValue({revisionChanges:[]});mocks.repair.mockResolvedValue({bars:[],revisions:[]});
    mocks.alpaca.mockImplementation(async (tickers:string[]) => tickers.map((ticker) => bar(ticker)));
  },30_000);
  afterEach(() => {market.dispose();ops.dispose();});

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
