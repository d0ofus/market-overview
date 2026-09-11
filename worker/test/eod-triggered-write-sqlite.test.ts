import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyStorageArchiveBlock } from "../src/market-storage-copy";
import { prepareStorageSourceFence } from "../src/market-storage-fence";
import { archiveMarketHistoryBars, loadVerifiedArchivedMarketHistory, type MarketHistoryBar } from "../src/market-history";
import { repairEodSecurity } from "../src/eod-price-repair";
import { cleanupUnpointedHistoryBlocks } from "../src/eod-history-maintenance";
import { writeEodBars } from "../src/eod-bar-store";
import { createEodD1Database, type EodSql } from "../src/eod-d1-rest";
import type { EodPriceBar, EodPriceProvider } from "../src/eod-price-provider";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const bar = (close: number): MarketHistoryBar => ({ feed: "sip", ticker: "TEST", date: "2026-09-08",
  o: close, h: close, l: close, c: close, volume: null, reportedVolume: null,
  reportedVolumeCollectedAt: null, sourceProvider: "alpaca", adjustment: "split", observedAt: null, fetchedAt: null });

describe("business-row proof with D1 trigger-inclusive metadata", { timeout: 30_000 }, () => {
  let market: ReturnType<typeof createSqliteD1>, history: ReturnType<typeof createSqliteD1>, env: Env;
  beforeEach(async () => {
    market = createSqliteD1(); history = createSqliteD1();
    market.migrate("market-data-migrations"); history.migrate("history-migrations");
    for (const storage of [market, history]) {
      const plan = await prepareStorageSourceFence(storage.db);
      storage.script(plan.statements.map((statement) => statement.sql).join("\n"));
    }
    env = { DB: market.db, MARKET_DATA_DB: market.db, MARKET_HISTORY_DB: history.db,
      EOD_RUNNER_MODE: "shadow", ALPACA_DAILY_FEED: "sip", ALPACA_DAILY_ADJUSTMENT: "split" } as Env;
  });
  afterEach(() => { market.dispose(); history.dispose(); });

  it("filters an unchanged overlap before BEFORE INSERT triggers while retaining real corrections", async () => {
    const writes: number[] = [];
    const databaseId = "00000000-0000-4000-8000-000000000001";
    const database = createEodD1Database({ accountId: "a".repeat(32), databaseId, allowedDatabaseIds: [databaseId], token: "test-only",
      fetcher: async (_url, init) => {
        const query = JSON.parse(String(init?.body)) as EodSql;
        const result = await market.db.prepare(query.sql).bind(...query.params).all();
        writes.push(Number(result.meta.rows_written));
        return Response.json({ success: true, result: [result] });
      } });
    const measured = { ...env, MARKET_DATA_DB: database };
    const original = { ...bar(10), reportedVolume: null, fetchedAt: "2026-09-09T00:00:00Z" } as EodPriceBar;
    expect(await writeEodBars(measured, [original])).toEqual(new Map([["TEST", 1]]));
    expect(writes.at(-1)).toBeGreaterThan(0);
    const fence = await market.db.prepare("SELECT revision FROM market_storage_fence").first("revision");
    const clock = await market.db.prepare("SELECT revision FROM eod_input_clock").first("revision");
    expect(await writeEodBars(measured, [{ ...original, fetchedAt: "2026-09-11", observedAt: "2026-09-11",
      reportedVolumeCollectedAt: "2026-09-11" }])).toEqual(new Map());
    expect(writes.at(-1)).toBe(0);
    expect(await market.db.prepare("SELECT revision FROM market_storage_fence").first("revision")).toBe(fence);
    expect(await market.db.prepare("SELECT revision FROM eod_input_clock").first("revision")).toBe(clock);
    expect(await writeEodBars(measured, [{ ...original, c: 11, h: 11 }])).toEqual(new Map([["TEST", 1]]));
    expect(writes.at(-1)).toBeGreaterThan(0);
    expect(await market.db.prepare("SELECT c FROM alpaca_daily_bars WHERE feed='sip' AND ticker='TEST'").first("c")).toBe(11);
  });

  it("copies and corrects archives despite extra trigger changes, retaining verified revisions", async () => {
    const initial = await copyStorageArchiveBlock(history.db, [bar(10)]);
    const corrected = await copyStorageArchiveBlock(history.db, [bar(11)]);
    expect(corrected.id).not.toBe(initial.id);
    expect(await copyStorageArchiveBlock(history.db, [bar(11)])).toEqual(corrected);
    expect(await history.db.prepare("SELECT COUNT(*) AS count FROM market_history_blocks").first("count")).toBe(2);
    const same = await history.db.prepare(`UPDATE market_history_block_pointers SET block_id=block_id
      WHERE feed='sip' AND ticker='TEST' AND calendar_year=2026 RETURNING block_id`).all<{ block_id: string }>();
    expect(same.meta.changes).toBe(2);
    expect(same.results).toEqual([{ block_id: corrected.id }]);
    await copyStorageArchiveBlock(history.db, [bar(12)]);
    await history.db.prepare("UPDATE market_history_blocks SET created_at='2020-01-01'").run();
    const cleaned = await cleanupUnpointedHistoryBlocks({ ...env, EOD_ARCHIVE_PRUNE_ENABLED: "true" }, {
      now: new Date("2026-09-11T00:00:00Z"),
    });
    expect(cleaned.deletedBlocks).toBe(1);
    expect(await history.db.prepare("SELECT COUNT(*) AS count FROM market_history_blocks").first("count")).toBe(2);
  });

  it("rejects a losing pointer UPSERT even when its INSERT guard reports one change", async () => {
    const original = await copyStorageArchiveBlock(history.db, [bar(10)]);
    const other = await copyStorageArchiveBlock(history.db, [bar(20)]);
    await history.db.prepare("UPDATE market_history_block_pointers SET block_id=? WHERE feed='sip' AND ticker='TEST'").bind(original.id).run();
    let casResult: D1Result<{ block_id: string }> | undefined;
    const raced = { prepare: history.db.prepare.bind(history.db), batch: async (statements: D1PreparedStatement[]) => {
      await history.db.prepare("UPDATE market_history_block_pointers SET block_id=? WHERE feed='sip' AND ticker='TEST'").bind(other.id).run();
      const results = await history.db.batch<{ block_id: string }>(statements);
      casResult = results[1];
      return results;
    } } as D1Database;
    await expect(copyStorageArchiveBlock(raced, [bar(30)])).rejects.toThrow("storage-archive-concurrent-change");
    expect(casResult).toMatchObject({ results: [], meta: { changes: 1 } });
    expect(await history.db.prepare("SELECT block_id FROM market_history_block_pointers WHERE feed='sip' AND ticker='TEST'").first("block_id")).toBe(other.id);
  });

  it("archives normal ingestion and closes its repair fence with retained revision guards", async () => {
    await archiveMarketHistoryBars(env, [bar(10)]);
    await archiveMarketHistoryBars(env, [bar(11)]);
    expect((await loadVerifiedArchivedMarketHistory(env, { tickers: ["TEST"], feed: "sip" }))[0].c).toBe(11);
    expect(await market.db.prepare("SELECT status,owner_token FROM eod_adjustment_repairs WHERE feed='sip' AND ticker='TEST'").first())
      .toEqual({ status: "complete", owner_token: null });
  });

  it("cannot acquire another owner's pending archive or SIP repair through a trigger-only change", async () => {
    await market.db.prepare(`INSERT INTO eod_adjustment_repairs(feed,ticker,status,start_date,updated_at,owner_token)
      VALUES('sip','TEST','pending','2026-09-08',?,'other-owner')`).bind(new Date().toISOString()).run();
    const before = await market.db.prepare("SELECT revision FROM market_storage_fence").first<number>("revision");
    await expect(archiveMarketHistoryBars(env, [bar(10)])).rejects.toThrow("already has a pending adjustment repair");
    const alpaca = vi.fn();
    await expect(repairEodSecurity(env, { alpaca } as unknown as EodPriceProvider, "TEST", "2026-09-08", "2026-01-01"))
      .rejects.toThrow("adjustment-repair-already-owned");
    expect(alpaca).not.toHaveBeenCalled();
    expect(await market.db.prepare("SELECT revision FROM market_storage_fence").first("revision")).toBe(before! + 2);
    expect(await market.db.prepare("SELECT owner_token FROM eod_adjustment_repairs WHERE feed='sip' AND ticker='TEST'").first("owner_token")).toBe("other-owner");
    expect(await history.db.prepare("SELECT COUNT(*) AS count FROM market_history_blocks").first("count")).toBe(0);
  });
});
