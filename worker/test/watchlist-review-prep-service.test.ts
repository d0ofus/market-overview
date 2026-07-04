import { afterEach, describe, expect, it, vi } from "vitest";
import * as dailyBarsModule from "../src/daily-bars";
import {
  createWatchlistReviewPrep,
  loadWatchlistReviewPrep,
  loadWatchlistReviewPrepBars,
} from "../src/watchlist-review-prep-service";

type Bar = {
  ticker: string;
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
};

type SymbolRow = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
};

function createPrepEnv(input: { bars?: Bar[]; symbols?: SymbolRow[] } = {}) {
  const bars = [...(input.bars ?? [])].map((bar) => ({ ...bar, ticker: bar.ticker.toUpperCase() }));
  const symbols = new Map((input.symbols ?? []).map((row) => [row.ticker.toUpperCase(), { ...row, ticker: row.ticker.toUpperCase() }]));
  const preps = new Map<string, any>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all() {
              if (sql.includes("MAX(date) as latestDate")) {
                const endDate = String(args.at(-1));
                const startDate = String(args.at(-2));
                const requested = new Set(args.slice(0, -2).map((arg) => String(arg).toUpperCase()));
                const grouped = new Map<string, Bar[]>();
                for (const bar of bars.filter((bar) => requested.has(bar.ticker) && bar.date >= startDate && bar.date <= endDate)) {
                  grouped.set(bar.ticker, [...(grouped.get(bar.ticker) ?? []), bar]);
                }
                return {
                  results: Array.from(grouped.entries()).map(([ticker, rows]) => ({
                    ticker,
                    latestDate: rows.reduce<string | null>((latest, row) => !latest || row.date > latest ? row.date : latest, null),
                    barCount: rows.length,
                  })),
                };
              }
              if (sql.includes("FROM symbols")) {
                const requested = new Set(args.map((arg) => String(arg).toUpperCase()));
                return { results: Array.from(symbols.values()).filter((row) => requested.has(row.ticker)) };
              }
              if (sql.includes("FROM daily_bars") && sql.includes("date >=")) {
                const endDate = String(args.at(-1));
                const startDate = String(args.at(-2));
                const requested = new Set(args.slice(0, -2).map((arg) => String(arg).toUpperCase()));
                return {
                  results: bars
                    .filter((bar) => requested.has(bar.ticker) && bar.date >= startDate && bar.date <= endDate)
                    .sort((left, right) => left.ticker.localeCompare(right.ticker) || left.date.localeCompare(right.date)),
                };
              }
              return { results: [] };
            },
            async first() {
              if (sql.includes("FROM watchlist_review_preps")) {
                return preps.get(String(args[0])) ?? null;
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT INTO watchlist_review_preps")) {
                preps.set(String(args[0]), {
                  id: args[0],
                  source: args[1],
                  sourceSetId: args[2],
                  sourceSetName: args[3],
                  watchlistName: args[4],
                  watchlistRunId: args[5],
                  symbolCount: args[6],
                  lookbackBars: args[7],
                  expectedAsOfDate: args[8],
                  providerJson: args[9],
                  coverageJson: args[10],
                  symbolsJson: args[11],
                  warningsJson: args[12],
                  status: args[13],
                  createdAt: args[14],
                  updatedAt: args[15],
                });
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return {
    env: {
      DB: db,
      DATA_PROVIDER: "alpaca",
      ALPACA_FEED: "iex",
      ALPACA_API_KEY: "do-not-leak-key",
      ALPACA_API_SECRET: "do-not-leak-secret",
    } as any,
    bars,
    preps,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("watchlist review prep service", () => {
  it("creates prep metadata with deduped symbols and freshness coverage", async () => {
    const refreshSpy = vi.spyOn(dailyBarsModule, "refreshDailyBarsIncremental");
    const { env } = createPrepEnv({
      symbols: [
        { ticker: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", sector: "Technology", industry: "Consumer Electronics" },
        { ticker: "MSFT", name: "Microsoft Corporation", exchange: "NASDAQ", sector: "Technology", industry: "Software" },
      ],
      bars: [
        { ticker: "AAPL", date: "2026-06-11", o: 99, h: 101, l: 98, c: 100, volume: 1000 },
        { ticker: "AAPL", date: "2026-06-12", o: 100, h: 105, l: 99, c: 104, volume: 2000 },
        { ticker: "MSFT", date: "2026-06-11", o: 50, h: 55, l: 49, c: 54, volume: 1500 },
      ],
    });

    const prep = await createWatchlistReviewPrep(env, {
      source: "watchlist-compiler",
      sourceSetId: "set-1",
      sourceSetName: "Daily Scans",
      watchlistRunId: "compile-run-1",
      symbols: ["AAPL", "aapl", "MSFT", "NONE"],
      lookbackBars: 260,
      now: new Date("2026-06-13T12:00:00.000Z"),
    });

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(prep).toMatchObject({
      source: "watchlist-compiler",
      sourceSetId: "set-1",
      sourceSetName: "Daily Scans",
      watchlistRunId: "compile-run-1",
      symbolCount: 3,
      expectedAsOfDate: "2026-06-12",
      status: "ready_with_warnings",
      coverage: { complete: 1, stale: 1, missing: 1, coveragePct: 33.3 },
    });
    expect(JSON.stringify(prep.provider)).not.toContain("do-not-leak");

    const loaded = await loadWatchlistReviewPrep(env, prep.prepId);
    expect(loaded?.prepId).toBe(prep.prepId);
  });

  it("refreshes a small stale subset when explicitly requested", async () => {
    const { env, bars } = createPrepEnv({
      symbols: [{ ticker: "MSFT", name: "Microsoft Corporation", exchange: "NASDAQ", sector: "Technology", industry: "Software" }],
      bars: [{ ticker: "MSFT", date: "2026-06-11", o: 50, h: 55, l: 49, c: 54, volume: 1500 }],
    });
    const refreshSpy = vi.spyOn(dailyBarsModule, "refreshDailyBarsIncremental").mockImplementation(async (_env, input: any) => {
      for (const ticker of input.tickers) {
        bars.push({ ticker, date: input.endDate, o: 55, h: 58, l: 54, c: 57, volume: 2500 });
      }
      return {
        requestedTickers: input.tickers.length,
        fetchedRows: input.tickers.length,
        writtenRows: input.tickers.length,
        skippedCurrentTickers: 0,
        currentDateTickers: input.tickers.length,
        missingCurrentDateTickers: 0,
        currentDateCoveragePct: 100,
      };
    });

    const prep = await createWatchlistReviewPrep(env, {
      source: "watchlist-compiler",
      symbols: ["MSFT"],
      lookbackBars: 60,
      refreshIfStale: true,
      now: new Date("2026-06-13T12:00:00.000Z"),
    });

    expect(refreshSpy).toHaveBeenCalledWith(env, expect.objectContaining({
      tickers: ["MSFT"],
      endDate: "2026-06-12",
    }));
    expect(prep.status).toBe("ready");
    expect(prep.coverage).toMatchObject({ complete: 1, stale: 0, missing: 0, coveragePct: 100 });
    expect(prep.timing.refreshedSymbols).toBe(1);
  });

  it("skips explicit refresh when the stale subset exceeds the sync limit", async () => {
    const refreshSpy = vi.spyOn(dailyBarsModule, "refreshDailyBarsIncremental").mockResolvedValue({
      requestedTickers: 0,
      fetchedRows: 0,
      writtenRows: 0,
      skippedCurrentTickers: 0,
      currentDateTickers: 0,
      missingCurrentDateTickers: 0,
      currentDateCoveragePct: 0,
    });
    const { env } = createPrepEnv();
    env.WATCHLIST_REVIEW_PREP_SYNC_REFRESH_LIMIT = "2";

    const prep = await createWatchlistReviewPrep(env, {
      source: "watchlist-compiler",
      symbols: ["AAA", "BBB", "CCC"],
      lookbackBars: 60,
      refreshIfStale: true,
      now: new Date("2026-06-13T12:00:00.000Z"),
    });

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(prep.status).toBe("blocked");
    expect(prep.timing.refreshedSymbols).toBe(0);
    expect(prep.warnings.join(" ")).toContain("Skipped automatic OHLCV refresh for 3 stale or missing symbols");
  });

  it("returns OHLCV bars rather than close-only data", async () => {
    const { env } = createPrepEnv({
      symbols: [{ ticker: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", sector: "Technology", industry: "Consumer Electronics" }],
      bars: [{ ticker: "AAPL", date: "2026-06-12", o: 100, h: 105, l: 99, c: 104, volume: 2000 }],
    });
    const prep = await createWatchlistReviewPrep(env, {
      source: "watchlist-compiler",
      symbols: ["AAPL"],
      lookbackBars: 60,
      refreshIfStale: false,
      now: new Date("2026-06-13T12:00:00.000Z"),
    });

    const bars = await loadWatchlistReviewPrepBars(env, prep.prepId, { symbols: ["AAPL"] });

    expect(bars?.symbols[0]).toMatchObject({
      ticker: "AAPL",
      tvSymbol: "NASDAQ:AAPL",
      bars: [{ date: "2026-06-12", o: 100, h: 105, l: 99, c: 104, volume: 2000 }],
    });
  });

  it("blocks prep when no usable OHLCV exists", async () => {
    const { env } = createPrepEnv();

    const prep = await createWatchlistReviewPrep(env, {
      source: "watchlist-compiler",
      symbols: ["NOPE"],
      lookbackBars: 60,
      refreshIfStale: false,
      now: new Date("2026-06-13T12:00:00.000Z"),
    });

    expect(prep.status).toBe("blocked");
    expect(prep.coverage).toMatchObject({ complete: 0, stale: 0, missing: 1, coveragePct: 0 });
    expect(prep.warnings.join(" ")).toMatch(/No usable OHLCV/);
  });
});
