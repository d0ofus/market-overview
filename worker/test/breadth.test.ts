import { describe, expect, it } from "vitest";
import { computeAndStoreBreadth } from "../src/eod";
import { computeBreadthStats } from "../src/metrics";
import type { DailyBar } from "../src/provider";

function createBreadthEnv(tickers: string[], bars: DailyBar[]) {
  const snapshots = new Map<string, unknown[]>();
  const deletedIds: string[] = [];
  const normalizedTickers = tickers.map((ticker) => ticker.toUpperCase());
  const normalizedBars = bars.map((bar) => ({ ...bar, ticker: bar.ticker.toUpperCase() }));

  const env = {
    DB: {
      prepare(sql: string) {
        const makeBound = (args: unknown[]) => ({
          async all<T>() {
            if (sql.includes("SELECT ticker FROM universe_symbols")) {
              return { results: normalizedTickers.map((ticker) => ({ ticker })) as T[] };
            }
            if (sql.includes("SELECT ticker, date, c, volume FROM daily_bars")) {
              const asOfDate = String(args.at(-1));
              const requested = new Set(args.slice(0, -1).map((arg) => String(arg).toUpperCase()));
              return {
                results: normalizedBars
                  .filter((bar) => requested.has(bar.ticker) && bar.date <= asOfDate)
                  .sort((left, right) => left.ticker.localeCompare(right.ticker) || left.date.localeCompare(right.date))
                  .map((bar) => ({ ticker: bar.ticker, date: bar.date, c: bar.c, volume: bar.volume })) as T[],
              };
            }
            return { results: [] as T[] };
          },
          async run() {
            if (sql.includes("DELETE FROM breadth_snapshots")) {
              deletedIds.push(String(args[0]));
            }
            if (sql.includes("INSERT OR REPLACE INTO breadth_snapshots")) {
              snapshots.set(String(args[0]), args);
            }
            return {};
          },
        });
        return {
          bind(...args: unknown[]) {
            return makeBound(args);
          },
          async all<T>() {
            return makeBound([]).all<T>();
          },
          async run() {
            return makeBound([]).run();
          },
        };
      },
    },
  } as any;

  return { env, snapshots, deletedIds };
}

function twoDayBar(ticker: string, currentDate = "2026-06-02"): DailyBar[] {
  return [
    { ticker, date: "2026-06-01", o: 10, h: 11, l: 9, c: 10, volume: 1_000 },
    { ticker, date: currentDate, o: 10, h: 12, l: 9, c: 11, volume: 1_100 },
  ];
}

describe("breadth computations", () => {
  it("computes breadth aggregates", () => {
    const stats = computeBreadthStats({
      AAA: { closes: Array.from({ length: 260 }, (_, i) => 100 + i), volumes: Array.from({ length: 260 }, () => 1_000_000) },
      BBB: { closes: Array.from({ length: 260 }, (_, i) => 100 - i * 0.2), volumes: Array.from({ length: 260 }, () => 900_000) },
      CCC: { closes: Array.from({ length: 260 }, () => 50), volumes: Array.from({ length: 260 }, () => 700_000) },
    });
    expect(stats.advancers + stats.decliners + stats.unchanged).toBe(3);
    expect(stats.memberCount).toBe(3);
    expect(stats.pctAbove5MA).toBeGreaterThanOrEqual(0);
    expect(stats.pctAbove200MA).toBeLessThanOrEqual(100);
    expect(stats.totalVolume).toBeGreaterThan(0);
    expect(stats.new52WHighs).toBeGreaterThanOrEqual(0);
    expect(stats.pctAbove50MA).toBeGreaterThanOrEqual(0);
    expect(stats.pctAbove50MA).toBeLessThanOrEqual(100);
  });

  it("skips S&P 500 breadth rows when current-session coverage is below the gate", async () => {
    const tickers = Array.from({ length: 10 }, (_, index) => `T${index}`);
    const bars = tickers.slice(0, 9).flatMap((ticker) => twoDayBar(ticker));
    const { env, snapshots, deletedIds } = createBreadthEnv(tickers, bars);

    const result = await computeAndStoreBreadth(env, "2026-06-02", "sp500-core");

    expect(result).toMatchObject({
      stored: false,
      reason: "low-current-date-coverage",
      coveragePct: 90,
      minCoveragePct: 95,
      memberCount: 9,
      totalUniverseMembers: 10,
    });
    expect(snapshots.size).toBe(0);
    expect(deletedIds).toEqual(["2026-06-02:sp500-core"]);
  });

  it("stores S&P 500 breadth rows when current-session coverage meets the gate", async () => {
    const tickers = Array.from({ length: 20 }, (_, index) => `T${index}`);
    const bars = tickers.slice(0, 19).flatMap((ticker) => twoDayBar(ticker));
    const { env, snapshots } = createBreadthEnv(tickers, bars);

    const result = await computeAndStoreBreadth(env, "2026-06-02", "sp500-core");

    expect(result).toMatchObject({
      stored: true,
      coveragePct: 95,
      minCoveragePct: 95,
      memberCount: 19,
      totalUniverseMembers: 20,
    });
    expect(snapshots.has("2026-06-02:sp500-core")).toBe(true);
  });
});
