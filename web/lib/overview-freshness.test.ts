import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveCommentaryFreshnessSummary,
  deriveOverviewFreshnessSummary,
  type OverviewFreshnessSection,
  type OverviewFreshnessContext,
} from "./overview-freshness";
import type { MarketCommentaryReport, MarketCommentaryDataQuality } from "./api";
import type { BarFreshnessStatus, QuoteFreshnessStatus } from "../types/dashboard";

function sections(rows: Array<{ ticker: string; barDate?: string | null; barFreshnessStatus?: BarFreshnessStatus; quoteFreshnessStatus?: QuoteFreshnessStatus }>): OverviewFreshnessSection[] {
  return [
    {
      groups: [
        {
          rows,
        },
      ],
    },
  ];
}

function status(overrides: Partial<OverviewFreshnessContext> = {}): OverviewFreshnessContext {
  return {
    asOfDate: "2026-06-12",
    expectedAsOfDate: "2026-06-12",
    freshnessStatus: "fresh",
    freshnessCoveragePct: 100,
    freshnessCurrentCount: 4,
    freshnessEligibleCount: 4,
    freshnessCriticalMissingTickers: [],
    freshnessWarning: null,
    quoteOverlayRequestedCount: 4,
    quoteOverlayReturnedCount: 4,
    quoteOverlayError: null,
    quoteOverlayMissingSample: [],
    ...overrides,
  };
}

function dailyReport(overrides: Partial<MarketCommentaryReport> = {}): MarketCommentaryReport {
  return {
    id: "report-1",
    sessionDate: "2026-06-12",
    asOf: "2026-06-12T21:00:00.000Z",
    generatedAt: "2026-06-12T21:05:00.000Z",
    marketSession: "after_hours",
    marketSessionLabel: "Post-close",
    dataBasis: "closing",
    provider: "gemini",
    model: "gemini-test",
    status: "ready",
    reportMarkdown: "Market commentary",
    sourceAudit: [],
    dataQuality: [],
    error: null,
    ...overrides,
  };
}

test("overview freshness hides the banner when status and rows are fresh", () => {
  const summary = deriveOverviewFreshnessSummary({
    status: status(),
    sections: sections([
      { ticker: "SPY", barDate: "2026-06-12", quoteFreshnessStatus: "fresh" },
      { ticker: "QQQ", barDate: "2026-06-12", quoteFreshnessStatus: "fresh" },
    ]),
    dashboardAvailable: true,
    auditHref: "#overview-quote-audit",
  });

  assert.equal(summary, null);
});

test("overview freshness marks stale critical symbols as danger", () => {
  const summary = deriveOverviewFreshnessSummary({
    status: status({
      freshnessStatus: "stale",
      freshnessCoveragePct: 50,
      freshnessCurrentCount: 2,
      freshnessEligibleCount: 4,
      freshnessCriticalMissingTickers: ["XOI", "VIX"],
      freshnessWarning: "Stale: critical overview tickers are not current.",
    }),
    sections: sections([{ ticker: "XOI", barDate: "2026-06-10", quoteFreshnessStatus: "stale" }]),
    dashboardAvailable: true,
    auditHref: "#overview-quote-audit",
  });

  assert.equal(summary?.tone, "danger");
  assert.equal(summary?.title, "Live quote freshness incomplete");
  assert.ok(summary?.details.includes("Critical historical symbols: XOI, VIX"));
});

test("overview freshness marks partial coverage as a warning", () => {
  const summary = deriveOverviewFreshnessSummary({
    status: status({
      freshnessStatus: "partial",
      freshnessCoveragePct: 75,
      freshnessCurrentCount: 3,
      freshnessEligibleCount: 4,
      freshnessWarning: "Partial freshness.",
    }),
    sections: sections([
      { ticker: "SPY", barDate: "2026-06-12", quoteFreshnessStatus: "fresh" },
      { ticker: "IBIT", barDate: "2026-06-12", quoteFreshnessStatus: "unsupported" },
    ]),
    dashboardAvailable: true,
    auditHref: "#overview-quote-audit",
  });

  assert.equal(summary?.tone, "warning");
  assert.equal(summary?.title, "Historical overview data partial");
  assert.ok(summary?.details.includes("Coverage 3/4 (75.0%)"));
});

test("overview freshness counts stale, unavailable, and unverified rows", () => {
  const summary = deriveOverviewFreshnessSummary({
    status: status(),
    sections: sections([
      { ticker: "SPY", barDate: "2026-06-10", quoteFreshnessStatus: "stale" },
      { ticker: "QQQ", barDate: null, quoteFreshnessStatus: "unavailable" },
      { ticker: "IBIT", barDate: "2026-06-12", quoteFreshnessStatus: "unsupported" },
    ]),
    dashboardAvailable: true,
    auditHref: "#overview-quote-audit",
  });

  assert.equal(summary?.counts.needsReview, 3);
  assert.equal(summary?.counts.stale, 1);
  assert.equal(summary?.counts.unavailable, 1);
  assert.equal(summary?.counts.unverified, 1);
  assert.ok(summary?.details.includes("3 live quote rows need review"));
});

test("overview freshness separates fresh live quotes from stale history", () => {
  const summary = deriveOverviewFreshnessSummary({
    status: status({
      freshnessStatus: "partial",
      freshnessCoveragePct: 50,
      freshnessCurrentCount: 1,
      freshnessEligibleCount: 2,
      freshnessWarning: null,
    }),
    sections: sections([
      { ticker: "EATZ", barDate: "2026-05-06", quoteFreshnessStatus: "fresh", barFreshnessStatus: "stale" },
      { ticker: "RSHO", barDate: "2026-06-12", quoteFreshnessStatus: "fresh", barFreshnessStatus: "fresh" },
    ]),
    dashboardAvailable: true,
    auditHref: "#overview-quote-audit",
  });

  assert.equal(summary?.tone, "warning");
  assert.equal(summary?.title, "Historical overview data stale");
  assert.equal(summary?.counts.needsReview, 0);
  assert.equal(summary?.counts.historyNeedsReview, 1);
  assert.ok(summary?.message.includes("Live quotes are current"));
});

test("overview freshness reports stale breadth separately from live quotes", () => {
  const summary = deriveOverviewFreshnessSummary({
    status: status({
      breadthStatus: "stale",
      breadthExpectedAsOfDate: "2026-06-12",
      breadthLatestAsOfDate: "2026-06-10",
      breadthWarning: "Breadth history is not current for 2026-06-12: sp500-core 2026-06-10.",
    }),
    sections: sections([
      { ticker: "SPY", barDate: "2026-06-12", quoteFreshnessStatus: "fresh", barFreshnessStatus: "fresh" },
      { ticker: "QQQ", barDate: "2026-06-12", quoteFreshnessStatus: "fresh", barFreshnessStatus: "fresh" },
    ]),
    dashboardAvailable: true,
    auditHref: "#overview-quote-audit",
  });

  assert.equal(summary?.tone, "warning");
  assert.equal(summary?.title, "Breadth data stale");
  assert.equal(summary?.counts.needsReview, 0);
  assert.ok(summary?.details.includes("Breadth history is not current for 2026-06-12: sp500-core 2026-06-10."));
  assert.match(summary?.message ?? "", /breadth history is lagging/i);
});

test("commentary freshness labels failed reports", () => {
  const summary = deriveCommentaryFreshnessSummary({
    mode: "daily",
    status: "failed",
    warning: "Overview market data is stale.",
    report: dailyReport({ status: "failed", error: "Overview market data is stale." }),
    dataQuality: [],
  });

  assert.equal(summary.tone, "danger");
  assert.equal(summary.label, "Failed");
  assert.match(summary.message ?? "", /stale/i);
});

test("commentary freshness labels partial or stale source data", () => {
  const quality: MarketCommentaryDataQuality[] = [
    {
      metric: "Existing dashboard snapshot",
      status: "stale",
      note: "Loaded partial snapshot as of 2026-06-12; 80/224 tickers current.",
    },
  ];
  const summary = deriveCommentaryFreshnessSummary({
    mode: "daily",
    status: "ready",
    report: dailyReport(),
    dataQuality: quality,
  });

  assert.equal(summary.tone, "warning");
  assert.equal(summary.label, "Partial sources");
  assert.match(summary.message ?? "", /Existing dashboard snapshot/);
});

test("commentary freshness labels old cached daily reports", () => {
  const summary = deriveCommentaryFreshnessSummary({
    mode: "daily",
    status: "ready",
    report: dailyReport({ sessionDate: "2026-06-10" }),
    dataQuality: [],
    overview: status({ asOfDate: "2026-06-12", expectedAsOfDate: "2026-06-12" }),
  });

  assert.equal(summary.tone, "warning");
  assert.equal(summary.label, "Old report");
  assert.match(summary.message ?? "", /2026-06-10/);
});

test("commentary freshness labels clean ready reports as fresh", () => {
  const summary = deriveCommentaryFreshnessSummary({
    mode: "daily",
    status: "ready",
    report: dailyReport(),
    dataQuality: [{ metric: "Existing dashboard snapshot", status: "ok", note: "Fresh." }],
    overview: status(),
  });

  assert.equal(summary.tone, "ok");
  assert.equal(summary.label, "Source data fresh");
  assert.equal(summary.message, null);
});
