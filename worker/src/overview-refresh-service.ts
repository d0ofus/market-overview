import type { Env } from "./types";

export type OverviewPageRefreshResult = {
  page: "overview";
  refreshedTickers: number;
  notes?: string;
};

export type OverviewPageRefreshDeps = {
  loadOverviewTickers(env: Env): Promise<string[]>;
  refreshRecentBarsForTickers(env: Env, tickers: string[], maxTickers?: number, lookbackDays?: number, replaceExisting?: boolean): Promise<void>;
  refreshAndStoreOverviewSnapshot(env: Env, options?: { requireFreshness?: boolean }): Promise<{
    asOfDate: string;
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
  let result = await deps.refreshAndStoreOverviewSnapshot(env, { requireFreshness: false });
  let historyCatchUpAttempted = false;
  if (result.freshness.status !== "fresh" && tickers.length > 0) {
    historyCatchUpAttempted = true;
    await deps.refreshRecentBarsForTickers(env, tickers, 1600, 21, true);
    result = await deps.refreshAndStoreOverviewSnapshot(env, { requireFreshness: false });
  }
  const rowSummary = typeof result.fetchedRows === "number" || typeof result.writtenRows === "number"
    ? ` Fetched ${result.fetchedRows ?? 0} rows; wrote ${result.writtenRows ?? 0}.`
    : "";
  const catchUpSummary = historyCatchUpAttempted ? " Historical bar catch-up was attempted." : "";
  return {
    page: "overview",
    refreshedTickers: tickers.length,
    notes: `Overview market data ${result.freshness.status}: ${result.freshness.currentCount}/${result.freshness.eligibleCount} tickers current for ${result.asOfDate} (${result.freshness.coveragePct.toFixed(1)}%).${catchUpSummary}${rowSummary}`,
  };
}
