import { describe, expect, it, vi } from "vitest";
import { qualifyRetentionArchiveBatch } from "../src/eod-retention-qualification";
import { loadVerifiedArchivedMarketHistory, type MarketHistoryBar } from "../src/market-history";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import type { Env } from "../src/types";

describe("retention archive qualification with real SQLite", () => {
  it("copies current retained bars without deleting recent prices or changing input revisions", async () => {
    const storage = createSqliteD1();
    try {
      storage.migrate("market-data-migrations"); storage.migrate("history-migrations");
      const bars: MarketHistoryBar[] = ["AAA", "BBB"].map(ticker => ({ ticker, date: "2026-09-17", o: 10, h: 12, l: 9, c: 11,
        volume: 100, reportedVolume: 100, reportedVolumeCollectedAt: "2026-09-17T21:00:00Z", feed: "sip",
        sourceProvider: "alpaca", adjustment: "split", observedAt: "2026-09-17T20:00:00Z", fetchedAt: "2026-09-17T21:00:00Z" }));
      for (const bar of bars) await storage.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume,
        reported_volume,reported_volume_collected_at,source_provider,adjustment,observed_at,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(bar.feed, bar.ticker, bar.date, bar.o, bar.h, bar.l, bar.c, bar.volume, bar.reportedVolume,
          bar.reportedVolumeCollectedAt, bar.sourceProvider, bar.adjustment, bar.observedAt, bar.fetchedAt).run();
      const env = { DB: storage.db, MARKET_DATA_DB: storage.db, MARKET_HISTORY_DB: storage.db,
        EOD_RUNNER_MODE: "active", EOD_READ_ENABLED: "true", EOD_ARCHIVE_PRUNE_ENABLED: "true" } as Env;
      const revision = await storage.db.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<number>("revision");
      const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider access forbidden"));
      try {
        expect(await qualifyRetentionArchiveBatch(env, bars)).toEqual({ verifiedBars: 2, archiveWrites: 2 });
        expect(await qualifyRetentionArchiveBatch(env, bars)).toEqual({ verifiedBars: 2, archiveWrites: 0 });
        expect(fetcher).not.toHaveBeenCalled();
      } finally { fetcher.mockRestore(); }
      expect(await storage.db.prepare("SELECT COUNT(*) AS count FROM alpaca_daily_bars").first<number>("count")).toBe(2);
      expect(await storage.db.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<number>("revision")).toBe(revision);
      expect(await loadVerifiedArchivedMarketHistory(env, { tickers: ["AAA", "BBB"], feed: "sip", startDate: "2026-09-17", endDate: "2026-09-17" })).toEqual(bars);
    } finally { storage.dispose(); }
  }, 30_000);
});
