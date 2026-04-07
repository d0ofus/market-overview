import { describe, expect, it } from "vitest";
import {
  buildLeadLagAnalysis,
  buildRollingCorrelationSeries,
  loadCorrelationPair,
  ordinaryLeastSquares,
  pearsonCorrelation,
} from "../src/correlation-service";
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

function createCorrelationEnv(symbols: SymbolRow[], dailyBars: BarRow[]): Env {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async all<T>() {
                if (sql.includes("FROM symbols")) {
                  const requested = new Set((args as string[]).map((value) => value.toUpperCase()));
                  return {
                    results: symbols
                      .filter((row) => requested.has(row.ticker.toUpperCase()))
                      .map((row) => ({ ticker: row.ticker, displayName: row.displayName })) as T[],
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
                    dailyBars
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
    } as D1Database,
  };
}

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
});
