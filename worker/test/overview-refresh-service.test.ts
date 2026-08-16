import { describe, expect, it, vi } from "vitest";
import { refreshOverviewPageData } from "../src/overview-refresh-service";

describe("refreshOverviewPageData", () => {
  it("rebuilds the overview snapshot first without a redundant daily-bar refresh when data is fresh", async () => {
    const calls: string[] = [];
    const refreshRecentBarsForTickers = vi.fn(async () => {
      calls.push("bars");
    });
    const refreshAndStoreOverviewSnapshot = vi.fn(async () => {
      calls.push("snapshot");
      return {
        snapshotId: "generation-1",
        asOfDate: "2026-06-18",
        generatedAt: "2026-06-18T21:00:00.000Z",
        currentCoveragePct: 100,
        historyExactCoveragePct: 90,
        historyUsableCoveragePct: 100,
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
    expect(refreshAndStoreOverviewSnapshot).toHaveBeenCalledWith({} as never, {
      forceCurrentData: true,
      refreshAllOverviewExactBars: true,
    });
    expect(result).toEqual({
      page: "overview",
      refreshedTickers: 2,
      publicationStatus: "published",
      publicationNextAttemptAt: null,
      publicationErrorCode: null,
      publicationError: null,
      generationId: "generation-1",
      publishedAt: "2026-06-18T21:00:00.000Z",
      currentCoveragePct: 100,
      canonicalSession: "2026-06-18",
      historyExactCoveragePct: 90,
      historyUsableCoveragePct: 100,
      notes: "Published overview generation generation-1 with fresh current-data coverage (100.0%). Exact-session history is 90.0% and usable history is 100.0%. Broad post-close daily-bar catch-up will continue through the scheduled worker job. Fetched 12 rows; wrote 10.",
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
          snapshotId: "generation-2",
          asOfDate: "2026-06-18",
          generatedAt: "2026-06-18T21:01:00.000Z",
          currentCoveragePct: 95,
          historyExactCoveragePct: 50,
          historyUsableCoveragePct: 100,
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
    expect(refreshAndStoreOverviewSnapshot).toHaveBeenNthCalledWith(1, {} as never, {
      forceCurrentData: true,
      refreshAllOverviewExactBars: true,
    });
    expect(result).toEqual({
      page: "overview",
      refreshedTickers: 2,
      publicationStatus: "published",
      publicationNextAttemptAt: null,
      publicationErrorCode: null,
      publicationError: null,
      generationId: "generation-2",
      publishedAt: "2026-06-18T21:01:00.000Z",
      currentCoveragePct: 95,
      canonicalSession: "2026-06-18",
      historyExactCoveragePct: 50,
      historyUsableCoveragePct: 100,
      notes: "Published overview generation generation-2 with fresh current-data coverage (95.0%). Exact-session history is 50.0% and usable history is 100.0%. Broad post-close daily-bar catch-up will continue through the scheduled worker job. Fetched 0 rows; wrote 0.",
    });
  });

  it("reports a transient publication result as recovering without claiming success", async () => {
    const result = await refreshOverviewPageData({} as never, {
      loadOverviewTickers: async () => ["SPY"],
      refreshAndStoreOverviewSnapshot: async () => ({
        snapshotId: null,
        asOfDate: "2026-06-18",
        generatedAt: null,
        currentCoveragePct: 100,
        historyExactCoveragePct: 100,
        historyUsableCoveragePct: 100,
        publicationStatus: "recovering",
        publicationNextAttemptAt: "2026-06-18T21:05:00.000Z",
        publicationErrorCode: "publication_error",
        publicationError: "Temporary D1 failure.",
        freshness: {
          status: "fresh",
          currentCount: 1,
          eligibleCount: 1,
          coveragePct: 100,
        },
      }),
    });

    expect(result.publicationStatus).toBe("recovering");
    expect(result.generationId).toBeUndefined();
    expect(result.publishedAt).toBeUndefined();
    expect(result.notes).toContain("Scheduled reconciliation will retry automatically");
  });
});
