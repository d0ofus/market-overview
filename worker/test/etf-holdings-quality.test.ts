import { afterEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { parseHoldingsFileByType, parseSpdrGoldArchive, parseIsharesPhysicalHoldings, holdingsFileAsOfDate, syncEtfConstituents } from "../src/etf";
import { etfHoldingAssetType, etfHoldingsIssue, etfHoldingsDateIssue, getEtfLifecycle, prepareStoredEtfHoldings, type StoredEtfHolding } from "../src/etf-holdings-quality";
import { estimateEodQueries } from "../src/eod-d1-rest";
import type { Env } from "../src/types";

const now = new Date("2026-09-11T04:30:00Z"), updated = "2026-03-12T22:00:00Z";
const holding = (ticker: string, weight: number | null = 5): StoredEtfHolding => ({ticker, weight, name:ticker, asOfDate:"2026-03-12", source:"official:advisorshares.com", updatedAt:updated});
const status = {etfTicker:"EATZ",status:"ok",error:null,source:"official:advisorshares.com",lastSyncedAt:updated,lastFullSyncedAt:updated,recordsCount:717,coverage:"full"};
function workbook(rows: unknown[][], sheetName = "Holdings"): ArrayBuffer {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),sheetName);
  return XLSX.write(book,{type:"array",bookType:"xlsx"}) as ArrayBuffer;
}
const goldArchive = (date = "10-Sep-2026", ounces: unknown = 33_767_456.92) => workbook([
  ["Date","Total Ounces of Gold in the Trust","Total Net Asset Value in the Trust"],
  ["09-Sep-2026",33_778_790.74,149_065_825_278.27],[date,ounces,147_393_848_783.45],
],"US GLD Historical Archive");

describe("holdings identity, weight units and dated public view",()=>{
  afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
  it("preserves explicit sub-one-percent CSV weights and formatted Excel percentages",()=>{
    const csv="Ticker,Name,Weight\nAAA,First,0.50%\nBBB,Second,0.75\nCCC,Third,1%\n";
    expect(parseHoldingsFileByType("https://issuer.test/holdings.csv","text/csv",csv,null).map(row=>row.weight)).toEqual([1,0.75,0.5]);
    const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([["Ticker","Name","Weight"],["AAA","First",0.005]]);
    sheet.C2.z="0.00%";XLSX.utils.book_append_sheet(book,sheet,"Holdings");
    const bytes=XLSX.write(book,{type:"array",bookType:"xlsx"}) as ArrayBuffer;
    expect(parseHoldingsFileByType("https://issuer.test/full.xlsx","application/octet-stream",null,bytes)).toEqual([{ticker:"AAA",name:"First",weight:0.5}]);
  });
  it("filters consolidated workbooks before generic parsing and rejects unknown account identity",()=>{
    const bytes=workbook([["Account Symbol","Stock Ticker","Security Description","Portfolio Weight %"],
      ["EATZ","EAT","Brinker","5.00%"],["MSOS","MSOSX","Other fund","20.00%"]]);
    expect(parseHoldingsFileByType("https://advisorshares.com/all.xlsx","application/octet-stream",null,bytes,{etfTicker:"EATZ"}))
      .toEqual([{ticker:"EAT",name:"Brinker",weight:5}]);
    expect(parseHoldingsFileByType("https://advisorshares.com/all.xlsx","application/octet-stream",null,bytes,{etfTicker:"OTHER"})).toEqual([]);
    const unidentifiable=workbook([["Ticker","Name","Weight"],["AAA","Wrong fund",25]]);
    expect(parseHoldingsFileByType("https://advisorshares.com/all.xlsx","application/octet-stream",null,unidentifiable,{etfTicker:"EATZ"})).toEqual([]);
  });
  it("quarantines the stored 717-row EATZ list without erasing its diagnostic evidence",()=>{
    const rows=Array.from({length:717},(_,i)=>holding(`T${i}`,0.1));
    const result=prepareStoredEtfHoldings("EATZ",rows,status,now);
    expect(result.rows).toEqual([]);expect(rows).toHaveLength(717);
    expect(result.syncStatus).toMatchObject({status:"quarantined",lastFullSyncedAt:null,quarantinedLastFullSyncedAt:updated});
    expect(result.holdings).toMatchObject({status:"quarantined",storedRecords:717,returnedRecords:0,unavailableReason:"holdings-cross-fund-contamination"});
    expect(result.warning).toContain("liquidated 2026-05-07");expect(getEtfLifecycle("EATZ")?.lastTradingDate).toBe("2026-04-30");
  });
  it("quarantines old multiplied aggregate weights without renormalizing them",()=>{
    const rows=[holding("AAA",50),holding("BBB",75),holding("CCC",30)];
    expect(etfHoldingsIssue("XLC",rows)).toBe("holdings-weights-inconsistent");
    expect(prepareStoredEtfHoldings("XLC",rows,{...status,etfTicker:"XLC"},now).rows).toEqual([]);
    expect(rows.map(row=>row.weight)).toEqual([50,75,30]);
  });
  it("separates verified Bitcoin exposure from an equity ETF trading as BTC",()=>{
    const bitcoin={...holding("BTC",100),name:"Bitcoin",source:"ishares:single-asset",asOfDate:null};
    expect(prepareStoredEtfHoldings("IBIT",[bitcoin],null,now).rows[0]).toMatchObject({assetType:"crypto",chartEligible:false,weight:null});
    expect(prepareStoredEtfHoldings("IBIT",[{...bitcoin,source:"unknown"}],null,now).holdings.unavailableReason).toBe("holdings-crypto-asset-identity-invalid");
    const fund={...holding("BTC",3),name:"Grayscale Bitcoin Mini Trust ETF"};
    expect(prepareStoredEtfHoldings("XLC",[fund],null,now).rows[0]).toMatchObject({assetType:"fund",chartEligible:true,weight:3});
    expect(etfHoldingAssetType("XLC",{ticker:"ETH",name:"Ethan Allen Interiors"})).toBe("equity");
  });
  it("quarantines valid future dates using the exchange date, not UTC midnight",()=>{
    const beforeLocalMidnight=new Date("2026-09-11T00:30:00Z");
    expect(etfHoldingsDateIssue(["2026-09-10"],beforeLocalMidnight)).toBeNull();
    const rows=[{...holding("META",20),asOfDate:"2026-09-11"}];
    const result=prepareStoredEtfHoldings("XLC",rows,null,beforeLocalMidnight);
    expect(result.holdings).toMatchObject({status:"quarantined",unavailableReason:"holdings-effective-date-future"});
    expect(result.rows).toEqual([]);expect(rows[0].asOfDate).toBe("2026-09-11");
  });
  it("keeps old full dates separate from a recent failed or partial attempt",()=>{
    const result=prepareStoredEtfHoldings("XLC",[holding("META",20)],{...status,etfTicker:"XLC",status:"partial",coverage:"full",
      lastSyncedAt:now.toISOString(),error:"Partial attempt; last full retained."},now);
    expect(result.holdings).toMatchObject({status:"stale",asOfDate:"2026-03-12",lastFullSyncedAt:updated,lastAttemptAt:now.toISOString()});
    expect(result.warning).toContain("Showing dated holdings from 2026-03-12");
  });
  it("parses official gold as physical exposure without fabricated weight or equity identity",()=>{
    const parsed=parseSpdrGoldArchive(goldArchive(),now);
    expect(parsed).toMatchObject({asOfDate:"2026-09-10",coverage:"single_asset",sourceTier:"official",holdings:[{ticker:"PHYSICAL-GOLD",weight:null,assetType:"physical_commodity"}]});
    const row={...parsed.holdings[0],asOfDate:parsed.asOfDate!,source:parsed.source,updatedAt:now.toISOString()};
    expect(prepareStoredEtfHoldings("GLD",[row],null,now).rows[0]).toMatchObject({chartEligible:false,assetType:"physical_commodity"});
    for(const invalid of [{...row,ticker:"GOLD",name:"Barrick Mining"},{...row,ticker:"XAU",name:"Gold & Silver Index"},{...row,source:"unknown"}]) {
      expect(prepareStoredEtfHoldings("GLD",[invalid],null,now).rows).toEqual([]);
    }
  });
  it("rejects future/malformed latest gold observations and the wrong fund workbook",()=>{
    expect(()=>parseSpdrGoldArchive(goldArchive("14-Sep-2026"),now)).toThrow("observation-invalid");
    expect(()=>parseSpdrGoldArchive(goldArchive("10-Sep-2026",null),now)).toThrow("observation-invalid");
    expect(()=>parseSpdrGoldArchive(workbook([["Ticker","Weight"],["GOLD",100]]),now)).toThrow("security-identity-invalid");
  });
  it("recognizes silver only from commodity rows and rejects malformed HTTP200 HTML",()=>{
    const csv='Fund Holdings as of,"10-Sep-2026"\nTicker,Name,Asset Class,Weight (%)\n-,SILVER,Commodity,99.75\nGOLD,Barrick,Equity,0.25';
    expect(parseIsharesPhysicalHoldings(csv,"SLV")).toEqual([{ticker:"PHYSICAL-SILVER",name:"Physical silver bullion",weight:99.75,assetType:"physical_commodity"}]);
    expect(holdingsFileAsOfDate(csv,"SLV")).toBe("2026-09-10");
    expect(parseIsharesPhysicalHoldings("<!DOCTYPE html><html>Not CSV</html>","SLV")).toEqual([]);
  });
});

describe("holdings persistence on the existing core schema",()=>{
  let sqlite:ReturnType<typeof createSqliteD1>|undefined;
  const setup=()=>{
    sqlite=createSqliteD1();
    sqlite.script("CREATE TABLE symbols(ticker TEXT PRIMARY KEY,name TEXT,exchange TEXT,asset_class TEXT,sector TEXT,industry TEXT);\n"+
      ["0006_etf_watchlists_and_constituents.sql","0009_etf_watchlist_source_url.sql","0051_etf_sync_metadata.sql"].map(name=>readFileSync(`migrations/${name}`,"utf8")).join("\n"));
    return {DB:sqlite.db} as Env;
  };
  afterEach(()=>{sqlite?.dispose();sqlite=undefined;vi.restoreAllMocks();vi.useRealTimers();});
  it("persists dated gold holdings without seeding a fake equity, and preserves them on official failure",async()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(now);const env=setup();
    const fetcher=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(goldArchive(),{headers:{"content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}}));
    await expect(syncEtfConstituents(env,"GLD")).resolves.toMatchObject({count:1,asOfDate:"2026-09-10",coverage:"single_asset"});
    const before=await env.DB.prepare("SELECT * FROM etf_constituents WHERE etf_ticker='GLD'").first();
    expect(before).toMatchObject({constituent_ticker:"PHYSICAL-GOLD",weight:null,as_of_date:"2026-09-10"});
    expect(await env.DB.prepare("SELECT ticker FROM symbols WHERE ticker='PHYSICAL-GOLD'").first()).toBeNull();
    fetcher.mockReset().mockResolvedValue(new Response("Unavailable",{status:503}));vi.setSystemTime(new Date("2026-09-12T04:30:00Z"));
    await expect(syncEtfConstituents(env,"GLD")).rejects.toThrow("503");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT * FROM etf_constituents WHERE etf_ticker='GLD'").first()).toEqual(before);
    expect(await env.DB.prepare("SELECT status,last_full_synced_at,source,last_synced_at FROM etf_constituent_sync_status WHERE etf_ticker='GLD'").first())
      .toMatchObject({status:"error",last_full_synced_at:now.toISOString(),source:"spdrgoldshares:physical-gold-archive",last_synced_at:"2026-09-12T04:30:00.000Z"});
  });
  it("preserves a validated historical EATZ list and never calls live providers after liquidation",async()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(now);const env=setup();
    await env.DB.prepare("INSERT INTO etf_constituents(id,etf_ticker,constituent_ticker,weight,as_of_date,source) VALUES('old','EATZ','EAT',5,'2026-04-29','official:advisorshares.com')").run();
    const fetcher=vi.spyOn(globalThis,"fetch");
    await expect(syncEtfConstituents(env,"EATZ")).rejects.toThrow("liquidated 2026-05-07");
    expect(fetcher).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM etf_constituents WHERE etf_ticker='EATZ'").first("count")).toBe(1);
  });
  it("persists IBIT exposure without seeding or changing the BTC equity instrument",async()=>{
    const env=setup();
    const fetcher=vi.spyOn(globalThis,"fetch");
    await expect(syncEtfConstituents(env,"IBIT")).resolves.toMatchObject({count:1,sourceTier:"synthetic",asOfDate:null});
    expect(await env.DB.prepare("SELECT ticker FROM symbols WHERE ticker='BTC'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT constituent_ticker,weight FROM etf_constituents WHERE etf_ticker='IBIT'").first())
      .toEqual({constituent_ticker:"BTC",weight:null});
    expect(fetcher).not.toHaveBeenCalled();
  });
  const officialCsv=(count:number,date="2026-09-10")=>"Date,Account Symbol,Stock Ticker,Security Description,Portfolio Weight %\n"
    +Array.from({length:count},(_,index)=>`${date},MSOS,T${String(index).padStart(4,"0")},Holding ${index},0.10%`).join("\n");
  const mockOfficial=(csv:string)=>vi.spyOn(globalThis,"fetch").mockImplementation(async(input)=>String(input).includes("advisorshares.com")
    ? new Response(csv,{headers:{"content-type":"text/csv"}}) : new Response("Unavailable",{status:503}));
  it("rejects a future official snapshot before replacing the dated full cache",async()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(now);const env=setup();
    await env.DB.prepare("INSERT INTO etf_constituents(id,etf_ticker,constituent_ticker,weight,as_of_date,source) VALUES('old','MSOS','OLD',5,'2026-09-10','official:advisorshares.com')").run();
    mockOfficial(officialCsv(2,"2026-09-14"));
    await expect(syncEtfConstituents(env,"MSOS")).rejects.toThrow("holdings-effective-date-future");
    expect(await env.DB.prepare("SELECT constituent_ticker FROM etf_constituents WHERE etf_ticker='MSOS'").all()).toMatchObject({results:[{constituent_ticker:"OLD"}]});
  });
  it("atomically persists all 501 holdings in three statements, with indexed write credit",async()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(now);const env=setup();mockOfficial(officialCsv(501));
    const batch=vi.spyOn(env.DB,"batch");
    await expect(syncEtfConstituents(env,"MSOS")).resolves.toMatchObject({count:501});
    expect(batch).toHaveBeenCalledTimes(1);expect(batch.mock.calls[0][0]).toHaveLength(3);
    const statements=batch.mock.calls[0][0] as unknown as Array<{sql:string;params:unknown[]}>;
    expect(estimateEodQueries(statements).writes).toBeGreaterThan(501*11);
    expect(estimateEodQueries(statements).writes).toBeLessThan(10_000);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count, COUNT(DISTINCT id) AS ids FROM etf_constituents WHERE etf_ticker='MSOS'").first()).toEqual({count:501,ids:501});
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM symbols WHERE ticker LIKE 'T0%'").first("count")).toBe(501);
    expect(await env.DB.prepare("SELECT constituent_ticker,weight,as_of_date FROM etf_constituents WHERE etf_ticker='MSOS' ORDER BY constituent_ticker DESC LIMIT 1").first())
      .toEqual({constituent_ticker:"T0500",weight:0.1,as_of_date:"2026-09-10"});
    sqlite!.script("CREATE TRIGGER fail_late_holding BEFORE INSERT ON etf_constituents WHEN NEW.constituent_ticker='T0501' BEGIN SELECT RAISE(ABORT,'fixture late failure'); END;");
    vi.mocked(fetch).mockRestore();mockOfficial(officialCsv(502));
    await expect(syncEtfConstituents(env,"MSOS")).rejects.toThrow("fixture late failure");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM etf_constituents WHERE etf_ticker='MSOS'").first("count")).toBe(501);
    expect(await env.DB.prepare("SELECT ticker FROM symbols WHERE ticker='T0501'").first()).toBeNull();
  });
  it("aborts a concurrent larger replacement before its admitted delete count is exceeded",async()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(now);const env=setup();mockOfficial(officialCsv(2));
    const original=env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB,"batch").mockImplementationOnce(async statements=>{
      await env.DB.prepare("INSERT INTO etf_constituents(id,etf_ticker,constituent_ticker,source) VALUES('concurrent','MSOS','OTHER','official:advisorshares.com')").run();
      return original(statements);
    });
    await expect(syncEtfConstituents(env,"MSOS")).rejects.toThrow("malformed JSON");
    expect(await env.DB.prepare("SELECT constituent_ticker FROM etf_constituents WHERE etf_ticker='MSOS'").all()).toMatchObject({results:[{constituent_ticker:"OTHER"}]});
  });
});
