import assert from "node:assert/strict";
import test from "node:test";
import {
  getOverviewFreshnessIndicators,
  type OverviewFreshnessIndicatorRow,
} from "./overview-freshness-indicators";
import type { OverviewCurrentData } from "../types/dashboard";

function currentData(status: OverviewCurrentData["status"]): OverviewCurrentData {
  return {
    sessionDate: "2026-07-20",
    status,
    reason: "Current snapshot is being refreshed.",
    quoteSource: "tradingview-scanner",
    performanceSource: "tradingview-scanner",
    smaSource: "tradingview-scanner",
    fieldSources: { price: "tradingview-scanner", change1d: "tradingview-scanner" },
    providerStatuses: {},
    fetchedAt: "2026-07-21T11:46:00.000Z",
    tradingViewSymbol: "NASDAQ:AAPL",
    tradingViewTime: null,
    tradingViewLastBarUpdateTime: null,
    tradingViewLastPriceUpdateTime: null,
    tradingViewUpdateTime: null,
    tradingViewUpdateMode: null,
    tradingViewCurrentSession: null,
  };
}

function row(overrides: Partial<OverviewFreshnessIndicatorRow> = {}): OverviewFreshnessIndicatorRow {
  return {
    ticker: "AAPL",
    barDate: "2026-07-20",
    barFreshnessStatus: "fresh",
    quoteFreshnessStatus: "fresh",
    quoteSource: "tradingview-scanner",
    quoteFetchedAt: "2026-07-21T11:46:00.000Z",
    sparkline: [98, 99, 100],
    relativeStrength30dVsSpy: [-0.2, 0.1, 0.4],
    currentData: currentData("fresh"),
    historyData: {
      sessionDate: "2026-07-20",
      status: "fresh",
      reason: "Canonical history is current.",
      barDate: "2026-07-20",
      source: "alpaca:sip",
      seriesThroughDate: "2026-07-20",
      seriesStatus: "fresh",
      seriesSource: "alpaca:sip",
      seriesReason: null,
    },
    ...overrides,
  };
}

test("fresh rows and optional metric gaps render no indicator", () => {
  const value = row({
    currentData: {
      ...currentData("fresh"),
      fieldSources: { price: "tradingview-scanner", change1d: "tradingview-scanner" },
    },
  });
  assert.deepEqual(getOverviewFreshnessIndicators(value), []);
});

test("stale current data renders only the amber clock indicator", () => {
  const indicators = getOverviewFreshnessIndicators(row({ quoteFreshnessStatus: "stale" }));
  assert.deepEqual(indicators.map(({ kind, tone }) => ({ kind, tone })), [
    { kind: "quote-stale", tone: "warning" },
  ]);
  assert.match(indicators[0].detail, /Stored session: 2026-07-20/);
  assert.match(indicators[0].detail, /Source: tradingview-scanner/);
});

test("usable fallback history is informational and includes both series dates", () => {
  const indicators = getOverviewFreshnessIndicators(row({
    historyData: {
      ...row().historyData!,
      seriesStatus: "fallback",
      seriesThroughDate: "2026-07-17",
    },
  }));
  assert.deepEqual(indicators.map(({ kind }) => kind), ["history-lagging"]);
  assert.match(indicators[0].detail, /available through 2026-07-17/);
  assert.match(indicators[0].detail, /canonical daily bar is through 2026-07-20/);
  assert.match(indicators[0].detail, /remain usable/);
});

test("current and historical failures render two ordered danger indicators", () => {
  const indicators = getOverviewFreshnessIndicators(row({
    quoteFreshnessStatus: "unavailable",
    currentData: currentData("unavailable"),
    sparkline: null,
    relativeStrength30dVsSpy: null,
    historyData: {
      ...row().historyData!,
      status: "unavailable",
      seriesStatus: "unavailable",
      seriesThroughDate: null,
    },
  }));
  assert.deepEqual(indicators.map(({ kind, tone }) => ({ kind, tone })), [
    { kind: "quote-unavailable", tone: "danger" },
    { kind: "history-unavailable", tone: "danger" },
  ]);
});

test("retrying takes precedence over an unavailable current status", () => {
  const indicators = getOverviewFreshnessIndicators(row({
    quoteFreshnessStatus: "unavailable",
    currentData: currentData("retrying"),
  }));
  assert.deepEqual(indicators.map(({ kind }) => kind), ["quote-retrying"]);
});

test("unsupported instruments collapse to one informational indicator", () => {
  const indicators = getOverviewFreshnessIndicators(row({
    quoteFreshnessStatus: "unsupported",
    historyData: {
      ...row().historyData!,
      seriesStatus: "fallback",
    },
  }));
  assert.deepEqual(indicators.map(({ kind, tone }) => ({ kind, tone })), [
    { kind: "unsupported", tone: "info" },
  ]);
  assert.match(indicators[0].detail, /not counted as a freshness error/);
});

test("JSON-shaped provider bodies are omitted from tooltip details", () => {
  const indicators = getOverviewFreshnessIndicators(row({
    quoteFreshnessStatus: "stale",
    quoteFreshnessReason: '{"error":{"message":"sensitive upstream body"}}',
  }));
  assert.doesNotMatch(indicators[0].detail, /sensitive upstream body/);
});
