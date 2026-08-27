import { describe, expect, it } from "vitest";
import { computeAndStoreBreadth, shouldRefreshUniverseSource, universeSourceAgeDays } from "../src/eod";
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
            if (sql.includes("SELECT ticker, date, c, volume") && sql.includes("FROM alpaca_daily_bars")) {
              const asOfDate = String(args.at(-1));
              const requested = sql.includes("json_each")
                ? new Set((JSON.parse(String(args.find((arg) => typeof arg === "string" && arg.startsWith("[")))) as string[]).map((ticker) => ticker.toUpperCase()))
                : new Set(args.slice(1, -1).map((arg) => String(arg).toUpperCase()));
              return {
                results: normalizedBars
                  .filter((bar) => requested.has(bar.ticker) && bar.date <= asOfDate)
                  .sort((left, right) => left.ticker.localeCompare(right.ticker) || left.date.localeCompare(right.date))
                  .map((bar) => ({
                    ticker: bar.ticker,
                    date: bar.date,
                    c: bar.c,
                    volume: bar.volume,
                    sourceProvider: "alpaca",
                  })) as T[],
              };
            }
            return { results: [] as T[] };
          },
          async run() {
            if (sql.includes("DELETE FROM breadth_snapshots")) {
              deletedIds.push(String(args[0]));
            }
            if (sql.includes("INSERT INTO breadth_snapshots")) {
              snapshots.set(String(args[0]), args);
            }
            return {};
          },
          async first<T>() {
            return null as T;
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
          async first<T>() {
            return null as T;
          },
        };
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        await Promise.all(statements.map((statement) => statement.run()));
        return statements.map(() => ({ meta: { changes: 1, rows_written: 1 } }));
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
      minCoveragePct: 98,
      memberCount: 9,
      totalUniverseMembers: 10,
    });
    expect(snapshots.size).toBe(0);
    expect(deletedIds).toEqual([]);
  });

  it("stores S&P 500 breadth rows when current-session coverage meets the gate", async () => {
    const tickers = Array.from({ length: 50 }, (_, index) => `T${index}`);
    const bars = tickers.slice(0, 49).flatMap((ticker) => twoDayBar(ticker));
    const { env, snapshots } = createBreadthEnv(tickers, bars);

    const result = await computeAndStoreBreadth(env, "2026-06-02", "sp500-core");

    expect(result).toMatchObject({
      stored: true,
      coveragePct: 98,
      minCoveragePct: 98,
      memberCount: 49,
      totalUniverseMembers: 50,
    });
    expect(snapshots.has("2026-06-02:sp500-core")).toBe(true);
  });
});

describe("breadth universe source age", () => {
  const now = new Date("2026-08-27T02:00:00Z");

  it("refreshes Russell holdings at ten source days but keeps retry backoff authoritative", () => {
    expect(universeSourceAgeDays("2026-08-17", now)).toBe(10);
    expect(shouldRefreshUniverseSource({
      existingCount: 2_000,
      status: "ok",
      sourceAsOfDate: "2026-08-17",
      nextAttemptAt: null,
      refreshAfterDays: 10,
      now,
    })).toBe(true);
    expect(shouldRefreshUniverseSource({
      existingCount: 2_000,
      status: "error",
      sourceAsOfDate: "2026-08-13",
      nextAttemptAt: "2026-08-28T02:00:00Z",
      refreshAfterDays: 10,
      now,
    })).toBe(false);
  });

  it("distinguishes the fourteen-day cached-use ceiling", () => {
    expect(universeSourceAgeDays("2026-08-13", now)).toBe(14);
    expect(universeSourceAgeDays("2026-08-12", now)).toBe(15);
  });
});
