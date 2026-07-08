import { describe, expect, it, vi } from "vitest";
import { refreshOverviewPageData } from "../src/overview-refresh-service";

describe("refreshOverviewPageData", () => {
  it("rebuilds the overview snapshot first without a redundant daily-bar refresh when data is fresh", async () => {
    const calls: string[] = [];
    const refreshRecentBarsForTickers = vi.fn(async () => {
      calls.push("bars");
    });
    const refreshAndStoreOverviewSnapshot = vi.fn(async (_env, _options?: { requireFreshness?: boolean }) => {
      calls.push("snapshot");
      return {
        asOfDate: "2026-06-18",
        fetchedRows: 12,
        writtenRows: 10,
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
      refreshAndStoreOverviewSnapshot,
    });

    expect(calls).toEqual(["snapshot"]);
    expect(refreshRecentBarsForTickers).not.toHaveBeenCalled();
    expect(refreshAndStoreOverviewSnapshot).toHaveBeenCalledWith({} as never, { requireFreshness: false });
    expect(result).toEqual({
      page: "overview",
      refreshedTickers: 2,
      notes: "Overview market data fresh: 2/2 tickers current for 2026-06-18 (100.0%). Fetched 12 rows; wrote 10.",
    });
  });

  it("does not run broad historical catch-up inline when freshness remains partial", async () => {
    const calls: string[] = [];
    const refreshRecentBarsForTickers = vi.fn(async () => {
      calls.push("bars");
    });
    const refreshAndStoreOverviewSnapshot = vi
      .fn()
      .mockImplementationOnce(async () => {
        calls.push("snapshot-1");
        return {
          asOfDate: "2026-06-18",
          fetchedRows: 0,
          writtenRows: 0,
          freshness: {
            status: "partial",
            currentCount: 1,
            eligibleCount: 2,
            coveragePct: 50,
          },
        };
      });

    const result = await refreshOverviewPageData({} as never, {
      loadOverviewTickers: async () => ["xsd", "spy"],
      refreshAndStoreOverviewSnapshot,
    });

    expect(calls).toEqual(["snapshot-1"]);
    expect(refreshRecentBarsForTickers).not.toHaveBeenCalled();
    expect(refreshAndStoreOverviewSnapshot).toHaveBeenCalledTimes(1);
    expect(refreshAndStoreOverviewSnapshot).toHaveBeenNthCalledWith(1, {} as never, { requireFreshness: false });
    expect(result).toEqual({
      page: "overview",
      refreshedTickers: 2,
      notes: "Overview market data partial: 1/2 tickers current for 2026-06-18 (50.0%). Broad post-close daily-bar catch-up will continue through the scheduled worker job. Fetched 0 rows; wrote 0.",
    });
  });
});
