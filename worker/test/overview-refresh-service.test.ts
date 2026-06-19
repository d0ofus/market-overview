import { describe, expect, it, vi } from "vitest";
import { refreshOverviewPageData } from "../src/overview-refresh-service";

describe("refreshOverviewPageData", () => {
  it("refreshes overview ticker daily bars before rebuilding the stored snapshot", async () => {
    const calls: string[] = [];
    const refreshRecentBarsForTickers = vi.fn(async () => {
      calls.push("bars");
    });
    const refreshAndStoreOverviewSnapshot = vi.fn(async () => {
      calls.push("snapshot");
      return {
        asOfDate: "2026-06-18",
        freshness: {
          status: "fresh",
          currentCount: 2,
          eligibleCount: 2,
          coveragePct: 100,
        },
      };
    });

    const result = await refreshOverviewPageData({} as never, {
      loadOverviewTickers: async () => ["xsd", "spy"],
      refreshRecentBarsForTickers,
      refreshAndStoreOverviewSnapshot,
    });

    expect(calls).toEqual(["bars", "snapshot"]);
    expect(refreshRecentBarsForTickers).toHaveBeenCalledWith({} as never, ["xsd", "spy"], 2000, 400, true);
    expect(result).toEqual({
      page: "overview",
      refreshedTickers: 2,
      notes: "Overview market data fresh: 2/2 tickers current for 2026-06-18 (100.0%).",
    });
  });
});
