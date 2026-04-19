import type { MetricBundle, RankingWindow } from "./types";

const pct = (now: number, then: number): number => {
  if (!isFinite(now) || !isFinite(then) || then === 0) return 0;
  return ((now - then) / then) * 100;
};

const SPARKLINE_LOOKBACK_DAYS = 90;
const RELATIVE_STRENGTH_LOOKBACK_DAYS = 30;
const ISOLATED_OUTLIER_MOVE_PCT = 0.12;
const ISOLATED_OUTLIER_NEIGHBOR_DRIFT_PCT = 0.06;

const dailySparkline = (values: number[], lookback = SPARKLINE_LOOKBACK_DAYS): number[] =>
  values.slice(Math.max(0, values.length - lookback));

export function sanitizeBarSeries(dates: string[], closes: number[]): { dates: string[]; closes: number[] } {
  if (dates.length !== closes.length || closes.length < 3) {
    return { dates: [...dates], closes: [...closes] };
  }

  const keep = new Array(closes.length).fill(true);
  for (let i = 1; i < closes.length - 1; i += 1) {
    const prev = closes[i - 1];
    const curr = closes[i];
    const next = closes[i + 1];
    if (![prev, curr, next].every((value) => Number.isFinite(value) && value > 0)) continue;
    const baseline = (prev + next) / 2;
    if (!Number.isFinite(baseline) || baseline <= 0) continue;
    const movePct = Math.abs(curr - baseline) / baseline;
    const neighborDriftPct = Math.abs(next - prev) / baseline;
    if (movePct >= ISOLATED_OUTLIER_MOVE_PCT && neighborDriftPct <= ISOLATED_OUTLIER_NEIGHBOR_DRIFT_PCT) {
      keep[i] = false;
    }
  }

  return {
    dates: dates.filter((_, index) => keep[index]),
    closes: closes.filter((_, index) => keep[index]),
  };
}

export function computeMetrics(dates: string[], closes: number[]): MetricBundle {
  const cleaned = sanitizeBarSeries(dates, closes);
  if (cleaned.dates.length === 0 || cleaned.closes.length === 0) {
    return {
      price: 0,
      change1d: 0,
      change5d: 0,
      change1w: 0,
      change3m: 0,
      change6m: 0,
      change21d: 0,
      ytd: 0,
      pctFrom52wHigh: 0,
      sparkline: [],
    };
  }

  const seriesDates = cleaned.dates;
  const seriesCloses = cleaned.closes;
  const last = seriesCloses.length - 1;
  const price = seriesCloses[last];
  const prev1d = seriesCloses[Math.max(0, last - 1)];
  const prev5d = seriesCloses[Math.max(0, last - 5)];
  const prev63d = seriesCloses[Math.max(0, last - 63)];
  const prev126d = seriesCloses[Math.max(0, last - 126)];
  const prev21d = seriesCloses[Math.max(0, last - 21)];

  const currentYear = Number(seriesDates[last].slice(0, 4));
  let ytdAnchor = seriesCloses[0];
  for (let i = 0; i < seriesDates.length; i += 1) {
    if (Number(seriesDates[i].slice(0, 4)) === currentYear) {
      ytdAnchor = seriesCloses[i];
      break;
    }
  }

  const lookback252 = seriesCloses.slice(Math.max(0, seriesCloses.length - 252));
  const high52w = Math.max(...lookback252);

  return {
    price,
    change1d: pct(price, prev1d),
    change5d: pct(price, prev5d),
    change1w: pct(price, prev5d),
    change3m: pct(price, prev63d),
    change6m: pct(price, prev126d),
    change21d: pct(price, prev21d),
    ytd: pct(price, ytdAnchor),
    pctFrom52wHigh: pct(price, high52w),
    sparkline: dailySparkline(seriesCloses),
  };
}

export function buildRelativeStrengthSeries(
  tickerDates: string[],
  tickerCloses: number[],
  benchmarkDates: string[],
  benchmarkCloses: number[],
  lookback = RELATIVE_STRENGTH_LOOKBACK_DAYS,
): number[] | null {
  const tickerSeries = sanitizeBarSeries(tickerDates, tickerCloses);
  const benchmarkSeries = sanitizeBarSeries(benchmarkDates, benchmarkCloses);
  if (tickerSeries.dates.length === 0 || benchmarkSeries.dates.length === 0) return null;

  const benchmarkByDate = new Map<string, number>();
  for (let index = 0; index < benchmarkSeries.dates.length; index += 1) {
    const close = benchmarkSeries.closes[index];
    if (!Number.isFinite(close) || close <= 0) continue;
    benchmarkByDate.set(benchmarkSeries.dates[index], close);
  }

  const values: number[] = [];
  for (let index = 0; index < tickerSeries.dates.length; index += 1) {
    const tickerClose = tickerSeries.closes[index];
    const benchmarkClose = benchmarkByDate.get(tickerSeries.dates[index]);
    if (!Number.isFinite(tickerClose) || tickerClose <= 0 || !Number.isFinite(benchmarkClose) || benchmarkClose <= 0) continue;
    values.push(tickerClose / benchmarkClose);
  }

  if (values.length === 0) return null;
  return values.slice(Math.max(0, values.length - Math.max(1, lookback)));
}

export function rankValue(metrics: MetricBundle, window: RankingWindow): number {
  switch (window) {
    case "1D":
      return metrics.change1d;
    case "5D":
      return metrics.change5d;
    case "1W":
      return metrics.change1w;
    case "YTD":
      return metrics.ytd;
    case "52W":
      return metrics.pctFrom52wHigh;
    default:
      return metrics.change1w;
  }
}

export function sma(values: number[], period: number): number {
  if (values.length < period || period <= 0) return 0;
  const window = values.slice(values.length - period);
  return window.reduce((a, b) => a + b, 0) / period;
}

export function isPriceAboveSma(values: number[], period: number): boolean | null {
  if (period <= 0 || values.length < period) return null;
  const last = values[values.length - 1];
  if (!Number.isFinite(last)) return null;
  return last > sma(values, period);
}

type BreadthSeries = {
  closes: number[];
  volumes: number[];
};

type HighWindow = "d5" | "m1" | "m3" | "m6" | "y1";

const highWindowPeriods: Array<{ key: HighWindow; period: number }> = [
  { key: "d5", period: 5 },
  { key: "m1", period: 21 },
  { key: "m3", period: 63 },
  { key: "m6", period: 126 },
  { key: "y1", period: 252 },
];

const toPercent = (count: number, total: number): number => (total > 0 ? (count / total) * 100 : 0);

export function computeBreadthStats(seriesByTicker: Record<string, BreadthSeries>) {
  const tickers = Object.keys(seriesByTicker);
  let adv = 0;
  let dec = 0;
  let unc = 0;
  let above5 = 0;
  let above20 = 0;
  let above50 = 0;
  let above100 = 0;
  let above200 = 0;
  let highs20 = 0;
  let highs5 = 0;
  let highs21 = 0;
  let highs63 = 0;
  let highs126 = 0;
  let highs252 = 0;
  let lows20 = 0;
  let gtPos4 = 0;
  let ltNeg4 = 0;
  let gtPos25q = 0;
  let ltNeg25q = 0;
  let totalVolume = 0;
  let membersWithData = 0;
  const r1: number[] = [];
  const r5: number[] = [];

  const highCounts: Record<HighWindow, number> = {
    d5: 0,
    m1: 0,
    m3: 0,
    m6: 0,
    y1: 0,
  };

  for (const ticker of tickers) {
    const series = seriesByTicker[ticker];
    const closes = series?.closes ?? [];
    const volumes = series?.volumes ?? [];
    if (!closes || closes.length < 2) continue;
    membersWithData += 1;
    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    const d1 = ((last - prev) / prev) * 100;
    r1.push(d1);
    if (d1 > 0) adv += 1;
    else if (d1 < 0) dec += 1;
    else unc += 1;

    if (closes.length >= 6) r5.push(((last - closes[closes.length - 6]) / closes[closes.length - 6]) * 100);

    if (d1 > 4) gtPos4 += 1;
    if (d1 < -4) ltNeg4 += 1;
    if (closes.length >= 64) {
      const qReturn = ((last - closes[closes.length - 64]) / closes[closes.length - 64]) * 100;
      if (qReturn > 25) gtPos25q += 1;
      if (qReturn < -25) ltNeg25q += 1;
    }

    if (last > sma(closes, 5)) above5 += 1;
    if (last > sma(closes, 20)) above20 += 1;
    if (last > sma(closes, 50)) above50 += 1;
    if (last > sma(closes, 100)) above100 += 1;
    if (last > sma(closes, 200)) above200 += 1;

    for (const window of highWindowPeriods) {
      const lookback = closes.slice(Math.max(0, closes.length - window.period));
      if (lookback.length === 0) continue;
      if (last >= Math.max(...lookback)) {
        highCounts[window.key] += 1;
      }
    }

    const last20 = closes.slice(Math.max(0, closes.length - 20));
    if (last >= Math.max(...last20)) highs20 += 1;
    if (last <= Math.min(...last20)) lows20 += 1;

    totalVolume += volumes[volumes.length - 1] ?? 0;
  }

  highs5 = highCounts.d5;
  highs21 = highCounts.m1;
  highs63 = highCounts.m3;
  highs126 = highCounts.m6;
  highs252 = highCounts.y1;

  const total = membersWithData;
  const totalUniverseMembers = tickers.length;
  const median = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const advDecRatio = dec > 0 ? adv / dec : adv > 0 ? null : 0;

  return {
    memberCount: total,
    totalUniverseMembers,
    dataCoveragePct: totalUniverseMembers > 0 ? (total / totalUniverseMembers) * 100 : 0,
    advancers: adv,
    decliners: dec,
    unchanged: unc,
    advDecRatio,
    totalVolume,
    pctAbove5MA: toPercent(above5, total),
    pctAbove20MA: toPercent(above20, total),
    pctAbove50MA: toPercent(above50, total),
    pctAbove100MA: toPercent(above100, total),
    pctAbove200MA: toPercent(above200, total),
    new5DHighs: highs5,
    new1MHighs: highs21,
    new3MHighs: highs63,
    new6MHighs: highs126,
    new52WHighs: highs252,
    pctNew5DHighs: toPercent(highs5, total),
    pctNew1MHighs: toPercent(highs21, total),
    pctNew3MHighs: toPercent(highs63, total),
    pctNew6MHighs: toPercent(highs126, total),
    pctNew52WHighs: toPercent(highs252, total),
    stocksGtPos4Pct: gtPos4,
    stocksLtNeg4Pct: ltNeg4,
    stocksGtPos25Q: gtPos25q,
    stocksLtNeg25Q: ltNeg25q,
    new20DHighs: highs20,
    new20DLows: lows20,
    medianReturn1D: median(r1),
    medianReturn5D: median(r5),
  };
}
