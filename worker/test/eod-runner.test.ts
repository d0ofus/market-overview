import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import type { Env } from "../src/types";
import { EOD_METRICS_VERSION, computeEodTickerMetrics, type EodTickerMetrics } from "../src/eod-metrics";
import { ProviderBudgetExceededError } from "../src/provider-usage";
import { decodeEodPayload } from "../src/eod-publication-codec";
import { archiveMarketHistoryBars, loadMarketHistory } from "../src/market-history";
import { loadEodMemberships } from "../src/eod";
import * as configDb from "../src/db";
const calls=vi.hoisted(() => ({alpaca:vi.fn(),yahoo:vi.fn()}));
vi.mock("../src/market-calendar-cache",() => ({ensureMarketCalendarCoverage:vi.fn()}));
vi.mock("../src/eod",() => ({refreshBreadthUniverseMemberships:vi.fn(),loadEodMemberships:vi.fn()}));
vi.mock("../src/eod-price-provider",async (original) => ({...await original<typeof import("../src/eod-price-provider")>(),EodPriceProvider:class {alpaca=calls.alpaca;yahoo=calls.yahoo;symbolErrors=new Map();}}));
import { runEodBatch, loadEodInputs, overviewPayload } from "../src/eod-runner";
import type { FrozenInputs } from "../src/eod-runner";

describe("EOD resumable runner with real publication and lease SQL", {timeout:30_000}, () => {
  let market:ReturnType<typeof createSqliteD1>,ops:ReturnType<typeof createSqliteD1>;
  let env:Env;
  let sliceInputs:FrozenInputs|undefined,restoreSliceConfig:(()=>void)|undefined;
  const session="2026-09-04";
  const runId=`eod:active:${session}:daily`;
  const dates=Array.from({length:400},(_,index) => {
    const date=new Date(`${session}T00:00:00Z`);date.setUTCDate(date.getUTCDate()-399+index);return date.toISOString().slice(0,10);
  });
  const makeBar=(date:string,c=100) => ({ticker:"SPY",date,o:c,h:c+1,l:c-1,c,volume:100,reportedVolume:100,
    feed:"sip",sourceProvider:"alpaca",adjustment:"split",observedAt:"2026-09-04T21:00:00Z",fetchedAt:"2026-09-04T21:00:00Z"});
  beforeEach(async () => {
    vi.clearAllMocks();
    market=createSqliteD1();ops=createSqliteD1();
    market.migrate("market-data-migrations");ops.migrate("ops-migrations");
    env={DB:market.db,MARKET_DATA_DB:market.db,OPS_DB:ops.db,EOD_RUNNER_MODE:"active",ALPACA_API_KEY:"test",ALPACA_API_SECRET:"test"} as Env;
    await market.db.prepare(`INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source)
      SELECT value,'09:30','16:00','test' FROM json_each(?)`).bind(JSON.stringify(dates)).run();
    await market.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume,reported_volume)
      SELECT 'sip','SPY',value,100,101,99,100,100,100 FROM json_each(?)`).bind(JSON.stringify(dates.slice(-260))).run();
    const frozen={methodologyVersion:EOD_METRICS_VERSION,calendarDates:dates,tickers:["SPY",...Array.from({length:25},(_,i) => `MISSING${i}`)],
      config:{id:"default",sections:[{id:"s",title:"Market",groups:[{id:"g",title:"Market",dataType:"price",rankingWindowDefault:"1D",showSparkline:true,pinTop10:false,columns:[],items:[{ticker:"SPY",enabled:true,displayName:"S&P ETF",holdings:[]}]}]}]},
      memberships:["sp500-core","nasdaq-core","nyse-core","russell2000-core","overall-market-proxy"].map((universeId) => ({universeId,versionId:universeId,source:"verified proxy",sourceType:universeId==="sp500-core" ? "wikipedia-derived-public-proxy" : universeId==="russell2000-core" ? "official-etf-holdings-proxy" : "public-common-stock-proxy",sourceUrl:"https://example.test",sourceAsOfDate:session,verifiedAt:`${session}T20:00:00Z`,members:["SPY"]}))};
    await ops.db.prepare(`INSERT INTO eod_runs(id,session_date,purpose,mode,status,stage,input_json,created_at,updated_at)
      VALUES(?,?,'daily','active','queued','queued',?,?,?)`).bind(runId,session,JSON.stringify(frozen),`${session}T20:20:00Z`,`${session}T20:20:00Z`).run();
    calls.alpaca.mockImplementation(async (tickers:string[],start:string,_target:string,adjustment="split") => tickers.includes("SPY")
      ? dates.filter((date) => date>=start).map((date) => ({...makeBar(date),adjustment})) : []);
    calls.yahoo.mockRejectedValue(new Error("yahoo-unavailable"));
  },30_000);
  afterEach(() => {
    if(restoreSliceConfig) {restoreSliceConfig();vi.mocked(loadEodMemberships).mockReset();}
    sliceInputs=undefined;restoreSliceConfig=undefined;market.dispose();ops.dispose();
  });

  it("publishes independent pages before a later catalog chunk is interrupted and resumes idempotently",async () => {
    const normal=calls.alpaca.getMockImplementation()!;
    calls.alpaca.mockImplementation(async (...args:unknown[]) => {
      if ((args[0] as string[]).includes("MISSING24")) throw new Error("d1-capacity-test");
      return normal(...args);
    });
    await expect(runEodBatch(env,runId)).rejects.toThrow("d1-capacity-test");
    expect(await market.db.prepare("SELECT COUNT(*) as n FROM eod_publication_pointers").first()).toEqual({n:6});
    expect(await ops.db.prepare("SELECT status,lease_token FROM eod_runs WHERE id=?").bind(runId).first()).toMatchObject({status:"retrying",lease_token:null});
    expect(await ops.db.prepare("SELECT next_attempt_at FROM eod_runs WHERE id=?").bind(runId).first<string>("next_attempt_at"))
      .toBe(new Date(new Date().setUTCHours(24,5,0,0)).toISOString());
    calls.alpaca.mockImplementation(normal);
    expect((await runEodBatch(env,runId)).status).toBe("completed");
    expect(await market.db.prepare("SELECT COUNT(*) as n FROM eod_publications").first()).toEqual({n:7});
    const catalog=await market.db.prepare("SELECT payload_json,payload_codec FROM eod_publications WHERE scope='history:catalog'").first<{payload_json:string;payload_codec:string}>();
    expect(catalog?.payload_codec).toBe("json");
    expect(JSON.parse(catalog!.payload_json).rows).toHaveLength(26);
    expect(JSON.parse(catalog!.payload_json).rows.find((row:unknown[]) => row[0]==="SPY")[1]).toBe(260);
    const completed=await ops.db.prepare("SELECT completed_input_clock,progress_json FROM eod_runs WHERE id=?").bind(runId).first<{completed_input_clock:number;progress_json:string}>();
    expect(completed?.completed_input_clock).toBeGreaterThan(0);
    expect(JSON.parse(completed!.progress_json).catalogPublicationId).toBeTruthy();
  });

  it("does no provider work when another healthy lease owns the run",async () => {
    await ops.db.prepare("UPDATE eod_runs SET lease_until=? WHERE id=?").bind(new Date(Date.now()+600_000).toISOString(),runId).run();
    expect((await runEodBatch(env,runId)).status).toBe("not-claimed");
    expect(calls.alpaca).not.toHaveBeenCalled();
    expect(calls.yahoo).not.toHaveBeenCalled();
  });

  async function interruptShortHistorySlice(missingCurrent?:"price"|"adjacent",missingSymbol="MISSING0",historicalEnd?:string) {
    const frozen=JSON.parse((await ops.db.prepare("SELECT input_json FROM eod_runs WHERE id=?")
      .bind(runId).first<string>("input_json"))!) as FrozenInputs;
    if(missingSymbol!=="MISSING0") {
      frozen.tickers=frozen.tickers.map(ticker=>ticker==="MISSING0" ? missingSymbol : ticker);
      const group=frozen.config.sections[0].groups[0];
      group.items.push({...group.items[0],ticker:missingSymbol,displayName:missingSymbol});
    }
    frozen.memberships.find(row=>row.universeId==="nasdaq-core")!.members=[...frozen.tickers];
    frozen.memberships.find(row=>row.universeId==="russell2000-core")!.members=["MISSING24"];
    await market.db.prepare("CREATE TABLE symbols(ticker TEXT PRIMARY KEY,is_active INTEGER,catalog_managed INTEGER,asset_class TEXT)").run();
    await market.db.prepare("INSERT INTO symbols SELECT value,1,1,'equity' FROM json_each(?)").bind(JSON.stringify(frozen.tickers)).run();
    const config=vi.spyOn(configDb,"loadConfig").mockResolvedValue(frozen.config);
    restoreSliceConfig=()=>config.mockRestore();
    vi.mocked(loadEodMemberships).mockResolvedValue(structuredClone(frozen.memberships));
    sliceInputs=await loadEodInputs(env,session);
    expect(sliceInputs.tickers).toEqual(frozen.tickers);
    await ops.db.prepare("UPDATE eod_runs SET input_json=? WHERE id=?").bind(JSON.stringify(sliceInputs),runId).run();
    const prices=async(tickers:string[],start:string,_target:string,adjustment="split")=>tickers.flatMap(ticker=>{
      if(ticker==="MISSING24")return [];
      return dates.filter(date=>date>=start && (ticker==="SPY" || date>=dates.at(ticker===missingSymbol && historicalEnd ? -260 : -30)!)
        && !(ticker===missingSymbol && historicalEnd && date>historicalEnd)
        && !(ticker===missingSymbol && ((missingCurrent==="price" && date===session)
          || (missingCurrent==="adjacent" && date===dates.at(-2)))))
        .map(date=>({...makeBar(date),ticker,adjustment}));
    });
    let stopped=false;
    calls.alpaca.mockImplementation(async(...args:Parameters<typeof prices>)=>{
      if(args[0].includes("MISSING24"))stopped=true;
      return prices(...args);
    });
    await expect(runEodBatch(env,runId,ops.db,{storageInputs:sliceInputs,assertContinue:()=>{
      if(stopped)throw new Error("storage-run-time-slice-complete");
    }})).rejects.toThrow("storage-run-time-slice-complete");
    expect(await ops.db.prepare("SELECT error_code,error_message FROM eod_runs WHERE id=?").bind(runId).first())
      .toEqual({error_code:"runner-error",error_message:"storage-run-time-slice-complete"});
    expect(Date.parse((await ops.db.prepare("SELECT next_attempt_at FROM eod_runs WHERE id=?")
      .bind(runId).first<string>("next_attempt_at"))!)).toBeLessThanOrEqual(Date.now());
    expect(await ops.db.prepare("SELECT chunk_key FROM eod_checkpoints WHERE run_id=? AND chunk_key='features:0'")
      .bind(runId).first()).toEqual({chunk_key:"features:0"});
    calls.alpaca.mockClear();calls.yahoo.mockClear();calls.alpaca.mockImplementation(prices);
  }

  it("resumes a planned slice past short-history chunks while ordinary recovery still refetches them",async()=>{
    await interruptShortHistorySlice();
    expect((await runEodBatch(env,runId,ops.db,{storageInputs:sliceInputs})).status).toBe("retrying");
    expect(calls.alpaca.mock.calls.every(([tickers])=>tickers.length===1 && tickers[0]==="MISSING24")).toBe(true);
    const stored=await ops.db.prepare("SELECT payload_json FROM eod_checkpoints WHERE run_id=? AND chunk_key='features:0'")
      .bind(runId).first<string>("payload_json");
    const metadata=JSON.parse(stored!);
    const cached=await decodeEodPayload({...metadata,payload:"{}"}) as {features:Array<[string,{above200Sma:boolean|null}]>};
    expect(cached.features.find(([ticker])=>ticker==="MISSING0")?.[1].above200Sma).toBeNull();
    expect(await ops.db.prepare("SELECT error_code FROM eod_runs WHERE id=?").bind(runId).first())
      .toEqual({error_code:"incomplete-publication"});
    calls.alpaca.mockClear();
    calls.alpaca.mockImplementation(async(tickers:string[],start:string,_target:string,adjustment="split")=>tickers.flatMap(ticker=>
      dates.filter(date=>date>=start).map(date=>({...makeBar(date),ticker,adjustment}))));
    expect((await runEodBatch(env,runId,ops.db,{storageInputs:sliceInputs})).status).toBe("completed");
    expect(calls.alpaca.mock.calls.some(([tickers])=>tickers.includes("MISSING0"))).toBe(true);
    expect(calls.alpaca.mock.calls.some(([tickers])=>tickers.includes("MISSING24"))).toBe(true);
  },60_000);

  it.each(["revision","calendar"] as const)("invalidates planned slice checkpoints after a %s change",async change=>{
    await interruptShortHistorySlice();
    if(change==="revision") await market.db.prepare("UPDATE alpaca_daily_bars SET reported_volume=777 WHERE feed='sip' AND ticker='SPY' AND date=?")
      .bind(session).run();
    else {
      const earlier=new Date(`${dates[0]}T00:00:00Z`);earlier.setUTCDate(earlier.getUTCDate()-1);
      await market.db.prepare("INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source) VALUES(?,'09:30','16:00','test')")
        .bind(earlier.toISOString().slice(0,10)).run();
    }
    if(change==="calendar") {
      await expect(runEodBatch(env,runId,ops.db,{storageInputs:sliceInputs})).rejects.toThrow("storage-bootstrap-input-plan-changed");
      expect(calls.alpaca).not.toHaveBeenCalled();
    } else {
      expect((await runEodBatch(env,runId,ops.db,{storageInputs:sliceInputs})).status).toBe("retrying");
      expect(calls.alpaca.mock.calls.some(([tickers])=>tickers.includes("SPY"))).toBe(true);
    }
  },60_000);

  it.each(["price","adjacent"] as const)("retries a missing current %s during planned slice continuation",async missing=>{
    await interruptShortHistorySlice(missing);
    expect((await runEodBatch(env,runId,ops.db,{storageInputs:sliceInputs})).status).toBe("retrying");
    expect(calls.alpaca.mock.calls.some(([tickers])=>tickers.includes("MISSING0"))).toBe(true);
  },60_000);

  it("refetches the retained null VIX checkpoint and publishes a corrected Overview revision",async()=>{
    await interruptShortHistorySlice("price","VIX");
    const before=(await market.db.prepare("SELECT * FROM eod_publications WHERE scope='overview:default' AND status='accepted' ORDER BY revision").all()).results;
    expect(before).toHaveLength(1);
    const old=before[0] as unknown as {payload_json:string;payload_codec:string;payload_base64:string|null};
    const oldPayload=await decodeEodPayload({payload:old.payload_json,payloadCodec:old.payload_codec,payloadBase64:old.payload_base64}) as {sections:Array<{groups:Array<{rows:Array<{ticker:string;price:number|null}>}>}>};
    expect(oldPayload.sections[0].groups[0].rows.find(row=>row.ticker==="VIX")?.price).toBeNull();
    calls.yahoo.mockImplementation(async(ticker:string)=>{
      if(ticker!=="VIX")throw new Error("yahoo-unavailable");
      return dates.slice(-260).map((date,index)=>({...makeBar(date,20+index/100),ticker:"VIX",feed:"yahoo-eod",sourceProvider:"yahoo",reportedVolume:null}));
    });
    expect((await runEodBatch(env,runId,ops.db,{storageInputs:sliceInputs})).status).toBe("retrying");
    expect(calls.alpaca.mock.calls.some(([tickers])=>tickers.includes("VIX"))).toBe(true);
    expect(calls.yahoo.mock.calls.some(([ticker])=>ticker==="VIX")).toBe(true);
    const after=(await market.db.prepare("SELECT * FROM eod_publications WHERE scope='overview:default' AND status='accepted' ORDER BY revision").all()).results;
    expect(after).toHaveLength(2);expect(after[0]).toEqual(before[0]);
    const current=after[1] as unknown as typeof old;
    const payload=await decodeEodPayload({payload:current.payload_json,payloadCodec:current.payload_codec,payloadBase64:current.payload_base64}) as typeof oldPayload;
    expect(payload.sections[0].groups[0].rows.find(row=>row.ticker==="VIX")?.price).toBe(22.59);
    expect(await market.db.prepare("SELECT publication_id FROM eod_publication_pointers WHERE scope='overview:default'").first<string>("publication_id")).toBe(after[1].id);
  },60_000);

  it.each(["alpaca","yahoo"] as const)("refetches logical RSHO after its dated rename using coherent %s history and preserves the earlier Overview",async provider=>{
    await interruptShortHistorySlice("price","RSHO","2026-06-18");
    const history=createSqliteD1();
    try {
      history.migrate("history-migrations");env={...env,MARKET_HISTORY_DB:history.db};
      const before=(await market.db.prepare("SELECT * FROM eod_publications WHERE scope='overview:default' AND status='accepted' ORDER BY revision").all()).results;
      expect(before).toHaveLength(1);
      const oldCheckpoint=JSON.parse((await ops.db.prepare("SELECT payload_json FROM eod_checkpoints WHERE run_id=? AND chunk_key='features:0'")
        .bind(runId).first<string>("payload_json"))!);
      const oldFeatures=await decodeEodPayload({...oldCheckpoint,payload:"{}"}) as {features:Array<[string,EodTickerMetrics]>};
      expect(oldFeatures.features.find(([ticker])=>ticker==="RSHO")?.[1].price).toBeNull();
      const primary=calls.alpaca.getMockImplementation()!;
      if(provider==="alpaca")calls.alpaca.mockImplementation(async(tickers:string[],start:string,target:string,adjustment="split")=>[
        ...(await primary(tickers.filter(ticker=>ticker!=="RSHO"),start,target,adjustment)),
        ...(tickers.includes("RSHO") ? dates.filter(date=>date>=start).map(date=>({...makeBar(date,date===session?101:100),ticker:"RSHO",adjustment})) : []),
      ]);
      else calls.yahoo.mockImplementation(async(ticker:string)=>{
        if(ticker!=="RSHO")throw new Error("yahoo-unavailable");
        return dates.slice(-260).map(date=>({...makeBar(date,date===session?101:100),ticker:"RSHO",feed:"yahoo-eod",sourceProvider:"yahoo",reportedVolume:null}));
      });
      expect((await runEodBatch(env,runId,ops.db,{storageInputs:sliceInputs})).status).toBe("retrying");
      expect(calls.alpaca.mock.calls.some(([tickers])=>tickers.includes("RSHO"))).toBe(true);
      expect(calls.yahoo.mock.calls.some(([ticker])=>ticker==="RSHO")).toBe(provider==="yahoo");
      const checkpoint=JSON.parse((await ops.db.prepare("SELECT payload_json FROM eod_checkpoints WHERE run_id=? AND chunk_key='features:0'")
        .bind(runId).first<string>("payload_json"))!);
      const features=await decodeEodPayload({...checkpoint,payload:"{}"}) as {features:Array<[string,EodTickerMetrics]>};
      const rsho=features.features.find(([ticker])=>ticker==="RSHO")![1];
      expect(rsho).toMatchObject({price:101,sourceProvider:provider,sourceSessions:260});
      expect(rsho.change1d).toBeCloseTo(1);expect(rsho.sma200).toBeCloseTo(100.005);
      const retained=await loadMarketHistory(env,{tickers:["RSHO"],feed:provider==="alpaca"?"sip":"yahoo-eod"});
      expect(retained.map(row=>row.date)).toEqual(dates.slice(-260));
      expect(retained.every(row=>row.ticker==="RSHO" && row.sourceProvider===provider)).toBe(true);
      expect(retained.at(-1)?.c).toBe(101);
      expect(await market.db.prepare("SELECT COUNT(*) AS count FROM alpaca_daily_bars WHERE ticker='WELD'").first()).toEqual({count:0});
      const after=(await market.db.prepare("SELECT * FROM eod_publications WHERE scope='overview:default' AND status='accepted' ORDER BY revision").all()).results;
      expect(after).toHaveLength(2);expect(after[0]).toEqual(before[0]);
      const current=after[1] as unknown as {payload_json:string;payload_codec:string;payload_base64:string|null};
      const payload=await decodeEodPayload({payload:current.payload_json,payloadCodec:current.payload_codec,payloadBase64:current.payload_base64}) as {
        sections:Array<{groups:Array<{rows:Array<{ticker:string;price:number|null;quoteSource:string|null;displayName?:string}>}>}>};
      expect(payload.sections[0].groups[0].rows.find(row=>row.ticker==="RSHO")).toMatchObject({price:101,
        quoteSource:provider==="alpaca"?"alpaca:sip:split":"yahoo:daily:split",
        displayName:"WELD (formerly RSHO) - Tema U.S. Manufacturing & Reshoring ETF"});
      expect(await market.db.prepare("SELECT publication_id FROM eod_publication_pointers WHERE scope='overview:default'").first<string>("publication_id"))
        .toBe(after[1].id);
      expect(sliceInputs!.tickers).toContain("RSHO");expect(sliceInputs!.tickers).not.toContain("WELD");
    } finally {history.dispose();}
  },90_000);

  it.each([
    {target:"2026-06-18",available:true}, {target:"2026-06-18",available:false},
    {target:"2026-06-22",available:true}, {target:"2026-06-22",available:false},
  ])("dates the RSHO/WELD label accurately for $target with current availability $available",async({target,available})=>{
    const frozen=JSON.parse((await ops.db.prepare("SELECT input_json FROM eod_runs WHERE id=?").bind(runId).first<string>("input_json"))!) as FrozenInputs;
    frozen.tickers=["SPY","RSHO"];frozen.calendarDates=["2026-06-17","2026-06-18","2026-06-22"].filter(date=>date<=target);
    const group=frozen.config.sections[0].groups[0];group.items.push({...group.items[0],ticker:"RSHO",displayName:"RSHO - Tema American Reshoring ETF"});
    const features=new Map(frozen.tickers.map(ticker=>[ticker,computeEodTickerMetrics({ticker,targetSession:target,calendarDates:frozen.calendarDates,
      bars:ticker==="RSHO" && !available ? [] : frozen.calendarDates.map(sessionDate=>({ticker,sessionDate,close:100,high:101,low:99,open:100,
        reportedVolume:100,sourceProvider:"alpaca" as const,priceBasis:"split" as const,sourceFeed:"sip"}))})]));
    const row=overviewPayload(frozen,features,target).sections[0].groups[0].rows.find(row=>row.ticker==="RSHO")!;
    expect(row.ticker).toBe("RSHO");expect(frozen.config.sections[0].groups[0].items.at(-1)?.ticker).toBe("RSHO");
    expect(row.displayName).toBe(target<"2026-06-22" ? "RSHO - Tema American Reshoring ETF" : "WELD (formerly RSHO) - Tema U.S. Manufacturing & Reshoring ETF");
    if(target==="2026-06-22") {
      expect(row.barFreshnessReason).toContain("trades as WELD from 2026-06-22");
      expect(row.barFreshnessReason).toContain("https://temaetfs.com/rsho-landing-page");
    } else expect(row.barFreshnessReason).not.toContain("WELD");
    expect(row.price).toBe(available?100:null);expect(row.barDate).toBe(available?target:null);
    expect(row.currentData?.status).toBe(available?"fresh":"unavailable");
    if(!available) {
      expect(row.quoteSource).toBeNull();expect(row.barFreshnessReason).toContain("No verified EOD price");
      expect(row.barFreshnessReason).not.toContain("EOD close from");
    }
  });

  async function prepareIndexCalendar(ticker="VIX") {
    const target="2026-09-10",holidays=new Set([
      "2025-01-01","2025-01-09","2025-01-20","2025-02-17","2025-04-18","2025-05-26",
      "2025-06-19","2025-07-04","2025-09-01","2025-11-27","2025-12-25",
      "2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25","2026-06-19","2026-07-03","2026-09-07",
    ]),calendar:string[]=[];
    for(const day=new Date(`${target}T00:00:00Z`);calendar.length<400;day.setUTCDate(day.getUTCDate()-1)) {
      const date=day.toISOString().slice(0,10);
      if(day.getUTCDay()!==0 && day.getUTCDay()!==6 && !holidays.has(date))calendar.unshift(date);
    }
    const frozen=JSON.parse((await ops.db.prepare("SELECT input_json FROM eod_runs WHERE id=?")
      .bind(runId).first<string>("input_json"))!) as FrozenInputs;
    frozen.calendarDates=calendar;frozen.tickers=["SPY",ticker];
    const group=frozen.config.sections[0].groups[0];
    group.items.push({...group.items[0],ticker,displayName:ticker});
    frozen.memberships=frozen.memberships.map(row=>({...row,sourceAsOfDate:target,verifiedAt:`${target}T20:00:00Z`,members:["SPY",ticker]}));
    await market.db.batch([
      market.db.prepare("DELETE FROM market_calendar_sessions"),
      market.db.prepare("INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source) SELECT value,'09:30','16:00','test' FROM json_each(?)").bind(JSON.stringify(calendar)),
      market.db.prepare("DELETE FROM alpaca_daily_bars"),
      market.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume,reported_volume)
        SELECT 'sip','SPY',value,100,101,99,100,100,100 FROM json_each(?)`).bind(JSON.stringify(calendar.slice(-260))),
    ]);
    await ops.db.prepare("UPDATE eod_runs SET session_date=?,input_json=? WHERE id=?").bind(target,JSON.stringify(frozen),runId).run();
    calls.alpaca.mockImplementation(async(tickers:string[],start:string,_target:string,adjustment="split")=>
      tickers.includes("SPY") ? calendar.filter(date=>date>=start).map(date=>({...makeBar(date),adjustment})) : []);
    const yahooBars=calendar.slice(-260).map((date,index)=>({...makeBar(date,20+index/100),ticker,
      feed:"yahoo-eod",sourceProvider:"yahoo",reportedVolume:null}));
    const extras=["2026-05-25","2026-09-07"].map(date=>({...makeBar(date,999),ticker,
      feed:"yahoo-eod",sourceProvider:"yahoo",reportedVolume:null}));
    const checkpoint=async()=>{
      const stored=JSON.parse((await ops.db.prepare("SELECT payload_json FROM eod_checkpoints WHERE run_id=? AND chunk_key='features:0'")
        .bind(runId).first<string>("payload_json"))!);
      return await decodeEodPayload({...stored,payload:"{}"}) as {features:Array<[string,EodTickerMetrics]>;errors:Record<string,string>};
    };
    return {target,calendar,yahooBars,extras,checkpoint};
  }

  it("quarantines VIX holiday observations before archiving and corrects the same-session Overview without rewriting its previous revision",async()=>{
    const history=createSqliteD1();
    try {
      history.migrate("history-migrations");env={...env,MARKET_HISTORY_DB:history.db};
      const f=await prepareIndexCalendar();
      expect((await runEodBatch(env,runId)).status).toBe("retrying");
      const before=(await market.db.prepare("SELECT * FROM eod_publications WHERE scope='overview:default' AND status='accepted' ORDER BY revision").all()).results;
      expect(before).toHaveLength(1);
      expect((await f.checkpoint()).features.find(([ticker])=>ticker==="VIX")?.[1].price).toBeNull();
      calls.yahoo.mockResolvedValue([...f.yahooBars,...f.extras].sort((a,b)=>a.date.localeCompare(b.date)));
      expect((await runEodBatch(env,runId)).status).toBe("completed");
      const retained=await loadMarketHistory(env,{tickers:["VIX"],feed:"yahoo-eod"});
      expect(retained.map(row=>row.date)).toEqual(f.calendar.slice(-260));
      expect(retained).toHaveLength(260);expect(retained.every(row=>row.c<100 && row.reportedVolume===null)).toBe(true);
      expect(await market.db.prepare("SELECT COUNT(*) AS count FROM alpaca_daily_bars WHERE ticker='VIX'").first()).toEqual({count:0});
      const checkpoint=await f.checkpoint(),vix=checkpoint.features.find(([ticker])=>ticker==="VIX")![1];
      expect(vix.price).toBe(22.59);expect(vix.change1d).toBeCloseTo((22.59/22.58-1)*100);
      expect(vix.sma200).toBeCloseTo(21.595);expect(vix.pctFrom52wHigh).toBeCloseTo((22.59/23.59-1)*100);
      const yearAnchor=f.yahooBars.filter(row=>row.date<"2026-01-01").at(-1)!;
      expect(vix.ytd).toBeCloseTo((22.59/yearAnchor.c-1)*100);
      expect(vix.sourceSessions).toBe(260);expect(vix.sourceProvider).toBe("yahoo");
      expect(checkpoint.errors.VIX).toBe("yahoo-vix-off-calendar-quarantined:count=2;dates=2026-05-25,2026-09-07");
      const progress=JSON.parse((await ops.db.prepare("SELECT progress_json FROM eod_runs WHERE id=?").bind(runId).first<string>("progress_json"))!);
      expect(progress.errors.VIX).toBe(checkpoint.errors.VIX);
      const after=(await market.db.prepare("SELECT * FROM eod_publications WHERE scope='overview:default' AND status='accepted' ORDER BY revision").all()).results;
      expect(after).toHaveLength(2);expect(after[0]).toEqual(before[0]);
      const current=after[1] as unknown as {payload_json:string;payload_codec:string;payload_base64:string|null};
      const payload=await decodeEodPayload({payload:current.payload_json,payloadCodec:current.payload_codec,payloadBase64:current.payload_base64}) as {
        sections:Array<{groups:Array<{rows:Array<{ticker:string;price:number|null;change1d:number|null;unavailableReason:string|null}>}>}>};
      const currentRow=payload.sections[0].groups[0].rows.find(row=>row.ticker==="VIX")!;
      expect(currentRow).toMatchObject({price:22.59,change1d:vix.change1d});
      expect(currentRow.unavailableReason ?? null).toBeNull();
      expect(await market.db.prepare("SELECT publication_id FROM eod_publication_pointers WHERE scope='overview:default'").first<string>("publication_id"))
        .toBe(after[1].id);
    } finally {history.dispose();}
  },90_000);

  it.each(["target","adjacent","63-session","other-index"] as const)("does not manufacture an index metric when the Yahoo window has a missing %s",async missing=>{
    const history=createSqliteD1();
    try {
      history.migrate("history-migrations");env={...env,MARKET_HISTORY_DB:history.db};
      const ticker=missing==="other-index" ? "XAU" : "VIX",f=await prepareIndexCalendar(ticker);
      const omitted=missing==="target" ? f.target : missing==="adjacent" ? f.calendar.at(-2) : missing==="63-session" ? f.calendar.at(-64) : null;
      calls.yahoo.mockResolvedValue([...f.yahooBars.filter(row=>row.date!==omitted),...f.extras].sort((a,b)=>a.date.localeCompare(b.date)));
      await runEodBatch(env,runId);
      const checkpoint=await f.checkpoint(),metric=checkpoint.features.find(([symbol])=>symbol===ticker)![1];
      const retained=await loadMarketHistory(env,{tickers:[ticker],feed:"yahoo-eod"});
      if(missing==="other-index") {
        expect(retained).toEqual([]);expect(metric.price).toBeNull();expect(metric.change1d).toBeNull();
        expect(checkpoint.errors.XAU).toBe("yahoo-unexpected-exchange-session");
      } else {
        expect(retained.map(row=>row.date)).toEqual(f.calendar.slice(-260).filter(date=>date!==omitted));
        expect(checkpoint.errors.VIX).toBe("yahoo-vix-off-calendar-quarantined:count=2;dates=2026-05-25,2026-09-07");
        if(missing==="target")expect(metric.price).toBeNull();else expect(metric.price).toBe(22.59);
        if(missing==="target" || missing==="adjacent")expect(metric.change1d).toBeNull();
        if(missing==="63-session")expect(metric.change3m).toBeNull();
      }
    } finally {history.dispose();}
  },60_000);

  it("requires approved storage inputs for planned slice checkpoint reuse",async()=>{
    await interruptShortHistorySlice();
    expect((await runEodBatch(env,runId)).status).toBe("retrying");
    expect(calls.alpaca.mock.calls.some(([tickers])=>tickers.includes("MISSING0"))).toBe(true);
  },60_000);

  it.each([
    { missingOffset: 1, expectedOffset: 5, label: "new target close" },
    { missingOffset: 3, expectedOffset: 5, label: "gap inside the overlap" },
    { missingOffset: 63, expectedOffset: 63, label: "older missing anchor" },
    { missingOffset: null, expectedOffset: 5, label: "complete current window" },
  ])("preserves five-session reconciliation for $label",async ({missingOffset,expectedOffset})=>{
    const frozen=JSON.parse((await ops.db.prepare("SELECT input_json FROM eod_runs WHERE id=?")
      .bind(runId).first<string>("input_json"))!) as FrozenInputs;
    frozen.tickers=["SPY"];
    await ops.db.prepare("UPDATE eod_runs SET input_json=? WHERE id=?").bind(JSON.stringify(frozen),runId).run();
    if(missingOffset!==null) await market.db.prepare("DELETE FROM alpaca_daily_bars WHERE feed='sip' AND ticker='SPY' AND date=?")
      .bind(dates.at(-missingOffset)).run();
    expect((await runEodBatch(env,runId)).status).toBe("completed");
    expect(calls.alpaca.mock.calls).toEqual([
      [["SPY"],dates.at(-expectedOffset),session],
      [["SPY"],dates.at(-5),session,"raw"],
    ]);
    expect(calls.yahoo).not.toHaveBeenCalled();
    expect(await market.db.prepare("SELECT COUNT(*) AS count FROM alpaca_daily_bars WHERE feed='sip' AND ticker='SPY'").first())
      .toEqual({count:260});
  });

  it("reads archived history but keeps the healthy five-session overlap entirely in the 90-session hot store",async()=>{
    const history=createSqliteD1();
    try {
      history.migrate("history-migrations");
      const archivedEnv={...env,MARKET_HISTORY_DB:history.db};
      const frozen=JSON.parse((await ops.db.prepare("SELECT input_json FROM eod_runs WHERE id=?")
        .bind(runId).first<string>("input_json"))!) as FrozenInputs;
      frozen.tickers=["SPY"];
      await ops.db.prepare("UPDATE eod_runs SET input_json=? WHERE id=?").bind(JSON.stringify(frozen),runId).run();
      await archiveMarketHistoryBars(archivedEnv,dates.slice(-260,-90).map(date=>makeBar(date)));
      await market.db.prepare("DELETE FROM alpaca_daily_bars WHERE date<? OR date=?").bind(dates.at(-90),session).run();
      const before=await history.db.prepare("SELECT * FROM market_history_blocks ORDER BY id").all();
      expect((await runEodBatch(archivedEnv,runId,ops.db,{hotSessions:90})).status).toBe("completed");
      expect(calls.alpaca.mock.calls).toEqual([
        [["SPY"],dates.at(-5),session],[["SPY"],dates.at(-5),session,"raw"],
      ]);
      expect((await history.db.prepare("SELECT * FROM market_history_blocks ORDER BY id").all()).results).toEqual(before.results);
      expect(await market.db.prepare("SELECT COUNT(*) AS count FROM alpaca_daily_bars WHERE feed='sip' AND ticker='SPY'").first())
        .toEqual({count:90});
      expect(await loadMarketHistory(archivedEnv,{tickers:["SPY"],feed:"sip"})).toHaveLength(260);
    } finally {history.dispose();}
  });

  it("keeps older raw volume and its collection time while leaving unknown older volume null",async()=>{
    const knownDate=dates.at(-100)!,unknownDate=dates.at(-200)!;
    const collectedAt="2026-05-01T21:00:00Z";
    await market.db.prepare("UPDATE alpaca_daily_bars SET reported_volume=321,reported_volume_collected_at=? WHERE date=?")
      .bind(collectedAt,knownDate).run();
    await market.db.prepare("UPDATE alpaca_daily_bars SET reported_volume=NULL,reported_volume_collected_at=NULL WHERE date=?")
      .bind(unknownDate).run();
    expect((await runEodBatch(env,runId)).status).toBe("completed");
    expect(calls.alpaca.mock.calls.filter(args=>args[3]==="raw").every(args=>args[1]===dates.at(-5))).toBe(true);
    expect(calls.alpaca.mock.calls.some(args=>args[3]!=="raw" && args[1]===dates.at(-260))).toBe(true);
    expect(await market.db.prepare("SELECT reported_volume,reported_volume_collected_at FROM alpaca_daily_bars WHERE date=?")
      .bind(knownDate).first()).toEqual({reported_volume:321,reported_volume_collected_at:collectedAt});
    expect(await market.db.prepare("SELECT reported_volume,reported_volume_collected_at FROM alpaca_daily_bars WHERE date=?")
      .bind(unknownDate).first()).toEqual({reported_volume:null,reported_volume_collected_at:null});
  });

  it("does not reload or rewrite unchanged archive years when a sibling keeps the price request at 260 sessions",async()=>{
    const history=createSqliteD1();
    try {
      history.migrate("history-migrations");
      const archivedEnv={...env,MARKET_HISTORY_DB:history.db};
      await archiveMarketHistoryBars(archivedEnv,dates.slice(-260).map(date=>makeBar(date)));
      await market.db.prepare("DELETE FROM alpaca_daily_bars WHERE date<?").bind(dates.at(-90)).run();
      const blocksBefore=(await history.db.prepare("SELECT * FROM market_history_blocks ORDER BY id").all()).results;
      const pointersBefore=(await history.db.prepare("SELECT * FROM market_history_block_pointers ORDER BY calendar_year").all()).results;
      const revisionBefore=await market.db.prepare("SELECT revision FROM eod_input_revisions WHERE feed='sip' AND ticker='SPY'").first();
      const prepare=vi.spyOn(history.db,"prepare");
      expect((await runEodBatch(archivedEnv,runId,ops.db,{hotSessions:90})).status).toBe("completed");
      // Two price chunks, each with exactly one SIP and one Yahoo range read.
      // No additional per-security/year archive read or mutation is needed.
      const during=prepare.mock.calls.map(([sql])=>sql);
      expect(during.filter(sql=>sql.includes("FROM market_history_block_pointers p"))).toHaveLength(4);
      expect(during.some(sql=>/^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toBe(false);
      prepare.mockRestore();
      expect((await history.db.prepare("SELECT * FROM market_history_blocks ORDER BY id").all()).results).toEqual(blocksBefore);
      expect((await history.db.prepare("SELECT * FROM market_history_block_pointers ORDER BY calendar_year").all()).results).toEqual(pointersBefore);
      expect(await market.db.prepare("SELECT revision FROM eod_input_revisions WHERE feed='sip' AND ticker='SPY'").first()).toEqual(revisionBefore);
    } finally {history.dispose();}
  });

  it("still repairs a changed adjustment basis across the full retained price and raw-volume window",async()=>{
    calls.alpaca.mockImplementation(async(tickers:string[],start:string,_target:string,adjustment="split")=>tickers.includes("SPY")
      ? dates.filter(date=>date>=start).map(date=>({...makeBar(date,50),adjustment,reportedVolume:200})) : []);
    expect((await runEodBatch(env,runId)).status).toBe("completed");
    const rawCalls=calls.alpaca.mock.calls.filter(args=>args[3]==="raw");
    expect(rawCalls[0][1]).toBe(dates.at(-5));
    expect(rawCalls.some(args=>args[0].length===1 && args[0][0]==="SPY" && args[1]===dates.at(-260))).toBe(true);
    expect(await market.db.prepare("SELECT status FROM eod_adjustment_repairs WHERE feed='sip' AND ticker='SPY'").first())
      .toEqual({status:"complete"});
    expect(await market.db.prepare("SELECT MIN(c) AS low,MAX(c) AS high,MIN(reported_volume) AS volume FROM alpaca_daily_bars").first())
      .toEqual({low:50,high:50,volume:200});
  });

  it("repairs archived and hot split prices coherently without duplicate archive writes or revision accounting",async()=>{
    const history=createSqliteD1();
    try {
      history.migrate("history-migrations");
      const archivedEnv={...env,MARKET_HISTORY_DB:history.db};
      await archiveMarketHistoryBars(archivedEnv,dates.slice(-260,-90).map(date=>makeBar(date)));
      await market.db.prepare("DELETE FROM alpaca_daily_bars WHERE date<?").bind(dates.at(-90)).run();
      const before=await market.db.prepare("SELECT revision FROM eod_input_revisions WHERE feed='sip' AND ticker='SPY'")
        .first<number>("revision");
      calls.alpaca.mockImplementation(async(tickers:string[],start:string,_target:string,adjustment="split")=>tickers.includes("SPY")
        ? dates.filter(date=>date>=start).map(date=>({...makeBar(date,50),adjustment,reportedVolume:200,
          reportedVolumeCollectedAt:adjustment==="raw" ? "2026-09-04T21:00:00Z" : null})) : []);
      const prepare=vi.spyOn(history.db,"prepare");
      // Completion exercises the runner's exact before + own changes = after
      // check, including both archive correction increments and hot triggers.
      expect((await runEodBatch(archivedEnv,runId,ops.db,{hotSessions:90})).status).toBe("completed");
      const archiveWrites=prepare.mock.calls.filter(([sql])=>/^\s*INSERT OR IGNORE INTO market_history_blocks\b/.test(sql));
      const years=new Set(dates.slice(-260).map(date=>date.slice(0,4))).size;
      expect(archiveWrites).toHaveLength(years);
      prepare.mockRestore();
      const after=await market.db.prepare("SELECT revision FROM eod_input_revisions WHERE feed='sip' AND ticker='SPY'")
        .first<number>("revision");
      expect(after).toBe(before!+years*2+90);
      const retained=await loadMarketHistory(archivedEnv,{tickers:["SPY"],feed:"sip"});
      expect(retained).toHaveLength(260);
      expect(retained.every(bar=>bar.o===50 && bar.h===51 && bar.l===49 && bar.c===50
        && bar.adjustment==="split" && bar.reportedVolume===200
        && bar.reportedVolumeCollectedAt==="2026-09-04T21:00:00Z")).toBe(true);
      expect(await market.db.prepare("SELECT COUNT(*) AS count FROM alpaca_daily_bars WHERE feed='sip' AND ticker='SPY'").first())
        .toEqual({count:90});
      expect(await market.db.prepare("SELECT status,owner_token FROM eod_adjustment_repairs WHERE feed='sip' AND ticker='SPY'").first())
        .toEqual({status:"complete",owner_token:null});
      expect(calls.alpaca.mock.calls.some(args=>args[3]==="raw" && args[0].length===1
        && args[0][0]==="SPY" && args[1]===dates.at(-260))).toBe(true);
    } finally {history.dispose();}
  },60_000);
  it("rejects a private storage plan that would trim a newly measured member before any provider writes",async()=>{
    const saved=await ops.db.prepare("SELECT input_json FROM eod_runs WHERE id=?").bind(runId).first<string>("input_json");
    const planned=JSON.parse(saved!) as FrozenInputs;
    planned.tickers.push("NEWLY-LISTED");
    await expect(runEodBatch(env,runId,ops.db,{hotSessions:90,storageInputs:planned})).rejects.toThrow("storage-bootstrap-input-plan-changed");
    expect(calls.alpaca).not.toHaveBeenCalled();expect(calls.yahoo).not.toHaveBeenCalled();
    expect(await market.db.prepare("SELECT COUNT(*) AS n FROM eod_publications").first()).toEqual({n:0});
    expect(await ops.db.prepare("SELECT input_json FROM eod_runs WHERE id=?").bind(runId).first<string>("input_json")).toBe(saved);
  });
  it("runs a private bootstrap against the exact measured current catalog and membership inputs",async()=>{
    let planned=JSON.parse((await ops.db.prepare("SELECT input_json FROM eod_runs WHERE id=?").bind(runId).first<string>("input_json"))!) as FrozenInputs;
    planned.tickers=["SPY",...planned.tickers.filter(ticker=>ticker!=="SPY").sort()];
    await ops.db.prepare("UPDATE eod_runs SET input_json=? WHERE id=?").bind(JSON.stringify(planned),runId).run();
    await market.db.prepare("CREATE TABLE symbols(ticker TEXT PRIMARY KEY,is_active INTEGER,catalog_managed INTEGER,asset_class TEXT)").run();
    await market.db.prepare("INSERT INTO symbols SELECT value,1,1,'equity' FROM json_each(?)")
      .bind(JSON.stringify(planned.tickers)).run();
    const config=vi.spyOn(configDb,"loadConfig").mockResolvedValue(planned.config);
    vi.mocked(loadEodMemberships).mockResolvedValue(structuredClone(planned.memberships));
    try {
      planned=await loadEodInputs(env,session);
      await ops.db.prepare("UPDATE eod_runs SET input_json=? WHERE id=?").bind(JSON.stringify(planned),runId).run();
      expect((await runEodBatch(env,runId,ops.db,{hotSessions:90,storageInputs:planned})).status).toBe("completed");
      expect(await ops.db.prepare("SELECT input_json FROM eod_runs WHERE id=?").bind(runId).first<string>("input_json"))
        .toBe(JSON.stringify(planned));
    } finally {config.mockRestore();vi.mocked(loadEodMemberships).mockReset();}
  });

  it("keeps a private90-session storage target small while calculating from the full260-session archive window",async () => {
    const history=createSqliteD1();
    try {
      history.migrate("history-migrations");
      const archivedEnv={...env,MARKET_HISTORY_DB:history.db};
      await market.db.prepare("DELETE FROM alpaca_daily_bars WHERE date<>?").bind(session).run();
      expect((await runEodBatch(archivedEnv,runId,ops.db,{hotSessions:90})).status).toBe("completed");
      const hot=await market.db.prepare("SELECT COUNT(*) AS count,MIN(date) AS firstDate FROM alpaca_daily_bars WHERE feed='sip' AND ticker='SPY'").first<{count:number;firstDate:string}>();
      // A cold bootstrap seeds one hot close per security. Its previous four
      // reconciliation bars are already available through the archive reader.
      expect(hot!.count).toBe(1);
      expect(hot!.firstDate>=dates.at(-90)!).toBe(true);
      expect(await loadMarketHistory(archivedEnv,{tickers:["SPY"],feed:"sip"})).toHaveLength(260);
      const catalog=await market.db.prepare("SELECT payload_json FROM eod_publications WHERE scope='history:catalog'").first<string>("payload_json");
      expect(JSON.parse(catalog!).rows.find((row:unknown[])=>row[0]==="SPY")[1]).toBe(260);
      expect(calls.alpaca.mock.calls.some(([,start])=>start===dates.at(-260))).toBe(true);
    } finally {history.dispose();}
  },45_000);

  it("stops cooperatively between provider requests without treating a deadline as fallback data failure",async () => {
    const normal=calls.alpaca.getMockImplementation()!;
    let stopped=false;
    calls.alpaca.mockImplementation(async (...args:unknown[])=>{const result=await normal(...args);stopped=true;return result;});
    const earliestRetry=Date.now()+15*60_000;
    await expect(runEodBatch(env,runId,ops.db,{assertContinue:()=>{
      if(stopped)throw new Error("storage-run-time-slice-complete");
    }})).rejects.toThrow("storage-run-time-slice-complete");
    expect(calls.alpaca).toHaveBeenCalledTimes(1);expect(calls.yahoo).not.toHaveBeenCalled();
    expect(await ops.db.prepare("SELECT status,lease_token,error_message FROM eod_runs WHERE id=?").bind(runId).first())
      .toMatchObject({status:"retrying",lease_token:null,error_message:"storage-run-time-slice-complete"});
    const retryAt=Date.parse((await ops.db.prepare("SELECT next_attempt_at FROM eod_runs WHERE id=?")
      .bind(runId).first<string>("next_attempt_at"))!);
    expect(retryAt).toBeGreaterThanOrEqual(earliestRetry);
    expect(retryAt).toBeLessThanOrEqual(Date.now()+15*60_000);
    expect(await market.db.prepare("SELECT COUNT(*) as n FROM eod_publication_pointers").first()).toEqual({n:0});
  });

  it("rejects a missing durable run instead of reporting a successful duplicate",async () => {
    const missingId=`eod:shadow:${session}:daily`;
    await expect(runEodBatch(env,missingId)).rejects.toThrow("EOD run missing.");
    expect(await ops.db.prepare("SELECT id FROM eod_runs WHERE id=?").bind(missingId).first()).toBeNull();
    expect(calls.alpaca).not.toHaveBeenCalled();
    expect(calls.yahoo).not.toHaveBeenCalled();
  });

  it("leaves a completed durable run unchanged without provider work",async () => {
    await ops.db.prepare("UPDATE eod_runs SET status='completed',stage='finished',completed_at=? WHERE id=?")
      .bind(`${session}T21:00:00Z`,runId).run();
    const before=await ops.db.prepare("SELECT * FROM eod_runs WHERE id=?").bind(runId).first();
    expect(await runEodBatch(env,runId)).toEqual({status:"not-claimed",published:[]});
    expect(await ops.db.prepare("SELECT * FROM eod_runs WHERE id=?").bind(runId).first()).toEqual(before);
    expect(calls.alpaca).not.toHaveBeenCalled();
    expect(calls.yahoo).not.toHaveBeenCalled();
  });

  it("refreshes an officially corrected calendar while retaining frozen constituents and configuration",async () => {
    const older=new Date(`${dates[0]}T00:00:00Z`);older.setUTCDate(older.getUTCDate()-1);
    const olderDate=older.toISOString().slice(0,10);
    await market.db.prepare("INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source) VALUES(?,'09:30','16:00','test')").bind(olderDate).run();
    expect((await runEodBatch(env,runId)).status).toBe("completed");
    const frozen=await ops.db.prepare("SELECT input_json FROM eod_runs WHERE id=?").bind(runId).first<{input_json:string}>();
    const inputs=JSON.parse(frozen!.input_json);
    expect(inputs.calendarDates).toHaveLength(401);
    expect(inputs.calendarDates[0]).toBe(olderDate);
    expect(inputs.memberships).toHaveLength(5);
    expect(inputs.tickers).toHaveLength(26);
  });

  it("detects an independent bar writer between input read and publication",async () => {
    const normal=calls.alpaca.getMockImplementation()!;
    let changed=false;
    calls.alpaca.mockImplementation(async (...args:unknown[]) => {
      if (!changed) {changed=true;await market.db.prepare("UPDATE alpaca_daily_bars SET c=100.5 WHERE ticker='SPY' AND date=?").bind(session).run();}
      return normal(...args);
    });
    await expect(runEodBatch(env,runId)).rejects.toThrow("eod-concurrent-input-correction");
    expect(await market.db.prepare("SELECT COUNT(*) as n FROM eod_publication_pointers").first()).toEqual({n:0});
  });

  it("keeps processing Alpaca symbols after the shared Yahoo daily budget is exhausted",async () => {
    calls.yahoo.mockRejectedValue(new ProviderBudgetExceededError("yahoo",250,"day"));
    expect((await runEodBatch(env,runId)).status).toBe("completed");
    expect(calls.yahoo).toHaveBeenCalledTimes(1);
    expect(calls.alpaca.mock.calls.some(([tickers]) => tickers.includes("MISSING24"))).toBe(true);
    const progress=await ops.db.prepare("SELECT progress_json FROM eod_runs WHERE id=?").bind(runId).first<{progress_json:string}>();
    expect(JSON.parse(progress!.progress_json).symbols).toBe(26);
  });

  it("publishes price breadth with null volume when raw volume collection fails",async () => {
    const normal=calls.alpaca.getMockImplementation()!;
    calls.alpaca.mockImplementation(async (...args:unknown[]) => {
      if (args[3]==="raw") throw new Error("alpaca-http-503");
      return normal(...args);
    });
    expect((await runEodBatch(env,runId)).status).toBe("completed");
    const row=await market.db.prepare(`SELECT payload_json as payload,payload_codec as payloadCodec,payload_base64 as payloadBase64
      FROM eod_publications WHERE scope='breadth:sp500-core'`).first<{payload:string;payloadCodec:string;payloadBase64:string}>();
    const payload=await decodeEodPayload(row!) as {metrics:{advancers:number;totalVolume:number|null}};
    expect(payload.metrics.advancers).toBe(0);
    expect(payload.metrics.totalVolume).toBeNull();
  });

  it("does not let an empty Overview candidate freeze valid independent breadth scopes",async () => {
    const row=await ops.db.prepare("SELECT input_json FROM eod_runs WHERE id=?").bind(runId).first<{input_json:string}>();
    const input=JSON.parse(row!.input_json);
    input.config.sections[0].groups[0].items[0].ticker="MISSING0";
    await ops.db.prepare("UPDATE eod_runs SET input_json=? WHERE id=?").bind(JSON.stringify(input),runId).run();
    expect((await runEodBatch(env,runId)).status).toBe("retrying");
    expect(await market.db.prepare("SELECT COUNT(*) as n FROM eod_publication_pointers WHERE scope LIKE 'breadth:%'").first()).toEqual({n:5});
  });

  it("preserves partially frozen inputs and fills a recovered universe without reloading configuration",async () => {
    const original=JSON.parse((await ops.db.prepare("SELECT input_json FROM eod_runs WHERE id=?").bind(runId).first<string>("input_json"))!);
    const recovered=original.memberships.pop();
    await ops.db.prepare("UPDATE eod_runs SET input_json=? WHERE id=?").bind(JSON.stringify(original),runId).run();
    vi.mocked(loadEodMemberships).mockResolvedValueOnce([]);
    expect((await runEodBatch(env,runId)).status).toBe("retrying");
    expect(await market.db.prepare("SELECT COUNT(*) AS n FROM eod_publication_pointers").first()).toEqual({n:6});
    vi.mocked(loadEodMemberships).mockResolvedValueOnce([recovered]);
    expect((await runEodBatch(env,runId)).status).toBe("completed");
    const inputs=JSON.parse((await ops.db.prepare("SELECT input_json FROM eod_runs WHERE id=?").bind(runId).first<string>("input_json"))!);
    expect(inputs.config).toEqual(original.config);
    expect(inputs.memberships).toHaveLength(5);
    expect(inputs.tickers).toEqual(original.tickers);
  });
});
