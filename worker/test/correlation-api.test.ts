import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import * as providerModule from "../src/provider";
import { latestUsSessionAsOfDate } from "../src/refresh-timing";
import * as symbolResolverModule from "../src/symbol-resolver";
import type { Env } from "../src/types";

type BarRow = {
  ticker: string;
  date: string;
  c: number;
};

type SymbolRow = {
  ticker: string;
  displayName: string | null;
};

function addDays(isoDate: string, days: number): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function buildDates(count: number, start = "2025-01-02"): string[] {
  const startDate = new Date(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const next = new Date(startDate);
    next.setUTCDate(startDate.getUTCDate() + index);
    return next.toISOString().slice(0, 10);
  });
}

function buildRecentDates(count: number, endDate: string): string[] {
  return Array.from({ length: count }, (_, index) => addDays(endDate, -(count - index - 1)));
}

function createCorrelationEnv(symbols: SymbolRow[], dailyBars: BarRow[]): Env {
  const storedSymbols = [...symbols];
  const storedBars = [...dailyBars];
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              __sql: sql,
              __args: args,
              async all<T>() {
                if (sql.includes("FROM symbols")) {
                  const requested = new Set((args as string[]).map((value) => value.toUpperCase()));
                  return {
                    results: storedSymbols
                      .filter((row) => requested.has(row.ticker.toUpperCase()))
                      .map((row) => ({ ticker: row.ticker, displayName: row.displayName })) as T[],
                  };
                }
                if (sql.includes("MAX(date) as lastBarDate") || sql.includes("MAX(date) as lastDate")) {
                  const requested = new Set((args as string[]).map((value) => value.toUpperCase()));
                  const fieldName = sql.includes("MAX(date) as lastDate") ? "lastDate" : "lastBarDate";
                  return {
                    results: Array.from(requested).flatMap((ticker) => {
                      const latestDate = storedBars
                        .filter((row) => row.ticker.toUpperCase() === ticker)
                        .map((row) => row.date)
                        .sort()
                        .at(-1);
                      return latestDate ? [{ ticker, [fieldName]: latestDate }] : [];
                    }) as T[],
                  };
                }
                if (sql.includes("FROM daily_bars")) {
                  const perTickerLimit = typeof args[args.length - 1] === "number"
                    ? Number(args[args.length - 1])
                    : Number.POSITIVE_INFINITY;
                  const requested = new Set(
                    (args as Array<string | number>)
                      .filter((value): value is string => typeof value === "string")
                      .map((value) => value.toUpperCase()),
                  );
                  const limitedRows = Array.from(requested).flatMap((ticker) =>
                    storedBars
                      .filter((row) => row.ticker.toUpperCase() === ticker)
                      .slice(-perTickerLimit),
                  );
                  return { results: limitedRows as T[] };
                }
                return { results: [] as T[] };
              },
              async first<T>() {
                return null as T;
              },
            };
          },
          async all<T>() {
            return { results: [] as T[] };
          },
          async first<T>() {
            return null as T;
          },
        };
      },
      async batch(statements: Array<{ __sql?: string; __args?: unknown[] }>) {
        for (const statement of statements) {
          if (statement.__sql?.includes("INTO symbols")) {
            const [ticker, name] = statement.__args ?? [];
            const normalizedTicker = String(ticker).toUpperCase();
            const existingSymbolIndex = storedSymbols.findIndex((row) => row.ticker.toUpperCase() === normalizedTicker);
            if (existingSymbolIndex >= 0) {
              storedSymbols[existingSymbolIndex] = { ticker: normalizedTicker, displayName: String(name ?? normalizedTicker) };
            } else {
              storedSymbols.push({ ticker: normalizedTicker, displayName: String(name ?? normalizedTicker) });
            }
            continue;
          }
          if (statement.__sql?.includes("INSERT OR REPLACE INTO daily_bars")) {
            const [ticker, date, , , , c] = statement.__args ?? [];
            const nextRow = { ticker: String(ticker), date: String(date), c: Number(c) };
            const existingIndex = storedBars.findIndex((row) => row.ticker === nextRow.ticker && row.date === nextRow.date);
            if (existingIndex >= 0) {
              storedBars[existingIndex] = nextRow;
            } else {
              storedBars.push(nextRow);
            }
          }
        }
        return [];
      },
    } as D1Database,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function createApiEnv(): Env {
  const dates = buildDates(30);
  const qqqDates = dates.slice(0, -2);
  const aaplBars = dates.map((date, index) => ({ ticker: "AAPL", date, c: 100 + index * 2 }));
  const msftBars = dates.map((date, index) => ({ ticker: "MSFT", date, c: 50 + index * 1.5 }));
  const qqqBars = qqqDates.map((date) => ({ ticker: "QQQ", date, c: 200 }));
  return createCorrelationEnv(
    [
      { ticker: "AAPL", displayName: "Apple Inc." },
      { ticker: "MSFT", displayName: "Microsoft Corp." },
      { ticker: "QQQ", displayName: "Invesco QQQ Trust" },
    ],
    [...aaplBars, ...msftBars, ...qqqBars],
  );
}

describe("correlation API", () => {
  it("returns a matrix response with default pair selection and stale diagnostics", async () => {
    vi.spyOn(providerModule, "getProvider").mockReturnValue({
      label: "test-provider",
      getDailyBars: async () => [],
    });
    const env = createApiEnv();
    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/correlation/matrix?tickers=AAPL,MSFT,QQQ,ZZZZ&lookback=60D"),
      env as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      resolvedTickers: Array<{ ticker: string; status: string }>;
      unresolvedTickers: Array<{ ticker: string; reason: string }>;
      matrix: Array<Array<number | null>>;
      defaultPair: { left: string; right: string } | null;
      warnings: string[];
    };

    expect(body.resolvedTickers.map((row) => row.ticker)).toEqual(["AAPL", "MSFT", "QQQ"]);
    expect(body.unresolvedTickers).toContainEqual({ ticker: "ZZZZ", reason: "unknown_ticker" });
    expect(body.defaultPair).toEqual({ left: "AAPL", right: "MSFT" });
    expect(body.matrix).toHaveLength(3);
    expect(body.warnings.some((warning) => warning.includes("QQQ history is stale"))).toBe(true);
  });

  it("returns pair drilldown payloads for valid ticker pairs", async () => {
    vi.spyOn(providerModule, "getProvider").mockReturnValue({
      label: "test-provider",
      getDailyBars: async () => [],
    });
    const env = createApiEnv();
    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/correlation/pair?left=AAPL&right=MSFT&lookback=60D&rollingWindow=20D"),
      env as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      pair: { left: { ticker: string }; right: { ticker: string } };
      overview: { normalizedSeries: unknown[]; stats: { observationCount: number } };
      spread: { series: unknown[] };
      dynamics: {
        rollingCorrelation: unknown[];
        leadLag: { rows: unknown[] };
      };
    };

    expect(body.pair.left.ticker).toBe("AAPL");
    expect(body.pair.right.ticker).toBe("MSFT");
    expect(body.overview.normalizedSeries.length).toBeGreaterThan(0);
    expect(body.overview.stats.observationCount).toBeGreaterThan(1);
    expect(body.spread.series.length).toBeGreaterThan(0);
    expect(body.dynamics.rollingCorrelation.length).toBeGreaterThan(0);
    expect(body.dynamics.leadLag.rows).toHaveLength(41);
  });

  it("rejects unsupported pair query parameters", async () => {
    vi.spyOn(providerModule, "getProvider").mockReturnValue({
      label: "test-provider",
      getDailyBars: async () => [],
    });
    const env = createApiEnv();
    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/correlation/pair?left=AAPL&right=MSFT&lookback=60D&rollingWindow=120D"),
      env as never,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("Rolling window cannot be larger than the selected lookback.");
  });

  it("hydrates cold-start matrix requests before returning data", async () => {
    const expectedAsOfDate = latestUsSessionAsOfDate(new Date());
    vi.spyOn(symbolResolverModule, "resolveTickerMeta").mockImplementation(async (ticker) => ({
      ticker,
      name: `${ticker} Inc.`,
      exchange: "NYSE",
      assetClass: "equity",
    }));
    vi.spyOn(providerModule, "getProvider").mockReturnValue({
      label: "test-provider",
      getDailyBars: async (tickers) => {
        const dates = buildRecentDates(35, expectedAsOfDate);
        return tickers.flatMap((ticker, tickerIndex) =>
          dates.map((date, index) => ({
            ticker,
            date,
            o: 90 + index + tickerIndex * 5,
            h: 90 + index + tickerIndex * 5,
            l: 90 + index + tickerIndex * 5,
            c: 90 + index + tickerIndex * 5,
            volume: 250,
          })));
      },
    });
    const env = createCorrelationEnv([], []);

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/correlation/matrix?tickers=AVT,ARW&lookback=60D"),
      env as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { resolvedTickers: Array<{ ticker: string }>; unresolvedTickers: unknown[] };
    expect(body.resolvedTickers.map((ticker) => ticker.ticker)).toEqual(["AVT", "ARW"]);
    expect(body.unresolvedTickers).toEqual([]);
  });

  it("hydrates cold-start pair requests before returning data", async () => {
    const expectedAsOfDate = latestUsSessionAsOfDate(new Date());
    vi.spyOn(symbolResolverModule, "resolveTickerMeta").mockImplementation(async (ticker) => ({
      ticker,
      name: `${ticker} Inc.`,
      exchange: "NYSE",
      assetClass: "equity",
    }));
    vi.spyOn(providerModule, "getProvider").mockReturnValue({
      label: "test-provider",
      getDailyBars: async (tickers) => {
        const dates = buildRecentDates(40, expectedAsOfDate);
        return tickers.flatMap((ticker, tickerIndex) =>
          dates.map((date, index) => ({
            ticker,
            date,
            o: 110 + index + tickerIndex * 7,
            h: 110 + index + tickerIndex * 7,
            l: 110 + index + tickerIndex * 7,
            c: 110 + index + tickerIndex * 7,
            volume: 400,
          })));
      },
    });
    const env = createCorrelationEnv([], []);

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/correlation/pair?left=AVT&right=ARW&lookback=60D&rollingWindow=20D"),
      env as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { pair: { left: { ticker: string }; right: { ticker: string } } };
    expect(body.pair.left.ticker).toBe("AVT");
    expect(body.pair.right.ticker).toBe("ARW");
  });

  it("includes unresolved ticker reasons when hydration still leaves fewer than two usable series", async () => {
    vi.spyOn(symbolResolverModule, "resolveTickerMeta").mockImplementation(async (ticker) => {
      if (ticker === "BAD") return null;
      return {
        ticker,
        name: `${ticker} Inc.`,
        exchange: "NYSE",
        assetClass: "equity",
      };
    });
    vi.spyOn(providerModule, "getProvider").mockReturnValue({
      label: "test-provider",
      getDailyBars: async (tickers) =>
        tickers.flatMap((ticker) => {
          if (ticker !== "AVT") return [];
          return [{
            ticker,
            date: buildDates(1).at(0)!,
            o: 101,
            h: 101,
            l: 101,
            c: 101,
            volume: 100,
          }];
        }),
    });
    const env = createCorrelationEnv([], []);

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/correlation/matrix?tickers=AVT,BAD&lookback=60D"),
      env as never,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("AVT (missing history)");
    expect(body.error).toContain("BAD (unknown ticker)");
  });
});
