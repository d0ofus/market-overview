import type { MetricBundle, RankingWindow } from "./types";

const pct = (now: number, then: number): number => {
  if (!isFinite(now) || !isFinite(then) || then === 0) return 0;
  return ((now - then) / then) * 100;
};

const clampSparkline = (values: number[], maxPoints = 60): number[] => {
  if (values.length <= maxPoints) return values;
  const step = values.length / maxPoints;
  const out: number[] = [];
  for (let i = 0; i < maxPoints; i += 1) {
    out.push(values[Math.floor(i * step)]);
  }
  return out;
};

export function computeMetrics(dates: string[], closes: number[]): MetricBundle {
  if (dates.length === 0 || closes.length === 0) {
    return {
      price: 0,
      change1d: 0,
      change5d: 0,
      change1w: 0,
      change21d: 0,
      ytd: 0,
      pctFrom52wHigh: 0,
      sparkline: [],
    };
  }

  const last = closes.length - 1;
  const price = closes[last];
  const prev1d = closes[Math.max(0, last - 1)];
  const prev5d = closes[Math.max(0, last - 5)];
  const prev21d = closes[Math.max(0, last - 21)];

  const currentYear = Number(dates[last].slice(0, 4));
  let ytdAnchor = closes[0];
  for (let i = 0; i < dates.length; i += 1) {
    if (Number(dates[i].slice(0, 4)) === currentYear) {
      ytdAnchor = closes[i];
      break;
    }
  }

  const lookback252 = closes.slice(Math.max(0, closes.length - 252));
  const high52w = Math.max(...lookback252);

  return {
    price,
    change1d: pct(price, prev1d),
    change5d: pct(price, prev5d),
    change1w: pct(price, prev5d),
    change21d: pct(price, prev21d),
    ytd: pct(price, ytdAnchor),
    pctFrom52wHigh: pct(price, high52w),
    sparkline: clampSparkline(closes.slice(Math.max(0, closes.length - 60))),
  };
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

export function computeBreadthStats(closesByTicker: Record<string, number[]>) {
  const tickers = Object.keys(closesByTicker);
  let adv = 0;
  let dec = 0;
  let unc = 0;
  let above20 = 0;
  let above50 = 0;
  let above200 = 0;
  let highs20 = 0;
  let lows20 = 0;
  const r1: number[] = [];
  const r5: number[] = [];
  for (const ticker of tickers) {
    const closes = closesByTicker[ticker];
    if (!closes || closes.length < 2) continue;
    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    const d1 = ((last - prev) / prev) * 100;
    r1.push(d1);
    if (d1 > 0.02) adv += 1;
    else if (d1 < -0.02) dec += 1;
    else unc += 1;
    if (closes.length >= 6) r5.push(((last - closes[closes.length - 6]) / closes[closes.length - 6]) * 100);
    if (last > sma(closes, 20)) above20 += 1;
    if (last > sma(closes, 50)) above50 += 1;
    if (last > sma(closes, 200)) above200 += 1;
    const last20 = closes.slice(Math.max(0, closes.length - 20));
    if (last >= Math.max(...last20)) highs20 += 1;
    if (last <= Math.min(...last20)) lows20 += 1;
  }
  const total = Math.max(1, tickers.length);
  const median = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  return {
    advancers: adv,
    decliners: dec,
    unchanged: unc,
    pctAbove20MA: (above20 / total) * 100,
    pctAbove50MA: (above50 / total) * 100,
    pctAbove200MA: (above200 / total) * 100,
    new20DHighs: highs20,
    new20DLows: lows20,
    medianReturn1D: median(r1),
    medianReturn5D: median(r5),
  };
}
