import type {
  MarketCommentaryDataQuality,
  MarketCommentaryReport,
  MarketCommentaryResponse,
  WeeklyMarketReviewReport,
  WeeklyMarketReviewResponse,
} from "./api";
import type { QuoteFreshnessStatus } from "../types/dashboard";

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
};

export type OverviewFreshnessSection = {
  groups: Array<{
    rows: Array<{
      barDate?: string | null;
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

function normalizeRowStatus(row: { quoteFreshnessStatus?: QuoteFreshnessStatus; barDate?: string | null }): QuoteFreshnessStatus {
  return row.quoteFreshnessStatus ?? (row.barDate ? "fresh" : "unavailable");
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
    return `Quote overlay ${returned}/${requested}${missing ? `; missing ${missing}` : ""}`;
  }
  if (status.quoteOverlayError) return `Quote overlay error: ${status.quoteOverlayError}`;
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
  };

  for (const section of sections) {
    for (const group of section.groups) {
      for (const row of group.rows) {
        counts.totalRows += 1;
        const rowStatus = normalizeRowStatus(row);
        if (rowStatus === "fresh") continue;
        counts.needsReview += 1;
        if (rowStatus === "stale") counts.stale += 1;
        if (rowStatus === "unavailable") counts.unavailable += 1;
        if (rowStatus === "unsupported") counts.unverified += 1;
      }
    }
  }

  const criticalTickers = compactTickerList(status.freshnessCriticalMissingTickers);
  const coverage = coverageDetail(status);
  const overlay = quoteOverlayDetail(status);
  const missingFreshness = !status.freshnessStatus;
  const hasOverlayGap = Boolean(overlay);
  const hasProblems = !dashboardAvailable
    || missingFreshness
    || status.freshnessStatus !== "fresh"
    || counts.needsReview > 0
    || hasOverlayGap;

  if (!hasProblems) return null;

  const tone: Exclude<FreshnessTone, "ok"> = !dashboardAvailable
    || missingFreshness
    || status.freshnessStatus === "stale"
    || Boolean(criticalTickers)
    || counts.stale > 0
    || counts.unavailable > 0
    ? "danger"
    : "warning";

  const details = [
    counts.needsReview > 0 ? `${counts.needsReview} rows need review` : null,
    counts.stale > 0 ? `${counts.stale} stale` : null,
    counts.unavailable > 0 ? `${counts.unavailable} unavailable` : null,
    counts.unverified > 0 ? `${counts.unverified} unverified` : null,
    coverage,
    criticalTickers ? `Critical stale symbols: ${criticalTickers}` : null,
    overlay,
  ].filter((detail): detail is string => Boolean(detail));

  const title = !dashboardAvailable
    ? "Overview data unavailable"
    : missingFreshness
      ? "Overview freshness unknown"
      : status.freshnessStatus === "stale" || Boolean(criticalTickers) || counts.stale > 0 || counts.unavailable > 0
        ? "Stale overview data"
        : status.freshnessStatus === "partial"
          ? "Partial overview freshness"
          : counts.unverified > 0
            ? "Unverified overview rows"
            : "Partial quote freshness";

  const message = status.freshnessWarning
    ?? (!dashboardAvailable
      ? "Overview market data could not be loaded. Refresh before relying on commentary or tables."
      : missingFreshness
        ? "Freshness diagnostics are missing for the displayed Overview data."
        : status.freshnessStatus === "partial"
          ? "Some Overview rows are not current. Use the quote audit before acting on this dashboard."
          : "Quote freshness is incomplete. Use the quote audit before acting on this dashboard.");

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
