import { getMarketDataDb, marketDataFeed } from "./market-data-db";
import {
  advanceRelativeStrengthState,
  bootstrapRelativeStrengthStateFromRatioRows,
  buildRelativeStrengthRatioRows,
  RS_STATE_VERSION,
  type RelativeStrengthCacheRow,
  type RelativeStrengthConfig,
  type RelativeStrengthConfigState,
  type RelativeStrengthDailyBar,
  type RelativeStrengthMaType,
} from "./relative-strength";
import type { Env } from "./types";

const STATE_QUERY_CHUNK_SIZE = 80;
const STATE_WRITE_CHUNK_SIZE = 40;
const INCREMENTAL_ADVANCE_MAX_BARS = 20;

export type RsStateV2Rollout = {
  dualWriteEnabled: boolean;
  readEnabled: boolean;
  legacyWriteEnabled: boolean;
};

export type RsStateV2Identity = {
  configKey: string;
  benchmarkTicker: string;
  benchmarkDataTicker: string;
  rsMaType: RelativeStrengthMaType;
  rsMaLength: number;
  newHighLookback: number;
  requiredBarCount: number;
  expectedTradingDate: string;
};

export type RsStateV2Feature = {
  ticker: string;
  benchmarkTicker: string;
  rsMaType: RelativeStrengthMaType;
  rsMaLength: number;
  newHighLookback: number;
  tradingDate: string;
  priceClose: number | null;
  change1d: number | null;
  rsRatioClose: number | null;
  rsRatioMa: number | null;
  rsAboveMa: boolean;
  rsNewHigh: boolean;
  rsNewHighBeforePrice: boolean;
  bullCross: boolean;
  approxRsRating: number | null;
};

type CompactState = {
  configKey: string;
  ticker: string;
  benchmarkTicker: string;
  rsMaType: RelativeStrengthMaType;
  rsMaLength: number;
  newHighLookback: number;
  stateVersion: number;
  latestTradingDate: string;
  priceCloseHistory: number[];
  benchmarkCloseHistory: number[];
  weightedScoreHistory: number[];
  rsNewHighWindow: number[];
  priceNewHighWindow: number[];
  smaWindow: number[];
  smaSum: number | null;
  emaValue: number | null;
  lastRsClose: number | null;
  lastRsMa: number | null;
};

type CompactStateRecord = {
  configKey: string;
  ticker: string;
  benchmarkTicker: string;
  rsMaType: string;
  rsMaLength: number;
  newHighLookback: number;
  stateVersion: number;
  latestTradingDate: string;
  priceCloseHistoryJson: string;
  benchmarkCloseHistoryJson: string;
  weightedScoreHistoryJson: string;
  rsNewHighWindowJson: string;
  priceNewHighWindowJson: string;
  smaWindowJson: string;
  smaSum: number | null;
  emaValue: number | null;
  lastRsClose: number | null;
  lastRsMa: number | null;
};

type FeatureRecord = RsStateV2Feature & {
  rsAboveMa: number | boolean;
  rsNewHigh: number | boolean;
  rsNewHighBeforePrice: number | boolean;
  bullCross: number | boolean;
};

export type RsStateV2MaterializationResult = {
  features: RsStateV2Feature[];
  cacheHitTickers: number;
  computedTickers: number;
  bootstrappedTickers: number;
};

export type RsStateV2ParityResult = {
  checkedCount: number;
  mismatchCount: number;
  mismatches: Array<{ ticker: string; fields: string[] }>;
};

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function rsStateV2Rollout(env: Env): RsStateV2Rollout {
  return {
    dualWriteEnabled: envBoolean(env.RS_STATE_V2_DUAL_WRITE_ENABLED, false),
    readEnabled: envBoolean(env.RS_STATE_V2_READ_ENABLED, false),
    legacyWriteEnabled: envBoolean(env.RS_LEGACY_CACHE_WRITE_ENABLED, true),
  };
}

export function legacyRsCacheRetired(env: Env): boolean {
  const rollout = rsStateV2Rollout(env);
  return rollout.readEnabled && !rollout.legacyWriteEnabled;
}

function parseNumberArray(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(Number).filter(Number.isFinite);
  } catch {
    return [];
  }
}

function normalizeMaType(value: string): RelativeStrengthMaType {
  return value === "SMA" ? "SMA" : "EMA";
}

function asBoolean(value: number | boolean): boolean {
  return value === true || value === 1;
}

function compactStateFromRecord(row: CompactStateRecord): CompactState {
  return {
    configKey: row.configKey,
    ticker: row.ticker.toUpperCase(),
    benchmarkTicker: row.benchmarkTicker.toUpperCase(),
    rsMaType: normalizeMaType(row.rsMaType),
    rsMaLength: Math.max(1, Math.trunc(Number(row.rsMaLength))),
    newHighLookback: Math.max(1, Math.trunc(Number(row.newHighLookback))),
    stateVersion: Math.trunc(Number(row.stateVersion)),
    latestTradingDate: row.latestTradingDate,
    priceCloseHistory: parseNumberArray(row.priceCloseHistoryJson),
    benchmarkCloseHistory: parseNumberArray(row.benchmarkCloseHistoryJson),
    weightedScoreHistory: parseNumberArray(row.weightedScoreHistoryJson),
    rsNewHighWindow: parseNumberArray(row.rsNewHighWindowJson),
    priceNewHighWindow: parseNumberArray(row.priceNewHighWindowJson),
    smaWindow: parseNumberArray(row.smaWindowJson),
    smaSum: row.smaSum == null ? null : Number(row.smaSum),
    emaValue: row.emaValue == null ? null : Number(row.emaValue),
    lastRsClose: row.lastRsClose == null ? null : Number(row.lastRsClose),
    lastRsMa: row.lastRsMa == null ? null : Number(row.lastRsMa),
  };
}

function stateForAdvance(row: CompactState): RelativeStrengthConfigState {
  return {
    configKey: row.configKey,
    ticker: row.ticker,
    benchmarkTicker: row.benchmarkTicker,
    rsMaType: row.rsMaType,
    rsMaLength: row.rsMaLength,
    newHighLookback: row.newHighLookback,
    stateVersion: row.stateVersion,
    latestTradingDate: row.latestTradingDate,
    updatedAt: null,
    priceClose: row.priceCloseHistory[row.priceCloseHistory.length - 1] ?? null,
    change1d: null,
    rsRatioClose: row.lastRsClose,
    rsRatioMa: row.lastRsMa,
    rsAboveMa: false,
    rsNewHigh: false,
    rsNewHighBeforePrice: false,
    bullCross: false,
    approxRsRating: null,
    priceCloseHistory: row.priceCloseHistory,
    benchmarkCloseHistory: row.benchmarkCloseHistory,
    weightedScoreHistory: row.weightedScoreHistory,
    rsNewHighWindow: row.rsNewHighWindow,
    priceNewHighWindow: row.priceNewHighWindow,
    smaWindow: row.smaWindow,
    smaSum: row.smaSum,
    emaValue: row.emaValue,
    previousRsClose: null,
    previousRsMa: null,
  };
}

function compactStateFromState(state: RelativeStrengthConfigState): CompactState {
  return {
    configKey: state.configKey,
    ticker: state.ticker.toUpperCase(),
    benchmarkTicker: state.benchmarkTicker.toUpperCase(),
    rsMaType: state.rsMaType,
    rsMaLength: state.rsMaLength,
    newHighLookback: state.newHighLookback,
    stateVersion: state.stateVersion,
    latestTradingDate: state.latestTradingDate,
    priceCloseHistory: state.priceCloseHistory,
    benchmarkCloseHistory: state.benchmarkCloseHistory,
    weightedScoreHistory: state.weightedScoreHistory,
    rsNewHighWindow: state.rsNewHighWindow,
    priceNewHighWindow: state.priceNewHighWindow,
    smaWindow: state.smaWindow,
    smaSum: state.smaSum,
    emaValue: state.emaValue,
    lastRsClose: state.rsRatioClose,
    lastRsMa: state.rsRatioMa,
  };
}

function featureFromCacheRow(row: RelativeStrengthCacheRow, identity: RsStateV2Identity): RsStateV2Feature {
  return {
    ticker: row.ticker.toUpperCase(),
    benchmarkTicker: identity.benchmarkTicker.toUpperCase(),
    rsMaType: identity.rsMaType,
    rsMaLength: identity.rsMaLength,
    newHighLookback: identity.newHighLookback,
    tradingDate: row.tradingDate,
    priceClose: row.priceClose,
    change1d: row.change1d,
    rsRatioClose: row.rsClose,
    rsRatioMa: row.rsMa,
    rsAboveMa: row.rsAboveMa,
    rsNewHigh: row.rsNewHigh,
    rsNewHighBeforePrice: row.rsNewHighBeforePrice,
    bullCross: row.bullCross,
    approxRsRating: row.approxRsRating,
  };
}

function groupBarsByTicker(rows: RelativeStrengthDailyBar[]): Map<string, RelativeStrengthDailyBar[]> {
  const grouped = new Map<string, RelativeStrengthDailyBar[]>();
  for (const row of rows) {
    const ticker = row.ticker.toUpperCase();
    const current = grouped.get(ticker) ?? [];
    current.push({ ...row, ticker });
    grouped.set(ticker, current);
  }
  for (const rowsForTicker of grouped.values()) {
    rowsForTicker.sort((left, right) => left.date.localeCompare(right.date));
  }
  return grouped;
}

async function loadBarsByCount(
  env: Env,
  tickers: string[],
  endDate: string,
  limit: number,
): Promise<RelativeStrengthDailyBar[]> {
  const normalized = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  if (normalized.length === 0) return [];
  const db = getMarketDataDb(env);
  const feed = marketDataFeed(env);
  const output: RelativeStrengthDailyBar[] = [];
  for (let index = 0; index < normalized.length; index += STATE_QUERY_CHUNK_SIZE) {
    const chunk = normalized.slice(index, index + STATE_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.prepare(
      `SELECT ticker, date, o, h, l, c, volume
       FROM (
         SELECT ticker, date, o, h, l, c, volume,
                ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS row_number
         FROM alpaca_daily_bars
         WHERE feed = ? AND ticker IN (${placeholders}) AND date <= ?
       )
       WHERE row_number <= ?
       ORDER BY ticker ASC, date ASC`,
    ).bind(feed, ...chunk, endDate, limit).all<RelativeStrengthDailyBar>();
    output.push(...(rows.results ?? []));
  }
  return output;
}

async function loadBarsInRange(
  env: Env,
  tickers: string[],
  startDate: string,
  endDate: string,
): Promise<RelativeStrengthDailyBar[]> {
  const normalized = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  if (normalized.length === 0) return [];
  const db = getMarketDataDb(env);
  const feed = marketDataFeed(env);
  const output: RelativeStrengthDailyBar[] = [];
  for (let index = 0; index < normalized.length; index += STATE_QUERY_CHUNK_SIZE) {
    const chunk = normalized.slice(index, index + STATE_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.prepare(
      `SELECT ticker, date, o, h, l, c, volume
       FROM alpaca_daily_bars
       WHERE feed = ? AND ticker IN (${placeholders}) AND date > ? AND date <= ?
       ORDER BY ticker ASC, date ASC`,
    ).bind(feed, ...chunk, startDate, endDate).all<RelativeStrengthDailyBar>();
    output.push(...(rows.results ?? []));
  }
  return output;
}

async function loadCompactStates(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  configKey: string,
  tickers: string[],
): Promise<Map<string, CompactState>> {
  const output = new Map<string, CompactState>();
  for (let index = 0; index < tickers.length; index += STATE_QUERY_CHUNK_SIZE) {
    const chunk = tickers.slice(index, index + STATE_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.SCANNER_CACHE_DB.prepare(
      `SELECT config_key as configKey, ticker, benchmark_ticker as benchmarkTicker,
              rs_ma_type as rsMaType, rs_ma_length as rsMaLength,
              new_high_lookback as newHighLookback, state_version as stateVersion,
              latest_trading_date as latestTradingDate,
              price_close_history_json as priceCloseHistoryJson,
              benchmark_close_history_json as benchmarkCloseHistoryJson,
              weighted_score_history_json as weightedScoreHistoryJson,
              rs_new_high_window_json as rsNewHighWindowJson,
              price_new_high_window_json as priceNewHighWindowJson,
              sma_window_json as smaWindowJson, sma_sum as smaSum,
              ema_value as emaValue, last_rs_close as lastRsClose, last_rs_ma as lastRsMa
       FROM rs_state_latest
       WHERE config_key = ? AND ticker IN (${placeholders})`,
    ).bind(configKey, ...chunk).all<CompactStateRecord>();
    for (const row of rows.results ?? []) output.set(row.ticker.toUpperCase(), compactStateFromRecord(row));
  }
  return output;
}

export async function loadRsStateV2Features(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  configKey: string,
  tickers: string[],
  tradingDate: string,
): Promise<Map<string, RsStateV2Feature>> {
  const normalized = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  const output = new Map<string, RsStateV2Feature>();
  for (let index = 0; index < normalized.length; index += STATE_QUERY_CHUNK_SIZE) {
    const chunk = normalized.slice(index, index + STATE_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.SCANNER_CACHE_DB.prepare(
      `SELECT ticker, benchmark_ticker as benchmarkTicker, rs_ma_type as rsMaType,
              rs_ma_length as rsMaLength, new_high_lookback as newHighLookback,
              trading_date as tradingDate, price_close as priceClose, change_1d as change1d,
              rs_ratio_close as rsRatioClose, rs_ratio_ma as rsRatioMa,
              rs_above_ma as rsAboveMa, rs_new_high as rsNewHigh,
              rs_new_high_before_price as rsNewHighBeforePrice, bull_cross as bullCross,
              approx_rs_rating as approxRsRating
       FROM rs_features_latest
       WHERE config_key = ? AND trading_date = ? AND status = 'computed'
         AND ticker IN (${placeholders})`,
    ).bind(configKey, tradingDate, ...chunk).all<FeatureRecord>();
    for (const row of rows.results ?? []) {
      const ticker = row.ticker.toUpperCase();
      output.set(ticker, {
        ...row,
        ticker,
        benchmarkTicker: row.benchmarkTicker.toUpperCase(),
        rsMaType: normalizeMaType(row.rsMaType),
        rsAboveMa: asBoolean(row.rsAboveMa),
        rsNewHigh: asBoolean(row.rsNewHigh),
        rsNewHighBeforePrice: asBoolean(row.rsNewHighBeforePrice),
        bullCross: asBoolean(row.bullCross),
      });
    }
  }
  return output;
}

function prepareStateUpsert(db: D1Database, row: CompactState): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO rs_state_latest
      (config_key, ticker, benchmark_ticker, rs_ma_type, rs_ma_length, new_high_lookback,
       state_version, latest_trading_date, price_close_history_json,
       benchmark_close_history_json, weighted_score_history_json, rs_new_high_window_json,
       price_new_high_window_json, sma_window_json, sma_sum, ema_value, last_rs_close,
       last_rs_ma, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(config_key, ticker) DO UPDATE SET
       benchmark_ticker = excluded.benchmark_ticker,
       rs_ma_type = excluded.rs_ma_type,
       rs_ma_length = excluded.rs_ma_length,
       new_high_lookback = excluded.new_high_lookback,
       state_version = excluded.state_version,
       latest_trading_date = excluded.latest_trading_date,
       price_close_history_json = excluded.price_close_history_json,
       benchmark_close_history_json = excluded.benchmark_close_history_json,
       weighted_score_history_json = excluded.weighted_score_history_json,
       rs_new_high_window_json = excluded.rs_new_high_window_json,
       price_new_high_window_json = excluded.price_new_high_window_json,
       sma_window_json = excluded.sma_window_json,
       sma_sum = excluded.sma_sum,
       ema_value = excluded.ema_value,
       last_rs_close = excluded.last_rs_close,
       last_rs_ma = excluded.last_rs_ma,
       updated_at = CURRENT_TIMESTAMP
     WHERE excluded.latest_trading_date > rs_state_latest.latest_trading_date
        OR excluded.state_version IS NOT rs_state_latest.state_version
        OR excluded.price_close_history_json IS NOT rs_state_latest.price_close_history_json
        OR excluded.benchmark_close_history_json IS NOT rs_state_latest.benchmark_close_history_json
        OR excluded.weighted_score_history_json IS NOT rs_state_latest.weighted_score_history_json
        OR excluded.rs_new_high_window_json IS NOT rs_state_latest.rs_new_high_window_json
        OR excluded.price_new_high_window_json IS NOT rs_state_latest.price_new_high_window_json
        OR excluded.sma_window_json IS NOT rs_state_latest.sma_window_json
        OR excluded.sma_sum IS NOT rs_state_latest.sma_sum
        OR excluded.ema_value IS NOT rs_state_latest.ema_value
        OR excluded.last_rs_close IS NOT rs_state_latest.last_rs_close
        OR excluded.last_rs_ma IS NOT rs_state_latest.last_rs_ma`,
  ).bind(
    row.configKey,
    row.ticker,
    row.benchmarkTicker,
    row.rsMaType,
    row.rsMaLength,
    row.newHighLookback,
    row.stateVersion,
    row.latestTradingDate,
    JSON.stringify(row.priceCloseHistory),
    JSON.stringify(row.benchmarkCloseHistory),
    JSON.stringify(row.weightedScoreHistory),
    JSON.stringify(row.rsNewHighWindow),
    JSON.stringify(row.priceNewHighWindow),
    JSON.stringify(row.smaWindow),
    row.smaSum,
    row.emaValue,
    row.lastRsClose,
    row.lastRsMa,
  );
}

function prepareFeatureUpsert(
  db: D1Database,
  identity: RsStateV2Identity,
  row: RsStateV2Feature,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO rs_features_latest
      (config_key, ticker, expected_trading_date, trading_date, benchmark_ticker,
       rs_ma_type, rs_ma_length, new_high_lookback, price_close, change_1d,
       rs_ratio_close, rs_ratio_ma, rs_above_ma, rs_new_high,
       rs_new_high_before_price, bull_cross, approx_rs_rating, status, reason, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'computed', NULL, CURRENT_TIMESTAMP)
     ON CONFLICT(config_key, ticker) DO UPDATE SET
       expected_trading_date = excluded.expected_trading_date,
       trading_date = excluded.trading_date,
       benchmark_ticker = excluded.benchmark_ticker,
       rs_ma_type = excluded.rs_ma_type,
       rs_ma_length = excluded.rs_ma_length,
       new_high_lookback = excluded.new_high_lookback,
       price_close = excluded.price_close,
       change_1d = excluded.change_1d,
       rs_ratio_close = excluded.rs_ratio_close,
       rs_ratio_ma = excluded.rs_ratio_ma,
       rs_above_ma = excluded.rs_above_ma,
       rs_new_high = excluded.rs_new_high,
       rs_new_high_before_price = excluded.rs_new_high_before_price,
       bull_cross = excluded.bull_cross,
       approx_rs_rating = excluded.approx_rs_rating,
       status = 'computed', reason = NULL, computed_at = CURRENT_TIMESTAMP
     WHERE excluded.trading_date > rs_features_latest.trading_date
        OR excluded.expected_trading_date IS NOT rs_features_latest.expected_trading_date
        OR excluded.price_close IS NOT rs_features_latest.price_close
        OR excluded.change_1d IS NOT rs_features_latest.change_1d
        OR excluded.rs_ratio_close IS NOT rs_features_latest.rs_ratio_close
        OR excluded.rs_ratio_ma IS NOT rs_features_latest.rs_ratio_ma
        OR excluded.rs_above_ma IS NOT rs_features_latest.rs_above_ma
        OR excluded.rs_new_high IS NOT rs_features_latest.rs_new_high
        OR excluded.rs_new_high_before_price IS NOT rs_features_latest.rs_new_high_before_price
        OR excluded.bull_cross IS NOT rs_features_latest.bull_cross
        OR excluded.approx_rs_rating IS NOT rs_features_latest.approx_rs_rating
        OR rs_features_latest.status != 'computed'`,
  ).bind(
    identity.configKey,
    row.ticker,
    identity.expectedTradingDate,
    row.tradingDate,
    row.benchmarkTicker,
    row.rsMaType,
    row.rsMaLength,
    row.newHighLookback,
    row.priceClose,
    row.change1d,
    row.rsRatioClose,
    row.rsRatioMa,
    row.rsAboveMa ? 1 : 0,
    row.rsNewHigh ? 1 : 0,
    row.rsNewHighBeforePrice ? 1 : 0,
    row.bullCross ? 1 : 0,
    row.approxRsRating,
  );
}

async function persistStateAndFeatures(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  identity: RsStateV2Identity,
  rows: Array<{ state: CompactState; feature: RsStateV2Feature }>,
): Promise<void> {
  for (let index = 0; index < rows.length; index += STATE_WRITE_CHUNK_SIZE) {
    const statements = rows.slice(index, index + STATE_WRITE_CHUNK_SIZE).flatMap((row) => [
      prepareStateUpsert(env.SCANNER_CACHE_DB, row.state),
      prepareFeatureUpsert(env.SCANNER_CACHE_DB, identity, row.feature),
    ]);
    await env.SCANNER_CACHE_DB.batch(statements);
  }
}

export async function materializeRsStateV2(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  identity: RsStateV2Identity,
  tickers: string[],
  benchmarkBars?: RelativeStrengthDailyBar[],
): Promise<RsStateV2MaterializationResult> {
  const normalized = Array.from(new Set(
    tickers.map((ticker) => ticker.trim().toUpperCase()).filter((ticker) => (
      ticker && ticker !== identity.benchmarkTicker && ticker !== identity.benchmarkDataTicker
    )),
  ));
  if (normalized.length === 0) {
    return { features: [], cacheHitTickers: 0, computedTickers: 0, bootstrappedTickers: 0 };
  }

  const config: RelativeStrengthConfig = {
    benchmarkTicker: identity.benchmarkTicker,
    verticalOffset: 0.01,
    rsMaLength: identity.rsMaLength,
    rsMaType: identity.rsMaType,
    newHighLookback: identity.newHighLookback,
  };
  const states = await loadCompactStates(env, identity.configKey, normalized);
  const currentFeatures = await loadRsStateV2Features(env, identity.configKey, normalized, identity.expectedTradingDate);
  const output = new Map<string, RsStateV2Feature>();
  const bootstrap = new Set<string>();
  const incremental: string[] = [];
  let cacheHitTickers = 0;

  for (const ticker of normalized) {
    const state = states.get(ticker);
    const feature = currentFeatures.get(ticker);
    if (state?.stateVersion === RS_STATE_VERSION && state.latestTradingDate === identity.expectedTradingDate && feature) {
      output.set(ticker, feature);
      cacheHitTickers += 1;
    } else if (state?.stateVersion === RS_STATE_VERSION && state.latestTradingDate < identity.expectedTradingDate) {
      incremental.push(ticker);
    } else {
      bootstrap.add(ticker);
    }
  }

  const benchmark = benchmarkBars?.length
    ? [...benchmarkBars].sort((left, right) => left.date.localeCompare(right.date))
    : await loadBarsByCount(env, [identity.benchmarkDataTicker], identity.expectedTradingDate, identity.requiredBarCount);
  const writes: Array<{ state: CompactState; feature: RsStateV2Feature }> = [];

  if (incremental.length > 0) {
    const earliestDate = incremental.reduce((earliest, ticker) => {
      const date = states.get(ticker)?.latestTradingDate ?? identity.expectedTradingDate;
      return date < earliest ? date : earliest;
    }, identity.expectedTradingDate);
    const barsByTicker = groupBarsByTicker(await loadBarsInRange(env, incremental, earliestDate, identity.expectedTradingDate));
    for (const ticker of incremental) {
      const compact = states.get(ticker);
      if (!compact) {
        bootstrap.add(ticker);
        continue;
      }
      const ratioRows = buildRelativeStrengthRatioRows(barsByTicker.get(ticker) ?? [], benchmark, identity.benchmarkTicker)
        .filter((row) => row.tradingDate > compact.latestTradingDate);
      const latest = ratioRows[ratioRows.length - 1];
      if (!latest || latest.tradingDate !== identity.expectedTradingDate || ratioRows.length > INCREMENTAL_ADVANCE_MAX_BARS) {
        bootstrap.add(ticker);
        continue;
      }
      let state = stateForAdvance(compact);
      let latestFeature: RsStateV2Feature | null = null;
      for (const row of ratioRows) {
        const advanced = advanceRelativeStrengthState(state, row, config);
        state = advanced.state;
        latestFeature = featureFromCacheRow(advanced.latestCacheRow, identity);
      }
      if (!latestFeature || state.latestTradingDate !== identity.expectedTradingDate) {
        bootstrap.add(ticker);
        continue;
      }
      output.set(ticker, latestFeature);
      writes.push({ state: compactStateFromState(state), feature: latestFeature });
    }
  }

  if (bootstrap.size > 0) {
    const bootstrapTickers = Array.from(bootstrap);
    const barsByTicker = groupBarsByTicker(await loadBarsByCount(
      env,
      bootstrapTickers,
      identity.expectedTradingDate,
      identity.requiredBarCount,
    ));
    for (const ticker of bootstrapTickers) {
      const ratioRows = buildRelativeStrengthRatioRows(barsByTicker.get(ticker) ?? [], benchmark, identity.benchmarkTicker);
      const bootstrapped = bootstrapRelativeStrengthStateFromRatioRows(ratioRows, config, {
        configKey: identity.configKey,
      });
      if (!bootstrapped || bootstrapped.latestCacheRow.tradingDate !== identity.expectedTradingDate) continue;
      const feature = featureFromCacheRow(bootstrapped.latestCacheRow, identity);
      output.set(ticker, feature);
      writes.push({ state: compactStateFromState(bootstrapped.state), feature });
    }
  }

  await persistStateAndFeatures(env, identity, writes);
  return {
    features: Array.from(output.values()),
    cacheHitTickers,
    computedTickers: writes.length,
    bootstrappedTickers: writes.filter((row) => bootstrap.has(row.feature.ticker)).length,
  };
}

function numericEqual(left: number | null, right: number | null, tolerance: number): boolean {
  if (left == null || right == null) return left === right;
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

export function compareRsStateV2Parity(
  expectedTickers: string[],
  legacyRows: Map<string, RsStateV2Feature>,
  v2Rows: Map<string, RsStateV2Feature>,
  tolerance = 1e-10,
): RsStateV2ParityResult {
  const mismatches: Array<{ ticker: string; fields: string[] }> = [];
  const tickers = Array.from(new Set(expectedTickers.map((ticker) => ticker.toUpperCase()))).sort();
  for (const ticker of tickers) {
    const legacy = legacyRows.get(ticker);
    const v2 = v2Rows.get(ticker);
    const fields: string[] = [];
    if (!legacy || !v2) {
      fields.push("inclusion");
    } else {
      if (legacy.tradingDate !== v2.tradingDate) fields.push("tradingDate");
      if (legacy.rsAboveMa !== v2.rsAboveMa) fields.push("rsAboveMa");
      if (legacy.rsNewHigh !== v2.rsNewHigh) fields.push("rsNewHigh");
      if (legacy.rsNewHighBeforePrice !== v2.rsNewHighBeforePrice) fields.push("rsNewHighBeforePrice");
      if (legacy.bullCross !== v2.bullCross) fields.push("bullCross");
      if (legacy.approxRsRating !== v2.approxRsRating) fields.push("approxRsRating");
      const numericFields: Array<keyof Pick<RsStateV2Feature, "priceClose" | "change1d" | "rsRatioClose" | "rsRatioMa">> = [
        "priceClose", "change1d", "rsRatioClose", "rsRatioMa",
      ];
      for (const field of numericFields) {
        if (!numericEqual(legacy[field], v2[field], tolerance)) fields.push(field);
      }
    }
    if (fields.length > 0) mismatches.push({ ticker, fields });
  }
  return { checkedCount: tickers.length, mismatchCount: mismatches.length, mismatches };
}

export async function recordRsStateV2Parity(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  result: RsStateV2ParityResult,
): Promise<void> {
  await env.SCANNER_CACHE_DB.prepare(
    `INSERT INTO rs_state_v2_status
      (id, last_parity_at, checked_count, mismatch_count, last_details_json, updated_at)
     VALUES (1, CURRENT_TIMESTAMP, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       last_parity_at = excluded.last_parity_at,
       checked_count = excluded.checked_count,
       mismatch_count = excluded.mismatch_count,
       last_details_json = excluded.last_details_json,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(result.checkedCount, result.mismatchCount, JSON.stringify(result.mismatches.slice(0, 25))).run();
}
