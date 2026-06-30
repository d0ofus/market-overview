import type {
  MarketCommentaryDataQuality,
  MarketCommentaryReport,
  MarketCommentaryResponse,
  WeeklyMarketReviewReport,
  WeeklyMarketReviewResponse,
} from "./api";
import type { BarFreshnessStatus, QuoteFreshnessStatus } from "../types/dashboard";

export type OverviewFreshnessStatus = "fresh" | "partial" | "stale";
export type FreshnessTone = "ok" | "warning" | "danger";

export type OverviewFreshnessContext = {
  asOfDate: string | null;
  expectedAsOfDate?: string | null;
  freshnessStatus?: OverviewFreshnessStatus;
  freshnessCoveragePct?: number | null;
  freshnessCurrentCount?: number | null;
  freshnessEligibleCount?: number | null;
  freshnessCriticalMissingTickers?: string[];
  freshnessWarning?: string | null;
  quoteOverlayRequestedCount?: number | null;
  quoteOverlayReturnedCount?: number | null;
  quoteOverlayError?: string | null;
  quoteOverlayMissingSample?: string[];
  breadthExpectedAsOfDate?: string | null;
  breadthStatus?: OverviewFreshnessStatus;
  breadthLatestAsOfDate?: string | null;
  breadthLastUpdated?: string | null;
  breadthWarning?: string | null;
  breadthDiagnostics?: Array<{
    universeId: string;
    expectedAsOfDate: string;
    latestAsOfDate: string | null;
    latestGeneratedAt: string | null;
    memberCount: number;
    currentDateTickers: number;
    coveragePct: number;
    minCoveragePct: number;
    status: "fresh" | "stale" | "missing" | "low_coverage";
    reason: string;
  }>;
};

export type OverviewFreshnessSection = {
  groups: Array<{
    rows: Array<{
      barDate?: string | null;
      barFreshnessStatus?: BarFreshnessStatus;
      quoteFreshnessStatus?: QuoteFreshnessStatus;
    }>;
  }>;
};

export type OverviewFreshnessSummary = {
  tone: Exclude<FreshnessTone, "ok">;
  label: string;
  title: string;
  message: string;
  details: string[];
  auditHref: string | null;
  counts: {
    totalRows: number;
    needsReview: number;
    stale: number;
    unavailable: number;
    unverified: number;
    historyNeedsReview: number;
    historyStale: number;
    historyUnavailable: number;
  };
};

export type CommentaryFreshnessMode = "daily" | "weekly";

export type CommentaryFreshnessInput = {
  mode: CommentaryFreshnessMode;
  status: MarketCommentaryResponse["status"] | WeeklyMarketReviewResponse["status"];
  warning?: string | null;
  report?: MarketCommentaryReport | WeeklyMarketReviewReport | null;
  dataQuality: MarketCommentaryDataQuality[];
  overview?: OverviewFreshnessContext | null;
};

export type CommentaryFreshnessSummary = {
  tone: FreshnessTone;
  label: string;
  message: string | null;
  issues: string[];
};

function normalizeQuoteStatus(row: { quoteFreshnessStatus?: QuoteFreshnessStatus }): QuoteFreshnessStatus {
  return row.quoteFreshnessStatus ?? "unavailable";
}

function normalizeBarStatus(row: { barFreshnessStatus?: BarFreshnessStatus; barDate?: string | null }): BarFreshnessStatus {
  return row.barFreshnessStatus ?? (row.barDate ? "fresh" : "unavailable");
}

function compactTickerList(tickers: string[] | undefined, limit = 6): string | null {
  const unique = Array.from(new Set((tickers ?? []).map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  if (unique.length === 0) return null;
  const shown = unique.slice(0, limit).join(", ");
  const extra = unique.length > limit ? ` +${unique.length - limit} more` : "";
  return `${shown}${extra}`;
}

function coverageDetail(status: OverviewFreshnessContext): string | null {
  const current = status.freshnessCurrentCount;
  const eligible = status.freshnessEligibleCount;
  const pct = status.freshnessCoveragePct;
  if (
    typeof current !== "number"
    || typeof eligible !== "number"
    || eligible <= 0
    || typeof pct !== "number"
  ) {
    return null;
  }
  return `Coverage ${current}/${eligible} (${pct.toFixed(1)}%)`;
}

function quoteOverlayDetail(status: OverviewFreshnessContext): string | null {
  const requested = status.quoteOverlayRequestedCount;
  const returned = status.quoteOverlayReturnedCount;
  if (typeof requested === "number" && requested > 0 && typeof returned === "number" && returned < requested) {
    const missing = compactTickerList(status.quoteOverlayMissingSample, 5);
    return `Live quote snapshots ${returned}/${requested}${missing ? `; missing ${missing}` : ""}`;
  }
  if (status.quoteOverlayError) return `Live quote snapshot error: ${status.quoteOverlayError}`;
  return null;
}

export function deriveOverviewFreshnessSummary({
  status,
  sections,
  dashboardAvailable,
  auditHref = null,
}: {
  status: OverviewFreshnessContext;
  sections: OverviewFreshnessSection[];
  dashboardAvailable: boolean;
  auditHref?: string | null;
}): OverviewFreshnessSummary | null {
  const counts = {
    totalRows: 0,
    needsReview: 0,
    stale: 0,
    unavailable: 0,
    unverified: 0,
    historyNeedsReview: 0,
    historyStale: 0,
    historyUnavailable: 0,
  };

  for (const section of sections) {
    for (const group of section.groups) {
      for (const row of group.rows) {
        counts.totalRows += 1;
        const quoteStatus = normalizeQuoteStatus(row);
        if (quoteStatus !== "fresh") {
          counts.needsReview += 1;
          if (quoteStatus === "stale") counts.stale += 1;
          if (quoteStatus === "unavailable") counts.unavailable += 1;
          if (quoteStatus === "unsupported") counts.unverified += 1;
        }
        const barStatus = normalizeBarStatus(row);
        if (barStatus !== "fresh") {
          counts.historyNeedsReview += 1;
          if (barStatus === "stale") counts.historyStale += 1;
          if (barStatus === "unavailable") counts.historyUnavailable += 1;
        }
      }
    }
  }

  const criticalTickers = compactTickerList(status.freshnessCriticalMissingTickers);
  const coverage = coverageDetail(status);
  const overlay = quoteOverlayDetail(status);
  const missingFreshness = !status.freshnessStatus;
  const hasOverlayGap = Boolean(overlay);
  const hasQuoteProblems = counts.needsReview > 0 || hasOverlayGap;
  const hasHistoryProblems = status.freshnessStatus !== "fresh" || counts.historyNeedsReview > 0;
  const hasBreadthProblems = Boolean(status.breadthStatus && status.breadthStatus !== "fresh");
  const hasProblems = !dashboardAvailable
    || missingFreshness
    || hasQuoteProblems
    || hasHistoryProblems
    || hasBreadthProblems;

  if (!hasProblems) return null;

  const hasDangerQuoteProblem = counts.stale > 0 || counts.unavailable > 0;
  const tone: Exclude<FreshnessTone, "ok"> = !dashboardAvailable
    || missingFreshness
    || hasDangerQuoteProblem
    ? "danger"
    : "warning";

  const details = [
    counts.needsReview > 0 ? `${counts.needsReview} live quote rows need review` : null,
    counts.stale > 0 ? `${counts.stale} live quote stale` : null,
    counts.unavailable > 0 ? `${counts.unavailable} live quote unavailable` : null,
    counts.unverified > 0 ? `${counts.unverified} quote unverified` : null,
    counts.historyNeedsReview > 0 ? `${counts.historyNeedsReview} history rows need review` : null,
    counts.historyStale > 0 ? `${counts.historyStale} history stale` : null,
    counts.historyUnavailable > 0 ? `${counts.historyUnavailable} history unavailable` : null,
    coverage,
    criticalTickers ? `Critical historical symbols: ${criticalTickers}` : null,
    overlay,
    hasBreadthProblems ? status.breadthWarning ?? `Breadth data is ${status.breadthStatus}.` : null,
  ].filter((detail): detail is string => Boolean(detail));

  const title = !dashboardAvailable
    ? "Overview data unavailable"
    : missingFreshness
      ? "Overview freshness unknown"
      : hasDangerQuoteProblem
        ? "Live quote freshness incomplete"
        : status.freshnessStatus === "stale" || counts.historyStale > 0 || counts.historyUnavailable > 0
          ? "Historical overview data stale"
          : status.freshnessStatus === "partial" || counts.historyNeedsReview > 0
            ? "Historical overview data partial"
            : hasBreadthProblems
              ? "Breadth data stale"
            : counts.unverified > 0
              ? "Unverified overview quote rows"
              : "Partial live quote coverage";

  const message = status.freshnessWarning
    ?? (!dashboardAvailable
      ? "Overview market data could not be loaded. Refresh before relying on commentary or tables."
      : missingFreshness
        ? "Freshness diagnostics are missing for the displayed Overview data."
        : hasQuoteProblems
          ? "Live quote snapshots are incomplete. Use the quote audit before acting on this dashboard."
          : hasBreadthProblems
            ? "Live quotes and overview snapshot are current, but breadth history is lagging."
          : "Live quotes are current, but stored daily bars are lagging for historical metrics.");

  return {
    tone,
    label: tone === "danger" ? "Needs review" : "Partial freshness",
    title,
    message,
    details,
    auditHref,
    counts,
  };
}

function reportSessionDate(report: MarketCommentaryReport | WeeklyMarketReviewReport | null | undefined): string | null {
  if (!report) return null;
  return "sessionDate" in report ? report.sessionDate : report.weekEnd;
}

function overviewExpectedDate(overview?: OverviewFreshnessContext | null): string | null {
  return overview?.expectedAsOfDate ?? overview?.asOfDate ?? null;
}

function issueTone(status: MarketCommentaryDataQuality["status"]): FreshnessTone {
  return status === "unavailable" ? "danger" : "warning";
}

export function deriveCommentaryFreshnessSummary(input: CommentaryFreshnessInput): CommentaryFreshnessSummary {
  if (input.status === "failed") {
    return {
      tone: "danger",
      label: "Failed",
      message: input.warning ?? input.report?.error ?? "Commentary generation failed.",
      issues: [input.warning ?? input.report?.error ?? "Commentary generation failed."],
    };
  }

  if (!input.report) {
    return {
      tone: input.status === "empty" ? "warning" : "ok",
      label: input.status === "empty" ? "No report" : "Loading",
      message: input.status === "empty" ? "No cached commentary report is available." : null,
      issues: [],
    };
  }

  const issues: string[] = [];
  let tone: FreshnessTone = "ok";
  let label = "Source data fresh";

  const reportDate = reportSessionDate(input.report);
  const expectedDate = overviewExpectedDate(input.overview);
  if (input.mode === "daily" && reportDate && expectedDate && reportDate < expectedDate) {
    tone = "warning";
    label = "Old report";
    issues.push(`Commentary is for ${reportDate}; Overview expects ${expectedDate}.`);
  }

  if (input.overview?.freshnessStatus === "stale") {
    tone = "danger";
    label = "Stale overview";
    issues.push(input.overview.freshnessWarning ?? "Overview source data is stale.");
  } else if (input.overview?.freshnessStatus === "partial") {
    tone = "warning";
    if (label === "Source data fresh") label = "Partial overview";
    if (input.overview.freshnessWarning) issues.push(input.overview.freshnessWarning);
  }

  const qualityIssues = input.dataQuality.filter((item) => item.status !== "ok");
  for (const item of qualityIssues) {
    const nextTone = issueTone(item.status);
    if (nextTone === "danger") tone = "danger";
    else if (tone === "ok") tone = "warning";
    issues.push(`${item.metric}: ${item.note}`);
  }

  if (qualityIssues.length > 0 && label === "Source data fresh") {
    const hasPartial = qualityIssues.some((item) => /partial/i.test(item.note));
    const hasStale = qualityIssues.some((item) => item.status === "stale");
    const hasUnavailable = qualityIssues.some((item) => item.status === "unavailable" || item.status === "not_configured");
    label = hasUnavailable ? "Source gaps" : hasPartial ? "Partial sources" : hasStale ? "Stale sources" : "Check sources";
  }

  return {
    tone,
    label,
    message: issues[0] ?? null,
    issues,
  };
}
