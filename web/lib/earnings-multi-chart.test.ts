import assert from "node:assert/strict";
import test from "node:test";
import type { EarningsGapRow, EarningsSurpriseRow } from "./api";
import {
  buildEarningsGridQuery,
  currentEarningsGridData,
  earningsGridMetricClass,
  gapRowToGridCard,
  normalizeEarningsResultView,
  surpriseRowToGridCard,
} from "./earnings-multi-chart";

const surpriseRow: EarningsSurpriseRow = {
  id: "surprise-aapl-2026-07-15",
  provider: "tradingview",
  sourceSymbol: "NASDAQ:AAPL",
  ticker: "AAPL",
  exchange: "NASDAQ",
  companyName: "Apple Inc.",
  sector: "Electronic Technology",
  industry: "Telecommunications Equipment",
  marketCap: 3_250_000_000_000,
  avgDollarVolume30d: 12_345_678_900,
  reportDate: "2026-07-15",
  reportTimestamp: null,
  reportTime: "after-market",
  fiscalPeriodEnd: "2026-06-30",
  season: "2026 Q2",
  epsActual: 2.1,
  epsEstimate: 2,
  epsSurprise: 0.1,
  epsSurprisePct: 5,
  revenueActual: 100,
  revenueEstimate: 105,
  revenueSurprise: -5,
  revenueSurprisePct: -4.7619,
  firstSeenAt: null,
  lastSeenAt: null,
};

const gapRow: EarningsGapRow = {
  id: "gap-msft-2026-07-15",
  provider: "tradingview",
  sourceSymbol: "NASDAQ:MSFT",
  ticker: "MSFT",
  exchange: "NASDAQ",
  companyName: "Microsoft",
  sector: "Technology Services",
  industry: "Packaged Software",
  marketCap: 2_900_000_000_000,
  price: 500,
  avgVolume30d: 20_000_000,
  avgDollarVolume30d: 10_000_000_000,
  reportDate: "2026-07-15",
  season: "2026 Q2",
  epsProvider: "tradingview",
  epsActual: 3,
  epsEstimate: 3.1,
  epsSurprise: -0.1,
  epsSurprisePct: -3.23,
  reportTimestamp: null,
  reportTime: "after-market",
  previousClose: 500,
  postmarketPrice: null,
  postmarketVolume: null,
  postmarketGapPct: null,
  reactionDate: "2026-07-16",
  reactionOpen: 520,
  regularOpenGapPct: 4,
  qualifyingGapPct: 4,
  gapSource: "regular_open",
  firstSeenAt: null,
  lastSeenAt: null,
};

test("earnings result view defaults malformed and missing storage to table", () => {
  assert.equal(normalizeEarningsResultView(undefined), "table");
  assert.equal(normalizeEarningsResultView(null), "table");
  assert.equal(normalizeEarningsResultView("multi"), "table");
  assert.equal(normalizeEarningsResultView("table"), "table");
  assert.equal(normalizeEarningsResultView("grid"), "grid");
});

test("grid query preserves active filters and sort while owning pagination", () => {
  const query = buildEarningsGridQuery({
    q: "AAPL",
    sector: "Technology",
    sort: "epsSurprisePct",
    sortDir: "desc",
    limit: 200,
    offset: 600,
  }, 3, 12);
  assert.deepEqual(query, {
    q: "AAPL",
    sector: "Technology",
    sort: "epsSurprisePct",
    sortDir: "desc",
    limit: 12,
    offset: 24,
  });
  assert.equal(buildEarningsGridQuery({}, 9, 100).limit, 48);
});

test("grid snapshots are visible only for the active sorted query", () => {
  const response = { rows: ["AAPL", "MSFT"], total: 2 };
  const snapshot = { queryKey: "reportDate-desc", data: response };
  assert.equal(currentEarningsGridData(snapshot, "reportDate-asc"), null);
  assert.equal(currentEarningsGridData(snapshot, "reportDate-desc"), response);
  assert.equal(currentEarningsGridData(null, "reportDate-desc"), null);
});

test("Surprises adapter emits the exact card metric order and signed formatting", () => {
  const card = surpriseRowToGridCard(surpriseRow);
  assert.equal(card.id, surpriseRow.id);
  assert.deepEqual(card.primaryMetrics.map((item) => item.label), ["Industry", "Mkt Cap", "$ Volume"]);
  assert.deepEqual(card.primaryMetrics.map((item) => item.value), ["Telecommunications Equipment", "3.25T", "12.35B"]);
  assert.deepEqual(card.signedMetrics.map((item) => [item.label, item.value]), [["EPS %", "+5.00%"], ["Rev %", "-4.76%"]]);
  assert.deepEqual(card.expandedMetrics.map((item) => item.label), ["Report Date", "Industry", "Mkt Cap", "$ Volume", "EPS %", "Rev %"]);
  assert.equal(earningsGridMetricClass(card.signedMetrics[0].rawValue), "text-pos");
  assert.equal(earningsGridMetricClass(card.signedMetrics[1].rawValue), "text-neg");
});

test("Gap-Ups adapter emits Best Gap and EPS metrics in order", () => {
  const card = gapRowToGridCard(gapRow);
  assert.deepEqual(card.primaryMetrics.map((item) => item.label), ["Industry", "Mkt Cap", "$ Volume"]);
  assert.deepEqual(card.signedMetrics.map((item) => [item.label, item.value]), [["Best Gap", "+4.00%"], ["EPS %", "-3.23%"]]);
  assert.deepEqual(card.expandedMetrics.map((item) => item.label), ["Report Date", "Industry", "Mkt Cap", "$ Volume", "Best Gap", "EPS %"]);
});

test("missing grid metrics render as dashes without sign coloring", () => {
  const card = surpriseRowToGridCard({
    ...surpriseRow,
    industry: null,
    marketCap: null,
    avgDollarVolume30d: null,
    epsSurprisePct: null,
    revenueSurprisePct: null,
  });
  assert.deepEqual(card.primaryMetrics.map((item) => item.value), ["-", "-", "-"]);
  assert.deepEqual(card.signedMetrics.map((item) => item.value), ["-", "-"]);
  assert.equal(earningsGridMetricClass(card.signedMetrics[0].rawValue), "text-slate-100");
});
