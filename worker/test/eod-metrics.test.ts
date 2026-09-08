import { describe, expect, it } from "vitest";
import { aggregateEodBreadthMetrics, computeEodBreadthMetrics, computeEodRelativeStrengthSeries, computeEodTickerMetrics, type EodMetricBar } from "../src/eod-metrics";

function dates(count: number): string[] {
  return Array.from({ length: count }, (_, index) => new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10));
}
function bars(calendar: string[], ticker = "AAA", sourceProvider: "alpaca" | "yahoo" = "alpaca", close = 100): EodMetricBar[] {
  return calendar.map((sessionDate) => ({ ticker, sessionDate, close, high: close + 1, low: close - 1,
    reportedVolume: 1_000, sourceProvider, priceBasis: "split", sourceFeed: sourceProvider === "alpaca" ? "sip" : undefined }));
}

describe("versioned EOD exact-session metrics", () => {
  it("does not call a two-session gap a one-day return or count it as a +4% mover", () => {
    const calendarDates = ["2026-08-24", "2026-08-25", "2026-08-26"];
    const inputBars = bars(calendarDates).filter((bar) => bar.sessionDate !== "2026-08-25");
    inputBars[1] = { ...inputBars[1]!, close: 105, high: 106 };
    const input = { targetSession: "2026-08-26", calendarDates, bars: inputBars };
    const ticker = computeEodTickerMetrics({ ...input, ticker: "AAA" });
    expect(ticker.price).toBe(105);
    expect(ticker.change1d).toBeNull();
    expect(ticker.sparkline).toEqual([100, null, 105]);
    const breadth = computeEodBreadthMetrics({ ...input, universeId: "nyse-core", members: [{ ticker: "AAA" }] });
    expect(breadth.publishable).toBe(false);
    expect(breadth.metrics.stocksGtPos4Pct).toBeNull();
    expect(breadth.metrics.metricCoverage.advancers?.missingCount).toBe(1);
  });

  it("uses supplied holiday sessions rather than elapsed days", () => {
    const calendarDates = ["2026-09-04", "2026-09-08"];
    const inputBars = bars(calendarDates);
    inputBars[1] = { ...inputBars[1]!, close: 103, high: 104 };
    expect(computeEodTickerMetrics({ ticker: "AAA", targetSession: "2026-09-08", calendarDates, bars: inputBars }).change1d).toBe(3);
    expect(() => computeEodTickerMetrics({ ticker: "AAA", targetSession: "2026-09-07", calendarDates, bars: inputBars })).toThrow(/absent/);
  });

  it("requires every session within a moving-average window", () => {
    const calendarDates = dates(30);
    const inputBars = bars(calendarDates).filter((_, index) => index !== 15);
    const row = computeEodTickerMetrics({ ticker: "AAA", targetSession: calendarDates.at(-1)!, calendarDates, bars: inputBars });
    expect(row.change1d).toBe(0);
    expect(row.sma5).toBe(100);
    expect(row.sma20).toBeNull();
    expect(row.high21).toBeNull();
    expect(row.change21d).toBeNull();
  });

  it("requires prior-year closing session for YTD and never uses first January close", () => {
    const calendarDates = ["2025-12-31", "2026-01-02", "2026-01-05"];
    const inputBars = bars(calendarDates).map((bar, index) => ({ ...bar, close: [100, 102, 110][index]!, high: 111, low: 99 }));
    const input = { ticker: "AAA", targetSession: "2026-01-05", calendarDates, bars: inputBars };
    expect(computeEodTickerMetrics(input).ytd).toBe(10);
    expect(computeEodTickerMetrics({ ...input, calendarDates: calendarDates.slice(1), bars: inputBars.slice(1) }).ytd).toBeNull();
  });

  it("keeps legitimate isolated price spikes rather than deleting real trades", () => {
    const calendarDates = dates(3);
    const inputBars = bars(calendarDates).map((bar, index) => ({ ...bar, close: [100, 130, 101][index]!, high: 131, low: 99 }));
    const result = computeEodTickerMetrics({ ticker: "AAA", targetSession: calendarDates.at(-1)!, calendarDates, bars: inputBars });
    expect(result.sparkline).toEqual([100, 130, 101]);
    expect(result.change1d).toBeCloseTo(-22.3076923);
  });

  it("uses a single complete Yahoo price series and independently preserves SIP reported volume", () => {
    const calendarDates = dates(252);
    const yahoo = bars(calendarDates, "AAA", "yahoo", 120);
    const alpaca = bars(calendarDates.slice(-2), "AAA", "alpaca", 200).map((bar) => ({ ...bar, reportedVolume: 777 }));
    const result = computeEodTickerMetrics({ ticker: "AAA", targetSession: calendarDates.at(-1)!, calendarDates, bars: [...alpaca, ...yahoo] });
    expect(result.sourceProvider).toBe("yahoo");
    expect(result.price).toBe(120);
    expect(result.sma200).toBe(120);
    expect(result.sparkline.every((value) => value === 120)).toBe(true);
    expect(result.reportedVolume).toBe(777);
    expect(result.fieldSources.reportedVolume).toBe("alpaca:sip-reported-volume");
    expect(result.fieldSources.price).toBe("yahoo:split-daily-bars");
  });

  it("keeps Yahoo price collection time independent of the raw SIP volume collection time", () => {
    const calendarDates = dates(252);
    const yahoo = bars(calendarDates, "AAA", "yahoo", 120).map((bar) => ({
      ...bar, collectedAt: "2026-09-09T20:30:00.000Z", reportedVolumeCollectedAt: "2026-09-09T20:30:00.000Z",
    }));
    const alpaca = bars(calendarDates.slice(-2)).map((bar) => ({ ...bar, reportedVolume: 777,
      collectedAt: "2026-09-09T20:10:00.000Z", reportedVolumeCollectedAt: "2026-09-09T20:20:00.000Z",
    }));
    const input = { ticker: "AAA", targetSession: calendarDates.at(-1)!, calendarDates };
    const row = computeEodTickerMetrics({ ...input, bars: [...alpaca, ...yahoo] });
    expect(row).toMatchObject({ sourceProvider: "yahoo", price: 120, reportedVolume: 777,
      collectedAt: "2026-09-09T20:30:00.000Z", reportedVolumeCollectedAt: "2026-09-09T20:20:00.000Z",
      sessionDate: calendarDates.at(-1)!,
    });
    const unknownVolume = computeEodTickerMetrics({ ...input, bars: [
      ...alpaca.map((bar) => ({ ...bar, reportedVolumeCollectedAt: null })), ...yahoo,
    ] });
    expect(unknownVolume.reportedVolume).toBe(777);
    expect(unknownVolume.reportedVolumeCollectedAt).toBeNull();
    const missingTime = computeEodTickerMetrics({ ...input, bars: bars(calendarDates) });
    expect(missingTime.collectedAt).toBeNull();
    expect(missingTime.reportedVolumeCollectedAt).toBeNull();
  });

  it("reports collection-time bounds only for eligible observed SIP volume and leaves unknown metadata null", () => {
    const calendarDates = dates(2);
    const targetSession = calendarDates.at(-1)!;
    const members = ["AAA", "BBB", "UNKNOWN", "MISSING", "FUTURE"].map((ticker) => ({ ticker,
      verifiedListingDate: ticker === "FUTURE" ? "2026-01-01" : null,
    }));
    const times: Record<string, string> = { AAA: "2026-09-09T20:20:00.000Z", BBB: "2026-09-09T21:00:00+00:00",
      UNKNOWN: "not-a-time", FUTURE: "2026-09-09T23:00:00.000Z" };
    const inputBars = members.filter((member) => member.ticker !== "MISSING").flatMap((member) =>
      bars(calendarDates, member.ticker).map((bar) => ({ ...bar, reportedVolumeCollectedAt: times[member.ticker] })));
    const result = computeEodBreadthMetrics({ universeId: "nyse-core", targetSession, calendarDates, members, bars: inputBars });
    expect(result.volumeCollection).toEqual({ earliest: "2026-09-09T20:20:00.000Z", latest: "2026-09-09T21:00:00.000Z",
      observedCount: 2, eligibleCount: 4 });
    expect(result.metrics.totalVolume).toBeNull(); // Collection bounds describe the observed subset, not complete volume.
    const unknown = computeEodBreadthMetrics({ universeId: "nyse-core", targetSession, calendarDates,
      members: [{ ticker: "AAA" }], bars: bars(calendarDates) });
    expect(unknown.volumeCollection).toEqual({ earliest: null, latest: null, observedCount: 0, eligibleCount: 1 });
    expect(unknown.metrics.totalVolume).toBe(1000);
  });

  it("prefers complete SIP and does not mix short Yahoo windows into partial SIP metrics", () => {
    const calendarDates = dates(252);
    const input = { ticker: "AAA", targetSession: calendarDates.at(-1)!, calendarDates };
    expect(computeEodTickerMetrics({ ...input, bars: [...bars(calendarDates), ...bars(calendarDates, "AAA", "yahoo", 120)] }).price).toBe(100);
    const partial = computeEodTickerMetrics({ ...input, bars: [...bars(calendarDates.slice(-2)), ...bars(calendarDates.slice(-20), "AAA", "yahoo", 120)] });
    expect(partial.sourceProvider).toBe("alpaca");
    expect(partial.sma20).toBeNull();
    expect(partial.change1d).toBe(0);
  });

  it("separates intraday 52-week highs for Overview from closing highs for Breadth", () => {
    const calendarDates = dates(252);
    const inputBars = bars(calendarDates);
    inputBars[0] = { ...inputBars[0]!, high: 200 };
    const row = computeEodTickerMetrics({ ticker: "AAA", targetSession: calendarDates.at(-1)!, calendarDates, bars: inputBars });
    expect(row.pctFrom52wHigh).toBe(-50);
    expect(row.high252).toBe(100);
    expect(computeEodBreadthMetrics({ universeId: "nyse-core", targetSession: calendarDates.at(-1)!, calendarDates,
      members: [{ ticker: "AAA" }], bars: inputBars }).metrics.new52WHighs).toBe(1);
  });

  it("does not turn missing or Yahoo volume into a zero or consolidated volume", () => {
    const calendarDates = dates(2);
    const input = { ticker: "AAA", targetSession: calendarDates.at(-1)!, calendarDates };
    expect(computeEodTickerMetrics({ ...input, bars: bars(calendarDates, "AAA", "yahoo") }).reportedVolume).toBeNull();
    const breadth = computeEodBreadthMetrics({ ...input, universeId: "nyse-core", members: [{ ticker: "AAA" }],
      bars: bars(calendarDates).map((bar) => ({ ...bar, reportedVolume: null })) });
    expect(breadth.publishable).toBe(true);
    expect(breadth.metrics.totalVolume).toBeNull();
  });

  it("excludes verified IPOs from long-horizon eligibility without disguising unverified history gaps", () => {
    const calendarDates = dates(252);
    const members = Array.from({ length: 100 }, (_, index) => ({ ticker: `T${index}`, verifiedListingDate: index >= 90 ? calendarDates.at(-20)! : null }));
    const inputBars = members.flatMap((member, index) => bars(index >= 90 ? calendarDates.slice(-20) : calendarDates, member.ticker));
    const input = { universeId: "nyse-core", targetSession: calendarDates.at(-1)!, calendarDates, bars: inputBars };
    const known = computeEodBreadthMetrics({ ...input, members });
    expect(known.metrics.metricCoverage.pctAbove200MA).toMatchObject({ eligiblePopulation: 90, eligibleCount: 90, structurallyIneligibleCount: 10, coveragePct: 100 });
    expect(known.metrics.pctAbove200MA).toBe(0);
    const unknown = computeEodBreadthMetrics({ ...input, members: members.map(({ ticker }) => ({ ticker })) });
    expect(unknown.metrics.metricCoverage.pctAbove200MA).toMatchObject({ eligiblePopulation: 100, missingCount: 10, status: "suppressed" });
    expect(unknown.metrics.pctAbove200MA).toBeNull();
  });

  it("gates S&P at98% and other universes at95%, without holding daily metrics for a short calendar", () => {
    const calendarDates = dates(2);
    const members = Array.from({ length: 100 }, (_, index) => ({ ticker: `T${index}` }));
    const input = { targetSession: calendarDates.at(-1)!, calendarDates, members, bars: members.slice(0, 97).flatMap((member) => bars(calendarDates, member.ticker)) };
    expect(computeEodBreadthMetrics({ ...input, universeId: "sp500-core" }).publishable).toBe(false);
    const other = computeEodBreadthMetrics({ ...input, universeId: "nyse-core" });
    expect(other.publishable).toBe(true);
    expect(other.metrics.pctAbove200MA).toBeNull();
    expect(other.metrics.unchanged).toBe(97);
  });

  it("averages both middle median values and preserves undefined A/D", () => {
    const calendarDates = dates(2);
    const inputBars = [...bars(calendarDates, "AAA"), ...bars(calendarDates, "BBB")].map((bar) => bar.sessionDate === calendarDates[1]
      ? { ...bar, close: bar.ticker === "AAA" ? 101 : 109, high: 110 } : bar);
    const result = computeEodBreadthMetrics({ universeId: "nyse-core", targetSession: calendarDates.at(-1)!, calendarDates,
      members: [{ ticker: "AAA" }, { ticker: "BBB" }], bars: inputBars });
    expect(result.metrics.medianReturn1D).toBe(5);
    expect(result.metrics.advDecRatio).toBeNull();
  });

  it("reuses versioned exact-session checkpoints and exposes population bounds for missing members", () => {
    const calendarDates = dates(20);
    const members = Array.from({ length: 100 }, (_, index) => ({ ticker: `T${index}` }));
    const targetSession = calendarDates.at(-1)!;
    const features = new Map(members.slice(0, 96).map((member) => [member.ticker,
      computeEodTickerMetrics({ ...member, targetSession, calendarDates,
        bars: bars(calendarDates, member.ticker).map((bar, index) => index === 19 ? { ...bar, close: 101 } : bar) })]));
    const result = aggregateEodBreadthMetrics({ universeId: "nyse-core", targetSession, calendarDates, members, features });
    expect(result.metrics.advancers).toBe(96);
    expect(result.metrics.pctAbove20MA).toBe(100);
    expect(result.metrics.metricCoverage.pctAbove20MA).toMatchObject({
      eligiblePopulation: 100, eligibleCount: 96, missingCount: 4,
      lowerBound: 96, upperBound: 100, boundUnit: "percent",
    });
    expect(result.metrics.metricCoverage.new1MHighs).toMatchObject({ eligibleCount: 0, missingCount: 100, status: "suppressed" });
    expect(result.metrics.metricCoverage.new5DHighs).toMatchObject({ lowerBound: 96, upperBound: 100, boundUnit: "count" });
    const wrongSession = aggregateEodBreadthMetrics({ universeId: "nyse-core", targetSession: calendarDates[18]!, calendarDates,
      members, features });
    expect(wrongSession.publishable).toBe(false);
  });

  it("retains aligned missing sessions in relative-strength history", () => {
    const calendarDates = dates(3);
    const input = { targetSession: calendarDates.at(-1)!, calendarDates };
    const result = computeEodRelativeStrengthSeries({ ticker: { ...input, ticker: "AAA", bars: bars(calendarDates).filter((_, index) => index !== 1) },
      benchmark: { ...input, ticker: "SPY", bars: bars(calendarDates, "SPY", "alpaca", 200) } });
    expect(result.values).toEqual([0.5, null, 0.5]);
  });
});
