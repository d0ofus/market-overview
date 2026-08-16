import { computeMetrics, isPriceAboveSma, sanitizeBarSeries } from "./metrics";
import { latestUsMarketSessionAsOfDate } from "./market-calendar";
import { getMarketDataDb } from "./market-data-db";
import { getProvider, type QuoteSnapshot } from "./provider";
import { meteredFetch, meteredFetchWithRetry } from "./provider-usage";
import { zonedParts } from "./refresh-timing";
import type { Env, OverviewCurrentProviderStatus as SharedOverviewCurrentProviderStatus } from "./types";

const TV_SCAN_URL = "https://scanner.tradingview.com/america/scan";
const TV_REQUEST_CHUNK_SIZE = 100;
const DB_CHUNK_SIZE = 80;
const CURRENT_REFRESH_OFFSET_MINUTES = 45;
const CURRENT_RETRY_MINUTES = 15;
const CURRENT_REFRESH_BATCH_SIZE = 80;
const CURRENT_REFRESH_LEASE_MS = 4 * 60_000;
const MAX_ALPACA_SNAPSHOT_BATCHES_PER_REFRESH = 4;
const ALPACA_SNAPSHOT_BATCH_SIZE = 80;
const TV_PREFIXES = ["NASDAQ", "NYSE", "AMEX", "CBOE", "INDEX", "TVC"] as const;
const TV_SYMBOL_OVERRIDES: Record<string, string> = {
  VIX: "CBOE:VIX",
};
export const OVERVIEW_REQUIRED_CURRENT_FIELDS = [
  "price",
  "change1d",
  "change1w",
  "change5d",
  "change3m",
  "change6m",
  "ytd",
  "pctFrom52wHigh",
  "above20Sma",
  "above50Sma",
  "above200Sma",
] as const;

export const OVERVIEW_PUBLICATION_ESSENTIAL_FIELDS = ["price", "change1d"] as const;

export const OVERVIEW_CURRENT_COLUMNS = [
  "close",
  "change",
  "Perf.W",
  "Perf.3M",
  "Perf.6M",
  "Perf.YTD",
  "price_52_week_high",
  "SMA20",
  "SMA50",
  "SMA200",
  "time",
  "last_bar_update_time",
  "last-price-update-time",
  "last-price-update-time-intraday",
  "update_time",
  "update_mode",
  "current_session",
  "exchange",
  "type",
] as const;

export type OverviewCurrentProviderStatus = SharedOverviewCurrentProviderStatus;

export type OverviewCurrentDisplayStatus = "fresh" | "stale" | "unavailable" | "retrying";

export type OverviewProviderDiagnostic = {
  status: OverviewCurrentProviderStatus;
  reason: string;
  providerSymbol?: string | null;
  marketTimestamp?: string | null;
};

export type OverviewCurrentData = {
  ticker: string;
  sessionDate: string;
  status: OverviewCurrentDisplayStatus;
  reason: string;
  price: number | null;
  change1d: number | null;
  change1w: number | null;
  change5d: number | null;
  change3m: number | null;
  change6m: number | null;
  ytd: number | null;
  pctFrom52wHigh: number | null;
  above20Sma: boolean | null;
  above50Sma: boolean | null;
  above200Sma: boolean | null;
  quoteSource: string | null;
  performanceSource: string | null;
  smaSource: string | null;
  fieldSources: Record<string, string>;
  providerStatuses: Record<string, OverviewProviderDiagnostic>;
  tradingViewSymbol: string | null;
  tradingViewTime: string | null;
  tradingViewLastBarUpdateTime: string | null;
  tradingViewLastPriceUpdateTime: string | null;
  tradingViewUpdateTime: string | null;
  tradingViewUpdateMode: string | null;
  tradingViewCurrentSession: string | null;
  fetchedAt: string;
};

export type OverviewCurrentRefreshResult = {
  configId: string;
  sessionDate: string;
  requestedTickers: number;
  freshTickers: number;
  unavailableTickers: number;
  status: "completed" | "retrying" | "running";
  nextAttemptAt: string | null;
  rows: OverviewCurrentData[];
};

type OverviewTickerInput = {
  ticker: string;
  exchange: string | null;
  tradingViewSymbol: string | null;
};

type TradingViewResponseRow = {
  s?: string;
  d?: unknown[];
};

export type TradingViewScalarRow = {
  ticker: string;
  providerSymbol: string | null;
  status: OverviewCurrentProviderStatus;
  reason: string;
  price: number | null;
  change1d: number | null;
  change1w: number | null;
  change3m: number | null;
  change6m: number | null;
  ytd: number | null;
  high52w: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  time: string | null;
  lastBarUpdateTime: string | null;
  lastPriceUpdateTime: string | null;
  updateTime: string | null;
  updateMode: string | null;
  currentSession: string | null;
};

export type AlpacaBarMetrics = {
  status: OverviewCurrentProviderStatus;
  reason: string;
  barDate: string | null;
  price: number | null;
  change1d: number | null;
  change1w: number | null;
  change3m: number | null;
  change6m: number | null;
  ytd: number | null;
  pctFrom52wHigh: number | null;
  above20Sma: boolean | null;
  above50Sma: boolean | null;
  above200Sma: boolean | null;
};

let schemaReady = false;

export function isOverviewCurrentV2Enabled(env: Env): boolean {
  return !/^(0|false|off)$/i.test(String(env.OVERVIEW_CURRENT_V2_ENABLED ?? "true").trim());
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toIsoTimestamp(value: unknown): string | null {
  const numeric = asFiniteNumber(value);
  if (numeric != null) {
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const textValue = asText(value);
  if (!textValue) return null;
  const date = new Date(textValue);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function marketDate(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return zonedParts(parsed, "America/New_York").localDate;
}

function sourcePrefixForExchange(exchange: string | null): string | null {
  const normalized = String(exchange ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!normalized) return null;
  if (normalized.includes("NASDAQ")) return "NASDAQ";
  if (normalized === "NYSE" || normalized.includes("NEWYORKSTOCKEXCHANGE")) return "NYSE";
  if (normalized.includes("ARCA") || normalized.includes("AMEX") || normalized.includes("NYSEAMERICAN")) return "AMEX";
  if (normalized.includes("CBOE") || normalized.includes("BATS")) return "CBOE";
  return null;
}

function candidatesForTicker(input: OverviewTickerInput): string[] {
  const preferred = sourcePrefixForExchange(input.exchange);
  const prefixes = preferred ? [preferred] : [...TV_PREFIXES];
  const generated = prefixes.map((prefix) => `${prefix}:${input.ticker}`);
  const stored = String(input.tradingViewSymbol ?? "").trim().toUpperCase();
  return Array.from(new Set(stored ? [stored, ...generated] : generated));
}

function statusFromError(error: unknown): OverviewCurrentProviderStatus {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/\b429\b|rate.?limit|provider budget exceeded/i.test(message)) return "rate-limited";
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|auth/i.test(message)) return "auth-blocked";
  return "provider-error";
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? "Provider request failed.")).slice(0, 500);
}

function isRetryableProviderStatus(status: OverviewCurrentProviderStatus): boolean {
  return status === "stale" || status === "missing" || status === "rate-limited" || status === "provider-error";
}

function booleanDb(value: boolean | null): number | null {
  return value == null ? null : value ? 1 : 0;
}

function dbBoolean(value: number | null | undefined): boolean | null {
  if (value == null) return null;
  return Number(value) === 1;
}

function startDateForHistory(sessionDate: string): string {
  const date = new Date(`${sessionDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 400);
  return date.toISOString().slice(0, 10);
}

export async function ensureOverviewCurrentDataSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  const db = getMarketDataDb(env);
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS alpaca_daily_bars (
       feed TEXT NOT NULL,
       ticker TEXT NOT NULL,
       date TEXT NOT NULL,
       o REAL NOT NULL,
       h REAL NOT NULL,
       l REAL NOT NULL,
       c REAL NOT NULL,
       volume REAL,
       fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (feed, ticker, date)
     ) STRICT, WITHOUT ROWID`,
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS overview_provider_symbols (
       provider_key TEXT NOT NULL,
       ticker TEXT NOT NULL,
       provider_symbol TEXT,
       support_status TEXT NOT NULL,
       reason TEXT,
       checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (provider_key, ticker)
     )`,
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS overview_current_data (
       config_id TEXT NOT NULL,
       session_date TEXT NOT NULL,
       ticker TEXT NOT NULL,
       status TEXT NOT NULL,
       reason TEXT,
       price REAL,
       change_1d REAL,
       change_1w REAL,
       change_5d REAL,
       change_3m REAL,
       change_6m REAL,
       ytd REAL,
       pct_from_52w_high REAL,
       above_20_sma INTEGER,
       above_50_sma INTEGER,
       above_200_sma INTEGER,
       quote_source TEXT,
       performance_source TEXT,
       sma_source TEXT,
       field_sources_json TEXT NOT NULL DEFAULT '{}',
       provider_statuses_json TEXT NOT NULL DEFAULT '{}',
       tradingview_symbol TEXT,
       tradingview_time TEXT,
       tradingview_last_bar_update_time TEXT,
       tradingview_last_price_update_time TEXT,
       tradingview_update_time TEXT,
       tradingview_update_mode TEXT,
       tradingview_current_session TEXT,
       fetched_at TEXT NOT NULL,
       updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (config_id, session_date, ticker)
     )`,
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS overview_current_refresh_jobs (
       config_id TEXT NOT NULL,
       session_date TEXT NOT NULL,
       status TEXT NOT NULL,
       attempt_count INTEGER NOT NULL DEFAULT 0,
       next_attempt_at TEXT,
       requested_tickers INTEGER NOT NULL DEFAULT 0,
       fresh_tickers INTEGER NOT NULL DEFAULT 0,
       unavailable_tickers INTEGER NOT NULL DEFAULT 0,
       last_error TEXT,
       last_error_code TEXT,
       cycle_id TEXT,
       cycle_started_at TEXT,
       cursor_offset INTEGER NOT NULL DEFAULT 0,
       processed_tickers INTEGER NOT NULL DEFAULT 0,
       lease_token TEXT,
       lease_expires_at TEXT,
       started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
       completed_at TEXT,
       PRIMARY KEY (config_id, session_date)
     )`,
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS overview_provider_catalog_cache (
       provider_key TEXT NOT NULL,
       catalog_date TEXT NOT NULL,
       symbols_json TEXT NOT NULL,
       fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (provider_key, catalog_date)
     )`,
  ).run();
  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_overview_current_data_session_status ON overview_current_data (config_id, session_date, status)",
  ).run();
  schemaReady = true;
}

export function buildTradingViewOverviewPayload(symbols: string[]): Record<string, unknown> {
  return {
    markets: ["america"],
    symbols: {
      query: { types: [] },
      tickers: symbols,
    },
    options: { lang: "en" },
    columns: [...OVERVIEW_CURRENT_COLUMNS],
    range: [0, symbols.length],
  };
}

export function parseTradingViewOverviewRow(
  ticker: string,
  providerSymbol: string,
  data: unknown[],
  expectedSessionDate: string,
  observedAt = new Date(),
): TradingViewScalarRow {
  const values = new Map<string, unknown>();
  OVERVIEW_CURRENT_COLUMNS.forEach((column, index) => values.set(column, data[index]));
  const time = toIsoTimestamp(values.get("time"));
  const lastBarUpdateTime = toIsoTimestamp(values.get("last_bar_update_time"));
  const lastPriceUpdateTime = toIsoTimestamp(
    values.get("last-price-update-time") ?? values.get("last-price-update-time-intraday"),
  );
  const updateTime = toIsoTimestamp(values.get("update_time"));
  const proofTimestamp = lastBarUpdateTime ?? time ?? lastPriceUpdateTime;
  const proofDate = marketDate(proofTimestamp);
  const proofTime = proofTimestamp ? Date.parse(proofTimestamp) : Number.NaN;
  const price = asFiniteNumber(values.get("close"));
  let status: OverviewCurrentProviderStatus = "supported";
  let reason = proofDate === expectedSessionDate
    ? `TradingView data is current for ${expectedSessionDate}.`
    : `TradingView data includes a newer ${proofDate} current-session observation; latest completed session is ${expectedSessionDate}.`;
  if (!proofTimestamp) {
    status = "missing";
    reason = "TradingView returned no usable market timestamp.";
  } else if (!proofDate || proofDate < expectedSessionDate) {
    status = "stale";
    reason = `TradingView market timestamp is ${proofDate ?? "invalid"}; expected ${expectedSessionDate}.`;
  } else if (!Number.isFinite(proofTime) || proofTime > observedAt.getTime() + 5 * 60_000) {
    status = "stale";
    reason = "TradingView returned an invalid or future market timestamp.";
  } else if (price == null || price <= 0) {
    status = "missing";
    reason = "TradingView returned no usable close value.";
  }
  return {
    ticker,
    providerSymbol,
    status,
    reason,
    price,
    change1d: asFiniteNumber(values.get("change")),
    change1w: asFiniteNumber(values.get("Perf.W")),
    change3m: asFiniteNumber(values.get("Perf.3M")),
    change6m: asFiniteNumber(values.get("Perf.6M")),
    ytd: asFiniteNumber(values.get("Perf.YTD")),
    high52w: asFiniteNumber(values.get("price_52_week_high")),
    sma20: asFiniteNumber(values.get("SMA20")),
    sma50: asFiniteNumber(values.get("SMA50")),
    sma200: asFiniteNumber(values.get("SMA200")),
    time,
    lastBarUpdateTime,
    lastPriceUpdateTime,
    updateTime,
    updateMode: asText(values.get("update_mode")),
    currentSession: asText(values.get("current_session")),
  };
}

async function loadOverviewTickerInputs(env: Env, configId: string): Promise<OverviewTickerInput[]> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT UPPER(TRIM(di.ticker)) as ticker, s.exchange
     FROM dashboard_items di
     JOIN dashboard_groups dg ON dg.id = di.group_id
     JOIN dashboard_sections ds ON ds.id = dg.section_id
     LEFT JOIN symbols s ON UPPER(s.ticker) = UPPER(di.ticker)
     WHERE ds.config_id = ?
       AND di.enabled = 1
       AND (ds.title LIKE '%Macro%' OR ds.title LIKE '%Equities%')
     ORDER BY ticker`,
  )
    .bind(configId)
    .all<{ ticker: string; exchange: string | null }>();
  const normalized = (rows.results ?? [])
    .map((row) => ({
      ticker: String(row.ticker ?? "").trim().toUpperCase(),
      exchange: row.exchange ?? null,
    }))
    .filter((row) => Boolean(row.ticker));
  const tradingViewSymbols = new Map<string, string>();
  const db = getMarketDataDb(env);
  for (const tickerChunk of chunk(normalized.map((row) => row.ticker), DB_CHUNK_SIZE)) {
    const placeholders = tickerChunk.map(() => "?").join(",");
    const mappings = await db.prepare(
      `SELECT ticker, provider_symbol as providerSymbol
       FROM overview_provider_symbols
       WHERE provider_key = 'tradingview'
         AND support_status = 'supported'
         AND ticker IN (${placeholders})`,
    ).bind(...tickerChunk).all<{ ticker: string; providerSymbol: string | null }>();
    for (const mapping of mappings.results ?? []) {
      if (mapping.providerSymbol) tradingViewSymbols.set(mapping.ticker.toUpperCase(), mapping.providerSymbol);
    }
  }
  return normalized.map((row) => ({
    ...row,
    tradingViewSymbol: tradingViewSymbols.get(row.ticker) ?? TV_SYMBOL_OVERRIDES[row.ticker] ?? null,
  }));
}

async function fetchTradingViewRows(
  env: Env,
  inputs: OverviewTickerInput[],
  expectedSessionDate: string,
  observedAt: Date,
): Promise<Map<string, TradingViewScalarRow>> {
  const enabled = !/^(0|false|off)$/i.test(String(env.OVERVIEW_TRADINGVIEW_SCANNER_ENABLED ?? "true").trim());
  if (!enabled) {
    return new Map(inputs.map((input) => [input.ticker, {
      ticker: input.ticker,
      providerSymbol: input.tradingViewSymbol,
      status: "unsupported" as const,
      reason: "TradingView overview scanner is disabled by configuration.",
      price: null,
      change1d: null,
      change1w: null,
      change3m: null,
      change6m: null,
      ytd: null,
      high52w: null,
      sma20: null,
      sma50: null,
      sma200: null,
      time: null,
      lastBarUpdateTime: null,
      lastPriceUpdateTime: null,
      updateTime: null,
      updateMode: null,
      currentSession: null,
    }]));
  }
  const candidatesByTicker = new Map(inputs.map((input) => [input.ticker, candidatesForTicker(input)]));
  const tickerByCandidate = new Map<string, string>();
  for (const [ticker, candidates] of candidatesByTicker.entries()) {
    for (const candidate of candidates) tickerByCandidate.set(candidate, ticker);
  }
  const responseRows = new Map<string, TradingViewResponseRow>();
  const requestErrors = new Map<string, OverviewProviderDiagnostic>();
  let terminalRequestError: OverviewProviderDiagnostic | null = null;
  const candidateChunks = chunk(Array.from(tickerByCandidate.keys()), TV_REQUEST_CHUNK_SIZE);

  for (const candidateChunk of candidateChunks) {
    try {
      const response = await meteredFetchWithRetry(env, TV_SCAN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "market-command-centre/1.0",
        },
        body: JSON.stringify(buildTradingViewOverviewPayload(candidateChunk)),
      }, {
        providerKey: "tradingview",
        endpointKey: "overview-current",
        caller: "overview-current",
        symbolCount: candidateChunk.length,
      }, 8_000);
      if (!response.ok) {
        const body = await response.text();
        const retryAfter = response.headers.get("Retry-After");
        throw new Error(
          `TradingView overview request failed (${response.status})${retryAfter ? `; retry-after=${retryAfter}` : ""}: ${body.slice(0, 180)}`,
        );
      }
      const body = await response.json() as { data?: TradingViewResponseRow[] };
      if (!Array.isArray(body.data)) throw new Error("TradingView overview response is missing its data array.");
      if (candidateChunk.length > 0 && body.data.length === 0) {
        throw new Error("TradingView overview response returned zero rows for a non-empty symbol request.");
      }
      for (const row of body.data) {
        if (typeof row.s !== "string" || !Array.isArray(row.d)) continue;
        if (row.d.length !== OVERVIEW_CURRENT_COLUMNS.length) {
          const ticker = tickerByCandidate.get(row.s.toUpperCase());
          if (ticker) {
            requestErrors.set(ticker, {
              status: "provider-error",
              reason: `TradingView overview row shape changed: expected ${OVERVIEW_CURRENT_COLUMNS.length} fields, received ${row.d.length}.`,
              providerSymbol: row.s,
            });
          }
          continue;
        }
        responseRows.set(row.s.toUpperCase(), row);
      }
    } catch (error) {
      const status = statusFromError(error);
      const reason = errorMessage(error);
      for (const candidate of candidateChunk) {
        const ticker = tickerByCandidate.get(candidate);
        if (ticker && !requestErrors.has(ticker)) requestErrors.set(ticker, { status, reason });
      }
      if (status === "rate-limited" || status === "auth-blocked") {
        terminalRequestError = { status, reason };
        break;
      }
    }
  }

  const out = new Map<string, TradingViewScalarRow>();
  for (const input of inputs) {
    const candidates = candidatesByTicker.get(input.ticker) ?? [];
    let matches = candidates
      .map((candidate) => responseRows.get(candidate.toUpperCase()))
      .filter((row): row is TradingViewResponseRow & { s: string; d: unknown[] } => Boolean(row?.s && Array.isArray(row.d)));
    const storedSymbol = String(input.tradingViewSymbol ?? "").trim().toUpperCase();
    const storedMatch = storedSymbol ? responseRows.get(storedSymbol) : null;
    if (storedMatch?.s && Array.isArray(storedMatch.d)) {
      matches = [storedMatch as TradingViewResponseRow & { s: string; d: unknown[] }];
    }
    if (matches.length > 1) {
      out.set(input.ticker, {
        ticker: input.ticker,
        providerSymbol: null,
        status: "provider-error",
        reason: `TradingView symbol resolution is ambiguous: ${matches.map((row) => row.s).join(", ")}.`,
        price: null,
        change1d: null,
        change1w: null,
        change3m: null,
        change6m: null,
        ytd: null,
        high52w: null,
        sma20: null,
        sma50: null,
        sma200: null,
        time: null,
        lastBarUpdateTime: null,
        lastPriceUpdateTime: null,
        updateTime: null,
        updateMode: null,
        currentSession: null,
      });
      continue;
    }
    if (matches.length === 1) {
      out.set(input.ticker, parseTradingViewOverviewRow(
        input.ticker,
        matches[0].s,
        matches[0].d,
        expectedSessionDate,
        observedAt,
      ));
      continue;
    }
    const requestError = requestErrors.get(input.ticker) ?? terminalRequestError;
    out.set(input.ticker, {
      ticker: input.ticker,
      providerSymbol: null,
      status: requestError?.status ?? "unsupported",
      reason: requestError?.reason ?? `${input.ticker} was not found in the TradingView America scanner.`,
      price: null,
      change1d: null,
      change1w: null,
      change3m: null,
      change6m: null,
      ytd: null,
      high52w: null,
      sma20: null,
      sma50: null,
      sma200: null,
      time: null,
      lastBarUpdateTime: null,
      lastPriceUpdateTime: null,
      updateTime: null,
      updateMode: null,
      currentSession: null,
    });
  }
  return out;
}

function quoteSnapshotMarketTimestamp(snapshot: QuoteSnapshot): string | null {
  return snapshot.tradeTimestamp ?? snapshot.dailyBarTimestamp ?? null;
}

function exactSessionAlpacaSnapshot(
  snapshot: QuoteSnapshot,
  expectedSessionDate: string,
): QuoteSnapshot | null {
  if (
    snapshot.dailyBarTimestamp
    && marketDate(snapshot.dailyBarTimestamp) === expectedSessionDate
    && typeof snapshot.dailyBarPrice === "number"
    && Number.isFinite(snapshot.dailyBarPrice)
    && snapshot.prevClose > 0
  ) {
    return {
      ...snapshot,
      price: snapshot.dailyBarPrice,
      change1d: ((snapshot.dailyBarPrice - snapshot.prevClose) / snapshot.prevClose) * 100,
      tradeTimestamp: null,
    };
  }
  if (
    snapshot.tradeTimestamp
    && marketDate(snapshot.tradeTimestamp) === expectedSessionDate
    && typeof snapshot.tradePrice === "number"
    && Number.isFinite(snapshot.tradePrice)
  ) {
    return { ...snapshot, price: snapshot.tradePrice };
  }
  return null;
}

async function syncAlpacaAssetSupport(
  env: Env,
  tickers: string[],
): Promise<Map<string, OverviewProviderDiagnostic>> {
  const db = getMarketDataDb(env);
  const diagnostics = new Map<string, OverviewProviderDiagnostic>();
  if ((env.DATA_PROVIDER ?? "alpaca").trim().toLowerCase() !== "alpaca") {
    for (const ticker of tickers) {
      diagnostics.set(ticker, {
        status: "unsupported",
        reason: "Alpaca is not the configured market-data provider.",
        providerSymbol: null,
      });
    }
    return diagnostics;
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const tickerChunk of chunk(tickers, DB_CHUNK_SIZE)) {
    const placeholders = tickerChunk.map(() => "?").join(",");
    const cached = await db.prepare(
      `SELECT ticker, support_status as supportStatus, reason
       FROM overview_provider_symbols
       WHERE provider_key = 'alpaca'
         AND ticker IN (${placeholders})
         AND substr(checked_at, 1, 10) = ?`,
    ).bind(...tickerChunk, today).all<{ ticker: string; supportStatus: OverviewCurrentProviderStatus; reason: string | null }>();
    for (const row of cached.results ?? []) {
      diagnostics.set(row.ticker.toUpperCase(), {
        status: row.supportStatus,
        reason: row.reason ?? `Alpaca asset status is ${row.supportStatus}.`,
        providerSymbol: row.ticker.toUpperCase(),
      });
    }
  }
  if (diagnostics.size === tickers.length) return diagnostics;

  try {
    const storedCatalog = await db.prepare(
      `SELECT symbols_json as symbolsJson
       FROM overview_provider_catalog_cache
       WHERE provider_key = 'alpaca' AND catalog_date = ?
       LIMIT 1`,
    ).bind(today).first<{ symbolsJson: string }>();
    let activeSymbols: Set<string> | null = null;
    if (storedCatalog?.symbolsJson) {
      try {
        const parsed = JSON.parse(storedCatalog.symbolsJson) as unknown;
        if (Array.isArray(parsed)) {
          activeSymbols = new Set(parsed.map((value) => String(value).trim().toUpperCase()).filter(Boolean));
        }
      } catch {
        activeSymbols = null;
      }
    }
    if (!activeSymbols) {
      const baseUrl = (env.ALPACA_TRADING_BASE_URL ?? "https://paper-api.alpaca.markets").replace(/\/$/, "");
      const response = await meteredFetch(env, `${baseUrl}/v2/assets?status=active&asset_class=us_equity`, {
        headers: {
          "APCA-API-KEY-ID": env.ALPACA_API_KEY ?? "",
          "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET ?? "",
          "User-Agent": "market-command-centre/1.0",
        },
      }, {
        providerKey: "alpaca",
        endpointKey: "active-assets",
        caller: "overview-current",
        symbolCount: tickers.length,
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Alpaca asset catalog failed (${response.status}): ${body.slice(0, 180)}`);
      }
      const assets = await response.json() as Array<{ symbol?: string; tradable?: boolean; status?: string }>;
      if (!Array.isArray(assets)) throw new Error("Alpaca asset catalog returned an invalid response.");
      activeSymbols = new Set(assets
        .filter((asset) => asset.status === "active" && asset.tradable !== false)
        .map((asset) => String(asset.symbol ?? "").trim().toUpperCase())
        .filter(Boolean));
      await db.prepare(
        `INSERT INTO overview_provider_catalog_cache (provider_key, catalog_date, symbols_json, fetched_at)
         VALUES ('alpaca', ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(provider_key, catalog_date) DO UPDATE SET
           symbols_json = excluded.symbols_json,
           fetched_at = CURRENT_TIMESTAMP`,
      ).bind(today, JSON.stringify(Array.from(activeSymbols).sort())).run();
    }
    const statements = tickers.map((ticker) => {
      const supported = activeSymbols?.has(ticker) === true;
      const diagnostic: OverviewProviderDiagnostic = {
        status: supported ? "supported" : "unsupported",
        reason: supported
          ? `${ticker} is present in Alpaca's active US-equity asset catalog.`
          : `${ticker} is not present in Alpaca's active US-equity asset catalog.`,
        providerSymbol: supported ? ticker : null,
      };
      diagnostics.set(ticker, diagnostic);
      return db.prepare(
        `INSERT INTO overview_provider_symbols (provider_key, ticker, provider_symbol, support_status, reason, checked_at)
         VALUES ('alpaca', ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(provider_key, ticker) DO UPDATE SET
           provider_symbol = excluded.provider_symbol,
           support_status = excluded.support_status,
           reason = excluded.reason,
           checked_at = CURRENT_TIMESTAMP`,
      ).bind(ticker, supported ? ticker : null, diagnostic.status, diagnostic.reason);
    });
    for (const statementChunk of chunk(statements, 100)) await db.batch(statementChunk);
  } catch (error) {
    const diagnostic = { status: statusFromError(error), reason: errorMessage(error) } satisfies OverviewProviderDiagnostic;
    for (const ticker of tickers) {
      if (!diagnostics.has(ticker)) diagnostics.set(ticker, diagnostic);
    }
  }
  return diagnostics;
}

async function fetchAlpacaSnapshots(
  env: Env,
  tickers: string[],
  expectedSessionDate: string,
): Promise<{ snapshots: Record<string, QuoteSnapshot>; diagnostic: OverviewProviderDiagnostic | null }> {
  if (tickers.length === 0) return { snapshots: {}, diagnostic: null };
  if ((env.DATA_PROVIDER ?? "alpaca").trim().toLowerCase() !== "alpaca") {
    return {
      snapshots: {},
      diagnostic: { status: "unsupported", reason: "Alpaca is not the configured market-data provider." },
    };
  }
  try {
    const provider = getProvider(env, { fallbackEnabled: false });
    if (!provider.getQuoteSnapshot) {
      return { snapshots: {}, diagnostic: { status: "unsupported", reason: "Alpaca snapshot support is unavailable." } };
    }
    const snapshots = await provider.getQuoteSnapshot(tickers);
    for (const [ticker, snapshot] of Object.entries(snapshots)) {
      const exactSession = exactSessionAlpacaSnapshot(snapshot, expectedSessionDate);
      if (exactSession) snapshots[ticker] = exactSession;
      else delete snapshots[ticker];
    }
    return { snapshots, diagnostic: null };
  } catch (error) {
    return { snapshots: {}, diagnostic: { status: statusFromError(error), reason: errorMessage(error) } };
  }
}

async function loadAlpacaBarMetrics(
  env: Env,
  tickers: string[],
  expectedSessionDate: string,
  alpacaFeed: string,
): Promise<Map<string, AlpacaBarMetrics>> {
  const db = getMarketDataDb(env);
  const rowsByTicker = new Map<string, { dates: string[]; closes: number[]; sourceProvider: string | null; sourceFeed: string | null }>();
  const startDate = startDateForHistory(expectedSessionDate);
  for (const tickerChunk of chunk(tickers, DB_CHUNK_SIZE)) {
    const placeholders = tickerChunk.map(() => "?").join(",");
    const rows = await db.prepare(
      `SELECT ticker, date, c
       FROM alpaca_daily_bars
       WHERE feed = ?
         AND ticker IN (${placeholders})
         AND date BETWEEN ? AND ?
       ORDER BY ticker, date`,
    )
      .bind(alpacaFeed, ...tickerChunk, startDate, expectedSessionDate)
      .all<{ ticker: string; date: string; c: number }>();
    for (const row of rows.results ?? []) {
      const ticker = row.ticker.toUpperCase();
      const existing = rowsByTicker.get(ticker) ?? { dates: [], closes: [], sourceProvider: null, sourceFeed: null };
      existing.dates.push(row.date);
      existing.closes.push(Number(row.c));
      if (row.date === expectedSessionDate) {
        existing.sourceProvider = "alpaca";
        existing.sourceFeed = alpacaFeed;
      }
      rowsByTicker.set(ticker, existing);
    }
  }

  const result = new Map<string, AlpacaBarMetrics>();
  for (const ticker of tickers) {
    const series = rowsByTicker.get(ticker);
    const cleaned = sanitizeBarSeries(series?.dates ?? [], series?.closes ?? []);
    const barDate = cleaned.dates.at(-1) ?? null;
    const sourceIsAlpaca = series?.sourceProvider === "alpaca";
    if (!barDate) {
      result.set(ticker, {
        status: "missing",
        reason: `No stored Alpaca daily bar is available for ${ticker}.`,
        barDate: null,
        price: null,
        change1d: null,
        change1w: null,
        change3m: null,
        change6m: null,
        ytd: null,
        pctFrom52wHigh: null,
        above20Sma: null,
        above50Sma: null,
        above200Sma: null,
      });
      continue;
    }
    if (barDate !== expectedSessionDate || !sourceIsAlpaca) {
      result.set(ticker, {
        status: "stale",
        reason: barDate !== expectedSessionDate
          ? `Latest stored bar is ${barDate}; expected ${expectedSessionDate}.`
          : "The current stored bar has no verified Alpaca provenance.",
        barDate,
        price: null,
        change1d: null,
        change1w: null,
        change3m: null,
        change6m: null,
        ytd: null,
        pctFrom52wHigh: null,
        above20Sma: null,
        above50Sma: null,
        above200Sma: null,
      });
      continue;
    }
    const metrics = computeMetrics(cleaned.dates, cleaned.closes);
    result.set(ticker, {
      status: "supported",
      reason: `Stored Alpaca ${series?.sourceFeed ?? "configured"} bar is current for ${expectedSessionDate}.`,
      barDate,
      price: metrics.price,
      change1d: metrics.change1d,
      change1w: metrics.change1w,
      change3m: metrics.change3m,
      change6m: metrics.change6m,
      ytd: metrics.ytd,
      pctFrom52wHigh: metrics.pctFrom52wHigh,
      above20Sma: isPriceAboveSma(cleaned.closes, 20),
      above50Sma: isPriceAboveSma(cleaned.closes, 50),
      above200Sma: isPriceAboveSma(cleaned.closes, 200),
    });
  }
  return result;
}

function pickNumber(
  field: string,
  fieldSources: Record<string, string>,
  candidates: Array<{ value: number | null; source: string }>,
): number | null {
  for (const candidate of candidates) {
    if (candidate.value == null || !Number.isFinite(candidate.value)) continue;
    fieldSources[field] = candidate.source;
    return candidate.value;
  }
  return null;
}

function pickBoolean(
  field: string,
  fieldSources: Record<string, string>,
  candidates: Array<{ value: boolean | null; source: string }>,
): boolean | null {
  for (const candidate of candidates) {
    if (candidate.value == null) continue;
    fieldSources[field] = candidate.source;
    return candidate.value;
  }
  return null;
}

export function resolveOverviewCurrentRow(input: {
  ticker: string;
  sessionDate: string;
  tv: TradingViewScalarRow;
  alpacaSnapshot: QuoteSnapshot | null;
  alpacaSnapshotDiagnostic: OverviewProviderDiagnostic | null;
  alpacaAssetDiagnostic: OverviewProviderDiagnostic | null;
  bars: AlpacaBarMetrics;
  alpacaFeed: string;
  fetchedAt: string;
}): OverviewCurrentData {
  const tvFresh = input.tv.status === "supported";
  const barFresh = input.bars.status === "supported";
  const snapshot = input.alpacaSnapshot;
  const tvSource = "tradingview-scanner";
  const snapshotSource = `alpaca:${input.alpacaFeed}-snapshot`;
  const barSource = `alpaca:${input.alpacaFeed}-bars`;
  const fieldSources: Record<string, string> = {};
  const price = pickNumber("price", fieldSources, [
    { value: tvFresh ? input.tv.price : null, source: tvSource },
    { value: snapshot?.price ?? null, source: snapshotSource },
    { value: barFresh ? input.bars.price : null, source: barSource },
  ]);
  const change1d = pickNumber("change1d", fieldSources, [
    { value: tvFresh ? input.tv.change1d : null, source: tvSource },
    { value: snapshot?.change1d ?? null, source: snapshotSource },
    { value: barFresh ? input.bars.change1d : null, source: barSource },
  ]);
  const change1w = pickNumber("change1w", fieldSources, [
    { value: tvFresh ? input.tv.change1w : null, source: tvSource },
    { value: barFresh ? input.bars.change1w : null, source: barSource },
  ]);
  if (fieldSources.change1w) fieldSources.change5d = fieldSources.change1w;
  const change3m = pickNumber("change3m", fieldSources, [
    { value: tvFresh ? input.tv.change3m : null, source: tvSource },
    { value: barFresh ? input.bars.change3m : null, source: barSource },
  ]);
  const change6m = pickNumber("change6m", fieldSources, [
    { value: tvFresh ? input.tv.change6m : null, source: tvSource },
    { value: barFresh ? input.bars.change6m : null, source: barSource },
  ]);
  const ytd = pickNumber("ytd", fieldSources, [
    { value: tvFresh ? input.tv.ytd : null, source: tvSource },
    { value: barFresh ? input.bars.ytd : null, source: barSource },
  ]);
  const tvPctFromHigh = tvFresh && input.tv.price != null && input.tv.high52w != null && input.tv.high52w > 0
    ? ((input.tv.price - input.tv.high52w) / input.tv.high52w) * 100
    : null;
  const pctFrom52wHigh = pickNumber("pctFrom52wHigh", fieldSources, [
    { value: tvPctFromHigh, source: tvSource },
    { value: barFresh ? input.bars.pctFrom52wHigh : null, source: barSource },
  ]);
  const above20Sma = pickBoolean("above20Sma", fieldSources, [
    { value: tvFresh && input.tv.price != null && input.tv.sma20 != null ? input.tv.price > input.tv.sma20 : null, source: tvSource },
    { value: barFresh ? input.bars.above20Sma : null, source: barSource },
  ]);
  const above50Sma = pickBoolean("above50Sma", fieldSources, [
    { value: tvFresh && input.tv.price != null && input.tv.sma50 != null ? input.tv.price > input.tv.sma50 : null, source: tvSource },
    { value: barFresh ? input.bars.above50Sma : null, source: barSource },
  ]);
  const above200Sma = pickBoolean("above200Sma", fieldSources, [
    { value: tvFresh && input.tv.price != null && input.tv.sma200 != null ? input.tv.price > input.tv.sma200 : null, source: tvSource },
    { value: barFresh ? input.bars.above200Sma : null, source: barSource },
  ]);
  const providerStatuses: Record<string, OverviewProviderDiagnostic> = {
    tradingview: {
      status: input.tv.status,
      reason: input.tv.reason,
      providerSymbol: input.tv.providerSymbol,
      marketTimestamp: input.tv.lastBarUpdateTime ?? input.tv.time ?? input.tv.lastPriceUpdateTime,
    },
    alpacaBars: {
      status: input.bars.status,
      reason: input.bars.reason,
      marketTimestamp: input.bars.barDate,
    },
  };
  if (input.alpacaAssetDiagnostic) providerStatuses.alpacaAsset = input.alpacaAssetDiagnostic;
  if (snapshot) {
    providerStatuses.alpacaSnapshot = {
      status: "supported",
      reason: `Alpaca snapshot is current for ${input.sessionDate}.`,
      marketTimestamp: quoteSnapshotMarketTimestamp(snapshot),
    };
  } else if (input.alpacaSnapshotDiagnostic) {
    providerStatuses.alpacaSnapshot = input.alpacaSnapshotDiagnostic;
  } else {
    providerStatuses.alpacaSnapshot = {
      status: "missing",
      reason: "No current Alpaca snapshot was returned.",
    };
  }
  const alpacaPermanentlyBlocked = input.alpacaAssetDiagnostic?.status === "unsupported"
    || input.alpacaAssetDiagnostic?.status === "auth-blocked";
  const transient = isRetryableProviderStatus(input.tv.status)
    || (!alpacaPermanentlyBlocked && (
      isRetryableProviderStatus(input.bars.status)
      || isRetryableProviderStatus(providerStatuses.alpacaSnapshot.status)
      || isRetryableProviderStatus(input.alpacaAssetDiagnostic?.status ?? "missing")
    ));
  const status: OverviewCurrentDisplayStatus = price != null && change1d != null
    ? "fresh"
    : transient
      ? "retrying"
      : "unavailable";
  const reason = status === "fresh"
    ? `Current-session values resolved for ${input.sessionDate}.`
    : `No current-session price and 1D pair is available for ${input.ticker}.`;
  return {
    ticker: input.ticker,
    sessionDate: input.sessionDate,
    status,
    reason,
    price,
    change1d,
    change1w,
    change5d: change1w,
    change3m,
    change6m,
    ytd,
    pctFrom52wHigh,
    above20Sma,
    above50Sma,
    above200Sma,
    quoteSource: fieldSources.price ?? fieldSources.change1d ?? null,
    performanceSource: fieldSources.change1w ?? fieldSources.ytd ?? null,
    smaSource: fieldSources.above20Sma ?? fieldSources.above50Sma ?? fieldSources.above200Sma ?? null,
    fieldSources,
    providerStatuses,
    tradingViewSymbol: input.tv.providerSymbol,
    tradingViewTime: input.tv.time,
    tradingViewLastBarUpdateTime: input.tv.lastBarUpdateTime,
    tradingViewLastPriceUpdateTime: input.tv.lastPriceUpdateTime,
    tradingViewUpdateTime: input.tv.updateTime,
    tradingViewUpdateMode: input.tv.updateMode,
    tradingViewCurrentSession: input.tv.currentSession,
    fetchedAt: input.fetchedAt,
  };
}

export function isOverviewCurrentRowComplete(row: OverviewCurrentData): boolean {
  return OVERVIEW_REQUIRED_CURRENT_FIELDS.every((field) => Boolean(row.fieldSources[field]));
}

export function planOverviewCurrentRefreshSlice(totalTickers: number, cursorOffset: number): {
  start: number;
  end: number;
  completeAfterSlice: boolean;
} {
  const total = Math.max(0, Math.trunc(totalTickers));
  const start = Math.min(total, Math.max(0, Math.trunc(cursorOffset)));
  const end = Math.min(total, start + CURRENT_REFRESH_BATCH_SIZE);
  return { start, end, completeAfterSlice: end >= total };
}

export function isOverviewCurrentRowPublishable(
  row: OverviewCurrentData,
  now?: Date,
  maxAgeMs = 20 * 60_000,
): boolean {
  const fetchedAt = Date.parse(row.fetchedAt);
  const recentlyFetched = !now || (Number.isFinite(fetchedAt) && now.getTime() - fetchedAt <= maxAgeMs);
  return recentlyFetched
    && row.status === "fresh"
    && OVERVIEW_PUBLICATION_ESSENTIAL_FIELDS.every((field) => Boolean(row.fieldSources[field]))
    && typeof row.price === "number"
    && Number.isFinite(row.price)
    && typeof row.change1d === "number"
    && Number.isFinite(row.change1d);
}

export function isOverviewCurrentRowPublishableForCycle(
  row: OverviewCurrentData,
  cycleStartedAt: string,
): boolean {
  const fetchedAt = Date.parse(row.fetchedAt);
  const cycleStartedAtMs = Date.parse(cycleStartedAt);
  return Number.isFinite(fetchedAt)
    && Number.isFinite(cycleStartedAtMs)
    && fetchedAt >= cycleStartedAtMs
    && isOverviewCurrentRowPublishable(row);
}

export function isOverviewCurrentRowStructurallyUnsupported(row: OverviewCurrentData | null | undefined): boolean {
  if (!row) return false;
  return row.providerStatuses.tradingview?.status === "unsupported"
    && row.providerStatuses.alpacaAsset?.status === "unsupported";
}

export function doesOverviewCurrentRowNeedRepair(row: OverviewCurrentData): boolean {
  if (row.status === "retrying") return true;
  if (row.status === "unavailable" || isOverviewCurrentRowComplete(row)) return false;
  const tradingView = row.providerStatuses.tradingview;
  const alpacaBars = row.providerStatuses.alpacaBars;
  const retryableStatuses = new Set<OverviewCurrentProviderStatus>([
    "stale",
    "missing",
    "rate-limited",
    "provider-error",
  ]);
  return Boolean(
    (tradingView?.status && retryableStatuses.has(tradingView.status))
    || (alpacaBars?.status && retryableStatuses.has(alpacaBars.status)),
  );
}

function retryAfterFromReason(reason: string, nowMs: number): string | null {
  const secondsMatch = reason.match(/retry-after=(\d+(?:\.\d+)?)/i);
  if (secondsMatch) {
    const seconds = Number(secondsMatch[1]);
    if (Number.isFinite(seconds) && seconds >= 0) return new Date(nowMs + seconds * 1000).toISOString();
  }
  const httpDateMatch = reason.match(/retry-after=([^;]*?GMT)/i);
  if (httpDateMatch) {
    const parsed = Date.parse(httpDateMatch[1].trim());
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function nextCurrentRetryAt(rows: OverviewCurrentData[], nowMs = Date.now()): string {
  const providerRetryTimes = rows
    .flatMap((row) => Object.values(row.providerStatuses))
    .map((diagnostic) => retryAfterFromReason(diagnostic.reason, nowMs))
    .filter((value): value is string => Boolean(value))
    .sort();
  return providerRetryTimes[0] ?? new Date(nowMs + CURRENT_RETRY_MINUTES * 60_000).toISOString();
}

async function persistCurrentRows(env: Env, configId: string, rows: OverviewCurrentData[]): Promise<void> {
  const db = getMarketDataDb(env);
  const statements = rows.map((row) => db.prepare(
    `INSERT INTO overview_current_data (
       config_id, session_date, ticker, status, reason, price, change_1d, change_1w, change_5d,
       change_3m, change_6m, ytd, pct_from_52w_high, above_20_sma, above_50_sma, above_200_sma,
       quote_source, performance_source, sma_source, field_sources_json, provider_statuses_json,
       tradingview_symbol, tradingview_time, tradingview_last_bar_update_time,
       tradingview_last_price_update_time, tradingview_update_time, tradingview_update_mode,
       tradingview_current_session, fetched_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(config_id, session_date, ticker) DO UPDATE SET
       status = excluded.status,
       reason = excluded.reason,
       price = excluded.price,
       change_1d = excluded.change_1d,
       change_1w = excluded.change_1w,
       change_5d = excluded.change_5d,
       change_3m = excluded.change_3m,
       change_6m = excluded.change_6m,
       ytd = excluded.ytd,
       pct_from_52w_high = excluded.pct_from_52w_high,
       above_20_sma = excluded.above_20_sma,
       above_50_sma = excluded.above_50_sma,
       above_200_sma = excluded.above_200_sma,
       quote_source = excluded.quote_source,
       performance_source = excluded.performance_source,
       sma_source = excluded.sma_source,
       field_sources_json = excluded.field_sources_json,
       provider_statuses_json = excluded.provider_statuses_json,
       tradingview_symbol = excluded.tradingview_symbol,
       tradingview_time = excluded.tradingview_time,
       tradingview_last_bar_update_time = excluded.tradingview_last_bar_update_time,
       tradingview_last_price_update_time = excluded.tradingview_last_price_update_time,
       tradingview_update_time = excluded.tradingview_update_time,
       tradingview_update_mode = excluded.tradingview_update_mode,
       tradingview_current_session = excluded.tradingview_current_session,
       fetched_at = excluded.fetched_at,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(
    configId,
    row.sessionDate,
    row.ticker,
    row.status,
    row.reason,
    row.price,
    row.change1d,
    row.change1w,
    row.change5d,
    row.change3m,
    row.change6m,
    row.ytd,
    row.pctFrom52wHigh,
    booleanDb(row.above20Sma),
    booleanDb(row.above50Sma),
    booleanDb(row.above200Sma),
    row.quoteSource,
    row.performanceSource,
    row.smaSource,
    JSON.stringify(row.fieldSources),
    JSON.stringify(row.providerStatuses),
    row.tradingViewSymbol,
    row.tradingViewTime,
    row.tradingViewLastBarUpdateTime,
    row.tradingViewLastPriceUpdateTime,
    row.tradingViewUpdateTime,
    row.tradingViewUpdateMode,
    row.tradingViewCurrentSession,
    row.fetchedAt,
  ));
  for (const statementChunk of chunk(statements, 100)) await db.batch(statementChunk);

  const symbolStatements = rows.map((row) => {
    const diagnostic = row.providerStatuses.tradingview;
    return db.prepare(
      `INSERT INTO overview_provider_symbols (provider_key, ticker, provider_symbol, support_status, reason, checked_at)
       VALUES ('tradingview', ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(provider_key, ticker) DO UPDATE SET
         provider_symbol = excluded.provider_symbol,
         support_status = excluded.support_status,
         reason = excluded.reason,
         checked_at = CURRENT_TIMESTAMP`,
    ).bind(row.ticker, row.tradingViewSymbol, diagnostic?.status ?? "missing", diagnostic?.reason ?? row.reason);
  });
  for (const statementChunk of chunk(symbolStatements, 100)) await db.batch(statementChunk);
}

export type OverviewCurrentRefreshJobState = {
  configId: string;
  sessionDate: string;
  status: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  updatedAt: string | null;
  cycleId: string | null;
  cycleStartedAt: string | null;
  cursorOffset: number;
  processedTickers: number;
  requestedTickers: number;
  freshTickers: number;
  unavailableTickers: number;
  leaseExpiresAt: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
};

export async function loadOverviewCurrentRefreshJob(
  env: Env,
  configId: string,
  sessionDate: string,
): Promise<OverviewCurrentRefreshJobState | null> {
  return await getMarketDataDb(env).prepare(
    `SELECT config_id as configId, session_date as sessionDate,
            status, attempt_count as attemptCount, next_attempt_at as nextAttemptAt,
            updated_at as updatedAt, cycle_id as cycleId, cycle_started_at as cycleStartedAt,
            cursor_offset as cursorOffset, processed_tickers as processedTickers,
            requested_tickers as requestedTickers,
            fresh_tickers as freshTickers, unavailable_tickers as unavailableTickers,
            lease_expires_at as leaseExpiresAt, last_error as lastError,
            last_error_code as lastErrorCode
     FROM overview_current_refresh_jobs
     WHERE config_id = ? AND session_date = ?`,
  ).bind(configId, sessionDate).first<OverviewCurrentRefreshJobState>();
}

export function overviewCurrentRefreshStateAllowsPublication(
  state: Pick<OverviewCurrentRefreshJobState, "status" | "cycleId" | "processedTickers" | "requestedTickers"> | null,
): boolean {
  if (!state?.cycleId) return true;
  if (state.status !== "running" && state.status !== "retrying") return true;
  return Number(state.processedTickers ?? 0) >= Number(state.requestedTickers ?? 0);
}

export async function isOverviewCurrentRefreshPublicationReady(
  env: Env,
  configId: string,
  sessionDate: string,
): Promise<boolean> {
  await ensureOverviewCurrentDataSchema(env);
  return overviewCurrentRefreshStateAllowsPublication(
    await loadOverviewCurrentRefreshJob(env, configId, sessionDate),
  );
}

export async function refreshOverviewCurrentData(
  env: Env,
  configId = "default",
  sessionDate = latestUsMarketSessionAsOfDate(new Date()),
  options: { now?: Date; startNewCycle?: boolean } = {},
): Promise<OverviewCurrentRefreshResult> {
  await ensureOverviewCurrentDataSchema(env);
  const db = getMarketDataDb(env);
  const inputs = await loadOverviewTickerInputs(env, configId);
  const tickers = inputs.map((input) => input.ticker);
  const now = options.now ?? new Date();
  const fetchedAt = now.toISOString();
  const feed = (env.ALPACA_DAILY_FEED ?? env.ALPACA_FEED ?? "iex").trim().toLowerCase() || "iex";
  const previousJob = await loadOverviewCurrentRefreshJob(env, configId, sessionDate);
  const continuingCycle = (previousJob?.status === "running" || previousJob?.status === "retrying")
    && Boolean(previousJob.cycleId)
    && Boolean(previousJob.cycleStartedAt)
    && Number(previousJob.cursorOffset ?? 0) < tickers.length
    && Number(previousJob.processedTickers ?? 0) < tickers.length
    && options.startNewCycle !== true;
  const cycleId = continuingCycle ? previousJob?.cycleId as string : crypto.randomUUID();
  const cycleStartedAt = continuingCycle ? previousJob?.cycleStartedAt as string : fetchedAt;
  const cursorOffset = continuingCycle ? Math.max(0, Number(previousJob?.cursorOffset ?? 0)) : 0;
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + CURRENT_REFRESH_LEASE_MS).toISOString();

  const insertedJob = await db.prepare(
    `INSERT INTO overview_current_refresh_jobs
       (config_id, session_date, status, attempt_count, requested_tickers,
        cycle_id, cycle_started_at, cursor_offset, processed_tickers,
        lease_token, lease_expires_at, started_at, updated_at)
     VALUES (?, ?, 'running', 1, ?, ?, ?, 0, 0, ?, ?, ?, ?)
     ON CONFLICT(config_id, session_date) DO NOTHING`,
  ).bind(
    configId,
    sessionDate,
    tickers.length,
    cycleId,
    cycleStartedAt,
    leaseToken,
    leaseExpiresAt,
    fetchedAt,
    fetchedAt,
  ).run();
  if (!previousJob && Number(insertedJob.meta?.changes ?? 0) === 0) {
    const active = await loadOverviewCurrentRefreshJob(env, configId, sessionDate);
    return {
      configId,
      sessionDate,
      requestedTickers: tickers.length,
      freshTickers: Number(active?.freshTickers ?? 0),
      unavailableTickers: Number(active?.unavailableTickers ?? 0),
      status: "running",
      nextAttemptAt: active?.leaseExpiresAt ?? null,
      rows: [],
    };
  }
  if (previousJob) {
    const claim = continuingCycle
      ? await db.prepare(
        `UPDATE overview_current_refresh_jobs
            SET status = 'running', attempt_count = attempt_count + 1,
                requested_tickers = ?, lease_token = ?, lease_expires_at = ?,
                last_error = NULL, last_error_code = NULL, next_attempt_at = NULL,
                updated_at = ?
          WHERE config_id = ? AND session_date = ?
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      ).bind(tickers.length, leaseToken, leaseExpiresAt, fetchedAt, configId, sessionDate, fetchedAt).run()
      : await db.prepare(
        `UPDATE overview_current_refresh_jobs
            SET status = 'running', attempt_count = attempt_count + 1,
                requested_tickers = ?, fresh_tickers = 0, unavailable_tickers = 0,
                cycle_id = ?, cycle_started_at = ?, cursor_offset = 0, processed_tickers = 0,
                lease_token = ?, lease_expires_at = ?, last_error = NULL,
                last_error_code = NULL, next_attempt_at = NULL, completed_at = NULL,
                started_at = ?, updated_at = ?
          WHERE config_id = ? AND session_date = ?
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      ).bind(
        tickers.length,
        cycleId,
        cycleStartedAt,
        leaseToken,
        leaseExpiresAt,
        fetchedAt,
        fetchedAt,
        configId,
        sessionDate,
        fetchedAt,
      ).run();
    if (Number(claim.meta?.changes ?? 0) === 0) {
      const active = await loadOverviewCurrentRefreshJob(env, configId, sessionDate);
      return {
        configId,
        sessionDate,
        requestedTickers: tickers.length,
        freshTickers: Number(active?.freshTickers ?? 0),
        unavailableTickers: Number(active?.unavailableTickers ?? 0),
        status: "running",
        nextAttemptAt: active?.leaseExpiresAt ?? null,
        rows: [],
      };
    }
  }

  const slicePlan = planOverviewCurrentRefreshSlice(tickers.length, cursorOffset);
  const sliceInputs = inputs.slice(slicePlan.start, slicePlan.end);
  const sliceTickers = sliceInputs.map((input) => input.ticker);
  try {
    const [tvRows, barRows, alpacaAssetSupport] = await Promise.all([
      fetchTradingViewRows(env, sliceInputs, sessionDate, new Date(fetchedAt)),
      loadAlpacaBarMetrics(env, sliceTickers, sessionDate, feed),
      syncAlpacaAssetSupport(env, sliceTickers),
    ]);
    const quoteFallbackTickers = sliceTickers.filter((ticker) => {
      const row = tvRows.get(ticker);
      return row?.status !== "supported" || row.price == null || row.change1d == null;
    });
    const attemptedSnapshotTickers = quoteFallbackTickers.slice(
      0,
      ALPACA_SNAPSHOT_BATCH_SIZE * MAX_ALPACA_SNAPSHOT_BATCHES_PER_REFRESH,
    );
    const attemptedSnapshotTickerSet = new Set(attemptedSnapshotTickers);
    const quoteFallbackTickerSet = new Set(quoteFallbackTickers);
    const alpacaSnapshots = await fetchAlpacaSnapshots(env, attemptedSnapshotTickers, sessionDate);
    const rows = sliceTickers.map((ticker) => resolveOverviewCurrentRow({
    ticker,
    sessionDate,
    tv: tvRows.get(ticker) ?? {
      ticker,
      providerSymbol: null,
      status: "missing",
      reason: "TradingView was not attempted for this ticker.",
      price: null,
      change1d: null,
      change1w: null,
      change3m: null,
      change6m: null,
      ytd: null,
      high52w: null,
      sma20: null,
      sma50: null,
      sma200: null,
      time: null,
      lastBarUpdateTime: null,
      lastPriceUpdateTime: null,
      updateTime: null,
      updateMode: null,
      currentSession: null,
    },
    alpacaSnapshot: alpacaSnapshots.snapshots[ticker] ?? null,
    alpacaSnapshotDiagnostic: alpacaSnapshots.diagnostic
      ?? (alpacaAssetSupport.get(ticker)?.status === "unsupported" ? alpacaAssetSupport.get(ticker) ?? null : null)
      ?? (quoteFallbackTickerSet.has(ticker) && !attemptedSnapshotTickerSet.has(ticker)
        ? {
          status: "missing",
          reason: "Alpaca snapshot refresh is queued for a later bounded batch.",
        }
        : null),
    alpacaAssetDiagnostic: alpacaAssetSupport.get(ticker) ?? null,
    bars: barRows.get(ticker) ?? {
      status: "missing",
      reason: "No Alpaca bar metrics were loaded.",
      barDate: null,
      price: null,
      change1d: null,
      change1w: null,
      change3m: null,
      change6m: null,
      ytd: null,
      pctFrom52wHigh: null,
      above20Sma: null,
      above50Sma: null,
      above200Sma: null,
    },
    alpacaFeed: feed,
    fetchedAt,
    }));
    await persistCurrentRows(env, configId, rows);
    const nextCursor = slicePlan.end;
    const cycleRows = Array.from((await loadOverviewCurrentData(env, configId, sessionDate)).values())
      .filter((row) => row.fetchedAt >= cycleStartedAt);
    const freshTickers = cycleRows.filter((row) => row.status === "fresh").length;
    const unavailableTickers = cycleRows.length - freshTickers;
    if (nextCursor < tickers.length) {
      await db.prepare(
        `UPDATE overview_current_refresh_jobs
            SET status = 'running', cursor_offset = ?, processed_tickers = ?,
                fresh_tickers = ?, unavailable_tickers = ?, next_attempt_at = ?,
                lease_token = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE config_id = ? AND session_date = ? AND lease_token = ?`,
      ).bind(
        nextCursor,
        nextCursor,
        freshTickers,
        unavailableTickers,
        fetchedAt,
        fetchedAt,
        configId,
        sessionDate,
        leaseToken,
      ).run();
      return {
        configId,
        sessionDate,
        requestedTickers: tickers.length,
        freshTickers,
        unavailableTickers,
        status: "running",
        nextAttemptAt: fetchedAt,
        rows,
      };
    }
    const retrying = cycleRows.length < tickers.length || cycleRows.some(doesOverviewCurrentRowNeedRepair);
    const cycleStartedAtMs = Date.parse(cycleStartedAt);
    const nextAttemptAt = retrying
      ? nextCurrentRetryAt(cycleRows, Number.isFinite(cycleStartedAtMs) ? cycleStartedAtMs : now.getTime())
      : null;
    await db.prepare(
      `UPDATE overview_current_refresh_jobs
          SET status = ?, cursor_offset = 0, processed_tickers = ?,
              fresh_tickers = ?, unavailable_tickers = ?, next_attempt_at = ?,
              lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
        WHERE config_id = ? AND session_date = ? AND lease_token = ?`,
    ).bind(
      retrying ? "retrying" : "completed",
      tickers.length,
      freshTickers,
      unavailableTickers,
      nextAttemptAt,
      retrying ? null : fetchedAt,
      fetchedAt,
      configId,
      sessionDate,
      leaseToken,
    ).run();
    return {
      configId,
      sessionDate,
      requestedTickers: tickers.length,
      freshTickers,
      unavailableTickers,
      status: retrying ? "retrying" : "completed",
      nextAttemptAt,
      rows: cycleRows,
    };
  } catch (error) {
    const retryAt = new Date(now.getTime() + CURRENT_RETRY_MINUTES * 60_000).toISOString();
    await db.prepare(
      `UPDATE overview_current_refresh_jobs
          SET status = 'retrying', next_attempt_at = ?, last_error = ?, last_error_code = ?,
              lease_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE config_id = ? AND session_date = ? AND lease_token = ?`,
    ).bind(
      retryAt,
      errorMessage(error),
      statusFromError(error),
      fetchedAt,
      configId,
      sessionDate,
      leaseToken,
    ).run();
    throw error;
  }
}

function parseJsonRecord<T>(value: string | null | undefined): Record<string, T> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, T> : {};
  } catch {
    return {};
  }
}

export async function loadOverviewCurrentData(
  env: Env,
  configId: string,
  sessionDate: string,
): Promise<Map<string, OverviewCurrentData>> {
  const rows = await getMarketDataDb(env).prepare(
    `SELECT ticker, session_date as sessionDate, status, reason, price, change_1d as change1d,
            change_1w as change1w, change_5d as change5d, change_3m as change3m,
            change_6m as change6m, ytd, pct_from_52w_high as pctFrom52wHigh,
            above_20_sma as above20Sma, above_50_sma as above50Sma, above_200_sma as above200Sma,
            quote_source as quoteSource, performance_source as performanceSource, sma_source as smaSource,
            field_sources_json as fieldSourcesJson, provider_statuses_json as providerStatusesJson,
            tradingview_symbol as tradingViewSymbol, tradingview_time as tradingViewTime,
            tradingview_last_bar_update_time as tradingViewLastBarUpdateTime,
            tradingview_last_price_update_time as tradingViewLastPriceUpdateTime,
            tradingview_update_time as tradingViewUpdateTime, tradingview_update_mode as tradingViewUpdateMode,
            tradingview_current_session as tradingViewCurrentSession, fetched_at as fetchedAt
     FROM overview_current_data
     WHERE config_id = ? AND session_date = ?`,
  )
    .bind(configId, sessionDate)
    .all<{
      ticker: string;
      sessionDate: string;
      status: OverviewCurrentDisplayStatus;
      reason: string | null;
      price: number | null;
      change1d: number | null;
      change1w: number | null;
      change5d: number | null;
      change3m: number | null;
      change6m: number | null;
      ytd: number | null;
      pctFrom52wHigh: number | null;
      above20Sma: number | null;
      above50Sma: number | null;
      above200Sma: number | null;
      quoteSource: string | null;
      performanceSource: string | null;
      smaSource: string | null;
      fieldSourcesJson: string | null;
      providerStatusesJson: string | null;
      tradingViewSymbol: string | null;
      tradingViewTime: string | null;
      tradingViewLastBarUpdateTime: string | null;
      tradingViewLastPriceUpdateTime: string | null;
      tradingViewUpdateTime: string | null;
      tradingViewUpdateMode: string | null;
      tradingViewCurrentSession: string | null;
      fetchedAt: string;
    }>();
  return new Map((rows.results ?? []).map((row) => [row.ticker.toUpperCase(), {
    ticker: row.ticker.toUpperCase(),
    sessionDate: row.sessionDate,
    status: row.status,
    reason: row.reason ?? "Current data is unavailable.",
    price: row.price,
    change1d: row.change1d,
    change1w: row.change1w,
    change5d: row.change5d,
    change3m: row.change3m,
    change6m: row.change6m,
    ytd: row.ytd,
    pctFrom52wHigh: row.pctFrom52wHigh,
    above20Sma: dbBoolean(row.above20Sma),
    above50Sma: dbBoolean(row.above50Sma),
    above200Sma: dbBoolean(row.above200Sma),
    quoteSource: row.quoteSource,
    performanceSource: row.performanceSource,
    smaSource: row.smaSource,
    fieldSources: parseJsonRecord<string>(row.fieldSourcesJson),
    providerStatuses: parseJsonRecord<OverviewProviderDiagnostic>(row.providerStatusesJson),
    tradingViewSymbol: row.tradingViewSymbol,
    tradingViewTime: row.tradingViewTime,
    tradingViewLastBarUpdateTime: row.tradingViewLastBarUpdateTime,
    tradingViewLastPriceUpdateTime: row.tradingViewLastPriceUpdateTime,
    tradingViewUpdateTime: row.tradingViewUpdateTime,
    tradingViewUpdateMode: row.tradingViewUpdateMode,
    tradingViewCurrentSession: row.tradingViewCurrentSession,
    fetchedAt: row.fetchedAt,
  }]));
}

export function currentRefreshStartWindowOpen(now: Date): boolean {
  const ny = zonedParts(now, "America/New_York");
  return ny.minutesOfDay >= 4 * 60 && ny.minutesOfDay <= 16 * 60 + CURRENT_REFRESH_OFFSET_MINUTES;
}

/** @deprecated Use currentRefreshStartWindowOpen. */
export const currentRefreshWindowOpen = currentRefreshStartWindowOpen;

export function currentRefreshContinuationAllowed(
  job: OverviewCurrentRefreshJobState | null,
  expectedSession: string,
  now: Date,
): boolean {
  if (!job || job.sessionDate !== expectedSession || !job.cycleId) return false;
  if (job.status !== "running" && job.status !== "retrying") return false;
  if (Number(job.processedTickers ?? 0) >= Number(job.requestedTickers ?? 0)) return false;
  if (job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) > now.getTime()) return false;
  if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > now.getTime()) return false;
  return true;
}

export async function maybeRunScheduledOverviewCurrentRefresh(
  env: Env,
  now = new Date(),
  configId = "default",
): Promise<OverviewCurrentRefreshResult | null> {
  const sessionDate = latestUsMarketSessionAsOfDate(now);
  await ensureOverviewCurrentDataSchema(env);
  const job = await loadOverviewCurrentRefreshJob(env, configId, sessionDate);
  if (!currentRefreshStartWindowOpen(now) && !currentRefreshContinuationAllowed(job, sessionDate, now)) return null;
  return await refreshOverviewCurrentDataIfDue(env, configId, sessionDate, now);
}

export async function refreshOverviewCurrentDataIfDue(
  env: Env,
  configId: string,
  sessionDate: string,
  now = new Date(),
  options: { forceCompleted?: boolean; force?: boolean; maxAgeMs?: number } = {},
): Promise<OverviewCurrentRefreshResult | null> {
  await ensureOverviewCurrentDataSchema(env);
  const job = await loadOverviewCurrentRefreshJob(env, configId, sessionDate);
  const force = options.force === true || options.forceCompleted === true;
  const maxAgeMs = Math.max(60_000, options.maxAgeMs ?? CURRENT_RETRY_MINUTES * 60_000);
  if (job?.status === "completed" && !force && job.updatedAt) {
    const cadenceAnchor = job.cycleStartedAt ?? job.updatedAt;
    const cadenceAnchorAt = Date.parse(cadenceAnchor.endsWith("Z") ? cadenceAnchor : `${cadenceAnchor.replace(" ", "T")}Z`);
    if (Number.isFinite(cadenceAnchorAt) && now.getTime() - cadenceAnchorAt < maxAgeMs) return null;
  }
  if (job?.leaseExpiresAt && Date.parse(job.leaseExpiresAt) > now.getTime()) {
    return null;
  }
  if (!force && job?.nextAttemptAt && Date.parse(job.nextAttemptAt) > now.getTime()) return null;
  const continueExistingCycle = (job?.status === "running" || job?.status === "retrying")
    && Boolean(job.cycleId)
    && Number(job.processedTickers ?? 0) < Number(job.requestedTickers ?? 0);
  if (!force && !continueExistingCycle && !currentRefreshStartWindowOpen(now)) return null;
  return await refreshOverviewCurrentData(env, configId, sessionDate, {
    now,
    startNewCycle: !continueExistingCycle,
  });
}
