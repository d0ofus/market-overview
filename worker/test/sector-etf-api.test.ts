import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

type EtfWatchlistRow = {
  listType: "sector" | "industry";
  parentSector: string | null;
  industry: string | null;
  ticker: string;
  fundName: string;
  sortOrder: number;
  sourceUrl: string | null;
};

type DailyBarRow = {
  ticker: string;
  date: string;
  c: number;
};

function createEtfApiEnv(input: {
  watchlists: EtfWatchlistRow[];
  dailyBars: DailyBarRow[];
}): Env {
  const watchlists = [...input.watchlists];
  const dailyBars = [...input.dailyBars];

  return {
    DATA_PROVIDER: "alpaca",
    ALPACA_API_KEY: "test-key",
    ALPACA_API_SECRET: "test-secret",
    DB: {
      prepare(sql: string) {
        const makeStatement = (args: unknown[] = []) => ({
          bind(...nextArgs: unknown[]) {
            return makeStatement(nextArgs);
          },
          async all<T>() {
            if (sql.includes("FROM etf_watchlists WHERE list_type = ?")) {
              const listType = args[0] === "industry" ? "industry" : "sector";
              return {
                results: watchlists
                  .filter((row) => row.listType === listType)
                  .sort((left, right) => left.sortOrder - right.sortOrder)
                  .map((row) => ({
                    listType: row.listType,
                    parentSector: row.parentSector,
                    industry: row.industry,
                    ticker: row.ticker,
                    fundName: row.fundName,
                    sortOrder: row.sortOrder,
                    sourceUrl: row.sourceUrl,
                  })) as T[],
              };
            }

            if (sql.includes("ROW_NUMBER() OVER") && sql.includes("FROM daily_bars")) {
              const requested = new Set(args.map((value) => String(value).toUpperCase()));
              const results = Array.from(requested).flatMap((ticker) =>
                dailyBars
                  .filter((row) => row.ticker.toUpperCase() === ticker)
                  .sort((left, right) => right.date.localeCompare(left.date))
                  .slice(0, 2)
                  .map((row, index) => ({
                    ticker: row.ticker.toUpperCase(),
                    c: row.c,
                    rowNumber: index + 1,
                  })),
              );
              return { results: results as T[] };
            }

            return { results: [] as T[] };
          },
          async first<T>() {
            return null as T;
          },
          async run() {
            return {};
          },
        });
        return makeStatement();
      },
      async batch() {
        return [];
      },
    } as unknown as D1Database,
  } as Env;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sector ETF list API", () => {
  it("returns sector ETF rows with stored 1D stats without live provider fetches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network should not be called"));
    const env = createEtfApiEnv({
      watchlists: [
        { listType: "sector", parentSector: "Energy", industry: "Sector ETF", ticker: "XLE", fundName: "Energy Select Sector SPDR Fund", sortOrder: 1, sourceUrl: null },
        { listType: "sector", parentSector: "Technology", industry: "Sector ETF", ticker: "XLK", fundName: "Technology Select Sector SPDR Fund", sortOrder: 2, sourceUrl: null },
      ],
      dailyBars: [
        { ticker: "XLE", date: "2026-05-18", c: 90 },
        { ticker: "XLE", date: "2026-05-19", c: 99 },
        { ticker: "XLK", date: "2026-05-18", c: 200 },
        { ticker: "XLK", date: "2026-05-19", c: 190 },
      ],
    });

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/etfs/sector"),
      env as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { rows: Array<{ ticker: string; change1d: number; lastPrice: number; priceSource: string }> };
    expect(body.rows.map((row) => row.ticker)).toEqual(["XLE", "XLK"]);
    expect(body.rows[0]).toMatchObject({ ticker: "XLE", change1d: 10, lastPrice: 99, priceSource: "daily-bars" });
    expect(body.rows[1]).toMatchObject({ ticker: "XLK", change1d: -5, lastPrice: 190, priceSource: "daily-bars" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns industry ETF rows from stored bars without live provider fetches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network should not be called"));
    const env = createEtfApiEnv({
      watchlists: [
        { listType: "industry", parentSector: "Information Technology", industry: "Semiconductors", ticker: "SMH", fundName: "VanEck Semiconductor ETF", sortOrder: 1, sourceUrl: null },
      ],
      dailyBars: [
        { ticker: "SMH", date: "2026-05-18", c: 250 },
        { ticker: "SMH", date: "2026-05-19", c: 275 },
      ],
    });

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/etfs/industry"),
      env as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { rows: Array<{ ticker: string; change1d: number; lastPrice: number; priceSource: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ ticker: "SMH", change1d: 10, lastPrice: 275, priceSource: "daily-bars" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
