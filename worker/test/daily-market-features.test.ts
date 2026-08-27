import { describe, expect, it } from "vitest";
import {
  aggregateDailyMarketFeatures,
  computeDailyMarketFeature,
  suppressUnderCoveredBreadthMetrics,
} from "../src/daily-market-features";
import { computeBreadthStats } from "../src/metrics";

describe("daily breadth features", () => {
  it("averages both middle values for an even-sized median", () => {
    const base = {
      sessionDate: "2026-07-29", close: 2, volume: 1_000, previousClose: 1,
      return5d: 1, return63d: 1, sma5: 1, sma20: 1, sma50: 1, sma100: 1, sma200: 1,
      high5: 2, high20: 2, high21: 2, high63: 2, high126: 2, high252: 2,
      low20: 1, sourceSessions: 260, sourceProvider: "alpaca",
    };
    const features = new Map([
      ["AAA", { ...base, ticker: "AAA", return1d: 1 }],
      ["BBB", { ...base, ticker: "BBB", return1d: 9 }],
    ]);
    expect(aggregateDailyMarketFeatures(["AAA", "BBB"], features).medianReturn1D).toBe(5);
  });

  it("matches the existing breadth formulas", () => {
    const series = {
      AAA: Array.from({ length: 260 }, (_, index) => 100 + index),
      BBB: Array.from({ length: 260 }, (_, index) => 200 - index * 0.2),
      CCC: Array.from({ length: 260 }, () => 50),
    };
    const sessionDate = "2026-06-02";
    const features = new Map(Object.entries(series).map(([ticker, closes]) => [
      ticker,
      computeDailyMarketFeature(ticker, sessionDate, closes.map((close, index) => ({
        ticker,
        date: index === closes.length - 1 ? sessionDate : new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
        c: close,
        volume: 1_000 + index,
        sourceProvider: "alpaca",
      })))!,
    ]));
    const expected = computeBreadthStats(Object.fromEntries(Object.entries(series).map(([ticker, closes]) => [
      ticker,
      { closes, volumes: closes.map((_, index) => 1_000 + index) },
    ])));
    const actual = aggregateDailyMarketFeatures(Object.keys(series), features);

    expect(actual).toMatchObject(expected);
    expect(actual.metricCoverage.pctAbove200MA).toMatchObject({ eligibleCount: 3, status: "ready" });
  });

  it("uses metric-specific eligible denominators and suppresses under-covered horizons", () => {
    const tickers = Array.from({ length: 100 }, (_, index) => `T${index}`);
    const features = new Map(tickers.map((ticker, index) => [ticker, {
      ticker,
      sessionDate: "2026-07-29",
      close: index < 10 ? 2 : 0.5,
      volume: 1_000,
      previousClose: 1,
      return1d: 0,
      return5d: null,
      return63d: null,
      sma5: 1,
      sma20: 1,
      sma50: 1,
      sma100: 1,
      sma200: 1,
      high5: 2,
      high20: 2,
      high21: 2,
      high63: 2,
      high126: 2,
      high252: 2,
      low20: 0.5,
      sourceSessions: index < 10 ? 260 : 20,
      sourceProvider: "alpaca",
    }]));

    const actual = aggregateDailyMarketFeatures(tickers, features);
    expect(actual.pctAbove200MA).toBe(100);
    expect(actual.metricCoverage.pctAbove200MA).toEqual({
      eligibleCount: 10,
      coveragePct: 10,
      thresholdPct: 95,
      status: "suppressed",
    });
    expect(actual.metricCoverage.pctAbove20MA.status).toBe("ready");
    const published = suppressUnderCoveredBreadthMetrics(actual);
    expect(published.pctAbove200MA).toBeNull();
    expect(published.pctNew52WHighs).toBeNull();
    expect(published.stocksGtPos25Q).toBeNull();
    expect(published.pctAbove20MA).toBe(actual.pctAbove20MA);
  });

  it("uses total universe membership rather than observed rows for metric coverage", () => {
    const tickers = Array.from({ length: 100 }, (_, index) => `T${index}`);
    const observed = new Map(Array.from({ length: 95 }, (_, index) => [tickers[index]!, {
      ticker: tickers[index]!, sessionDate: "2026-07-29", close: 2, volume: 1_000,
      previousClose: 1, return1d: 1, return5d: 1, return63d: 1,
      sma5: 1, sma20: 1, sma50: 1, sma100: 1, sma200: 1,
      high5: 2, high20: 2, high21: 2, high63: 2, high126: 2, high252: 2,
      low20: 1, sourceSessions: index < 90 ? 260 : 20, sourceProvider: "alpaca",
    }]));
    const actual = aggregateDailyMarketFeatures(tickers, observed);
    expect(actual.metricCoverage.pctAbove200MA.coveragePct).toBe(90);
    expect(actual.metricCoverage.pctAbove200MA.status).toBe("suppressed");
  });
});
