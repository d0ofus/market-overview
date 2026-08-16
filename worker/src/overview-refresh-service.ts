import type { Env } from "./types";

export type OverviewPageRefreshResult = {
  page: "overview";
  refreshedTickers: number;
  notes?: string;
  generationId?: string;
  publishedAt?: string;
  currentCoveragePct?: number;
  historyExactCoveragePct?: number;
  historyUsableCoveragePct?: number;
  canonicalSession?: string;
  historyRefreshStatus?: string;
  historyErrorCode?: string | null;
  historyNextAttemptAt?: string | null;
  publicationStatus: "published" | "recovering" | "blocked";
  publicationNextAttemptAt?: string | null;
  publicationErrorCode?: string | null;
  publicationError?: string | null;
};

export type OverviewPageRefreshDeps = {
  loadOverviewTickers(env: Env): Promise<string[]>;
  refreshAndStoreOverviewSnapshot(env: Env, options?: {
    forceCurrentData?: boolean;
    refreshAllOverviewExactBars?: boolean;
  }): Promise<{
    snapshotId: string | null;
    asOfDate: string;
    generatedAt: string | null;
    currentCoveragePct: number;
    historyExactCoveragePct: number;
    historyUsableCoveragePct: number;
    fetchedRows?: number;
    writtenRows?: number;
    canonicalSession?: string;
    historyRefreshStatus?: string;
    historyErrorCode?: string | null;
    historyNextAttemptAt?: string | null;
    publicationStatus?: "published" | "recovering" | "blocked";
    publicationNextAttemptAt?: string | null;
    publicationErrorCode?: string | null;
    publicationError?: string | null;
    freshness: {
      status: string;
      currentCount: number;
      eligibleCount: number;
      coveragePct: number;
    };
  }>;
};

export async function refreshOverviewPageData(
  env: Env,
  deps: OverviewPageRefreshDeps,
): Promise<OverviewPageRefreshResult> {
  const tickers = await deps.loadOverviewTickers(env);
  const result = await deps.refreshAndStoreOverviewSnapshot(env, {
    forceCurrentData: true,
    refreshAllOverviewExactBars: true,
  });
  const rowSummary = typeof result.fetchedRows === "number" || typeof result.writtenRows === "number"
    ? ` Fetched ${result.fetchedRows ?? 0} rows; wrote ${result.writtenRows ?? 0}.`
    : "";
  const catchUpSummary = result.historyExactCoveragePct >= 95
    ? ""
    : " Broad post-close daily-bar catch-up will continue through the scheduled worker job.";
  const publicationStatus = result.publicationStatus ?? "published";
  const qualityStatus = result.currentCoveragePct >= 95 ? "fresh" : "degraded";
  const response: OverviewPageRefreshResult = {
    page: "overview",
    refreshedTickers: tickers.length,
    publicationStatus,
    currentCoveragePct: result.currentCoveragePct,
    historyExactCoveragePct: result.historyExactCoveragePct,
    historyUsableCoveragePct: result.historyUsableCoveragePct,
    canonicalSession: result.canonicalSession ?? result.asOfDate,
    notes: publicationStatus === "published"
      ? `Published overview generation ${result.snapshotId} with ${qualityStatus} current-data coverage (${result.currentCoveragePct.toFixed(1)}%). Exact-session history is ${result.historyExactCoveragePct.toFixed(1)}% and usable history is ${result.historyUsableCoveragePct.toFixed(1)}%.${catchUpSummary}${rowSummary}`
      : publicationStatus === "blocked"
        ? `Overview publication is blocked: ${result.publicationError ?? "the current-data publication gate was not met"}. The last-ready generation remains available.`
        : `Overview publication is recovering${result.publicationError ? `: ${result.publicationError}.` : "."} Scheduled reconciliation will retry automatically.`,
  };
  if (publicationStatus === "published" && result.snapshotId && result.generatedAt) {
    response.generationId = result.snapshotId;
    response.publishedAt = result.generatedAt;
  }
  response.publicationNextAttemptAt = result.publicationNextAttemptAt ?? null;
  response.publicationErrorCode = result.publicationErrorCode ?? null;
  response.publicationError = result.publicationError ?? null;
  if (result.historyRefreshStatus) {
    response.historyRefreshStatus = result.historyRefreshStatus;
    response.historyErrorCode = result.historyErrorCode ?? null;
    response.historyNextAttemptAt = result.historyNextAttemptAt ?? null;
  }
  return response;
}
