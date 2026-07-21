import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

const dailyBarsMocks = vi.hoisted(() => ({
  refreshDailyBarsIncremental: vi.fn(async () => ({
    requestedTickers: 1,
    fetchedRows: 0,
    writtenRows: 0,
    skippedCurrentTickers: 0,
  })),
}));

const providerMocks = vi.hoisted(() => ({
  getProvider: vi.fn(() => ({
    label: "test provider",
    getDailyBars: vi.fn(async () => []),
  })),
}));

vi.mock("../src/daily-bars", () => dailyBarsMocks);
vi.mock("../src/provider", async () => {
  const actual = await vi.importActual<typeof import("../src/provider")>("../src/provider");
  return {
    ...actual,
    getProvider: providerMocks.getProvider,
  };
});

const worker = (await import("../src/index")).default;

type TestBar = { date: string; c: number };

function addUtcDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function makeBars(count: number): TestBar[] {
  return Array.from({ length: count }, (_, index) => ({
    date: addUtcDays("2024-01-01", index),
    c: 100 + index,
  }));
}

function createContext() {
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    }),
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, waitUntilPromises };
}

function createTickerEnv(seed: Record<string, TestBar[]>) {
  const barsByTicker = new Map(
    Object.entries(seed).map(([ticker, bars]) => [ticker.toUpperCase(), [...bars]]),
  );
  const env = {
    DB: {
      prepare(sql: string) {
        const makeBound = (args: unknown[]) => ({
          __sql: sql,
          __args: args,
          async first<T>() {
            if (sql.includes("FROM symbols WHERE ticker = ?")) {
              const ticker = String(args[0]).toUpperCase();
              return {
                ticker,
                name: `${ticker} Inc`,
                exchange: "NASDAQ",
                assetClass: "equity",
              } as T;
            }
            return null;
          },
          async all<T>() {
            if (sql.includes("SELECT date, c FROM alpaca_daily_bars")) {
              const ticker = String(args[1]).toUpperCase();
              const rows = [...(barsByTicker.get(ticker) ?? [])]
                .sort((left, right) => right.date.localeCompare(left.date));
              const limit = sql.includes("LIMIT ?") ? Number(args[2]) : rows.length;
              return { results: rows.slice(0, limit) as T[] };
            }
            return { results: [] as T[] };
          },
          async run() {
            return {};
          },
        });
        return {
          bind(...args: unknown[]) {
            return makeBound(args);
          },
          async first<T>() {
            return makeBound([]).first<T>();
          },
          async all<T>() {
            return makeBound([]).all<T>();
          },
          async run() {
            return makeBound([]).run();
          },
        };
      },
    },
    DATA_PROVIDER: "alpaca",
    ALPACA_FEED: "iex",
  } as unknown as Env;

  return { env };
}

describe("ticker API series timeframes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to the 6M stored-bar window", async () => {
    const { env } = createTickerEnv({ AAA: makeBars(180) });
    const response = await worker.fetch(new Request("https://example.com/api/ticker/AAA"), env, createContext().ctx);
    const body = await response.json() as { series: TestBar[]; historyStatus: { timeframe: string; requestedBars: number; availableBars: number } };

    expect(response.status).toBe(200);
    expect(body.series).toHaveLength(130);
    expect(body.series[0]?.date).toBe(makeBars(180).slice(-130)[0]?.date);
    expect(body.historyStatus).toMatchObject({
      timeframe: "6M",
      requestedBars: 130,
      availableBars: 130,
    });
  });

  it("applies supported timeframe limits and treats unknown values as the 6M default", async () => {
    const { env } = createTickerEnv({ AAA: makeBars(600) });
    const cases: Array<[string, string, number]> = [
      ["1M", "1M", 23],
      ["3M", "3M", 70],
      ["1Y", "1Y", 260],
      ["2Y", "2Y", 520],
      ["max", "MAX", 600],
      ["5Y", "6M", 130],
    ];

    for (const [queryValue, expectedTimeframe, expectedLength] of cases) {
      const response = await worker.fetch(
        new Request(`https://example.com/api/ticker/AAA?timeframe=${queryValue}`),
        env,
        createContext().ctx,
      );
      const body = await response.json() as { series: TestBar[]; historyStatus: { timeframe: string } };

      expect(response.status).toBe(200);
      expect(body.series).toHaveLength(expectedLength);
      expect(body.historyStatus.timeframe).toBe(expectedTimeframe);
    }
  });

  it("keeps a short 2Y request stored-read only and directs refresh through admin", async () => {
    const { env } = createTickerEnv({ AAA: makeBars(120) });
    const firstContext = createContext();
    const firstResponse = await worker.fetch(
      new Request("https://example.com/api/ticker/AAA?timeframe=2Y"),
      env,
      firstContext.ctx,
    );
    const firstBody = await firstResponse.json() as {
      historyStatus: {
        complete: boolean;
        backfill: { status: string };
      };
    };

    expect(firstResponse.status).toBe(200);
    expect(firstBody.historyStatus.complete).toBe(false);
    expect(firstBody.historyStatus.backfill.status).toBe("unavailable");
    expect(firstContext.ctx.waitUntil).not.toHaveBeenCalled();
    expect(providerMocks.getProvider).not.toHaveBeenCalled();
    expect(dailyBarsMocks.refreshDailyBarsIncremental).not.toHaveBeenCalled();
  });
});
