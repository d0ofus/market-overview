import { describe, expect, it } from "vitest";
import {
  buildTradingViewOverviewPayload,
  currentRefreshWindowOpen,
  currentRefreshContinuationAllowed,
  doesOverviewCurrentRowNeedRepair,
  isOverviewCurrentRowComplete,
  isOverviewCurrentRowPublishable,
  isOverviewCurrentRowStructurallyUnsupported,
  OVERVIEW_CURRENT_COLUMNS,
  overviewCurrentRefreshStateAllowsPublication,
  parseTradingViewOverviewRow,
  planOverviewCurrentRefreshSlice,
  resolveOverviewCurrentRow,
} from "../src/overview-current-data";

function tradingViewData(overrides: Record<string, unknown> = {}): unknown[] {
  const values: Record<string, unknown> = {
    close: 105,
    change: 5,
    "Perf.W": 4,
    "Perf.3M": 12,
    "Perf.6M": 18,
    "Perf.YTD": 20,
    price_52_week_high: 110,
    SMA20: 100,
    SMA50: 98,
    SMA200: 90,
    time: Date.parse("2026-07-10T20:00:00.000Z") / 1000,
    last_bar_update_time: Date.parse("2026-07-10T20:00:00.000Z") / 1000,
    "last-price-update-time": Date.parse("2026-07-10T20:00:00.000Z") / 1000,
    update_time: Date.parse("2026-07-10T20:01:00.000Z") / 1000,
    update_mode: "delayed_streaming_900",
    current_session: "out_of_session",
    exchange: "NASDAQ",
    type: "stock",
    ...overrides,
  };
  return OVERVIEW_CURRENT_COLUMNS.map((column) => values[column]);
}

describe("overview current refresh cadence", () => {
  it("opens only during the 04:00-16:45 New York snapshot window", () => {
    expect(currentRefreshWindowOpen(new Date("2026-07-21T07:59:00.000Z"))).toBe(false);
    expect(currentRefreshWindowOpen(new Date("2026-07-21T08:00:00.000Z"))).toBe(true);
    expect(currentRefreshWindowOpen(new Date("2026-07-21T20:30:00.000Z"))).toBe(true);
    expect(currentRefreshWindowOpen(new Date("2026-07-21T20:45:00.000Z"))).toBe(true);
    expect(currentRefreshWindowOpen(new Date("2026-07-21T20:46:00.000Z"))).toBe(false);
  });

  it("advances a 225-ticker refresh in bounded 80-ticker slices", () => {
    expect(planOverviewCurrentRefreshSlice(225, 0)).toEqual({ start: 0, end: 80, completeAfterSlice: false });
    expect(planOverviewCurrentRefreshSlice(225, 80)).toEqual({ start: 80, end: 160, completeAfterSlice: false });
    expect(planOverviewCurrentRefreshSlice(225, 160)).toEqual({ start: 160, end: 225, completeAfterSlice: true });
  });

  it("blocks publication only while a resumable current refresh cycle is incomplete", () => {
    expect(overviewCurrentRefreshStateAllowsPublication(null)).toBe(true);
    expect(overviewCurrentRefreshStateAllowsPublication({
      status: "retrying",
      cycleId: null,
      processedTickers: 0,
      requestedTickers: 225,
    })).toBe(true);
    expect(overviewCurrentRefreshStateAllowsPublication({
      status: "running",
      cycleId: "cycle-1",
      processedTickers: 160,
      requestedTickers: 225,
    })).toBe(false);
    expect(overviewCurrentRefreshStateAllowsPublication({
      status: "retrying",
      cycleId: "cycle-1",
      processedTickers: 225,
      requestedTickers: 225,
    })).toBe(true);
  });

  it("continues only a due incomplete expected-session cycle after hours", () => {
    const now = new Date("2026-07-21T21:00:00.000Z");
    const job = {
      configId: "default",
      sessionDate: "2026-07-21",
      status: "running",
      attemptCount: 2,
      nextAttemptAt: "2026-07-21T20:55:00.000Z",
      updatedAt: "2026-07-21T20:45:00.000Z",
      cycleId: "cycle-1",
      cycleStartedAt: "2026-07-21T20:30:00.000Z",
      cursorOffset: 160,
      processedTickers: 160,
      requestedTickers: 225,
      freshTickers: 157,
      unavailableTickers: 3,
      leaseExpiresAt: null,
      lastError: null,
      lastErrorCode: null,
    };
    expect(currentRefreshContinuationAllowed(job, "2026-07-21", now)).toBe(true);
    expect(currentRefreshContinuationAllowed({ ...job, sessionDate: "2026-07-20" }, "2026-07-21", now)).toBe(false);
    expect(currentRefreshContinuationAllowed({ ...job, processedTickers: 225 }, "2026-07-21", now)).toBe(false);
    expect(currentRefreshContinuationAllowed({ ...job, leaseExpiresAt: "2026-07-21T21:03:00.000Z" }, "2026-07-21", now)).toBe(false);
    expect(currentRefreshContinuationAllowed({ ...job, nextAttemptAt: "2026-07-21T21:05:00.000Z" }, "2026-07-21", now)).toBe(false);
  });
});

describe("overview TradingView current data", () => {
  it("builds a point-symbol request with the strict scalar field contract", () => {
    const payload = buildTradingViewOverviewPayload(["NASDAQ:AAPL"]);

    expect(payload).toMatchObject({
      markets: ["america"],
      symbols: { tickers: ["NASDAQ:AAPL"] },
      columns: [...OVERVIEW_CURRENT_COLUMNS],
      range: [0, 1],
    });
  });

  it("accepts a row when a provider market timestamp matches the expected session", () => {
    const row = parseTradingViewOverviewRow(
      "AAPL",
      "NASDAQ:AAPL",
      tradingViewData(),
      "2026-07-10",
    );

    expect(row).toMatchObject({
      status: "supported",
      price: 105,
      change1d: 5,
      change1w: 4,
      change3m: 12,
      change6m: 18,
      ytd: 20,
      sma20: 100,
      sma50: 98,
      sma200: 90,
      updateMode: "delayed_streaming_900",
      currentSession: "out_of_session",
    });
  });

  it("accepts a newer premarket observation after the latest completed session", () => {
    const premarketTimestamp = Date.parse("2026-07-13T08:15:00.000Z") / 1000;
    const row = parseTradingViewOverviewRow(
      "EDOW",
      "AMEX:EDOW",
      tradingViewData({
        time: premarketTimestamp,
        last_bar_update_time: premarketTimestamp,
        "last-price-update-time": premarketTimestamp,
        current_session: "pre_market",
      }),
      "2026-07-10",
      new Date("2026-07-13T08:20:00.000Z"),
    );

    expect(row.status).toBe("supported");
    expect(row.reason).toContain("newer 2026-07-13 current-session observation");
  });

  it("rejects a provider timestamp that is ahead of the observation time", () => {
    const futureTimestamp = Date.parse("2026-07-13T09:00:00.000Z") / 1000;
    const row = parseTradingViewOverviewRow(
      "AAPL",
      "NASDAQ:AAPL",
      tradingViewData({
        time: futureTimestamp,
        last_bar_update_time: futureTimestamp,
        "last-price-update-time": futureTimestamp,
      }),
      "2026-07-10",
      new Date("2026-07-13T08:20:00.000Z"),
    );

    expect(row.status).toBe("stale");
    expect(row.reason).toContain("future market timestamp");
  });

  it("marks a prior-session row stale even when it was fetched today", () => {
    const staleTimestamp = Date.parse("2026-07-09T20:00:00.000Z") / 1000;
    const row = parseTradingViewOverviewRow(
      "AAPL",
      "NASDAQ:AAPL",
      tradingViewData({
        time: staleTimestamp,
        last_bar_update_time: staleTimestamp,
        "last-price-update-time": staleTimestamp,
      }),
      "2026-07-10",
    );

    expect(row.status).toBe("stale");
    expect(row.reason).toContain("2026-07-09");
  });

  it("keeps the row current while leaving an individually missing SMA unavailable", () => {
    const row = parseTradingViewOverviewRow(
      "NEWETF",
      "AMEX:NEWETF",
      tradingViewData({ SMA200: null }),
      "2026-07-10",
    );

    expect(row.status).toBe("supported");
    expect(row.sma200).toBeNull();
  });

  it("does not use request time when market timestamps are absent", () => {
    const row = parseTradingViewOverviewRow(
      "AAPL",
      "NASDAQ:AAPL",
      tradingViewData({
        time: null,
        last_bar_update_time: null,
        "last-price-update-time": null,
        update_time: Date.parse("2026-07-10T23:00:00.000Z") / 1000,
      }),
      "2026-07-10",
    );

    expect(row.status).toBe("missing");
    expect(row.reason).toContain("market timestamp");
  });

  it("keeps TradingView primary while using fresh Alpaca bars for an individually missing field", () => {
    const tv = parseTradingViewOverviewRow(
      "AAPL",
      "NASDAQ:AAPL",
      tradingViewData({ SMA200: null }),
      "2026-07-10",
    );
    const row = resolveOverviewCurrentRow({
      ticker: "AAPL",
      sessionDate: "2026-07-10",
      tv,
      alpacaSnapshot: null,
      alpacaSnapshotDiagnostic: null,
      alpacaAssetDiagnostic: { status: "supported", reason: "Active Alpaca asset." },
      bars: {
        status: "supported",
        reason: "Fresh Alpaca bars.",
        barDate: "2026-07-10",
        price: 104,
        change1d: 4,
        change1w: 3,
        change3m: 11,
        change6m: 17,
        ytd: 19,
        pctFrom52wHigh: -6,
        above20Sma: true,
        above50Sma: true,
        above200Sma: false,
      },
      alpacaFeed: "iex",
      fetchedAt: "2026-07-10T21:00:00.000Z",
    });

    expect(row.price).toBe(105);
    expect(row.change1w).toBe(4);
    expect(row.above200Sma).toBe(false);
    expect(row.fieldSources.price).toBe("tradingview-scanner");
    expect(row.fieldSources.above200Sma).toBe("alpaca:iex-bars");
  });

  it("uses an Alpaca snapshot for price and Alpaca bars for longer-period fallback values", () => {
    const staleTimestamp = Date.parse("2026-07-09T20:00:00.000Z") / 1000;
    const tv = parseTradingViewOverviewRow(
      "RSHO",
      "AMEX:RSHO",
      tradingViewData({
        time: staleTimestamp,
        last_bar_update_time: staleTimestamp,
        "last-price-update-time": staleTimestamp,
      }),
      "2026-07-10",
    );
    const row = resolveOverviewCurrentRow({
      ticker: "RSHO",
      sessionDate: "2026-07-10",
      tv,
      alpacaSnapshot: {
        price: 31,
        prevClose: 30,
        change1d: 3.3333333333,
        source: "alpaca-snapshot",
        fetchedAt: "2026-07-10T21:00:00.000Z",
        tradeTimestamp: "2026-07-10T20:00:00.000Z",
      },
      alpacaSnapshotDiagnostic: null,
      alpacaAssetDiagnostic: { status: "supported", reason: "Active Alpaca asset." },
      bars: {
        status: "supported",
        reason: "Fresh Alpaca bars.",
        barDate: "2026-07-10",
        price: 31,
        change1d: 3.3333333333,
        change1w: 6,
        change3m: 12,
        change6m: 15,
        ytd: 22,
        pctFrom52wHigh: -4,
        above20Sma: true,
        above50Sma: true,
        above200Sma: null,
      },
      alpacaFeed: "iex",
      fetchedAt: "2026-07-10T21:00:00.000Z",
    });

    expect(row.status).toBe("fresh");
    expect(row.quoteSource).toBe("alpaca:iex-snapshot");
    expect(row.performanceSource).toBe("alpaca:iex-bars");
    expect(row.price).toBe(31);
    expect(row.change1w).toBe(6);
    expect(row.ytd).toBe(22);
  });

  it("keeps fresh fields usable while marking an individually missing field incomplete", () => {
    const tv = parseTradingViewOverviewRow(
      "NEWETF",
      "AMEX:NEWETF",
      tradingViewData({ SMA200: null }),
      "2026-07-10",
    );
    const row = resolveOverviewCurrentRow({
      ticker: "NEWETF",
      sessionDate: "2026-07-10",
      tv,
      alpacaSnapshot: null,
      alpacaSnapshotDiagnostic: { status: "missing", reason: "No snapshot." },
      alpacaAssetDiagnostic: { status: "supported", reason: "Active asset." },
      bars: {
        status: "missing",
        reason: "No verified bars.",
        barDate: null,
        price: null,
        change1d: null,
        change1w: null,
        change3m: null,
        change6m: null,
        ytd: null,
        pctFrom52wHigh: null,
        above20Sma: null,
        above50Sma: null,
        above200Sma: null,
      },
      alpacaFeed: "iex",
      fetchedAt: "2026-07-10T21:00:00.000Z",
    });

    expect(row.status).toBe("fresh");
    expect(row.price).toBe(105);
    expect(row.above200Sma).toBeNull();
    expect(isOverviewCurrentRowComplete(row)).toBe(false);
    expect(isOverviewCurrentRowPublishable(row)).toBe(true);
    expect(isOverviewCurrentRowPublishable(row, new Date("2026-07-10T21:21:00.000Z"))).toBe(false);
    expect(doesOverviewCurrentRowNeedRepair(row)).toBe(true);
  });

  it("stops retrying a structurally unavailable field after both exact-session providers resolve", () => {
    const tv = parseTradingViewOverviewRow(
      "NEWETF",
      "AMEX:NEWETF",
      tradingViewData({ SMA200: null }),
      "2026-07-10",
    );
    const row = resolveOverviewCurrentRow({
      ticker: "NEWETF",
      sessionDate: "2026-07-10",
      tv,
      alpacaSnapshot: null,
      alpacaSnapshotDiagnostic: { status: "missing", reason: "No snapshot." },
      alpacaAssetDiagnostic: { status: "supported", reason: "Active asset." },
      bars: {
        status: "supported",
        reason: "Exact-session history is present but the listing is younger than 200 sessions.",
        barDate: "2026-07-10",
        price: 105,
        change1d: 1,
        change1w: 2,
        change3m: 3,
        change6m: null,
        ytd: 4,
        pctFrom52wHigh: -2,
        above20Sma: true,
        above50Sma: true,
        above200Sma: null,
      },
      alpacaFeed: "iex",
      fetchedAt: "2026-07-10T21:00:00.000Z",
    });

    expect(row.status).toBe("fresh");
    expect(row.above200Sma).toBeNull();
    expect(isOverviewCurrentRowComplete(row)).toBe(false);
    expect(doesOverviewCurrentRowNeedRepair(row)).toBe(false);
  });

  it("classifies a ticker unsupported when neither provider covers it", () => {
    const tv = parseTradingViewOverviewRow(
      "EATZ",
      "AMEX:EATZ",
      tradingViewData({ close: null }),
      "2026-07-10",
    );
    tv.status = "unsupported";
    tv.reason = "Not in TradingView.";
    const row = resolveOverviewCurrentRow({
      ticker: "EATZ",
      sessionDate: "2026-07-10",
      tv,
      alpacaSnapshot: null,
      alpacaSnapshotDiagnostic: { status: "unsupported", reason: "Not an Alpaca asset." },
      alpacaAssetDiagnostic: { status: "unsupported", reason: "Not an Alpaca asset." },
      bars: {
        status: "missing",
        reason: "No Alpaca bars.",
        barDate: null,
        price: null,
        change1d: null,
        change1w: null,
        change3m: null,
        change6m: null,
        ytd: null,
        pctFrom52wHigh: null,
        above20Sma: null,
        above50Sma: null,
        above200Sma: null,
      },
      alpacaFeed: "iex",
      fetchedAt: "2026-07-10T21:00:00.000Z",
    });

    expect(row.status).toBe("unavailable");
    expect(row.price).toBeNull();
    expect(isOverviewCurrentRowStructurallyUnsupported(row)).toBe(true);
    expect(isOverviewCurrentRowPublishable(row)).toBe(false);
    expect(doesOverviewCurrentRowNeedRepair(row)).toBe(false);
  });
});
