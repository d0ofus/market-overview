export type RelativeStrengthMaType = "SMA" | "EMA";

export type RelativeStrengthOutputMode =
  | "all"
  | "rs_new_high_only"
  | "rs_new_high_before_price_only"
  | "both";

export type RelativeStrengthConfig = {
  benchmarkTicker: string;
  verticalOffset: number;
  rsMaLength: number;
  rsMaType: RelativeStrengthMaType;
  newHighLookback: number;
};

export type RelativeStrengthDailyBar = {
  ticker: string;
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
};

export type RelativeStrengthCacheRow = {
  ticker: string;
  benchmarkTicker: string;
  tradingDate: string;
  priceClose: number;
  change1d: number | null;
  rsOpen: number | null;
  rsHigh: number | null;
  rsLow: number | null;
  rsClose: number | null;
  rsMa: number | null;
  rsAboveMa: boolean;
  rsNewHigh: boolean;
  rsNewHighBeforePrice: boolean;
  bullCross: boolean;
  approxRsRating: number | null;
};

export type RelativeStrengthRatioRow = {
  ticker: string;
  benchmarkTicker: string;
  tradingDate: string;
  priceClose: number;
  benchmarkClose: number;
  rsRatioClose: number;
};

export type RelativeStrengthConfigState = {
  configKey: string;
  ticker: string;
  benchmarkTicker: string;
  rsMaType: RelativeStrengthMaType;
  rsMaLength: number;
  newHighLookback: number;
  stateVersion: number;
  latestTradingDate: string;
  updatedAt: string | null;
  priceClose: number | null;
  change1d: number | null;
  rsRatioClose: number | null;
  rsRatioMa: number | null;
  rsAboveMa: boolean;
  rsNewHigh: boolean;
  rsNewHighBeforePrice: boolean;
  bullCross: boolean;
  approxRsRating: number | null;
  priceCloseHistory: number[];
  benchmarkCloseHistory: number[];
  weightedScoreHistory: number[];
  rsNewHighWindow: number[];
  priceNewHighWindow: number[];
  smaWindow: number[];
  smaSum: number | null;
  emaValue: number | null;
  previousRsClose: number | null;
  previousRsMa: number | null;
};

export const RS_STATE_VERSION = 1;

type AlignedSeries = {
  tradingDate: string;
  priceClose: number;
  benchmarkClose: number;
  rsOpen: number | null;
  rsHigh: number | null;
  rsLow: number | null;
  rsClose: number | null;
};

function pctChange(now: number, previous: number): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(previous) || previous === 0) return null;
  return ((now - previous) / previous) * 100;
}

function toFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function highest(values: Array<number | null>, lookback: number, index: number): number | null {
  const start = Math.max(0, index - lookback + 1);
  let result: number | null = null;
  for (let current = start; current <= index; current += 1) {
    const value = values[current];
    if (value == null || !Number.isFinite(value)) continue;
    result = result == null ? value : Math.max(result, value);
  }
  return result;
}

function lowest(values: Array<number | null>, lookback: number, index: number): number | null {
  const start = Math.max(0, index - lookback + 1);
  let result: number | null = null;
  for (let current = start; current <= index; current += 1) {
    const value = values[current];
    if (value == null || !Number.isFinite(value)) continue;
    result = result == null ? value : Math.min(result, value);
  }
  return result;
}

function calculateSma(values: Array<number | null>, length: number, index: number): number | null {
  if (length <= 0 || index < length - 1) return null;
  let sum = 0;
  for (let current = index - length + 1; current <= index; current += 1) {
    const value = values[current];
    if (value == null || !Number.isFinite(value)) return null;
    sum += value;
  }
  return sum / length;
}

function calculateEma(values: Array<number | null>, length: number): Array<number | null> {
  const multiplier = 2 / (Math.max(1, length) + 1);
  const out: Array<number | null> = [];
  let previous: number | null = null;
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) {
      out.push(previous);
      continue;
    }
    previous = previous == null ? value : (value - previous) * multiplier + previous;
    out.push(previous);
  }
  return out;
}

function calculateMovingAverage(values: Array<number | null>, length: number, type: RelativeStrengthMaType): Array<number | null> {
  if (type === "EMA") return calculateEma(values, length);
  return values.map((_, index) => calculateSma(values, length, index));
}

function alignBars(
  tickerBars: RelativeStrengthDailyBar[],
  benchmarkBars: RelativeStrengthDailyBar[],
  config: RelativeStrengthConfig,
): AlignedSeries[] {
  const benchmarkByDate = new Map<string, RelativeStrengthDailyBar>();
  for (const bar of benchmarkBars) {
    benchmarkByDate.set(bar.date, bar);
  }
  const scaleFactor = config.verticalOffset * 100;
  const aligned: AlignedSeries[] = [];
  for (const bar of [...tickerBars].sort((left, right) => left.date.localeCompare(right.date))) {
    const benchmark = benchmarkByDate.get(bar.date);
    if (!benchmark || !Number.isFinite(benchmark.c) || benchmark.c === 0) continue;
    aligned.push({
      tradingDate: bar.date,
      priceClose: bar.c,
      benchmarkClose: benchmark.c,
      rsOpen: Number.isFinite(benchmark.o) && benchmark.o !== 0 ? (bar.o / benchmark.o) * scaleFactor : null,
      rsHigh: Number.isFinite(benchmark.h) && benchmark.h !== 0 ? (bar.h / benchmark.h) * scaleFactor : null,
      rsLow: Number.isFinite(benchmark.l) && benchmark.l !== 0 ? (bar.l / benchmark.l) * scaleFactor : null,
      rsClose: (bar.c / benchmark.c) * scaleFactor,
    });
  }
  return aligned;
}

function relPerformance(closeSeries: number[], benchmarkSeries: number[], index: number, lookback: number): number | null {
  const previousIndex = index - lookback;
  if (previousIndex < 0) return null;
  const closeNow = closeSeries[index];
  const closeThen = closeSeries[previousIndex];
  const benchmarkNow = benchmarkSeries[index];
  const benchmarkThen = benchmarkSeries[previousIndex];
  if (
    !Number.isFinite(closeNow) ||
    !Number.isFinite(closeThen) ||
    !Number.isFinite(benchmarkNow) ||
    !Number.isFinite(benchmarkThen) ||
    closeThen === 0 ||
    benchmarkNow === 0 ||
    benchmarkThen === 0
  ) {
    return null;
  }
  return closeNow / closeThen / (benchmarkNow / benchmarkThen) - 1;
}

function relPerformanceFromHistory(closeSeries: number[], benchmarkSeries: number[], lookback: number): number | null {
  if (closeSeries.length <= lookback || benchmarkSeries.length <= lookback) return null;
  const index = closeSeries.length - 1;
  return relPerformance(closeSeries, benchmarkSeries, index, lookback);
}

function trimWindow(values: number[], maxLength: number): number[] {
  if (maxLength <= 0) return [];
  return values.length > maxLength ? values.slice(values.length - maxLength) : [...values];
}

function appendWindow(values: number[], nextValue: number, maxLength: number): number[] {
  return trimWindow([...values, nextValue], maxLength);
}

function buildWeightedScoreSeries(priceCloseSeries: number[], benchmarkCloseSeries: number[]): number[] {
  const weightedScoreSeries: number[] = [];
  for (let index = 0; index < priceCloseSeries.length; index += 1) {
    const score =
      (relPerformance(priceCloseSeries, benchmarkCloseSeries, index, 63) ?? 0) * 0.4 +
      (relPerformance(priceCloseSeries, benchmarkCloseSeries, index, 126) ?? 0) * 0.2 +
      (relPerformance(priceCloseSeries, benchmarkCloseSeries, index, 189) ?? 0) * 0.2 +
      (relPerformance(priceCloseSeries, benchmarkCloseSeries, index, 252) ?? 0) * 0.2;
    weightedScoreSeries.push(Number.isFinite(score) ? score : 0);
  }
  return weightedScoreSeries;
}

function computeApproxRsRating(weightedScoreHistory: number[]): number {
  if (weightedScoreHistory.length === 0) return 50;
  const current = weightedScoreHistory[weightedScoreHistory.length - 1];
  let scoreMin = Number.POSITIVE_INFINITY;
  let scoreMax = Number.NEGATIVE_INFINITY;
  for (const value of weightedScoreHistory) {
    if (!Number.isFinite(value)) continue;
    scoreMin = Math.min(scoreMin, value);
    scoreMax = Math.max(scoreMax, value);
  }
  if (!Number.isFinite(current) || !Number.isFinite(scoreMin) || !Number.isFinite(scoreMax) || scoreMax === scoreMin) {
    return 50;
  }
  return Math.max(1, Math.min(99, Math.round(1 + 98 * ((current - scoreMin) / (scoreMax - scoreMin)))));
}

function latestValue(values: number[]): number | null {
  if (values.length === 0) return null;
  const value = values[values.length - 1];
  return Number.isFinite(value) ? value : null;
}

export function buildRelativeStrengthRatioRows(
  tickerBars: RelativeStrengthDailyBar[],
  benchmarkBars: RelativeStrengthDailyBar[],
  benchmarkTicker: string,
): RelativeStrengthRatioRow[] {
  const benchmarkByDate = new Map<string, RelativeStrengthDailyBar>();
  for (const bar of benchmarkBars) {
    benchmarkByDate.set(bar.date, bar);
  }
  const out: RelativeStrengthRatioRow[] = [];
  const normalizedTicker = tickerBars[0]?.ticker?.toUpperCase() ?? "";
  const normalizedBenchmark = benchmarkTicker.toUpperCase();
  for (const bar of [...tickerBars].sort((left, right) => left.date.localeCompare(right.date))) {
    const benchmark = benchmarkByDate.get(bar.date);
    if (!benchmark || !Number.isFinite(benchmark.c) || benchmark.c === 0 || !Number.isFinite(bar.c)) continue;
    out.push({
      ticker: normalizedTicker,
      benchmarkTicker: normalizedBenchmark,
      tradingDate: bar.date,
      priceClose: bar.c,
      benchmarkClose: benchmark.c,
      rsRatioClose: bar.c / benchmark.c,
    });
  }
  return out.filter((row) => row.ticker);
}

export function buildRelativeStrengthCacheRowsFromRatioRows(
  ratioRows: RelativeStrengthRatioRow[],
  config: RelativeStrengthConfig,
): RelativeStrengthCacheRow[] {
  const aligned = [...ratioRows]
    .sort((left, right) => left.tradingDate.localeCompare(right.tradingDate))
    .filter((row) => Number.isFinite(row.priceClose) && Number.isFinite(row.benchmarkClose) && row.benchmarkClose !== 0 && Number.isFinite(row.rsRatioClose));
  if (aligned.length === 0) return [];
  const scaleFactor = config.verticalOffset * 100;
  const rsCloseSeries = aligned.map((row) => row.rsRatioClose * scaleFactor);
  const priceCloseSeries = aligned.map((row) => row.priceClose);
  const benchmarkCloseSeries = aligned.map((row) => row.benchmarkClose);
  const movingAverageSeries = calculateMovingAverage(rsCloseSeries, config.rsMaLength, config.rsMaType);
  const weightedScoreSeries = buildWeightedScoreSeries(priceCloseSeries, benchmarkCloseSeries);

  return aligned.map((row, index) => {
    const rsClose = toFinite(rsCloseSeries[index]);
    const rsMa = toFinite(movingAverageSeries[index]);
    const previousRsClose = index > 0 ? toFinite(rsCloseSeries[index - 1]) : null;
    const previousRsMa = index > 0 ? toFinite(movingAverageSeries[index - 1]) : null;
    const previousPrice = index > 0 ? priceCloseSeries[index - 1] : NaN;
    const rsWindowHigh = highest(rsCloseSeries, config.newHighLookback, index);
    const priceWindowHigh = highest(priceCloseSeries.map((value) => value), config.newHighLookback, index);
    const rsNewHigh = rsClose != null && rsWindowHigh != null && rsClose >= rsWindowHigh;
    const priceNewHigh = Number.isFinite(row.priceClose) && priceWindowHigh != null && row.priceClose >= priceWindowHigh;
    const scoreMin = lowest(weightedScoreSeries, 252, index);
    const scoreMax = highest(weightedScoreSeries, 252, index);
    const weightedScore = weightedScoreSeries[index];
    const approxRsRating = weightedScore != null && scoreMin != null && scoreMax != null && scoreMax !== scoreMin
      ? Math.max(1, Math.min(99, Math.round(1 + 98 * ((weightedScore - scoreMin) / (scoreMax - scoreMin)))))
      : 50;

    return {
      ticker: row.ticker.toUpperCase(),
      benchmarkTicker: config.benchmarkTicker.toUpperCase(),
      tradingDate: row.tradingDate,
      priceClose: row.priceClose,
      change1d: index > 0 ? pctChange(row.priceClose, previousPrice) : null,
      rsOpen: null,
      rsHigh: null,
      rsLow: null,
      rsClose,
      rsMa,
      rsAboveMa: rsClose != null && rsMa != null ? rsClose >= rsMa : false,
      rsNewHigh,
      rsNewHighBeforePrice: rsNewHigh && !priceNewHigh,
      bullCross: rsClose != null && rsMa != null && previousRsClose != null && previousRsMa != null
        ? previousRsClose <= previousRsMa && rsClose > rsMa
        : false,
      approxRsRating,
    };
  }).filter((row) => row.ticker);
}

export function bootstrapRelativeStrengthStateFromRatioRows(
  ratioRows: RelativeStrengthRatioRow[],
  config: RelativeStrengthConfig,
  options: { configKey: string; updatedAt?: string | null },
): { state: RelativeStrengthConfigState; latestCacheRow: RelativeStrengthCacheRow } | null {
  const aligned = [...ratioRows]
    .sort((left, right) => left.tradingDate.localeCompare(right.tradingDate))
    .filter((row) => Number.isFinite(row.priceClose) && Number.isFinite(row.benchmarkClose) && row.benchmarkClose !== 0 && Number.isFinite(row.rsRatioClose));
  if (aligned.length === 0) return null;

  const cacheRows = buildRelativeStrengthCacheRowsFromRatioRows(aligned, config);
  const latestCacheRow = cacheRows[cacheRows.length - 1];
  if (!latestCacheRow) return null;

  const scaleFactor = config.verticalOffset * 100;
  const priceCloseSeries = aligned.map((row) => row.priceClose);
  const benchmarkCloseSeries = aligned.map((row) => row.benchmarkClose);
  const rsCloseSeries = aligned.map((row) => row.rsRatioClose * scaleFactor);
  const movingAverageSeries = calculateMovingAverage(rsCloseSeries, config.rsMaLength, config.rsMaType);
  const weightedScoreSeries = buildWeightedScoreSeries(priceCloseSeries, benchmarkCloseSeries);
  const smaWindow = config.rsMaType === "SMA"
    ? trimWindow(rsCloseSeries, config.rsMaLength)
    : [];
  const smaSum = config.rsMaType === "SMA" && smaWindow.length >= config.rsMaLength
    ? smaWindow.reduce((sum, value) => sum + value, 0)
    : null;
  const emaValue = config.rsMaType === "EMA"
    ? toFinite(movingAverageSeries[movingAverageSeries.length - 1])
    : null;

  return {
    state: {
      configKey: options.configKey,
      ticker: latestCacheRow.ticker.toUpperCase(),
      benchmarkTicker: config.benchmarkTicker.toUpperCase(),
      rsMaType: config.rsMaType,
      rsMaLength: config.rsMaLength,
      newHighLookback: config.newHighLookback,
      stateVersion: RS_STATE_VERSION,
      latestTradingDate: latestCacheRow.tradingDate,
      updatedAt: options.updatedAt ?? null,
      priceClose: latestCacheRow.priceClose,
      change1d: latestCacheRow.change1d,
      rsRatioClose: latestCacheRow.rsClose,
      rsRatioMa: latestCacheRow.rsMa,
      rsAboveMa: latestCacheRow.rsAboveMa,
      rsNewHigh: latestCacheRow.rsNewHigh,
      rsNewHighBeforePrice: latestCacheRow.rsNewHighBeforePrice,
      bullCross: latestCacheRow.bullCross,
      approxRsRating: latestCacheRow.approxRsRating,
      priceCloseHistory: trimWindow(priceCloseSeries, 253),
      benchmarkCloseHistory: trimWindow(benchmarkCloseSeries, 253),
      weightedScoreHistory: trimWindow(weightedScoreSeries, 252),
      rsNewHighWindow: trimWindow(rsCloseSeries, config.newHighLookback),
      priceNewHighWindow: trimWindow(priceCloseSeries, config.newHighLookback),
      smaWindow,
      smaSum,
      emaValue,
      previousRsClose: rsCloseSeries.length > 1 ? rsCloseSeries[rsCloseSeries.length - 2] : null,
      previousRsMa: movingAverageSeries.length > 1 ? toFinite(movingAverageSeries[movingAverageSeries.length - 2]) : null,
    },
    latestCacheRow,
  };
}

export function advanceRelativeStrengthState(
  state: RelativeStrengthConfigState,
  ratioRow: RelativeStrengthRatioRow,
  config: RelativeStrengthConfig,
  options?: { updatedAt?: string | null },
): { state: RelativeStrengthConfigState; latestCacheRow: RelativeStrengthCacheRow } {
  const scaleFactor = config.verticalOffset * 100;
  const rsClose = ratioRow.rsRatioClose * scaleFactor;
  const nextPriceHistory = appendWindow(state.priceCloseHistory, ratioRow.priceClose, 253);
  const nextBenchmarkHistory = appendWindow(state.benchmarkCloseHistory, ratioRow.benchmarkClose, 253);
  const previousPriceClose = nextPriceHistory.length > 1 ? nextPriceHistory[nextPriceHistory.length - 2] : NaN;

  let rsMa: number | null = null;
  let nextSmaWindow = state.smaWindow;
  let nextSmaSum = state.smaSum;
  let nextEmaValue = state.emaValue;
  if (config.rsMaType === "EMA") {
    const multiplier = 2 / (Math.max(1, config.rsMaLength) + 1);
    nextEmaValue = nextEmaValue == null ? rsClose : (rsClose - nextEmaValue) * multiplier + nextEmaValue;
    rsMa = nextEmaValue;
  } else {
    nextSmaWindow = appendWindow(state.smaWindow, rsClose, config.rsMaLength);
    nextSmaSum = nextSmaWindow.reduce((sum, value) => sum + value, 0);
    rsMa = nextSmaWindow.length >= config.rsMaLength ? nextSmaSum / config.rsMaLength : null;
  }

  const nextRsWindow = appendWindow(state.rsNewHighWindow, rsClose, config.newHighLookback);
  const nextPriceWindow = appendWindow(state.priceNewHighWindow, ratioRow.priceClose, config.newHighLookback);
  const rsWindowHigh = nextRsWindow.length > 0 ? Math.max(...nextRsWindow) : null;
  const priceWindowHigh = nextPriceWindow.length > 0 ? Math.max(...nextPriceWindow) : null;
  const rsNewHigh = rsWindowHigh != null && rsClose >= rsWindowHigh;
  const priceNewHigh = priceWindowHigh != null && ratioRow.priceClose >= priceWindowHigh;

  const weightedScore =
    (relPerformanceFromHistory(nextPriceHistory, nextBenchmarkHistory, 63) ?? 0) * 0.4 +
    (relPerformanceFromHistory(nextPriceHistory, nextBenchmarkHistory, 126) ?? 0) * 0.2 +
    (relPerformanceFromHistory(nextPriceHistory, nextBenchmarkHistory, 189) ?? 0) * 0.2 +
    (relPerformanceFromHistory(nextPriceHistory, nextBenchmarkHistory, 252) ?? 0) * 0.2;
  const nextWeightedScores = appendWindow(state.weightedScoreHistory, Number.isFinite(weightedScore) ? weightedScore : 0, 252);
  const approxRsRating = computeApproxRsRating(nextWeightedScores);
  const previousRsClose = state.rsRatioClose;
  const previousRsMa = state.rsRatioMa;
  const bullCross = previousRsClose != null && previousRsMa != null && rsMa != null
    ? previousRsClose <= previousRsMa && rsClose > rsMa
    : false;
  const change1d = Number.isFinite(previousPriceClose) ? pctChange(ratioRow.priceClose, previousPriceClose) : null;

  const latestCacheRow: RelativeStrengthCacheRow = {
    ticker: state.ticker.toUpperCase(),
    benchmarkTicker: config.benchmarkTicker.toUpperCase(),
    tradingDate: ratioRow.tradingDate,
    priceClose: ratioRow.priceClose,
    change1d,
    rsOpen: null,
    rsHigh: null,
    rsLow: null,
    rsClose,
    rsMa,
    rsAboveMa: rsMa != null ? rsClose >= rsMa : false,
    rsNewHigh,
    rsNewHighBeforePrice: rsNewHigh && !priceNewHigh,
    bullCross,
    approxRsRating,
  };

  return {
    state: {
      ...state,
      benchmarkTicker: config.benchmarkTicker.toUpperCase(),
      rsMaType: config.rsMaType,
      rsMaLength: config.rsMaLength,
      newHighLookback: config.newHighLookback,
      stateVersion: RS_STATE_VERSION,
      latestTradingDate: ratioRow.tradingDate,
      updatedAt: options?.updatedAt ?? state.updatedAt,
      priceClose: latestCacheRow.priceClose,
      change1d: latestCacheRow.change1d,
      rsRatioClose: latestCacheRow.rsClose,
      rsRatioMa: latestCacheRow.rsMa,
      rsAboveMa: latestCacheRow.rsAboveMa,
      rsNewHigh: latestCacheRow.rsNewHigh,
      rsNewHighBeforePrice: latestCacheRow.rsNewHighBeforePrice,
      bullCross: latestCacheRow.bullCross,
      approxRsRating: latestCacheRow.approxRsRating,
      priceCloseHistory: nextPriceHistory,
      benchmarkCloseHistory: nextBenchmarkHistory,
      weightedScoreHistory: nextWeightedScores,
      rsNewHighWindow: nextRsWindow,
      priceNewHighWindow: nextPriceWindow,
      smaWindow: nextSmaWindow,
      smaSum: nextSmaSum,
      emaValue: nextEmaValue,
      previousRsClose,
      previousRsMa,
    },
    latestCacheRow,
  };
}

export function buildRelativeStrengthCacheRows(
  tickerBars: RelativeStrengthDailyBar[],
  benchmarkBars: RelativeStrengthDailyBar[],
  config: RelativeStrengthConfig,
): RelativeStrengthCacheRow[] {
  const baseRows = buildRelativeStrengthCacheRowsFromRatioRows(
    buildRelativeStrengthRatioRows(tickerBars, benchmarkBars, config.benchmarkTicker),
    config,
  );
  if (baseRows.length === 0) return [];
  const aligned = alignBars(tickerBars, benchmarkBars, config);
  const byDate = new Map(aligned.map((row) => [row.tradingDate, row]));
  return baseRows.map((row) => {
    const alignedRow = byDate.get(row.tradingDate);
    return {
      ...row,
      rsOpen: alignedRow?.rsOpen ?? null,
      rsHigh: alignedRow?.rsHigh ?? null,
      rsLow: alignedRow?.rsLow ?? null,
    };
  });
}
