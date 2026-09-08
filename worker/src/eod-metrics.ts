/** Pure, versioned calculations. Callers must normalize every provider series to
 * one split-adjustment basis before passing it here. No provider I/O or D1 reads. */
export const EOD_METRICS_VERSION = "eod-exact-session-v1";

export type EodMetricProvider = "alpaca" | "yahoo";
export type EodMetricBar = {
  ticker: string;
  sessionDate: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  reportedVolume: number | null;
  sourceProvider: EodMetricProvider;
  priceBasis: "split";
  sourceFeed?: string;
  volumeSourceProvider?: "alpaca";
  collectedAt?: string | null;
  reportedVolumeCollectedAt?: string | null;
};
export type EodMetricMember = { ticker: string; verifiedListingDate?: string | null };
export type EodMetricCoverage = {
  eligibleCount: number;
  eligiblePopulation: number;
  totalUniverseMembers: number;
  structurallyIneligibleCount: number;
  missingCount: number;
  coveragePct: number;
  thresholdPct: number;
  status: "ready" | "suppressed";
  lowerBound?: number;
  upperBound?: number;
  boundUnit?: "count" | "percent";
};
export type EodTickerMetricInput = EodMetricMember & {
  targetSession: string;
  calendarDates: readonly string[];
  bars: readonly EodMetricBar[];
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const pct = (value: number, base: number): number => ((value - base) / base) * 100;
const average = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

function calendarThrough(dates: readonly string[], session: string): string[] {
  if (!ISO_DATE.test(session) || dates.some((date) => !ISO_DATE.test(date))) {
    throw new Error("EOD calculations require ISO exchange-session dates.");
  }
  const calendar = Array.from(new Set(dates)).filter((date) => date <= session).sort();
  if (calendar.at(-1) !== session) throw new Error(`Target ${session} is absent from the exchange calendar.`);
  return calendar;
}

function validPriceBar(bar: EodMetricBar): boolean {
  if (bar.priceBasis !== "split" || !positive(bar.close)) return false;
  if (bar.sourceProvider === "alpaca" && bar.sourceFeed && bar.sourceFeed !== "sip") return false;
  for (const value of [bar.open, bar.high, bar.low]) {
    if (value !== undefined && !positive(value)) return false;
  }
  if (bar.high !== undefined && bar.high < Math.max(bar.close, bar.open ?? bar.close)) return false;
  if (bar.low !== undefined && bar.low > Math.min(bar.close, bar.open ?? bar.close)) return false;
  return bar.high === undefined || bar.low === undefined || bar.high >= bar.low;
}

function providerSeries(input: EodTickerMetricInput, provider: EodMetricProvider): Map<string, EodMetricBar> {
  const byDate = new Map<string, EodMetricBar>();
  const conflicts = new Set<string>();
  for (const bar of input.bars) {
    if (bar.ticker.toUpperCase() !== input.ticker.toUpperCase() || bar.sourceProvider !== provider
      || bar.sessionDate > input.targetSession || !validPriceBar(bar)) continue;
    const existing = byDate.get(bar.sessionDate);
    if (existing && existing.close !== bar.close) conflicts.add(bar.sessionDate);
    byDate.set(bar.sessionDate, bar);
  }
  for (const date of conflicts) byDate.delete(date);
  return byDate;
}

function completeWindow(calendar: string[], series: Map<string, EodMetricBar>, count: number): EodMetricBar[] | null {
  if (count <= 0 || calendar.length < count) return null;
  const rows = calendar.slice(-count).map((date) => series.get(date));
  return rows.every((row): row is EodMetricBar => Boolean(row)) ? rows : null;
}

function chooseSeries(input: EodTickerMetricInput, calendar: string[]) {
  const alpaca = providerSeries(input, "alpaca");
  const yahoo = providerSeries(input, "yahoo");
  // One provider for every price field. A fallback cannot silently supply only
  // a denominator or moving average from a different price series.
  for (const count of [252, 2, 1]) {
    if (completeWindow(calendar, alpaca, count)) return { provider: "alpaca" as const, series: alpaca };
    if (completeWindow(calendar, yahoo, count)) return { provider: "yahoo" as const, series: yahoo };
  }
  return { provider: null, series: new Map<string, EodMetricBar>() };
}

function collectionTime(value: unknown): string | null {
  if (typeof value !== "string" || !value.includes("T") || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function reportedVolume(input: EodTickerMetricInput): { value: number | null; collectedAt: string | null } {
  const observations = input.bars.filter((bar) => bar.ticker.toUpperCase() === input.ticker.toUpperCase()
    && bar.sessionDate === input.targetSession
    && ((bar.sourceProvider === "alpaca" && (!bar.sourceFeed || bar.sourceFeed === "sip"))
      || bar.volumeSourceProvider === "alpaca"))
    .filter((bar) => typeof bar.reportedVolume === "number" && Number.isFinite(bar.reportedVolume) && bar.reportedVolume >= 0);
  if (!observations.length || !observations.every((bar) => bar.reportedVolume === observations[0]!.reportedVolume)) {
    return { value: null, collectedAt: null };
  }
  // A split-price fetch and the independent raw-volume fetch may occur at
  // different times. Only explicit reported-volume evidence dates the volume.
  const times = observations.map((bar) => collectionTime(bar.reportedVolumeCollectedAt))
    .filter((time): time is string => time !== null).sort();
  return { value: observations[0]!.reportedVolume, collectedAt: times.at(-1) ?? null };
}

export function computeEodTickerMetrics(input: EodTickerMetricInput) {
  const calendar = calendarThrough(input.calendarDates, input.targetSession);
  const selected = chooseSeries(input, calendar);
  const price = selected.series.get(input.targetSession)?.close ?? null;
  const window = (count: number) => completeWindow(calendar, selected.series, count)?.map((bar) => bar.close) ?? null;
  const returnFor = (sessions: number) => {
    const closes = window(sessions + 1);
    return closes ? pct(closes.at(-1)!, closes[0]!) : null;
  };
  const movingAverage = (sessions: number) => { const closes = window(sessions); return closes ? average(closes) : null; };
  const high = (sessions: number) => { const closes = window(sessions); return closes ? Math.max(...closes) : null; };
  const sma5 = movingAverage(5);
  const sma20 = movingAverage(20);
  const sma50 = movingAverage(50);
  const sma100 = movingAverage(100);
  const sma200 = movingAverage(200);
  const high252 = high(252);
  let priorYearIndex = -1;
  for (let index = 0; index < calendar.length; index += 1) {
    if (calendar[index]!.slice(0, 4) < input.targetSession.slice(0, 4)) priorYearIndex = index;
  }
  const ytdWindow = priorYearIndex >= 0 ? window(calendar.length - priorYearIndex) : null;
  const change1d = returnFor(1);
  const change5d = returnFor(5);
  const change21d = returnFor(21);
  const change3m = returnFor(63);
  const change6m = returnFor(126);
  const ytd = ytdWindow ? pct(ytdWindow.at(-1)!, ytdWindow[0]!) : null;
  const volume = reportedVolume(input);
  const high252Bars = completeWindow(calendar, selected.series, 252);
  const intradayHigh252 = high252Bars?.every((bar) => positive(bar.high))
    ? Math.max(...high252Bars.map((bar) => bar.high!)) : null;
  const values = {
    price, change1d, change5d, change1w: change5d, change21d, change3m, change6m, ytd,
    pctFrom52wHigh: price !== null && intradayHigh252 !== null ? pct(price, intradayHigh252) : null,
    above20Sma: price !== null && sma20 !== null ? price > sma20 : null,
    above50Sma: price !== null && sma50 !== null ? price > sma50 : null,
    above200Sma: price !== null && sma200 !== null ? price > sma200 : null,
    sma5, sma20, sma50, sma100, sma200,
    high5: high(5), high20: high(20), high21: high(21), high63: high(63), high126: high(126), high252,
    low20: window(20) ? Math.min(...window(20)!) : null,
    reportedVolume: volume.value,
  };
  const fieldSources: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) fieldSources[key] = key === "reportedVolume" ? "alpaca:sip-reported-volume" : `${selected.provider}:split-daily-bars`;
  }
  const sparklineDates = calendar.slice(-90);
  return {
    ticker: input.ticker.toUpperCase(), sessionDate: input.targetSession,
    methodologyVersion: EOD_METRICS_VERSION, sourceProvider: selected.provider,
    collectedAt: collectionTime(selected.series.get(input.targetSession)?.collectedAt),
    reportedVolumeCollectedAt: volume.collectedAt,
    sourceSessions: calendar.filter((date) => selected.series.has(date)).length,
    verifiedListingDate: input.verifiedListingDate ?? null,
    ...values, fieldSources, sparklineDates,
    sparkline: sparklineDates.map((date) => selected.series.get(date)?.close ?? null),
  };
}

export type EodTickerMetrics = ReturnType<typeof computeEodTickerMetrics>;

export function computeEodRelativeStrengthSeries(input: {
  ticker: EodTickerMetricInput;
  benchmark: EodTickerMetricInput;
  lookback?: number;
}): { dates: string[]; values: Array<number | null> } {
  if (input.ticker.targetSession !== input.benchmark.targetSession) throw new Error("Relative strength sessions must match.");
  const dates = calendarThrough(input.ticker.calendarDates, input.ticker.targetSession);
  const ticker = chooseSeries(input.ticker, dates).series;
  const benchmark = chooseSeries(input.benchmark, dates).series;
  const scoped = dates.slice(-Math.max(1, Math.min(90, input.lookback ?? 30)));
  return { dates: scoped, values: scoped.map((date) => {
    const left = ticker.get(date)?.close;
    const right = benchmark.get(date)?.close;
    return left !== undefined && right !== undefined ? left / right : null;
  }) };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function computeEodBreadthMetrics(input: {
  universeId: string;
  targetSession: string;
  calendarDates: readonly string[];
  members: readonly EodMetricMember[];
  bars: readonly EodMetricBar[];
  features?: ReadonlyMap<string, EodTickerMetrics>;
}) {
  const calendar = calendarThrough(input.calendarDates, input.targetSession);
  const requiredCoveragePct = input.universeId === "sp500-core" ? 98 : 95;
  const members = Array.from(new Map(input.members.map((member) => [member.ticker.toUpperCase(), member])).values());
  const barsByTicker = new Map<string, EodMetricBar[]>();
  for (const bar of input.bars) {
    const ticker = bar.ticker.toUpperCase();
    const rows = barsByTicker.get(ticker) ?? [];
    rows.push(bar);
    barsByTicker.set(ticker, rows);
  }
  const rows = members.map((member) => {
    const cached = input.features?.get(member.ticker.toUpperCase());
    if (cached?.sessionDate === input.targetSession && cached.methodologyVersion === EOD_METRICS_VERSION) {
      return { ...cached, verifiedListingDate: member.verifiedListingDate ?? null };
    }
    return computeEodTickerMetrics({ ...member, targetSession: input.targetSession,
      calendarDates: calendar, bars: barsByTicker.get(member.ticker.toUpperCase()) ?? [] });
  });
  const metricCoverage: Record<string, EodMetricCoverage> = {};
  const eligibleFor = (row: EodTickerMetrics, sessions: number): boolean => {
    if (!row.verifiedListingDate || !ISO_DATE.test(row.verifiedListingDate)) return true;
    const start = calendar.at(-sessions);
    if (start) return row.verifiedListingDate <= start;
    // A short calendar cannot prove pre-listing ineligibility unless it covers
    // the verified listing date; otherwise the population remains missing.
    return calendar[0]! > row.verifiedListingDate || calendar.filter((date) => date >= row.verifiedListingDate!).length >= sessions;
  };
  const qualified = (key: string, sessions: number, value: (row: EodTickerMetrics) => number | null) => {
    const population = rows.filter((row) => eligibleFor(row, sessions));
    const observed = population.filter((row) => value(row) !== null);
    const coveragePct = population.length ? observed.length / population.length * 100 : 0;
    metricCoverage[key] = {
      eligibleCount: observed.length, eligiblePopulation: population.length, totalUniverseMembers: members.length,
      structurallyIneligibleCount: members.length - population.length, missingCount: population.length - observed.length,
      coveragePct, thresholdPct: requiredCoveragePct, status: population.length > 0 && coveragePct >= requiredCoveragePct ? "ready" : "suppressed",
    };
    return observed;
  };
  const daily = qualified("advancers", 2, (row) => row.change1d);
  for (const key of ["decliners", "unchanged", "advDecRatio", "medianReturn1D", "stocksGtPos4Pct", "stocksLtNeg4Pct"]) metricCoverage[key] = { ...metricCoverage.advancers! };
  const volume = qualified("totalVolume", 1, (row) => row.reportedVolume);
  const volumeTimes = volume.map((row) => collectionTime(row.reportedVolumeCollectedAt))
    .filter((time): time is string => time !== null).sort();
  const volumeCollection = {
    earliest: volumeTimes[0] ?? null, latest: volumeTimes.at(-1) ?? null,
    observedCount: volumeTimes.length, eligibleCount: metricCoverage.totalVolume!.eligiblePopulation,
  };
  const weekly = qualified("medianReturn5D", 6, (row) => row.change5d);
  const quarter = qualified("return63D", 64, (row) => row.change3m);
  metricCoverage.stocksGtPos25Q = { ...metricCoverage.return63D! };
  metricCoverage.stocksLtNeg25Q = { ...metricCoverage.return63D! };
  const count = (values: EodTickerMetrics[], predicate: (row: EodTickerMetrics) => boolean) => values.filter(predicate).length;
  const advancers = count(daily, (row) => row.change1d! > 0);
  const decliners = count(daily, (row) => row.change1d! < 0);
  const unchanged = daily.length - advancers - decliners;
  const gated = (key: string, value: number | null): number | null => metricCoverage[key]?.status === "ready" ? value : null;
  const percentage = (numerator: number, denominator: number) => denominator ? numerator / denominator * 100 : null;
  const bounds = (key: string, numerator: number, percent = false) => {
    const coverage = metricCoverage[key]!;
    if (!coverage.eligiblePopulation) return;
    coverage.boundUnit = percent ? "percent" : "count";
    coverage.lowerBound = percent ? numerator / coverage.eligiblePopulation * 100 : numerator;
    coverage.upperBound = percent ? (numerator + coverage.missingCount) / coverage.eligiblePopulation * 100 : numerator + coverage.missingCount;
  };
  const ma = (key: string, sessions: number, get: (row: EodTickerMetrics) => number | null) => {
    const values = qualified(key, sessions, get);
    const numerator = count(values, (row) => row.price! > get(row)!);
    bounds(key, numerator, true);
    return gated(key, percentage(numerator, values.length));
  };
  const highs = (key: string, sessions: number, get: (row: EodTickerMetrics) => number | null) => {
    const values = qualified(key, sessions, get);
    const n = count(values, (row) => row.price! >= get(row)!);
    bounds(key, n);
    const percentKey = `pct${key[0]!.toUpperCase()}${key.slice(1)}`;
    metricCoverage[percentKey] = { ...metricCoverage[key]! };
    bounds(percentKey, n, true);
    return { count: gated(key, n), percent: gated(key, percentage(n, values.length)) };
  };
  const high5 = highs("new5DHighs", 5, (row) => row.high5);
  const high21 = highs("new1MHighs", 21, (row) => row.high21);
  const high63 = highs("new3MHighs", 63, (row) => row.high63);
  const high126 = highs("new6MHighs", 126, (row) => row.high126);
  const high252 = highs("new52WHighs", 252, (row) => row.high252);
  const high20 = highs("new20DHighs", 20, (row) => row.high20);
  const low20Rows = qualified("new20DLows", 20, (row) => row.low20);
  const metrics = {
    memberCount: daily.length, totalUniverseMembers: members.length,
    dataCoveragePct: metricCoverage.advancers!.coveragePct, metricCoverage,
    advancers: gated("advancers", advancers), decliners: gated("decliners", decliners), unchanged: gated("unchanged", unchanged),
    advDecRatio: gated("advDecRatio", decliners > 0 ? advancers / decliners : null),
    totalVolume: gated("totalVolume", volume.reduce((sum, row) => sum + row.reportedVolume!, 0)),
    pctAbove5MA: ma("pctAbove5MA", 5, (row) => row.sma5),
    pctAbove20MA: ma("pctAbove20MA", 20, (row) => row.sma20),
    pctAbove50MA: ma("pctAbove50MA", 50, (row) => row.sma50),
    pctAbove100MA: ma("pctAbove100MA", 100, (row) => row.sma100),
    pctAbove200MA: ma("pctAbove200MA", 200, (row) => row.sma200),
    new5DHighs: high5.count, pctNew5DHighs: high5.percent,
    new1MHighs: high21.count, pctNew1MHighs: high21.percent,
    new3MHighs: high63.count, pctNew3MHighs: high63.percent,
    new6MHighs: high126.count, pctNew6MHighs: high126.percent,
    new52WHighs: high252.count, pctNew52WHighs: high252.percent,
    new20DHighs: high20.count,
    new20DLows: gated("new20DLows", count(low20Rows, (row) => row.price! <= row.low20!)),
    stocksGtPos4Pct: gated("stocksGtPos4Pct", count(daily, (row) => row.change1d! > 4)),
    stocksLtNeg4Pct: gated("stocksLtNeg4Pct", count(daily, (row) => row.change1d! < -4)),
    stocksGtPos25Q: gated("stocksGtPos25Q", count(quarter, (row) => row.change3m! > 25)),
    stocksLtNeg25Q: gated("stocksLtNeg25Q", count(quarter, (row) => row.change3m! < -25)),
    medianReturn1D: gated("medianReturn1D", median(daily.map((row) => row.change1d!))),
    medianReturn5D: gated("medianReturn5D", median(weekly.map((row) => row.change5d!))),
  };
  for (const [key, numerator] of [
    ["advancers", advancers], ["decliners", decliners], ["unchanged", unchanged],
    ["stocksGtPos4Pct", count(daily, (row) => row.change1d! > 4)],
    ["stocksLtNeg4Pct", count(daily, (row) => row.change1d! < -4)],
    ["stocksGtPos25Q", count(quarter, (row) => row.change3m! > 25)],
    ["stocksLtNeg25Q", count(quarter, (row) => row.change3m! < -25)],
    ["new20DLows", count(low20Rows, (row) => row.price! <= row.low20!)],
  ] as const) bounds(key, numerator);
  const sourceMix = { alpaca: rows.filter((row) => row.sourceProvider === "alpaca").length,
    yahoo: rows.filter((row) => row.sourceProvider === "yahoo").length, missing: rows.filter((row) => row.sourceProvider === null).length };
  return {
    asOfDate: input.targetSession, universeId: input.universeId, methodologyVersion: EOD_METRICS_VERSION,
    metrics, sourceMix, volumeCollection, coveragePct: metrics.dataCoveragePct, requiredCoveragePct,
    publishable: metricCoverage.advancers!.status === "ready",
    advancers: metrics.advancers, decliners: metrics.decliners, unchanged: metrics.unchanged,
    pctAbove20MA: metrics.pctAbove20MA, pctAbove50MA: metrics.pctAbove50MA, pctAbove200MA: metrics.pctAbove200MA,
    new20DHighs: metrics.new20DHighs, new20DLows: metrics.new20DLows,
    medianReturn1D: metrics.medianReturn1D, medianReturn5D: metrics.medianReturn5D,
  };
}

/** Reuse the runner's per-symbol checkpoints across overlapping universes. */
export function aggregateEodBreadthMetrics(input: {
  universeId: string;
  targetSession: string;
  calendarDates: readonly string[];
  members: readonly EodMetricMember[];
  features: ReadonlyMap<string, EodTickerMetrics>;
}) {
  return computeEodBreadthMetrics({ ...input, bars: [] });
}
