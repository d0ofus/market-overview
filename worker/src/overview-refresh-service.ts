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
};

export type OverviewPageRefreshDeps = {
  loadOverviewTickers(env: Env): Promise<string[]>;
  refreshAndStoreOverviewSnapshot(env: Env, options?: {
    requireFreshness?: boolean;
    forceCurrentData?: boolean;
    refreshAllOverviewExactBars?: boolean;
  }): Promise<{
    snapshotId: string;
    asOfDate: string;
    generatedAt: string;
    currentCoveragePct: number;
    historyExactCoveragePct: number;
    historyUsableCoveragePct: number;
    fetchedRows?: number;
    writtenRows?: number;
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
    requireFreshness: false,
    forceCurrentData: true,
    refreshAllOverviewExactBars: true,
  });
  const rowSummary = typeof result.fetchedRows === "number" || typeof result.writtenRows === "number"
    ? ` Fetched ${result.fetchedRows ?? 0} rows; wrote ${result.writtenRows ?? 0}.`
    : "";
  const catchUpSummary = result.historyExactCoveragePct >= 95
    ? ""
    : " Broad post-close daily-bar catch-up will continue through the scheduled worker job.";
  const publicationStatus = result.currentCoveragePct >= 95 ? "fresh" : "degraded";
  return {
    page: "overview",
    refreshedTickers: tickers.length,
    generationId: result.snapshotId,
    publishedAt: result.generatedAt,
    currentCoveragePct: result.currentCoveragePct,
    historyExactCoveragePct: result.historyExactCoveragePct,
    historyUsableCoveragePct: result.historyUsableCoveragePct,
    notes: `Published overview generation ${result.snapshotId} with ${publicationStatus} current-data coverage (${result.currentCoveragePct.toFixed(1)}%). Exact-session history is ${result.historyExactCoveragePct.toFixed(1)}% and usable history is ${result.historyUsableCoveragePct.toFixed(1)}%.${catchUpSummary}${rowSummary}`,
  };
}
