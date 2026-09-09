import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveMarketHistoryBars, loadMarketHistory, loadVerifiedArchivedMarketHistory, type MarketHistoryBar } from "../src/market-history";
import { archiveAndPruneMarketHistory, cleanupUnpointedHistoryBlocks, MARKET_HISTORY_REQUIRED_CONSUMERS } from "../src/eod-history-maintenance";
import { computeAndStoreDailyMarketFeatures, loadDailyMarketFeatures } from "../src/daily-market-features";
import { buildEodCatalogRow, encodeEodCatalogPayload, EOD_CATALOG_METHODOLOGY_VERSION } from "../src/eod-catalog-service";
import { eodHash } from "../src/eod-publication-service";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("history archive and retention against real SQLite", { timeout: 20_000 }, () => {
  let market: ReturnType<typeof createSqliteD1>;
  let archive: ReturnType<typeof createSqliteD1>;
  let ops: ReturnType<typeof createSqliteD1>;
  let env: Env;
  const now = new Date("2026-09-08T00:00:00Z");
  const evidence = {
    capacity: { measuredAt: now.toISOString(), marketDatabaseBytes: 371_000_000, priceTableAndIndexBytes: 330_000_000,
      priceRows: 2_000_000, retainedPriceRows: 1_539_200, archiveDatabaseBytes: 10_000_000, additionalArchiveBytes: 130_000_000 },
    readers: { contractVersion: 1, checkedAt: now.toISOString(), parityPassed: true, consumers: [...MARKET_HISTORY_REQUIRED_CONSUMERS] },
    now,
  };
  const rows: MarketHistoryBar[] = Array.from({ length: 300 }, (_, index) => ({
    ticker: "AAA", date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    feed: "sip", o: 10 + index, h: 11 + index, l: 9 + index, c: 10.5 + index,
    volume: index % 2 ? null : 100.5, reportedVolume: index % 3 ? null : 9876.5, reportedVolumeCollectedAt: "2026-09-08T00:00:00Z",
    sourceProvider: "alpaca", adjustment: "split", observedAt: "2026-09-01T00:00:00Z", fetchedAt: "2026-09-08T00:00:00Z",
  }));
  async function publishCatalog() {
    const revision = await market.db.prepare("SELECT revision FROM eod_input_revisions WHERE feed='sip' AND ticker='AAA'").first<{revision:number}>();
    const payload = encodeEodCatalogPayload(rows.at(-1)!.date, [buildEodCatalogRow("AAA", rows, revision!.revision)]);
    await market.db.prepare(`INSERT INTO eod_publications(id,scope,session_date,revision,input_hash,methodology_version,
      payload_json,payload_checksum,payload_codec,status,created_at)
      VALUES(?,'history:catalog',?,?,?, ?,?,?,'json','accepted',?)`)
      .bind(`catalog-${revision!.revision}`, rows.at(-1)!.date, revision!.revision, `catalog-${revision!.revision}`,
        EOD_CATALOG_METHODOLOGY_VERSION, JSON.stringify(payload), await eodHash(payload), now.toISOString()).run();
  }
  beforeEach(async () => {
    market = createSqliteD1(); archive = createSqliteD1(); ops = createSqliteD1();
    market.migrate("market-data-migrations"); archive.migrate("history-migrations"); ops.migrate("ops-migrations");
    env = { DB: market.db, MARKET_DATA_DB: market.db, MARKET_HISTORY_DB: archive.db, OPS_DB: ops.db,
      EOD_RUNNER_MODE: "shadow", EOD_ARCHIVE_PRUNE_ENABLED: "true", ALPACA_DAILY_FEED: "sip", ALPACA_DAILY_ADJUSTMENT: "split" } as Env;
    await market.db.batch(rows.map((bar) => market.db.prepare(`INSERT INTO alpaca_daily_bars
      (feed,ticker,date,o,h,l,c,volume,reported_volume,source_provider,adjustment,observed_at,fetched_at,reported_volume_collected_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(bar.feed,bar.ticker,bar.date,bar.o,bar.h,bar.l,bar.c,bar.volume,
        bar.reportedVolume,bar.sourceProvider,bar.adjustment,bar.observedAt,bar.fetchedAt,bar.reportedVolumeCollectedAt)));
    await publishCatalog();
  }, 30_000);
  afterEach(() => { market.dispose(); archive.dispose(); ops.dispose(); });

  it("archives before bounded retirement and exactly preserves MAX,520 and260 reads after hot pruning", async () => {
    const first = await archiveAndPruneMarketHistory(env, { tickers: ["AAA"], endDate: rows.at(-1)!.date, maxRows: 20, ...evidence });
    expect(first).toMatchObject({ status: "partial", archivedRows: 20, deletedRows: 20 });
    const second = await archiveAndPruneMarketHistory(env, { tickers: ["AAA"], endDate: rows.at(-1)!.date, cursor: first.cursor!, ...evidence });
    expect(second).toMatchObject({ status: "complete", archivedRows: 20, deletedRows: 20 });
    expect(await market.db.prepare("SELECT COUNT(*) as count FROM alpaca_daily_bars").first()).toEqual({ count: 260 });
    expect(await loadMarketHistory(env, { tickers: ["AAA"] })).toEqual(rows);
    expect(await loadMarketHistory(env, { tickers: ["AAA"], limitPerTicker: 520 })).toEqual(rows);
    expect(await loadMarketHistory(env, { tickers: ["AAA"], limitPerTicker: 260 })).toEqual(rows.slice(-260));
    expect(await loadVerifiedArchivedMarketHistory(env, { tickers: ["AAA"] })).toEqual(rows.slice(0, 40));
    expect(await market.db.prepare("SELECT revision FROM eod_input_revisions WHERE ticker='AAA'").first()).toEqual({ revision: 300 });
    expect(await market.db.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first()).toEqual({ revision: 300 });
    expect(await market.db.prepare("SELECT COUNT(*) as count FROM eod_history_relocations").first()).toEqual({ count: 0 });
  });

  it("relocates Yahoo fallback history to 90 hot rows without changing provenance or correction clocks", async () => {
    await market.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume,reported_volume,source_provider,adjustment,observed_at,fetched_at)
      SELECT 'yahoo-eod',ticker,date,o,h,l,c,volume,NULL,'yahoo','split',observed_at,fetched_at FROM alpaca_daily_bars
      WHERE feed='sip' AND date>=?`).bind(rows.at(-91)!.date).run();
    const before = await loadMarketHistory(env, { tickers: ["AAA"], feed: "yahoo-eod" });
    const clock = await market.db.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first();
    expect(await archiveAndPruneMarketHistory(env, { tickers: ["AAA"], endDate: rows.at(-1)!.date,
      hotSessions: 90, feed: "yahoo-eod", maxRows: 1, ...evidence })).toMatchObject({ deletedRows: 1, archivedRows: 1 });
    expect(await market.db.prepare("SELECT COUNT(*) AS count FROM alpaca_daily_bars WHERE feed='yahoo-eod'").first()).toEqual({ count: 90 });
    expect(await market.db.prepare("SELECT COUNT(*) AS count FROM alpaca_daily_bars WHERE feed='sip'").first()).toEqual({ count: 300 });
    const after = await loadMarketHistory(env, { tickers: ["AAA"], feed: "yahoo-eod" });
    expect(after.map((row) => [row.date, row.c, row.volume, row.sourceProvider, row.reportedVolume]))
      .toEqual(before.map((row) => [row.date, row.c, row.volume, row.sourceProvider, row.reportedVolume]));
    expect(await market.db.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first()).toEqual(clock);
    expect(await market.db.prepare("SELECT revision FROM eod_input_revisions WHERE feed='yahoo-eod' AND ticker='AAA'").first()).toEqual({ revision: 91 });
  });

  it("keeps Yahoo hot observations when an adjustment repair is pending or begins before the relocation transaction", async () => {
    await market.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume,source_provider,adjustment,observed_at,fetched_at)
      SELECT 'yahoo-eod',ticker,date,o,h,l,c,volume,'yahoo','split',observed_at,fetched_at FROM alpaca_daily_bars
      WHERE feed='sip' AND date>=?`).bind(rows.at(-91)!.date).run();
    await market.db.prepare("INSERT INTO eod_adjustment_repairs(feed,ticker,status,owner_token,start_date,updated_at) VALUES('yahoo-eod','AAA','pending','other','2025-01-01','2026-09-08T00:00:00Z')").run();
    await expect(archiveAndPruneMarketHistory(env, { tickers: ["AAA"], endDate: rows.at(-1)!.date,
      hotSessions: 90, feed: "yahoo-eod", maxRows: 1, ...evidence })).rejects.toThrow("adjustment repair is pending");
    await market.db.prepare("UPDATE eod_adjustment_repairs SET status='complete',owner_token=NULL WHERE feed='yahoo-eod'").run();
    const wrapped = { prepare: market.db.prepare.bind(market.db), batch: async (statements: D1PreparedStatement[]) => {
      await market.db.prepare("UPDATE eod_adjustment_repairs SET status='pending',owner_token='raced' WHERE feed='yahoo-eod'").run();
      return market.db.batch(statements);
    } } as D1Database;
    const result = await archiveAndPruneMarketHistory({ ...env, MARKET_DATA_DB: wrapped }, { tickers: ["AAA"], endDate: rows.at(-1)!.date,
      hotSessions: 90, feed: "yahoo-eod", maxRows: 1, ...evidence });
    expect(result).toMatchObject({ archivedRows: 1, deletedRows: 0, concurrentCorrections: 1 });
    expect(await market.db.prepare("SELECT COUNT(*) AS count FROM alpaca_daily_bars WHERE feed='yahoo-eod'").first()).toEqual({ count: 91 });
  });

  it("keeps an independently corrected hot row when the archived value no longer matches", async () => {
    let corrected = false;
    const wrapped = { prepare: market.db.prepare.bind(market.db), batch: async (statements: D1PreparedStatement[]) => {
      if (!corrected) {
        corrected = true;
        await market.db.prepare("UPDATE alpaca_daily_bars SET c=10.75,reported_volume=9999 WHERE date=?").bind(rows[0].date).run();
      }
      return market.db.batch(statements);
    } } as D1Database;
    const result = await archiveAndPruneMarketHistory({ ...env, MARKET_DATA_DB: wrapped }, {
      tickers: ["AAA"], endDate: rows.at(-1)!.date, maxRows: 1, ...evidence,
    });
    expect(result).toMatchObject({ archivedRows: 1, deletedRows: 0, concurrentCorrections: 1 });
    expect(await market.db.prepare("SELECT c,reported_volume as reportedVolume FROM alpaca_daily_bars WHERE date=?").bind(rows[0].date).first())
      .toEqual({ c: 10.75, reportedVolume: 9999 });
    expect((await loadMarketHistory(env, { tickers: ["AAA"] }))[0].c).toBe(10.75);
    expect(await market.db.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first()).toEqual({ revision: 301 });
    expect(await market.db.prepare("SELECT COUNT(*) as count FROM eod_history_relocations").first()).toEqual({ count: 0 });
  });

  it.each(["missing", "candidate", "checksum", "changed-input"] as const)("defers pruning for a %s catalog", async (reason) => {
    if (reason === "missing") await market.db.prepare("DELETE FROM eod_publications").run();
    else if (reason === "candidate") await market.db.prepare("UPDATE eod_publications SET status='candidate'").run();
    else if (reason === "checksum") await market.db.prepare("UPDATE eod_publications SET payload_checksum='tampered'").run();
    else await market.db.prepare("UPDATE alpaca_daily_bars SET c=c+1 WHERE date=?").bind(rows.at(-1)!.date).run();
    await expect(archiveAndPruneMarketHistory(env, { tickers: ["AAA"], endDate: rows.at(-1)!.date, ...evidence }))
      .rejects.toThrow(/history-prune-deferred/);
    expect(await market.db.prepare("SELECT COUNT(*) as count FROM alpaca_daily_bars").first()).toEqual({ count: 300 });
    expect(await archive.db.prepare("SELECT COUNT(*) as count FROM market_history_blocks").first()).toEqual({ count: 0 });
  });

  it("does not let the neutral relocation option import absent or changed hot values", async () => {
    for (const bar of [{ ...rows[0], c: 999 }, { ...rows[0], date: "2024-01-02" }]) {
      await expect(archiveMarketHistoryBars(env, [bar], { verifiedHotRelocation: true })).rejects.toThrow(/changed before archiving/);
    }
    expect(await archive.db.prepare("SELECT COUNT(*) as count FROM market_history_blocks").first()).toEqual({ count: 0 });
    expect(await market.db.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first()).toEqual({ revision: 300 });
  });

  it("releases its own fence after a failed neutral archive copy so storage retry remains possible", async () => {
    const failingHistory = { prepare: archive.db.prepare.bind(archive.db), batch: async () => { throw new Error("simulated archive outage"); } } as unknown as D1Database;
    await expect(archiveMarketHistoryBars({ ...env, MARKET_HISTORY_DB: failingHistory }, [rows[0]], { verifiedHotRelocation: true }))
      .rejects.toThrow(/simulated archive outage/);
    expect(await market.db.prepare("SELECT status,owner_token FROM eod_adjustment_repairs WHERE feed='sip' AND ticker='AAA'").first())
      .toEqual({ status: "complete", owner_token: null });
    expect(await market.db.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first()).toEqual({ revision: 300 });
    expect(await market.db.prepare("SELECT COUNT(*) as count FROM alpaca_daily_bars").first()).toEqual({ count: 300 });
    expect((await archiveMarketHistoryBars(env, [rows[0]], { verifiedHotRelocation: true })).revisionChanges).toEqual([]);
  });

  it("requires a genuine archive repair to use ordinary revision-changing publication", async () => {
    await archiveMarketHistoryBars(env, [{ ...rows[0], c: 10.6 }]);
    await expect(archiveMarketHistoryBars(env, [rows[0]], { verifiedHotRelocation: true })).rejects.toThrow(/cannot repair conflicting archived prices/);
    expect((await loadVerifiedArchivedMarketHistory(env, { tickers: ["AAA"] }))[0].c).toBe(10.6);
    expect(await market.db.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first()).toEqual({ revision: 302 });
    await archiveMarketHistoryBars(env, [rows[0]]);
    expect(await market.db.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first()).toEqual({ revision: 304 });
    expect(await market.db.prepare(`SELECT semantic_revision,last_correction_revision,append_high_water_date,
      append_epoch_start_revision,append_epoch_start_date FROM eod_input_revisions WHERE feed='sip' AND ticker='AAA'`).first())
      .toEqual({ semantic_revision: 304, last_correction_revision: 304, append_high_water_date: rows.at(-1)!.date,
        append_epoch_start_revision: null, append_epoch_start_date: null });
  });

  it("rolls back hot deletion and transient markers if the final transaction statement fails", async () => {
    const wrapped = { prepare: market.db.prepare.bind(market.db), batch: async (statements: D1PreparedStatement[]) => {
      // The market transaction's third statement is marker cleanup; archive
      // publication uses the independent history database.
      return market.db.batch([...statements.slice(0, 2), market.db.prepare("INSERT INTO missing_test_table VALUES(1)")]);
    } } as D1Database;
    await expect(archiveAndPruneMarketHistory({ ...env, MARKET_DATA_DB: wrapped }, {
      tickers: ["AAA"], endDate: rows.at(-1)!.date, maxRows: 1, ...evidence,
    })).rejects.toThrow(/missing_test_table/);
    expect(await market.db.prepare("SELECT COUNT(*) as count FROM alpaca_daily_bars").first()).toEqual({ count: 300 });
    expect(await market.db.prepare("SELECT COUNT(*) as count FROM eod_history_relocations").first()).toEqual({ count: 0 });
    expect(await market.db.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first()).toEqual({ revision: 300 });
    // The archive copy was durably verified, so a retry can safely reuse it.
    expect(await loadVerifiedArchivedMarketHistory(env, { tickers: ["AAA"] })).toEqual([rows[0]]);
  });

  it("retains active and previous immutable revisions during bounded orphan cleanup", async () => {
    await archiveMarketHistoryBars(env, [rows[0]]);
    await archiveMarketHistoryBars(env, [{ ...rows[0], c: 10.6 }]);
    await archiveMarketHistoryBars(env, [{ ...rows[0], c: 10.7 }]);
    expect(await archive.db.prepare("SELECT COUNT(*) as count FROM market_history_blocks").first()).toEqual({ count: 2 });
    await archive.db.prepare("UPDATE market_history_blocks SET created_at='2020-01-01'").run();
    const result = await cleanupUnpointedHistoryBlocks(env, { now });
    expect(result.deletedBlocks).toBe(0);
    expect((await loadVerifiedArchivedMarketHistory(env, { tickers: ["AAA"] }))[0].c).toBe(10.7);
  });

  it("reuses unchanged verified observations during recheck and retirement without rewriting timestamp-only revisions", async () => {
    const original = { ...rows[0], fetchedAt: "2026-08-01T00:00:00Z", observedAt: "2026-08-01T00:00:00Z" };
    const first = await archiveMarketHistoryBars(env, [original]);
    const rechecked = await archiveMarketHistoryBars(env, [rows[0]]);
    expect(rechecked).toMatchObject({ rowsWritten: 0, revisionChanges: [] });
    expect(rechecked.blocks[0].id).toBe(first.blocks[0].id);
    await publishCatalog();
    const result = await archiveAndPruneMarketHistory(env, { tickers: ["AAA"], endDate: rows.at(-1)!.date, maxRows: 1, ...evidence });
    expect(result).toMatchObject({ archivedRows: 1, deletedRows: 1 });
    expect((await loadMarketHistory(env, { tickers: ["AAA"] }))[0]).toEqual(original);
    expect(await market.db.prepare("SELECT revision FROM eod_input_revisions WHERE ticker='AAA'").first()).toEqual({ revision: 302 });
  });

  it("fences pending adjustment repairs, preserves an outer owner's lock and bumps archive revisions", async () => {
    await market.db.prepare(`INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,updated_at,owner_token)
      VALUES('sip','AAA','pending','2025-01-01',?,'outer-repair')`).bind(now.toISOString()).run();
    await expect(loadMarketHistory(env, { tickers: ["AAA"] })).rejects.toThrow(/adjustment-repair-pending/);
    expect((await loadMarketHistory(env, { tickers: ["AAA"], allowPendingAdjustmentRepair: true })).length).toBe(300);
    await expect(archiveMarketHistoryBars(env, [rows[0]])).rejects.toThrow(/pending adjustment repair/);
    const result = await archiveMarketHistoryBars(env, [rows[0]], { repairFenceToken: "outer-repair" });
    expect(result.revisionChanges).toEqual([{ feed: "sip", ticker: "AAA", count: 2 }]);
    expect(await market.db.prepare("SELECT revision FROM eod_input_revisions WHERE ticker='AAA'").first()).toEqual({ revision: 302 });
    expect(await market.db.prepare("SELECT status,owner_token as owner FROM eod_adjustment_repairs WHERE ticker='AAA'").first())
      .toEqual({ status: "pending", owner: "outer-repair" });
  });

  it("keeps a full feature lookback with only38 retained calendar rows and invalidates cache after a manual correction", async () => {
    await market.db.batch(rows.slice(-38).map((bar) => market.db.prepare(`INSERT INTO market_calendar_sessions
      (session_date,open_at,close_at,source) VALUES(?,'09:30','16:00','test')`).bind(bar.date)));
    const session = rows.at(-1)!.date;
    const features = await computeAndStoreDailyMarketFeatures(env, ["AAA"], session);
    expect(features.get("AAA")?.sourceSessions).toBe(300);
    expect(features.get("AAA")?.inputRevision).toBe(300);
    expect((await loadDailyMarketFeatures(env, ["AAA"], session)).size).toBe(1);
    await market.db.prepare("UPDATE alpaca_daily_bars SET c=310 WHERE date=?").bind(session).run();
    expect((await loadDailyMarketFeatures(env, ["AAA"], session)).size).toBe(0);
    expect((await loadDailyMarketFeatures({ ...env, EOD_RUNNER_MODE: "disabled", EOD_READ_ENABLED: "true" }, ["AAA"], session)).size).toBe(0);
    const corrected = await computeAndStoreDailyMarketFeatures(env, ["AAA"], session);
    expect(corrected.get("AAA")?.close).toBe(310);
    expect(corrected.get("AAA")?.inputRevision).toBe(301);
  });

  it("does not store a feature against the wrong revision when a bar changes immediately before the write", async () => {
    let corrected = false;
    const wrapped = { prepare: market.db.prepare.bind(market.db), batch: async (statements: D1PreparedStatement[]) => {
      if (!corrected) {
        corrected = true;
        await market.db.prepare("UPDATE alpaca_daily_bars SET c=310 WHERE date=?").bind(rows.at(-1)!.date).run();
      }
      return market.db.batch(statements);
    } } as D1Database;
    await expect(computeAndStoreDailyMarketFeatures({ ...env, MARKET_DATA_DB: wrapped }, ["AAA"], rows.at(-1)!.date))
      .rejects.toThrow(/market-feature-inputs-changed/);
    expect(await market.db.prepare("SELECT COUNT(*) as count FROM daily_market_features").first()).toEqual({ count: 0 });
  });
});
