import { describe, expect, it } from "vitest";
import { deriveOverviewQuoteOverlayFromSnapshot } from "../src/overview-quote-snapshot";

describe("overview quote snapshot overlay", () => {
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
});
