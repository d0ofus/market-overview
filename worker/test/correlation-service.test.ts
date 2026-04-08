import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLeadLagAnalysis,
  buildRollingCorrelationSeries,
  loadCorrelationPair,
  loadCorrelationMatrix,
  ordinaryLeastSquares,
  pearsonCorrelation,
} from "../src/correlation-service";
import * as providerModule from "../src/provider";
import { latestUsSessionAsOfDate } from "../src/refresh-timing";
import type { Env } from "../src/types";

type BarRow = {
  ticker: string;
  date: string;
  c: number;
};

type SymbolRow = {
  ticker: string;
  displayName: string | null;
};

function buildDates(count: number, start = "2025-01-02"): string[] {
  const startDate = new Date(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const next = new Date(startDate);
    next.setUTCDate(startDate.getUTCDate() + index);
    return next.toISOString().slice(0, 10);
  });
}

function addDays(isoDate: string, days: number): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function createCorrelationEnv(symbols: SymbolRow[], dailyBars: BarRow[]): Env {
  const storedBars = [...dailyBars];
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              __sql: sql,
              __args: args,
              async all<T>() {
                if (sql.includes("FROM symbols")) {
                  const requested = new Set((args as string[]).map((value) => value.toUpperCase()));
                  return {
                    results: symbols
                      .filter((row) => requested.has(row.ticker.toUpperCase()))
                      .map((row) => ({ ticker: row.ticker, displayName: row.displayName })) as T[],
                  };
                }
                if (sql.includes("MAX(date) as lastBarDate")) {
                  const requested = new Set((args as string[]).map((value) => value.toUpperCase()));
                  return {
                    results: Array.from(requested).flatMap((ticker) => {
                      const lastBarDate = storedBars
                        .filter((row) => row.ticker.toUpperCase() === ticker)
                        .map((row) => row.date)
                        .sort()
                        .at(-1);
                      return lastBarDate ? [{ ticker, lastBarDate }] : [];
                    }) as T[],
                  };
                }
                if (sql.includes("FROM daily_bars")) {
                  const perTickerLimit = typeof args[args.length - 1] === "number"
                    ? Number(args[args.length - 1])
                    : Number.POSITIVE_INFINITY;
                  const requested = new Set(
                    (args as Array<string | number>)
                      .filter((value): value is string => typeof value === "string")
                      .map((value) => value.toUpperCase()),
                  );
                  const limitedRows = Array.from(requested).flatMap((ticker) =>
                    storedBars
                      .filter((row) => row.ticker.toUpperCase() === ticker)
                      .slice(-perTickerLimit),
                  );
                  return { results: limitedRows as T[] };
                }
                return { results: [] as T[] };
              },
              async first<T>() {
                return null as T;
              },
            };
          },
          async all<T>() {
            return { results: [] as T[] };
          },
        };
      },
      async batch(statements: Array<{ __sql?: string; __args?: unknown[] }>) {
        for (const statement of statements) {
          if (!statement.__sql?.includes("INSERT OR REPLACE INTO daily_bars")) continue;
          const [ticker, date, o, h, l, c, volume] = statement.__args ?? [];
          const nextRow = {
            ticker: String(ticker),
            date: String(date),
            o: Number(o),
            h: Number(h),
            l: Number(l),
            c: Number(c),
            volume: Number(volume),
          };
          const existingIndex = storedBars.findIndex((row) => row.ticker === nextRow.ticker && row.date === nextRow.date);
          if (existingIndex >= 0) {
            storedBars[existingIndex] = { ticker: nextRow.ticker, date: nextRow.date, c: nextRow.c };
          } else {
            storedBars.push({ ticker: nextRow.ticker, date: nextRow.date, c: nextRow.c });
          }
        }
        return [];
      },
    } as D1Database,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("correlation service", () => {
  it("computes Pearson correlation for positive and negative relationships", () => {
    expect(pearsonCorrelation([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(pearsonCorrelation([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1);
    expect(pearsonCorrelation([1, 1, 1], [2, 3, 4])).toBeNull();
  });

  it("computes OLS regression statistics", () => {
    const result = ordinaryLeastSquares([1, 2, 3, 4], [3, 5, 7, 9]);

    expect(result.beta).toBeCloseTo(2);
    expect(result.intercept).toBeCloseTo(1);
    expect(result.correlation).toBeCloseTo(1);
    expect(result.rSquared).toBeCloseTo(1);
    expect(result.observationCount).toBe(4);
  });

  it("builds rolling correlation windows after the selected window is reached", () => {
    const result = buildRollingCorrelationSeries(
      {
        dates: buildDates(5),
        leftValues: [1, 2, 3, 4, 5],
        rightValues: [2, 4, 6, 8, 10],
      },
      3,
    );

    expect(result.slice(0, 2).map((row) => row.value)).toEqual([null, null]);
    expect(result.slice(2).every((row) => row.value != null && Math.abs(row.value - 1) < 1e-12)).toBe(true);
  });

  it("detects when the left series leads the right series in lead-lag analysis", () => {
    const dates = buildDates(25);
    const leftValues = Array.from({ length: 25 }, (_, index) => (index % 2 === 0 ? 1 : -1) * (index + 1));
    const rightValues = [0, ...leftValues.slice(0, -1)];

    const result = buildLeadLagAnalysis(
      { dates, values: leftValues },
      { dates, values: rightValues },
    );

    expect(result.bestLag?.lag).toBe(1);
    expect(result.bestLag?.correlation).toBeCloseTo(1);
    expect(result.confidenceBand).not.toBeNull();
  });

  it("returns no usable lead-lag winner when overlap is below the minimum threshold", () => {
    const dates = buildDates(10);
    const result = buildLeadLagAnalysis(
      { dates, values: Array.from({ length: 10 }, (_, index) => index + 1) },
      { dates, values: Array.from({ length: 10 }, (_, index) => (index + 1) * 2) },
    );

    expect(result.bestLag).toBeNull();
    expect(result.confidenceBand).toBeNull();
    expect(result.rows.every((row) => row.correlation == null)).toBe(true);
  });

  it("keeps flat spread z-scores null when the pair tracks at a constant ratio", async () => {
    vi.spyOn(providerModule, "getProvider").mockReturnValue({
      label: "test-provider",
      getDailyBars: async () => [],
    });
    const dates = buildDates(30);
    const aaplBars = dates.map((date, index) => ({ ticker: "AAPL", date, c: 100 + index }));
    const msftBars = dates.map((date, index) => ({ ticker: "MSFT", date, c: (100 + index) * 2 }));
    const env = createCorrelationEnv(
      [
        { ticker: "AAPL", displayName: "Apple Inc." },
        { ticker: "MSFT", displayName: "Microsoft Corp." },
      ],
      [...aaplBars, ...msftBars],
    );

    const result = await loadCorrelationPair(env, ["AAPL", "MSFT"], "60D", "20D");

    expect(result.overview.normalizedSeries.length).toBe(30);
    expect(result.overview.stats.beta).toBeCloseTo(1, 10);
    expect(result.overview.stats.intercept).toBeCloseTo(Math.log(2), 10);
    expect(result.spread.series.length).toBe(30);
    expect(result.spread.latest.zScore).toBeNull();
    expect(result.dynamics.rollingCorrelation.some((row) => row.value != null)).toBe(true);
  });

  it("backfills stale correlation bars before analysis when newer provider data is available", async () => {
    const expectedAsOfDate = latestUsSessionAsOfDate(new Date());
    const latestStoredDate = addDays(expectedAsOfDate, -2);
    const previousStoredDate = addDays(expectedAsOfDate, -3);
    vi.spyOn(providerModule, "getProvider").mockReturnValue({
      label: "test-provider",
      getDailyBars: async () => [
        { ticker: "AAPL", date: addDays(expectedAsOfDate, -1), o: 111, h: 111, l: 111, c: 111, volume: 1 },
        { ticker: "AAPL", date: expectedAsOfDate, o: 112, h: 112, l: 112, c: 112, volume: 1 },
        { ticker: "MSFT", date: addDays(expectedAsOfDate, -1), o: 55, h: 55, l: 55, c: 55, volume: 1 },
        { ticker: "MSFT", date: expectedAsOfDate, o: 56, h: 56, l: 56, c: 56, volume: 1 },
      ],
    });
    const env = createCorrelationEnv(
      [
        { ticker: "AAPL", displayName: "Apple Inc." },
        { ticker: "MSFT", displayName: "Microsoft Corp." },
      ],
      [
        { ticker: "AAPL", date: previousStoredDate, c: 109 },
        { ticker: "AAPL", date: latestStoredDate, c: 110 },
        { ticker: "MSFT", date: previousStoredDate, c: 54 },
        { ticker: "MSFT", date: latestStoredDate, c: 54.5 },
      ],
    );

    const result = await loadCorrelationMatrix(env, ["AAPL", "MSFT"], "60D");

    expect(result.latestAvailableDate).toBe(expectedAsOfDate);
    expect(result.warnings.some((warning) => warning.includes("Stored bar history is behind"))).toBe(false);
    expect(result.resolvedTickers.every((ticker) => ticker.status === "ok")).toBe(true);
  });

  it("falls back to stale stored bars when correlation backfill fails", async () => {
    const expectedAsOfDate = latestUsSessionAsOfDate(new Date());
    const latestStoredDate = addDays(expectedAsOfDate, -2);
    vi.spyOn(providerModule, "getProvider").mockReturnValue({
      label: "test-provider",
      getDailyBars: async () => {
        throw new Error("provider unavailable");
      },
    });
    const env = createCorrelationEnv(
      [
        { ticker: "AAPL", displayName: "Apple Inc." },
        { ticker: "MSFT", displayName: "Microsoft Corp." },
      ],
      [
        { ticker: "AAPL", date: addDays(expectedAsOfDate, -3), c: 109 },
        { ticker: "AAPL", date: latestStoredDate, c: 110 },
        { ticker: "MSFT", date: addDays(expectedAsOfDate, -3), c: 54 },
        { ticker: "MSFT", date: latestStoredDate, c: 54.5 },
      ],
    );

    const result = await loadCorrelationMatrix(env, ["AAPL", "MSFT"], "60D");

    expect(result.latestAvailableDate).toBe(latestStoredDate);
    expect(result.warnings.some((warning) => warning.includes("Live correlation backfill failed"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("Stored bar history is behind"))).toBe(true);
  });
});
