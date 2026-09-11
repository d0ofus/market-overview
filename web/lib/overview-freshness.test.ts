import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveCommentaryFreshnessSummary,
  deriveOverviewFreshnessSummary,
  countActionableOverviewRows,
  type OverviewFreshnessSection,
  type OverviewFreshnessContext,
} from "./overview-freshness";
import type { MarketCommentaryReport, MarketCommentaryDataQuality, WeeklyMarketReviewReport } from "./api";

function sections(rows: OverviewFreshnessSection["groups"][number]["rows"]): OverviewFreshnessSection[] {
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

test("production-shaped fallback data does not report every row as affected", () => {
  const rows: OverviewFreshnessSection["groups"][number]["rows"] = Array.from({ length: 232 }, (_, index) => ({
    ticker: `T${index}`,
    barDate: "2026-07-20",
    barFreshnessStatus: "fresh",
    quoteFreshnessStatus: "fresh",
    sparkline: index === 0 ? null : [98, 99, 100],
    relativeStrength30dVsSpy: index < 11 ? null : [-0.2, 0.1, 0.4],
    currentData: {
      status: "fresh",
      fieldSources: { price: "tradingview", change1d: "tradingview" },
    },
    historyData: { seriesStatus: index === 0 ? "unavailable" : "fallback" },
  }));
  rows.push(...Array.from({ length: 4 }, (_, index) => ({
    ticker: `UNSUPPORTED${index}`,
    quoteFreshnessStatus: "unsupported" as const,
    historyData: { seriesStatus: "unsupported" as const },
  })));

  assert.equal(countActionableOverviewRows(sections(rows)), 1);
});

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

test("overview keeps the publication warning when all closes exist but a long-window metric is unavailable", () => {
  const warning = "The 252-session high is unavailable; verified closes remain visible.";
  const summary = deriveOverviewFreshnessSummary({
    status: status({ freshnessStatus: "partial", servingState: "degraded", freshnessWarning: warning }),
    sections: sections([{ ticker: "SPY", barDate: "2026-06-12", quoteFreshnessStatus: "fresh",
      currentData: { status: "fresh", fieldSources: { price: "alpaca", change1d: "alpaca" } },
      historyData: { seriesStatus: "fresh" }, sparkline: [98, 99, 100] }]),
    dashboardAvailable: true,
  });
  assert.equal(summary?.message, warning);
  assert.equal(summary?.tone, "warning");
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
  assert.equal(summary?.title, "Current-session data incomplete");
  assert.ok(summary?.details.includes("Critical current-data symbols: XOI, VIX"));
});

test("overview freshness treats unsupported rows and optional coverage gaps as informational", () => {
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

  assert.equal(summary, null);
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

  assert.equal(summary?.counts.needsReview, 2);
  assert.equal(summary?.counts.stale, 1);
  assert.equal(summary?.counts.unavailable, 1);
  assert.equal(summary?.counts.unverified, 1);
  assert.ok(summary?.details.includes("2 current-data rows need review"));
});

test("overview freshness does not open an error for usable lagging history", () => {
  const summary = deriveOverviewFreshnessSummary({
    status: status({
      freshnessStatus: "partial",
      freshnessCoveragePct: 50,
      freshnessCurrentCount: 1,
      freshnessEligibleCount: 2,
      freshnessWarning: null,
    }),
    sections: sections([
      {
        ticker: "EATZ",
        barDate: "2026-07-20",
        quoteFreshnessStatus: "fresh",
        barFreshnessStatus: "fresh",
        sparkline: [98, 99, 100],
        historyData: { seriesStatus: "fallback" },
      },
      { ticker: "RSHO", barDate: "2026-06-12", quoteFreshnessStatus: "fresh", barFreshnessStatus: "fresh" },
    ]),
    dashboardAvailable: true,
    auditHref: "#overview-quote-audit",
  });

  assert.equal(summary, null);
});

test("stale fallback is always visible and escalates after one completed trading session", () => {
  const oneSession = deriveOverviewFreshnessSummary({
    status: status({
      asOfDate: "2026-06-11",
      servingState: "stale_fallback",
      staleTradingSessions: 1,
      overviewRecovery: {
        expectedAsOfDate: "2026-06-12",
        status: "refreshing_current",
        sourceCycleId: "cycle-1",
        processedTickers: 160,
        requestedTickers: 225,
        freshTickers: 157,
        unavailableTickers: 3,
        historyCoveragePct: null,
        publicationCoveragePct: null,
        generationId: null,
        lastAttemptAt: "2026-06-12T20:30:00.000Z",
        nextAttemptAt: null,
        lastErrorCode: null,
        lastError: null,
      },
    }),
    sections: sections([{ ticker: "SPY", quoteFreshnessStatus: "fresh" }]),
    dashboardAvailable: true,
  });
  const breached = deriveOverviewFreshnessSummary({
    status: status({
      asOfDate: "2026-06-10",
      servingState: "stale_fallback",
      staleTradingSessions: 2,
    }),
    sections: sections([{ ticker: "SPY", quoteFreshnessStatus: "fresh" }]),
    dashboardAvailable: true,
  });

  assert.equal(oneSession?.tone, "warning");
  assert.equal(oneSession?.title, "Refreshing current data (160/225)");
  assert.equal(breached?.tone, "danger");
  assert.equal(breached?.title, "Overview more than one trading session old");
});

test("retrying and blocked recovery states expose actionable copy", () => {
  const recoveryBase = {
    expectedAsOfDate: "2026-06-12",
    sourceCycleId: "cycle-1",
    processedTickers: 225,
    requestedTickers: 225,
    freshTickers: 220,
    unavailableTickers: 5,
    historyCoveragePct: 100,
    publicationCoveragePct: 97.7,
    generationId: null,
    lastAttemptAt: "2026-06-12T21:00:00.000Z",
    nextAttemptAt: "2026-06-12T21:05:00.000Z",
    lastErrorCode: "publication_error",
    lastError: "Temporary D1 failure.",
  };
  const retrying = deriveOverviewFreshnessSummary({
    status: status({ overviewRecovery: { ...recoveryBase, status: "retrying" } }),
    sections: sections([{ ticker: "SPY", quoteFreshnessStatus: "fresh" }]),
    dashboardAvailable: true,
  });
  const blocked = deriveOverviewFreshnessSummary({
    status: status({ overviewRecovery: { ...recoveryBase, status: "blocked" } }),
    sections: sections([{ ticker: "SPY", quoteFreshnessStatus: "fresh" }]),
    dashboardAvailable: true,
  });

  assert.equal(retrying?.title, "Current data ready — publication recovering");
  assert.match(retrying?.message ?? "", /Temporary D1 failure/);
  assert.equal(blocked?.title, "Overview publication blocked");
  assert.ok(blocked?.details.some((detail) => detail.startsWith("Problem:")));
  assert.ok(blocked?.details.some((detail) => detail.startsWith("Impact:")));
  assert.ok(blocked?.details.some((detail) => detail.startsWith("Next step:")));
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

test("an older successful weekly report remains dated when the current week is unavailable", () => {
  const report: WeeklyMarketReviewReport = {
    id: "last-good", weekStart: "2026-08-31", weekEnd: "2026-09-04", generatedAt: "2026-09-05T04:30:00Z",
    asOf: "2026-09-04", provider: "factual", model: "verified", generationProvider: "gemini_fallback",
    generationMode: "scheduled_fallback", status: "ready", title: "Last successful weekly report", marketTone: null,
    reviewMarkdown: "Dated facts", sections: {}, keyTickers: [], sourceAudit: [], dataQuality: [], sourceSnapshot: {}, error: null,
  };
  const summary = deriveCommentaryFreshnessSummary({
    mode: "weekly", status: "empty", report, expectedWeekEnd: "2026-09-11", dataQuality: [],
  });
  assert.equal(summary.tone, "warning");
  assert.equal(summary.label, "Old report");
  assert.match(summary.message ?? "", /2026-09-04.*2026-09-11/);
  const failed = deriveCommentaryFreshnessSummary({
    mode: "weekly", status: "failed", report, expectedWeekEnd: "2026-09-11", dataQuality: [],
    warning: "Current week failed; showing separately dated last success.",
  });
  assert.equal(failed.label, "Failed");
  assert.match(failed.message ?? "", /Current week failed/);
});
