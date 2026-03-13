import { afterEach, describe, expect, it, vi } from "vitest";
import { CsvTextProvider, TickerListProvider, TradingViewPublicLinkProvider, normalizeScanSourceType } from "../src/scanning-providers";

describe("scanning providers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses csv rows with duplicate ticker entries intact", async () => {
    const provider = new CsvTextProvider();
    const rows = await provider.fetch({
      providerKey: "csv-text",
      sourceType: "csv-text",
      sourceValue: [
        "ticker,name,price,change_1d",
        "NVDA,NVIDIA,120.55,2.4",
        "NVDA,NVIDIA,121.10,2.8",
        "PLTR,Palantir,31.22,-1.2",
      ].join("\n"),
    });

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ ticker: "NVDA", displayName: "NVIDIA", price: 120.55, change1d: 2.4 });
    expect(rows[1]).toMatchObject({ ticker: "NVDA", price: 121.1 });
  });

  it("parses ticker lists and strips exchange prefixes", async () => {
    const provider = new TickerListProvider();
    const rows = await provider.fetch({
      providerKey: "ticker-list",
      sourceType: "ticker-list",
      sourceValue: "NASDAQ:MSFT, nyse:pltr\nSPY",
    });

    expect(rows.map((row) => row.ticker)).toEqual(["MSFT", "PLTR", "SPY"]);
  });

  it("extracts symbols from tradingview url query parameters before fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new TradingViewPublicLinkProvider();
    const rows = await provider.fetch({
      providerKey: "tradingview-public-link",
      sourceType: "tradingview-public-link",
      sourceValue: "https://www.tradingview.com/screener/?symbols=NASDAQ:AAPL,NYSE:PLTR",
    });

    expect(rows.map((row) => row.ticker)).toEqual(["AAPL", "PLTR"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("extracts tradingview watchlist symbols from embedded symbols array", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        `<html><script>{"list":{"id":34128913,"symbols":["###LIVE ORDERS","NYSE:OIS","NASDAQ:RKLB","###FOCUS LIST - READY FOR EXECUTION","NYSE:AA","NYSE:MOG.A"]}}</script></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } },
      ),
    );

    const provider = new TradingViewPublicLinkProvider();
    const rows = await provider.fetch({
      providerKey: "tradingview-public-link",
      sourceType: "tradingview-public-link",
      sourceValue: "https://www.tradingview.com/watchlists/34128913/",
    });

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.ticker)).toEqual(["OIS", "RKLB", "AA", "MOG.A"]);
    expect(rows[0]).toMatchObject({ exchange: "NYSE", rankLabel: "LIVE ORDERS", rankValue: 1 });
    expect(rows[2]).toMatchObject({ exchange: "NYSE", rankLabel: "FOCUS LIST - READY FOR EXECUTION", rankValue: 3 });
  });

  it("normalizes supported source types", () => {
    expect(normalizeScanSourceType("csv-text")).toBe("csv-text");
    expect(normalizeScanSourceType("bad-type")).toBeNull();
  });
});
