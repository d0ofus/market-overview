export type VcpConfig = {
  dailyPivotLookback: number;
  weeklyHighLookback: number;
  pivotAgeBars: number;
  dailyNearPct: number;
  weeklyNearPct: number;
};

export type VcpDailyBar = {
  ticker: string;
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  volume?: number | null;
};

export type VcpFeatureRow = {
  ticker: string;
  tradingDate: string;
  priceClose: number;
  change1d: number | null;
  sma50: number | null;
  sma150: number | null;
  sma200: number | null;
  dailyPivot: number | null;
  dailyPivotGapPct: number | null;
  weeklyHigh: number | null;
  weeklyHighGapPct: number | null;
  volSma20: number | null;
  trendScore: number;
  trendTemplate: boolean;
  pivotStable: boolean;
  dailyNear: boolean;
  weeklyNear: boolean;
  higherLows: boolean;
  volumeContracting: boolean;
  vcpSignal: boolean;
};

export const DEFAULT_VCP_CONFIG: VcpConfig = {
  dailyPivotLookback: 100,
  weeklyHighLookback: 100,
  pivotAgeBars: 10,
  dailyNearPct: 7,
  weeklyNearPct: 20,
};

const DEFAULT_MINTICK = 0.01;

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function clampPercent(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function normalizeVcpConfig(input: Partial<VcpConfig> | null | undefined): VcpConfig {
  return {
    dailyPivotLookback: clampInteger(input?.dailyPivotLookback ?? DEFAULT_VCP_CONFIG.dailyPivotLookback, 5, 520),
    weeklyHighLookback: clampInteger(input?.weeklyHighLookback ?? DEFAULT_VCP_CONFIG.weeklyHighLookback, 5, 260),
    pivotAgeBars: clampInteger(input?.pivotAgeBars ?? DEFAULT_VCP_CONFIG.pivotAgeBars, 1, 120),
    dailyNearPct: clampPercent(input?.dailyNearPct ?? DEFAULT_VCP_CONFIG.dailyNearPct, 0.1, 50),
    weeklyNearPct: clampPercent(input?.weeklyNearPct ?? DEFAULT_VCP_CONFIG.weeklyNearPct, 0.1, 80),
  };
}

export function vcpConfigKey(config: VcpConfig): string {
  const normalized = normalizeVcpConfig(config);
  return [
    "vcp",
    normalized.dailyPivotLookback,
    normalized.weeklyHighLookback,
    normalized.pivotAgeBars,
    normalized.dailyNearPct,
    normalized.weeklyNearPct,
  ].join("|");
}

export function requiredVcpBarCount(config: VcpConfig): number {
  const normalized = normalizeVcpConfig(config);
  return Math.max(
    520,
    252,
    220,
    60,
    50,
    normalized.dailyPivotLookback + normalized.pivotAgeBars + 2,
    normalized.weeklyHighLookback * 5 + 10,
  );
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sma(values: number[], length: number, index: number): number | null {
  if (length <= 0 || index < length - 1) return null;
  let sum = 0;
  for (let current = index - length + 1; current <= index; current += 1) {
    const value = values[current];
    if (!Number.isFinite(value)) return null;
    sum += value;
  }
  return sum / length;
}

function highest(values: number[], length: number, index: number): number | null {
  if (length <= 0 || index < 0) return null;
  const start = Math.max(0, index - length + 1);
  let result: number | null = null;
  for (let current = start; current <= index; current += 1) {
    const value = values[current];
    if (!Number.isFinite(value)) continue;
    result = result == null ? value : Math.max(result, value);
  }
  return result;
}

function lowest(values: number[], length: number, index: number): number | null {
  if (length <= 0 || index < 0) return null;
  const start = Math.max(0, index - length + 1);
  let result: number | null = null;
  for (let current = start; current <= index; current += 1) {
    const value = values[current];
    if (!Number.isFinite(value)) continue;
    result = result == null ? value : Math.min(result, value);
  }
  return result;
}

function priorPivotAt(highs: number[], lookback: number, index: number): number | null {
  if (index <= 0) return null;
  const start = Math.max(0, index - lookback);
  let result: number | null = null;
  for (let current = start; current <= index - 1; current += 1) {
    const value = highs[current];
    if (!Number.isFinite(value)) continue;
    result = result == null ? value : Math.max(result, value);
  }
  return result;
}

function pctChange(now: number | null | undefined, previous: number | null | undefined): number | null {
  if (now == null || previous == null || !Number.isFinite(now) || !Number.isFinite(previous) || previous === 0) return null;
  return ((now - previous) / previous) * 100;
}

function pctGapToLevel(level: number | null, close: number): number | null {
  if (level == null || !Number.isFinite(level) || !Number.isFinite(close) || close === 0) return null;
  return (level / close - 1) * 100;
}

function weekStartIso(dateIso: string): string {
  const parsed = new Date(`${dateIso}T00:00:00Z`);
  const day = parsed.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  parsed.setUTCDate(parsed.getUTCDate() + mondayOffset);
  return parsed.toISOString().slice(0, 10);
}

function weeklyHighAndClose(bars: VcpDailyBar[], lookback: number): { high: number | null; close: number | null } {
  const weekly = new Map<string, { high: number; close: number; lastDate: string }>();
  for (const bar of bars) {
    if (!Number.isFinite(bar.h) || !Number.isFinite(bar.c)) continue;
    const key = weekStartIso(bar.date);
    const current = weekly.get(key);
    if (!current) {
      weekly.set(key, { high: bar.h, close: bar.c, lastDate: bar.date });
      continue;
    }
    current.high = Math.max(current.high, bar.h);
    if (bar.date >= current.lastDate) {
      current.close = bar.c;
      current.lastDate = bar.date;
    }
  }
  const rows = Array.from(weekly.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([, row]) => row);
  if (rows.length === 0) return { high: null, close: null };
  const slice = rows.slice(-Math.max(1, lookback));
  return {
    high: Math.max(...slice.map((row) => row.high)),
    close: rows[rows.length - 1]?.close ?? null,
  };
}

export function buildVcpFeatureRow(
  rawBars: VcpDailyBar[],
  rawConfig: Partial<VcpConfig> | null | undefined,
  options?: { mintick?: number },
): VcpFeatureRow | null {
  const bars = [...rawBars]
    .filter((bar) => typeof bar.date === "string" && Number.isFinite(bar.h) && Number.isFinite(bar.l) && Number.isFinite(bar.c))
    .sort((left, right) => left.date.localeCompare(right.date));
  if (bars.length === 0) return null;

  const config = normalizeVcpConfig(rawConfig);
  const index = bars.length - 1;
  const closes = bars.map((bar) => bar.c);
  const highs = bars.map((bar) => bar.h);
  const lows = bars.map((bar) => bar.l);
  const volumes = bars.map((bar) => Number(bar.volume ?? 0));
  const latest = bars[index];
  const previous = bars[index - 1] ?? null;
  const close = latest.c;

  const sma50 = sma(closes, 50, index);
  const sma150 = sma(closes, 150, index);
  const sma200 = sma(closes, 200, index);
  const sma150Prev20 = sma(closes, 150, index - 20);
  const sma200Prev20 = sma(closes, 200, index - 20);
  const high252 = highest(highs, 252, index);
  const low252 = lowest(lows, 252, index);
  const dailyPivot = priorPivotAt(highs, config.dailyPivotLookback, index);
  const agedPivot = priorPivotAt(highs, config.dailyPivotLookback, index - config.pivotAgeBars);
  const tickTolerance = (options?.mintick ?? DEFAULT_MINTICK) * 2;

  const tt1 = sma50 != null && close > sma50;
  const tt2 = sma150 != null && close > sma150;
  const tt3 = sma200 != null && close > sma200;
  const tt4 = sma50 != null && sma150 != null && sma50 > sma150;
  const tt5 = sma50 != null && sma200 != null && sma50 > sma200;
  const tt6 = sma150 != null && sma200 != null && sma150 > sma200;
  const tt7 = sma150 != null && sma150Prev20 != null && sma150 > sma150Prev20;
  const tt8 = sma200 != null && sma200Prev20 != null && sma200 > sma200Prev20;
  const tt9 = low252 != null && close >= low252 * 1.3;
  const tt10 = high252 != null && close >= high252 * 0.75;
  const trendScore = [tt1, tt2, tt3, tt4, tt5, tt6, tt7, tt8, tt9, tt10].filter(Boolean).length;
  const trendTemplate = trendScore === 10;

  const pivotStable = dailyPivot != null && agedPivot != null && Math.abs(dailyPivot - agedPivot) <= tickTolerance;
  const dailyNear = dailyPivot != null && close >= dailyPivot * (1 - config.dailyNearPct / 100) && close <= dailyPivot;

  const low10 = lowest(lows, 10, index);
  const low10Prev = lowest(lows, 10, index - 10);
  const low20 = lowest(lows, 20, index);
  const low20Prev = lowest(lows, 20, index - 20);
  const low30 = lowest(lows, 30, index);
  const low30Prev = lowest(lows, 30, index - 30);
  const higherLows = low10 != null && low10Prev != null && low20 != null && low20Prev != null && low30 != null && low30Prev != null
    ? low10 > low10Prev && low20 > low20Prev && low30 > low30Prev
    : false;

  const volSma20 = sma(volumes, 20, index);
  const volSma20Previous = sma(volumes, 20, index - 1);
  const volumeContracting = [30, 25, 20, 15, 10, 5].some((offset) => {
    const comparison = sma(volumes, 20, index - offset);
    return volSma20Previous != null && comparison != null && volSma20Previous < comparison;
  });

  const weekly = weeklyHighAndClose(bars, config.weeklyHighLookback);
  const weeklyNear = weekly.high != null && weekly.close != null
    ? weekly.close >= weekly.high * (1 - config.weeklyNearPct / 100) && weekly.close <= weekly.high
    : false;

  const vcpSignal = trendTemplate && pivotStable && dailyNear && weeklyNear && higherLows && volumeContracting;

  return {
    ticker: latest.ticker.toUpperCase(),
    tradingDate: latest.date,
    priceClose: close,
    change1d: pctChange(close, previous?.c),
    sma50: finiteOrNull(sma50),
    sma150: finiteOrNull(sma150),
    sma200: finiteOrNull(sma200),
    dailyPivot: finiteOrNull(dailyPivot),
    dailyPivotGapPct: pctGapToLevel(dailyPivot, close),
    weeklyHigh: finiteOrNull(weekly.high),
    weeklyHighGapPct: pctGapToLevel(weekly.high, close),
    volSma20: finiteOrNull(volSma20),
    trendScore,
    trendTemplate,
    pivotStable,
    dailyNear,
    weeklyNear,
    higherLows,
    volumeContracting,
    vcpSignal,
  };
}
