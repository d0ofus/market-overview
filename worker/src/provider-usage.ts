import type { Env } from "./types";
import { getOpsDb, isOpsDbRequired, OpsDbUnavailableError } from "./ops-db";

export type ProviderUsageMeta = {
  providerKey: string;
  endpointKey: string;
  caller: string;
  symbolCount?: number;
  rowCount?: number;
  cacheHit?: boolean;
};

export type ProviderUsageResult = {
  ok?: boolean;
  status?: number | null;
  error?: unknown;
  durationMs?: number;
  requestCount?: number;
  successCount?: number;
  errorCount?: number;
  rateLimitedCount?: number;
  timeoutCount?: number;
  symbolCount?: number;
  rowCount?: number;
  cacheHitCount?: number;
};

export type ProviderUsageDailyRow = {
  usageDay: string;
  providerKey: string;
  endpointKey: string;
  caller: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  rateLimitedCount: number;
  timeoutCount: number;
  symbolCount: number;
  rowCount: number;
  cacheHitCount: number;
  totalDurationMs: number;
  lastStatus: number | null;
  lastError: string | null;
  lastCalledAt: string | null;
  updatedAt: string;
};

export type ProviderUsageWarning = {
  providerKey: string;
  level: "warn" | "hard";
  message: string;
  requestCount: number;
  limit: number;
  window: "minute" | "day";
};

export type AdminProviderUsageResponse = {
  days: number;
  rows: ProviderUsageDailyRow[];
  totalsByProvider: Array<{
    providerKey: string;
    requestCount: number;
    successCount: number;
    errorCount: number;
    rateLimitedCount: number;
    timeoutCount: number;
    symbolCount: number;
    rowCount: number;
    cacheHitCount: number;
    totalDurationMs: number;
  }>;
  totals: {
    requestCount: number;
    successCount: number;
    errorCount: number;
    rateLimitedCount: number;
    timeoutCount: number;
    symbolCount: number;
    rowCount: number;
    cacheHitCount: number;
    totalDurationMs: number;
  };
  latestSamples: Array<{
    usageDay: string;
    providerKey: string;
    endpointKey: string;
    caller: string;
    lastStatus: number | null;
    lastError: string | null;
    lastCalledAt: string | null;
  }>;
  budgetWarnings: ProviderUsageWarning[];
};

export class ProviderBudgetExceededError extends Error {
  readonly code = "provider-budget-exhausted";

  constructor(
    readonly providerKey: string,
    readonly limit: number,
    readonly window: "minute" | "day",
  ) {
    super(`Provider budget exceeded for ${providerKey}: ${limit}/${window}.`);
    this.name = "ProviderBudgetExceededError";
  }
}

export class ProviderBudgetUnavailableError extends Error {
  readonly code = "provider-budget-unavailable";

  constructor(readonly providerKey: string, cause?: unknown) {
    super(`Provider budget storage is unavailable for ${providerKey}; request was not sent.`);
    this.name = "ProviderBudgetUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}

export type ProviderRequestFailureCode =
  | "provider-timeout"
  | "provider-http-error"
  | "provider-invalid-payload";

export class ProviderRequestFailureError extends Error {
  constructor(
    readonly code: ProviderRequestFailureCode,
    message: string,
    readonly status: number | null = null,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderRequestFailureError";
    if (cause !== undefined) this.cause = cause;
  }
}

const DEFAULT_BUDGETS = {
  alpacaMinuteWarn: 150,
  alpacaMinuteHard: 160,
  // TradingView and Yahoo limits are deployment-profile choices. Production
  // config sets the approved 6/minute, 400/day, and 250/day ceilings; keeping
  // the library defaults disabled avoids silently imposing that profile on
  // tests and alternate deployments that have not opted in.
  tradingViewMinuteWarn: 0,
  tradingViewMinuteHard: 0,
  tradingViewDayHard: 0,
  yahooDayHard: 0,
  fmpDayWarn: 200,
  fmpDayHard: 240,
  alphaVantageDayWarn: 20,
  alphaVantageDayHard: 24,
  finnhubMinuteWarn: 45,
  finnhubMinuteHard: 55,
};

const minuteCountersByEnv = new WeakMap<object, Map<string, number>>();
const providerCircuitsByEnv = new WeakMap<object, Map<string, { failures: number; openUntil: number }>>();
const PROVIDER_CIRCUIT_FAILURE_THRESHOLD = 3;
const PROVIDER_CIRCUIT_OPEN_MS = 2 * 60_000;

function minuteCountersFor(env: Env): Map<string, number> {
  const key = env as object;
  let counters = minuteCountersByEnv.get(key);
  if (!counters) {
    counters = new Map<string, number>();
    minuteCountersByEnv.set(key, counters);
  }
  return counters;
}

function providerCircuitFor(env: Env, providerKey: string): { failures: number; openUntil: number } {
  const envKey = env as object;
  let circuits = providerCircuitsByEnv.get(envKey);
  if (!circuits) {
    circuits = new Map();
    providerCircuitsByEnv.set(envKey, circuits);
  }
  const key = normalizeKey(providerKey);
  let circuit = circuits.get(key);
  if (!circuit) {
    circuit = { failures: 0, openUntil: 0 };
    circuits.set(key, circuit);
  }
  return circuit;
}

function updateProviderCircuit(circuit: { failures: number; openUntil: number }, failed: boolean, now: number): void {
  if (!failed) {
    circuit.failures = 0;
    circuit.openUntil = 0;
    return;
  }
  circuit.failures += 1;
  if (circuit.failures >= PROVIDER_CIRCUIT_FAILURE_THRESHOLD) {
    circuit.openUntil = now + PROVIDER_CIRCUIT_OPEN_MS;
  }
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._/-]+/g, "-") || "unknown";
}

function envInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.trunc(parsed));
}

function providerBudget(env: Env, providerKey: string): { warn: number; hard: number; window: "minute" | "day" } | null {
  const key = normalizeKey(providerKey);
  if (key === "alpaca") {
    return {
      warn: envInt(env.ALPACA_REQUESTS_PER_MINUTE_WARN, DEFAULT_BUDGETS.alpacaMinuteWarn),
      hard: envInt(env.ALPACA_REQUESTS_PER_MINUTE_HARD, DEFAULT_BUDGETS.alpacaMinuteHard),
      window: "minute",
    };
  }
  if (key === "fmp" || key === "financialmodelingprep") {
    return {
      warn: envInt(env.FMP_REQUESTS_PER_DAY_WARN, DEFAULT_BUDGETS.fmpDayWarn),
      hard: envInt(env.FMP_REQUESTS_PER_DAY_HARD, DEFAULT_BUDGETS.fmpDayHard),
      window: "day",
    };
  }
  if (key === "alpha-vantage" || key === "alphavantage") {
    return {
      warn: envInt(env.ALPHA_VANTAGE_REQUESTS_PER_DAY_WARN, DEFAULT_BUDGETS.alphaVantageDayWarn),
      hard: envInt(env.ALPHA_VANTAGE_REQUESTS_PER_DAY_HARD, DEFAULT_BUDGETS.alphaVantageDayHard),
      window: "day",
    };
  }
  if (key === "finnhub") {
    return {
      warn: envInt(env.FINNHUB_REQUESTS_PER_MINUTE_WARN, DEFAULT_BUDGETS.finnhubMinuteWarn),
      hard: envInt(env.FINNHUB_REQUESTS_PER_MINUTE_HARD, DEFAULT_BUDGETS.finnhubMinuteHard),
      window: "minute",
    };
  }
  if (key === "tradingview" || key === "trading-view") {
    return {
      warn: envInt(env.TRADINGVIEW_REQUESTS_PER_MINUTE_WARN, DEFAULT_BUDGETS.tradingViewMinuteWarn),
      hard: envInt(env.TRADINGVIEW_REQUESTS_PER_MINUTE_HARD, DEFAULT_BUDGETS.tradingViewMinuteHard),
      window: "minute",
    };
  }
  if (key === "yahoo") {
    const hard = envInt(env.YAHOO_REQUESTS_PER_DAY_HARD, DEFAULT_BUDGETS.yahooDayHard);
    return { warn: Math.max(0, Math.floor(hard * 0.8)), hard, window: "day" };
  }
  if (key === "nasdaqtrader" || key === "sp500-public-proxy") {
    return { warn: 3, hard: 4, window: "day" };
  }
  if (key === "ishares") {
    return { warn: 4, hard: 6, window: "day" };
  }
  return null;
}

function usageDb(env: Env): D1Database | null {
  try {
    const db = getOpsDb(env);
    return db && typeof db.prepare === "function" ? db : null;
  } catch (error) {
    if (error instanceof OpsDbUnavailableError) return null;
    throw error;
  }
}

function reservationDb(env: Env): D1Database | null {
  const db = env.OPS_DB;
  return db && typeof db.prepare === "function" ? db : null;
}

function isMissingUsageTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /provider_(?:usage_daily|budget_counters)|no such table|\.prepare is not a function|\.run is not a function|\.first is not a function/i.test(message);
}

function classifyTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return error.name === "AbortError" || message.includes("timed out") || message.includes("timeout");
}

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

async function checkBudgetBeforeFetch(env: Env, providerKey: string, now: Date): Promise<void> {
  const budget = providerBudget(env, providerKey);
  if (!budget || budget.hard <= 0) return;
  const key = normalizeKey(providerKey);
  const windowBucket = budget.window === "minute"
    ? now.toISOString().slice(0, 16)
    : now.toISOString().slice(0, 10);
  const db = reservationDb(env);
  if (db) {
    try {
      const reservation = await db.prepare(
        `INSERT INTO provider_budget_counters
           (provider_key, window_kind, window_bucket, request_count, updated_at)
         VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(provider_key, window_kind, window_bucket) DO UPDATE SET
           request_count = provider_budget_counters.request_count + 1,
           updated_at = CURRENT_TIMESTAMP
         WHERE provider_budget_counters.request_count < ?`,
      ).bind(key, budget.window, windowBucket, budget.hard).run();
      if (Number(reservation.meta?.changes ?? 0) <= 0) {
        throw new ProviderBudgetExceededError(key, budget.hard, budget.window);
      }
      return;
    } catch (error) {
      if (error instanceof ProviderBudgetExceededError) throw error;
      if (isOpsDbRequired(env) || !isMissingUsageTable(error)) {
        throw new ProviderBudgetUnavailableError(key, error);
      }
    }
  } else if (isOpsDbRequired(env)) {
    throw new ProviderBudgetUnavailableError(key);
  }

  // Local/test compatibility only. Production requires OPS_DB and never uses
  // isolate-local counters for a provider reservation.
  const counterKey = `${key}|${budget.window}|${windowBucket}`;
  const counters = minuteCountersFor(env);
  const used = counters.get(counterKey) ?? 0;
  if (used >= budget.hard) throw new ProviderBudgetExceededError(key, budget.hard, budget.window);
  counters.set(counterKey, used + 1);
}

export async function recordProviderUsage(
  env: Env,
  meta: ProviderUsageMeta,
  result: ProviderUsageResult = {},
): Promise<void> {
  const db = usageDb(env);
  if (!db) return;
  const nowIso = new Date().toISOString();
  const providerKey = normalizeKey(meta.providerKey);
  const endpointKey = normalizeKey(meta.endpointKey);
  const caller = normalizeKey(meta.caller);
  const requestCount = result.requestCount ?? (meta.cacheHit || result.cacheHitCount ? 0 : 1);
  const status = typeof result.status === "number" ? result.status : null;
  const timeoutCount = result.timeoutCount ?? (classifyTimeout(result.error) ? 1 : 0);
  const rateLimitedCount = result.rateLimitedCount ?? (status === 429 ? 1 : 0);
  const successCount = result.successCount ?? (result.ok === true ? 1 : 0);
  const errorCount = result.errorCount ?? (requestCount > 0 && successCount === 0 ? 1 : 0);
  const cacheHitCount = result.cacheHitCount ?? (meta.cacheHit ? 1 : 0);
  const symbolCount = result.symbolCount ?? meta.symbolCount ?? 0;
  const rowCount = result.rowCount ?? meta.rowCount ?? 0;
  const totalDurationMs = Math.max(0, Math.round(result.durationMs ?? 0));
  const lastCalledAt = requestCount > 0 ? nowIso : null;
  const lastError = errorMessage(result.error);
  try {
    await db.prepare(
      `INSERT INTO provider_usage_daily
         (usage_day, provider_key, endpoint_key, caller, request_count, success_count, error_count, rate_limited_count, timeout_count, symbol_count, row_count, cache_hit_count, total_duration_ms, last_status, last_error, last_called_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(usage_day, provider_key, endpoint_key, caller) DO UPDATE SET
         request_count = provider_usage_daily.request_count + excluded.request_count,
         success_count = provider_usage_daily.success_count + excluded.success_count,
         error_count = provider_usage_daily.error_count + excluded.error_count,
         rate_limited_count = provider_usage_daily.rate_limited_count + excluded.rate_limited_count,
         timeout_count = provider_usage_daily.timeout_count + excluded.timeout_count,
         symbol_count = provider_usage_daily.symbol_count + excluded.symbol_count,
         row_count = provider_usage_daily.row_count + excluded.row_count,
         cache_hit_count = provider_usage_daily.cache_hit_count + excluded.cache_hit_count,
         total_duration_ms = provider_usage_daily.total_duration_ms + excluded.total_duration_ms,
         last_status = COALESCE(excluded.last_status, provider_usage_daily.last_status),
         last_error = COALESCE(excluded.last_error, provider_usage_daily.last_error),
         last_called_at = COALESCE(excluded.last_called_at, provider_usage_daily.last_called_at),
         updated_at = excluded.updated_at`,
    )
      .bind(
        nowIso.slice(0, 10),
        providerKey,
        endpointKey,
        caller,
        requestCount,
        successCount,
        errorCount,
        rateLimitedCount,
        timeoutCount,
        symbolCount,
        rowCount,
        cacheHitCount,
        totalDurationMs,
        status,
        lastError,
        lastCalledAt,
        nowIso,
      )
      .run();
  } catch (error) {
    if (!isMissingUsageTable(error)) {
      console.warn("Provider usage logging failed", { providerKey, endpointKey, caller, error });
    }
  }
}

export async function cleanupProviderUsage(env: Env, now = new Date()): Promise<void> {
  const db = usageDb(env);
  if (!db) return;
  const minuteCutoff = new Date(now.getTime() - 2 * 24 * 60 * 60_000).toISOString().slice(0, 16);
  const dailyCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const detailedCutoff = new Date(now.getTime() - 14 * 24 * 60 * 60_000).toISOString();
  const runBatches = async (sql: string, bindings: unknown[], limit: number, maxBatches = 50): Promise<void> => {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await db.prepare(sql).bind(...bindings).run();
      const changes = Number(result.meta?.changes ?? result.meta?.rows_written ?? 0);
      if (changes < limit) return;
    }
  };
  try {
    await runBatches(
      `DELETE FROM provider_budget_counters WHERE (provider_key, window_kind, window_bucket) IN (
         SELECT provider_key, window_kind, window_bucket FROM provider_budget_counters
          WHERE window_kind = 'minute' AND window_bucket < ? ORDER BY window_bucket LIMIT 500
       )`, [minuteCutoff], 500,
    );
    await runBatches(
      `DELETE FROM provider_budget_counters WHERE (provider_key, window_kind, window_bucket) IN (
         SELECT provider_key, window_kind, window_bucket FROM provider_budget_counters
          WHERE window_kind = 'day' AND window_bucket < ? ORDER BY window_bucket LIMIT 500
       )`, [dailyCutoff], 500,
    );
    await runBatches(
      `DELETE FROM provider_usage_daily WHERE (usage_day, provider_key, endpoint_key, caller) IN (
         SELECT usage_day, provider_key, endpoint_key, caller FROM provider_usage_daily
          WHERE usage_day < ? ORDER BY usage_day LIMIT 500
       )`, [dailyCutoff], 500,
    );
    await runBatches("DELETE FROM scheduled_job_runs WHERE id IN (SELECT id FROM scheduled_job_runs WHERE started_at < ? ORDER BY started_at LIMIT 500)", [detailedCutoff], 500);
    await runBatches("DELETE FROM market_pipeline_runs WHERE id IN (SELECT id FROM market_pipeline_runs WHERE started_at < ? ORDER BY started_at LIMIT 500)", [detailedCutoff], 500);
    await runBatches("DELETE FROM capacity_health_samples WHERE id IN (SELECT id FROM capacity_health_samples WHERE observed_at < datetime('now', '-90 days') ORDER BY observed_at LIMIT 500)", [], 500);
    await runBatches("DELETE FROM market_data_daily_usage WHERE usage_date IN (SELECT usage_date FROM market_data_daily_usage WHERE usage_date < ? ORDER BY usage_date LIMIT 500)", [dailyCutoff], 500);
    await runBatches(
      `DELETE FROM post_close_daily_bar_refresh_job_items
        WHERE (job_id, ticker) IN (
          SELECT item.job_id, item.ticker FROM post_close_daily_bar_refresh_job_items item
          JOIN post_close_daily_bar_refresh_jobs job ON job.id = item.job_id
          WHERE job.status IN ('completed', 'failed', 'superseded') AND job.updated_at < ?
          ORDER BY job.updated_at, item.ordinal LIMIT 1000
        )`, [detailedCutoff], 1000,
    );
    await runBatches(
      `DELETE FROM post_close_daily_bar_refresh_jobs
        WHERE id IN (
          SELECT job.id FROM post_close_daily_bar_refresh_jobs job
          WHERE job.status IN ('completed', 'failed', 'superseded') AND job.updated_at < ?
            AND NOT EXISTS (SELECT 1 FROM post_close_daily_bar_refresh_job_items item WHERE item.job_id = job.id)
          ORDER BY job.updated_at LIMIT 100
        )`, [detailedCutoff], 100,
    );
  } catch (error) {
    if (!isMissingUsageTable(error)) throw error;
  }
}

export async function meteredFetch(
  env: Env,
  input: RequestInfo | URL,
  init: RequestInit = {},
  meta: ProviderUsageMeta,
  timeoutMs?: number,
): Promise<Response> {
  const startedAt = Date.now();
  const providerKey = normalizeKey(meta.providerKey);
  const circuit = providerCircuitFor(env, providerKey);
  if (circuit.openUntil > startedAt) {
    const retryAfterSeconds = Math.max(1, Math.ceil((circuit.openUntil - startedAt) / 1000));
    throw new Error(`Provider circuit open for ${providerKey}; retry-after=${retryAfterSeconds}`);
  }
  await checkBudgetBeforeFetch(env, meta.providerKey, new Date(startedAt));
  const controller = timeoutMs ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller?.signal ?? init.signal,
    });
    await recordProviderUsage(env, meta, {
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    updateProviderCircuit(
      circuit,
      response.status === 403 || response.status === 429 || response.status >= 500,
      Date.now(),
    );
    return response;
  } catch (error) {
    const mapped = controller && classifyTimeout(error)
      ? new ProviderRequestFailureError(
          "provider-timeout",
          `Provider fetch timed out after ${timeoutMs}ms.`,
          null,
          error,
        )
      : error;
    await recordProviderUsage(env, meta, {
      ok: false,
      status: null,
      durationMs: Date.now() - startedAt,
      error: mapped,
    });
    updateProviderCircuit(circuit, true, Date.now());
    throw mapped;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function providerRetryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers?.get?.("Retry-After")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(15_000, Math.max(0, seconds * 1000));
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.min(15_000, Math.max(0, timestamp - Date.now()));
  }
  return Math.min(8_000, 500 * 2 ** Math.max(0, attempt - 1) + Math.floor(Math.random() * 250));
}

export async function meteredFetchWithRetry(
  env: Env,
  input: RequestInfo | URL,
  init: RequestInit,
  meta: ProviderUsageMeta,
  timeoutMs = 8_000,
  maxAttempts = 3,
): Promise<Response> {
  const attempts = Math.max(1, Math.min(3, Math.trunc(maxAttempts)));
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await meteredFetch(env, input, init, meta, timeoutMs);
      const status = Number(response.status);
      const retryable = Number.isFinite(status)
        ? status === 403 || status === 429 || status >= 500
        : response.ok === false;
      if (!retryable) return response;
      if (attempt === attempts) return response;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error ?? "");
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (
        code === "provider-budget-exhausted"
        || code === "provider-budget-unavailable"
        || /provider budget exceeded|provider circuit open/i.test(message)
        || attempt === attempts
      ) throw error;
    }
    const delayMs = providerRetryDelayMs(response, attempt);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Provider request failed after bounded retries.");
}

function emptyTotals() {
  return {
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    rateLimitedCount: 0,
    timeoutCount: 0,
    symbolCount: 0,
    rowCount: 0,
    cacheHitCount: 0,
    totalDurationMs: 0,
  };
}

function rowToUsage(row: ProviderUsageDailyRow): ProviderUsageDailyRow {
  return {
    usageDay: row.usageDay,
    providerKey: row.providerKey,
    endpointKey: row.endpointKey,
    caller: row.caller,
    requestCount: Number(row.requestCount ?? 0),
    successCount: Number(row.successCount ?? 0),
    errorCount: Number(row.errorCount ?? 0),
    rateLimitedCount: Number(row.rateLimitedCount ?? 0),
    timeoutCount: Number(row.timeoutCount ?? 0),
    symbolCount: Number(row.symbolCount ?? 0),
    rowCount: Number(row.rowCount ?? 0),
    cacheHitCount: Number(row.cacheHitCount ?? 0),
    totalDurationMs: Number(row.totalDurationMs ?? 0),
    lastStatus: row.lastStatus == null ? null : Number(row.lastStatus),
    lastError: row.lastError ?? null,
    lastCalledAt: row.lastCalledAt ?? null,
    updatedAt: row.updatedAt,
  };
}

function addUsageTotals(target: ReturnType<typeof emptyTotals>, row: ProviderUsageDailyRow): void {
  target.requestCount += row.requestCount;
  target.successCount += row.successCount;
  target.errorCount += row.errorCount;
  target.rateLimitedCount += row.rateLimitedCount;
  target.timeoutCount += row.timeoutCount;
  target.symbolCount += row.symbolCount;
  target.rowCount += row.rowCount;
  target.cacheHitCount += row.cacheHitCount;
  target.totalDurationMs += row.totalDurationMs;
}

function computeBudgetWarnings(env: Env, rows: ProviderUsageDailyRow[], now: Date): ProviderUsageWarning[] {
  const today = now.toISOString().slice(0, 10);
  const byProvider = new Map<string, number>();
  for (const row of rows) {
    if (row.usageDay !== today) continue;
    byProvider.set(row.providerKey, (byProvider.get(row.providerKey) ?? 0) + row.requestCount);
  }
  const warnings: ProviderUsageWarning[] = [];
  for (const [providerKey, requestCount] of byProvider) {
    const budget = providerBudget(env, providerKey);
    if (!budget || budget.window !== "day") continue;
    if (budget.hard > 0 && requestCount >= budget.hard) {
      warnings.push({
        providerKey,
        level: "hard",
        requestCount,
        limit: budget.hard,
        window: budget.window,
        message: `${providerKey} daily hard budget reached (${requestCount}/${budget.hard}).`,
      });
    } else if (budget.warn > 0 && requestCount >= budget.warn) {
      warnings.push({
        providerKey,
        level: "warn",
        requestCount,
        limit: budget.warn,
        window: budget.window,
        message: `${providerKey} daily warning budget reached (${requestCount}/${budget.warn}).`,
      });
    }
  }
  for (const row of rows) {
    if (row.rateLimitedCount > 0) {
      warnings.push({
        providerKey: row.providerKey,
        level: "warn",
        requestCount: row.rateLimitedCount,
        limit: 0,
        window: "day",
        message: `${row.providerKey}/${row.endpointKey}/${row.caller} saw ${row.rateLimitedCount} rate-limited responses.`,
      });
    }
  }
  return warnings;
}

export async function loadProviderUsageDaily(env: Env, daysInput = 14, now = new Date()): Promise<AdminProviderUsageResponse> {
  const days = Math.max(1, Math.min(90, Math.floor(Number(daysInput) || 14)));
  const cutoff = new Date(now.getTime() - (days - 1) * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const db = usageDb(env);
  if (!db) {
    return {
      days,
      rows: [],
      totalsByProvider: [],
      totals: emptyTotals(),
      latestSamples: [],
      budgetWarnings: [],
    };
  }
  try {
    const result = await db.prepare(
      `SELECT usage_day as usageDay,
              provider_key as providerKey,
              endpoint_key as endpointKey,
              caller,
              request_count as requestCount,
              success_count as successCount,
              error_count as errorCount,
              rate_limited_count as rateLimitedCount,
              timeout_count as timeoutCount,
              symbol_count as symbolCount,
              row_count as rowCount,
              cache_hit_count as cacheHitCount,
              total_duration_ms as totalDurationMs,
              last_status as lastStatus,
              last_error as lastError,
              last_called_at as lastCalledAt,
              updated_at as updatedAt
         FROM provider_usage_daily
        WHERE usage_day >= ?
        ORDER BY usage_day DESC, provider_key ASC, endpoint_key ASC, caller ASC`,
    ).bind(cutoff).all<ProviderUsageDailyRow>();
    const rows = (result.results ?? []).map(rowToUsage);
    const totals = emptyTotals();
    const byProvider = new Map<string, ReturnType<typeof emptyTotals>>();
    for (const row of rows) {
      addUsageTotals(totals, row);
      const providerTotals = byProvider.get(row.providerKey) ?? emptyTotals();
      addUsageTotals(providerTotals, row);
      byProvider.set(row.providerKey, providerTotals);
    }
    const latestSamples = rows
      .filter((row) => row.rateLimitedCount > 0 || row.errorCount > 0 || row.timeoutCount > 0 || row.lastError)
      .slice(0, 20)
      .map((row) => ({
        usageDay: row.usageDay,
        providerKey: row.providerKey,
        endpointKey: row.endpointKey,
        caller: row.caller,
        lastStatus: row.lastStatus,
        lastError: row.lastError,
        lastCalledAt: row.lastCalledAt,
      }));
    return {
      days,
      rows,
      totalsByProvider: Array.from(byProvider.entries())
        .map(([providerKey, providerTotals]) => ({ providerKey, ...providerTotals }))
        .sort((a, b) => b.requestCount - a.requestCount || a.providerKey.localeCompare(b.providerKey)),
      totals,
      latestSamples,
      budgetWarnings: computeBudgetWarnings(env, rows, now),
    };
  } catch (error) {
    if (isMissingUsageTable(error)) {
      return {
        days,
        rows: [],
        totalsByProvider: [],
        totals: emptyTotals(),
        latestSamples: [],
        budgetWarnings: [],
      };
    }
    throw error;
  }
}
