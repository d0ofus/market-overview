import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOverviewQuoteOverlaysFromSnapshots,
  deriveOverviewQuoteOverlayFromSnapshot,
} from "../src/overview-quote-snapshot";

describe("overview quote snapshot overlay", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks an eligible stale daily-bar row fresh when an Alpaca snapshot has price and previous close", () => {
    const overlay = deriveOverviewQuoteOverlayFromSnapshot({
      ticker: "SPY",
      groupTitle: "US Index Futures",
      barDate: "2026-06-12",
      expectedAsOfDate: "2026-06-17",
      snapshot: {
        price: 101,
        prevClose: 100,
        change1d: 1,
        source: "alpaca-snapshot",
        fetchedAt: "2026-06-18T05:00:00.000Z",
      },
    });

    expect(overlay).toEqual({
      ticker: "SPY",
      quotePrice: 101,
      quotePrevClose: 100,
      quoteChange1d: 1,
      quoteSource: "alpaca-snapshot",
      quoteFetchedAt: "2026-06-18T05:00:00.000Z",
      quoteFreshnessStatus: "fresh",
      quoteFreshnessReason: "Alpaca snapshot quote is available; last stored daily bar is 2026-06-12.",
    });
  });

  it("falls back to stale daily-bar freshness when a snapshot is missing", () => {
    const overlay = deriveOverviewQuoteOverlayFromSnapshot({
      ticker: "GLD",
      groupTitle: "Metals & Energy",
      barDate: "2026-06-12",
      expectedAsOfDate: "2026-06-17",
      snapshot: null,
    });

    expect(overlay.quotePrice).toBeNull();
    expect(overlay.quoteFreshnessStatus).toBe("stale");
    expect(overlay.quoteFreshnessReason).toBe("No Alpaca snapshot quote is available; last stored daily bar is 2026-06-12; expected 2026-06-17.");
  });

  it("leaves crypto and unsupported symbols outside automated quote freshness validation", () => {
    const overlay = deriveOverviewQuoteOverlayFromSnapshot({
      ticker: "BITO",
      groupTitle: "Crypto Proxies",
      barDate: "2026-06-12",
      expectedAsOfDate: "2026-06-17",
      snapshot: {
        price: 50,
        prevClose: 49,
        change1d: 2.0408163265306123,
        source: "alpaca-snapshot",
        fetchedAt: "2026-06-18T05:00:00.000Z",
      },
    });

    expect(overlay.quotePrice).toBeNull();
    expect(overlay.quoteFreshnessStatus).toBe("unsupported");
    expect(overlay.quoteFreshnessReason).toBe("BITO is outside automated quote freshness validation; last stored daily bar is 2026-06-12.");
  });

  it("builds row overlays from preloaded snapshots without a late provider fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = buildOverviewQuoteOverlaysFromSnapshots(
      [
        { ticker: "SPY", groupTitle: "US Index Futures", barDate: "2026-06-12" },
        { ticker: "GLD", groupTitle: "Metals & Energy", barDate: "2026-06-17" },
      ],
      "2026-06-18",
      {
        providerAttempted: true,
        providerError: null,
        snapshots: {
          SPY: {
            price: 101,
            prevClose: 100,
            change1d: 1,
            source: "alpaca-snapshot",
            fetchedAt: "2026-06-18T21:05:00.000Z",
          },
        },
      },
    );

    expect(result.overlays.get("SPY")).toMatchObject({
      quotePrice: 101,
      quoteFreshnessStatus: "fresh",
      quoteSource: "alpaca-snapshot",
    });
    expect(result.overlays.get("GLD")).toMatchObject({
      quotePrice: null,
      quoteFreshnessStatus: "stale",
      quoteSource: "daily-bars",
    });
    expect(result.diagnostics).toMatchObject({
      requestedTickers: 2,
      eligibleTickers: 2,
      returnedSnapshots: 1,
      quotePriceRows: 1,
      providerAttempted: true,
      providerError: null,
      sampleMissingTickers: ["GLD"],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
