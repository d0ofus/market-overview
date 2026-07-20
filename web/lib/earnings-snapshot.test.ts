import assert from "node:assert/strict";
import test from "node:test";
import type { EarningsSurpriseRow } from "./api";
import {
  earningsSnapshotFilterQuery,
  sliceEarningsSnapshotRows,
  sortEarningsSnapshotRows,
} from "./earnings-snapshot";

function row(overrides: Partial<EarningsSurpriseRow>): EarningsSurpriseRow {
  return {
    id: "row-a",
    provider: "tradingview",
    sourceSymbol: "NASDAQ:AAPL",
    ticker: "AAPL",
    exchange: "NASDAQ",
    companyName: "Apple",
    sector: "Technology",
    industry: "Hardware",
    marketCap: 1,
    avgDollarVolume30d: 1,
    reportDate: "2026-07-15",
    reportTimestamp: null,
    reportTime: null,
    fiscalPeriodEnd: null,
    season: "2026 Q2",
    epsActual: 1,
    epsEstimate: 1,
    epsSurprise: 0,
    epsSurprisePct: 0,
    revenueActual: null,
    revenueEstimate: null,
    revenueSurprise: null,
    revenueSurprisePct: null,
    qualifyingGapPct: null,
    regularOpenGapPct: null,
    firstSeenAt: null,
    lastSeenAt: null,
    ...overrides,
  };
}

test("sorts the complete snapshot with SQL-compatible null placement", () => {
  const rows = [
    row({ id: "null", ticker: "NULL", epsSurprisePct: null }),
    row({ id: "negative", ticker: "NEG", epsSurprisePct: -2 }),
    row({ id: "positive", ticker: "POS", epsSurprisePct: 5 }),
  ];
  assert.deepEqual(sortEarningsSnapshotRows(rows, "epsSurprisePct", "asc").map((item) => item.id), ["null", "negative", "positive"]);
  assert.deepEqual(sortEarningsSnapshotRows(rows, "epsSurprisePct", "desc").map((item) => item.id), ["positive", "negative", "null"]);
});

test("sorts nullable Surprise gap enrichment with SQL-compatible null placement", () => {
  const rows = [
    row({ id: "missing", ticker: "MISS", qualifyingGapPct: null, regularOpenGapPct: null }),
    row({ id: "small", ticker: "SMALL", qualifyingGapPct: 2, regularOpenGapPct: 1 }),
    row({ id: "large", ticker: "LARGE", qualifyingGapPct: 8, regularOpenGapPct: 6 }),
  ];
  assert.deepEqual(sortEarningsSnapshotRows(rows, "qualifyingGapPct", "asc").map((item) => item.id), ["missing", "small", "large"]);
  assert.deepEqual(sortEarningsSnapshotRows(rows, "qualifyingGapPct", "desc").map((item) => item.id), ["large", "small", "missing"]);
  assert.deepEqual(sortEarningsSnapshotRows(rows, "regularOpenGapPct", "desc").map((item) => item.id), ["large", "small", "missing"]);
});

test("uses ticker, report date, and id as deterministic tie-breakers", () => {
  const rows = [
    row({ id: "z", ticker: "MSFT", reportDate: "2026-07-15", marketCap: 10 }),
    row({ id: "b", ticker: "AAPL", reportDate: "2026-07-14", marketCap: 10 }),
    row({ id: "a", ticker: "AAPL", reportDate: "2026-07-14", marketCap: 10 }),
    row({ id: "new", ticker: "AAPL", reportDate: "2026-07-16", marketCap: 10 }),
  ];
  assert.deepEqual(sortEarningsSnapshotRows(rows, "marketCap", "desc").map((item) => item.id), ["new", "a", "b", "z"]);
});

test("sorts report dates descending and paginates locally", () => {
  const rows = [
    row({ id: "old", reportDate: "2026-07-14" }),
    row({ id: "new", reportDate: "2026-07-16" }),
    row({ id: "middle", reportDate: "2026-07-15" }),
  ];
  const sorted = sortEarningsSnapshotRows(rows, "reportDate", "desc");
  assert.deepEqual(sorted.map((item) => item.id), ["new", "middle", "old"]);
  assert.deepEqual(sliceEarningsSnapshotRows(sorted, 1, 1).map((item) => item.id), ["middle"]);
  assert.deepEqual(sliceEarningsSnapshotRows(sorted, 0, 100).map((item) => item.id), ["new", "middle", "old"]);
});

test("snapshot request identity excludes local sorting and pagination", () => {
  const first = earningsSnapshotFilterQuery({
    q: "AAPL",
    sector: "Technology",
    sort: "reportDate",
    sortDir: "desc",
    limit: 200,
    offset: 0,
  });
  const second = earningsSnapshotFilterQuery({
    q: "AAPL",
    sector: "Technology",
    sort: "epsSurprisePct",
    sortDir: "asc",
    limit: 25,
    offset: 500,
  });
  assert.deepEqual(first, { q: "AAPL", sector: "Technology" });
  assert.deepEqual(second, first);
});
