import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeEodCatalogUnavailableTuple, buildEodCatalogRow, encodeEodCatalogPayload, EOD_CATALOG_METHODOLOGY_VERSION, loadEodCatalogRows, type EodCatalogRow, type EodCatalogCheckpointRow } from "../src/eod-catalog-service";
import { loadCanonicalPatternUniverseStats, type PatternProfile } from "../src/pattern-scanner-service";
import { loadDailyBarCoverage, loadScheduledRelativeStrengthUniverseCandidates } from "../src/scans-page-service";
import { archiveMarketHistoryBars, type MarketHistoryBar } from "../src/market-history";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { loadTickersMissingBarHistory } from "../src/index";

describe("compact full-history catalog metadata", () => {
  let storage: ReturnType<typeof createSqliteD1>;
  let env: Env;
  let queries: string[];
  const session = "2026-09-08";
  const profile = { prefilterConfig: { minPrice: 5, minDollarVolume20d: 1_000, minBars: 520 } } as PatternProfile;
  beforeEach(() => {
    storage = createSqliteD1(); storage.migrate("market-data-migrations");
    queries = [];
    const db = { prepare: (sql: string) => { queries.push(sql); return storage.db.prepare(sql); } } as D1Database;
    env = { DB: db, MARKET_DATA_DB: db, OPS_DB: db, EOD_READ_ENABLED: "true", ALPACA_DAILY_FEED: "sip",
      MARKET_HISTORY_DB: { prepare: () => { throw new Error("Catalog consumers must not open archive payloads"); } },
    } as unknown as Env;
  }, 30_000);
  afterEach(() => { storage?.dispose(); vi.useRealTimers(); });

  async function publish(rows: EodCatalogCheckpointRow[], status = "accepted", catalogSession = session) {
    const payload = encodeEodCatalogPayload(catalogSession, rows);
    await storage.db.prepare(`INSERT INTO eod_publications
      (id,scope,session_date,revision,input_hash,methodology_version,payload_json,payload_codec,status,created_at)
      VALUES(?,'history:catalog',?,1,'hash',?,?,'json',?,?)`)
      .bind(`catalog-${catalogSession}`, catalogSession, EOD_CATALOG_METHODOLOGY_VERSION, JSON.stringify(payload), status, `${catalogSession}T21:00:00Z`).run();
  }
  const row = (ticker: string): EodCatalogRow => ({ ticker, barCount: 800, firstDate: "2023-01-03", lastDate: session,
    price: 10, previousPrice: 8, volume: 500, avgVolume30d: 250, avgDollarVolume20d: 10_000, sourceRevision: 0 });
  async function insertBar(date: string, ticker = "ABC") {
    await storage.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume,source_provider,adjustment,fetched_at)
      VALUES('sip',?,?,10,10,10,10,100,'alpaca','split','2026-09-09T00:00:00Z')`).bind(ticker, date).run();
  }
  async function revision(ticker = "ABC") {
    return (await storage.db.prepare("SELECT revision FROM eod_input_revisions WHERE feed='sip' AND ticker=?")
      .bind(ticker).first<{ revision: number }>())!.revision;
  }

  it("builds exact retained counts and original observed-bar windows without raw/IEX/Yahoo contamination", () => {
    const bars: MarketHistoryBar[] = Array.from({ length: 800 }, (_, index) => ({
      ticker: "ABC", date: new Date(Date.UTC(2023, 0, index + 1)).toISOString().slice(0, 10),
      o: 10, h: 10, l: 10, c: 10, volume: index === 799 ? null : 100,
      feed: "sip", sourceProvider: "alpaca", adjustment: "split", observedAt: null, fetchedAt: null,
    }));
    const metadata = buildEodCatalogRow("abc", [...bars, { ...bars[0], feed: "iex" },
      { ...bars[0], adjustment: "raw" }, { ...bars[0], sourceProvider: "yahoo" }], 7);
    expect(metadata).toMatchObject({ ticker: "ABC", barCount: 800, sourceRevision: 7, price: 10,
      previousPrice: 10, volume: null, avgDollarVolume20d: 950, avgVolume30d: 100 });
    expect(buildEodCatalogRow("NONE", bars, 0)).toMatchObject({ barCount: 0, firstDate: null, lastDate: null, price: null });
    expect(encodeEodCatalogPayload(session, [metadata]).rows[0]).toHaveLength(10);
  });

  it("encodes unknown retained history explicitly and never revives a quarantined catalog after its fence clears",async()=>{
    const missing={ticker:"BNRG",sourceRevision:0,unavailableReason:"adjustment-repair-incomplete" as const};
    const payload=encodeEodCatalogPayload(session,[row("ABC"),missing]);
    expect(payload.rows[1]).toEqual(["BNRG",null,null,null,null,null,0,null,null,null,"adjustment-repair-incomplete"]);
    expect(decodeEodCatalogUnavailableTuple(payload.rows[1])).toEqual(missing);
    expect(decodeEodCatalogUnavailableTuple(payload.rows[0])).toBeNull();
    expect(()=>decodeEodCatalogUnavailableTuple([...payload.rows[1],"extra"])).toThrow("invalid unavailable");
    expect(()=>decodeEodCatalogUnavailableTuple(["BNRG",0,null,null,null,null,0,null,null,null,"adjustment-repair-incomplete"])).toThrow("invalid unavailable");
    await publish([row("ABC"),missing]);
    await storage.db.prepare("INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,updated_at) VALUES('sip','BNRG','pending','2025-04-14','2026-09-08T20:00:00Z')").run();
    await expect(loadEodCatalogRows(env,["ABC","BNRG"],session)).rejects.toThrow("retained history is quarantined");
    expect([...(await loadEodCatalogRows(env,["ABC","BNRG"],session,{unavailableRows:"omit"})).keys()]).toEqual(["ABC"]);
    await storage.db.prepare("UPDATE eod_adjustment_repairs SET status='complete' WHERE ticker='BNRG'").run();
    await expect(loadEodCatalogRows(env,["BNRG"],session)).rejects.toThrow("retained history is quarantined");
    expect((await loadEodCatalogRows(env,["BNRG"],session,{unavailableRows:"omit"})).size).toBe(0);
  });

  it("keeps healthy catalog payloads byte-identical without unavailable metadata",()=>{
    const actual=buildEodCatalogRow("ABC",[],7);
    const expected={schemaVersion:1,sessionDate:session,methodologyVersion:EOD_CATALOG_METHODOLOGY_VERSION,
      rows:[["ABC",0,null,null,null,null,7,null,null,null]],compatibility:{schemaVersion:1,rows:[["ABC",null,null,null]]}};
    expect(JSON.stringify(encodeEodCatalogPayload(session,[actual]))).toBe(JSON.stringify(expected));
  });

  it("prefilters all6000 securities and preserves800-bar counts with bounded SQL and no history decompression", async () => {
    const rows = Array.from({ length: 6_000 }, (_, index) => row(`T${String(index).padStart(4, "0")}`));
    rows[0].barCount = 519;
    rows[1].price = 1;
    rows[5_999] = buildEodCatalogRow("T5999", [], 0);
    await publish(rows);
    const tickers = rows.map((item) => item.ticker);
    const count = await loadCanonicalPatternUniverseStats(env, profile, session, tickers, null, null);
    expect(count).toEqual({ count: 5_997 });
    expect(queries).toHaveLength(1);
    queries = [];
    const page = await loadCanonicalPatternUniverseStats(env, profile, session, tickers, 1, 40);
    expect(Array.isArray(page) && page.length).toBe(40);
    expect(Array.isArray(page) && page[0]).toMatchObject({ ticker: "T0003", barCount: 800 });
    expect(queries).toHaveLength(1);

    storage.script(`CREATE TABLE symbols(ticker TEXT PRIMARY KEY,name TEXT,sector TEXT,industry TEXT,exchange TEXT,asset_class TEXT,shares_outstanding REAL);`);
    await storage.db.prepare(`INSERT INTO symbols(ticker,name,exchange,asset_class,shares_outstanding)
      SELECT value,value,'NASDAQ','equity',1000000 FROM json_each(?)`).bind(JSON.stringify(tickers)).run();
    await storage.db.prepare(`INSERT INTO post_close_daily_bar_refresh_job_items(job_id,ordinal,ticker,status,bar_date)
      SELECT 'job',CAST(key AS INTEGER),value,'completed',? FROM json_each(?)`).bind(session, JSON.stringify(tickers)).run();
    queries = [];
    const candidates = await loadScheduledRelativeStrengthUniverseCandidates(env, "job", session);
    expect(candidates).toHaveLength(6_000);
    expect(candidates[2]).toMatchObject({ ticker: "T0002", price: 10, avgVolume: 250, relativeVolume: 2, change1d: 25 });
    expect(candidates.at(-1)?.price).toBeNull();
    expect(queries).toHaveLength(3);
    queries = [];
    const coverage = await loadDailyBarCoverage(env, tickers, session);
    expect(coverage.get("T0002")?.barCount).toBe(800);
    expect(coverage.has("T5999")).toBe(false);
    expect(queries).toHaveLength(1);
    expect(queries.some((sql) => /alpaca_daily_bars|market_history_blocks/.test(sql))).toBe(false);
  }, 30_000);

  it("fails visibly for absent sessions/tickers, revised inputs, and pending adjustment repair", async () => {
    await expect(loadEodCatalogRows(env, ["ABC"], session)).rejects.toThrow("no accepted");
    await publish([row("ABC")]);
    await expect(loadEodCatalogRows(env, ["ABC"], "2026-09-04")).rejects.toThrow("no accepted");
    await expect(loadEodCatalogRows(env, ["OTHER"], session)).rejects.toThrow("not included");
    await storage.db.prepare("INSERT INTO eod_input_revisions(feed,ticker,revision) VALUES('sip','ABC',1)").run();
    await expect(loadEodCatalogRows(env, ["ABC"], session)).rejects.toThrow("input revision changed");
    await storage.db.prepare("UPDATE eod_input_revisions SET revision=0 WHERE ticker='ABC'").run();
    await storage.db.prepare("INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,updated_at) VALUES('sip','ABC','pending','2023-01-01','2026-09-08T21:00:00Z')").run();
    await expect(loadEodCatalogRows(env, ["ABC"], session)).rejects.toThrow("repair is pending");
  }, 30_000);

  it("does not activate archive prefilters merely because the binding is provisioned", async () => {
    env.EOD_READ_ENABLED = "false";
    await storage.db.prepare("INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume) VALUES('sip','ABC',?,10,10,10,10,100)").bind(session).run();
    expect(await loadCanonicalPatternUniverseStats(env, { prefilterConfig: { minPrice: 5, minDollarVolume20d: 500, minBars: 1 } } as PatternProfile,
      session, ["ABC"], null, null)).toEqual({ count: 1 });
    expect(queries.some((sql) => sql.includes("eod_publications"))).toBe(false);
    expect((await loadDailyBarCoverage(env, ["ABC"], session)).get("ABC")?.barCount).toBe(1);
  }, 30_000);

  it("preserves historical catalogs across future append sessions but keeps the latest catalog strict", async () => {
    await insertBar("2026-09-04"); await insertBar(session);
    const oldRevision = await revision();
    await publish([{ ...row("ABC"), sourceRevision: oldRevision }]);
    await insertBar("2026-09-09");
    await expect(loadEodCatalogRows(env, ["ABC"], session)).rejects.toThrow("input revision changed");
    await publish([{ ...row("ABC"), sourceRevision: await revision(), lastDate: "2026-09-09" }], "accepted", "2026-09-09");
    queries = [];
    expect((await loadEodCatalogRows(env, ["ABC"], session)).get("ABC"))
      .toMatchObject({ sourceRevision: oldRevision, lastDate: session, price: 10 });
    expect(queries).toHaveLength(1);
    await insertBar("2026-09-10");
    expect((await loadEodCatalogRows(env, ["ABC"], session)).size).toBe(1);
    await expect(loadEodCatalogRows(env, ["ABC"], "2026-09-09")).rejects.toThrow("input revision changed");
    await storage.db.prepare("UPDATE alpaca_daily_bars SET c=11 WHERE date='2026-09-04'").run();
    await expect(loadEodCatalogRows(env, ["ABC"], session)).rejects.toThrow("input revision changed");
  }, 30_000);

  it("does not mistake a monotonic append inside a lagging catalog session for a harmless future append", async () => {
    await insertBar("2026-09-04");
    await publish([{ ...row("ABC"), lastDate: "2026-09-04", sourceRevision: await revision() }]);
    await insertBar("2026-09-05"); await insertBar("2026-09-09");
    await publish([{ ...row("ABC"), lastDate: "2026-09-09", sourceRevision: await revision() }], "accepted", "2026-09-09");
    await expect(loadEodCatalogRows(env, ["ABC"], session)).rejects.toThrow("input revision changed");
  }, 30_000);

  it("can prove an empty historical row survived an append epoch that starts strictly after its session", async () => {
    await publish([buildEodCatalogRow("ABC", [], 0)]);
    await insertBar("2026-09-09"); await insertBar("2026-09-10");
    await publish([{ ...row("ABC"), lastDate: "2026-09-10", sourceRevision: await revision() }], "accepted", "2026-09-10");
    expect((await loadEodCatalogRows(env, ["ABC"], session)).get("ABC")?.barCount).toBe(0);
  }, 30_000);

  it("treats unclassified revision advances and backfills as corrections, not append evidence", async () => {
    await insertBar(session);
    await publish([{ ...row("ABC"), sourceRevision: await revision() }]);
    await storage.db.prepare("UPDATE eod_input_revisions SET revision=revision+1 WHERE ticker='ABC'").run();
    await insertBar("2026-09-09");
    await publish([{ ...row("ABC"), lastDate: "2026-09-09", sourceRevision: await revision() }], "accepted", "2026-09-09");
    await expect(loadEodCatalogRows(env, ["ABC"], session)).rejects.toThrow("input revision changed");
    await insertBar("2026-09-03");
    const state = await storage.db.prepare(`SELECT revision,last_correction_revision as correction,
      append_epoch_start_revision as epoch FROM eod_input_revisions WHERE ticker='ABC'`).first();
    expect(state).toEqual({ revision: 4, correction: 4, epoch: null });
  }, 30_000);

  it("preserves exact archive relocation, rejects genuine archive corrections, and always respects repair fences", async () => {
    const archive = createSqliteD1(); archive.migrate("history-migrations");
    const archiveEnv = { ...env, MARKET_HISTORY_DB: archive.db, EOD_RUNNER_MODE: "shadow", EOD_ARCHIVE_PRUNE_ENABLED: "true" } as Env;
    try {
      await insertBar(session);
      const original: MarketHistoryBar = { ticker: "ABC", date: session, feed: "sip", o: 10, h: 10, l: 10,
        c: 10, volume: 100, sourceProvider: "alpaca", adjustment: "split", observedAt: null, fetchedAt: "2026-09-09T00:00:00Z" };
      await publish([{ ...row("ABC"), sourceRevision: await revision() }]);
      await archiveMarketHistoryBars(archiveEnv, [original], { verifiedHotRelocation: true });
      await insertBar("2026-09-09");
      await publish([{ ...row("ABC"), lastDate: "2026-09-09", sourceRevision: await revision() }], "accepted", "2026-09-09");
      expect((await loadEodCatalogRows(archiveEnv, ["ABC"], session)).size).toBe(1);
      await storage.db.prepare(`INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,updated_at,owner_token)
        VALUES('sip','ABC','pending',?,'2026-09-09T21:00:00Z','test') ON CONFLICT(feed,ticker) DO UPDATE SET status='pending',owner_token='test'`)
        .bind(session).run();
      await expect(loadEodCatalogRows(archiveEnv, ["ABC"], session)).rejects.toThrow("repair is pending");
      await storage.db.prepare("UPDATE eod_adjustment_repairs SET status='complete',owner_token=NULL WHERE ticker='ABC'").run();
      await archiveMarketHistoryBars(archiveEnv, [{ ...original, c: 11 }]);
      await expect(loadEodCatalogRows(archiveEnv, ["ABC"], session)).rejects.toThrow("input revision changed");
      const state = await storage.db.prepare(`SELECT revision,semantic_revision as semantic,last_correction_revision as correction,
        append_epoch_start_revision as epoch FROM eod_input_revisions WHERE ticker='ABC'`).first();
      expect(state).toEqual({ revision: 4, semantic: 4, correction: 4, epoch: null });
    } finally { archive.dispose(); }
  }, 30_000);

  it("checks overview history counts against the exact completed cached exchange session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-08T21:00:00Z"));
    storage.script(`INSERT INTO market_calendar_refresh_state(id,covered_start,covered_end,verified_at)
      VALUES('default','2026-09-01','2026-09-30','2026-09-08T20:00:00Z');
      INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source) VALUES
      ('2026-09-04','09:30','16:00','alpaca-calendar'),('2026-09-08','09:30','16:00','alpaca-calendar');`);
    await publish([row("ABC"), { ...row("SHORT"), barCount: 10 }]);
    expect(await loadTickersMissingBarHistory(env, ["abc", "SHORT", "ABC"], 520)).toEqual(["SHORT"]);
    expect(queries.some((sql) => sql.includes("alpaca_daily_bars"))).toBe(false);
    vi.setSystemTime(new Date("2026-09-08T19:00:00Z"));
    await expect(loadTickersMissingBarHistory(env, ["ABC"], 520)).rejects.toThrow("2026-09-04");
    await storage.db.prepare("DELETE FROM market_calendar_refresh_state").run();
    await expect(loadTickersMissingBarHistory(env, ["ABC"], 520)).rejects.toThrow("exchange session cannot be verified");
  }, 30_000);
});
