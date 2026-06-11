import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPeerMetricRows, loadPeerMetrics, loadSharesOutstandingMap } from "../src/peer-metrics-service";

describe("peer metrics service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds market cap and average volume from Alpaca-backed inputs", () => {
    const rows = buildPeerMetricRows(
      ["AAPL", "MSFT"],
      "2026-03-12T00:00:00.000Z",
      {
        AAPL: { price: 200, prevClose: 198 },
      },
      [
        { ticker: "AAPL", date: "2026-03-10", c: 199, volume: 100 },
        { ticker: "AAPL", date: "2026-03-11", c: 200, volume: 200 },
        { ticker: "MSFT", date: "2026-03-11", c: 300, volume: 300 },
      ],
      new Map([
        ["AAPL", 1000],
        ["MSFT", null],
      ]),
      new Map([
        ["AAPL", { marketCap: 3_100_000_000_000, avgVolume: 55_000_000, source: "fmp-quote" }],
      ]),
    );

    expect(rows[0]).toMatchObject({
      ticker: "AAPL",
      price: 200,
      marketCap: 3_100_000_000_000,
      avgVolume: 55_000_000,
      source: "alpaca+fmp-quote",
    });
    expect(rows[1]).toMatchObject({
      ticker: "MSFT",
      price: 300,
      change1d: null,
      marketCap: null,
      avgVolume: 300,
      source: "alpaca",
    });
  });

  it("falls back to seeded shares and non-zero recent bars when quote fundamentals are unavailable", () => {
    const rows = buildPeerMetricRows(
      ["AAPL"],
      "2026-03-12T00:00:00.000Z",
      {
        AAPL: { price: 200, prevClose: 198 },
      },
      [
        { ticker: "AAPL", date: "2026-03-07", c: 195, volume: 0 },
        { ticker: "AAPL", date: "2026-03-10", c: 199, volume: 100 },
        { ticker: "AAPL", date: "2026-03-11", c: 200, volume: 200 },
      ],
      new Map([
        ["AAPL", 1000],
      ]),
    );

    expect(rows[0]).toMatchObject({
      ticker: "AAPL",
      price: 200,
      marketCap: 200000,
      avgVolume: 150,
      source: "alpaca+seeded-shares",
    });
  });

  it("falls back to daily bars for 1D change when snapshot prev close is unavailable", () => {
    const rows = buildPeerMetricRows(
      ["MSFT"],
      "2026-03-12T00:00:00.000Z",
      {},
      [
        { ticker: "MSFT", date: "2026-03-10", c: 290, volume: 100 },
        { ticker: "MSFT", date: "2026-03-11", c: 300, volume: 200 },
      ],
      new Map([["MSFT", null]]),
    );

    expect(rows[0]).toMatchObject({
      ticker: "MSFT",
      price: 300,
      change1d: (300 - 290) / 290 * 100,
      avgVolume: 150,
    });
  });

  it("loads seeded share counts in chunks for large peer groups", async () => {
    const prepareCalls: string[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          prepareCalls.push(sql);
          if (sql.includes("pragma_table_info")) {
            return {
              bind() {
                return {
                  async first() {
                    return { count: 1 };
                  },
                };
              },
            };
          }
          return {
            bind(...tickers: string[]) {
              return {
                async all() {
                  return {
                    results: tickers.map((ticker) => ({ ticker, sharesOutstanding: 1000 })),
                  };
                },
              };
            },
          };
        },
      },
    } as any;

    const tickers = Array.from({ length: 401 }, (_, index) => `T${String(index + 1).padStart(3, "0")}`);
    const sharesByTicker = await loadSharesOutstandingMap(env, tickers);

    expect(sharesByTicker.size).toBe(401);
    expect(sharesByTicker.get("T001")).toBe(1000);
    expect(prepareCalls.filter((sql) => sql.includes("shares_outstanding")).length).toBe(9);
  });

  it("maps TradingView weekly performance into change1w", async () => {
    let requestedColumns: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { columns?: string[]; symbols?: { tickers?: string[] } };
      requestedColumns = body.columns ?? [];
      const symbol = body.symbols?.tickers?.find((ticker) => ticker.endsWith(":AAPL")) ?? "NASDAQ:AAPL";
      return new Response(JSON.stringify({
        data: [
          {
            s: symbol,
            d: [200, 1.25, 3_000_000_000_000, 55_000_000, 4.75],
          },
        ],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await loadPeerMetrics({} as never, [{ ticker: "AAPL", exchange: "NASDAQ" }]);

    expect(requestedColumns).toContain("Perf.W");
    expect(result.rows[0]).toMatchObject({
      ticker: "AAPL",
      change1w: 4.75,
    });
  });
});
