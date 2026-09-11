import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { listingFixture, listingDashboardFixture } from "./helpers/eod-listing-fixtures";
import { registerListingEvidence } from "../src/eod-listing-evidence";
import { decodeEodPayload } from "../src/eod-publication-codec";
import { verifyStorageAcceptedPublications } from "../src/market-storage-acceptance";
import { loadEodInputs, runEodBatch } from "../src/eod-runner";
import type { Env, DashboardConfigPayload, SnapshotReadyResponse } from "../src/types";
import type { EodPriceBar } from "../src/eod-price-provider";
import { eodHash } from "../src/eod-publication-service";
import { loadMarketHistory } from "../src/market-history";
const calls=vi.hoisted(()=>({alpaca:vi.fn(),yahoo:vi.fn(),config:vi.fn(),memberships:vi.fn()}));
vi.mock("../src/market-calendar-cache",()=>({ensureMarketCalendarCoverage:vi.fn()}));
vi.mock("../src/db",()=>({loadConfig:calls.config}));
vi.mock("../src/eod",()=>({refreshBreadthUniverseMemberships:vi.fn(),loadEodMemberships:calls.memberships}));
vi.mock("../src/eod-price-provider",async original=>({...await original<typeof import("../src/eod-price-provider")>(),EodPriceProvider:class{alpaca=calls.alpaca;yahoo=calls.yahoo;symbolErrors=new Map();}}));

describe("listing evidence through actual runner and seven-publication acceptance",()=>{
  let market:ReturnType<typeof createSqliteD1>,ops:ReturnType<typeof createSqliteD1>,history:ReturnType<typeof createSqliteD1>;
  let env:Env;
  const session="2026-09-10",runId=`eod:active:${session}:daily`;
  const calendar=Array.from({length:400},(_,i)=>new Date(Date.parse(`${session}T00:00:00Z`)-(399-i)*86_400_000).toISOString().slice(0,10));
  beforeEach(async()=>{
    vi.clearAllMocks();market=createSqliteD1();ops=createSqliteD1();history=createSqliteD1();
    market.migrate("market-data-migrations");ops.migrate("ops-migrations");history.migrate("history-migrations");
    env={DB:market.db,MARKET_DATA_DB:market.db,MARKET_HISTORY_DB:history.db,OPS_DB:ops.db,EOD_RUNNER_MODE:"active",EOD_READ_ENABLED:"true",ALPACA_API_KEY:"test",ALPACA_API_SECRET:"test"} as Env;
    market.script("CREATE TABLE symbols(ticker TEXT PRIMARY KEY,is_active INTEGER,catalog_managed INTEGER,asset_class TEXT)");
    await market.db.prepare("INSERT INTO symbols SELECT value,1,1,'equity' FROM json_each(?)").bind(JSON.stringify(["SPY","BRTM","UNKNOWN"])).run();
    await market.db.prepare("INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source) SELECT value,'09:30','16:00','test' FROM json_each(?)").bind(JSON.stringify(calendar)).run();
    const config:DashboardConfigPayload=listingDashboardFixture(["SPY","BRTM","UNKNOWN"]);
    calls.config.mockResolvedValue(config);
    calls.memberships.mockResolvedValue(["sp500-core","nasdaq-core","nyse-core","russell2000-core","overall-market-proxy"].map(universeId=>({universeId,versionId:universeId,source:"verified proxy",
      sourceType:universeId==="sp500-core"?"wikipedia-derived-public-proxy":universeId==="russell2000-core"?"official-etf-holdings-proxy":"public-common-stock-proxy",
      sourceUrl:"https://example.test",sourceAsOfDate:session,verifiedAt:`${session}T20:00:00Z`,members:["SPY","BRTM"]})));
    const candidate={...listingFixture(),effectiveFromSession:session};
    await registerListingEvidence(ops.db,candidate,candidate.sourceQuote,{ticker:"BRTM",issuerName:candidate.security.issuerName,exchange:"NASDAQ",assetClass:"equity",firstRetainedDate:null},"b".repeat(40),new Date(`${session}T21:00:00Z`));
    await ops.db.prepare("INSERT INTO eod_runs(id,session_date,purpose,mode,status,stage,created_at,updated_at) VALUES(?,?,'daily','active','queued','queued',?,?)").bind(runId,session,`${session}T21:00:00Z`,`${session}T21:00:00Z`).run();
    calls.yahoo.mockRejectedValue(new Error("yahoo-unavailable"));
    calls.alpaca.mockImplementation(async(tickers:string[],start:string,_target:string,adjustment="split")=>tickers.flatMap(ticker=>calendar.filter(date=>date>=start&&(ticker==="SPY"||(ticker==="BRTM"&&date===session))).map(date=>({
      ticker,date,o:100,h:101,l:99,c:100,volume:100,reportedVolume:100,feed:"sip",sourceProvider:"alpaca",adjustment,observedAt:`${session}T21:00:00Z`,fetchedAt:`${session}T21:00:00Z`,reportedVolumeCollectedAt:`${session}T21:00:00Z`,
    }))));
  },30_000);
  afterEach(()=>{market.dispose();ops.dispose();history.dispose();});

  it.each([true,false])("publishes valid scopes with first-day price available=%s while authenticating IPO exclusions",async(hasPrice)=>{
    if(!hasPrice){const normal=calls.alpaca.getMockImplementation()!;calls.alpaca.mockImplementation(async(...args:unknown[])=>(await normal(...args) as EodPriceBar[]).filter(row=>row.ticker!=="BRTM"));}
    expect((await runEodBatch(env,runId)).status).toBe("completed");
    const frozen=JSON.parse((await ops.db.prepare("SELECT input_json FROM eod_runs WHERE id=?").bind(runId).first<string>("input_json"))!);
    expect(frozen.listingEvidence.entries[0]).toMatchObject({ticker:"BRTM",listingDate:session});
    expect(frozen.listingEvidence.entries[0].sourceQuote).toBeUndefined();
    const stored=await market.db.prepare("SELECT payload_json AS payload,payload_codec AS payloadCodec,payload_base64 AS payloadBase64 FROM eod_publications WHERE scope='overview:default'").first<{payload:string;payloadCodec:string;payloadBase64:string|null}>();
    const overview=await decodeEodPayload(stored!) as SnapshotReadyResponse;
    const ipo=overview.sections[0]!.groups[0]!.rows.find(row=>row.ticker==="BRTM")!;
    expect(ipo.price).toBe(hasPrice?100:null);expect(ipo.change1d).toBeNull();expect(ipo.above200Sma).toBeNull();
    expect(calls.yahoo.mock.calls.some(([ticker])=>ticker==="BRTM")).toBe(!hasPrice);
    expect(calls.yahoo.mock.calls.some(([ticker])=>ticker==="UNKNOWN")).toBe(true);
    expect(ipo.currentData?.fieldReasons).toMatchObject({change1d:"verified-recent-listing",sma200:"verified-recent-listing"});
    expect(ipo.historyData?.seriesReason).toContain(`Verified first trading session ${session}`);
    expect(overview.sections[0]!.groups[0]!.rows.find(row=>row.ticker==="UNKNOWN")!.currentData?.fieldReasons?.sma200).toBe("missing-required-session");
    const input={env,runId,tickers:frozen.tickers as string[],expectedSession:session,identity:{id:"market-storage:test",sourceDatabaseId:"10000000-0000-0000-0000-000000000001",targetDatabaseId:"10000000-0000-0000-0000-000000000002",historyDatabaseId:"10000000-0000-0000-0000-000000000003",sessionDate:session,codeRevision:"b".repeat(40)}};
    expect((await verifyStorageAcceptedPublications(input)).scopes).toHaveLength(7);
    const row=await market.db.prepare("SELECT id,payload_json AS payload,payload_codec AS payloadCodec,payload_base64 AS payloadBase64 FROM eod_publications WHERE scope='breadth:nasdaq-core'").first<{id:string;payload:string;payloadCodec:string;payloadBase64:string|null}>();
    const breadth=await decodeEodPayload(row!) as {metrics:{metricCoverage:{pctAbove200MA:{eligiblePopulation:number}}}};
    breadth.metrics.metricCoverage.pctAbove200MA.eligiblePopulation=2;
    await market.db.prepare("UPDATE eod_publications SET payload_codec='json',payload_json=?,payload_checksum=? WHERE id=?").bind(JSON.stringify(breadth),await eodHash(breadth),row!.id).run();
    await expect(verifyStorageAcceptedPublications(input)).rejects.toThrow("listing-coverage-denominator-invalid");
  },30_000);

  it("reuses a verified first-day checkpoint on ordinary retry and does not expand five-session reconciliation into pre-listing history",async()=>{
    await market.db.prepare("DELETE FROM symbols WHERE ticker='UNKNOWN'").run();
    const config=await calls.config();config.sections[0].groups[0].items=config.sections[0].groups[0].items.filter((item:{ticker:string})=>item.ticker!=="UNKNOWN");
    calls.config.mockResolvedValue(config);
    await market.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume,reported_volume)
      SELECT 'sip','SPY',value,100,101,99,100,100,100 FROM json_each(?)`).bind(JSON.stringify(calendar.slice(-260))).run();
    expect((await runEodBatch(env,runId)).status).toBe("completed");
    expect(calls.yahoo).not.toHaveBeenCalled();
    expect(calls.alpaca.mock.calls[0]?.[1]).toBe(calendar.at(-5));
    const checkpoints=(await ops.db.prepare("SELECT * FROM eod_checkpoints WHERE run_id=? ORDER BY chunk_key").bind(runId).all()).results;
    await ops.db.prepare("UPDATE eod_runs SET status='retrying',completed_at=NULL,error_code='incomplete-publication',error_message=NULL WHERE id=?").bind(runId).run();
    calls.alpaca.mockClear();calls.yahoo.mockClear();
    expect((await runEodBatch(env,runId)).status).toBe("completed");
    expect(calls.alpaca).not.toHaveBeenCalled();expect(calls.yahoo).not.toHaveBeenCalled();
    expect((await ops.db.prepare("SELECT * FROM eod_checkpoints WHERE run_id=? ORDER BY chunk_key").bind(runId).all()).results).toEqual(checkpoints);
  },30_000);

  it("retains all 6,330 symbols with compact evidence and refuses an oversized frozen input",async()=>{
    const tickers=["SPY","BRTM",...Array.from({length:6328},(_,i)=>`T${i}`)];
    await market.db.prepare("INSERT OR IGNORE INTO symbols SELECT value,1,1,'equity' FROM json_each(?)").bind(JSON.stringify(tickers)).run();
    const memberships=await calls.memberships();
    calls.memberships.mockResolvedValue(memberships.map((row:Record<string,unknown>)=>({...row,members:tickers})));
    const inputs=await loadEodInputs(env,session);
    expect(inputs.tickers).toHaveLength(6331); // The existing UNKNOWN catalog member remains too.
    expect(new TextEncoder().encode(JSON.stringify(inputs)).byteLength).toBeLessThan(1_800_000);
    expect(JSON.stringify(inputs.listingEvidence).length).toBeLessThan(400);
    const config=await calls.config();config.sections[0].title="x".repeat(1_800_000);
    calls.config.mockResolvedValue(config);
    await expect(loadEodInputs(env,session)).rejects.toThrow("eod-listing-evidence-input-capacity-exceeded");
  },30_000);

  it("quarantines contradictory pre-listing prices without deleting them or blocking healthy scopes",async()=>{
    const normal=calls.alpaca.getMockImplementation()!;
    calls.alpaca.mockImplementation(async(...args:unknown[])=>{
      const rows=await normal(...args) as EodPriceBar[];
      const current=rows.find(row=>row.ticker==="BRTM");
      return current ? [...rows,{...current,date:"2026-09-09"}] : rows;
    });
    expect((await runEodBatch(env,runId)).status).toBe("completed");
    expect(calls.yahoo.mock.calls.some(([ticker])=>ticker==="BRTM")).toBe(false);
    const row=await market.db.prepare("SELECT payload_json AS payload,payload_codec AS payloadCodec,payload_base64 AS payloadBase64 FROM eod_publications WHERE scope='overview:default'").first<{payload:string;payloadCodec:string;payloadBase64:string|null}>();
    const overview=await decodeEodPayload(row!) as SnapshotReadyResponse;
    const items=overview.sections[0]!.groups[0]!.rows;
    expect(items.find(row=>row.ticker==="SPY")?.price).toBe(100);
    expect(items.find(row=>row.ticker==="BRTM")).toMatchObject({price:null,change1d:null,above200Sma:null});
    expect(items.find(row=>row.ticker==="BRTM")?.barFreshnessReason).toContain("eod-listing-evidence-history-contradiction");
    expect((await loadMarketHistory(env,{tickers:["BRTM"],feed:"sip"})).map(row=>row.date)).toEqual(["2026-09-09","2026-09-10"]);
    expect((await market.db.prepare("SELECT scope FROM eod_publication_pointers").all()).results).toHaveLength(7);
  },30_000);
});
