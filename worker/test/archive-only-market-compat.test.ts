import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeMarketHistoryBlock, loadMarketHistory, type MarketHistoryBar } from "../src/market-history";
import { loadMarketHistoryLatestDates } from "../src/market-history-metadata";
import { loadMarketDataTickersWithBarOnDate } from "../src/market-data-db";
import { buildEodCatalogRow, encodeEodCatalogPayload, EOD_CATALOG_METHODOLOGY_VERSION } from "../src/eod-catalog-service";
import { getStoredHoldingStats } from "../src/eod-holdings-quotes";
import { loadCatalogSectorTrending } from "../src/sector-trending-service";
import { loadAlpacaBarMetrics } from "../src/overview-current-data";
import { isOverviewSnapshotStale } from "../src/overview-snapshot";
import { getStored1dStatsMap, loadTickersMissingBarHistory } from "../src/index";
import { refreshDailyBarsIncremental } from "../src/daily-bars";
import type { MarketDataProvider } from "../src/provider";
import { loadCanonicalPatternUniverseStats, type PatternProfile } from "../src/pattern-scanner-service";
import { loadDailyBarCoverage, loadScheduledRelativeStrengthUniverseCandidates } from "../src/scans-page-service";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("market migration with one hot session and older prices only in archive", () => {
  let market: ReturnType<typeof createSqliteD1>, archive: ReturnType<typeof createSqliteD1>;
  let env: Env;
  const session = "2026-09-08";
  const dates: string[] = [];
  for (let day = new Date(`${session}T00:00:00Z`); dates.length < 520; day.setUTCDate(day.getUTCDate() - 1)) {
    if (![0, 6].includes(day.getUTCDay()) && day.toISOString().slice(0, 10) !== "2026-09-07") dates.unshift(day.toISOString().slice(0, 10));
  }
  const bars = (ticker: string): MarketHistoryBar[] => dates.map((date, i) => ({ ticker, date, feed: "sip",
    o: 100 + i, h: 100 + i, l: 100 + i, c: 100 + i, volume: 100,
    sourceProvider: "alpaca", adjustment: "split", observedAt: `${date}T20:05:00Z`, fetchedAt: `${date}T20:05:00Z` }));
  async function archiveRows(rows: MarketHistoryBar[]) {
    const grouped = new Map<string, MarketHistoryBar[]>();
    for (const row of rows) { const key = `${row.ticker}:${row.date.slice(0, 4)}`; grouped.set(key, [...(grouped.get(key) ?? []), row]); }
    for (const rows of grouped.values()) {
      const block = await encodeMarketHistoryBlock(rows);
      await archive.db.prepare(`INSERT INTO market_history_blocks(id,feed,ticker,calendar_year,schema_version,codec,checksum,row_count,
        first_date,last_date,uncompressed_bytes,payload_base64,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(block.id,block.feed,block.ticker,block.calendarYear,block.schemaVersion,block.codec,block.checksum,block.rowCount,
          block.firstDate,block.lastDate,block.uncompressedBytes,block.payloadBase64,`${session}T21:00:00Z`).run();
      await archive.db.prepare(`INSERT INTO market_history_block_pointers(feed,ticker,calendar_year,block_id,updated_at) VALUES(?,?,?,?,?)`)
        .bind(block.feed,block.ticker,block.calendarYear,block.id,`${session}T21:00:00Z`).run();
    }
  }
  async function hotRows(rows: MarketHistoryBar[]) {
    await market.db.batch(rows.map((row) => market.db.prepare(`INSERT INTO alpaca_daily_bars
      (feed,ticker,date,o,h,l,c,volume,source_provider,adjustment,observed_at,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(row.feed,row.ticker,row.date,row.o,row.h,row.l,row.c,row.volume,row.sourceProvider,row.adjustment,row.observedAt,row.fetchedAt)));
  }
  async function publish(rows: MarketHistoryBar[], tickers: string[]) {
    const revisions = await market.db.prepare("SELECT ticker,revision FROM eod_input_revisions WHERE feed='sip'").all<{ticker:string;revision:number}>();
    const byTicker = new Map(revisions.results.map((row) => [row.ticker,row.revision]));
    const payload = encodeEodCatalogPayload(session, tickers.map((ticker) => buildEodCatalogRow(ticker, rows, byTicker.get(ticker) ?? 0)));
    await market.db.prepare(`INSERT INTO eod_publications(id,scope,session_date,revision,input_hash,methodology_version,payload_json,payload_codec,status,created_at)
      VALUES('catalog','history:catalog',?,1,'hash',?,?,'json','accepted',?)`)
      .bind(session,EOD_CATALOG_METHODOLOGY_VERSION,JSON.stringify(payload),`${session}T21:00:00Z`).run();
  }
  beforeEach(async () => {
    vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(new Date(`${session}T21:30:00Z`));
    market=createSqliteD1();archive=createSqliteD1();market.migrate("market-data-migrations");archive.migrate("history-migrations");
    env={DB:market.db,MARKET_DATA_DB:market.db,MARKET_HISTORY_DB:archive.db,EOD_READ_ENABLED:"true",ALPACA_DAILY_FEED:"sip"} as Env;
    await market.db.prepare(`INSERT INTO market_calendar_refresh_state(id,covered_start,covered_end,verified_at) VALUES('default',?,'2026-09-30',?)`)
      .bind(dates[0],`${session}T21:00:00Z`).run();
    await market.db.prepare(`INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source)
      SELECT value,'09:30','16:00','test-cached-calendar' FROM json_each(?)`).bind(JSON.stringify(dates)).run();
  },30_000);
  afterEach(() => {market.dispose();archive.dispose();vi.useRealTimers();});

  it("preserves MAX/520 history, overview metrics, exact archived dates and catalog prefilters", async () => {
    const source=bars("AAA");
    await archiveRows(source.slice(0,-1)); await hotRows(source.slice(-1)); await publish(source,["AAA"]);
    expect(await market.db.prepare("SELECT COUNT(*) AS count FROM alpaca_daily_bars").first()).toEqual({count:1});
    expect((await loadMarketHistory(env,{tickers:["AAA"]})).map((row) => row.c)).toEqual(source.map((row) => row.c));
    expect(await loadMarketHistory(env,{tickers:["AAA"],limitPerTicker:520})).toHaveLength(520);
    const archivedMetrics=(await loadAlpacaBarMetrics(env,["AAA"],session,"sip")).get("AAA");
    await hotRows(source.slice(0,-1));
    const legacyMetrics=(await loadAlpacaBarMetrics({...env,MARKET_HISTORY_DB:undefined},["AAA"],session,"sip")).get("AAA");
    expect(archivedMetrics).toEqual(legacyMetrics);
    expect(archivedMetrics).toMatchObject({status:"supported",price:619,above200Sma:true});
    // Revert the fixture to a new DB with just the current session, preserving
    // the copied input revision used by its immutable bootstrap catalog.
    await market.db.prepare("DELETE FROM alpaca_daily_bars WHERE date<>?").bind(session).run();
    await market.db.prepare("UPDATE eod_input_revisions SET revision=1,semantic_revision=1 WHERE ticker='AAA'").run();
    expect(await loadMarketDataTickersWithBarOnDate(env,["AAA","NONE"],dates[0])).toEqual(new Set(["AAA"]));
    expect((await loadMarketHistoryLatestDates(env,["AAA"],"sip")).get("AAA")).toBe(session);
    const profile={prefilterConfig:{minPrice:1,minDollarVolume20d:1,minBars:520}} as PatternProfile;
    expect(await loadCanonicalPatternUniverseStats(env,profile,session,["AAA"],null,null)).toEqual({count:1});
    expect((await loadDailyBarCoverage(env,["AAA"],session)).get("AAA")?.barCount).toBe(520);
    expect((await getStored1dStatsMap({...env,EOD_READ_ENABLED:"false"},["AAA"])).get("AAA")?.change1d).toBeCloseTo((619/618-1)*100);
    const core=createSqliteD1();
    try {
      core.script(`CREATE TABLE snapshots_meta(id TEXT,config_id TEXT,as_of_date TEXT,generated_at TEXT);
      CREATE TABLE snapshot_rows(snapshot_id TEXT,group_id TEXT,ticker TEXT,display_name TEXT,sparkline_json TEXT);
      CREATE TABLE dashboard_groups(id TEXT,section_id TEXT,title TEXT,show_sparkline INTEGER);
      CREATE TABLE dashboard_sections(id TEXT,config_id TEXT,title TEXT);
      CREATE TABLE etf_watchlists(ticker TEXT,fund_name TEXT,list_type TEXT,parent_sector TEXT,industry TEXT,sort_order INTEGER);
      INSERT INTO snapshots_meta VALUES('snapshot','default','2026-09-08','2026-09-08T21:00:00Z');
      INSERT INTO dashboard_sections VALUES('section','default','Macro');
      INSERT INTO dashboard_groups VALUES('group','section','Indices',1);`);
      await core.db.prepare("INSERT INTO snapshot_rows VALUES('snapshot','group','AAA','Company',?)")
        .bind(JSON.stringify(source.slice(-90).map((row) => row.c))).run();
      expect(await isOverviewSnapshotStale({...env,DB:core.db})).toBe(false);
    } finally {core.dispose();}
  },30_000);

  it("does not refetch an archived date or treat an archive-only security as never populated", async () => {
    const source=bars("OLD").slice(0,-1);
    await archiveRows(source);
    const provider={label:"test",getDailyBars:vi.fn()} as unknown as MarketDataProvider;
    const endDate=source.at(-1)!.date;
    expect((await loadMarketHistoryLatestDates(env,["OLD"],"sip")).get("OLD")).toBe(endDate);
    expect(await refreshDailyBarsIncremental(env,{tickers:["OLD"],startDate:dates[0],endDate,provider}))
      .toMatchObject({fetchedRows:0,writtenRows:0,skippedCurrentTickers:1,currentDateTickers:1,missingCurrentDateTickers:0});
    expect(provider.getDailyBars).not.toHaveBeenCalled();
    expect(await market.db.prepare("SELECT COUNT(*) AS count FROM alpaca_daily_bars").first()).toEqual({count:0});
  },30_000);

  it("preserves unavailable members while healthy scan and pattern metadata remains usable", async () => {
    const source=bars("AAA");
    await hotRows(source.slice(-1));
    const payload=encodeEodCatalogPayload(session,[buildEodCatalogRow("AAA",source,1),
      {ticker:"BNRG",sourceRevision:0,unavailableReason:"adjustment-repair-incomplete"}]);
    await market.db.prepare(`INSERT INTO eod_publications(id,scope,session_date,revision,input_hash,methodology_version,payload_json,payload_codec,status,created_at)
      VALUES('catalog','history:catalog',?,1,'hash',?,?,'json','accepted',?)`)
      .bind(session,EOD_CATALOG_METHODOLOGY_VERSION,JSON.stringify(payload),`${session}T21:00:00Z`).run();
    await market.db.prepare(`INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,updated_at,owner_token)
      VALUES('sip','BNRG','pending','2025-04-14',?,'unchanged-owner')`).bind(`${session}T21:00:00Z`).run();
    const profile={prefilterConfig:{minPrice:1,minDollarVolume20d:1,minBars:520}} as PatternProfile;
    expect(await loadCanonicalPatternUniverseStats(env,profile,session,["AAA","BNRG"],null,null)).toEqual({count:1});
    const coverage=await loadDailyBarCoverage(env,["AAA","BNRG"],session);
    expect([...coverage.keys()]).toEqual(["AAA"]);
    expect(coverage.get("AAA")?.barCount).toBe(520);
    expect(await loadTickersMissingBarHistory(env,["AAA","BNRG"],520)).toEqual(["BNRG"]);
    const core=createSqliteD1();
    try {
      core.script(`CREATE TABLE symbols(ticker TEXT,name TEXT,sector TEXT,industry TEXT,exchange TEXT,asset_class TEXT,shares_outstanding REAL);
        INSERT INTO symbols VALUES('AAA','Healthy company',NULL,NULL,'NYSE','equity',1000);
        INSERT INTO symbols VALUES('BNRG','Unavailable company',NULL,NULL,'NASDAQ','equity',1000);`);
      await market.db.prepare(`INSERT INTO post_close_daily_bar_refresh_job_items(job_id,ordinal,ticker,status,bar_date)
        VALUES('fixture',0,'AAA','completed',?),('fixture',1,'BNRG','completed',?)`).bind(session,session).run();
      const candidates=await loadScheduledRelativeStrengthUniverseCandidates({...env,DB:core.db,OPS_DB:market.db},"fixture",session);
      expect(candidates.map(row => row.ticker)).toEqual(["AAA","BNRG"]);
      expect(candidates[0]).toMatchObject({price:619,marketCap:619000});
      expect(candidates[1]).toMatchObject({price:null,change1d:null,marketCap:null,relativeVolume:null,avgVolume:null});
      expect(await market.db.prepare("SELECT status,owner_token FROM eod_adjustment_repairs WHERE ticker='BNRG'").first())
        .toEqual({status:"pending",owner_token:"unchanged-owner"});
    } finally {core.dispose();}
  },30_000);

  it("rejects mismatched or unsupported pointed manifests without reading archive bodies", async () => {
    await archiveRows(bars("AAA").slice(-1));
    const metadataOnly = { ...env, MARKET_HISTORY_DB: {
      prepare: (sql: string) => {
        if (sql.includes("payload_base64")) throw new Error("Latest-date planning must not open archive bodies");
        return archive.db.prepare(sql);
      },
    } as D1Database };
    expect((await loadMarketHistoryLatestDates(metadataOnly, ["AAA"], "sip")).get("AAA")).toBe(session);
    for (const [column, invalidValue, validValue] of [
      ["feed", "iex", "sip"], ["ticker", "OTHER", "AAA"], ["calendar_year", 2025, 2026],
      ["codec", "gzip-json-v2", "gzip-json-v1"], ["schema_version", 2, 1],
    ] as const) {
      // Column identifiers come only from this fixed fixture list. Bypass CHECK
      // constraints in this fixture connection to simulate an incompatible import.
      await archive.db.batch([
        archive.db.prepare("PRAGMA ignore_check_constraints=ON"),
        archive.db.prepare(`UPDATE market_history_blocks SET ${column}=?`).bind(invalidValue),
      ]);
      await expect(loadMarketHistoryLatestDates(metadataOnly, ["AAA"], "sip"))
        .rejects.toThrow("market-history-invalid-latest-date:AAA");
      await archive.db.prepare(`UPDATE market_history_blocks SET ${column}=?`).bind(validValue).run();
    }
    expect((await loadMarketHistoryLatestDates(metadataOnly, ["AAA"], "sip")).get("AAA")).toBe(session);
  }, 30_000);

  it("checks6000 hot-present current-session symbols without reading any archive payload", async () => {
    const tickers=Array.from({length:6_000},(_,i) => `T${String(i).padStart(4,"0")}`);
    await market.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume,source_provider,adjustment)
      SELECT 'sip',value,?,100,100,100,100,100,'alpaca','split' FROM json_each(?)`).bind(session,JSON.stringify(tickers)).run();
    const marketQueries:string[]=[], archiveQueries:string[]=[];
    const counted={...env,
      MARKET_DATA_DB:{prepare:(sql:string) => {marketQueries.push(sql);return market.db.prepare(sql);}} as D1Database,
      MARKET_HISTORY_DB:{prepare:(sql:string) => {
        archiveQueries.push(sql);if(sql.includes("payload_base64")) throw new Error("Hot-present date check must not open archive bodies");
        return archive.db.prepare(sql);
      }} as D1Database,
    };
    expect((await loadMarketDataTickersWithBarOnDate(counted,tickers,session)).size).toBe(6_000);
    expect(marketQueries).toHaveLength(6);expect(archiveQueries).toHaveLength(0);
    marketQueries.length=0;
    const provider={label:"test",getDailyBars:vi.fn()} as unknown as MarketDataProvider;
    expect(await refreshDailyBarsIncremental(counted,{tickers,startDate:dates[0],endDate:session,provider}))
      .toMatchObject({skippedCurrentTickers:6_000,currentDateTickers:6_000,fetchedRows:0,writtenRows:0});
    expect(provider.getDailyBars).not.toHaveBeenCalled();
    expect(marketQueries.length+archiveQueries.length).toBeLessThan(50);
    expect(archiveQueries.every((sql) => !sql.includes("payload_base64"))).toBe(true);
  },30_000);

  it("prices all105 holdings from catalog prior-date evidence with no archive payload reads", async () => {
    const tickers=Array.from({length:105},(_,i) => `T${i.toString().padStart(3,"0")}`);
    const source=tickers.flatMap((ticker) => bars(ticker).slice(-7));
    await hotRows(source.filter((row) => row.date===session)); await publish(source,tickers);
    env.MARKET_HISTORY_DB={prepare:() => {throw new Error("Holding quotes must not decompress archives");}} as unknown as D1Database;
    const result=await getStoredHoldingStats(env,[...tickers,"UNKNOWN"]);
    expect(result.size).toBe(106);
    expect(result.get("T104")).toMatchObject({lastPrice:619,barDate:session,source:"alpaca:sip:split"});
    expect(result.get("T104")?.change1d).toBeCloseTo((619/618-1)*100);
    expect(result.get("UNKNOWN")).toMatchObject({lastPrice:null,change1d:null});
    await market.db.prepare(`INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,updated_at)
      VALUES('sip','T104','pending',?,?)`).bind(dates[0],`${session}T21:00:00Z`).run();
    expect((await getStoredHoldingStats(env,tickers)).get("T104")?.lastPrice).toBeNull();
  },30_000);

  it("preserves sector ranking windows from compact metadata and refuses a missing supplement", async () => {
    const source=[...bars("AAA").slice(-8),...bars("IPO").slice(-2),...bars("OLD").slice(0,10)];
    await hotRows(source.filter((row) => row.date===session)); await publish(source,["AAA","IPO","OLD"]);
    env.MARKET_HISTORY_DB={prepare:() => {throw new Error("Sector ranking must not decompress archives");}} as unknown as D1Database;
    const symbols=[{ticker:"AAA",name:"Company",sector:"Industrials"},{ticker:"IPO",name:"New Company",sector:"Industrials"},
      {ticker:"OLD",name:"Old Company",sector:"Health Care"}];
    const result=await loadCatalogSectorTrending(env,symbols,30);
    expect(result.sectors).toHaveLength(1);
    expect(result.sectors[0]).toMatchObject({sector:"Industrials",symbolCount:2});
    expect(result.sectors[0].trend5d).toBeCloseTo((619/614-1)*100);
    expect(result.sectors[0].tickers.find((row) => row.ticker==="IPO")).toMatchObject({hasWindow:false,trend5d:0});
    await market.db.prepare("UPDATE eod_publications SET payload_json=json_remove(payload_json,'$.compatibility')").run();
    await expect(loadCatalogSectorTrending(env,symbols,30)).rejects.toThrow("metadata must be rebuilt");
  },30_000);
});
