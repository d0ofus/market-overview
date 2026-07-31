import {
  assertMarketDataCriticalWorkBudget,
  getMarketDataDb,
  marketDataFeed,
  recordMarketDataD1Usage,
} from "./market-data-db";
import { sma } from "./metrics";
import type { Env } from "./types";

const FEATURE_QUERY_BATCH_SIZE = 80;
const FEATURE_WRITE_BATCH_SIZE = 100;

type FeatureSourceBar = {
  ticker: string;
  date: string;
  c: number;
  volume: number | null;
  sourceProvider?: string | null;
};

export type DailyMarketFeature = {
  ticker: string;
  sessionDate: string;
  close: number;
  volume: number;
  previousClose: number;
  return1d: number;
  return5d: number | null;
  return63d: number | null;
  sma5: number;
  sma20: number;
  sma50: number;
  sma100: number;
  sma200: number;
  high5: number;
  high20: number;
  high21: number;
  high63: number;
  high126: number;
  high252: number;
  low20: number;
  sourceSessions: number;
  sourceProvider: string;
};

function normalizeTickers(tickers: string[]): string[] {
  return Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
}

function percentReturn(current: number, prior: number): number {
  return Number.isFinite(current) && Number.isFinite(prior) && prior !== 0
    ? ((current - prior) / prior) * 100
    : 0;
}

function high(closes: number[], period: number): number {
  return Math.max(...closes.slice(Math.max(0, closes.length - period)));
}

export function computeDailyMarketFeature(
  ticker: string,
  sessionDate: string,
  sourceBars: FeatureSourceBar[],
): DailyMarketFeature | null {
  const bars = sourceBars
    .filter((bar) => bar.date <= sessionDate && Number.isFinite(bar.c))
    .sort((left, right) => left.date.localeCompare(right.date));
  if (bars.length < 2 || bars.at(-1)?.date !== sessionDate) return null;
  const closes = bars.map((bar) => Number(bar.c));
  const last = closes.at(-1) as number;
  const previous = closes.at(-2) as number;
  const currentBar = bars.at(-1) as FeatureSourceBar;
  const last20 = closes.slice(Math.max(0, closes.length - 20));
  return {
    ticker: ticker.toUpperCase(),
    sessionDate,
    close: last,
    volume: Number(currentBar.volume ?? 0),
    previousClose: previous,
    return1d: percentReturn(last, previous),
    return5d: closes.length >= 6 ? percentReturn(last, closes[closes.length - 6]) : null,
    return63d: closes.length >= 64 ? percentReturn(last, closes[closes.length - 64]) : null,
    sma5: sma(closes, 5),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma100: sma(closes, 100),
    sma200: sma(closes, 200),
    high5: high(closes, 5),
    high20: Math.max(...last20),
    high21: high(closes, 21),
    high63: high(closes, 63),
    high126: high(closes, 126),
    high252: high(closes, 252),
    low20: Math.min(...last20),
    sourceSessions: closes.length,
    sourceProvider: String(currentBar.sourceProvider ?? "alpaca").toLowerCase(),
  };
}

export async function computeAndStoreDailyMarketFeatures(
  env: Env,
  tickersInput: string[],
  sessionDate: string,
): Promise<Map<string, DailyMarketFeature>> {
  const tickers = normalizeTickers(tickersInput);
  await assertMarketDataCriticalWorkBudget(env, {
    rowsRead: tickers.length * 600,
    rowsWritten: tickers.length,
  });
  const db = getMarketDataDb(env);
  const feed = marketDataFeed(env);
  const barsByTicker = new Map<string, FeatureSourceBar[]>();
  let rowsRead = 0;
  for (let offset = 0; offset < tickers.length; offset += FEATURE_QUERY_BATCH_SIZE) {
    const chunk = tickers.slice(offset, offset + FEATURE_QUERY_BATCH_SIZE);
    const result = await db.prepare(
      `SELECT ticker, date, c, volume, source_provider as sourceProvider
         FROM alpaca_daily_bars
        WHERE feed = ?
          AND ticker IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          AND date <= ?
        ORDER BY ticker, date`,
    ).bind(feed, JSON.stringify(chunk), sessionDate).all<FeatureSourceBar>();
    rowsRead += Number(result.meta?.rows_read ?? 0);
    for (const bar of result.results ?? []) {
      const ticker = bar.ticker.toUpperCase();
      const current = barsByTicker.get(ticker) ?? [];
      current.push(bar);
      barsByTicker.set(ticker, current);
    }
  }

  const features = new Map<string, DailyMarketFeature>();
  for (const ticker of tickers) {
    const feature = computeDailyMarketFeature(ticker, sessionDate, barsByTicker.get(ticker) ?? []);
    if (feature) features.set(ticker, feature);
  }
  const statements = Array.from(features.values()).map((feature) => db.prepare(
    `INSERT INTO daily_market_features
       (feed, ticker, session_date, close, volume, previous_close, return_1d, return_5d,
        return_63d, sma_5, sma_20, sma_50, sma_100, sma_200, high_5, high_20,
        high_21, high_63, high_126, high_252, low_20, source_sessions, source_provider, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(feed, ticker, session_date) DO UPDATE SET
       close = excluded.close,
       volume = excluded.volume,
       previous_close = excluded.previous_close,
       return_1d = excluded.return_1d,
       return_5d = excluded.return_5d,
       return_63d = excluded.return_63d,
       sma_5 = excluded.sma_5,
       sma_20 = excluded.sma_20,
       sma_50 = excluded.sma_50,
       sma_100 = excluded.sma_100,
       sma_200 = excluded.sma_200,
       high_5 = excluded.high_5,
       high_20 = excluded.high_20,
       high_21 = excluded.high_21,
       high_63 = excluded.high_63,
       high_126 = excluded.high_126,
       high_252 = excluded.high_252,
       low_20 = excluded.low_20,
       source_sessions = excluded.source_sessions,
       source_provider = excluded.source_provider,
       computed_at = CURRENT_TIMESTAMP
     WHERE daily_market_features.close IS NOT excluded.close
        OR daily_market_features.volume IS NOT excluded.volume
        OR daily_market_features.previous_close IS NOT excluded.previous_close
        OR daily_market_features.return_1d IS NOT excluded.return_1d
        OR daily_market_features.return_5d IS NOT excluded.return_5d
        OR daily_market_features.return_63d IS NOT excluded.return_63d
        OR daily_market_features.sma_5 IS NOT excluded.sma_5
        OR daily_market_features.sma_20 IS NOT excluded.sma_20
        OR daily_market_features.sma_50 IS NOT excluded.sma_50
        OR daily_market_features.sma_100 IS NOT excluded.sma_100
        OR daily_market_features.sma_200 IS NOT excluded.sma_200
        OR daily_market_features.high_5 IS NOT excluded.high_5
        OR daily_market_features.high_20 IS NOT excluded.high_20
        OR daily_market_features.high_21 IS NOT excluded.high_21
        OR daily_market_features.high_63 IS NOT excluded.high_63
        OR daily_market_features.high_126 IS NOT excluded.high_126
        OR daily_market_features.high_252 IS NOT excluded.high_252
        OR daily_market_features.low_20 IS NOT excluded.low_20
        OR daily_market_features.source_sessions IS NOT excluded.source_sessions
        OR daily_market_features.source_provider IS NOT excluded.source_provider`,
  ).bind(
    feed,
    feature.ticker,
    feature.sessionDate,
    feature.close,
    feature.volume,
    feature.previousClose,
    feature.return1d,
    feature.return5d,
    feature.return63d,
    feature.sma5,
    feature.sma20,
    feature.sma50,
    feature.sma100,
    feature.sma200,
    feature.high5,
    feature.high20,
    feature.high21,
    feature.high63,
    feature.high126,
    feature.high252,
    feature.low20,
    feature.sourceSessions,
    feature.sourceProvider,
  ));
  let rowsWritten = 0;
  for (let offset = 0; offset < statements.length; offset += FEATURE_WRITE_BATCH_SIZE) {
    const results = await db.batch(statements.slice(offset, offset + FEATURE_WRITE_BATCH_SIZE));
    rowsWritten += results.reduce(
      (sum, result) => sum + Number(result.meta?.rows_written ?? result.meta?.changes ?? 0),
      0,
    );
  }
  await recordMarketDataD1Usage(env, { rowsRead, rowsWritten });
  return features;
}

export async function loadDailyMarketFeatures(
  env: Env,
  tickersInput: string[],
  sessionDate: string,
): Promise<Map<string, DailyMarketFeature>> {
  const tickers = normalizeTickers(tickersInput);
  const db = getMarketDataDb(env);
  const feed = marketDataFeed(env);
  const features = new Map<string, DailyMarketFeature>();
  for (let offset = 0; offset < tickers.length; offset += FEATURE_QUERY_BATCH_SIZE) {
    const chunk = tickers.slice(offset, offset + FEATURE_QUERY_BATCH_SIZE);
    const result = await db.prepare(
      `SELECT ticker, session_date as sessionDate, close, volume,
              previous_close as previousClose, return_1d as return1d, return_5d as return5d,
              return_63d as return63d, sma_5 as sma5, sma_20 as sma20, sma_50 as sma50,
              sma_100 as sma100, sma_200 as sma200, high_5 as high5, high_20 as high20,
              high_21 as high21, high_63 as high63, high_126 as high126,
              high_252 as high252, low_20 as low20, source_sessions as sourceSessions,
              source_provider as sourceProvider
         FROM daily_market_features
        WHERE feed = ? AND session_date = ?
          AND ticker IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
    ).bind(feed, sessionDate, JSON.stringify(chunk)).all<DailyMarketFeature>();
    for (const row of result.results ?? []) features.set(row.ticker.toUpperCase(), row);
  }
  return features;
}

function toPercent(count: number, total: number): number {
  return total > 0 ? (count / total) * 100 : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

export function aggregateDailyMarketFeatures(
  tickersInput: string[],
  features: Map<string, DailyMarketFeature>,
) {
  const tickers = normalizeTickers(tickersInput);
  const rows = tickers.map((ticker) => features.get(ticker)).filter((row): row is DailyMarketFeature => Boolean(row));
  const total = rows.length;
  const count = (values: DailyMarketFeature[], predicate: (row: DailyMarketFeature) => boolean) => values.filter(predicate).length;
  const eligible = (sessions: number) => rows.filter((row) => row.sourceSessions >= sessions);
  const coverage = (values: DailyMarketFeature[]) => {
    const coveragePct = toPercent(values.length, tickers.length);
    return {
      eligibleCount: values.length,
      coveragePct,
      thresholdPct: 95,
      status: coveragePct >= 95 ? "ready" as const : "suppressed" as const,
    };
  };
  const ma5Rows = eligible(5);
  const ma20Rows = eligible(20);
  const ma50Rows = eligible(50);
  const ma100Rows = eligible(100);
  const ma200Rows = eligible(200);
  const high21Rows = eligible(21);
  const high63Rows = eligible(63);
  const high126Rows = eligible(126);
  const high252Rows = eligible(252);
  const return5Rows = eligible(6).filter((row) => row.return5d != null);
  const return63Rows = eligible(64).filter((row) => row.return63d != null);
  const advancers = count(rows, (row) => row.return1d > 0);
  const decliners = count(rows, (row) => row.return1d < 0);
  const unchanged = total - advancers - decliners;
  return {
    memberCount: total,
    totalUniverseMembers: tickers.length,
    dataCoveragePct: toPercent(total, tickers.length),
    metricCoverage: {
      pctAbove5MA: coverage(ma5Rows),
      pctAbove20MA: coverage(ma20Rows),
      pctAbove50MA: coverage(ma50Rows),
      pctAbove100MA: coverage(ma100Rows),
      pctAbove200MA: coverage(ma200Rows),
      new5DHighs: coverage(ma5Rows),
      new1MHighs: coverage(high21Rows),
      new3MHighs: coverage(high63Rows),
      new6MHighs: coverage(high126Rows),
      new52WHighs: coverage(high252Rows),
      new20DHighs: coverage(ma20Rows),
      new20DLows: coverage(ma20Rows),
      medianReturn5D: coverage(return5Rows),
      return63D: coverage(return63Rows),
      stocksGtPos25Q: coverage(return63Rows),
      stocksLtNeg25Q: coverage(return63Rows),
    },
    advancers,
    decliners,
    unchanged,
    advDecRatio: decliners > 0 ? advancers / decliners : advancers > 0 ? null : 0,
    totalVolume: rows.reduce((sum, row) => sum + row.volume, 0),
    pctAbove5MA: toPercent(count(ma5Rows, (row) => row.close > row.sma5), ma5Rows.length),
    pctAbove20MA: toPercent(count(ma20Rows, (row) => row.close > row.sma20), ma20Rows.length),
    pctAbove50MA: toPercent(count(ma50Rows, (row) => row.close > row.sma50), ma50Rows.length),
    pctAbove100MA: toPercent(count(ma100Rows, (row) => row.close > row.sma100), ma100Rows.length),
    pctAbove200MA: toPercent(count(ma200Rows, (row) => row.close > row.sma200), ma200Rows.length),
    new5DHighs: count(ma5Rows, (row) => row.close >= row.high5),
    new1MHighs: count(high21Rows, (row) => row.close >= row.high21),
    new3MHighs: count(high63Rows, (row) => row.close >= row.high63),
    new6MHighs: count(high126Rows, (row) => row.close >= row.high126),
    new52WHighs: count(high252Rows, (row) => row.close >= row.high252),
    pctNew5DHighs: toPercent(count(ma5Rows, (row) => row.close >= row.high5), ma5Rows.length),
    pctNew1MHighs: toPercent(count(high21Rows, (row) => row.close >= row.high21), high21Rows.length),
    pctNew3MHighs: toPercent(count(high63Rows, (row) => row.close >= row.high63), high63Rows.length),
    pctNew6MHighs: toPercent(count(high126Rows, (row) => row.close >= row.high126), high126Rows.length),
    pctNew52WHighs: toPercent(count(high252Rows, (row) => row.close >= row.high252), high252Rows.length),
    stocksGtPos4Pct: count(rows, (row) => row.return1d > 4),
    stocksLtNeg4Pct: count(rows, (row) => row.return1d < -4),
    stocksGtPos25Q: count(return63Rows, (row) => row.return63d != null && row.return63d > 25),
    stocksLtNeg25Q: count(return63Rows, (row) => row.return63d != null && row.return63d < -25),
    new20DHighs: count(ma20Rows, (row) => row.close >= row.high20),
    new20DLows: count(ma20Rows, (row) => row.close <= row.low20),
    medianReturn1D: median(rows.map((row) => row.return1d)),
    medianReturn5D: median(return5Rows.map((row) => row.return5d as number)),
  };
}

const COVERAGE_GATED_BREADTH_FIELDS = {
  pctAbove5MA: "pctAbove5MA",
  pctAbove20MA: "pctAbove20MA",
  pctAbove50MA: "pctAbove50MA",
  pctAbove100MA: "pctAbove100MA",
  pctAbove200MA: "pctAbove200MA",
  new5DHighs: "new5DHighs",
  pctNew5DHighs: "new5DHighs",
  new1MHighs: "new1MHighs",
  pctNew1MHighs: "new1MHighs",
  new3MHighs: "new3MHighs",
  pctNew3MHighs: "new3MHighs",
  new6MHighs: "new6MHighs",
  pctNew6MHighs: "new6MHighs",
  new52WHighs: "new52WHighs",
  pctNew52WHighs: "new52WHighs",
  new20DHighs: "new20DHighs",
  new20DLows: "new20DLows",
  medianReturn5D: "medianReturn5D",
  stocksGtPos25Q: "stocksGtPos25Q",
  stocksLtNeg25Q: "stocksLtNeg25Q",
} as const;

export function suppressUnderCoveredBreadthMetrics(
  stats: ReturnType<typeof aggregateDailyMarketFeatures>,
): Record<string, unknown> {
  const published: Record<string, unknown> = { ...stats };
  for (const [field, coverageKey] of Object.entries(COVERAGE_GATED_BREADTH_FIELDS)) {
    if (stats.metricCoverage[coverageKey as keyof typeof stats.metricCoverage].status !== "ready") {
      published[field] = null;
    }
  }
  return published;
}
