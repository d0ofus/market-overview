import { describe, expect, it } from "vitest";
import {
  buildPatternFeatureSnapshot,
  scorePatternSnapshot,
  type PatternDailyBar,
  type PatternLabel,
  type PatternModelVersion,
} from "../src/pattern-scanner-service";

function makeBars(ticker: string, count: number, startClose = 50): PatternDailyBar[] {
  const start = new Date("2025-01-02T00:00:00Z");
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    const close = startClose + index * 0.3 + Math.sin(index / 6) * 1.5;
    return {
      ticker,
      date: date.toISOString().slice(0, 10),
      o: close - 0.2,
      h: close + 0.8,
      l: close - 0.9,
      c: close,
      volume: 1_000_000 + (index % 20) * 10_000,
    };
  });
}

function labelFromSnapshot(
  id: string,
  snapshot: NonNullable<ReturnType<typeof buildPatternFeatureSnapshot>>,
  label: "approved" | "rejected",
  status: PatternLabel["status"] = "active",
): PatternLabel {
  return {
    id,
    profileId: "default",
    ticker: snapshot.ticker,
    setupDate: snapshot.setupDate,
    label,
    status,
    source: "test",
    contextWindowBars: snapshot.contextWindowBars,
    patternWindowBars: snapshot.patternWindowBars,
    patternStartDate: snapshot.patternStartDate,
    patternEndDate: snapshot.patternEndDate,
    selectedBarCount: snapshot.selectedBarCount,
    selectionMode: snapshot.selectionMode,
    tags: [],
    notes: null,
    featureVersion: snapshot.featureVersion,
    featureJson: snapshot.featureJson,
    shapeJson: snapshot.shapeJson,
    windowHash: snapshot.windowHash,
    createdAt: snapshot.setupDate,
    updatedAt: snapshot.setupDate,
  };
}

describe("pattern scanner service", () => {
  it("extracts deterministic fixed-length features without future bars", () => {
    const tickerBars = makeBars("TEST", 120, 30);
    const benchmarkBars = makeBars("SPY", 120, 100);
    const setupDate = tickerBars[90].date;
    const withFuture = buildPatternFeatureSnapshot({
      ticker: "TEST",
      setupDate,
      tickerBars,
      benchmarkBars,
      benchmarkTicker: "SPY",
    });
    const withoutFuture = buildPatternFeatureSnapshot({
      ticker: "TEST",
      setupDate,
      tickerBars: tickerBars.slice(0, 91),
      benchmarkBars: benchmarkBars.slice(0, 91),
      benchmarkTicker: "SPY",
    });

    expect(withFuture).not.toBeNull();
    expect(withoutFuture).not.toBeNull();
    expect(withFuture?.windowHash).toBe(withoutFuture?.windowHash);
    expect(withFuture?.featureJson).toEqual(withoutFuture?.featureJson);
    expect(withFuture?.shapeJson.price_path_40d).toHaveLength(40);
    expect(withFuture?.shapeJson.relative_strength_path_60d).toHaveLength(60);
    expect(withFuture?.shapeJson.selected_price_path_64).toHaveLength(64);
    expect(withFuture?.sourceMetadata.latestBarDate).toBe(setupDate);
  });

  it("uses a chart-selected date range for pattern-sensitive features", () => {
    const tickerBars = makeBars("RANGE", 140, 40);
    const benchmarkBars = makeBars("SPY", 140, 100);
    const setupDate = tickerBars[110].date;
    const startDate = tickerBars[82].date;
    const snapshot = buildPatternFeatureSnapshot({
      ticker: "RANGE",
      setupDate,
      patternStartDate: startDate,
      patternEndDate: setupDate,
      selectionMode: "chart_range",
      tickerBars,
      benchmarkBars,
      benchmarkTicker: "SPY",
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.patternStartDate).toBe(startDate);
    expect(snapshot?.patternEndDate).toBe(setupDate);
    expect(snapshot?.selectedBarCount).toBe(29);
    expect(snapshot?.featureJson.base_length_bars).toBe(29);
    expect(snapshot?.shapeJson.selected_price_path_64).toHaveLength(64);
    expect(snapshot?.sourceMetadata.latestBarDate).toBe(setupDate);
  });

  it("returns null when stored bars are insufficient", () => {
    const snapshot = buildPatternFeatureSnapshot({
      ticker: "THIN",
      setupDate: "2025-02-15",
      tickerBars: makeBars("THIN", 20, 10),
      benchmarkBars: makeBars("SPY", 80, 100),
      benchmarkTicker: "SPY",
    });

    expect(snapshot).toBeNull();
  });

  it("scores with model mode when enough active labels are present", () => {
    const approvedSnapshots = [0, 1, 2].map((offset) => buildPatternFeatureSnapshot({
      ticker: `APP${offset}`,
      setupDate: "2025-04-20",
      tickerBars: makeBars(`APP${offset}`, 120, 50 + offset),
      benchmarkBars: makeBars("SPY", 120, 100),
      benchmarkTicker: "SPY",
    })!);
    const rejectedSnapshots = [0, 1, 2].map((offset) => buildPatternFeatureSnapshot({
      ticker: `REJ${offset}`,
      setupDate: "2025-04-20",
      tickerBars: makeBars(`REJ${offset}`, 120, 20 - offset),
      benchmarkBars: makeBars("SPY", 120, 100),
      benchmarkTicker: "SPY",
    })!);
    const labels = [
      ...approvedSnapshots.map((snapshot, index) => labelFromSnapshot(`a-${index}`, snapshot, "approved")),
      ...rejectedSnapshots.map((snapshot, index) => labelFromSnapshot(`r-${index}`, snapshot, "rejected")),
    ];
    const model: PatternModelVersion = {
      id: "model-1",
      profileId: "default",
      modelType: "similarity_v1",
      featureVersion: "v1",
      approvedCount: 3,
      rejectedCount: 3,
      active: true,
      createdAt: "2025-04-20",
      metrics: {
        enoughLabels: true,
        approvedCount: 3,
        rejectedCount: 3,
        totalActiveLabels: 6,
        chronologicalAccuracy: null,
        precisionAt25: null,
        precisionAt50: null,
        validationWindowSize: 0,
      },
      featureSummary: { scalarStats: {}, topWeightedFeatures: [] },
      model: {
        modelType: "similarity_v1",
        featureVersion: "v1",
        enoughLabels: true,
        scalarKeys: ["prior_runup_60d_pct", "close_vs_50sma_pct", "base_depth_pct"],
        shapeKeys: ["price_path_40d"],
        scalarNormalization: {
          prior_runup_60d_pct: { mean: 0, std: 20 },
          close_vs_50sma_pct: { mean: 0, std: 10 },
          base_depth_pct: { mean: 20, std: 10 },
        },
        approvedScalarCentroid: {
          prior_runup_60d_pct: 1,
          close_vs_50sma_pct: 1,
          base_depth_pct: 0,
        },
        rejectedScalarCentroid: {
          prior_runup_60d_pct: -1,
          close_vs_50sma_pct: -1,
          base_depth_pct: 1,
        },
        approvedShapeCentroid: { price_path_40d: approvedSnapshots[0].shapeJson.price_path_40d },
        rejectedShapeCentroid: { price_path_40d: rejectedSnapshots[0].shapeJson.price_path_40d },
        featureWeights: {},
        tagWeights: {},
        nearestReferences: { approved: [], rejected: [] },
      },
    };

    const score = scorePatternSnapshot(approvedSnapshots[0], labels, model);

    expect(score.mode).toBe("model");
    expect(score.score).toBeGreaterThan(0.5);
    expect(score.positiveContributions.length).toBeGreaterThan(0);
  });
});
