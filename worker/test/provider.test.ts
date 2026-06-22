import { afterEach, describe, expect, it, vi } from "vitest";
import { extractPremarketSnapshotFromAlpacaSnapshot, getProvider } from "../src/provider";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractPremarketSnapshotFromAlpacaSnapshot", () => {
  it("prefers minute bar data for premarket price and volume", () => {
    const snapshot = extractPremarketSnapshotFromAlpacaSnapshot({
      latestTrade: { p: 103.5 },
      minuteBar: { c: 104.25, v: 125000 },
      dailyBar: { c: 101.2, v: 3000000 },
      prevDailyBar: { c: 100 },
    });

    expect(snapshot).toEqual({
      price: 104.25,
      prevClose: 100,
      premarketPrice: 104.25,
      premarketVolume: 125000,
    });
  });

  it("falls back to latest trade when minute bar is unavailable", () => {
    const snapshot = extractPremarketSnapshotFromAlpacaSnapshot({
      latestTrade: { p: 51.1 },
      dailyBar: { c: 50.8, v: 900000 },
      prevDailyBar: { c: 48.5 },
    });

    expect(snapshot).toEqual({
      price: 51.1,
      prevClose: 48.5,
      premarketPrice: 51.1,
      premarketVolume: 0,
    });
  });

  it("returns null when required pricing fields are missing", () => {
    const snapshot = extractPremarketSnapshotFromAlpacaSnapshot({
      minuteBar: { c: 12.4, v: 5000 },
      dailyBar: { c: 12.1, v: 500000 },
    });

    expect(snapshot).toBeNull();
  });
});

describe("Alpaca quote snapshots", () => {
  it("parses the stock snapshots response keyed by ticker at the top level", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      AAPL: {
        latestTrade: { p: 105, t: "2026-06-17T20:00:00Z" },
        dailyBar: { c: 104.5, t: "2026-06-17T04:00:00Z" },
        prevDailyBar: { c: 100 },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = getProvider({
      DB: {} as D1Database,
      DATA_PROVIDER: "alpaca",
      ALPACA_API_KEY: "key",
      ALPACA_API_SECRET: "secret",
      ALPACA_FEED: "iex",
    });

    await expect(provider.getQuoteSnapshot?.(["AAPL"])).resolves.toMatchObject({
      AAPL: {
        price: 105,
        prevClose: 100,
        change1d: 5,
        source: "alpaca-snapshot",
        tradeTimestamp: "2026-06-17T20:00:00Z",
        dailyBarTimestamp: "2026-06-17T04:00:00Z",
      },
    });
  });

  it("preserves successful snapshot chunks when a later chunk fails", async () => {
    const tickers = ["AAPL", ...Array.from({ length: 79 }, (_, index) => `OK${index}`), "BADETF"];
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return Response.json({
          AAPL: {
            latestTrade: { p: 105, t: "2026-06-18T20:00:00Z" },
            dailyBar: { c: 104.5, t: "2026-06-18T04:00:00Z" },
            prevDailyBar: { c: 100 },
          },
        });
      }
      return new Response(JSON.stringify({ message: "invalid symbol BADETF" }), { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = getProvider({
      DB: {} as D1Database,
      DATA_PROVIDER: "alpaca",
      ALPACA_API_KEY: "key",
      ALPACA_API_SECRET: "secret",
      ALPACA_FEED: "iex",
    });

    await expect(provider.getQuoteSnapshot?.(tickers)).resolves.toMatchObject({
      AAPL: { price: 105, prevClose: 100, source: "alpaca-snapshot" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a diagnostic error when every isolated snapshot request fails", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: "forbidden feed" }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = getProvider({
      DB: {} as D1Database,
      DATA_PROVIDER: "alpaca",
      ALPACA_API_KEY: "key",
      ALPACA_API_SECRET: "secret",
      ALPACA_FEED: "iex",
    });

    await expect(provider.getQuoteSnapshot?.(["AAA", "BBB"])).rejects.toThrow(
      "Alpaca snapshot fetch failed for all requested tickers",
    );
  });
});

describe("provider fallback control", () => {
  it("does not chase fallback providers when fallbackEnabled is false", async () => {
    const fetchMock = vi.fn(async () => new Response(
      "Date,Open,High,Low,Close,Volume\n2026-05-26,10,11,9,10,1000\n",
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const provider = getProvider({ DB: {} as D1Database, DATA_PROVIDER: "stooq" }, { fallbackEnabled: false });
    const bars = await provider.getDailyBars(["AAA"], "2026-05-25", "2026-05-27");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bars).toEqual([{
      ticker: "AAA",
      date: "2026-05-26",
      o: 10,
      h: 11,
      l: 9,
      c: 10,
      volume: 1000,
    }]);
  });

  it("does not call SIP or external fallback when IEX has current preferred ETF bars", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      bars: {
        SPY: [{ t: "2026-06-18T04:00:00Z", o: 10, h: 11, l: 9, c: 10.5, v: 1000 }],
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = getProvider({
      DB: {} as D1Database,
      DATA_PROVIDER: "alpaca",
      ALPACA_API_KEY: "key",
      ALPACA_API_SECRET: "secret",
      ALPACA_FEED: "iex",
    });
    const bars = await provider.getDailyBars(["SPY"], "2026-06-18", "2026-06-18");

    expect(bars).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("feed=iex");
  });

  it("uses SIP for a preferred ETF only when IEX is stale", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("feed=iex")) {
        return Response.json({
          bars: {
            SPY: [{ t: "2026-06-17T04:00:00Z", o: 10, h: 11, l: 9, c: 10.5, v: 1000 }],
          },
        });
      }
      return Response.json({
        bars: {
          SPY: [{ t: "2026-06-18T04:00:00Z", o: 11, h: 12, l: 10, c: 11.5, v: 1200 }],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = getProvider({
      DB: {} as D1Database,
      DATA_PROVIDER: "alpaca",
      ALPACA_API_KEY: "key",
      ALPACA_API_SECRET: "secret",
      ALPACA_FEED: "iex",
    });
    const bars = await provider.getDailyBars(["SPY"], "2026-06-17", "2026-06-18");

    expect(bars.map((bar) => bar.date)).toEqual(["2026-06-17", "2026-06-18"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining("feed=iex"),
      expect.stringContaining("feed=sip"),
    ]);
  });

  it("falls back outside Alpaca when a preferred ETF is still missing after SIP", async () => {
    const yahooTimestamp = Math.floor(Date.parse("2026-06-18T04:00:00Z") / 1000);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("data.alpaca.markets")) {
        return Response.json({ bars: {} });
      }
      return Response.json({
        chart: {
          result: [{
            timestamp: [yahooTimestamp],
            indicators: {
              quote: [{
                open: [20],
                high: [22],
                low: [19],
                close: [21],
                volume: [2000],
              }],
              adjclose: [{ adjclose: [21] }],
            },
          }],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = getProvider({
      DB: {} as D1Database,
      DATA_PROVIDER: "alpaca",
      ALPACA_API_KEY: "key",
      ALPACA_API_SECRET: "secret",
      ALPACA_FEED: "iex",
    });
    const bars = await provider.getDailyBars(["SPY"], "2026-06-18", "2026-06-18");

    expect(bars).toEqual([{
      ticker: "SPY",
      date: "2026-06-18",
      o: 20,
      h: 22,
      l: 19,
      c: 21,
      volume: 2000,
    }]);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining("feed=iex"),
      expect.stringContaining("feed=sip"),
      expect.stringContaining("query1.finance.yahoo.com"),
    ]);
  });

  it("uses Stooq fallback for a non-preferred missing symbol", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("data.alpaca.markets")) return Response.json({ bars: {} });
      return new Response(
        "Date,Open,High,Low,Close,Volume\n2026-06-18,30,31,29,30.5,3000\n",
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = getProvider({
      DB: {} as D1Database,
      DATA_PROVIDER: "alpaca",
      ALPACA_API_KEY: "key",
      ALPACA_API_SECRET: "secret",
      ALPACA_FEED: "iex",
    });
    const bars = await provider.getDailyBars(["ABC"], "2026-06-18", "2026-06-18");

    expect(bars).toEqual([{
      ticker: "ABC",
      date: "2026-06-18",
      o: 30,
      h: 31,
      l: 29,
      c: 30.5,
      volume: 3000,
    }]);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining("feed=iex"),
      expect.stringContaining("stooq.com"),
    ]);
  });
});
