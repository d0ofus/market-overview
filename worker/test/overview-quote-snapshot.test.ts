import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOverviewQuoteOverlaysFromSnapshots,
  deriveOverviewQuoteOverlayFromSnapshot,
  fetchOverviewQuoteSnapshots,
} from "../src/overview-quote-snapshot";
import type { Env } from "../src/types";

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
      quoteFreshnessReason: "Alpaca snapshot quote is available. Snapshot quote is current.",
      barFreshnessStatus: "stale",
      barFreshnessReason: "Last stored daily bar is 2026-06-12; expected 2026-06-17.",
    });
  });

  it("keeps quote unavailable and reports stale history when a snapshot is missing", () => {
    const overlay = deriveOverviewQuoteOverlayFromSnapshot({
      ticker: "GLD",
      groupTitle: "Metals & Energy",
      barDate: "2026-06-12",
      expectedAsOfDate: "2026-06-17",
      snapshot: null,
    });

    expect(overlay.quotePrice).toBeNull();
    expect(overlay.quoteSource).toBeNull();
    expect(overlay.quoteFreshnessStatus).toBe("unavailable");
    expect(overlay.quoteFreshnessReason).toBe("No Alpaca or Yahoo snapshot quote is available for GLD.");
    expect(overlay.barFreshnessStatus).toBe("stale");
    expect(overlay.barFreshnessReason).toBe("Last stored daily bar is 2026-06-12; expected 2026-06-17.");
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
    expect(overlay.barFreshnessStatus).toBe("stale");
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
      quoteFreshnessStatus: "unavailable",
      quoteSource: null,
      barFreshnessStatus: "stale",
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

  it("falls back to Yahoo chart quotes when Alpaca misses a ticker", async () => {
    const regularMarketTime = Math.floor(Date.parse("2026-06-29T20:00:00.000Z") / 1000);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      chart: {
        result: [
          {
            meta: {
              regularMarketPrice: 100,
              chartPreviousClose: 98,
              regularMarketTime,
            },
            timestamp: [regularMarketTime],
            indicators: {
              quote: [{ close: [100] }],
            },
          },
        ],
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchOverviewQuoteSnapshots(
      { DATA_PROVIDER: "stooq" } as Env,
      ["RSHO"],
      "2026-06-29",
    );

    expect(result.providerAttempted).toBe(true);
    expect(result.providerError).toBeNull();
    expect(result.snapshots.RSHO).toMatchObject({
      price: 100,
      prevClose: 98,
      source: "yahoo-chart",
    });
    expect(result.snapshots.RSHO?.change1d).toBeCloseTo(2.0408, 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows EATZ and RSHO as live-quote fresh even when their daily bars are stale", () => {
    const result = buildOverviewQuoteOverlaysFromSnapshots(
      [
        { ticker: "EATZ", groupTitle: "Industry/Thematic ETFs", barDate: "2026-05-06" },
        { ticker: "RSHO", groupTitle: "Industry/Thematic ETFs", barDate: "2026-06-18" },
      ],
      "2026-06-29",
      {
        providerAttempted: true,
        providerError: null,
        snapshots: {
          EATZ: {
            price: 25,
            prevClose: 24,
            change1d: 4.166666666666666,
            source: "alpaca-snapshot",
            fetchedAt: "2026-06-29T20:05:00.000Z",
            tradeTimestamp: "2026-06-29T20:00:00.000Z",
          },
          RSHO: {
            price: 31,
            prevClose: 30,
            change1d: 3.3333333333333335,
            source: "alpaca-snapshot",
            fetchedAt: "2026-06-29T20:05:00.000Z",
            tradeTimestamp: "2026-06-29T20:00:00.000Z",
          },
        },
      },
    );

    expect(result.overlays.get("EATZ")).toMatchObject({
      quoteFreshnessStatus: "fresh",
      barFreshnessStatus: "stale",
      quoteSource: "alpaca-snapshot",
    });
    expect(result.overlays.get("RSHO")).toMatchObject({
      quoteFreshnessStatus: "fresh",
      barFreshnessStatus: "stale",
      quoteSource: "alpaca-snapshot",
    });
  });
});
