import { execFileSync } from "node:child_process";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import * as metrics from "../src/eod-metrics";
import { buildEodCatalogRow, encodeEodCatalogPayload } from "../src/eod-catalog-service";
import type { MarketHistoryBar } from "../src/market-history";
import { overviewPayload, type FrozenInputs } from "../src/eod-runner";
import { getEtfLifecycle } from "../src/etf-holdings-quality";
import { reviewedEodTickerAlias } from "../src/eod-ticker-aliases";
import { listingDashboardFixture } from "./helpers/eod-listing-fixtures";

const R18="bf65b3c86430ebf904cdc905fb9ccd2a0d492997";
const oldSource=(path:string)=>execFileSync("git",["show",`${R18}:${path}`],{encoding:"utf8",windowsHide:true,maxBuffer:2_000_000});
const compile=(text:string)=>ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
// Execute the trusted, fixed predecessor implementation, not copied expectations
// that could accidentally mirror the new implementation's behavior.
const oldMetrics=new Function("exports",`${compile(oldSource("worker/src/eod-metrics.ts"))}; return exports;`)({}) as typeof metrics;
const oldRunner=ts.createSourceFile("old.ts",oldSource("worker/src/eod-runner.ts"),ts.ScriptTarget.Latest,true);
const oldOverview=oldRunner.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==="overviewPayload")!;
const previousOverview=new Function("computeEodTickerMetrics","getEtfLifecycle","reviewedEodTickerAlias",
  `${compile(oldOverview.getText(oldRunner).replace(/^export\s+/,""))};return overviewPayload;`)(oldMetrics.computeEodTickerMetrics,getEtfLifecycle,reviewedEodTickerAlias) as typeof overviewPayload;
// The old module has one runtime database import. The two pure functions must
// never use it; fail explicitly instead of substituting current catalog logic.
const oldCatalog=new Function("exports","require",`${compile(oldSource("worker/src/eod-catalog-service.ts"))}; return exports;`)({},
  (specifier:string)=>{
    if(specifier!=="./market-data-db") throw new Error(`Unexpected predecessor catalog import: ${specifier}`);
    return {getMarketDataDb:()=>{throw new Error("Pure catalog compatibility fixture must not access a database");}};
  }) as {buildEodCatalogRow:typeof buildEodCatalogRow;encodeEodCatalogPayload:typeof encodeEodCatalogPayload};

afterEach(()=>vi.useRealTimers());

it("preserves R18 byte-for-byte metrics, Overview, breadth and catalog contract when listing evidence is omitted",()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-09-11T21:00:00Z"));
  const session="2026-09-10",calendar=Array.from({length:400},(_,i)=>new Date(Date.parse(`${session}T00:00:00Z`)-(399-i)*86_400_000).toISOString().slice(0,10));
  const tickers=["SPY","BRTM","UNKNOWN","RSHO","EATZ"];
  const bars:metrics.EodMetricBar[]=tickers.flatMap(ticker=>calendar.filter((_date,i)=>ticker!=="UNKNOWN"&&(ticker!=="BRTM"||i===399)
    &&(ticker!=="EATZ"||i<5)).map((date,i)=>({ticker,sessionDate:date,close:100+i,open:100+i,high:101+i,low:99+i,
      reportedVolume:i%10 ? 100:null,sourceProvider:ticker==="RSHO"?"yahoo":"alpaca",priceBasis:"split",sourceFeed:ticker==="RSHO"?"yahoo-eod":"sip"})));
  const current=new Map(tickers.map(ticker=>[ticker,metrics.computeEodTickerMetrics({ticker,targetSession:session,calendarDates:calendar,bars})]));
  const previous=new Map(tickers.map(ticker=>[ticker,oldMetrics.computeEodTickerMetrics({ticker,targetSession:session,calendarDates:calendar,bars})]));
  expect(JSON.stringify([...current])).toBe(JSON.stringify([...previous]));
  const inputs:FrozenInputs={tickers,calendarDates:calendar,methodologyVersion:metrics.EOD_METRICS_VERSION,memberships:[],config:listingDashboardFixture(tickers)};
  expect(JSON.stringify(overviewPayload(inputs,current,session))).toBe(JSON.stringify(previousOverview(inputs,previous,session)));
  for(const universeId of ["sp500-core","nasdaq-core","nyse-core","russell2000-core","overall-market-proxy"]) {
    const input={universeId,targetSession:session,calendarDates:calendar,members:tickers.map(ticker=>({ticker})),bars};
    expect(JSON.stringify(metrics.computeEodBreadthMetrics({...input,features:current})))
      .toBe(JSON.stringify(oldMetrics.computeEodBreadthMetrics({...input,features:previous})));
  }
  const historyBars:MarketHistoryBar[]=bars.map((bar,index)=>({ticker:bar.ticker,date:bar.sessionDate,
    o:bar.open??bar.close!,h:bar.high??bar.close!,l:bar.low??bar.close!,c:bar.close!,
    volume:index%11 ? 200:null,reportedVolume:bar.reportedVolume??null,
    reportedVolumeCollectedAt:bar.reportedVolume===null ? null:`${session}T21:00:00Z`,
    feed:bar.sourceFeed??"sip",sourceProvider:bar.sourceProvider==="yahoo" ? "yahoo":"alpaca",adjustment:"split",
    observedAt:`${session}T21:00:00Z`,fetchedAt:`${session}T21:00:00Z`}));
  historyBars.push({...historyBars[0],feed:"yahoo-eod",sourceProvider:"yahoo",c:999_999});
  const currentCatalog=tickers.map((ticker,index)=>buildEodCatalogRow(ticker,historyBars,10+index));
  const previousCatalog=tickers.map((ticker,index)=>oldCatalog.buildEodCatalogRow(ticker,historyBars,10+index));
  expect(currentCatalog.map(row=>[row.ticker,row.barCount])).toEqual([["SPY",400],["BRTM",1],["UNKNOWN",0],["RSHO",0],["EATZ",5]]);
  expect(JSON.stringify(currentCatalog)).toBe(JSON.stringify(previousCatalog));
  expect(JSON.stringify(encodeEodCatalogPayload(session,currentCatalog)))
    .toBe(JSON.stringify(oldCatalog.encodeEodCatalogPayload(session,previousCatalog)));
});
