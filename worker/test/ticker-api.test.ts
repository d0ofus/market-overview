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
type BackfillStatusRow = {
  status: string | null;
  lastRequestedAt: string | null;
  lastAttemptedAt: string | null;
  lastCompletedAt: string | null;
  updatedAt: string | null;
  barCount: number;
};

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
  const backfillStatus = new Map<string, BackfillStatusRow>();

  const runStatement = (sql: string, args: unknown[]) => {
    if (sql.includes("INSERT INTO ticker_history_backfill_status")) {
      const [tickerArg, timeframeArg, _targetBars, barCountArg, requestedAtArg, updatedAtArg] = args;
      const ticker = String(tickerArg).toUpperCase();
      const timeframe = String(timeframeArg).toUpperCase();
      const key = `${ticker}|${timeframe}`;
      const existing = backfillStatus.get(key);
      backfillStatus.set(key, {
        status: "queued",
        barCount: Number(barCountArg ?? 0),
        lastRequestedAt: String(requestedAtArg),
        lastAttemptedAt: existing?.lastAttemptedAt ?? null,
        lastCompletedAt: existing?.lastCompletedAt ?? null,
        updatedAt: String(updatedAtArg),
      });
    }
    if (sql.includes("UPDATE ticker_history_backfill_status")) {
      const [statusArg, barCountArg, attemptedAtArg, completedAtArg, _lastErrorArg, updatedAtArg, tickerArg, timeframeArg] = args;
      const ticker = String(tickerArg).toUpperCase();
      const timeframe = String(timeframeArg).toUpperCase();
      const key = `${ticker}|${timeframe}`;
      const existing = backfillStatus.get(key) ?? {
        status: null,
        barCount: 0,
        lastRequestedAt: null,
        lastAttemptedAt: null,
        lastCompletedAt: null,
        updatedAt: null,
      };
      backfillStatus.set(key, {
        ...existing,
        status: String(statusArg),
        barCount: Number(barCountArg ?? 0),
        lastAttemptedAt: attemptedAtArg == null ? existing.lastAttemptedAt : String(attemptedAtArg),
        lastCompletedAt: completedAtArg == null ? existing.lastCompletedAt : String(completedAtArg),
        updatedAt: String(updatedAtArg),
      });
    }
  };

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
            if (sql.includes("FROM ticker_history_backfill_status")) {
              const ticker = String(args[0]).toUpperCase();
              const timeframe = String(args[1]).toUpperCase();
              return (backfillStatus.get(`${ticker}|${timeframe}`) ?? null) as T | null;
            }
            if (sql.includes("COUNT(*) as barCount FROM daily_bars")) {
              const ticker = String(args[0]).toUpperCase();
              return { barCount: barsByTicker.get(ticker)?.length ?? 0 } as T;
            }
            return null;
          },
          async all<T>() {
            if (sql.includes("SELECT date, c FROM daily_bars")) {
              const ticker = String(args[0]).toUpperCase();
              const rows = [...(barsByTicker.get(ticker) ?? [])]
                .sort((left, right) => right.date.localeCompare(left.date));
              const limit = sql.includes("LIMIT ?") ? Number(args[1]) : rows.length;
              return { results: rows.slice(0, limit) as T[] };
            }
            return { results: [] as T[] };
          },
          async run() {
            runStatement(sql, args);
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

  return { env, backfillStatus };
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

  it("queues 2Y background backfill for short history and respects the cooldown row", async () => {
    const { env, backfillStatus } = createTickerEnv({ AAA: makeBars(120) });
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
    expect(firstBody.historyStatus.backfill.status).toBe("queued");
    expect(firstContext.ctx.waitUntil).toHaveBeenCalledTimes(1);

    await Promise.all(firstContext.waitUntilPromises);

    expect(providerMocks.getProvider).toHaveBeenCalled();
    expect(dailyBarsMocks.refreshDailyBarsIncremental).toHaveBeenCalledWith(env, expect.objectContaining({
      tickers: ["AAA"],
      replaceExisting: true,
    }));
    expect(backfillStatus.get("AAA|2Y")?.status).toBe("partial");

    dailyBarsMocks.refreshDailyBarsIncremental.mockClear();
    const secondContext = createContext();
    const secondResponse = await worker.fetch(
      new Request("https://example.com/api/ticker/AAA?timeframe=2Y"),
      env,
      secondContext.ctx,
    );
    const secondBody = await secondResponse.json() as { historyStatus: { backfill: { status: string } } };

    expect(secondResponse.status).toBe(200);
    expect(secondBody.historyStatus.backfill.status).toBe("recently_requested");
    expect(secondContext.ctx.waitUntil).not.toHaveBeenCalled();
    expect(dailyBarsMocks.refreshDailyBarsIncremental).not.toHaveBeenCalled();
  });
});
