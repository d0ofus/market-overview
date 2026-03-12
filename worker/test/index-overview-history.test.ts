import { describe, expect, it } from "vitest";
import { loadTickersMissingBarHistory } from "../src/index";

function createEnv(counts: Record<string, number>) {
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all<T>() {
              if (!sql.includes("COUNT(*) as barCount")) return { results: [] as T[] };
              const tickers = args as string[];
              return {
                results: tickers
                  .filter((ticker) => counts[ticker.toUpperCase()] != null)
                  .map((ticker) => ({
                    ticker: ticker.toUpperCase(),
                    barCount: counts[ticker.toUpperCase()],
                  })) as T[],
              };
            },
          };
        },
      };
    },
  };
  return { DB: db as unknown as D1Database } as { DB: D1Database };
}

describe("loadTickersMissingBarHistory", () => {
  it("returns overview tickers with fewer than 63 daily bars", async () => {
    const missing = await loadTickersMissingBarHistory(
      createEnv({
        AAPL: 63,
        SPY: 62,
        XLK: 20,
      }) as never,
      ["AAPL", "SPY", "XLK", "XLF"],
      63,
    );

    expect(missing).toEqual(["SPY", "XLK", "XLF"]);
  });
});

