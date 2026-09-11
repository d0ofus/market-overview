import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSsgaHoldingsFile, syncEtfConstituents } from "../src/etf";
import { etfHoldingsIssue, etfHoldingAssetType, prepareStoredEtfHoldings } from "../src/etf-holdings-quality";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const NOW = new Date("2026-09-11T06:30:00Z");
const fixtures = JSON.parse(readFileSync("test/fixtures/ssga-sectors-2026-09-09.json", "utf8")) as {
  version: number; funds: Array<{ticker:string;url:string;checkedAt:string;rows:unknown[][]}>;
};
const counts:Record<string,number>={XLB:28,XLF:80,XLI:86,XLK:76,XLP:38,XLU:34,XLY:50,XLE:24,XLRE:33,XLV:63};
function workbook(rows:unknown[][]) {
  const book=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),"holdings");
  return XLSX.write(book,{type:"array",bookType:"xlsx"}) as ArrayBuffer;
}
beforeEach(()=>{vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(NOW);});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

describe("actual sector holdings asset identities",()=>{
  it.each(fixtures.funds)("retains every reported $ticker position and exact signed weights",fund=>{
    const parsed=parseSsgaHoldingsFile(fund.ticker,workbook(fund.rows),"xlsx");
    expect(parsed.asOfDate).toBe("2026-09-09");
    expect(parsed.holdings).toHaveLength(counts[fund.ticker]);
    const header=fund.rows.findIndex(row=>row.includes("Ticker")&&row.includes("Weight"));
    const weightIndex=fund.rows[header].indexOf("Weight");
    expect(parsed.holdings.map(row=>row.weight)).toEqual(fund.rows.slice(header+1).map(row=>Number(row[weightIndex])));
    const prepared=prepareStoredEtfHoldings(fund.ticker,parsed.holdings.map(row=>({...row,source:"ssga:fund-data",
      asOfDate:parsed.asOfDate,updatedAt:NOW.toISOString()})),null,NOW);
    expect(prepared.holdings.status).toBe("ready");
    const futures=prepared.rows.filter(row=>/\bSEP26$/.test(row.name??""));
    expect(futures).toHaveLength(fund.ticker==="XLRE"?0:1);
    for(const future of futures)expect(future).toMatchObject({assetType:"derivative",chartEligible:false});
    expect(prepared.rows.filter(row=>["cash","money_market","corporate_action"].includes(row.assetType)).every(row=>!row.chartEligible)).toBe(true);
    expect(prepared.rows.filter(row=>row.assetType==="equity").every(row=>row.chartEligible)).toBe(true);
  });

  it("requires matching source, fund, contract root, month and year for signed sector futures",()=>{
    const future={ticker:"IXDU6",name:"XAB MATERIALS     SEP26",weight:-0.009707,source:"ssga:fund-data"};
    expect(etfHoldingAssetType("XLB",future)).toBe("derivative");
    for(const wrong of [{...future,source:"unknown"},{...future,ticker:"IXTU6"},{...future,ticker:"IXDZ6"},
      {...future,ticker:"IXDU7"},{...future,name:"Materials company"},{...future,weight:-101}]) {
      expect(etfHoldingsIssue("XLB",[wrong])).toBe("holdings-weights-inconsistent");
    }
    expect(etfHoldingsIssue("XLK",[future])).toBe("holdings-weights-inconsistent");
  });

  it("retains source-identified sterling balances without treating the GBP listed ticker as cash",()=>{
    const cash={ticker:"GBP",name:"POUND STERLING",weight:-0.000001,source:"ssga:fund-data"};
    expect(etfHoldingAssetType("XLF",cash)).toBe("cash");
    expect(etfHoldingsIssue("XLF",[cash])).toBeNull();
    expect(etfHoldingAssetType("XLF",{...cash,source:"unknown"})).toBe("equity");
    expect(etfHoldingAssetType("XLF",{...cash,name:"Global company"})).toBe("equity");
    expect(etfHoldingsIssue("XLF",[{...cash,weight:-101}])).toBe("holdings-weights-inconsistent");
    const fund=fixtures.funds.find(row=>row.ticker==="XLF")!;
    expect(parseSsgaHoldingsFile("XLF",workbook(fund.rows),"xlsx").holdings.find(row=>row.ticker==="GBP"))
      .toMatchObject({name:"POUND STERLING",assetType:"cash",weight:0.000001});
  });

  it("preserves the issuer's actual corporate-action identifier and refuses unexplained placeholders",()=>{
    const fund=fixtures.funds.find(row=>row.ticker==="XLP")!,parsed=parseSsgaHoldingsFile("XLP",workbook(fund.rows),"xlsx");
    expect(parsed.holdings.find(row=>row.name==="CONTRA WALGREENS BOOTS"))
      .toMatchObject({ticker:"931CVR013",weight:0,assetType:"corporate_action"});
    const changed=structuredClone(fund.rows),position=changed.find(row=>row[0]==="CONTRA WALGREENS BOOTS")!;
    position[2]="UNVERIFIED";
    expect(()=>parseSsgaHoldingsFile("XLP",workbook(changed),"xlsx")).toThrow("position-identity-invalid");
    expect(etfHoldingAssetType("XLF",{ticker:"931CVR013",name:"CONTRA WALGREENS BOOTS",source:"ssga:fund-data"})).toBe("equity");
  });

  it("persists cash and corporate-action rows without inserting their identifiers into the equity catalog",async()=>{
    const sqlite=createSqliteD1();
    try {
      sqlite.script("CREATE TABLE symbols(ticker TEXT PRIMARY KEY,name TEXT,exchange TEXT,asset_class TEXT,sector TEXT,industry TEXT);\n"
        + ["0006_etf_watchlists_and_constituents.sql","0009_etf_watchlist_source_url.sql","0051_etf_sync_metadata.sql"]
          .map(name=>readFileSync(`migrations/${name}`,"utf8")).join("\n"));
      const env={DB:sqlite.db} as Env;
      for(const ticker of ["XLF","XLP"]) {
        const fund=fixtures.funds.find(row=>row.ticker===ticker)!;
        vi.spyOn(globalThis,"fetch").mockImplementation(async input=>String(input).endsWith(".xlsx")
          ?new Response(workbook(fund.rows)):new Response(`<a href="${fund.url}">Holdings</a>`));
        await expect(syncEtfConstituents(env,ticker)).resolves.toMatchObject({coverage:"full",sourceTier:"official",count:counts[ticker],asOfDate:"2026-09-09"});
        expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM etf_constituents WHERE etf_ticker=?").bind(ticker).first("count")).toBe(counts[ticker]);
        vi.restoreAllMocks();
      }
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM symbols WHERE ticker IN ('-','USD','GBP','931CVR013','IXAU6','IXRU6')").first("count")).toBe(0);
      expect(await env.DB.prepare("SELECT constituent_name AS name,weight FROM etf_constituents WHERE etf_ticker='XLP' AND constituent_ticker='931CVR013'").first())
        .toEqual({name:"CONTRA WALGREENS BOOTS",weight:0});
    } finally {sqlite.dispose();}
  },20000);
});
