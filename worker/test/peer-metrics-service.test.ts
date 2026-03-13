import { describe, expect, it } from "vitest";
import { buildPeerMetricRows, loadSharesOutstandingMap } from "../src/peer-metrics-service";

describe("peer metrics service", () => {
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
    );

    expect(rows[0]).toMatchObject({
      ticker: "AAPL",
      price: 200,
      marketCap: 200000,
      avgVolume: 150,
      source: "alpaca+seeded-shares",
    });
    expect(rows[1]).toMatchObject({
      ticker: "MSFT",
      price: 300,
      marketCap: null,
      avgVolume: 300,
      source: "alpaca",
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
});
