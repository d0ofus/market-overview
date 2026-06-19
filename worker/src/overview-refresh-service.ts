import type { Env } from "./types";

export type OverviewPageRefreshResult = {
  page: "overview";
  refreshedTickers: number;
  notes?: string;
};

export type OverviewPageRefreshDeps = {
  loadOverviewTickers(env: Env): Promise<string[]>;
  refreshRecentBarsForTickers(env: Env, tickers: string[], maxTickers?: number, lookbackDays?: number, replaceExisting?: boolean): Promise<void>;
  refreshAndStoreOverviewSnapshot(env: Env): Promise<{
    asOfDate: string;
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
  await deps.refreshRecentBarsForTickers(env, tickers, 2000, 400, true);
  const result = await deps.refreshAndStoreOverviewSnapshot(env);
  return {
    page: "overview",
    refreshedTickers: tickers.length,
    notes: `Overview market data ${result.freshness.status}: ${result.freshness.currentCount}/${result.freshness.eligibleCount} tickers current for ${result.asOfDate} (${result.freshness.coveragePct.toFixed(1)}%).`,
  };
}
