import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildRelativeStrengthCacheRows,
  type RelativeStrengthDailyBar,
} from "../src/relative-strength";
import {
  compareRsStateV2Parity,
  materializeRsStateV2,
  rsStateV2Rollout,
  type RsStateV2Feature,
} from "../src/rs-state-v2-service";
import type { Env } from "../src/types";

type Prepared = {
  __sql: string;
  __args: unknown[];
  bind: (...args: unknown[]) => Prepared;
  all: <T>() => Promise<{ results: T[] }>;
  first: <T>() => Promise<T | null>;
  run: () => Promise<{ meta: { rows_written: number } }>;
};

function makeBars(ticker: string, count: number, start: number, step: number): RelativeStrengthDailyBar[] {
  const startDate = new Date("2024-01-02T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(startDate.getTime() + index * 86_400_000).toISOString().slice(0, 10);
    const close = start + index * step;
    return { ticker, date, o: close, h: close, l: close, c: close, volume: 1_000_000 };
  });
}

function makeStatefulEnv(barsByTicker: Map<string, RelativeStrengthDailyBar[]>): Env {
  const states = new Map<string, Record<string, unknown>>();
  const features = new Map<string, Record<string, unknown>>();

  const scannerDb = {
    prepare(sql: string): Prepared {
      const build = (args: unknown[]): Prepared => ({
        __sql: sql,
        __args: args,
        bind: (...next: unknown[]) => build(next),
        async all<T>() {
          if (sql.includes("FROM rs_state_latest")) {
            const [configKey, ...tickers] = args.map(String);
            return {
              results: tickers.map((ticker) => states.get(`${configKey}|${ticker}`)).filter(Boolean) as T[],
            };
          }
          if (sql.includes("FROM rs_features_latest")) {
            const [configKey, tradingDate, ...tickers] = args.map(String);
            return {
              results: tickers
                .map((ticker) => features.get(`${configKey}|${ticker}`))
                .filter((row) => row?.tradingDate === tradingDate) as T[],
            };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          return null as T | null;
        },
        async run() {
          return { meta: { rows_written: 1 } };
        },
      });
      return build([]);
    },
    async batch(statements: Prepared[]) {
      for (const statement of statements) {
        const args = statement.__args;
        if (statement.__sql.includes("INSERT INTO rs_state_latest")) {
          const [
            configKey, ticker, benchmarkTicker, rsMaType, rsMaLength, newHighLookback,
            stateVersion, latestTradingDate, priceCloseHistoryJson, benchmarkCloseHistoryJson,
            weightedScoreHistoryJson, rsNewHighWindowJson, priceNewHighWindowJson,
            smaWindowJson, smaSum, emaValue, lastRsClose, lastRsMa,
          ] = args;
          states.set(`${configKey}|${ticker}`, {
            configKey, ticker, benchmarkTicker, rsMaType, rsMaLength, newHighLookback,
            stateVersion, latestTradingDate, priceCloseHistoryJson, benchmarkCloseHistoryJson,
            weightedScoreHistoryJson, rsNewHighWindowJson, priceNewHighWindowJson,
            smaWindowJson, smaSum, emaValue, lastRsClose, lastRsMa,
          });
        }
        if (statement.__sql.includes("INSERT INTO rs_features_latest")) {
          const [
            configKey, ticker, expectedTradingDate, tradingDate, benchmarkTicker, rsMaType,
            rsMaLength, newHighLookback, priceClose, change1d, rsRatioClose, rsRatioMa,
            rsAboveMa, rsNewHigh, rsNewHighBeforePrice, bullCross, approxRsRating,
          ] = args;
          features.set(`${configKey}|${ticker}`, {
            ticker, benchmarkTicker, rsMaType, rsMaLength, newHighLookback, tradingDate,
            expectedTradingDate, priceClose, change1d, rsRatioClose, rsRatioMa,
            rsAboveMa, rsNewHigh, rsNewHighBeforePrice, bullCross, approxRsRating,
          });
        }
      }
      return statements.map(() => ({ meta: { rows_written: 1 } }));
    },
  } as unknown as D1Database;

  const marketDb = {
    prepare(sql: string): Prepared {
      const build = (args: unknown[]): Prepared => ({
        __sql: sql,
        __args: args,
        bind: (...next: unknown[]) => build(next),
        async all<T>() {
          const isCountQuery = sql.includes("ROW_NUMBER()");
          const endDate = String(args[args.length - (isCountQuery ? 2 : 1)]);
          const startDate = isCountQuery ? null : String(args[args.length - 2]);
          const limit = isCountQuery ? Number(args[args.length - 1]) : Number.POSITIVE_INFINITY;
          const tickers = args.slice(1, args.length - (isCountQuery ? 2 : 2)).map(String);
          const results = tickers.flatMap((ticker) => (barsByTicker.get(ticker) ?? [])
            .filter((bar) => bar.date <= endDate && (!startDate || bar.date > startDate))
            .slice(-limit));
          return { results: results as T[] };
        },
        async first<T>() {
          return null as T | null;
        },
        async run() {
          return { meta: { rows_written: 0 } };
        },
      });
      return build([]);
    },
  } as unknown as D1Database;

  return {
    DB: {} as D1Database,
    MARKET_DATA_DB: marketDb,
    SCANNER_CACHE_DB: scannerDb,
    ALPACA_DAILY_FEED: "sip",
  };
}

function feature(ticker: string, overrides: Partial<RsStateV2Feature> = {}): RsStateV2Feature {
  return {
    ticker,
    benchmarkTicker: "SPY",
    rsMaType: "EMA",
    rsMaLength: 21,
    newHighLookback: 252,
    tradingDate: "2026-07-20",
    priceClose: 100,
    change1d: 1,
    rsRatioClose: 0.2,
    rsRatioMa: 0.19,
    rsAboveMa: true,
    rsNewHigh: false,
    rsNewHighBeforePrice: false,
    bullCross: false,
    approxRsRating: 90,
    ...overrides,
  };
}

describe("RS state v2 rollout", () => {
  it("keeps the legacy path authoritative by default", () => {
    expect(rsStateV2Rollout({} as Env)).toEqual({
      dualWriteEnabled: false,
      readEnabled: false,
      legacyWriteEnabled: true,
    });
    expect(rsStateV2Rollout({
      RS_STATE_V2_DUAL_WRITE_ENABLED: "true",
      RS_STATE_V2_READ_ENABLED: "1",
      RS_LEGACY_CACHE_WRITE_ENABLED: "false",
    } as Env)).toEqual({
      dualWriteEnabled: true,
      readEnabled: true,
      legacyWriteEnabled: false,
    });
  });

  it("requires exact categorical parity and tolerates only 1e-10 numeric drift", () => {
    const legacy = new Map([["NVDA", feature("NVDA")]]);
    expect(compareRsStateV2Parity(
      ["NVDA"],
      legacy,
      new Map([["NVDA", feature("NVDA", { rsRatioMa: 0.19000000005 })]]),
    ).mismatchCount).toBe(0);

    const mismatch = compareRsStateV2Parity(
      ["NVDA", "MISSING"],
      legacy,
      new Map([["NVDA", feature("NVDA", { rsNewHigh: true, rsRatioMa: 0.190001 })]]),
    );
    expect(mismatch.mismatchCount).toBe(2);
    expect(mismatch.mismatches).toContainEqual({ ticker: "NVDA", fields: ["rsNewHigh", "rsRatioMa"] });
    expect(mismatch.mismatches).toContainEqual({ ticker: "MISSING", fields: ["inclusion"] });
  });

  it("bootstraps and incrementally advances from canonical bars with legacy-equivalent output", async () => {
    const benchmarkBars = makeBars("SPY", 521, 100, 0.1);
    const tickerBars = makeBars("NVDA", 521, 40, 0.35);
    const barsByTicker = new Map([["NVDA", tickerBars]]);
    const env = makeStatefulEnv(barsByTicker) as Env & { SCANNER_CACHE_DB: D1Database };
    const identity = {
      configKey: "SPY|EMA|21|252",
      benchmarkTicker: "SPY",
      benchmarkDataTicker: "SPY",
      rsMaType: "EMA" as const,
      rsMaLength: 21,
      newHighLookback: 252,
      requiredBarCount: 520,
      expectedTradingDate: tickerBars[519].date,
    };

    const initial = await materializeRsStateV2(env, identity, ["NVDA"], benchmarkBars.slice(0, 520));
    expect(initial).toMatchObject({ computedTickers: 1, bootstrappedTickers: 1, cacheHitTickers: 0 });

    const next = await materializeRsStateV2(env, {
      ...identity,
      expectedTradingDate: tickerBars[520].date,
    }, ["NVDA"], benchmarkBars);
    expect(next).toMatchObject({ computedTickers: 1, bootstrappedTickers: 0, cacheHitTickers: 0 });

    const legacy = buildRelativeStrengthCacheRows(tickerBars, benchmarkBars, {
      benchmarkTicker: "SPY",
      verticalOffset: 0.01,
      rsMaLength: 21,
      rsMaType: "EMA",
      newHighLookback: 252,
    }).at(-1);
    expect(next.features[0]).toMatchObject({
      ticker: legacy?.ticker,
      tradingDate: legacy?.tradingDate,
      rsAboveMa: legacy?.rsAboveMa,
      rsNewHigh: legacy?.rsNewHigh,
      rsNewHighBeforePrice: legacy?.rsNewHighBeforePrice,
      bullCross: legacy?.bullCross,
      approxRsRating: legacy?.approxRsRating,
    });
    expect(next.features[0]?.rsRatioClose).toBeCloseTo(legacy?.rsClose ?? 0, 12);
    expect(next.features[0]?.rsRatioMa).toBeCloseTo(legacy?.rsMa ?? 0, 12);

    const unchanged = await materializeRsStateV2(env, {
      ...identity,
      expectedTradingDate: tickerBars[520].date,
    }, ["NVDA"], benchmarkBars);
    expect(unchanged).toMatchObject({ computedTickers: 0, bootstrappedTickers: 0, cacheHitTickers: 1 });
  });

  it("rebootstraps instead of advancing a gap longer than twenty aligned sessions", async () => {
    const benchmarkBars = makeBars("SPY", 521, 100, 0.1);
    const tickerBars = makeBars("NVDA", 521, 40, 0.35);
    const env = makeStatefulEnv(new Map([["NVDA", tickerBars]])) as Env & { SCANNER_CACHE_DB: D1Database };
    const identity = {
      configKey: "SPY|SMA|21|252",
      benchmarkTicker: "SPY",
      benchmarkDataTicker: "SPY",
      rsMaType: "SMA" as const,
      rsMaLength: 21,
      newHighLookback: 252,
      requiredBarCount: 520,
      expectedTradingDate: tickerBars[499].date,
    };

    await materializeRsStateV2(env, identity, ["NVDA"], benchmarkBars.slice(0, 500));
    const result = await materializeRsStateV2(env, {
      ...identity,
      expectedTradingDate: tickerBars[520].date,
    }, ["NVDA"], benchmarkBars);

    expect(result).toMatchObject({ computedTickers: 1, bootstrappedTickers: 1, cacheHitTickers: 0 });
  });

  it("defines compact state without duplicating current output columns", () => {
    const migration = readFileSync(new URL("../scanner-cache-migrations/0008_rs_state_v2.sql", import.meta.url), "utf8");
    const service = readFileSync(new URL("../src/scans-page-service.ts", import.meta.url), "utf8");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS rs_state_latest");
    expect(migration).not.toMatch(/\bprice_close\s+REAL/);
    expect(migration).not.toMatch(/\bapprox_rs_rating\b/);
    expect(service).not.toContain("INSERT INTO rs_scan_rows_latest");
  });
});
