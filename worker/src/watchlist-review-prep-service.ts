import { refreshDailyBarsIncremental } from "./daily-bars";
import { getProvider } from "./provider";
import { latestUsSessionAsOfDate } from "./refresh-timing";
import type { Env } from "./types";

export type WatchlistReviewPrepStatus = "ready" | "ready_with_warnings" | "blocked";
export type WatchlistReviewPrepSymbolFreshnessStatus = "fresh" | "stale" | "missing";

export type WatchlistReviewPrepProvider = {
  primary: string;
  feed: string | null;
  adjustment: "all";
  fallbackEnabled: boolean;
  fallbacks: string[];
};

export type WatchlistReviewPrepCoverage = {
  complete: number;
  stale: number;
  missing: number;
  coveragePct: number;
};

export type WatchlistReviewPrepSymbol = {
  ticker: string;
  tvSymbol: string | null;
  name: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  latestDate: string | null;
  availableBars: number;
  freshness: {
    latestDate: string | null;
    expectedAsOfDate: string;
    status: WatchlistReviewPrepSymbolFreshnessStatus;
  };
};

export type WatchlistReviewPrepSummary = {
  prepId: string;
  source: string;
  sourceSetId: string | null;
  sourceSetName: string | null;
  watchlistName: string | null;
  watchlistRunId: string | null;
  symbolCount: number;
  lookbackBars: number;
  expectedAsOfDate: string;
  provider: WatchlistReviewPrepProvider;
  coverage: WatchlistReviewPrepCoverage;
  status: WatchlistReviewPrepStatus;
  warnings: string[];
  timing: {
    refreshMs: number;
    dbReadMs: number;
    totalMs: number;
    requestedSymbols: number;
    refreshedSymbols: number;
    skippedFreshSymbols: number;
  };
  hermesNext: {
    command: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type WatchlistReviewPrepBarsResponse = WatchlistReviewPrepSummary & {
  symbols: Array<WatchlistReviewPrepSymbol & {
    bars: Array<{
      date: string;
      o: number;
      h: number;
      l: number;
      c: number;
      volume: number;
    }>;
  }>;
  missing: string[];
  stale: string[];
};

type WatchlistReviewPrepRow = {
  id: string;
  source: string;
  sourceSetId: string | null;
  sourceSetName: string | null;
  watchlistName: string | null;
  watchlistRunId: string | null;
  symbolCount: number | string;
  lookbackBars: number | string;
  expectedAsOfDate: string;
  providerJson: string;
  coverageJson: string;
  symbolsJson: string;
  warningsJson: string;
  status: WatchlistReviewPrepStatus;
  createdAt: string;
  updatedAt: string;
};

type LatestBarRow = {
  ticker: string;
  latestDate: string | null;
  barCount: number | string | null;
};

type SymbolMetaRow = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
};

type OhlcvRow = {
  ticker: string;
  date: string;
  o: number | string;
  h: number | string;
  l: number | string;
  c: number | string;
  volume: number | string | null;
};

export type CreateWatchlistReviewPrepInput = {
  source: "watchlist-compiler" | string;
  sourceSetId?: string | null;
  sourceSetName?: string | null;
  watchlistName?: string | null;
  watchlistRunId?: string | null;
  symbols: string[];
  lookbackBars: number;
  refreshIfStale: boolean;
  now?: Date;
};

export type LoadWatchlistReviewPrepBarsOptions = {
  offset?: number;
  limit?: number;
  symbols?: string[];
};

const PREP_SELECT = `
  SELECT
    id,
    source,
    source_set_id as sourceSetId,
    source_set_name as sourceSetName,
    watchlist_name as watchlistName,
    watchlist_run_id as watchlistRunId,
    symbol_count as symbolCount,
    lookback_bars as lookbackBars,
    expected_as_of_date as expectedAsOfDate,
    provider_json as providerJson,
    coverage_json as coverageJson,
    symbols_json as symbolsJson,
    warnings_json as warningsJson,
    status,
    created_at as createdAt,
    updated_at as updatedAt
  FROM watchlist_review_preps
`;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function cleanText(value: unknown, max = 240): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function normalizeSymbols(symbols: string[], max = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of symbols) {
    const ticker = String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9.\-^]/g, "");
    if (!ticker || seen.has(ticker)) continue;
    if (!/^[A-Z0-9.\-^]{1,20}$/.test(ticker)) continue;
    seen.add(ticker);
    out.push(ticker);
    if (out.length >= max) break;
  }
  return out;
}

function addUtcDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function startDateForLookback(expectedAsOfDate: string, lookbackBars: number): string {
  return addUtcDays(expectedAsOfDate, -(Math.ceil(Math.max(1, lookbackBars) * 1.7) + 10));
}

function providerMetadata(env: Env): WatchlistReviewPrepProvider {
  const primary = (env.DATA_PROVIDER ?? "alpaca").toLowerCase();
  return {
    primary,
    feed: primary === "alpaca" ? env.ALPACA_FEED ?? "iex" : null,
    adjustment: "all",
    fallbackEnabled: true,
    fallbacks: ["stooq", "yahoo", "fmp", "alpha-vantage"],
  };
}

function tvSymbolFor(ticker: string, exchange: string | null): string | null {
  const normalized = (exchange ?? "").trim().toUpperCase();
  if (!normalized) return null;
  if (ticker.includes(":")) return ticker;
  return `${normalized}:${ticker}`;
}

function chunk<T>(values: T[], size = 80): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

function numberOr(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function loadSymbolMetadata(env: Env, tickers: string[]): Promise<Map<string, SymbolMetaRow>> {
  const meta = new Map<string, SymbolMetaRow>();
  for (const group of chunk(tickers)) {
    const placeholders = group.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT UPPER(ticker) as ticker, name, exchange, sector, industry
       FROM symbols
       WHERE UPPER(ticker) IN (${placeholders})`,
    ).bind(...group).all<SymbolMetaRow>();
    for (const row of rows.results ?? []) {
      meta.set(row.ticker.toUpperCase(), {
        ticker: row.ticker.toUpperCase(),
        name: row.name ?? null,
        exchange: row.exchange ?? null,
        sector: row.sector ?? null,
        industry: row.industry ?? null,
      });
    }
  }
  return meta;
}

async function loadLatestBars(env: Env, tickers: string[]): Promise<Map<string, { latestDate: string | null; barCount: number }>> {
  const latest = new Map<string, { latestDate: string | null; barCount: number }>();
  for (const group of chunk(tickers)) {
    const placeholders = group.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT UPPER(ticker) as ticker, MAX(date) as latestDate, COUNT(*) as barCount
       FROM daily_bars
       WHERE UPPER(ticker) IN (${placeholders})
       GROUP BY UPPER(ticker)`,
    ).bind(...group).all<LatestBarRow>();
    for (const row of rows.results ?? []) {
      latest.set(row.ticker.toUpperCase(), {
        latestDate: row.latestDate ?? null,
        barCount: Math.max(0, Math.trunc(numberOr(row.barCount, 0))),
      });
    }
  }
  return latest;
}

function buildSymbols(
  tickers: string[],
  meta: Map<string, SymbolMetaRow>,
  latest: Map<string, { latestDate: string | null; barCount: number }>,
  expectedAsOfDate: string,
): WatchlistReviewPrepSymbol[] {
  return tickers.map((ticker) => {
    const row = meta.get(ticker);
    const bars = latest.get(ticker) ?? { latestDate: null, barCount: 0 };
    const status: WatchlistReviewPrepSymbolFreshnessStatus = !bars.latestDate
      ? "missing"
      : bars.latestDate >= expectedAsOfDate
        ? "fresh"
        : "stale";
    return {
      ticker,
      tvSymbol: tvSymbolFor(ticker, row?.exchange ?? null),
      name: row?.name ?? null,
      exchange: row?.exchange ?? null,
      sector: row?.sector ?? null,
      industry: row?.industry ?? null,
      latestDate: bars.latestDate,
      availableBars: bars.barCount,
      freshness: {
        latestDate: bars.latestDate,
        expectedAsOfDate,
        status,
      },
    };
  });
}

function coverageFor(symbols: WatchlistReviewPrepSymbol[]): WatchlistReviewPrepCoverage {
  const complete = symbols.filter((symbol) => symbol.freshness.status === "fresh").length;
  const stale = symbols.filter((symbol) => symbol.freshness.status === "stale").length;
  const missing = symbols.filter((symbol) => symbol.freshness.status === "missing").length;
  return {
    complete,
    stale,
    missing,
    coveragePct: symbols.length > 0 ? Number(((complete / symbols.length) * 100).toFixed(1)) : 0,
  };
}

function statusFor(symbols: WatchlistReviewPrepSymbol[], coverage: WatchlistReviewPrepCoverage): WatchlistReviewPrepStatus {
  if (symbols.every((symbol) => symbol.availableBars === 0)) return "blocked";
  if (coverage.stale > 0 || coverage.missing > 0) return "ready_with_warnings";
  return "ready";
}

function warningsFor(status: WatchlistReviewPrepStatus, coverage: WatchlistReviewPrepCoverage): string[] {
  const warnings: string[] = [];
  if (coverage.stale > 0) warnings.push(`${coverage.stale} symbol${coverage.stale === 1 ? "" : "s"} stale versus expected session.`);
  if (coverage.missing > 0) warnings.push(`${coverage.missing} symbol${coverage.missing === 1 ? "" : "s"} missing OHLCV bars.`);
  if (status === "blocked") warnings.push("No usable OHLCV bars were available for this prep.");
  return warnings;
}

function mapPrepRow(row: WatchlistReviewPrepRow, timingOverride?: WatchlistReviewPrepSummary["timing"]): WatchlistReviewPrepSummary {
  const prepId = row.id;
  return {
    prepId,
    source: row.source,
    sourceSetId: row.sourceSetId ?? null,
    sourceSetName: row.sourceSetName ?? null,
    watchlistName: row.watchlistName ?? null,
    watchlistRunId: row.watchlistRunId ?? null,
    symbolCount: Math.max(0, Math.trunc(numberOr(row.symbolCount, 0))),
    lookbackBars: Math.max(0, Math.trunc(numberOr(row.lookbackBars, 0))),
    expectedAsOfDate: row.expectedAsOfDate,
    provider: parseJson<WatchlistReviewPrepProvider>(row.providerJson, {
      primary: "alpaca",
      feed: "iex",
      adjustment: "all",
      fallbackEnabled: true,
      fallbacks: ["stooq", "yahoo", "fmp", "alpha-vantage"],
    }),
    coverage: parseJson<WatchlistReviewPrepCoverage>(row.coverageJson, { complete: 0, stale: 0, missing: 0, coveragePct: 0 }),
    status: row.status,
    warnings: parseJson<string[]>(row.warningsJson, []),
    timing: timingOverride ?? { refreshMs: 0, dbReadMs: 0, totalMs: 0, requestedSymbols: 0, refreshedSymbols: 0, skippedFreshSymbols: 0 },
    hermesNext: {
      command: `/run-watchlist-review from-prep ${prepId}`,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadPrepRow(env: Env, prepId: string): Promise<WatchlistReviewPrepRow | null> {
  return await env.DB.prepare(`${PREP_SELECT} WHERE id = ? LIMIT 1`).bind(prepId).first<WatchlistReviewPrepRow>();
}

export async function createWatchlistReviewPrep(
  env: Env,
  input: CreateWatchlistReviewPrepInput,
): Promise<WatchlistReviewPrepSummary> {
  const startedAt = Date.now();
  const symbols = normalizeSymbols(input.symbols);
  if (symbols.length === 0) throw new Error("Provide at least one valid symbol for watchlist review prep.");
  const lookbackBars = Math.max(60, Math.min(520, Math.trunc(input.lookbackBars || 260)));
  const expectedAsOfDate = latestUsSessionAsOfDate(input.now ?? new Date());
  const startDate = startDateForLookback(expectedAsOfDate, lookbackBars);
  const provider = providerMetadata(env);

  const dbStartedAt = Date.now();
  let [latest, meta] = await Promise.all([
    loadLatestBars(env, symbols),
    loadSymbolMetadata(env, symbols),
  ]);
  let dbReadMs = Date.now() - dbStartedAt;
  let refreshMs = 0;

  const toRefresh = symbols.filter((ticker) => {
    const row = latest.get(ticker);
    return !row?.latestDate || row.latestDate < expectedAsOfDate;
  });

  if (input.refreshIfStale && toRefresh.length > 0) {
    const refreshStartedAt = Date.now();
    try {
      await refreshDailyBarsIncremental(env, {
        provider: getProvider(env, { fallbackEnabled: true, yahooPreferredTickers: symbols }),
        tickers: toRefresh,
        startDate,
        endDate: expectedAsOfDate,
        providerBatchSize: 80,
        continueOnError: true,
      });
    } finally {
      refreshMs = Date.now() - refreshStartedAt;
    }
    const reloadStartedAt = Date.now();
    latest = await loadLatestBars(env, symbols);
    dbReadMs += Date.now() - reloadStartedAt;
  }

  const symbolRows = buildSymbols(symbols, meta, latest, expectedAsOfDate);
  const coverage = coverageFor(symbolRows);
  const status = statusFor(symbolRows, coverage);
  const warnings = warningsFor(status, coverage);
  const now = new Date().toISOString();
  const prepId = `watchlist-review-prep-${expectedAsOfDate}-${crypto.randomUUID().slice(0, 8)}`;

  await env.DB.prepare(
    `INSERT INTO watchlist_review_preps
       (id, source, source_set_id, source_set_name, watchlist_name, watchlist_run_id, symbol_count, lookback_bars,
        expected_as_of_date, provider_json, coverage_json, symbols_json, warnings_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    prepId,
    cleanText(input.source, 80) ?? "watchlist-compiler",
    cleanText(input.sourceSetId, 160),
    cleanText(input.sourceSetName, 240),
    cleanText(input.watchlistName, 240),
    cleanText(input.watchlistRunId, 160),
    symbolRows.length,
    lookbackBars,
    expectedAsOfDate,
    JSON.stringify(provider),
    JSON.stringify(coverage),
    JSON.stringify(symbolRows),
    JSON.stringify(warnings),
    status,
    now,
    now,
  ).run();

  const row = await loadPrepRow(env, prepId);
  if (!row) throw new Error("Watchlist review prep was not persisted.");
  return mapPrepRow(row, {
    refreshMs,
    dbReadMs,
    totalMs: Date.now() - startedAt,
    requestedSymbols: symbolRows.length,
    refreshedSymbols: input.refreshIfStale ? toRefresh.length : 0,
    skippedFreshSymbols: Math.max(0, symbolRows.length - (input.refreshIfStale ? toRefresh.length : 0)),
  });
}

export async function loadWatchlistReviewPrep(env: Env, prepId: string): Promise<WatchlistReviewPrepSummary | null> {
  const row = await loadPrepRow(env, prepId);
  return row ? mapPrepRow(row) : null;
}

async function loadOhlcvBars(
  env: Env,
  tickers: string[],
  expectedAsOfDate: string,
  lookbackBars: number,
): Promise<Map<string, WatchlistReviewPrepBarsResponse["symbols"][number]["bars"]>> {
  const byTicker = new Map<string, WatchlistReviewPrepBarsResponse["symbols"][number]["bars"]>();
  const startDate = startDateForLookback(expectedAsOfDate, lookbackBars);
  for (const group of chunk(tickers)) {
    const placeholders = group.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT UPPER(ticker) as ticker, date, o, h, l, c, volume
       FROM daily_bars
       WHERE UPPER(ticker) IN (${placeholders})
         AND date >= ?
         AND date <= ?
       ORDER BY UPPER(ticker) ASC, date ASC`,
    ).bind(...group, startDate, expectedAsOfDate).all<OhlcvRow>();
    for (const row of rows.results ?? []) {
      const ticker = row.ticker.toUpperCase();
      const current = byTicker.get(ticker) ?? [];
      current.push({
        date: row.date,
        o: numberOr(row.o),
        h: numberOr(row.h),
        l: numberOr(row.l),
        c: numberOr(row.c),
        volume: numberOr(row.volume),
      });
      byTicker.set(ticker, current.slice(-lookbackBars));
    }
  }
  return byTicker;
}

export async function loadWatchlistReviewPrepBars(
  env: Env,
  prepId: string,
  options: LoadWatchlistReviewPrepBarsOptions = {},
): Promise<WatchlistReviewPrepBarsResponse | null> {
  const row = await loadPrepRow(env, prepId);
  if (!row) return null;
  const summary = mapPrepRow(row);
  const storedSymbols = parseJson<WatchlistReviewPrepSymbol[]>(row.symbolsJson, []);
  const requested = normalizeSymbols(options.symbols ?? []);
  const requestedSet = requested.length > 0 ? new Set(requested) : null;
  const filtered = requestedSet
    ? storedSymbols.filter((symbol) => requestedSet.has(symbol.ticker))
    : storedSymbols.slice(
      Math.max(0, Math.trunc(options.offset ?? 0)),
      Math.max(0, Math.trunc(options.offset ?? 0)) + Math.max(1, Math.min(250, Math.trunc(options.limit ?? 50))),
    );
  const barsByTicker = await loadOhlcvBars(env, filtered.map((symbol) => symbol.ticker), summary.expectedAsOfDate, summary.lookbackBars);
  const symbolsWithBars = filtered.map((symbol) => ({
    ...symbol,
    bars: barsByTicker.get(symbol.ticker) ?? [],
  }));
  return {
    ...summary,
    symbols: symbolsWithBars,
    missing: filtered.filter((symbol) => symbol.freshness.status === "missing").map((symbol) => symbol.ticker),
    stale: filtered.filter((symbol) => symbol.freshness.status === "stale").map((symbol) => symbol.ticker),
  };
}
