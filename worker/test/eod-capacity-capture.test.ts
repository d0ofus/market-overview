import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createCapacityLocalSqlite } from "../scripts/eod-capacity-local-sqlite";
import { captureCapacityDatabase, flattenCapacityHistory } from "../scripts/eod-capacity-capture";
import { STORAGE_TARGET_DDL, STORAGE_BUSINESS_DDL, copyStorageArchiveBlock } from "../src/market-storage-copy";
import { prepareStorageSourceFence } from "../src/market-storage-fence";
import { captureOpenStorageDatabase } from "../src/eod-storage-capacity-renewal";
import { loadMarketHistory, type MarketHistoryBar } from "../src/market-history";
import { verifyStorageConsumerBatch, STORAGE_CONSUMER_CONTRACTS, collectStoragePublicationGrowthSamples,
  storagePublicationGrowthReserve, validateStorageCapacityAnalysis } from "../src/market-storage-acceptance";
import { EOD_PUBLICATION_SCOPES } from "../src/eod-coordinator";
import { estimateEodQueries } from "../src/eod-d1-rest";
import { eodHash } from "../src/eod-publication-service";
import type { Env } from "../src/types";

describe("fresh captured SQLite renewal reference", () => {
  let directory: string, market: ReturnType<typeof createCapacityLocalSqlite>, history: ReturnType<typeof createCapacityLocalSqlite>;
  const locals: Array<ReturnType<typeof createCapacityLocalSqlite>> = [];
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "eod-capacity-capture-test-"));
    market = createCapacityLocalSqlite(join(directory, "live-market.sqlite")); history = createCapacityLocalSqlite(join(directory, "live-history.sqlite"));
    locals.push(market, history);
    await market.script([...STORAGE_TARGET_DDL, ...STORAGE_BUSINESS_DDL].join(";\n"));
    await market.script("INSERT INTO market_storage_fence(id) VALUES('default'); INSERT INTO eod_input_clock(id,revision) VALUES('default',0);");
    await history.script(readFileSync(resolve("history-migrations/0001_history.sql"), "utf8") + readFileSync(resolve("history-migrations/0002_market_storage_fence.sql"), "utf8"));
    for (const local of [market, history]) {
      const plan = await prepareStorageSourceFence(local.db); await local.script(plan.statements.map((row) => row.sql).join("\n"));
    }
  });
  afterEach(async () => { await Promise.all(locals.splice(0).map((local) => local.close())); rmSync(directory, { recursive: true, force: true }); });
  async function hot(rows: MarketHistoryBar[]) {
    await market.db.batch(rows.map((bar) => market.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume,
      source_provider,adjustment,observed_at,fetched_at,reported_volume,reported_volume_collected_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(bar.feed,bar.ticker,bar.date,bar.o,bar.h,bar.l,bar.c,bar.volume,bar.sourceProvider,bar.adjustment,
        bar.observedAt,bar.fetchedAt,bar.reportedVolume ?? null,bar.reportedVolumeCollectedAt ?? null)));
  }
  it("captures real schemas and runs every reader against independent MAX history including gaps, corrections, Yahoo and unsupported rows", async () => {
    const dates: string[] = [];
    for (const date = new Date("2026-09-08T00:00:00Z"); dates.length < 1_380; date.setUTCDate(date.getUTCDate()-1)) {
      if (![0,6].includes(date.getUTCDay())) dates.unshift(date.toISOString().slice(0,10));
    }
    const bars: MarketHistoryBar[] = dates.filter((_, index) => index !== 60).map((date, index) => ({ ticker: "AAA", feed: "sip", date,
      o:100+index,h:103+index,l:98+index,c:101+index,volume:index%8 === 0 ? null : 1000,reportedVolume:index%8 === 0 ? null : 1000,
      reportedVolumeCollectedAt:`${date}T21:00:00Z`,sourceProvider:"alpaca",adjustment:"split",observedAt:`${date}T21:00:00Z`,fetchedAt:`${date}T21:00:00Z` }));
    const yahoo = bars.slice(-15).map((bar) => ({ ...bar, ticker:"YH", feed:"yahoo-eod",sourceProvider:"yahoo",reportedVolume:null }));
    const unsupported = bars.slice(-3).map((bar) => ({ ...bar,ticker:"RAW",sourceProvider:"manual",adjustment:"raw" }));
    const groups = new Map<string,MarketHistoryBar[]>();
    for (const bar of [...bars.slice(0,-1),...yahoo,...unsupported]) {
      const key=`${bar.feed}:${bar.ticker}:${bar.date.slice(0,4)}`; const group=groups.get(key) ?? []; group.push(bar);groups.set(key,group);
    }
    for (const group of groups.values()) await copyStorageArchiveBlock(history.db,group);
    const correction={...bars.at(-2)!,c:bars.at(-2)!.c+0.5,observedAt:"2026-09-08T22:00:00Z"};
    await hot([correction,bars.at(-1)!,{...bars.at(-1)!,ticker:"IPO"}]);
    const marketBefore=await captureOpenStorageDatabase(market.db),historyBefore=await captureOpenStorageDatabase(history.db);
    let checked=0;
    const assertCurrent=async()=>{ checked++;expect(await captureOpenStorageDatabase(market.db)).toEqual(marketBefore);expect(await captureOpenStorageDatabase(history.db)).toEqual(historyBefore); };
    const marketFile=join(directory,"captured-market.sqlite"),historyFile=join(directory,"captured-history.sqlite");
    const capturedMarket=await captureCapacityDatabase({db:market.db,kind:"market",file:marketFile,progress:async()=>undefined,assertCurrent});
    const checkedHistory={...history.db,batch:async(statements:D1PreparedStatement[])=>{
      const queries=statements as unknown as Array<{sql:string;params:unknown[]}>;
      expect(statements.length).toBeLessThanOrEqual(8);
      expect(estimateEodQueries(queries).reads).toBeLessThan(250_000);
      return history.db.batch(statements);
    }} as D1Database;
    const capturedHistory=await captureCapacityDatabase({db:checkedHistory,kind:"history",file:historyFile,progress:async()=>undefined,assertCurrent});
    expect(capturedMarket.rows).toBeGreaterThan(3);expect(capturedHistory.rows).toBeGreaterThan(10);expect(checked).toBeGreaterThan(0);
    const localMarket=createCapacityLocalSqlite(marketFile),localHistory=createCapacityLocalSqlite(historyFile),reference=createCapacityLocalSqlite(join(directory,"reference.sqlite"));
    locals.push(localMarket,localHistory,reference);
    await flattenCapacityHistory({market:localMarket,history:localHistory,reference,progress:async()=>undefined});
    const env={DB:localMarket.db,MARKET_DATA_DB:localMarket.db,MARKET_HISTORY_DB:localHistory.db,EOD_RUNNER_MODE:"shadow"} as Env;
    const referenceEnv={...env,DB:reference.db,MARKET_DATA_DB:reference.db,MARKET_HISTORY_DB:undefined};
    const flat=await loadMarketHistory(referenceEnv,{tickers:["AAA"],feed:"sip"});
    expect(flat).toHaveLength(1_379);expect(flat.find((bar)=>bar.date===correction.date)?.c).toBe(correction.c);
    const identity={id:"market-storage:renewal",sourceDatabaseId:"10000000-0000-0000-0000-000000000001",targetDatabaseId:"10000000-0000-0000-0000-000000000002",
      historyDatabaseId:"10000000-0000-0000-0000-000000000003",sessionDate:dates.at(-1)!,codeRevision:"a".repeat(40)};
    const result=await verifyStorageConsumerBatch({sourceEnv:referenceEnv,targetEnv:env,tickers:["AAA","IPO","MISSING","RAW","YH"],calendarDates:dates,
      capture:{identity,captureHash:await eodHash([capturedMarket,capturedHistory]),sourceCapture:marketBefore,targetCapture:marketBefore,historyCapture:historyBefore},
      maxTickers:10,assertCapture:async()=>undefined});
    expect(result.evidence?.nextTicker).toBe(5);
    for(const name of STORAGE_CONSUMER_CONTRACTS)expect(result.evidence?.checks[name].tickers).toBe(5);
    expect(result.evidence?.checks["correlation-5y"].observations).toBe(1_334);
    expect(result.evidence?.history.missing).toBe(2);
    // All capture/model work is read-only remotely, including exact revisions.
    await assertCurrent();
  },30_000);
  it("rejects missing archive pointers and surfaces local SQL errors without echoing values", async () => {
    const reference=createCapacityLocalSqlite(join(directory,"reference.sqlite"));locals.push(reference);
    await history.db.prepare("INSERT INTO market_history_block_pointers(feed,ticker,calendar_year,block_id) VALUES('sip','AAA',2026,'missing')").run();
    await expect(flattenCapacityHistory({market,history,reference,progress:async()=>undefined})).rejects.toThrow("reference-pointer-invalid");
    await expect(reference.db.prepare("SELECT secret_value FROM absent_table").all()).rejects.toThrow("local-sqlite-query-failed");
  });
  it("measures the captured real schema with existing Python tools and preserves a 90-session layout", async () => {
    const codeRevision=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8",windowsHide:true}).trim();
    const identity={id:"market-storage:measurement",sourceDatabaseId:"10000000-0000-0000-0000-000000000001",targetDatabaseId:"10000000-0000-0000-0000-000000000002",
      historyDatabaseId:"10000000-0000-0000-0000-000000000003",sessionDate:"2026-09-08",codeRevision};
    const timestamp=new Date().toISOString(),tickers=["AAA"],tickerHash=await eodHash(tickers),schemaHash=(await prepareStorageSourceFence(market.db)).schemaHash;
    const scopes=[...EOD_PUBLICATION_SCOPES,"history:catalog"].map((scope)=>({scope,id:scope,revision:1,checksum:""}));
    for(const scope of scopes) {
      const payload={asOfDate:identity.sessionDate,scope:scope.scope,rows:[{ticker:"AAA",close:123.456789,history:Array.from({length:64},(_,i)=>i*1.123456789)}]};
      scope.checksum=await eodHash(payload);
      await market.db.prepare(`INSERT INTO eod_publications(id,scope,session_date,revision,input_hash,methodology_version,payload_json,payload_checksum,status,created_at,accepted_at)
        VALUES(?,?,?,1,?,'fixture',?,?,'accepted',?,?)`).bind(scope.id,scope.scope,identity.sessionDate,"a".repeat(64),JSON.stringify(payload),scope.checksum,timestamp,timestamp).run();
    }
    await hot([{ticker:"AAA",feed:"sip",date:identity.sessionDate,o:100,h:102,l:99,c:101,volume:1000,sourceProvider:"alpaca",adjustment:"split",observedAt:timestamp,fetchedAt:timestamp}]);
    const publicationsBody={version:1 as const,identity,runId:"run",sessionDate:identity.sessionDate,inputClock:1,tickerHash,tickerCount:1,checkedAt:timestamp,
      scopes,membershipHash:"a".repeat(64),catalogHash:"a".repeat(64)};
    const publications={...publicationsBody,evidenceHash:await eodHash(publicationsBody)};
    const env={DB:market.db,MARKET_DATA_DB:market.db,MARKET_HISTORY_DB:history.db} as Env;
    const samples=await collectStoragePublicationGrowthSamples(env,publications,schemaHash);
    const marketFile=join(directory,"physical-market.sqlite"),historyFile=join(directory,"physical-history.sqlite");
    for(const [db,kind,file] of [[market.db,"market",marketFile],[history.db,"history",historyFile]] as const) {
      await captureCapacityDatabase({db,kind,file,progress:async()=>undefined,assertCurrent:async()=>undefined});
    }
    const samplesFile=join(directory,"samples.json"),growthFile=join(directory,"growth.json"),tickerFile=join(directory,"tickers.json"),analysisFile=join(directory,"analysis.json");
    writeFileSync(samplesFile,JSON.stringify(samples));writeFileSync(tickerFile,JSON.stringify({tickers}));
    const python=(script:string,args:string[])=>execFileSync("python",[resolve("scripts",script),...args],{windowsHide:true,encoding:"utf8",timeout:30_000});
    python("measure-eod-publication-growth.py",["--schema-sqlite",marketFile,"--samples-json",samplesFile,"--output",growthFile]);
    const publicationGrowth=JSON.parse(readFileSync(growthFile,"utf8"));
    const reserve=storagePublicationGrowthReserve(publicationGrowth,{codeRevision,tickerHash,schemaHash});
    python("analyze-eod-storage.py",["--source-sqlite",marketFile,"--history-sqlite",historyFile,"--tickers-json",tickerFile,"--session-date",identity.sessionDate,
      "--publication-growth-reserve-bytes",String(reserve),"--output",analysisFile]);
    const analysis=JSON.parse(readFileSync(analysisFile,"utf8"));
    expect(analysis.source.capture).toMatchObject({kind:"logical-d1-capacity-snapshot",completeDeclared:true,partialEstimate:false});
    expect(analysis.source.snapshotSha256).toBe(publicationGrowth.sourceSnapshotSha256);
    const accepted=await validateStorageCapacityAnalysis({analysis,publicationGrowth,identity,tickers,sourceSchemaHash:schemaHash,
      sourceSnapshotSha256:analysis.source.snapshotSha256,target:market.db,history:history.db,publications,hotSessions:90});
    expect(accepted.hotSessions).toBe(90);expect(accepted.projectedMarketBytes).toBeLessThan(350_000_000);expect(accepted.publicationGrowthReserveBytes).toBeGreaterThan(0);
  },45_000);
});
