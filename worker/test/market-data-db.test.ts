import { describe, expect, it } from "vitest";
import {
  assertMarketDataBackgroundWriteBudget,
  assertMarketDataWriteBudget,
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
