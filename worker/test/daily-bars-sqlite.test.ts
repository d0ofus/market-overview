import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshDailyBarsIncremental } from "../src/daily-bars";
import { prepareStorageSourceFence } from "../src/market-storage-fence";
import type { DailyBar, MarketDataProvider } from "../src/provider";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

afterEach(() => { vi.restoreAllMocks(); });

describe("guarded legacy daily-bar writes", () => {
  it("skips unchanged rows before guards and invalidates only real changed-bar dates while metering triggers", async () => {
    const storage = createSqliteD1();
    try {
      storage.migrate("market-data-migrations");
      const bars: DailyBar[] = [
        { ticker: "AAA", date: "2026-06-01", o: 10, h: 11, l: 9, c: 10, volume: 100 },
        { ticker: "AAA", date: "2026-06-02", o: 10, h: 11, l: 9, c: 10, volume: 100 },
        { ticker: "BBB", date: "2026-06-02", o: 10, h: 11, l: 9, c: 10, volume: 100 },
      ];
      await storage.db.batch(bars.map((bar) => storage.db.prepare(`INSERT INTO alpaca_daily_bars
        (feed,ticker,date,o,h,l,c,volume) VALUES('sip',?,?,?,?,?,?,?)`)
        .bind(bar.ticker,bar.date,bar.o,bar.h,bar.l,bar.c,bar.volume)));
      storage.script(`INSERT INTO daily_market_features(feed,ticker,session_date,close)
        VALUES('sip','AAA','2026-06-01',10),('sip','AAA','2026-06-02',10),('sip','BBB','2026-06-02',10);`);
      const fence = await prepareStorageSourceFence(storage.db);
      storage.script(fence.statements.map((statement) => statement.sql).join("\n"));
      const env = { DB: storage.db, MARKET_DATA_DB: storage.db, DATA_PROVIDER: "alpaca", ALPACA_DAILY_FEED: "sip" } as Env;
      const provider: MarketDataProvider = { label: "fixture", getDailyBars: vi.fn(async () => bars) };
      const batch = vi.spyOn(storage.db, "batch");
      const input = { tickers: ["AAA", "BBB"], startDate: "2026-06-01", endDate: "2026-06-02", provider, replaceExisting: true };
      expect(await refreshDailyBarsIncremental(env, input)).toMatchObject({ fetchedRows: 3, writtenRows: 0 });
      const unchanged = await batch.mock.results[0]!.value as D1Result[];
      expect(unchanged).toHaveLength(3);
      expect(unchanged.every((result) => result.results.length === 0 && result.meta.changes === 0 && result.meta.rows_written === 0)).toBe(true);
      expect(await storage.db.prepare("SELECT revision FROM market_storage_fence WHERE id='default'").first("revision")).toBe(0);
      expect(await storage.db.prepare("SELECT COUNT(*) AS count FROM daily_market_features").first("count")).toBe(3);

      batch.mockClear();
      bars[1] = { ...bars[1]!, c: 10.5 };
      expect(await refreshDailyBarsIncremental(env, input)).toMatchObject({ fetchedRows: 3, writtenRows: 1 });
      const writes = await batch.mock.results[0]!.value as D1Result[];
      expect(writes.flatMap((result) => result.results)).toEqual([{ ticker: "AAA", date: "2026-06-02" }]);
      expect(writes[1]!.meta.changes).toBeGreaterThan(1);
      expect(writes[1]!.meta.rows_written).toBeGreaterThan(1);
      const retained = await storage.db.prepare("SELECT ticker,session_date FROM daily_market_features ORDER BY ticker,session_date").all();
      expect(retained.results).toEqual([{ ticker: "AAA", session_date: "2026-06-01" }, { ticker: "BBB", session_date: "2026-06-02" }]);
      const invalidation = await batch.mock.results[1]!.value as D1Result[];
      const totalWrites = [...writes,...invalidation].reduce((sum, result) => sum + result.meta.rows_written, 0);
      expect(await storage.db.prepare("SELECT bars_written,rows_written FROM market_data_daily_usage").first())
        .toEqual({ bars_written: 1, rows_written: totalWrites });
    } finally { storage.dispose(); }
  }, 30_000);
});
