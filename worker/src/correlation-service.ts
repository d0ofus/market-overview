import { sanitizeBarSeries } from "./metrics";
import { getProvider, type DailyBar } from "./provider";
import { latestUsSessionAsOfDate } from "./refresh-timing";
import type { Env } from "./types";

export const CORRELATION_LOOKBACKS = {
  "60D": { returnPeriods: 60, closePeriods: 61 },
  "120D": { returnPeriods: 120, closePeriods: 121 },
  "252D": { returnPeriods: 252, closePeriods: 253 },
  "2Y": { returnPeriods: 504, closePeriods: 505 },
  "5Y": { returnPeriods: 1260, closePeriods: 1261 },
} as const;

export const CORRELATION_ROLLING_WINDOWS = {
  "20D": 20,
  "60D": 60,
  "120D": 120,
} as const;

export type CorrelationLookback = keyof typeof CORRELATION_LOOKBACKS;
export type CorrelationRollingWindow = keyof typeof CORRELATION_ROLLING_WINDOWS;

export type CorrelationTickerStatus = "ok" | "stale";

export type CorrelationResolvedTicker = {
  ticker: string;
  displayName: string | null;
  lastBarDate: string | null;
  barCount: number;
  status: CorrelationTickerStatus;
};

export type CorrelationUnresolvedTicker = {
  ticker: string;
  reason: "unknown_ticker" | "missing_history";
};

export type CorrelationMatrixResponse = {
  requestedTickers: string[];
  lookback: CorrelationLookback;
  returnPeriods: number;
  generatedAt: string;
  expectedAsOfDate: string;
  latestAvailableDate: string | null;
  resolvedTickers: CorrelationResolvedTicker[];
  unresolvedTickers: CorrelationUnresolvedTicker[];
  matrix: Array<Array<number | null>>;
  overlapCounts: number[][];
  warnings: string[];
  defaultPair: { left: string; right: string } | null;
};

export type CorrelationPairResponse = {
  lookback: CorrelationLookback;
  rollingWindow: CorrelationRollingWindow;
  generatedAt: string;
  warnings: string[];
  pair: {
    left: CorrelationResolvedTicker;
    right: CorrelationResolvedTicker;
    overlapStartDate: string | null;
    overlapEndDate: string | null;
    priceObservationCount: number;
    returnObservationCount: number;
  };
  overview: {
    normalizedSeries: Array<{ date: string; left: number; right: number }>;
    regressionPoints: Array<{ date: string; x: number; y: number }>;
    regressionLine: Array<{ x: number; y: number }>;
    stats: {
      beta: number | null;
      intercept: number | null;
      correlation: number | null;
      rSquared: number | null;
      observationCount: number;
    };
  };
  spread: {
    series: Array<{
      date: string;
      spread: number;
      mean: number | null;
      upper2Sigma: number | null;
      lower2Sigma: number | null;
      zScore: number | null;
    }>;
    latest: {
      spread: number | null;
      zScore: number | null;
    };
  };
  dynamics: {
    rollingCorrelation: Array<{ date: string; value: number | null }>;
    leadLag: {
      confidenceBand: number | null;
      bestLag: { lag: number; correlation: number; observationCount: number } | null;
      rows: Array<{ lag: number; correlation: number | null; observationCount: number }>;
    };
    lagOverlay: Array<{ date: string; left: number | null; right: number | null }>;
  };
};

type RawBarRow = {
  ticker: string;
  date: string;
  c: number;
};

type TickerMetaRow = {
  ticker: string;
  displayName: string | null;
};

type PriceSeries = {
  dates: string[];
  closes: number[];
};

type ReturnSeries = {
  dates: string[];
  values: number[];
};

type AlignedSeries = {
  dates: string[];
  leftValues: number[];
  rightValues: number[];
};

type RegressionStats = {
  beta: number | null;
  intercept: number | null;
  correlation: number | null;
  rSquared: number | null;
  observationCount: number;
};

const MIN_CORRELATION_OBSERVATIONS = 20;
const MAX_LEAD_LAG_DAYS = 20;
const STABILITY_EPSILON = 1e-12;
const BAR_FETCH_BUFFER = 30;
const BAR_UPSERT_CHUNK_SIZE = 100;

function closePeriodsForLookback(lookback: CorrelationLookback): number {
  return CORRELATION_LOOKBACKS[lookback].closePeriods;
}

function returnPeriodsForLookback(lookback: CorrelationLookback): number {
  return CORRELATION_LOOKBACKS[lookback].returnPeriods;
}

function rollingPeriodsForWindow(window: CorrelationRollingWindow): number {
  return CORRELATION_ROLLING_WINDOWS[window];
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return sum(values) / values.length;
}

function sampleStdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = mean(values);
  const variance = values.reduce((total, value) => total + (value - avg) ** 2, 0) / (values.length - 1);
  return variance > STABILITY_EPSILON ? Math.sqrt(variance) : null;
}

export function pearsonCorrelation(leftValues: number[], rightValues: number[]): number | null {
  if (leftValues.length !== rightValues.length || leftValues.length < 2) return null;
  const leftMean = mean(leftValues);
  const rightMean = mean(rightValues);
  let numerator = 0;
  let leftDenominator = 0;
  let rightDenominator = 0;
  for (let index = 0; index < leftValues.length; index += 1) {
    const leftCentered = leftValues[index] - leftMean;
    const rightCentered = rightValues[index] - rightMean;
    numerator += leftCentered * rightCentered;
    leftDenominator += leftCentered * leftCentered;
    rightDenominator += rightCentered * rightCentered;
  }
  if (leftDenominator <= STABILITY_EPSILON || rightDenominator <= STABILITY_EPSILON) return null;
  return numerator / Math.sqrt(leftDenominator * rightDenominator);
}

export function ordinaryLeastSquares(xValues: number[], yValues: number[]): RegressionStats {
  if (xValues.length !== yValues.length || xValues.length < 2) {
    return {
      beta: null,
      intercept: null,
      correlation: null,
      rSquared: null,
      observationCount: xValues.length,
    };
  }
  const xMean = mean(xValues);
  const yMean = mean(yValues);
  let covariance = 0;
  let xVariance = 0;
  for (let index = 0; index < xValues.length; index += 1) {
    const xCentered = xValues[index] - xMean;
    const yCentered = yValues[index] - yMean;
    covariance += xCentered * yCentered;
    xVariance += xCentered * xCentered;
  }
  if (xVariance <= STABILITY_EPSILON) {
    return {
      beta: null,
      intercept: null,
      correlation: pearsonCorrelation(xValues, yValues),
      rSquared: null,
      observationCount: xValues.length,
    };
  }
  const beta = covariance / xVariance;
  const intercept = yMean - beta * xMean;
  const correlation = pearsonCorrelation(xValues, yValues);
  return {
    beta,
    intercept,
    correlation,
    rSquared: correlation == null ? null : correlation * correlation,
    observationCount: xValues.length,
  };
}

function buildNormalizedSeries(aligned: AlignedSeries): Array<{ date: string; left: number; right: number }> {
  if (aligned.dates.length === 0) return [];
  const leftBase = aligned.leftValues[0];
  const rightBase = aligned.rightValues[0];
  if (leftBase <= 0 || rightBase <= 0) return [];
  return aligned.dates.map((date, index) => ({
    date,
    left: (aligned.leftValues[index] / leftBase) * 100,
    right: (aligned.rightValues[index] / rightBase) * 100,
  }));
}

function clampNumber(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value;
}

function buildRegressionLine(points: Array<{ x: number; y: number }>, beta: number | null, intercept: number | null): Array<{ x: number; y: number }> {
  if (points.length === 0 || beta == null || intercept == null) return [];
  const sorted = [...points].sort((left, right) => left.x - right.x);
  const firstX = sorted[0].x;
  const lastX = sorted[sorted.length - 1].x;
  return [
    { x: firstX, y: intercept + beta * firstX },
    { x: lastX, y: intercept + beta * lastX },
  ];
}

function buildRollingMean(values: number[], window: number): Array<number | null> {
  const out = new Array<number | null>(values.length).fill(null);
  if (window <= 1 || values.length < window) return out;
  let runningSum = 0;
  for (let index = 0; index < values.length; index += 1) {
    runningSum += values[index];
    if (index >= window) runningSum -= values[index - window];
    if (index >= window - 1) out[index] = runningSum / window;
  }
  return out;
}

function buildRollingStdDev(values: number[], window: number): Array<number | null> {
  const out = new Array<number | null>(values.length).fill(null);
  if (window <= 1 || values.length < window) return out;
  for (let index = window - 1; index < values.length; index += 1) {
    out[index] = sampleStdDev(values.slice(index - window + 1, index + 1));
  }
  return out;
}

export function buildRollingCorrelationSeries(alignedReturns: AlignedSeries, window: number): Array<{ date: string; value: number | null }> {
  return alignedReturns.dates.map((date, index) => {
    if (index < window - 1) return { date, value: null };
    const leftSlice = alignedReturns.leftValues.slice(index - window + 1, index + 1);
    const rightSlice = alignedReturns.rightValues.slice(index - window + 1, index + 1);
    return {
      date,
      value: clampNumber(pearsonCorrelation(leftSlice, rightSlice)),
    };
  });
}

function alignPriceSeries(leftSeries: PriceSeries, rightSeries: PriceSeries): AlignedSeries {
  const rightByDate = new Map<string, number>();
  for (let index = 0; index < rightSeries.dates.length; index += 1) {
    rightByDate.set(rightSeries.dates[index], rightSeries.closes[index]);
  }
  const dates: string[] = [];
  const leftValues: number[] = [];
  const rightValues: number[] = [];
  for (let index = 0; index < leftSeries.dates.length; index += 1) {
    const date = leftSeries.dates[index];
    const rightClose = rightByDate.get(date);
    if (rightClose == null) continue;
    dates.push(date);
    leftValues.push(leftSeries.closes[index]);
    rightValues.push(rightClose);
  }
  return { dates, leftValues, rightValues };
}

function alignReturnSeries(leftSeries: ReturnSeries, rightSeries: ReturnSeries): AlignedSeries {
  const rightByDate = new Map<string, number>();
  for (let index = 0; index < rightSeries.dates.length; index += 1) {
    rightByDate.set(rightSeries.dates[index], rightSeries.values[index]);
  }
  const dates: string[] = [];
  const leftValues: number[] = [];
  const rightValues: number[] = [];
  for (let index = 0; index < leftSeries.dates.length; index += 1) {
    const date = leftSeries.dates[index];
    const rightValue = rightByDate.get(date);
    if (rightValue == null) continue;
    dates.push(date);
    leftValues.push(leftSeries.values[index]);
    rightValues.push(rightValue);
  }
  return { dates, leftValues, rightValues };
}

function buildReturnSeries(priceSeries: PriceSeries): ReturnSeries {
  const dates: string[] = [];
  const values: number[] = [];
  for (let index = 1; index < priceSeries.closes.length; index += 1) {
    const prevClose = priceSeries.closes[index - 1];
    const nextClose = priceSeries.closes[index];
    if (!Number.isFinite(prevClose) || prevClose <= 0 || !Number.isFinite(nextClose) || nextClose <= 0) continue;
    dates.push(priceSeries.dates[index]);
    values.push((nextClose - prevClose) / prevClose);
  }
  return { dates, values };
}

function selectTrailingPriceSeries(dates: string[], closes: number[], closePeriods: number): PriceSeries {
  const start = Math.max(0, closes.length - closePeriods);
  return {
    dates: dates.slice(start),
    closes: closes.slice(start),
  };
}

function determineTickerStatus(lastBarDate: string | null, freshestDate: string | null): CorrelationTickerStatus {
  return lastBarDate && freshestDate && lastBarDate === freshestDate ? "ok" : "stale";
}

function buildTickerWarning(ticker: string, lastBarDate: string | null, freshestDate: string | null): string | null {
  if (!lastBarDate || !freshestDate || lastBarDate === freshestDate) return null;
  return `${ticker} history is stale versus the freshest available date (${lastBarDate} vs ${freshestDate}).`;
}

function buildDatasetStaleWarning(latestAvailableDate: string | null, expectedAsOfDate: string): string | null {
  if (!latestAvailableDate) return "No historical bars were available for the requested tickers.";
  if (latestAvailableDate >= expectedAsOfDate) return null;
  return `Stored bar history is behind the expected latest session (${latestAvailableDate} vs ${expectedAsOfDate}).`;
}

function bestPairFromMatrix(resolvedTickers: CorrelationResolvedTicker[], matrix: Array<Array<number | null>>): { left: string; right: string } | null {
  let best: { left: string; right: string; score: number; lagDistance: number } | null = null;
  for (let row = 0; row < resolvedTickers.length; row += 1) {
    for (let column = row + 1; column < resolvedTickers.length; column += 1) {
      const value = matrix[row]?.[column] ?? null;
      if (value == null) continue;
      const score = Math.abs(value);
      const lagDistance = Math.abs(column - row);
      if (!best || score > best.score || (score === best.score && lagDistance < best.lagDistance)) {
        best = {
          left: resolvedTickers[row].ticker,
          right: resolvedTickers[column].ticker,
          score,
          lagDistance,
        };
      }
    }
  }
  return best ? { left: best.left, right: best.right } : null;
}

function laggedAlignment(leftSeries: ReturnSeries, rightSeries: ReturnSeries, lag: number): AlignedSeries {
  const leftDateIndex = new Map<string, number>();
  const rightDateIndex = new Map<string, number>();
  for (let index = 0; index < leftSeries.dates.length; index += 1) {
    leftDateIndex.set(leftSeries.dates[index], index);
  }
  for (let index = 0; index < rightSeries.dates.length; index += 1) {
    rightDateIndex.set(rightSeries.dates[index], index);
  }
  const dates: string[] = [];
  const leftValues: number[] = [];
  const rightValues: number[] = [];

  if (lag >= 0) {
    for (let index = 0; index < leftSeries.dates.length; index += 1) {
      const leftDate = leftSeries.dates[index];
      const rightIndex = rightDateIndex.get(leftDate);
      if (rightIndex == null) continue;
      const shiftedIndex = rightIndex + lag;
      if (shiftedIndex >= rightSeries.dates.length) continue;
      dates.push(rightSeries.dates[shiftedIndex]);
      leftValues.push(leftSeries.values[index]);
      rightValues.push(rightSeries.values[shiftedIndex]);
    }
    return { dates, leftValues, rightValues };
  }

  const rightLead = Math.abs(lag);
  for (let index = 0; index < rightSeries.dates.length; index += 1) {
    const rightDate = rightSeries.dates[index];
    const leftIndex = leftDateIndex.get(rightDate);
    if (leftIndex == null) continue;
    const shiftedLeftIndex = leftIndex + rightLead;
    if (shiftedLeftIndex >= leftSeries.dates.length) continue;
    dates.push(leftSeries.dates[shiftedLeftIndex]);
    leftValues.push(leftSeries.values[shiftedLeftIndex]);
    rightValues.push(rightSeries.values[index]);
  }
  return { dates, leftValues, rightValues };
}

export function buildLeadLagAnalysis(leftSeries: ReturnSeries, rightSeries: ReturnSeries) {
  const rows: Array<{ lag: number; correlation: number | null; observationCount: number }> = [];
  let best: { lag: number; correlation: number; observationCount: number } | null = null;

  for (let lag = -MAX_LEAD_LAG_DAYS; lag <= MAX_LEAD_LAG_DAYS; lag += 1) {
    const aligned = laggedAlignment(leftSeries, rightSeries, lag);
    const observationCount = aligned.leftValues.length;
    const correlation = observationCount >= MIN_CORRELATION_OBSERVATIONS
      ? clampNumber(pearsonCorrelation(aligned.leftValues, aligned.rightValues))
      : null;
    rows.push({ lag, correlation, observationCount });
    if (correlation == null) continue;
    if (
      !best
      || Math.abs(correlation) > Math.abs(best.correlation)
      || (Math.abs(correlation) === Math.abs(best.correlation) && Math.abs(lag) < Math.abs(best.lag))
    ) {
      best = { lag, correlation, observationCount };
    }
  }

  const confidenceBand = best && best.observationCount > 0 ? 1.96 / Math.sqrt(best.observationCount) : null;
  return { rows, bestLag: best, confidenceBand };
}

function buildLagOverlay(leftSeries: ReturnSeries, rightSeries: ReturnSeries, lag: number | null): Array<{ date: string; left: number | null; right: number | null }> {
  if (lag == null) return [];
  const aligned = laggedAlignment(leftSeries, rightSeries, lag);
  return aligned.dates.map((date, index) => ({
    date,
    left: aligned.leftValues[index] ?? null,
    right: aligned.rightValues[index] ?? null,
  }));
}

function compareIsoDates(left: string | null, right: string | null): number {
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  return left.localeCompare(right);
}

function addUtcDays(isoDate: string, days: number): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

async function upsertBars(env: Env, bars: DailyBar[]): Promise<void> {
  if (bars.length === 0) return;
  for (let index = 0; index < bars.length; index += BAR_UPSERT_CHUNK_SIZE) {
    const chunk = bars.slice(index, index + BAR_UPSERT_CHUNK_SIZE);
    const statements = chunk.map((bar) =>
      env.DB.prepare(
        "INSERT OR REPLACE INTO daily_bars (ticker, date, o, h, l, c, volume) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(bar.ticker.toUpperCase(), bar.date, bar.o, bar.h, bar.l, bar.c, bar.volume),
    );
    await env.DB.batch(statements);
  }
}

async function loadTickerMetadata(env: Env, tickers: string[]): Promise<Map<string, string | null>> {
  if (tickers.length === 0) return new Map();
  const placeholders = tickers.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT ticker, name as displayName FROM symbols WHERE ticker IN (${placeholders})`,
  )
    .bind(...tickers)
    .all<TickerMetaRow>();
  return new Map((result.results ?? []).map((row) => [row.ticker.toUpperCase(), row.displayName ?? null]));
}

async function loadLatestBarDates(env: Env, tickers: string[]): Promise<Map<string, string | null>> {
  if (tickers.length === 0) return new Map();
  const placeholders = tickers.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT ticker, MAX(date) as lastBarDate FROM daily_bars WHERE ticker IN (${placeholders}) GROUP BY ticker`,
  )
    .bind(...tickers)
    .all<{ ticker: string; lastBarDate: string | null }>();
  return new Map((result.results ?? []).map((row) => [row.ticker.toUpperCase(), row.lastBarDate ?? null]));
}

async function attemptCorrelationBackfill(
  env: Env,
  requestedTickers: string[],
  expectedAsOfDate: string,
): Promise<string[]> {
  const latestBarDates = await loadLatestBarDates(env, requestedTickers);
  const staleTickers = requestedTickers.filter((ticker) => {
    const lastBarDate = latestBarDates.get(ticker.toUpperCase());
    return lastBarDate != null && lastBarDate < expectedAsOfDate;
  });
  if (staleTickers.length === 0) return [];

  const staleStartDates = staleTickers
    .map((ticker) => latestBarDates.get(ticker.toUpperCase()))
    .filter((value): value is string => Boolean(value))
    .map((value) => addUtcDays(value, 1));
  const startDate = staleStartDates.sort().at(0);
  if (!startDate || startDate > expectedAsOfDate) return [];

  try {
    const provider = getProvider(env);
    const freshBars = await provider.getDailyBars(staleTickers, startDate, expectedAsOfDate);
    if (freshBars.length > 0) {
      await upsertBars(env, freshBars);
      return [];
    }
    return [`Backfill attempted for stale correlation tickers (${staleTickers.join(", ")}), but no newer bars were returned.`];
  } catch (error) {
    console.error("correlation backfill failed; stored bars used", { requestedTickers: staleTickers, error });
    const message = error instanceof Error ? error.message : "unknown provider error";
    return [`Live correlation backfill failed; stale stored bars were used instead (${message}).`];
  }
}

async function loadTickerBars(env: Env, tickers: string[], closePeriods: number): Promise<Map<string, PriceSeries>> {
  if (tickers.length === 0) return new Map();
  const placeholders = tickers.map(() => "?").join(", ");
  const perTickerLimit = closePeriods + BAR_FETCH_BUFFER;
  const result = await env.DB.prepare(
    `SELECT ticker, date, c
     FROM (
       SELECT
         ticker,
         date,
         c,
         ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS row_num
       FROM daily_bars
       WHERE ticker IN (${placeholders})
     )
     WHERE row_num <= ?
     ORDER BY ticker, date`,
  )
    .bind(...tickers, perTickerLimit)
    .all<RawBarRow>();
  const grouped = new Map<string, PriceSeries>();
  for (const row of result.results ?? []) {
    const ticker = row.ticker.toUpperCase();
    const current = grouped.get(ticker) ?? { dates: [], closes: [] };
    current.dates.push(row.date);
    current.closes.push(row.c);
    grouped.set(ticker, current);
  }
  return grouped;
}

async function loadPreparedSeries(
  env: Env,
  requestedTickers: string[],
  lookback: CorrelationLookback,
): Promise<{
  expectedAsOfDate: string;
  latestAvailableDate: string | null;
  resolvedTickers: CorrelationResolvedTicker[];
  unresolvedTickers: CorrelationUnresolvedTicker[];
  priceSeriesByTicker: Map<string, PriceSeries>;
  returnSeriesByTicker: Map<string, ReturnSeries>;
  warnings: string[];
}> {
  const uniqueTickers = Array.from(new Set(requestedTickers.map((ticker) => ticker.toUpperCase())));
  const closePeriods = closePeriodsForLookback(lookback);
  const expectedAsOfDate = latestUsSessionAsOfDate(new Date());
  const backfillWarnings = await attemptCorrelationBackfill(env, uniqueTickers, expectedAsOfDate);
  const [metadataByTicker, rawBarsByTicker] = await Promise.all([
    loadTickerMetadata(env, uniqueTickers),
    loadTickerBars(env, uniqueTickers, closePeriods),
  ]);
  const preparedPriceSeriesByTicker = new Map<string, PriceSeries>();
  const preparedReturnSeriesByTicker = new Map<string, ReturnSeries>();
  const unresolvedTickers: CorrelationUnresolvedTicker[] = [];
  const latestByTicker = new Map<string, string | null>();

  for (const ticker of uniqueTickers) {
    const rawSeries = rawBarsByTicker.get(ticker);
    if (!rawSeries || rawSeries.closes.length === 0) {
      unresolvedTickers.push({
        ticker,
        reason: metadataByTicker.has(ticker) ? "missing_history" : "unknown_ticker",
      });
      continue;
    }
    const cleaned = sanitizeBarSeries(rawSeries.dates, rawSeries.closes);
    const priceSeries = selectTrailingPriceSeries(cleaned.dates, cleaned.closes, closePeriods);
    if (priceSeries.closes.length < 2) {
      unresolvedTickers.push({ ticker, reason: "missing_history" });
      continue;
    }
    preparedPriceSeriesByTicker.set(ticker, priceSeries);
    preparedReturnSeriesByTicker.set(ticker, buildReturnSeries(priceSeries));
    latestByTicker.set(ticker, priceSeries.dates[priceSeries.dates.length - 1] ?? null);
  }

  const latestAvailableDate = Array.from(latestByTicker.values()).sort(compareIsoDates).at(-1) ?? null;
  const warnings: string[] = [...backfillWarnings];
  const datasetWarning = buildDatasetStaleWarning(latestAvailableDate, expectedAsOfDate);
  if (datasetWarning) warnings.push(datasetWarning);

  const resolvedTickers = uniqueTickers
    .filter((ticker) => preparedPriceSeriesByTicker.has(ticker))
    .map((ticker) => {
      const priceSeries = preparedPriceSeriesByTicker.get(ticker)!;
      const lastBarDate = priceSeries.dates[priceSeries.dates.length - 1] ?? null;
      const tickerWarning = buildTickerWarning(ticker, lastBarDate, latestAvailableDate);
      if (tickerWarning) warnings.push(tickerWarning);
      return {
        ticker,
        displayName: metadataByTicker.get(ticker) ?? null,
        lastBarDate,
        barCount: priceSeries.closes.length,
        status: determineTickerStatus(lastBarDate, latestAvailableDate),
      } satisfies CorrelationResolvedTicker;
    });

  return {
    expectedAsOfDate,
    latestAvailableDate,
    resolvedTickers,
    unresolvedTickers,
    priceSeriesByTicker: preparedPriceSeriesByTicker,
    returnSeriesByTicker: preparedReturnSeriesByTicker,
    warnings,
  };
}

export async function loadCorrelationMatrix(
  env: Env,
  requestedTickers: string[],
  lookback: CorrelationLookback,
): Promise<CorrelationMatrixResponse> {
  const prepared = await loadPreparedSeries(env, requestedTickers, lookback);
  if (prepared.resolvedTickers.length < 2) {
    throw new Error("At least 2 valid tickers with stored history are required.");
  }

  const matrix: Array<Array<number | null>> = [];
  const overlapCounts: number[][] = [];

  for (let row = 0; row < prepared.resolvedTickers.length; row += 1) {
    const rowTicker = prepared.resolvedTickers[row].ticker;
    const rowReturns = prepared.returnSeriesByTicker.get(rowTicker)!;
    const matrixRow: Array<number | null> = [];
    const overlapRow: number[] = [];
    for (let column = 0; column < prepared.resolvedTickers.length; column += 1) {
      const columnTicker = prepared.resolvedTickers[column].ticker;
      if (row === column) {
        matrixRow.push(1);
        overlapRow.push(rowReturns.values.length);
        continue;
      }
      const columnReturns = prepared.returnSeriesByTicker.get(columnTicker)!;
      const aligned = alignReturnSeries(rowReturns, columnReturns);
      overlapRow.push(aligned.leftValues.length);
      matrixRow.push(
        aligned.leftValues.length >= MIN_CORRELATION_OBSERVATIONS
          ? clampNumber(pearsonCorrelation(aligned.leftValues, aligned.rightValues))
          : null,
      );
    }
    matrix.push(matrixRow);
    overlapCounts.push(overlapRow);
  }

  return {
    requestedTickers,
    lookback,
    returnPeriods: returnPeriodsForLookback(lookback),
    generatedAt: new Date().toISOString(),
    expectedAsOfDate: prepared.expectedAsOfDate,
    latestAvailableDate: prepared.latestAvailableDate,
    resolvedTickers: prepared.resolvedTickers,
    unresolvedTickers: prepared.unresolvedTickers,
    matrix,
    overlapCounts,
    warnings: prepared.warnings,
    defaultPair: bestPairFromMatrix(prepared.resolvedTickers, matrix),
  };
}

export async function loadCorrelationPair(
  env: Env,
  tickers: [string, string],
  lookback: CorrelationLookback,
  rollingWindow: CorrelationRollingWindow,
): Promise<CorrelationPairResponse> {
  const requestedTickers = [tickers[0].toUpperCase(), tickers[1].toUpperCase()];
  const prepared = await loadPreparedSeries(env, requestedTickers, lookback);
  if (prepared.resolvedTickers.length < 2) {
    throw new Error("Both selected tickers require stored history.");
  }

  const leftMeta = prepared.resolvedTickers.find((ticker) => ticker.ticker === requestedTickers[0]);
  const rightMeta = prepared.resolvedTickers.find((ticker) => ticker.ticker === requestedTickers[1]);
  if (!leftMeta || !rightMeta) {
    throw new Error("Both selected tickers require stored history.");
  }

  const leftPrices = prepared.priceSeriesByTicker.get(leftMeta.ticker)!;
  const rightPrices = prepared.priceSeriesByTicker.get(rightMeta.ticker)!;
  const alignedPrices = alignPriceSeries(leftPrices, rightPrices);
  const normalizedSeries = buildNormalizedSeries(alignedPrices);
  const logPricePoints = alignedPrices.dates.flatMap((date, index) => {
    const leftValue = alignedPrices.leftValues[index];
    const rightValue = alignedPrices.rightValues[index];
    if (!Number.isFinite(leftValue) || leftValue <= 0 || !Number.isFinite(rightValue) || rightValue <= 0) {
      return [];
    }
    return [{
      date,
      leftLog: Math.log(leftValue),
      rightLog: Math.log(rightValue),
    }];
  });
  const leftLogs = logPricePoints.map((point) => point.leftLog);
  const rightLogs = logPricePoints.map((point) => point.rightLog);
  const regressionStats = ordinaryLeastSquares(leftLogs, rightLogs);
  const regressionPoints = logPricePoints.map((point) => ({
    date: point.date,
    x: point.leftLog,
    y: point.rightLog,
  }));
  const regressionLine = buildRegressionLine(
    regressionPoints.map((point) => ({ x: point.x, y: point.y })),
    regressionStats.beta,
    regressionStats.intercept,
  );

  const residuals = regressionStats.beta == null || regressionStats.intercept == null
    ? [] as number[]
    : leftLogs.map((x, index) => rightLogs[index] - (regressionStats.intercept! + regressionStats.beta! * x));

  const rollingPeriodCount = rollingPeriodsForWindow(rollingWindow);
  const spreadMeans = buildRollingMean(residuals, rollingPeriodCount);
  const spreadStdDevs = buildRollingStdDev(residuals, rollingPeriodCount);
  const spreadSeries = residuals.length === logPricePoints.length ? logPricePoints.map((point, index) => {
    const meanValue = spreadMeans[index];
    const stdDev = spreadStdDevs[index];
    const spread = residuals[index];
    const upper2Sigma = meanValue != null && stdDev != null ? meanValue + stdDev * 2 : null;
    const lower2Sigma = meanValue != null && stdDev != null ? meanValue - stdDev * 2 : null;
    const zScore = meanValue != null && stdDev != null && stdDev > STABILITY_EPSILON ? (spread - meanValue) / stdDev : null;
    return {
      date: point.date,
      spread,
      mean: meanValue,
      upper2Sigma,
      lower2Sigma,
      zScore,
    };
  }) : [];

  const leftReturns = prepared.returnSeriesByTicker.get(leftMeta.ticker)!;
  const rightReturns = prepared.returnSeriesByTicker.get(rightMeta.ticker)!;
  const alignedReturns = alignReturnSeries(leftReturns, rightReturns);
  const rollingCorrelation = buildRollingCorrelationSeries(alignedReturns, rollingPeriodCount);
  const leadLag = buildLeadLagAnalysis(leftReturns, rightReturns);
  const lagOverlay = buildLagOverlay(leftReturns, rightReturns, leadLag.bestLag?.lag ?? null);

  const warnings = [...prepared.warnings];
  if (alignedPrices.leftValues.length < 2) {
    warnings.push(`Not enough overlapping price observations for ${leftMeta.ticker} and ${rightMeta.ticker}.`);
  }
  if (alignedReturns.leftValues.length < MIN_CORRELATION_OBSERVATIONS) {
    warnings.push(`Only ${alignedReturns.leftValues.length} shared daily returns were available; correlation-based metrics may be limited.`);
  }

  return {
    lookback,
    rollingWindow,
    generatedAt: new Date().toISOString(),
    warnings,
    pair: {
      left: leftMeta,
      right: rightMeta,
      overlapStartDate: alignedPrices.dates[0] ?? null,
      overlapEndDate: alignedPrices.dates[alignedPrices.dates.length - 1] ?? null,
      priceObservationCount: alignedPrices.dates.length,
      returnObservationCount: alignedReturns.dates.length,
    },
    overview: {
      normalizedSeries,
      regressionPoints,
      regressionLine,
      stats: regressionStats,
    },
    spread: {
      series: spreadSeries,
      latest: {
        spread: spreadSeries[spreadSeries.length - 1]?.spread ?? null,
        zScore: spreadSeries[spreadSeries.length - 1]?.zScore ?? null,
      },
    },
    dynamics: {
      rollingCorrelation,
      leadLag,
      lagOverlay,
    },
  };
}
