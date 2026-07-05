import { hasCentralCronIntervalElapsed, isCentralCronEnabled, type CronJobValues } from "./cron-jobs-service";
import { getUsMarketSessionContext } from "./market-calendar";
import { meteredFetch } from "./provider-usage";
import type { Env } from "./types";
import {
  listWatchlistSets,
  loadWatchlistUniqueRows,
  type WatchlistSetDetail,
} from "./watchlist-compiler-service";

export type OptionsStrategy = "long_call" | "long_put" | "call_debit_spread" | "put_debit_spread";
export type OptionRight = "call" | "put";
export type OptionSpreadBasis = "historical_bid_ask" | "partial_historical_bid_ask" | "live_quote" | "unavailable";

export type OptionsRefreshRequest = {
  setId?: string | null;
  runId?: string | null;
  tickers?: string[];
  minDte?: number;
  maxDte?: number;
  minOpenInterest?: number;
  minVolume?: number;
  maxContractsPerTicker?: number;
  includeHistoricalSpreads?: boolean;
  persistChainRows?: boolean;
};

export type OptionsBridgeHealth = {
  ok: boolean;
  reachable: boolean;
  configured: boolean;
  enabled: boolean;
  authenticated: boolean | null;
  bridgeRunning: boolean | null;
  ibGatewayRunning: boolean | null;
  marketDataEntitled: boolean | null;
  quoteMode: string | null;
  latestTickAt: string | null;
  historicalPacing: string | null;
  lastSuccessfulProbeAt: string | null;
  lastError: string | null;
  version: string | null;
  checkedAt: string;
  raw?: Record<string, unknown> | null;
};

export type OptionChainSnapshot = {
  id: string;
  requestId: string;
  watchlistSetId: string | null;
  watchlistSetName: string | null;
  watchlistRunId: string | null;
  ticker: string;
  provider: string;
  bridgeStatus: string;
  underlyingPrice: number | null;
  underlyingQuoteTime: string | null;
  optionsAvailable: boolean;
  ivRank52w: number | null;
  ivPercentile52w: number | null;
  dataMode: string | null;
  latestRthSessionDate: string | null;
  contractCount: number;
  candidateCount: number;
  warnings: string[];
  rawSummary: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
};

export type OptionCandidateRow = {
  id: string;
  snapshotId: string;
  requestId: string;
  rowKind: "candidate" | "chain";
  watchlistSetId: string | null;
  watchlistRunId: string | null;
  ticker: string;
  strategy: OptionsStrategy;
  contractKey: string;
  ibkrConId: number | null;
  localSymbol: string | null;
  expiry: string | null;
  strike: number | null;
  right: OptionRight | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  quoteTime: string | null;
  dataMode: string | null;
  rthSessionDate: string | null;
  spreadBasis: OptionSpreadBasis;
  rthLastBid: number | null;
  rthLastAsk: number | null;
  rthMedianSpreadPct: number | null;
  rthP75SpreadPct: number | null;
  rthMaxSpreadPct: number | null;
  rthSampleCount: number | null;
  rthFirstSampleTime: string | null;
  rthLastSampleTime: string | null;
  scoreLiquidity: number | null;
  scoreSpread: number | null;
  scoreIv: number | null;
  scoreStrategy: number | null;
  score: number | null;
  debit: number | null;
  width: number | null;
  breakeven: number | null;
  maxLoss: number | null;
  legs: OptionCandidateLeg[];
  scoreInputs: Record<string, unknown>;
  warnings: string[];
  createdAt: string;
  expiresAt: string;
};

export type OptionCandidateLeg = {
  action: "buy" | "sell";
  contractKey: string;
  ibkrConId: number | null;
  localSymbol: string | null;
  expiry: string | null;
  strike: number | null;
  right: OptionRight | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  delta: number | null;
  rthMedianSpreadPct: number | null;
};

export type OptionsStatusResponse = {
  ok: boolean;
  bridge: OptionsBridgeHealth;
  marketSession: ReturnType<typeof getUsMarketSessionContext>;
  latestSnapshot: OptionChainSnapshot | null;
  latestCandidate: OptionCandidateRow | null;
  troubleshooting: Array<{ key: string; label: string; ok: boolean; detail: string | null }>;
  warnings: string[];
};

export type OptionsRefreshResponse = {
  ok: boolean;
  requestId: string;
  set: Pick<WatchlistSetDetail, "id" | "name" | "slug"> | null;
  runId: string | null;
  requestedTickers: number;
  refreshedTickers: number;
  snapshots: OptionChainSnapshot[];
  candidates: OptionCandidateRow[];
  warnings: string[];
};

export type OptionsWatchlistResponse = {
  ok: boolean;
  set: Pick<WatchlistSetDetail, "id" | "name" | "slug"> | null;
  runId: string | null;
  rows: Array<{
    ticker: string;
    companyName: string | null;
    snapshot: OptionChainSnapshot | null;
    candidateCount: number;
    topScore: number | null;
    warnings: string[];
  }>;
  warnings: string[];
};

export type OptionsChainResponse = {
  ok: boolean;
  ticker: string;
  snapshot: OptionChainSnapshot | null;
  rows: OptionCandidateRow[];
  warnings: string[];
};

export type OptionsCandidatesResponse = {
  ok: boolean;
  rows: OptionCandidateRow[];
  grouped: Record<OptionsStrategy, OptionCandidateRow[]>;
  warnings: string[];
};

type NormalizedContract = {
  ticker: string;
  contractKey: string;
  ibkrConId: number | null;
  localSymbol: string | null;
  expiry: string | null;
  strike: number | null;
  right: OptionRight | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  quoteTime: string | null;
  dataMode: string | null;
  rthSpread: HistoricalSpreadMetrics | null;
  warnings: string[];
};

type NormalizedTickerChain = {
  ticker: string;
  provider: string;
  bridgeStatus: string;
  underlyingPrice: number | null;
  underlyingQuoteTime: string | null;
  optionsAvailable: boolean;
  ivRank52w: number | null;
  ivPercentile52w: number | null;
  dataMode: string | null;
  warnings: string[];
  contracts: NormalizedContract[];
  rawSummary: Record<string, unknown>;
};

type HistoricalSpreadMetrics = {
  contractKey: string;
  ibkrConId: number | null;
  localSymbol: string | null;
  sessionDate: string | null;
  spreadBasis: OptionSpreadBasis;
  lastBid: number | null;
  lastAsk: number | null;
  medianSpreadPct: number | null;
  p75SpreadPct: number | null;
  maxSpreadPct: number | null;
  sampleCount: number | null;
  firstSampleTime: string | null;
  lastSampleTime: string | null;
  warnings: string[];
};

type RefreshDefaults = {
  minDte: number;
  maxDte: number;
  minOpenInterest: number;
  minVolume: number;
  maxContractsPerTicker: number;
  historicalSpreadMaxContracts: number;
  historicalSpreadSampleTarget: number;
};

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MIN_DTE = 14;
const DEFAULT_MAX_DTE = 90;
const DEFAULT_MIN_OPEN_INTEREST = 100;
const DEFAULT_MIN_VOLUME = 10;
const DEFAULT_MAX_CONTRACTS_PER_TICKER = 800;
const DEFAULT_REFRESH_TICKER_LIMIT = 50;
const DEFAULT_HISTORICAL_SPREAD_MAX_CONTRACTS = 40;
const DEFAULT_HISTORICAL_SPREAD_SAMPLE_TARGET = 300;
const DEFAULT_OPTIONS_TIMEOUT_MS = 30_000;
const OPTIONS_HOUSEKEEPING_INTERVAL_MINUTES = 360;

let lastOptionsHousekeepingAt: string | null = null;

function envFlag(value: string | undefined, fallback = false): boolean {
  if (value == null || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function optionsEnabled(env: Env): boolean {
  return envFlag(env.IBKR_OPTIONS_ENABLED, false);
}

function optionsEndpoint(env: Env): string | null {
  const value = env.IBKR_OPTIONS_ENDPOINT?.trim();
  return value ? value.replace(/\/+$/, "") : null;
}

function retentionDays(env: Env): number {
  return envInt(env.OPTIONS_SNAPSHOT_RETENTION_DAYS, DEFAULT_RETENTION_DAYS, 1, 90);
}

function expiresAtIso(env: Env, now = new Date()): string {
  return new Date(now.getTime() + retentionDays(env) * 24 * 60 * 60_000).toISOString();
}

function refreshDefaults(env: Env, input: OptionsRefreshRequest = {}): RefreshDefaults {
  return {
    minDte: Math.max(0, Math.trunc(input.minDte ?? DEFAULT_MIN_DTE)),
    maxDte: Math.max(1, Math.trunc(input.maxDte ?? DEFAULT_MAX_DTE)),
    minOpenInterest: Math.max(0, Math.trunc(input.minOpenInterest ?? DEFAULT_MIN_OPEN_INTEREST)),
    minVolume: Math.max(0, Math.trunc(input.minVolume ?? DEFAULT_MIN_VOLUME)),
    maxContractsPerTicker: Math.max(1, Math.trunc(input.maxContractsPerTicker ?? DEFAULT_MAX_CONTRACTS_PER_TICKER)),
    historicalSpreadMaxContracts: envInt(env.OPTIONS_HISTORICAL_SPREAD_MAX_CONTRACTS, DEFAULT_HISTORICAL_SPREAD_MAX_CONTRACTS, 1, 200),
    historicalSpreadSampleTarget: envInt(env.OPTIONS_HISTORICAL_SPREAD_SAMPLE_TARGET, DEFAULT_HISTORICAL_SPREAD_SAMPLE_TARGET, 10, 1000),
  };
}

function requestId(): string {
  return `opt-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
}

function rowId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function uniqueTickers(values: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const ticker = String(value ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,15}$/.test(ticker)) continue;
    if (ticker.includes("^") || ticker.includes("/") || ticker.includes("=")) continue;
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    out.push(ticker);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const record = asRecord(value);
    if (record) return record;
  }
  return null;
}

function pick(record: Record<string, unknown> | null | undefined, keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return undefined;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function intOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function boolOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (["true", "1", "yes", "ok", "connected"].includes(lower)) return true;
    if (["false", "0", "no", "down", "disconnected"].includes(lower)) return false;
  }
  return null;
}

function normalizeRank(value: unknown): number | null {
  const parsed = numberOrNull(value);
  if (parsed == null) return null;
  if (parsed >= 0 && parsed <= 1) return parsed * 100;
  return Math.max(0, Math.min(100, parsed));
}

function normalizePercent(value: unknown): number | null {
  const parsed = numberOrNull(value);
  if (parsed == null) return null;
  if (parsed >= 0 && parsed <= 1) return parsed * 100;
  return parsed;
}

function warningsFrom(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 20);
  }
  const single = stringOrNull(value);
  return single ? [single] : [];
}

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item ?? "")).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function parseJsonLegs(value: string | null | undefined): OptionCandidateLeg[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as OptionCandidateLeg[] : [];
  } catch {
    return [];
  }
}

function normalizeRight(value: unknown): OptionRight | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (["c", "call", "calls"].includes(text)) return "call";
  if (["p", "put", "puts"].includes(text)) return "put";
  return null;
}

function normalizeDate(value: unknown): string | null {
  const text = stringOrNull(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeIso(value: unknown): string | null {
  const text = stringOrNull(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function daysToExpiry(expiry: string | null, now = new Date()): number | null {
  if (!expiry) return null;
  const parsed = Date.parse(`${expiry}T21:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  return Math.ceil((parsed - now.getTime()) / (24 * 60 * 60_000));
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function spreadPctFromBidAsk(bid: number | null, ask: number | null): number | null {
  if (bid == null || ask == null || bid <= 0 || ask <= 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  return mid > 0 ? ((ask - bid) / mid) * 100 : null;
}

function median(values: number[], quantile = 0.5): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function candidateMid(bid: number | null, ask: number | null, last: number | null): number | null {
  if (bid != null && ask != null && bid > 0 && ask > 0 && ask >= bid) return (bid + ask) / 2;
  return last != null && last > 0 ? last : null;
}

async function ensureOptionsSchema(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS option_chain_snapshots (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      watchlist_set_id TEXT,
      watchlist_set_name TEXT,
      watchlist_run_id TEXT,
      ticker TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'ibkr_bridge',
      bridge_status TEXT NOT NULL DEFAULT 'unknown',
      underlying_price REAL,
      underlying_quote_time TEXT,
      options_available INTEGER NOT NULL DEFAULT 0,
      iv_rank_52w REAL,
      iv_percentile_52w REAL,
      data_mode TEXT,
      latest_rth_session_date TEXT,
      contract_count INTEGER NOT NULL DEFAULT 0,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      raw_summary_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS option_contract_quotes (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      row_kind TEXT NOT NULL DEFAULT 'candidate',
      watchlist_set_id TEXT,
      watchlist_run_id TEXT,
      ticker TEXT NOT NULL,
      strategy TEXT NOT NULL,
      contract_key TEXT NOT NULL,
      ibkr_con_id INTEGER,
      local_symbol TEXT,
      expiry TEXT,
      strike REAL,
      right TEXT,
      bid REAL,
      ask REAL,
      mid REAL,
      last REAL,
      volume INTEGER,
      open_interest INTEGER,
      iv REAL,
      delta REAL,
      gamma REAL,
      theta REAL,
      vega REAL,
      quote_time TEXT,
      data_mode TEXT,
      rth_session_date TEXT,
      spread_basis TEXT NOT NULL DEFAULT 'unavailable',
      rth_last_bid REAL,
      rth_last_ask REAL,
      rth_median_spread_pct REAL,
      rth_p75_spread_pct REAL,
      rth_max_spread_pct REAL,
      rth_sample_count INTEGER,
      rth_first_sample_time TEXT,
      rth_last_sample_time TEXT,
      score_liquidity REAL,
      score_spread REAL,
      score_iv REAL,
      score_strategy REAL,
      score REAL,
      debit REAL,
      width REAL,
      breakeven REAL,
      max_loss REAL,
      legs_json TEXT NOT NULL DEFAULT '[]',
      score_inputs_json TEXT NOT NULL DEFAULT '{}',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    )`,
  ).run();
  try {
    const rowKindColumn = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM pragma_table_info('option_contract_quotes') WHERE name = 'row_kind'",
    ).first<{ count: number }>();
    if (!Number(rowKindColumn?.count ?? 0)) {
      await env.DB.prepare("ALTER TABLE option_contract_quotes ADD COLUMN row_kind TEXT NOT NULL DEFAULT 'candidate'").run();
    }
  } catch {
    // Production D1 is updated by migrations; this keeps older local DBs usable.
  }
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_option_chain_snapshots_ticker_created ON option_chain_snapshots (ticker, created_at DESC)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_option_chain_snapshots_watchlist_created ON option_chain_snapshots (watchlist_set_id, watchlist_run_id, created_at DESC)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_option_contract_quotes_snapshot ON option_contract_quotes (snapshot_id)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_option_contract_quotes_row_kind_ticker ON option_contract_quotes (row_kind, ticker)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_option_contract_quotes_ticker_score ON option_contract_quotes (ticker, score DESC)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_option_contract_quotes_strategy_score ON option_contract_quotes (strategy, score DESC)").run();
}

function bridgeHeaders(env: Env): Headers {
  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  if (env.IBKR_OPTIONS_TOKEN?.trim()) headers.set("authorization", `Bearer ${env.IBKR_OPTIONS_TOKEN.trim()}`);
  if (env.IBKR_OPTIONS_CF_ACCESS_CLIENT_ID?.trim()) headers.set("CF-Access-Client-Id", env.IBKR_OPTIONS_CF_ACCESS_CLIENT_ID.trim());
  if (env.IBKR_OPTIONS_CF_ACCESS_CLIENT_SECRET?.trim()) headers.set("CF-Access-Client-Secret", env.IBKR_OPTIONS_CF_ACCESS_CLIENT_SECRET.trim());
  return headers;
}

async function bridgeJson(env: Env, path: string, init: RequestInit, endpointKey: string, symbolCount = 0): Promise<unknown> {
  const endpoint = optionsEndpoint(env);
  if (!endpoint) throw new Error("IBKR options bridge endpoint is not configured.");
  const timeoutMs = envInt(env.IBKR_OPTIONS_TIMEOUT_MS, DEFAULT_OPTIONS_TIMEOUT_MS, 1_000, 240_000);
  const response = await meteredFetch(env, `${endpoint}${path}`, {
    ...init,
    headers: bridgeHeaders(env),
  }, {
    providerKey: "ibkr-options",
    endpointKey,
    caller: "options-workbench",
    symbolCount,
  }, timeoutMs);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`IBKR options bridge ${endpointKey} failed: ${response.status}${text ? ` - ${text.slice(0, 300)}` : ""}`);
  }
  return await response.json();
}

function normalizeHealth(raw: unknown, enabled: boolean, configured: boolean, reachable: boolean, error?: unknown): OptionsBridgeHealth {
  const record = asRecord(raw) ?? {};
  const ibkr = firstRecord(record.ibkr, record.ibGateway, record.gateway, record.session);
  const marketData = firstRecord(record.marketData, record.data, record.entitlements);
  const pacing = firstRecord(record.historicalPacing, record.pacing);
  const lastError = error instanceof Error
    ? error.message
    : stringOrNull(pick(record, ["lastError", "error", "message"]));
  return {
    ok: reachable && (boolOrNull(pick(record, ["ok", "healthy"])) ?? true),
    reachable,
    configured,
    enabled,
    authenticated: boolOrNull(pick(ibkr, ["authenticated", "isAuthenticated", "connected"])) ?? boolOrNull(pick(record, ["authenticated", "ibkrAuthenticated"])),
    bridgeRunning: boolOrNull(pick(record, ["bridgeRunning", "running", "serviceRunning"])),
    ibGatewayRunning: boolOrNull(pick(ibkr, ["running", "gatewayRunning", "ibGatewayRunning"])) ?? boolOrNull(pick(record, ["ibGatewayRunning"])),
    marketDataEntitled: boolOrNull(pick(marketData, ["entitled", "marketDataEntitled", "hasEntitlements"])) ?? boolOrNull(pick(record, ["marketDataEntitled"])),
    quoteMode: stringOrNull(pick(marketData, ["quoteMode", "mode"])) ?? stringOrNull(pick(record, ["quoteMode", "dataMode"])),
    latestTickAt: normalizeIso(pick(record, ["latestTickAt", "lastTickAt", "lastQuoteAt"])),
    historicalPacing: stringOrNull(pick(pacing, ["status", "state"])) ?? stringOrNull(pick(record, ["historicalPacing"])),
    lastSuccessfulProbeAt: normalizeIso(pick(record, ["lastSuccessfulProbeAt", "lastProbeAt", "lastSuccessAt"])),
    lastError,
    version: stringOrNull(pick(record, ["version", "bridgeVersion"])),
    checkedAt: new Date().toISOString(),
    raw: raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null,
  };
}

async function fetchBridgeHealth(env: Env): Promise<OptionsBridgeHealth> {
  const enabled = optionsEnabled(env);
  const configured = Boolean(optionsEndpoint(env));
  if (!enabled || !configured) {
    return normalizeHealth({}, enabled, configured, false, !enabled ? new Error("IBKR options bridge is disabled.") : undefined);
  }
  try {
    const raw = await bridgeJson(env, "/health", { method: "GET" }, "health");
    return normalizeHealth(raw, enabled, configured, true);
  } catch (error) {
    return normalizeHealth({}, enabled, configured, false, error);
  }
}

function responseArray(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  const record = asRecord(raw);
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.entries(value as Record<string, unknown>).map(([ticker, row]) => {
        const child = asRecord(row);
        return child ? { ticker, ...child } : { ticker, value: row };
      });
    }
  }
  return [];
}

function normalizeContract(ticker: string, raw: unknown): NormalizedContract | null {
  const record = asRecord(raw);
  if (!record) return null;
  const greeks = firstRecord(record.greeks);
  const quote = firstRecord(record.quote, record.nbbo);
  const right = normalizeRight(pick(record, ["right", "type", "putCall", "optionType", "cp"]));
  const expiry = normalizeDate(pick(record, ["expiry", "expiration", "expirationDate", "lastTradeDateOrContractMonth"]));
  const strike = numberOrNull(pick(record, ["strike", "strikePrice"]));
  const ibkrConId = intOrNull(pick(record, ["ibkrConId", "conId", "contractId"]));
  const localSymbol = stringOrNull(pick(record, ["localSymbol", "symbol", "contractSymbol"]));
  const contractKey = stringOrNull(pick(record, ["contractKey", "key", "id"]))
    ?? localSymbol
    ?? (ibkrConId != null ? String(ibkrConId) : null)
    ?? `${ticker}-${expiry ?? "unknown"}-${right ?? "option"}-${strike ?? "na"}`;
  const bid = numberOrNull(pick(quote, ["bid", "bidPrice"])) ?? numberOrNull(pick(record, ["bid", "bidPrice"]));
  const ask = numberOrNull(pick(quote, ["ask", "askPrice"])) ?? numberOrNull(pick(record, ["ask", "askPrice"]));
  const last = numberOrNull(pick(quote, ["last", "lastPrice"])) ?? numberOrNull(pick(record, ["last", "lastPrice"]));
  const mid = numberOrNull(pick(quote, ["mid", "mark"])) ?? numberOrNull(pick(record, ["mid", "mark"])) ?? candidateMid(bid, ask, last);
  const rthSpread = normalizeHistoricalSpreadRecord(record, ticker);
  return {
    ticker,
    contractKey,
    ibkrConId,
    localSymbol,
    expiry,
    strike,
    right,
    bid,
    ask,
    mid,
    last,
    volume: intOrNull(pick(record, ["volume", "dayVolume"])),
    openInterest: intOrNull(pick(record, ["openInterest", "oi"])),
    iv: numberOrNull(pick(greeks, ["iv", "impliedVolatility"])) ?? numberOrNull(pick(record, ["iv", "impliedVolatility"])),
    delta: numberOrNull(pick(greeks, ["delta"])) ?? numberOrNull(pick(record, ["delta"])),
    gamma: numberOrNull(pick(greeks, ["gamma"])) ?? numberOrNull(pick(record, ["gamma"])),
    theta: numberOrNull(pick(greeks, ["theta"])) ?? numberOrNull(pick(record, ["theta"])),
    vega: numberOrNull(pick(greeks, ["vega"])) ?? numberOrNull(pick(record, ["vega"])),
    quoteTime: normalizeIso(pick(quote, ["time", "quoteTime", "timestamp"])) ?? normalizeIso(pick(record, ["quoteTime", "timestamp", "asOf"])),
    dataMode: stringOrNull(pick(record, ["dataMode", "quoteMode", "mode"])),
    rthSpread,
    warnings: warningsFrom(record.warnings),
  };
}

function normalizeTickerChain(raw: unknown): NormalizedTickerChain | null {
  const record = asRecord(raw);
  if (!record) return null;
  const ticker = uniqueTickers([pick(record, ["ticker", "symbol", "underlyingSymbol"])])[0];
  if (!ticker) return null;
  const underlying = firstRecord(record.underlying, record.underlyingQuote);
  const contracts = responseArray(record.contracts ?? record.options ?? record.chain ?? record.rows, ["contracts", "options", "chain", "rows"])
    .map((contract) => normalizeContract(ticker, contract))
    .filter((contract): contract is NormalizedContract => Boolean(contract));
  const optionsAvailable = boolOrNull(pick(record, ["optionsAvailable", "hasOptions", "listedOptions"]))
    ?? contracts.length > 0;
  return {
    ticker,
    provider: stringOrNull(pick(record, ["provider"])) ?? "ibkr_bridge",
    bridgeStatus: stringOrNull(pick(record, ["status", "bridgeStatus"])) ?? "ok",
    underlyingPrice: numberOrNull(pick(underlying, ["price", "last", "mark"])) ?? numberOrNull(pick(record, ["underlyingPrice", "price"])),
    underlyingQuoteTime: normalizeIso(pick(underlying, ["quoteTime", "timestamp", "asOf"])) ?? normalizeIso(pick(record, ["underlyingQuoteTime", "asOf"])),
    optionsAvailable,
    ivRank52w: normalizeRank(pick(record, ["ivRank52w", "ivRank", "iv_rank_52w"])),
    ivPercentile52w: normalizeRank(pick(record, ["ivPercentile52w", "ivPercentile", "iv_percentile_52w"])),
    dataMode: stringOrNull(pick(record, ["dataMode", "quoteMode", "mode"])),
    warnings: warningsFrom(record.warnings),
    contracts,
    rawSummary: {
      bridgeStatus: pick(record, ["status", "bridgeStatus"]) ?? null,
      rawContractCount: contracts.length,
      pacing: record.pacing ?? null,
    },
  };
}

function normalizeChainResponse(raw: unknown): NormalizedTickerChain[] {
  return responseArray(raw, ["results", "tickers", "chains", "rows"])
    .map(normalizeTickerChain)
    .filter((chain): chain is NormalizedTickerChain => Boolean(chain));
}

function normalizeHistoricalSpreadRecord(raw: unknown, fallbackTicker?: string): HistoricalSpreadMetrics | null {
  const record = asRecord(raw);
  if (!record) return null;
  const spreadRecord = firstRecord(record.rthSpread, record.historicalSpread, record.spreadMetrics) ?? record;
  const contractKey = stringOrNull(pick(spreadRecord, ["contractKey", "key", "id"]))
    ?? stringOrNull(pick(record, ["contractKey", "key", "id"]))
    ?? stringOrNull(pick(record, ["localSymbol", "symbol", "contractSymbol"]))
    ?? (intOrNull(pick(record, ["ibkrConId", "conId", "contractId"])) != null ? String(intOrNull(pick(record, ["ibkrConId", "conId", "contractId"]))) : null);
  const ticks = responseArray(spreadRecord.ticks ?? spreadRecord.samples, ["ticks", "samples"]);
  let computed: Partial<HistoricalSpreadMetrics> = {};
  if (ticks.length > 0) {
    const samples = ticks.map((tick) => {
      const row = asRecord(tick);
      const bid = numberOrNull(pick(row, ["bid", "bidPrice"]));
      const ask = numberOrNull(pick(row, ["ask", "askPrice"]));
      const spreadPct = spreadPctFromBidAsk(bid, ask);
      return {
        bid,
        ask,
        spreadPct,
        time: normalizeIso(pick(row, ["time", "timestamp", "quoteTime"])),
      };
    }).filter((sample) => sample.spreadPct != null) as Array<{ bid: number | null; ask: number | null; spreadPct: number; time: string | null }>;
    const spreads = samples.map((sample) => sample.spreadPct);
    const last = samples[samples.length - 1];
    computed = {
      lastBid: last?.bid ?? null,
      lastAsk: last?.ask ?? null,
      medianSpreadPct: median(spreads),
      p75SpreadPct: median(spreads, 0.75),
      maxSpreadPct: spreads.length ? Math.max(...spreads) : null,
      sampleCount: samples.length,
      firstSampleTime: samples[0]?.time ?? null,
      lastSampleTime: last?.time ?? null,
    };
  }
  const hasExplicitMetrics =
    pick(spreadRecord, ["medianSpreadPct", "median_spread_pct", "p75SpreadPct", "p75_spread_pct", "sampleCount", "sample_count"]) !== undefined;
  if (!contractKey && !hasExplicitMetrics && !computed.sampleCount) return null;
  return {
    contractKey: contractKey ?? `${fallbackTicker ?? "UNKNOWN"}-unknown`,
    ibkrConId: intOrNull(pick(record, ["ibkrConId", "conId", "contractId"])),
    localSymbol: stringOrNull(pick(record, ["localSymbol", "symbol", "contractSymbol"])),
    sessionDate: normalizeDate(pick(spreadRecord, ["sessionDate", "rthSessionDate", "date"])),
    spreadBasis: (stringOrNull(pick(spreadRecord, ["spreadBasis", "basis"])) as OptionSpreadBasis | null) ?? "historical_bid_ask",
    lastBid: numberOrNull(pick(spreadRecord, ["lastBid", "rthLastBid"])) ?? computed.lastBid ?? null,
    lastAsk: numberOrNull(pick(spreadRecord, ["lastAsk", "rthLastAsk"])) ?? computed.lastAsk ?? null,
    medianSpreadPct: normalizePercent(pick(spreadRecord, ["medianSpreadPct", "median_spread_pct"])) ?? computed.medianSpreadPct ?? null,
    p75SpreadPct: normalizePercent(pick(spreadRecord, ["p75SpreadPct", "p75_spread_pct"])) ?? computed.p75SpreadPct ?? null,
    maxSpreadPct: normalizePercent(pick(spreadRecord, ["maxSpreadPct", "max_spread_pct"])) ?? computed.maxSpreadPct ?? null,
    sampleCount: intOrNull(pick(spreadRecord, ["sampleCount", "sample_count"])) ?? computed.sampleCount ?? null,
    firstSampleTime: normalizeIso(pick(spreadRecord, ["firstSampleTime", "first_sample_time"])) ?? computed.firstSampleTime ?? null,
    lastSampleTime: normalizeIso(pick(spreadRecord, ["lastSampleTime", "last_sample_time"])) ?? computed.lastSampleTime ?? null,
    warnings: warningsFrom(spreadRecord.warnings),
  };
}

function spreadMetricKeys(contract: Pick<NormalizedContract, "contractKey" | "ibkrConId" | "localSymbol">): string[] {
  return [
    contract.contractKey,
    contract.localSymbol ?? "",
    contract.ibkrConId != null ? String(contract.ibkrConId) : "",
  ].filter(Boolean);
}

function historicalSpreadMap(raw: unknown): Map<string, HistoricalSpreadMetrics> {
  const rows = responseArray(raw, ["contracts", "results", "rows", "spreads"])
    .map((row) => normalizeHistoricalSpreadRecord(row))
    .filter((row): row is HistoricalSpreadMetrics => Boolean(row));
  const map = new Map<string, HistoricalSpreadMetrics>();
  for (const row of rows) {
    for (const key of [row.contractKey, row.localSymbol ?? "", row.ibkrConId != null ? String(row.ibkrConId) : ""].filter(Boolean)) {
      map.set(key, row);
    }
  }
  return map;
}

async function fetchChains(env: Env, tickers: string[], defaults: RefreshDefaults): Promise<NormalizedTickerChain[]> {
  const raw = await bridgeJson(env, "/v1/options/chains", {
    method: "POST",
    body: JSON.stringify({
      tickers,
      includeGreeks: true,
      includeIvRank: true,
      minDte: defaults.minDte,
      maxDte: defaults.maxDte,
      maxContractsPerTicker: defaults.maxContractsPerTicker,
    }),
  }, "chains", tickers.length);
  return normalizeChainResponse(raw);
}

async function fetchHistoricalSpreads(
  env: Env,
  contracts: NormalizedContract[],
  sessionDate: string,
  sampleTarget: number,
): Promise<Map<string, HistoricalSpreadMetrics>> {
  if (contracts.length === 0) return new Map();
  const raw = await bridgeJson(env, "/v1/options/historical-bid-ask", {
    method: "POST",
    body: JSON.stringify({
      sessionDate,
      useRth: 1,
      tickType: "BID_ASK",
      sampleTarget,
      contracts: contracts.map((contract) => ({
        ticker: contract.ticker,
        contractKey: contract.contractKey,
        ibkrConId: contract.ibkrConId,
        localSymbol: contract.localSymbol,
        expiry: contract.expiry,
        strike: contract.strike,
        right: contract.right,
      })),
    }),
  }, "historical-bid-ask", contracts.length);
  return historicalSpreadMap(raw);
}

function passesBaseFilters(contract: NormalizedContract, defaults: RefreshDefaults, now = new Date()): boolean {
  const dte = daysToExpiry(contract.expiry, now);
  if (dte == null || dte < defaults.minDte || dte > defaults.maxDte) return false;
  if ((contract.openInterest ?? 0) < defaults.minOpenInterest) return false;
  if ((contract.volume ?? 0) < defaults.minVolume) return false;
  return Boolean(contract.right && contract.strike != null);
}

function passesLongDelta(contract: NormalizedContract): boolean {
  const delta = contract.delta;
  if (delta == null) return false;
  const abs = Math.abs(delta);
  return abs >= 0.25 && abs <= 0.60;
}

function liquidityScore(contract: Pick<NormalizedContract, "openInterest" | "volume">): number {
  const oiScore = Math.min(1, Math.max(0, (contract.openInterest ?? 0) / 1000)) * 60;
  const volumeScore = Math.min(1, Math.max(0, (contract.volume ?? 0) / 200)) * 40;
  return clampScore(oiScore + volumeScore);
}

function spreadScore(metrics: HistoricalSpreadMetrics | null, fallbackBid?: number | null, fallbackAsk?: number | null): { score: number; spreadPct: number | null; basis: OptionSpreadBasis } {
  const spreadPct = metrics?.medianSpreadPct ?? spreadPctFromBidAsk(fallbackBid ?? null, fallbackAsk ?? null);
  const basis = metrics?.medianSpreadPct != null ? metrics.spreadBasis : (spreadPct != null ? "live_quote" : "unavailable");
  if (spreadPct == null) return { score: 0, spreadPct: null, basis: "unavailable" };
  if (spreadPct <= 4) return { score: 100, spreadPct, basis };
  if (spreadPct >= 18) return { score: 0, spreadPct, basis };
  return { score: clampScore(100 - ((spreadPct - 4) / 14) * 100), spreadPct, basis };
}

function ivScore(ivRank52w: number | null): number {
  if (ivRank52w == null) return 50;
  return clampScore(100 - ivRank52w);
}

function strategyFitScore(contract: NormalizedContract, defaults: RefreshDefaults, now = new Date()): number {
  const dte = daysToExpiry(contract.expiry, now);
  const delta = Math.abs(contract.delta ?? 0);
  const dteFit = dte == null ? 50 : dte >= defaults.minDte && dte <= defaults.maxDte ? 100 : 0;
  const deltaFit = delta >= 0.25 && delta <= 0.60 ? 100 - Math.abs(delta - 0.40) * 120 : 25;
  return clampScore((dteFit * 0.45) + (deltaFit * 0.55));
}

function finalScore(input: {
  liquidity: number;
  spread: number;
  iv: number;
  strategy: number;
  missingIv: boolean;
  missingSpread: boolean;
}): number {
  let score = (input.liquidity * 0.45) + (input.spread * 0.25) + (input.iv * 0.20) + (input.strategy * 0.10);
  if (input.missingIv) score = Math.min(score, 80);
  if (input.missingSpread) score = Math.min(score, 70);
  return Math.round(clampScore(score));
}

function contractLeg(action: "buy" | "sell", contract: NormalizedContract): OptionCandidateLeg {
  return {
    action,
    contractKey: contract.contractKey,
    ibkrConId: contract.ibkrConId,
    localSymbol: contract.localSymbol,
    expiry: contract.expiry,
    strike: contract.strike,
    right: contract.right,
    bid: contract.bid,
    ask: contract.ask,
    mid: contract.mid,
    delta: contract.delta,
    rthMedianSpreadPct: contract.rthSpread?.medianSpreadPct ?? null,
  };
}

function baseCandidate(input: {
  snapshotId: string;
  requestIdValue: string;
  watchlistSetId: string | null;
  watchlistRunId: string | null;
  chain: NormalizedTickerChain;
  contract: NormalizedContract;
  strategy: OptionsStrategy;
  defaults: RefreshDefaults;
  latestRthSessionDate: string;
  extraWarnings?: string[];
  rowKind?: OptionCandidateRow["rowKind"];
}): OptionCandidateRow {
  const spread = spreadScore(input.contract.rthSpread, input.contract.bid, input.contract.ask);
  const liquidity = liquidityScore(input.contract);
  const iv = ivScore(input.chain.ivRank52w);
  const strategy = strategyFitScore(input.contract, input.defaults);
  const missingIv = input.chain.ivRank52w == null;
  const missingSpread = spread.basis === "unavailable";
  const warnings = [
    ...input.chain.warnings,
    ...input.contract.warnings,
    ...(input.contract.rthSpread?.warnings ?? []),
    ...(input.extraWarnings ?? []),
  ];
  if (missingIv) warnings.push("Missing 52-week IV rank; score capped.");
  if (missingSpread) warnings.push("Missing historical RTH BID_ASK spread; score capped.");
  const score = finalScore({ liquidity, spread: spread.score, iv, strategy, missingIv, missingSpread });
  return {
    id: rowId("optq"),
    snapshotId: input.snapshotId,
    requestId: input.requestIdValue,
    rowKind: input.rowKind ?? "candidate",
    watchlistSetId: input.watchlistSetId,
    watchlistRunId: input.watchlistRunId,
    ticker: input.chain.ticker,
    strategy: input.strategy,
    contractKey: input.contract.contractKey,
    ibkrConId: input.contract.ibkrConId,
    localSymbol: input.contract.localSymbol,
    expiry: input.contract.expiry,
    strike: input.contract.strike,
    right: input.contract.right,
    bid: input.contract.bid,
    ask: input.contract.ask,
    mid: input.contract.mid,
    last: input.contract.last,
    volume: input.contract.volume,
    openInterest: input.contract.openInterest,
    iv: input.contract.iv,
    delta: input.contract.delta,
    gamma: input.contract.gamma,
    theta: input.contract.theta,
    vega: input.contract.vega,
    quoteTime: input.contract.quoteTime,
    dataMode: input.contract.dataMode ?? input.chain.dataMode,
    rthSessionDate: input.contract.rthSpread?.sessionDate ?? input.latestRthSessionDate,
    spreadBasis: spread.basis,
    rthLastBid: input.contract.rthSpread?.lastBid ?? null,
    rthLastAsk: input.contract.rthSpread?.lastAsk ?? null,
    rthMedianSpreadPct: input.contract.rthSpread?.medianSpreadPct ?? spread.spreadPct,
    rthP75SpreadPct: input.contract.rthSpread?.p75SpreadPct ?? null,
    rthMaxSpreadPct: input.contract.rthSpread?.maxSpreadPct ?? null,
    rthSampleCount: input.contract.rthSpread?.sampleCount ?? null,
    rthFirstSampleTime: input.contract.rthSpread?.firstSampleTime ?? null,
    rthLastSampleTime: input.contract.rthSpread?.lastSampleTime ?? null,
    scoreLiquidity: Math.round(liquidity),
    scoreSpread: Math.round(spread.score),
    scoreIv: Math.round(iv),
    scoreStrategy: Math.round(strategy),
    score,
    debit: input.contract.ask ?? input.contract.mid,
    width: null,
    breakeven: input.contract.right === "call" && input.contract.strike != null && input.contract.ask != null
      ? input.contract.strike + input.contract.ask
      : input.contract.right === "put" && input.contract.strike != null && input.contract.ask != null
        ? input.contract.strike - input.contract.ask
        : null,
    maxLoss: input.contract.ask ?? input.contract.mid,
    legs: [contractLeg("buy", input.contract)],
    scoreInputs: { spreadPct: spread.spreadPct, ivRank52w: input.chain.ivRank52w },
    warnings: Array.from(new Set(warnings)),
    createdAt: new Date().toISOString(),
    expiresAt: "",
  };
}

function combinedSpreadMetric(left: NormalizedContract, right: NormalizedContract): {
  basis: OptionSpreadBasis;
  median: number | null;
  p75: number | null;
  max: number | null;
  samples: number | null;
  first: string | null;
  last: string | null;
} {
  const metrics = [left.rthSpread, right.rthSpread].filter(Boolean) as HistoricalSpreadMetrics[];
  if (metrics.length === 0) return { basis: "unavailable", median: null, p75: null, max: null, samples: null, first: null, last: null };
  const avg = (values: Array<number | null>) => {
    const clean = values.filter((value): value is number => value != null && Number.isFinite(value));
    return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
  };
  return {
    basis: metrics.length === 2 ? "historical_bid_ask" : "partial_historical_bid_ask",
    median: avg(metrics.map((metric) => metric.medianSpreadPct)),
    p75: avg(metrics.map((metric) => metric.p75SpreadPct)),
    max: avg(metrics.map((metric) => metric.maxSpreadPct)),
    samples: metrics.reduce((sum, metric) => sum + (metric.sampleCount ?? 0), 0) || null,
    first: metrics.map((metric) => metric.firstSampleTime).filter(Boolean).sort()[0] ?? null,
    last: metrics.map((metric) => metric.lastSampleTime).filter(Boolean).sort().at(-1) ?? null,
  };
}

function buildSpreadCandidate(input: {
  snapshotId: string;
  requestIdValue: string;
  watchlistSetId: string | null;
  watchlistRunId: string | null;
  chain: NormalizedTickerChain;
  buy: NormalizedContract;
  sell: NormalizedContract;
  strategy: OptionsStrategy;
  defaults: RefreshDefaults;
  latestRthSessionDate: string;
}): OptionCandidateRow | null {
  if (input.buy.strike == null || input.sell.strike == null) return null;
  if (input.buy.ask == null || input.sell.bid == null) return null;
  const width = Math.abs(input.sell.strike - input.buy.strike);
  if (width <= 0) return null;
  const debit = input.buy.ask - input.sell.bid;
  if (debit <= 0 || debit > width * 0.75) return null;
  const combinedSpread = combinedSpreadMetric(input.buy, input.sell);
  const spread = spreadScore({
    contractKey: `${input.buy.contractKey}|${input.sell.contractKey}`,
    ibkrConId: null,
    localSymbol: null,
    sessionDate: input.latestRthSessionDate,
    spreadBasis: combinedSpread.basis,
    lastBid: null,
    lastAsk: null,
    medianSpreadPct: combinedSpread.median,
    p75SpreadPct: combinedSpread.p75,
    maxSpreadPct: combinedSpread.max,
    sampleCount: combinedSpread.samples,
    firstSampleTime: combinedSpread.first,
    lastSampleTime: combinedSpread.last,
    warnings: [],
  });
  const liquidity = Math.min(liquidityScore(input.buy), liquidityScore(input.sell));
  const iv = ivScore(input.chain.ivRank52w);
  const strategy = clampScore(strategyFitScore(input.buy, input.defaults) - Math.max(0, (debit / width) - 0.5) * 80);
  const missingIv = input.chain.ivRank52w == null;
  const missingSpread = combinedSpread.basis === "unavailable";
  const warnings = [
    ...input.chain.warnings,
    ...input.buy.warnings,
    ...input.sell.warnings,
    ...(input.buy.rthSpread?.warnings ?? []),
    ...(input.sell.rthSpread?.warnings ?? []),
  ];
  if (missingIv) warnings.push("Missing 52-week IV rank; score capped.");
  if (missingSpread) warnings.push("Missing historical RTH BID_ASK spread; score capped.");
  const score = finalScore({ liquidity, spread: spread.score, iv, strategy, missingIv, missingSpread });
  const breakeven = input.strategy === "call_debit_spread"
    ? input.buy.strike + debit
    : input.buy.strike - debit;
  return {
    id: rowId("optq"),
    snapshotId: input.snapshotId,
    requestId: input.requestIdValue,
    rowKind: "candidate",
    watchlistSetId: input.watchlistSetId,
    watchlistRunId: input.watchlistRunId,
    ticker: input.chain.ticker,
    strategy: input.strategy,
    contractKey: `${input.buy.contractKey}|${input.sell.contractKey}`,
    ibkrConId: input.buy.ibkrConId,
    localSymbol: input.buy.localSymbol,
    expiry: input.buy.expiry,
    strike: input.buy.strike,
    right: input.buy.right,
    bid: null,
    ask: null,
    mid: null,
    last: null,
    volume: Math.min(input.buy.volume ?? 0, input.sell.volume ?? 0),
    openInterest: Math.min(input.buy.openInterest ?? 0, input.sell.openInterest ?? 0),
    iv: input.buy.iv,
    delta: input.buy.delta,
    gamma: input.buy.gamma,
    theta: input.buy.theta,
    vega: input.buy.vega,
    quoteTime: input.buy.quoteTime ?? input.sell.quoteTime,
    dataMode: input.buy.dataMode ?? input.sell.dataMode ?? input.chain.dataMode,
    rthSessionDate: input.latestRthSessionDate,
    spreadBasis: combinedSpread.basis,
    rthLastBid: null,
    rthLastAsk: null,
    rthMedianSpreadPct: combinedSpread.median,
    rthP75SpreadPct: combinedSpread.p75,
    rthMaxSpreadPct: combinedSpread.max,
    rthSampleCount: combinedSpread.samples,
    rthFirstSampleTime: combinedSpread.first,
    rthLastSampleTime: combinedSpread.last,
    scoreLiquidity: Math.round(liquidity),
    scoreSpread: Math.round(spread.score),
    scoreIv: Math.round(iv),
    scoreStrategy: Math.round(strategy),
    score,
    debit,
    width,
    breakeven,
    maxLoss: debit,
    legs: [contractLeg("buy", input.buy), contractLeg("sell", input.sell)],
    scoreInputs: { debit, width, debitPctOfWidth: debit / width, ivRank52w: input.chain.ivRank52w },
    warnings: Array.from(new Set(warnings)),
    createdAt: new Date().toISOString(),
    expiresAt: "",
  };
}

function buildCandidates(input: {
  chain: NormalizedTickerChain;
  snapshotId: string;
  requestIdValue: string;
  watchlistSetId: string | null;
  watchlistRunId: string | null;
  defaults: RefreshDefaults;
  latestRthSessionDate: string;
  expiresAt: string;
}): OptionCandidateRow[] {
  const now = new Date();
  const base = input.chain.contracts.filter((contract) => passesBaseFilters(contract, input.defaults, now));
  const candidates: OptionCandidateRow[] = [];
  for (const contract of base) {
    if (!passesLongDelta(contract)) continue;
    if (contract.right === "call") {
      candidates.push(baseCandidate({ ...input, contract, strategy: "long_call" }));
    } else if (contract.right === "put") {
      candidates.push(baseCandidate({ ...input, contract, strategy: "long_put" }));
    }
  }
  const grouped = new Map<string, NormalizedContract[]>();
  for (const contract of base) {
    if (!contract.right || !contract.expiry) continue;
    const key = `${contract.right}|${contract.expiry}`;
    grouped.set(key, [...(grouped.get(key) ?? []), contract]);
  }
  for (const contracts of grouped.values()) {
    const sorted = [...contracts].sort((left, right) => (left.strike ?? 0) - (right.strike ?? 0));
    for (const buy of sorted) {
      const delta = buy.delta == null ? 0 : Math.abs(buy.delta);
      if (delta < 0.35 || delta > 0.60) continue;
      const sellCandidates = sorted.filter((candidate) => {
        if (buy.right === "call") return (candidate.strike ?? -Infinity) > (buy.strike ?? Infinity);
        return (candidate.strike ?? Infinity) < (buy.strike ?? -Infinity);
      });
      for (const sell of sellCandidates.slice(0, 4)) {
        const strategy: OptionsStrategy = buy.right === "call" ? "call_debit_spread" : "put_debit_spread";
        const row = buildSpreadCandidate({ ...input, buy, sell, strategy });
        if (row) candidates.push(row);
      }
    }
  }
  return candidates
    .map((row) => ({ ...row, expiresAt: input.expiresAt }))
    .sort((left, right) => (right.score ?? -1) - (left.score ?? -1))
    .slice(0, 250);
}

function buildChainRows(input: {
  chain: NormalizedTickerChain;
  snapshotId: string;
  requestIdValue: string;
  watchlistSetId: string | null;
  watchlistRunId: string | null;
  defaults: RefreshDefaults;
  latestRthSessionDate: string;
  expiresAt: string;
  excludeContractKeys?: Set<string>;
}): OptionCandidateRow[] {
  const excluded = input.excludeContractKeys ?? new Set<string>();
  return input.chain.contracts
    .filter((contract) => contract.right && contract.strike != null && !excluded.has(contract.contractKey))
    .map((contract) => baseCandidate({
      ...input,
      contract,
      strategy: contract.right === "put" ? "long_put" : "long_call",
      rowKind: "chain",
    }))
    .map((row) => ({ ...row, expiresAt: input.expiresAt }))
    .sort((left, right) => {
      const expiryCompare = String(left.expiry ?? "").localeCompare(String(right.expiry ?? ""));
      if (expiryCompare !== 0) return expiryCompare;
      const rightCompare = String(left.right ?? "").localeCompare(String(right.right ?? ""));
      if (rightCompare !== 0) return rightCompare;
      return (left.strike ?? 0) - (right.strike ?? 0);
    })
    .slice(0, 500);
}

function selectContractsForSpreadProbe(chains: NormalizedTickerChain[], defaults: RefreshDefaults): NormalizedContract[] {
  const selected = chains
    .flatMap((chain) => chain.contracts)
    .filter((contract) => passesBaseFilters(contract, defaults))
    .sort((left, right) => {
      const leftScore = (left.openInterest ?? 0) + (left.volume ?? 0) * 3 + (passesLongDelta(left) ? 500 : 0);
      const rightScore = (right.openInterest ?? 0) + (right.volume ?? 0) * 3 + (passesLongDelta(right) ? 500 : 0);
      return rightScore - leftScore;
    });
  const seen = new Set<string>();
  const out: NormalizedContract[] = [];
  for (const contract of selected) {
    if (seen.has(contract.contractKey)) continue;
    seen.add(contract.contractKey);
    out.push(contract);
    if (out.length >= defaults.historicalSpreadMaxContracts) break;
  }
  return out;
}

function applyHistoricalSpreads(chains: NormalizedTickerChain[], spreadMap: Map<string, HistoricalSpreadMetrics>): void {
  for (const contract of chains.flatMap((chain) => chain.contracts)) {
    for (const key of spreadMetricKeys(contract)) {
      const metrics = spreadMap.get(key);
      if (metrics) {
        contract.rthSpread = metrics;
        break;
      }
    }
  }
}

async function resolveWatchlistContext(env: Env, input: OptionsRefreshRequest): Promise<{
  set: Pick<WatchlistSetDetail, "id" | "name" | "slug"> | null;
  runId: string | null;
  tickers: string[];
  names: Map<string, string | null>;
  warnings: string[];
}> {
  const manualTickers = uniqueTickers(input.tickers ?? []);
  if (manualTickers.length > 0) {
    return { set: null, runId: null, tickers: manualTickers, names: new Map(), warnings: [] };
  }
  const sets = await listWatchlistSets(env, false);
  const setId = input.setId?.trim() || sets[0]?.id;
  if (!setId) {
    return { set: null, runId: null, tickers: [], names: new Map(), warnings: ["No active TradingView watchlist set is configured."] };
  }
  const payload = await loadWatchlistUniqueRows(env, setId, input.runId ?? null);
  const names = new Map<string, string | null>();
  const tickers = uniqueTickers(payload.rows.map((row) => {
    names.set(row.ticker.toUpperCase(), row.displayName ?? null);
    return row.ticker;
  }));
  return {
    set: { id: payload.set.id, name: payload.set.name, slug: payload.set.slug },
    runId: payload.runId,
    tickers,
    names,
    warnings: tickers.length === 0 ? ["Selected watchlist run has no tickers."] : [],
  };
}

function limitTickers(env: Env, tickers: string[]): { tickers: string[]; warning: string | null } {
  const limit = envInt(env.OPTIONS_REFRESH_TICKER_LIMIT, DEFAULT_REFRESH_TICKER_LIMIT, 1, 500);
  if (tickers.length <= limit) return { tickers, warning: null };
  return {
    tickers: tickers.slice(0, limit),
    warning: `Options refresh limited to ${limit} tickers from ${tickers.length} requested tickers.`,
  };
}

function snapshotFromChain(input: {
  chain: NormalizedTickerChain;
  requestIdValue: string;
  watchlistSetId: string | null;
  watchlistSetName: string | null;
  watchlistRunId: string | null;
  latestRthSessionDate: string;
  expiresAt: string;
}): OptionChainSnapshot {
  return {
    id: rowId("opts"),
    requestId: input.requestIdValue,
    watchlistSetId: input.watchlistSetId,
    watchlistSetName: input.watchlistSetName,
    watchlistRunId: input.watchlistRunId,
    ticker: input.chain.ticker,
    provider: input.chain.provider,
    bridgeStatus: input.chain.bridgeStatus,
    underlyingPrice: input.chain.underlyingPrice,
    underlyingQuoteTime: input.chain.underlyingQuoteTime,
    optionsAvailable: input.chain.optionsAvailable,
    ivRank52w: input.chain.ivRank52w,
    ivPercentile52w: input.chain.ivPercentile52w,
    dataMode: input.chain.dataMode,
    latestRthSessionDate: input.latestRthSessionDate,
    contractCount: input.chain.contracts.length,
    candidateCount: 0,
    warnings: input.chain.warnings,
    rawSummary: input.chain.rawSummary,
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt,
  };
}

async function persistRefresh(env: Env, snapshots: OptionChainSnapshot[], candidates: OptionCandidateRow[]): Promise<void> {
  if (snapshots.length === 0) return;
  const statements = [
    ...snapshots.map((row) => env.DB.prepare(
      `INSERT INTO option_chain_snapshots (
        id, request_id, watchlist_set_id, watchlist_set_name, watchlist_run_id, ticker, provider, bridge_status,
        underlying_price, underlying_quote_time, options_available, iv_rank_52w, iv_percentile_52w, data_mode,
        latest_rth_session_date, contract_count, candidate_count, warnings_json, raw_summary_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id,
      row.requestId,
      row.watchlistSetId,
      row.watchlistSetName,
      row.watchlistRunId,
      row.ticker,
      row.provider,
      row.bridgeStatus,
      row.underlyingPrice,
      row.underlyingQuoteTime,
      row.optionsAvailable ? 1 : 0,
      row.ivRank52w,
      row.ivPercentile52w,
      row.dataMode,
      row.latestRthSessionDate,
      row.contractCount,
      row.candidateCount,
      jsonString(row.warnings),
      jsonString(row.rawSummary),
      row.createdAt,
      row.expiresAt,
    )),
    ...candidates.map((row) => env.DB.prepare(
      `INSERT INTO option_contract_quotes (
        id, snapshot_id, request_id, row_kind, watchlist_set_id, watchlist_run_id, ticker, strategy, contract_key,
        ibkr_con_id, local_symbol, expiry, strike, right, bid, ask, mid, last, volume, open_interest,
        iv, delta, gamma, theta, vega, quote_time, data_mode, rth_session_date, spread_basis,
        rth_last_bid, rth_last_ask, rth_median_spread_pct, rth_p75_spread_pct, rth_max_spread_pct,
        rth_sample_count, rth_first_sample_time, rth_last_sample_time, score_liquidity, score_spread,
        score_iv, score_strategy, score, debit, width, breakeven, max_loss, legs_json, score_inputs_json,
        warnings_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id,
      row.snapshotId,
      row.requestId,
      row.rowKind,
      row.watchlistSetId,
      row.watchlistRunId,
      row.ticker,
      row.strategy,
      row.contractKey,
      row.ibkrConId,
      row.localSymbol,
      row.expiry,
      row.strike,
      row.right,
      row.bid,
      row.ask,
      row.mid,
      row.last,
      row.volume,
      row.openInterest,
      row.iv,
      row.delta,
      row.gamma,
      row.theta,
      row.vega,
      row.quoteTime,
      row.dataMode,
      row.rthSessionDate,
      row.spreadBasis,
      row.rthLastBid,
      row.rthLastAsk,
      row.rthMedianSpreadPct,
      row.rthP75SpreadPct,
      row.rthMaxSpreadPct,
      row.rthSampleCount,
      row.rthFirstSampleTime,
      row.rthLastSampleTime,
      row.scoreLiquidity,
      row.scoreSpread,
      row.scoreIv,
      row.scoreStrategy,
      row.score,
      row.debit,
      row.width,
      row.breakeven,
      row.maxLoss,
      jsonString(row.legs),
      jsonString(row.scoreInputs),
      jsonString(row.warnings),
      row.createdAt,
      row.expiresAt,
    )),
  ];
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
}

type SnapshotRow = {
  id: string;
  requestId: string;
  watchlistSetId: string | null;
  watchlistSetName: string | null;
  watchlistRunId: string | null;
  ticker: string;
  provider: string;
  bridgeStatus: string;
  underlyingPrice: number | null;
  underlyingQuoteTime: string | null;
  optionsAvailable: number | boolean;
  ivRank52w: number | null;
  ivPercentile52w: number | null;
  dataMode: string | null;
  latestRthSessionDate: string | null;
  contractCount: number;
  candidateCount: number;
  warningsJson: string | null;
  rawSummaryJson: string | null;
  createdAt: string;
  expiresAt: string;
};

type CandidateDbRow = Omit<OptionCandidateRow, "warnings" | "legs" | "scoreInputs" | "optionsAvailable"> & {
  warningsJson: string | null;
  legsJson: string | null;
  scoreInputsJson: string | null;
};

function mapSnapshot(row: SnapshotRow): OptionChainSnapshot {
  return {
    id: row.id,
    requestId: row.requestId,
    watchlistSetId: row.watchlistSetId,
    watchlistSetName: row.watchlistSetName,
    watchlistRunId: row.watchlistRunId,
    ticker: row.ticker,
    provider: row.provider,
    bridgeStatus: row.bridgeStatus,
    underlyingPrice: row.underlyingPrice == null ? null : Number(row.underlyingPrice),
    underlyingQuoteTime: row.underlyingQuoteTime,
    optionsAvailable: Boolean(row.optionsAvailable),
    ivRank52w: row.ivRank52w == null ? null : Number(row.ivRank52w),
    ivPercentile52w: row.ivPercentile52w == null ? null : Number(row.ivPercentile52w),
    dataMode: row.dataMode,
    latestRthSessionDate: row.latestRthSessionDate,
    contractCount: Number(row.contractCount ?? 0),
    candidateCount: Number(row.candidateCount ?? 0),
    warnings: parseJsonArray(row.warningsJson),
    rawSummary: parseJsonObject(row.rawSummaryJson),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function mapCandidate(row: CandidateDbRow): OptionCandidateRow {
  return {
    ...row,
    rowKind: row.rowKind ?? "candidate",
    score: row.score == null ? null : Number(row.score),
    scoreLiquidity: row.scoreLiquidity == null ? null : Number(row.scoreLiquidity),
    scoreSpread: row.scoreSpread == null ? null : Number(row.scoreSpread),
    scoreIv: row.scoreIv == null ? null : Number(row.scoreIv),
    scoreStrategy: row.scoreStrategy == null ? null : Number(row.scoreStrategy),
    bid: row.bid == null ? null : Number(row.bid),
    ask: row.ask == null ? null : Number(row.ask),
    mid: row.mid == null ? null : Number(row.mid),
    last: row.last == null ? null : Number(row.last),
    volume: row.volume == null ? null : Number(row.volume),
    openInterest: row.openInterest == null ? null : Number(row.openInterest),
    iv: row.iv == null ? null : Number(row.iv),
    delta: row.delta == null ? null : Number(row.delta),
    gamma: row.gamma == null ? null : Number(row.gamma),
    theta: row.theta == null ? null : Number(row.theta),
    vega: row.vega == null ? null : Number(row.vega),
    strike: row.strike == null ? null : Number(row.strike),
    rthLastBid: row.rthLastBid == null ? null : Number(row.rthLastBid),
    rthLastAsk: row.rthLastAsk == null ? null : Number(row.rthLastAsk),
    rthMedianSpreadPct: row.rthMedianSpreadPct == null ? null : Number(row.rthMedianSpreadPct),
    rthP75SpreadPct: row.rthP75SpreadPct == null ? null : Number(row.rthP75SpreadPct),
    rthMaxSpreadPct: row.rthMaxSpreadPct == null ? null : Number(row.rthMaxSpreadPct),
    rthSampleCount: row.rthSampleCount == null ? null : Number(row.rthSampleCount),
    debit: row.debit == null ? null : Number(row.debit),
    width: row.width == null ? null : Number(row.width),
    breakeven: row.breakeven == null ? null : Number(row.breakeven),
    maxLoss: row.maxLoss == null ? null : Number(row.maxLoss),
    warnings: parseJsonArray(row.warningsJson),
    legs: parseJsonLegs(row.legsJson),
    scoreInputs: parseJsonObject(row.scoreInputsJson),
  };
}

async function loadLatestSnapshot(env: Env): Promise<OptionChainSnapshot | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT id, request_id as requestId, watchlist_set_id as watchlistSetId, watchlist_set_name as watchlistSetName,
              watchlist_run_id as watchlistRunId, ticker, provider, bridge_status as bridgeStatus,
              underlying_price as underlyingPrice, underlying_quote_time as underlyingQuoteTime,
              options_available as optionsAvailable, iv_rank_52w as ivRank52w, iv_percentile_52w as ivPercentile52w,
              data_mode as dataMode, latest_rth_session_date as latestRthSessionDate, contract_count as contractCount,
              candidate_count as candidateCount, warnings_json as warningsJson, raw_summary_json as rawSummaryJson,
              created_at as createdAt, expires_at as expiresAt
         FROM option_chain_snapshots
        ORDER BY datetime(created_at) DESC
        LIMIT 1`,
    ).first<SnapshotRow>();
    return row ? mapSnapshot(row) : null;
  } catch {
    return null;
  }
}

async function loadLatestCandidate(env: Env): Promise<OptionCandidateRow | null> {
  const rows = await loadCandidates(env, { limit: 1 });
  return rows[0] ?? null;
}

async function loadSnapshotsForTickers(env: Env, tickers: string[], setId?: string | null, runId?: string | null): Promise<Map<string, OptionChainSnapshot>> {
  const out = new Map<string, OptionChainSnapshot>();
  if (tickers.length === 0) return out;
  const clauses = [`ticker IN (${tickers.map(() => "?").join(",")})`];
  const args: unknown[] = [...tickers];
  if (setId) {
    clauses.push("watchlist_set_id = ?");
    args.push(setId);
  }
  if (runId) {
    clauses.push("watchlist_run_id = ?");
    args.push(runId);
  }
  const rows = await env.DB.prepare(
    `SELECT id, request_id as requestId, watchlist_set_id as watchlistSetId, watchlist_set_name as watchlistSetName,
            watchlist_run_id as watchlistRunId, ticker, provider, bridge_status as bridgeStatus,
            underlying_price as underlyingPrice, underlying_quote_time as underlyingQuoteTime,
            options_available as optionsAvailable, iv_rank_52w as ivRank52w, iv_percentile_52w as ivPercentile52w,
            data_mode as dataMode, latest_rth_session_date as latestRthSessionDate, contract_count as contractCount,
            candidate_count as candidateCount, warnings_json as warningsJson, raw_summary_json as rawSummaryJson,
            created_at as createdAt, expires_at as expiresAt
       FROM option_chain_snapshots
      WHERE ${clauses.join(" AND ")}
      ORDER BY datetime(created_at) DESC`,
  ).bind(...args).all<SnapshotRow>();
  for (const row of rows.results ?? []) {
    if (!out.has(row.ticker)) out.set(row.ticker, mapSnapshot(row));
  }
  return out;
}

async function loadCandidates(env: Env, options: {
  ticker?: string | null;
  setId?: string | null;
  runId?: string | null;
  strategy?: string | null;
  limit?: number;
  snapshotId?: string | null;
  rowKind?: "candidate" | "chain" | "all";
} = {}): Promise<OptionCandidateRow[]> {
  const clauses = ["datetime(expires_at) >= datetime('now')"];
  const args: unknown[] = [];
  if (options.rowKind !== "all") {
    clauses.push("row_kind = ?");
    args.push(options.rowKind ?? "candidate");
  }
  if (options.ticker) {
    clauses.push("ticker = ?");
    args.push(options.ticker.toUpperCase());
  }
  if (options.setId) {
    clauses.push("watchlist_set_id = ?");
    args.push(options.setId);
  }
  if (options.runId) {
    clauses.push("watchlist_run_id = ?");
    args.push(options.runId);
  }
  if (options.strategy) {
    clauses.push("strategy = ?");
    args.push(options.strategy);
  }
  if (options.snapshotId) {
    clauses.push("snapshot_id = ?");
    args.push(options.snapshotId);
  }
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
  const rows = await env.DB.prepare(
    `SELECT id, snapshot_id as snapshotId, request_id as requestId, row_kind as rowKind, watchlist_set_id as watchlistSetId,
            watchlist_run_id as watchlistRunId, ticker, strategy, contract_key as contractKey, ibkr_con_id as ibkrConId,
            local_symbol as localSymbol, expiry, strike, right, bid, ask, mid, last, volume, open_interest as openInterest,
            iv, delta, gamma, theta, vega, quote_time as quoteTime, data_mode as dataMode, rth_session_date as rthSessionDate,
            spread_basis as spreadBasis, rth_last_bid as rthLastBid, rth_last_ask as rthLastAsk,
            rth_median_spread_pct as rthMedianSpreadPct, rth_p75_spread_pct as rthP75SpreadPct,
            rth_max_spread_pct as rthMaxSpreadPct, rth_sample_count as rthSampleCount,
            rth_first_sample_time as rthFirstSampleTime, rth_last_sample_time as rthLastSampleTime,
            score_liquidity as scoreLiquidity, score_spread as scoreSpread, score_iv as scoreIv,
            score_strategy as scoreStrategy, score, debit, width, breakeven, max_loss as maxLoss,
            legs_json as legsJson, score_inputs_json as scoreInputsJson, warnings_json as warningsJson,
            created_at as createdAt, expires_at as expiresAt
       FROM option_contract_quotes
      WHERE ${clauses.join(" AND ")}
      ORDER BY
        CASE row_kind WHEN 'candidate' THEN 0 ELSE 1 END,
        score DESC,
        expiry ASC,
        right ASC,
        strike ASC,
        datetime(created_at) DESC
      LIMIT ${limit}`,
  ).bind(...args).all<CandidateDbRow>();
  return (rows.results ?? []).map(mapCandidate);
}

export async function cleanupOldOptionsData(env: Env, retention = retentionDays(env)): Promise<{ snapshotsDeleted: number; quotesDeleted: number }> {
  await ensureOptionsSchema(env);
  const cutoff = new Date(Date.now() - Math.max(1, retention) * 24 * 60 * 60_000).toISOString();
  const quotes = await env.DB.prepare(
    "DELETE FROM option_contract_quotes WHERE datetime(expires_at) < datetime('now') OR datetime(created_at) < datetime(?)",
  ).bind(cutoff).run();
  const snapshots = await env.DB.prepare(
    "DELETE FROM option_chain_snapshots WHERE datetime(expires_at) < datetime('now') OR datetime(created_at) < datetime(?)",
  ).bind(cutoff).run();
  return {
    snapshotsDeleted: Number(snapshots.meta?.changes ?? 0),
    quotesDeleted: Number(quotes.meta?.changes ?? 0),
  };
}

export async function maybeRunOptionsHousekeeping(env: Env, settings?: CronJobValues, now = new Date()): Promise<null | Awaited<ReturnType<typeof cleanupOldOptionsData>>> {
  if (settings && !isCentralCronEnabled(settings)) return null;
  if (!hasCentralCronIntervalElapsed(lastOptionsHousekeepingAt, settings ?? {}, OPTIONS_HOUSEKEEPING_INTERVAL_MINUTES, now)) return null;
  lastOptionsHousekeepingAt = now.toISOString();
  return cleanupOldOptionsData(env, settings ? Number(settings.retentionDays ?? retentionDays(env)) : retentionDays(env));
}

export async function loadOptionsStatus(env: Env): Promise<OptionsStatusResponse> {
  await ensureOptionsSchema(env);
  const bridge = await fetchBridgeHealth(env);
  const [latestSnapshot, latestCandidate] = await Promise.all([
    loadLatestSnapshot(env),
    loadLatestCandidate(env),
  ]);
  const warnings: string[] = [];
  if (!bridge.enabled) warnings.push("IBKR options bridge is disabled.");
  if (bridge.enabled && !bridge.configured) warnings.push("IBKR options bridge endpoint is not configured.");
  if (bridge.enabled && bridge.configured && !bridge.reachable) warnings.push("IBKR options bridge is unreachable.");
  if (bridge.authenticated === false) warnings.push("IBKR session is not authenticated.");
  if (bridge.marketDataEntitled === false) warnings.push("IBKR market-data entitlement check failed.");
  const troubleshooting = [
    { key: "configured", label: "Bridge endpoint configured", ok: bridge.configured, detail: bridge.configured ? null : "Set IBKR_OPTIONS_ENDPOINT." },
    { key: "enabled", label: "Bridge enabled", ok: bridge.enabled, detail: bridge.enabled ? null : "Set IBKR_OPTIONS_ENABLED=true." },
    { key: "reachable", label: "Tunnel reachable", ok: bridge.reachable, detail: bridge.lastError },
    { key: "bridge", label: "Bridge service running", ok: bridge.bridgeRunning ?? bridge.reachable, detail: null },
    { key: "gateway", label: "IB Gateway running", ok: bridge.ibGatewayRunning ?? false, detail: bridge.ibGatewayRunning == null ? "Bridge did not report gateway state." : null },
    { key: "auth", label: "IBKR authenticated", ok: bridge.authenticated ?? false, detail: bridge.authenticated == null ? "Bridge did not report auth state." : null },
    { key: "entitlement", label: "Market-data entitlement", ok: bridge.marketDataEntitled ?? false, detail: bridge.marketDataEntitled == null ? "Bridge did not report entitlement state." : null },
    { key: "tick", label: "Latest quote/tick received", ok: Boolean(bridge.latestTickAt), detail: bridge.latestTickAt },
    { key: "pacing", label: "Historical tick pacing state", ok: bridge.historicalPacing !== "limited", detail: bridge.historicalPacing },
    { key: "probe", label: "Last successful contract probe", ok: Boolean(bridge.lastSuccessfulProbeAt), detail: bridge.lastSuccessfulProbeAt },
  ];
  return {
    ok: warnings.length === 0,
    bridge,
    marketSession: getUsMarketSessionContext(),
    latestSnapshot,
    latestCandidate,
    troubleshooting,
    warnings,
  };
}

export async function refreshOptionsForWatchlist(env: Env, input: OptionsRefreshRequest = {}): Promise<OptionsRefreshResponse> {
  await ensureOptionsSchema(env);
  await cleanupOldOptionsData(env).catch((error) => console.warn("options cleanup before refresh failed", error));
  const id = requestId();
  const warnings: string[] = [];
  const context = await resolveWatchlistContext(env, input);
  warnings.push(...context.warnings);
  const limited = limitTickers(env, context.tickers);
  if (limited.warning) warnings.push(limited.warning);
  const tickers = limited.tickers;
  if (!optionsEnabled(env) || !optionsEndpoint(env)) {
    warnings.push(!optionsEnabled(env) ? "IBKR options bridge is disabled." : "IBKR options bridge endpoint is not configured.");
    return {
      ok: false,
      requestId: id,
      set: context.set,
      runId: context.runId,
      requestedTickers: context.tickers.length,
      refreshedTickers: 0,
      snapshots: [],
      candidates: [],
      warnings,
    };
  }
  if (tickers.length === 0) {
    return {
      ok: false,
      requestId: id,
      set: context.set,
      runId: context.runId,
      requestedTickers: 0,
      refreshedTickers: 0,
      snapshots: [],
      candidates: [],
      warnings,
    };
  }

  const defaults = refreshDefaults(env, input);
  const session = getUsMarketSessionContext();
  const latestRthSessionDate = session.latestCompletedSessionDate;
  const exp = expiresAtIso(env);
  const chains = await fetchChains(env, tickers, defaults);
  const returnedTickers = new Set(chains.map((chain) => chain.ticker));
  for (const ticker of tickers) {
    if (!returnedTickers.has(ticker)) warnings.push(`Bridge returned no options chain for ${ticker}.`);
  }

  if (input.includeHistoricalSpreads !== false) {
    const spreadProbeContracts = selectContractsForSpreadProbe(chains, defaults);
    if (spreadProbeContracts.length > 0) {
      try {
        const spreads = await fetchHistoricalSpreads(env, spreadProbeContracts, latestRthSessionDate, defaults.historicalSpreadSampleTarget);
        applyHistoricalSpreads(chains, spreads);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : "Historical BID_ASK spread probe failed.");
      }
    }
  }

  const snapshots: OptionChainSnapshot[] = chains.map((chain) => snapshotFromChain({
    chain,
    requestIdValue: id,
    watchlistSetId: context.set?.id ?? null,
    watchlistSetName: context.set?.name ?? null,
    watchlistRunId: context.runId,
    latestRthSessionDate,
    expiresAt: exp,
  }));
  const snapshotByTicker = new Map(snapshots.map((snapshot) => [snapshot.ticker, snapshot]));
  const candidates = chains.flatMap((chain) => {
    const snapshot = snapshotByTicker.get(chain.ticker);
    if (!snapshot) return [];
    const rows = buildCandidates({
      chain,
      snapshotId: snapshot.id,
      requestIdValue: id,
      watchlistSetId: context.set?.id ?? null,
      watchlistRunId: context.runId,
      defaults,
      latestRthSessionDate,
      expiresAt: exp,
    });
    snapshot.candidateCount = rows.length;
    return rows;
  });
  const chainRows = input.persistChainRows
    ? chains.flatMap((chain) => {
      const snapshot = snapshotByTicker.get(chain.ticker);
      if (!snapshot) return [];
      const excluded = new Set(
        candidates
          .filter((row) => row.ticker === chain.ticker && !row.contractKey.includes("|"))
          .map((row) => row.contractKey),
      );
      return buildChainRows({
        chain,
        snapshotId: snapshot.id,
        requestIdValue: id,
        watchlistSetId: context.set?.id ?? null,
        watchlistRunId: context.runId,
        defaults,
        latestRthSessionDate,
        expiresAt: exp,
        excludeContractKeys: excluded,
      });
    })
    : [];
  await persistRefresh(env, snapshots, [...candidates, ...chainRows]);
  return {
    ok: true,
    requestId: id,
    set: context.set,
    runId: context.runId,
    requestedTickers: context.tickers.length,
    refreshedTickers: snapshots.length,
    snapshots,
    candidates,
    warnings,
  };
}

export async function loadOptionsWatchlist(env: Env, input: { setId?: string | null; runId?: string | null } = {}): Promise<OptionsWatchlistResponse> {
  await ensureOptionsSchema(env);
  const context = await resolveWatchlistContext(env, { setId: input.setId, runId: input.runId });
  const snapshots = await loadSnapshotsForTickers(env, context.tickers, context.set?.id ?? null, context.runId);
  const rows = await Promise.all(context.tickers.map(async (ticker) => {
    const snapshot = snapshots.get(ticker) ?? null;
    const candidates = await loadCandidates(env, { ticker, setId: context.set?.id ?? null, runId: context.runId, limit: 1 });
    return {
      ticker,
      companyName: context.names.get(ticker) ?? null,
      snapshot,
      candidateCount: snapshot?.candidateCount ?? 0,
      topScore: candidates[0]?.score ?? null,
      warnings: snapshot?.warnings ?? [],
    };
  }));
  return {
    ok: context.warnings.length === 0,
    set: context.set,
    runId: context.runId,
    rows,
    warnings: context.warnings,
  };
}

export async function loadOptionsChain(env: Env, tickerInput: string, input: { setId?: string | null; runId?: string | null } = {}): Promise<OptionsChainResponse> {
  await ensureOptionsSchema(env);
  const ticker = uniqueTickers([tickerInput])[0];
  if (!ticker) return { ok: false, ticker: tickerInput, snapshot: null, rows: [], warnings: ["Invalid ticker."] };
  const snapshotMap = await loadSnapshotsForTickers(env, [ticker], input.setId, input.runId);
  const snapshot = snapshotMap.get(ticker) ?? null;
  const rows = await loadCandidates(env, {
    ticker,
    setId: input.setId ?? snapshot?.watchlistSetId ?? null,
    runId: input.runId ?? snapshot?.watchlistRunId ?? null,
    snapshotId: snapshot?.id ?? null,
    rowKind: "all",
    limit: 300,
  });
  const warnings = snapshot ? snapshot.warnings : ["No stored options refresh for this ticker. Run an options refresh first."];
  return { ok: Boolean(snapshot), ticker, snapshot, rows, warnings };
}

export async function loadOptionsCandidates(env: Env, input: {
  setId?: string | null;
  runId?: string | null;
  strategy?: string | null;
  limit?: number;
} = {}): Promise<OptionsCandidatesResponse> {
  await ensureOptionsSchema(env);
  const rows = await loadCandidates(env, {
    setId: input.setId,
    runId: input.runId,
    strategy: input.strategy,
    limit: input.limit ?? 200,
  });
  const grouped: Record<OptionsStrategy, OptionCandidateRow[]> = {
    long_call: [],
    long_put: [],
    call_debit_spread: [],
    put_debit_spread: [],
  };
  for (const row of rows) {
    grouped[row.strategy].push(row);
  }
  return { ok: true, rows, grouped, warnings: rows.length === 0 ? ["No stored options candidates match the current filters."] : [] };
}
