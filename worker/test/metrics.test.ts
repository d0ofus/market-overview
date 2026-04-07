import { describe, expect, it } from "vitest";
import { buildRelativeStrengthSeries, computeMetrics, rankValue, sanitizeBarSeries } from "../src/metrics";

describe("computeMetrics", () => {
  it("computes core return metrics and sparkline", () => {
    const dates = Array.from({ length: 260 }, (_, i) => `2025-${String(Math.floor(i / 21) + 1).padStart(2, "0")}-${String((i % 21) + 1).padStart(2, "0")}`);
    const closes = Array.from({ length: 260 }, (_, i) => 100 + i * 0.5);
    const m = computeMetrics(dates, closes);
    expect(m.price).toBeCloseTo(229.5);
    expect(m.change1d).toBeGreaterThan(0);
    expect(m.change5d).toBeGreaterThan(0);
    expect(m.ytd).toBeGreaterThan(0);
    expect(m.pctFrom52wHigh).toBeLessThanOrEqual(0);
    expect(m.sparkline.length).toBeLessThanOrEqual(90);
  });

  it("ranks based on requested window", () => {
    const sample = {
      price: 100,
      change1d: 1,
      change5d: 2,
      change1w: 3,
      change3m: 4,
      change6m: 5,
      change21d: 4,
      ytd: 6,
      pctFrom52wHigh: -2,
      sparkline: [1, 2, 3],
    };
    expect(rankValue(sample, "1W")).toBe(3);
    expect(rankValue(sample, "YTD")).toBe(6);
    expect(rankValue(sample, "52W")).toBe(-2);
  });

  it("filters isolated corrupt bars from the series before building sparklines", () => {
    const dates = ["2025-01-16", "2025-01-17", "2025-01-20", "2025-01-21", "2025-01-22"];
    const closes = [591.7, 597.64, 482.1648070476866, 602.92, 606.33];
    const cleaned = sanitizeBarSeries(dates, closes);
    expect(cleaned.dates).toEqual(["2025-01-16", "2025-01-17", "2025-01-21", "2025-01-22"]);
    expect(cleaned.closes).toEqual([591.7, 597.64, 602.92, 606.33]);
    expect(computeMetrics(dates, closes).sparkline).toEqual([591.7, 597.64, 602.92, 606.33]);
  });

  it("builds a 30 day relative strength series from overlapping dates", () => {
    const tickerDates = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"];
    const tickerCloses = [20, 21, 22, 24];
    const benchmarkDates = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"];
    const benchmarkCloses = [10, 10.5, 11, 12];

    expect(buildRelativeStrengthSeries(tickerDates, tickerCloses, benchmarkDates, benchmarkCloses)).toEqual([2, 2, 2, 2]);
  });

  it("keeps fewer than 30 overlapping values when history is short", () => {
    const tickerDates = ["2025-01-02", "2025-01-03"];
    const tickerCloses = [20, 24];
    const benchmarkDates = ["2025-01-02", "2025-01-03"];
    const benchmarkCloses = [10, 12];

    expect(buildRelativeStrengthSeries(tickerDates, tickerCloses, benchmarkDates, benchmarkCloses)).toEqual([2, 2]);
  });

  it("aligns relative strength using only shared dates", () => {
    const tickerDates = ["2025-01-02", "2025-01-03", "2025-01-06"];
    const tickerCloses = [20, 24, 30];
    const benchmarkDates = ["2025-01-02", "2025-01-06"];
    const benchmarkCloses = [10, 15];

    expect(buildRelativeStrengthSeries(tickerDates, tickerCloses, benchmarkDates, benchmarkCloses)).toEqual([2, 2]);
  });

  it("filters isolated corrupt bars before calculating relative strength", () => {
    const tickerDates = ["2025-01-16", "2025-01-17", "2025-01-20", "2025-01-21", "2025-01-22"];
    const tickerCloses = [591.7, 597.64, 482.1648070476866, 602.92, 606.33];
    const benchmarkDates = ["2025-01-16", "2025-01-17", "2025-01-20", "2025-01-21", "2025-01-22"];
    const benchmarkCloses = [295.85, 298.82, 241.0824035238433, 301.46, 303.165];

    expect(buildRelativeStrengthSeries(tickerDates, tickerCloses, benchmarkDates, benchmarkCloses)).toEqual([2, 2, 2, 2]);
  });

  it("returns null when there are no shared dates", () => {
    const tickerDates = ["2025-01-02", "2025-01-03"];
    const tickerCloses = [20, 24];
    const benchmarkDates = ["2025-01-06", "2025-01-07"];
    const benchmarkCloses = [10, 12];

    expect(buildRelativeStrengthSeries(tickerDates, tickerCloses, benchmarkDates, benchmarkCloses)).toBeNull();
  });
});
