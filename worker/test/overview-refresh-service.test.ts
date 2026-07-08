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
      refreshRecentBarsForTickers,
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

  it("attempts a short historical catch-up when the snapshot diagnostics are recoverable", async () => {
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
      })
      .mockImplementationOnce(async () => {
        calls.push("snapshot-2");
        return {
          asOfDate: "2026-06-18",
          fetchedRows: 25,
          writtenRows: 22,
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

    expect(calls).toEqual(["snapshot-1", "bars", "snapshot-2"]);
    expect(refreshRecentBarsForTickers).toHaveBeenCalledWith({} as never, ["xsd", "spy"], 1600, 21, true);
    expect(refreshAndStoreOverviewSnapshot).toHaveBeenCalledTimes(2);
    expect(refreshAndStoreOverviewSnapshot).toHaveBeenNthCalledWith(1, {} as never, { requireFreshness: false });
    expect(refreshAndStoreOverviewSnapshot).toHaveBeenNthCalledWith(2, {} as never, { requireFreshness: false });
    expect(result).toEqual({
      page: "overview",
      refreshedTickers: 2,
      notes: "Overview market data fresh: 2/2 tickers current for 2026-06-18 (100.0%). Historical bar catch-up was attempted. Fetched 25 rows; wrote 22.",
    });
  });
});
