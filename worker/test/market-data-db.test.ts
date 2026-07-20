import { describe, expect, it, vi } from "vitest";
import {
  assertMarketDataBackgroundWriteBudget,
  assertMarketDataWriteBudget,
  loadMarketDataTickersWithBarOnDate,
} from "../src/market-data-db";
import type { Env } from "../src/types";

function envWithUsage(barsWritten: number): Env {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async first<T>() {
              return { barsWritten } as T;
            },
          };
        },
      };
    },
  };
  return {
    DB: db as unknown as D1Database,
    MARKET_DATA_DB: db as unknown as D1Database,
    MARKET_DATA_DAILY_WRITE_BUDGET: "75000",
    MARKET_DATA_CRITICAL_WRITE_RESERVE: "15000",
  };
}

describe("market-data write budgets", () => {
  it("reserves the final 15,000 writes from background post-close work", async () => {
    const now = new Date("2026-07-17T12:00:00Z");
    await expect(assertMarketDataBackgroundWriteBudget(envWithUsage(59_999), 1, now)).resolves.toBeUndefined();
    await expect(assertMarketDataBackgroundWriteBudget(envWithUsage(59_999), 2, now)).rejects.toThrow(
      /critical write reserve/,
    );
    await expect(assertMarketDataBackgroundWriteBudget(envWithUsage(60_000), 0, now)).rejects.toThrow(
      /critical write reserve/,
    );
  });

  it("continues to admit critical work until the full daily ceiling", async () => {
    const now = new Date("2026-07-17T12:00:00Z");
    await expect(assertMarketDataWriteBudget(envWithUsage(60_000), now)).resolves.toBeUndefined();
    await expect(assertMarketDataWriteBudget(envWithUsage(75_000), now)).rejects.toThrow(
      /daily rate limit/,
    );
  });
});

describe("market-data reads", () => {
  it("loads expected-date tickers only from MARKET_DATA_DB", async () => {
    const primaryPrepare = vi.fn(() => {
      throw new Error("primary DB must not be queried for market bars");
    });
    const marketPrepare = vi.fn((sql: string) => {
      expect(sql).toContain("FROM alpaca_daily_bars");
      expect(sql).toContain("json_each(?)");
      const statement = {
        bind: (feed: string, tickersJson: string, date: string) => {
          expect(feed).toBe("iex");
          expect(JSON.parse(tickersJson)).toEqual(["AAPL", "MSFT", "NVDA"]);
          expect(date).toBe("2026-07-17");
          return statement;
        },
        all: async <T>() => ({
          results: [{ ticker: "AAPL" }, { ticker: "NVDA" }] as T[],
        }),
      };
      return statement;
    });
    const env = {
      DB: { prepare: primaryPrepare } as unknown as D1Database,
      MARKET_DATA_DB: { prepare: marketPrepare } as unknown as D1Database,
      MARKET_DATA_DB_REQUIRED: "true",
      ALPACA_FEED: "iex",
    } as Env;

    const tickers = await loadMarketDataTickersWithBarOnDate(
      env,
      ["aapl", "MSFT", "AAPL", "NVDA"],
      "2026-07-17",
    );

    expect([...tickers].sort()).toEqual(["AAPL", "NVDA"]);
    expect(primaryPrepare).not.toHaveBeenCalled();
    expect(marketPrepare).toHaveBeenCalledOnce();
  });

  it("chunks large ticker sets into bounded market-data queries", async () => {
    const chunkSizes: number[] = [];
    const statement = {
      bind: (_feed: string, tickersJson: string, _date: string) => {
        chunkSizes.push((JSON.parse(tickersJson) as string[]).length);
        return statement;
      },
      all: vi.fn(async () => ({ results: [] })),
    };
    const env = {
      DB: {} as D1Database,
      MARKET_DATA_DB: { prepare: vi.fn(() => statement) } as unknown as D1Database,
      MARKET_DATA_DB_REQUIRED: "true",
    } as Env;
    const tickers = Array.from({ length: 1001 }, (_, index) => `T${index}`);

    await loadMarketDataTickersWithBarOnDate(env, tickers, "2026-06-12");

    expect(chunkSizes).toEqual([1000, 1]);
  });
});
