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

export function buildRelativeStrengthCacheRows(
  tickerBars: RelativeStrengthDailyBar[],
  benchmarkBars: RelativeStrengthDailyBar[],
  config: RelativeStrengthConfig,
): RelativeStrengthCacheRow[] {
  const aligned = alignBars(tickerBars, benchmarkBars, config);
  if (aligned.length === 0) return [];
  const rsCloseSeries = aligned.map((row) => row.rsClose);
  const priceCloseSeries = aligned.map((row) => row.priceClose);
  const benchmarkCloseSeries = aligned.map((row) => row.benchmarkClose);
  const movingAverageSeries = calculateMovingAverage(rsCloseSeries, config.rsMaLength, config.rsMaType);
  const weightedScoreSeries: Array<number | null> = [];

  for (let index = 0; index < aligned.length; index += 1) {
    const score =
      (relPerformance(priceCloseSeries, benchmarkCloseSeries, index, 63) ?? 0) * 0.4 +
      (relPerformance(priceCloseSeries, benchmarkCloseSeries, index, 126) ?? 0) * 0.2 +
      (relPerformance(priceCloseSeries, benchmarkCloseSeries, index, 189) ?? 0) * 0.2 +
      (relPerformance(priceCloseSeries, benchmarkCloseSeries, index, 252) ?? 0) * 0.2;
    weightedScoreSeries.push(Number.isFinite(score) ? score : null);
  }

  return aligned.map((row, index) => {
    const rsClose = toFinite(row.rsClose);
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
      ticker: tickerBars[0]?.ticker?.toUpperCase() ?? "",
      benchmarkTicker: config.benchmarkTicker.toUpperCase(),
      tradingDate: row.tradingDate,
      priceClose: row.priceClose,
      change1d: index > 0 ? pctChange(row.priceClose, previousPrice) : null,
      rsOpen: row.rsOpen,
      rsHigh: row.rsHigh,
      rsLow: row.rsLow,
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
