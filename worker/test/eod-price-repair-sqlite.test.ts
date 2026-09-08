import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repairEodSecurity, repairEodYahoo } from "../src/eod-price-repair";
import { archiveMarketHistoryBars, loadMarketHistory, loadVerifiedArchivedMarketHistory } from "../src/market-history";
import { writeEodBars } from "../src/eod-bar-store";
import type { EodPriceBar, EodPriceProvider } from "../src/eod-price-provider";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("cross-database price repairs against real SQLite", { timeout: 20_000 }, () => {
  let market: ReturnType<typeof createSqliteD1>;
  let archive: ReturnType<typeof createSqliteD1>;
  let env: Env;
  const oldDate = "2024-01-02";
  const target = "2026-09-08";
  const hotStart = "2025-09-02";
  const bar = (date: string, close: number, feed = "sip"): EodPriceBar => ({
    ticker: "AAA", date, feed, o: close, h: close + 1, l: close - 1, c: close,
    volume: 1234, reportedVolume: 9876, sourceProvider: feed === "sip" ? "alpaca" : "yahoo",
    adjustment: "split", observedAt: null, fetchedAt: "2026-09-08T23:00:00Z",
  });
  beforeEach(async () => {
    market = createSqliteD1(); archive = createSqliteD1();
    market.migrate("market-data-migrations"); archive.migrate("history-migrations");
    // No provider credentials: calendar refresh cannot make a live request.
    env = { DB: market.db, MARKET_DATA_DB: market.db, MARKET_HISTORY_DB: archive.db,
      EOD_RUNNER_MODE: "shadow", ALPACA_DAILY_FEED: "sip", ALPACA_DAILY_ADJUSTMENT: "split" } as Env;
    await market.db.batch([oldDate, target].map((date) => market.db.prepare(`INSERT INTO market_calendar_sessions
      (session_date,open_at,close_at,source) VALUES(?,'09:30','16:00','test')`).bind(date)));
  }, 30_000);
  afterEach(() => { market.dispose(); archive.dispose(); vi.restoreAllMocks(); });

  it("repairs older retained hot rows and archived copies onto the same split basis", async () => {
    await writeEodBars(env, [bar(oldDate, 100), bar(target, 60)]);
    await archiveMarketHistoryBars(env, [bar(oldDate, 100)]);
    const corrected = [bar(oldDate, 50), bar(target, 60)];
    const alpaca = vi.fn(async (_tickers: string[], _start: string, _end: string, adjustment?: string) =>
      corrected.map((row) => ({ ...row, reportedVolume: adjustment === "raw" ? 8000 : null })));
    const provider = { alpaca } as unknown as EodPriceProvider;

    const result = await repairEodSecurity(env, provider, "AAA", target, hotStart);

    expect(alpaca.mock.calls[0].slice(0, 3)).toEqual([["AAA"], oldDate, target]);
    expect(result.bars.map((row) => row.date)).toEqual([target]);
    const hot = await market.db.prepare("SELECT c,reported_volume as volume FROM alpaca_daily_bars WHERE ticker='AAA' AND date=?").bind(oldDate).first();
    expect(hot).toEqual({ c: 50, volume: 8000 });
    expect((await loadVerifiedArchivedMarketHistory(env, { tickers: ["AAA"] })).map((row) => row.c)).toEqual([50, 60]);
    expect((await loadMarketHistory(env, { tickers: ["AAA"] })).map((row) => row.c)).toEqual([50, 60]);
    expect(await market.db.prepare("SELECT status,owner_token as owner FROM eod_adjustment_repairs WHERE feed='sip' AND ticker='AAA'").first())
      .toEqual({ status: "complete", owner: null });
    expect(result.revisions.filter((row) => row.feed === "sip").reduce((total, row) => total + row.count, 0)).toBe(6);
  });

  it("recovers an abandoned Yahoo fence by validating all retained dates before reopening reads", async () => {
    await archiveMarketHistoryBars(env, [bar(oldDate, 100, "yahoo-eod")]);
    await market.db.prepare("UPDATE eod_adjustment_repairs SET status='pending',owner_token='abandoned',updated_at='2020-01-01T00:00:00Z' WHERE feed='yahoo-eod'").run();
    await expect(loadMarketHistory(env, { tickers: ["AAA"], feed: "yahoo-eod" })).rejects.toThrow(/adjustment-repair-pending/);
    const yahoo = vi.fn(async () => [bar(oldDate, 50, "yahoo-eod"), bar(target, 60, "yahoo-eod")]);
    const result = await repairEodYahoo(env, { yahoo } as unknown as EodPriceProvider, "AAA", target, hotStart, []);
    expect(yahoo).toHaveBeenCalledWith("AAA", oldDate, target, []);
    expect(result.revisions).toEqual([{ feed: "yahoo-eod", ticker: "AAA", count: 4 }]);
    expect((await loadMarketHistory(env, { tickers: ["AAA"], feed: "yahoo-eod" })).map((row) => row.c)).toEqual([50, 60]);
    expect(await market.db.prepare("SELECT status,owner_token as owner FROM eod_adjustment_repairs WHERE feed='yahoo-eod' AND ticker='AAA'").first())
      .toEqual({ status: "complete", owner: null });
  });

  it("keeps the fence closed when recovery omits an existing archived date", async () => {
    await archiveMarketHistoryBars(env, [bar(oldDate, 100, "yahoo-eod")]);
    await market.db.prepare("UPDATE eod_adjustment_repairs SET status='pending',owner_token='abandoned',updated_at='2020-01-01T00:00:00Z' WHERE feed='yahoo-eod'").run();
    const provider = { yahoo: vi.fn(async () => [bar(target, 60, "yahoo-eod")]) } as unknown as EodPriceProvider;
    await expect(repairEodYahoo(env, provider, "AAA", target, hotStart, [])).rejects.toThrow("adjustment-repair-incomplete");
    const rollbackEnv = { ...env, EOD_RUNNER_MODE: "disabled", EOD_READ_ENABLED: "true" } as Env;
    await expect(loadMarketHistory(rollbackEnv, { tickers: ["AAA"], feed: "yahoo-eod" })).rejects.toThrow(/adjustment-repair-pending/);
    expect((await loadVerifiedArchivedMarketHistory(env, { tickers: ["AAA"], feed: "yahoo-eod" }))[0].c).toBe(100);
  });

  it("preserves raw volume when writers are disabled but validated readers remain enabled", async () => {
    await writeEodBars(env, [bar(target, 60)]);
    const rollbackEnv = { ...env, EOD_RUNNER_MODE: "disabled", EOD_READ_ENABLED: "true" } as Env;
    expect((await loadMarketHistory(rollbackEnv, { tickers: ["AAA"] }))[0].reportedVolume).toBe(9876);
  });
});
