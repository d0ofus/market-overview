import { describe, expect, it } from "vitest";
import { aggregateDailyMarketFeatures, computeDailyMarketFeature } from "../src/daily-market-features";
import { computeBreadthStats } from "../src/metrics";

describe("daily breadth features", () => {
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

    expect(actual).toEqual(expected);
  });
});
