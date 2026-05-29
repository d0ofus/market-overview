import { refreshDailyBarsIncremental } from "./daily-bars";
import { latestUsSessionAsOfDate } from "./refresh-timing";
import type { Env } from "./types";

export type WatchlistFactorStatus = "pass" | "fail" | "unknown";

export type WatchlistFactorKey =
  | "priceAboveSma200"
  | "priceAbove"
  | "marketCapAbove"
  | "within52WeekHigh"
  | "priorStrongMove"
  | "strongSector"
  | "avg10dDollarVolume"
  | "increasingVolumeProfile"
  | "positiveRevenueGrowth"
  | "positiveEpsGrowth"
  | "acceleratingRevenueGrowth"
  | "acceleratingEpsGrowth"
  | "averageTradingRangePct";

export type WatchlistFactorConfig = {
  enabled: Partial<Record<WatchlistFactorKey, boolean>>;
  thresholds: {
    priceAbove: { minPrice: number };
    marketCapAbove: { minMarketCapMillions: number };
    within52WeekHigh: { maxDistancePct: number };
    priorStrongMove: { movePct: number; lookbackMonths: number };
    strongSector: { lookbackMonths: number };
    avg10dDollarVolume: { minDollarVolumeMillions: number };
    increasingVolumeProfile: { lookbackMonths: number; minTrendPct: number };
    acceleratingRevenueGrowth: { minAccelerationPct: number };
    acceleratingEpsGrowth: { minAccelerationPct: number };
    averageTradingRangePct: { minAtrPct: number };
  };
};

export type WatchlistFactorResult = {
  key: WatchlistFactorKey;
  label: string;
  status: WatchlistFactorStatus;
  value: number | string | boolean | null;
  threshold: number | string | null;
  source: string | null;
  details?: Record<string, unknown>;
};

export type WatchlistFactorMetrics = {
  sma200: number | null;
  price52WeekHigh: number | null;
  averageVolume10d: number | null;
  atrp: number | null;
  totalRevenueFq: number | null;
  totalRevenueFqHistory: number[];
  totalRevenueYoyGrowthFq: number | null;
  totalRevenueQoqGrowthFq: number | null;
  netIncomeFq: number | null;
  netIncomeFqHistory: number[];
  netIncomeYoyGrowthFq: number | null;
  earningsPerShareDilutedFq: number | null;
  earningsPerShareDilutedFqHistory: number[];
  earningsPerShareDilutedYoyGrowthFq: number | null;
  earningsPerShareDilutedQoqGrowthFq: number | null;
};

export type WatchlistFactorAssessmentInputRow = {
  ticker: string;
  price: number | null;
  marketCap: number | null;
  volume: number | null;
  metrics?: WatchlistFactorMetrics | null;
};

export type WatchlistFactorAssessmentOutputRow<T extends WatchlistFactorAssessmentInputRow> = T & {
  factorScore: number | null;
  factorPassCount: number | null;
  factorUnknownCount: number | null;
  factorResults: WatchlistFactorResult[] | null;
};

export type WatchlistFactorAssessmentTrace = {
  sourceId: "__factors__";
  sourceUrl: string;
  sourceSections: string[];
  status: "ok" | "empty" | "error";
  rawCount: number;
  acceptedCount: number;
  durationMs: number;
  provider: string;
  enabledCount: number;
  evaluatedRows: number;
  missingDataCounts: Partial<Record<WatchlistFactorKey, number>>;
  sourceErrors: string[];
  factorConfig: WatchlistFactorConfig;
};

type DailyBar = {
  ticker: string;
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
};

type FundamentalGrowthPoint = {
  revenueYoY: number | null;
  dilutedEpsYoY: number | null;
};

type FundamentalGrowth = {
  latest: FundamentalGrowthPoint | null;
  previous: FundamentalGrowthPoint | null;
};

type SectorMatch = {
  entryId: string;
  sectorName: string | null;
  eventDate: string | null;
};

const FACTOR_LABELS: Record<WatchlistFactorKey, string> = {
  priceAboveSma200: "Price > 200 SMA",
  priceAbove: "Price > threshold",
  marketCapAbove: "Market cap > threshold",
  within52WeekHigh: "Within 52-week high distance",
  priorStrongMove: "Prior strong move",
  strongSector: "In a strong sector",
  avg10dDollarVolume: "Average 10D dollar volume",
  increasingVolumeProfile: "Increasing volume profile",
  positiveRevenueGrowth: "Positive latest revenue growth",
  positiveEpsGrowth: "Positive latest EPS growth",
  acceleratingRevenueGrowth: "Accelerating revenue growth",
  acceleratingEpsGrowth: "Accelerating EPS growth",
  averageTradingRangePct: "Average trading range %",
};

export const WATCHLIST_FACTOR_KEYS: WatchlistFactorKey[] = [
  "priceAboveSma200",
  "priceAbove",
  "marketCapAbove",
  "within52WeekHigh",
  "priorStrongMove",
  "strongSector",
  "avg10dDollarVolume",
  "increasingVolumeProfile",
  "positiveRevenueGrowth",
  "positiveEpsGrowth",
  "acceleratingRevenueGrowth",
  "acceleratingEpsGrowth",
  "averageTradingRangePct",
];

export const CORE_WATCHLIST_FACTOR_KEYS: WatchlistFactorKey[] = [
  "priceAboveSma200",
  "priceAbove",
  "marketCapAbove",
  "within52WeekHigh",
  "priorStrongMove",
  "avg10dDollarVolume",
  "increasingVolumeProfile",
  "averageTradingRangePct",
];

export const DEFAULT_WATCHLIST_FACTOR_CONFIG: WatchlistFactorConfig = {
  enabled: {
    priceAboveSma200: true,
    priceAbove: true,
    marketCapAbove: true,
    within52WeekHigh: true,
    priorStrongMove: true,
    avg10dDollarVolume: true,
    increasingVolumeProfile: true,
    averageTradingRangePct: true,
  },
  thresholds: {
    priceAbove: { minPrice: 10 },
    marketCapAbove: { minMarketCapMillions: 500 },
    within52WeekHigh: { maxDistancePct: 15 },
    priorStrongMove: { movePct: 50, lookbackMonths: 3 },
    strongSector: { lookbackMonths: 3 },
    avg10dDollarVolume: { minDollarVolumeMillions: 20 },
    increasingVolumeProfile: { lookbackMonths: 3, minTrendPct: 0 },
    acceleratingRevenueGrowth: { minAccelerationPct: 0 },
    acceleratingEpsGrowth: { minAccelerationPct: 0 },
    averageTradingRangePct: { minAtrPct: 3 },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function numberFromConfig(value: unknown, fallback: number, min?: number, max?: number): number {
  const parsed = asFiniteNumber(value) ?? fallback;
  const lowerBounded = min == null ? parsed : Math.max(min, parsed);
  return max == null ? lowerBounded : Math.min(max, lowerBounded);
}

function cloneDefaultConfig(): WatchlistFactorConfig {
  return {
    enabled: { ...DEFAULT_WATCHLIST_FACTOR_CONFIG.enabled },
    thresholds: {
      priceAbove: { ...DEFAULT_WATCHLIST_FACTOR_CONFIG.thresholds.priceAbove },
      marketCapAbove: { ...DEFAULT_WATCHLIST_FACTOR_CONFIG.thresholds.marketCapAbove },
      within52WeekHigh: { ...DEFAULT_WATCHLIST_FACTOR_CONFIG.thresholds.within52WeekHigh },
      priorStrongMove: { ...DEFAULT_WATCHLIST_FACTOR_CONFIG.thresholds.priorStrongMove },
      strongSector: { ...DEFAULT_WATCHLIST_FACTOR_CONFIG.thresholds.strongSector },
      avg10dDollarVolume: { ...DEFAULT_WATCHLIST_FACTOR_CONFIG.thresholds.avg10dDollarVolume },
      increasingVolumeProfile: { ...DEFAULT_WATCHLIST_FACTOR_CONFIG.thresholds.increasingVolumeProfile },
      acceleratingRevenueGrowth: { ...DEFAULT_WATCHLIST_FACTOR_CONFIG.thresholds.acceleratingRevenueGrowth },
      acceleratingEpsGrowth: { ...DEFAULT_WATCHLIST_FACTOR_CONFIG.thresholds.acceleratingEpsGrowth },
      averageTradingRangePct: { ...DEFAULT_WATCHLIST_FACTOR_CONFIG.thresholds.averageTradingRangePct },
    },
  };
}

export function normalizeWatchlistFactorConfig(raw: unknown): WatchlistFactorConfig {
  const config = cloneDefaultConfig();
  if (!isRecord(raw)) return config;
  const rawEnabled = isRecord(raw.enabled) ? raw.enabled : {};
  for (const key of WATCHLIST_FACTOR_KEYS) {
    config.enabled[key] = rawEnabled[key] === true;
  }
  const rawThresholds = isRecord(raw.thresholds) ? raw.thresholds : {};
  const priceAbove = isRecord(rawThresholds.priceAbove) ? rawThresholds.priceAbove : {};
  config.thresholds.priceAbove.minPrice = numberFromConfig(priceAbove.minPrice, config.thresholds.priceAbove.minPrice, 0);

  const marketCapAbove = isRecord(rawThresholds.marketCapAbove) ? rawThresholds.marketCapAbove : {};
  config.thresholds.marketCapAbove.minMarketCapMillions = numberFromConfig(
    marketCapAbove.minMarketCapMillions,
    config.thresholds.marketCapAbove.minMarketCapMillions,
    0,
  );

  const within52WeekHigh = isRecord(rawThresholds.within52WeekHigh) ? rawThresholds.within52WeekHigh : {};
  config.thresholds.within52WeekHigh.maxDistancePct = numberFromConfig(
    within52WeekHigh.maxDistancePct,
    config.thresholds.within52WeekHigh.maxDistancePct,
    0,
    100,
  );

  const priorStrongMove = isRecord(rawThresholds.priorStrongMove) ? rawThresholds.priorStrongMove : {};
  config.thresholds.priorStrongMove.movePct = numberFromConfig(priorStrongMove.movePct, config.thresholds.priorStrongMove.movePct, 0);
  config.thresholds.priorStrongMove.lookbackMonths = numberFromConfig(
    priorStrongMove.lookbackMonths,
    config.thresholds.priorStrongMove.lookbackMonths,
    1,
    60,
  );

  const strongSector = isRecord(rawThresholds.strongSector) ? rawThresholds.strongSector : {};
  config.thresholds.strongSector.lookbackMonths = numberFromConfig(
    strongSector.lookbackMonths,
    config.thresholds.strongSector.lookbackMonths,
    1,
    60,
  );

  const avg10dDollarVolume = isRecord(rawThresholds.avg10dDollarVolume) ? rawThresholds.avg10dDollarVolume : {};
  config.thresholds.avg10dDollarVolume.minDollarVolumeMillions = numberFromConfig(
    avg10dDollarVolume.minDollarVolumeMillions,
    config.thresholds.avg10dDollarVolume.minDollarVolumeMillions,
    0,
  );

  const increasingVolumeProfile = isRecord(rawThresholds.increasingVolumeProfile) ? rawThresholds.increasingVolumeProfile : {};
  config.thresholds.increasingVolumeProfile.lookbackMonths = numberFromConfig(
    increasingVolumeProfile.lookbackMonths,
    config.thresholds.increasingVolumeProfile.lookbackMonths,
    1,
    60,
  );
  config.thresholds.increasingVolumeProfile.minTrendPct = numberFromConfig(
    increasingVolumeProfile.minTrendPct,
    config.thresholds.increasingVolumeProfile.minTrendPct,
  );

  const acceleratingRevenueGrowth = isRecord(rawThresholds.acceleratingRevenueGrowth) ? rawThresholds.acceleratingRevenueGrowth : {};
  config.thresholds.acceleratingRevenueGrowth.minAccelerationPct = numberFromConfig(
    acceleratingRevenueGrowth.minAccelerationPct,
    config.thresholds.acceleratingRevenueGrowth.minAccelerationPct,
  );

  const acceleratingEpsGrowth = isRecord(rawThresholds.acceleratingEpsGrowth) ? rawThresholds.acceleratingEpsGrowth : {};
  config.thresholds.acceleratingEpsGrowth.minAccelerationPct = numberFromConfig(
    acceleratingEpsGrowth.minAccelerationPct,
    config.thresholds.acceleratingEpsGrowth.minAccelerationPct,
  );

  const averageTradingRangePct = isRecord(rawThresholds.averageTradingRangePct) ? rawThresholds.averageTradingRangePct : {};
  config.thresholds.averageTradingRangePct.minAtrPct = numberFromConfig(
    averageTradingRangePct.minAtrPct,
    config.thresholds.averageTradingRangePct.minAtrPct,
    0,
  );

  return config;
}

export function enabledWatchlistFactorKeys(config: WatchlistFactorConfig): WatchlistFactorKey[] {
  return WATCHLIST_FACTOR_KEYS.filter((key) => config.enabled[key] === true);
}

function addUtcDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monthsToCalendarDays(months: number): number {
  return Math.ceil(Math.max(1, months) * 31);
}

function needsDailyBars(keys: WatchlistFactorKey[]): boolean {
  return keys.some((key) => [
    "priceAboveSma200",
    "within52WeekHigh",
    "priorStrongMove",
    "avg10dDollarVolume",
    "increasingVolumeProfile",
    "averageTradingRangePct",
  ].includes(key));
}

function requiredCalendarDays(config: WatchlistFactorConfig, keys: WatchlistFactorKey[]): number {
  let days = 0;
  if (keys.includes("priceAboveSma200")) days = Math.max(days, 320);
  if (keys.includes("within52WeekHigh")) days = Math.max(days, 400);
  if (keys.includes("priorStrongMove")) days = Math.max(days, monthsToCalendarDays(config.thresholds.priorStrongMove.lookbackMonths) + 10);
  if (keys.includes("increasingVolumeProfile")) days = Math.max(days, monthsToCalendarDays(config.thresholds.increasingVolumeProfile.lookbackMonths) + 25);
  if (keys.includes("avg10dDollarVolume")) days = Math.max(days, 25);
  if (keys.includes("averageTradingRangePct")) days = Math.max(days, 35);
  return Math.max(days, 0);
}

async function loadDailyBars(env: Env, tickers: string[], startDate: string): Promise<Map<string, DailyBar[]>> {
  const barsByTicker = new Map<string, DailyBar[]>();
  const uniqueTickers = Array.from(new Set(tickers.map((ticker) => ticker.toUpperCase()).filter(Boolean)));
  for (let index = 0; index < uniqueTickers.length; index += 80) {
    const chunk = uniqueTickers.slice(index, index + 80);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT ticker, date, o, h, l, c, volume
       FROM daily_bars
       WHERE ticker IN (${placeholders}) AND date >= ?
       ORDER BY ticker ASC, date ASC`,
    ).bind(...chunk, startDate).all<DailyBar>();
    for (const row of rows.results ?? []) {
      const ticker = row.ticker.toUpperCase();
      const current = barsByTicker.get(ticker) ?? [];
      current.push({
        ticker,
        date: row.date,
        o: Number(row.o),
        h: Number(row.h),
        l: Number(row.l),
        c: Number(row.c),
        volume: Number(row.volume ?? 0),
      });
      barsByTicker.set(ticker, current);
    }
  }
  return barsByTicker;
}

async function refreshAndLoadBars(
  env: Env,
  tickers: string[],
  config: WatchlistFactorConfig,
  keys: WatchlistFactorKey[],
  sourceErrors: string[],
): Promise<Map<string, DailyBar[]>> {
  if (!needsDailyBars(keys)) return new Map();
  const endDate = latestUsSessionAsOfDate(new Date());
  const startDate = addUtcDays(endDate, -requiredCalendarDays(config, keys));
  try {
    await refreshDailyBarsIncremental(env, {
      tickers,
      startDate,
      endDate,
      continueOnError: true,
    });
  } catch (error) {
    sourceErrors.push(error instanceof Error ? error.message.slice(0, 240) : "Daily bars refresh failed.");
  }
  try {
    return await loadDailyBars(env, tickers, startDate);
  } catch (error) {
    sourceErrors.push(error instanceof Error ? error.message.slice(0, 240) : "Daily bars load failed.");
    return new Map();
  }
}

async function loadSectorMatches(
  env: Env,
  tickers: string[],
  lookbackMonths: number,
  sourceErrors: string[],
): Promise<Map<string, SectorMatch[]>> {
  const matches = new Map<string, SectorMatch[]>();
  const uniqueTickers = Array.from(new Set(tickers.map((ticker) => ticker.toUpperCase()).filter(Boolean)));
  if (uniqueTickers.length === 0) return matches;
  const cutoff = addUtcDays(new Date().toISOString().slice(0, 10), -monthsToCalendarDays(lookbackMonths));
  try {
    for (let index = 0; index < uniqueTickers.length; index += 80) {
      const chunk = uniqueTickers.slice(index, index + 80);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = await env.DB.prepare(
        `SELECT UPPER(s.ticker) as ticker, e.id as entryId, e.sector_name as sectorName, e.event_date as eventDate
         FROM sector_tracker_entry_symbols s
         JOIN sector_tracker_entries e ON e.id = s.entry_id
         WHERE UPPER(s.ticker) IN (${placeholders})
           AND e.event_date >= ?
         ORDER BY e.event_date DESC`,
      ).bind(...chunk, cutoff).all<{ ticker: string; entryId: string; sectorName: string | null; eventDate: string | null }>();
      for (const row of rows.results ?? []) {
        const ticker = row.ticker.toUpperCase();
        const current = matches.get(ticker) ?? [];
        current.push({ entryId: row.entryId, sectorName: row.sectorName, eventDate: row.eventDate });
        matches.set(ticker, current);
      }
    }
  } catch (error) {
    sourceErrors.push(error instanceof Error ? error.message.slice(0, 240) : "Sector/narrative lookup failed.");
  }
  return matches;
}

async function loadFundamentalGrowth(
  env: Env,
  tickers: string[],
  sourceErrors: string[],
): Promise<Map<string, FundamentalGrowth>> {
  const growth = new Map<string, FundamentalGrowth>();
  const db = env.FUNDAMENTALS_DB ?? null;
  if (!db) {
    sourceErrors.push("FUNDAMENTALS_DB binding is not configured.");
    return growth;
  }
  const uniqueTickers = Array.from(new Set(tickers.map((ticker) => ticker.toUpperCase()).filter(Boolean)));
  try {
    for (let index = 0; index < uniqueTickers.length; index += 80) {
      const chunk = uniqueTickers.slice(index, index + 80);
      const placeholders = chunk.map(() => "?").join(",");
      let rows: Array<{ ticker: string; revenueYoY: number | null; dilutedEpsYoY?: number | null; periodEnd: string }> = [];
      try {
        const result = await db.prepare(
          `SELECT ticker, period_end as periodEnd, revenue_yoy as revenueYoY, diluted_eps_yoy as dilutedEpsYoY
           FROM fundamental_quarters
           WHERE ticker IN (${placeholders})
           ORDER BY ticker ASC, period_end DESC`,
        ).bind(...chunk).all<{ ticker: string; revenueYoY: number | null; dilutedEpsYoY: number | null; periodEnd: string }>();
        rows = result.results ?? [];
      } catch (error) {
        sourceErrors.push(error instanceof Error ? `SEC EPS columns unavailable: ${error.message.slice(0, 180)}` : "SEC EPS columns unavailable.");
        const fallback = await db.prepare(
          `SELECT ticker, period_end as periodEnd, revenue_yoy as revenueYoY
           FROM fundamental_quarters
           WHERE ticker IN (${placeholders})
           ORDER BY ticker ASC, period_end DESC`,
        ).bind(...chunk).all<{ ticker: string; revenueYoY: number | null; periodEnd: string }>();
        rows = fallback.results ?? [];
      }
      const byTicker = new Map<string, typeof rows>();
      for (const row of rows) {
        const ticker = row.ticker.toUpperCase();
        const current = byTicker.get(ticker) ?? [];
        if (current.length < 6) current.push(row);
        byTicker.set(ticker, current);
      }
      for (const [ticker, tickerRows] of byTicker.entries()) {
        growth.set(ticker, {
          latest: tickerRows[0]
            ? { revenueYoY: asFiniteNumber(tickerRows[0].revenueYoY), dilutedEpsYoY: asFiniteNumber(tickerRows[0].dilutedEpsYoY) }
            : null,
          previous: tickerRows[1]
            ? { revenueYoY: asFiniteNumber(tickerRows[1].revenueYoY), dilutedEpsYoY: asFiniteNumber(tickerRows[1].dilutedEpsYoY) }
            : null,
        });
      }
    }
  } catch (error) {
    sourceErrors.push(error instanceof Error ? error.message.slice(0, 240) : "SEC fundamentals lookup failed.");
  }
  return growth;
}

function recentBars(bars: DailyBar[] | undefined, count: number): DailyBar[] {
  return (bars ?? []).filter((bar) => Number.isFinite(bar.c)).slice(-count);
}

function closeSma(bars: DailyBar[] | undefined, length: number): number | null {
  const recent = recentBars(bars, length);
  if (recent.length < length) return null;
  return recent.reduce((sum, bar) => sum + bar.c, 0) / length;
}

function high52Week(bars: DailyBar[] | undefined): number | null {
  const recent = recentBars(bars, 252);
  if (recent.length < 120) return null;
  const high = Math.max(...recent.map((bar) => bar.h));
  return Number.isFinite(high) ? high : null;
}

export function calculatePriorStrongMovePct(
  bars: Array<{ date: string; l: number; h: number }> | undefined,
  lookbackMonths: number,
): number | null {
  const cutoff = addUtcDays(new Date().toISOString().slice(0, 10), -monthsToCalendarDays(lookbackMonths));
  const recent = (bars ?? []).filter((bar) => bar.date >= cutoff && Number.isFinite(bar.l) && Number.isFinite(bar.h));
  if (recent.length < 2) return null;
  let minLow = Number.POSITIVE_INFINITY;
  let maxMove = Number.NEGATIVE_INFINITY;
  for (const bar of recent) {
    minLow = Math.min(minLow, bar.l);
    if (minLow > 0) {
      maxMove = Math.max(maxMove, ((bar.h - minLow) / minLow) * 100);
    }
  }
  return Number.isFinite(maxMove) ? Number(maxMove.toFixed(4)) : null;
}

function avg10dDollarVolume(bars: DailyBar[] | undefined): number | null {
  const recent = recentBars(bars, 10);
  if (recent.length < 10) return null;
  const total = recent.reduce((sum, bar) => sum + (bar.c * (Number.isFinite(bar.volume) ? bar.volume : 0)), 0);
  return total / recent.length;
}

export function rolling10dVolumeTrendPct(bars: Array<{ date: string; volume: number }>, lookbackMonths: number): number | null {
  const cutoff = addUtcDays(new Date().toISOString().slice(0, 10), -monthsToCalendarDays(lookbackMonths));
  const recent = bars.filter((bar) => bar.date >= cutoff && Number.isFinite(bar.volume));
  if (recent.length < 20) return null;
  const rolling: number[] = [];
  for (let index = 9; index < recent.length; index += 1) {
    const window = recent.slice(index - 9, index + 1);
    rolling.push(window.reduce((sum, bar) => sum + bar.volume, 0) / 10);
  }
  if (rolling.length < 2) return null;
  const n = rolling.length;
  const xMean = (n - 1) / 2;
  const yMean = rolling.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += (index - xMean) * (rolling[index] - yMean);
    denominator += (index - xMean) ** 2;
  }
  if (denominator === 0) return null;
  const slope = numerator / denominator;
  const intercept = yMean - (slope * xMean);
  const start = intercept;
  const end = intercept + (slope * (n - 1));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) return null;
  return Number((((end - start) / Math.abs(start)) * 100).toFixed(4));
}

function averageTrueRangePct(bars: DailyBar[] | undefined): number | null {
  const recent = recentBars(bars, 15);
  if (recent.length < 15) return null;
  const trueRanges: number[] = [];
  for (let index = 1; index < recent.length; index += 1) {
    const current = recent[index];
    const previous = recent[index - 1];
    trueRanges.push(Math.max(
      current.h - current.l,
      Math.abs(current.h - previous.c),
      Math.abs(current.l - previous.c),
    ));
  }
  const atr = trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length;
  const latestClose = recent.at(-1)?.c ?? null;
  if (!latestClose || latestClose <= 0) return null;
  return Number(((atr / latestClose) * 100).toFixed(4));
}

function pctChange(current: number | null, previous: number | null): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return Number(((((current as number) - (previous as number)) / Math.abs(previous as number)) * 100).toFixed(4));
}

function growthFromHistory(history: number[], latestYoyHint: number | null): { latestYoY: number | null; previousYoY: number | null } {
  const clean = history.map(asFiniteNumber).filter((value): value is number => value != null);
  if (clean.length < 6) return { latestYoY: null, previousYoY: null };
  const candidates = [clean, [...clean].reverse()].map((values) => ({
    latestYoY: pctChange(values[0], values[4]),
    previousYoY: pctChange(values[1], values[5]),
  }));
  if (latestYoyHint != null) {
    const ranked = candidates
      .filter((candidate) => candidate.latestYoY != null)
      .sort((left, right) => Math.abs((left.latestYoY ?? 0) - latestYoyHint) - Math.abs((right.latestYoY ?? 0) - latestYoyHint));
    if (ranked[0]) return ranked[0];
  }
  return candidates[0];
}

function makeResult(
  key: WatchlistFactorKey,
  status: WatchlistFactorStatus,
  value: number | string | boolean | null,
  threshold: number | string | null,
  source: string | null,
  details?: Record<string, unknown>,
): WatchlistFactorResult {
  return {
    key,
    label: FACTOR_LABELS[key],
    status,
    value,
    threshold,
    source,
    ...(details ? { details } : {}),
  };
}

function numericPass(
  key: WatchlistFactorKey,
  value: number | null,
  threshold: number | null,
  source: string | null,
  comparator: (value: number, threshold: number) => boolean,
  details?: Record<string, unknown>,
): WatchlistFactorResult {
  if (value == null || threshold == null) return makeResult(key, "unknown", value, threshold, source, details);
  return makeResult(key, comparator(value, threshold) ? "pass" : "fail", Number(value.toFixed(4)), Number(threshold.toFixed(4)), source, details);
}

function latestRevenueGrowth(row: WatchlistFactorAssessmentInputRow, fundamentals: FundamentalGrowth | undefined): { value: number | null; source: string | null } {
  const secValue = fundamentals?.latest?.revenueYoY ?? null;
  if (secValue != null) return { value: secValue, source: "SEC fundamentals" };
  const tvValue = row.metrics?.totalRevenueYoyGrowthFq ?? null;
  if (tvValue != null) return { value: tvValue, source: "TradingView Screener" };
  const history = growthFromHistory(row.metrics?.totalRevenueFqHistory ?? [], tvValue);
  return history.latestYoY != null ? { value: history.latestYoY, source: "TradingView Screener history" } : { value: null, source: null };
}

function previousRevenueGrowth(row: WatchlistFactorAssessmentInputRow, fundamentals: FundamentalGrowth | undefined): { value: number | null; source: string | null } {
  const secValue = fundamentals?.previous?.revenueYoY ?? null;
  if (secValue != null) return { value: secValue, source: "SEC fundamentals" };
  const history = growthFromHistory(row.metrics?.totalRevenueFqHistory ?? [], row.metrics?.totalRevenueYoyGrowthFq ?? null);
  return history.previousYoY != null ? { value: history.previousYoY, source: "TradingView Screener history" } : { value: null, source: null };
}

function latestEpsGrowth(row: WatchlistFactorAssessmentInputRow, fundamentals: FundamentalGrowth | undefined): { value: number | null; source: string | null } {
  const secValue = fundamentals?.latest?.dilutedEpsYoY ?? null;
  if (secValue != null) return { value: secValue, source: "SEC fundamentals" };
  const tvValue = row.metrics?.earningsPerShareDilutedYoyGrowthFq ?? null;
  if (tvValue != null) return { value: tvValue, source: "TradingView Screener" };
  const history = growthFromHistory(row.metrics?.earningsPerShareDilutedFqHistory ?? [], tvValue);
  return history.latestYoY != null ? { value: history.latestYoY, source: "TradingView Screener history" } : { value: null, source: null };
}

function previousEpsGrowth(row: WatchlistFactorAssessmentInputRow, fundamentals: FundamentalGrowth | undefined): { value: number | null; source: string | null } {
  const secValue = fundamentals?.previous?.dilutedEpsYoY ?? null;
  if (secValue != null) return { value: secValue, source: "SEC fundamentals" };
  const history = growthFromHistory(row.metrics?.earningsPerShareDilutedFqHistory ?? [], row.metrics?.earningsPerShareDilutedYoyGrowthFq ?? null);
  return history.previousYoY != null ? { value: history.previousYoY, source: "TradingView Screener history" } : { value: null, source: null };
}

function evaluateFactor(input: {
  key: WatchlistFactorKey;
  row: WatchlistFactorAssessmentInputRow;
  config: WatchlistFactorConfig;
  bars: DailyBar[] | undefined;
  fundamentals: FundamentalGrowth | undefined;
  sectorMatches: SectorMatch[] | undefined;
  sectorLookupFailed: boolean;
}): WatchlistFactorResult {
  const { key, row, config, bars, fundamentals, sectorMatches, sectorLookupFailed } = input;

  switch (key) {
    case "priceAboveSma200": {
      const tvSma = row.metrics?.sma200 ?? null;
      const localSma = tvSma == null ? closeSma(bars, 200) : null;
      const sma = tvSma ?? localSma;
      const source = tvSma != null ? "TradingView Screener" : localSma != null ? "daily_bars" : null;
      return numericPass(key, row.price, sma, source, (value, threshold) => value > threshold, { price: row.price, sma200: sma });
    }
    case "priceAbove":
      return numericPass(key, row.price, config.thresholds.priceAbove.minPrice, row.price != null ? "TradingView Screener" : null, (value, threshold) => value > threshold);
    case "marketCapAbove":
      return numericPass(
        key,
        row.marketCap,
        config.thresholds.marketCapAbove.minMarketCapMillions * 1_000_000,
        row.marketCap != null ? "TradingView Screener" : null,
        (value, threshold) => value >= threshold,
      );
    case "within52WeekHigh": {
      const tvHigh = row.metrics?.price52WeekHigh ?? null;
      const localHigh = tvHigh == null ? high52Week(bars) : null;
      const high = tvHigh ?? localHigh;
      const distance = row.price != null && high != null && high > 0 ? ((high - row.price) / high) * 100 : null;
      const source = tvHigh != null ? "TradingView Screener" : localHigh != null ? "daily_bars" : null;
      return numericPass(key, distance, config.thresholds.within52WeekHigh.maxDistancePct, source, (value, threshold) => value <= threshold, { price: row.price, high52Week: high });
    }
    case "priorStrongMove": {
      const movePct = calculatePriorStrongMovePct(bars, config.thresholds.priorStrongMove.lookbackMonths);
      return numericPass(key, movePct, config.thresholds.priorStrongMove.movePct, movePct != null ? "daily_bars" : null, (value, threshold) => value >= threshold, {
        lookbackMonths: config.thresholds.priorStrongMove.lookbackMonths,
      });
    }
    case "strongSector": {
      if (sectorLookupFailed) return makeResult(key, "unknown", null, `>=1 entry in ${config.thresholds.strongSector.lookbackMonths}M`, "sector/narrative calendar");
      const matches = sectorMatches ?? [];
      if (matches.length === 0) return makeResult(key, "fail", false, `>=1 entry in ${config.thresholds.strongSector.lookbackMonths}M`, "sector/narrative calendar", { matches });
      return makeResult(key, "pass", true, `>=1 entry in ${config.thresholds.strongSector.lookbackMonths}M`, "sector/narrative calendar", { matches: matches.slice(0, 5) });
    }
    case "avg10dDollarVolume": {
      const tvAverageVolume = row.metrics?.averageVolume10d ?? null;
      const tvValue = tvAverageVolume != null && row.price != null ? tvAverageVolume * row.price : null;
      const localValue = tvValue == null ? avg10dDollarVolume(bars) : null;
      const value = tvValue ?? localValue;
      const source = tvValue != null ? "TradingView Screener" : localValue != null ? "daily_bars" : null;
      return numericPass(key, value, config.thresholds.avg10dDollarVolume.minDollarVolumeMillions * 1_000_000, source, (left, right) => left >= right);
    }
    case "increasingVolumeProfile": {
      const trendPct = rolling10dVolumeTrendPct(bars ?? [], config.thresholds.increasingVolumeProfile.lookbackMonths);
      return numericPass(key, trendPct, config.thresholds.increasingVolumeProfile.minTrendPct, trendPct != null ? "daily_bars" : null, (value, threshold) => value >= threshold, {
        lookbackMonths: config.thresholds.increasingVolumeProfile.lookbackMonths,
      });
    }
    case "positiveRevenueGrowth": {
      const latest = latestRevenueGrowth(row, fundamentals);
      return numericPass(key, latest.value, 0, latest.source, (value, threshold) => value > threshold);
    }
    case "positiveEpsGrowth": {
      const latest = latestEpsGrowth(row, fundamentals);
      return numericPass(key, latest.value, 0, latest.source, (value, threshold) => value > threshold);
    }
    case "acceleratingRevenueGrowth": {
      const latest = latestRevenueGrowth(row, fundamentals);
      const previous = previousRevenueGrowth(row, fundamentals);
      const acceleration = latest.value != null && previous.value != null ? latest.value - previous.value : null;
      return numericPass(key, acceleration, config.thresholds.acceleratingRevenueGrowth.minAccelerationPct, latest.source ?? previous.source, (value, threshold) => value > threshold, {
        latestYoY: latest.value,
        previousYoY: previous.value,
      });
    }
    case "acceleratingEpsGrowth": {
      const latest = latestEpsGrowth(row, fundamentals);
      const previous = previousEpsGrowth(row, fundamentals);
      const acceleration = latest.value != null && previous.value != null ? latest.value - previous.value : null;
      return numericPass(key, acceleration, config.thresholds.acceleratingEpsGrowth.minAccelerationPct, latest.source ?? previous.source, (value, threshold) => value > threshold, {
        latestYoY: latest.value,
        previousYoY: previous.value,
      });
    }
    case "averageTradingRangePct": {
      const tvAtrp = row.metrics?.atrp ?? null;
      const localAtrp = tvAtrp == null ? averageTrueRangePct(bars) : null;
      const value = tvAtrp ?? localAtrp;
      const source = tvAtrp != null ? "TradingView Screener" : localAtrp != null ? "daily_bars" : null;
      return numericPass(key, value, config.thresholds.averageTradingRangePct.minAtrPct, source, (left, right) => left > right);
    }
    default:
      return makeResult(key, "unknown", null, null, null);
  }
}

export async function assessWatchlistFactors<T extends WatchlistFactorAssessmentInputRow>(
  env: Env,
  rows: T[],
  rawConfig: unknown,
): Promise<{
  rows: Array<WatchlistFactorAssessmentOutputRow<T>>;
  trace: WatchlistFactorAssessmentTrace | null;
}> {
  const startedAt = Date.now();
  const config = normalizeWatchlistFactorConfig(rawConfig);
  const keys = enabledWatchlistFactorKeys(config);
  if (keys.length === 0) {
    return {
      rows: rows.map((row) => ({
        ...row,
        factorScore: null,
        factorPassCount: null,
        factorUnknownCount: null,
        factorResults: null,
      })),
      trace: null,
    };
  }

  const tickers = Array.from(new Set(rows.map((row) => row.ticker.toUpperCase()).filter(Boolean)));
  const sourceErrors: string[] = [];
  const barsByTicker = await refreshAndLoadBars(env, tickers, config, keys, sourceErrors);
  const sectorLookback = config.thresholds.strongSector.lookbackMonths;
  const sourceErrorCountBeforeSector = sourceErrors.length;
  const sectorMatches = keys.includes("strongSector")
    ? await loadSectorMatches(env, tickers, sectorLookback, sourceErrors)
    : new Map<string, SectorMatch[]>();
  const sectorLookupFailed = keys.includes("strongSector") && sourceErrors.length > sourceErrorCountBeforeSector;
  const fundamentals = keys.some((key) => ["positiveRevenueGrowth", "positiveEpsGrowth", "acceleratingRevenueGrowth", "acceleratingEpsGrowth"].includes(key))
    ? await loadFundamentalGrowth(env, tickers, sourceErrors)
    : new Map<string, FundamentalGrowth>();

  const missingDataCounts: Partial<Record<WatchlistFactorKey, number>> = {};
  const assessedRows = rows.map((row) => {
    const ticker = row.ticker.toUpperCase();
    const results = keys.map((key) => evaluateFactor({
      key,
      row,
      config,
      bars: barsByTicker.get(ticker),
      fundamentals: fundamentals.get(ticker),
      sectorMatches: sectorMatches.get(ticker),
      sectorLookupFailed,
    }));
    let passCount = 0;
    let unknownCount = 0;
    for (const result of results) {
      if (result.status === "pass") passCount += 1;
      if (result.status === "unknown") {
        unknownCount += 1;
        missingDataCounts[result.key] = (missingDataCounts[result.key] ?? 0) + 1;
      }
    }
    return {
      ...row,
      factorScore: Number(((passCount / keys.length) * 100).toFixed(2)),
      factorPassCount: passCount,
      factorUnknownCount: unknownCount,
      factorResults: results,
    };
  });

  return {
    rows: assessedRows,
    trace: {
      sourceId: "__factors__",
      sourceUrl: "watchlist-factor-assessment",
      sourceSections: [],
      status: assessedRows.length > 0 ? "ok" : "empty",
      rawCount: rows.length,
      acceptedCount: assessedRows.length,
      durationMs: Date.now() - startedAt,
      provider: "Watchlist factor assessment",
      enabledCount: keys.length,
      evaluatedRows: assessedRows.length,
      missingDataCounts,
      sourceErrors,
      factorConfig: config,
    },
  };
}
