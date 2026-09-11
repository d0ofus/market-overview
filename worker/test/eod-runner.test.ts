import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import type { Env } from "../src/types";
import { EOD_METRICS_VERSION } from "../src/eod-metrics";
import { ProviderBudgetExceededError } from "../src/provider-usage";
import { decodeEodPayload } from "../src/eod-publication-codec";
import { loadMarketHistory } from "../src/market-history";
import { loadEodMemberships } from "../src/eod";
import * as configDb from "../src/db";
const calls=vi.hoisted(() => ({alpaca:vi.fn(),yahoo:vi.fn()}));
vi.mock("../src/market-calendar-cache",() => ({ensureMarketCalendarCoverage:vi.fn()}));
vi.mock("../src/eod",() => ({refreshBreadthUniverseMemberships:vi.fn(),loadEodMemberships:vi.fn()}));
vi.mock("../src/eod-price-provider",async (original) => ({...await original<typeof import("../src/eod-price-provider")>(),EodPriceProvider:class {alpaca=calls.alpaca;yahoo=calls.yahoo;symbolErrors=new Map();}}));
import { runEodBatch, loadEodInputs } from "../src/eod-runner";
import type { FrozenInputs } from "../src/eod-runner";

describe("EOD resumable runner with real publication and lease SQL", {timeout:30_000}, () => {
  let market:ReturnType<typeof createSqliteD1>,ops:ReturnType<typeof createSqliteD1>;
  let env:Env;
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
  afterEach(() => {market.dispose();ops.dispose();});

  it("publishes independent pages before a later catalog chunk is interrupted and resumes idempotently",async () => {
    const normal=calls.alpaca.getMockImplementation()!;
    calls.alpaca.mockImplementation(async (...args:unknown[]) => {
      if ((args[0] as string[]).includes("MISSING24")) throw new Error("d1-capacity-test");
      return normal(...args);
    });
    await expect(runEodBatch(env,runId)).rejects.toThrow("d1-capacity-test");
    expect(await market.db.prepare("SELECT COUNT(*) as n FROM eod_publication_pointers").first()).toEqual({n:6});
    expect(await ops.db.prepare("SELECT status,lease_token FROM eod_runs WHERE id=?").bind(runId).first()).toMatchObject({status:"retrying",lease_token:null});
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
    await expect(runEodBatch(env,runId,ops.db,{assertContinue:()=>{
      if(stopped)throw new Error("storage-run-time-slice-complete");
    }})).rejects.toThrow("storage-run-time-slice-complete");
    expect(calls.alpaca).toHaveBeenCalledTimes(1);expect(calls.yahoo).not.toHaveBeenCalled();
    expect(await ops.db.prepare("SELECT status,lease_token,error_message FROM eod_runs WHERE id=?").bind(runId).first())
      .toMatchObject({status:"retrying",lease_token:null,error_message:"storage-run-time-slice-complete"});
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
