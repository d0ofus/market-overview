import { refreshDailyBarsIncremental } from "./daily-bars";
import { coverageSatisfiesHistory, verifyMarketBarCoverage } from "./bar-coverage";
import { alpacaHistoricalRequestEnd, getProvider } from "./provider";
import { latestUsMarketSessionAsOfDate, previousUsMarketTradingDay } from "./market-calendar";
import { ensureMarketCalendarCoverage, loadStoredMarketSession } from "./market-calendar-cache";
import {
  assertMarketDataBackgroundWriteBudget,
  assertMarketDataCriticalWorkBudget,
  cleanupMarketDataOperationalState,
  getMarketDataDb,
  marketDataFeed,
  withDatabase,
} from "./market-data-db";
import {
  clearProviderSymbolBackoff,
} from "./provider-backoff";
import { zonedParts } from "./refresh-timing";
import type { Env, PostCloseDailyBarRefreshJob, WorkerScheduleSettings } from "./types";

const DEFAULT_WORKER_SCHEDULE_ID = "default";
const DEFAULT_RS_BACKGROUND_BATCH_SIZE = 50;
const DEFAULT_RS_BACKGROUND_MAX_BATCHES_PER_TICK = 20;
const DEFAULT_RS_BACKGROUND_TIME_BUDGET_MS = 15_000;
const DEFAULT_POST_CLOSE_BARS_OFFSET_MINUTES = 35;
const DEFAULT_POST_CLOSE_BARS_BATCH_SIZE = 80;
const DEFAULT_POST_CLOSE_BARS_MAX_BATCHES_PER_TICK = 4;
const MAX_POST_CLOSE_PROVIDER_BATCH_SIZE = 80;
const MAX_POST_CLOSE_HISTORY_BATCH_SIZE = 12;
const MAX_POST_CLOSE_PROVIDER_BATCHES_PER_TICK = 4;
const OVERVIEW_HISTORY_BOOTSTRAP_BATCH_SIZE = 25;
const OVERVIEW_HISTORY_LOOKBACK_DAYS = 470;
const POST_CLOSE_ITEM_LEASE_MS = 10 * 60_000;
const POST_CLOSE_RETRY_MINUTES = 15;
const POST_CLOSE_DATA_NOT_READY_RETRY_MINUTES = 5;
const POST_CLOSE_STALE_RUNNING_MS = 30 * 60_000;
const DEFAULT_PATTERN_SCAN_OFFSET_MINUTES = 75;
const DEFAULT_PATTERN_SCAN_BATCH_SIZE = 40;
const DEFAULT_PATTERN_SCAN_MAX_BATCHES_PER_TICK = 4;
const BREADTH_HISTORY_UNIVERSE_IDS = [
  "sp500-core",
  "nasdaq-core",
  "nyse-core",
  "russell2000-core",
  "overall-market-proxy",
] as const;
export const POST_CLOSE_SCOPE = "active-us-common-stocks-plus-overview";
export const FIXED_WORKER_CRON_EXPRESSION = "*/15 * * * *";

const POST_CLOSE_DAILY_BAR_UNIVERSE_SELECT = `
  SELECT ticker, MIN(priority) as priority, MAX(history_required) as history_required
  FROM (
    SELECT UPPER(TRIM(di.ticker)) as ticker, 0 as priority, 1 as history_required
    FROM dashboard_items di
    JOIN dashboard_groups dg ON dg.id = di.group_id
    JOIN dashboard_sections ds ON ds.id = dg.section_id
    JOIN dashboard_configs dc ON dc.id = ds.config_id
    WHERE dc.is_default = 1
      AND di.enabled = 1
      AND (ds.title LIKE '%Macro%' OR ds.title LIKE '%Equities%')
    UNION ALL
    SELECT UPPER(TRIM(us.ticker)) as ticker, 1 as priority, 1 as history_required
    FROM universe_symbols us
    WHERE us.universe_id = 'sp500-core'
    UNION ALL
    SELECT UPPER(TRIM(us.ticker)) as ticker, 2 as priority, 1 as history_required
    FROM universe_symbols us
    WHERE us.universe_id IN (${BREADTH_HISTORY_UNIVERSE_IDS.filter((id) => id !== "sp500-core").map((id) => `'${id}'`).join(", ")})
    UNION ALL
    SELECT UPPER(TRIM(s.ticker)) as ticker, 3 as priority, 0 as history_required
    FROM symbols s
    WHERE COALESCE(s.is_active, 1) = 1
      AND COALESCE(s.catalog_managed, 0) = 1
      AND lower(COALESCE(s.asset_class, '')) IN ('equity', 'stock')
  ) post_close_universe_raw
  WHERE ticker IS NOT NULL AND ticker <> ''
  GROUP BY ticker
`;

export function buildPostCloseDailyBarUniverseQuery(kind: "count" | "batch"): string {
  if (kind === "count") {
    return `SELECT COUNT(*) as count FROM (${POST_CLOSE_DAILY_BAR_UNIVERSE_SELECT}) post_close_universe`;
  }
  return `SELECT ticker FROM (${POST_CLOSE_DAILY_BAR_UNIVERSE_SELECT}) post_close_universe ORDER BY priority ASC, ticker ASC LIMIT ? OFFSET ?`;
}

let postCloseRetrySchemaReady = false;

function postCloseStateEnv(env: Env): Env {
  return withDatabase(env, getMarketDataDb(env));
}

async function ensurePostCloseRetrySchema(env: Env): Promise<void> {
  if (postCloseRetrySchemaReady) return;
  void env;
  postCloseRetrySchemaReady = true;
}

export function planPostCloseJobItemMaterialization(
  universe: Array<{ ticker: string; historyRequired: number }>,
  existingTickers: ReadonlySet<string>,
): Array<{ ticker: string; historyRequired: number; ordinal: number }> {
  return universe.flatMap((row, ordinal) => {
    const ticker = row.ticker.trim().toUpperCase();
    if (!ticker || existingTickers.has(ticker)) return [];
    return [{ ticker, historyRequired: Number(row.historyRequired) === 1 ? 1 : 0, ordinal }];
  });
}

export function isPostCloseJobComplete(
  totalTickers: number,
  itemCount: number,
  incompleteCount: number,
): boolean {
  return itemCount >= totalTickers && incompleteCount === 0;
}

async function materializePostCloseJobItems(
  env: Env,
  stateEnv: Env,
  jobId: string,
  totalTickers: number,
): Promise<void> {
  const existingCount = await stateEnv.DB.prepare(
    "SELECT COUNT(*) as count FROM post_close_daily_bar_refresh_job_items WHERE job_id = ?",
  ).bind(jobId).first<{ count: number | null }>();
  if (Number(existingCount?.count ?? 0) >= totalTickers) return;
  const universe = await env.DB.prepare(
    `SELECT ticker, history_required as historyRequired
     FROM (${POST_CLOSE_DAILY_BAR_UNIVERSE_SELECT}) post_close_universe
     ORDER BY priority ASC, ticker ASC`,
  ).all<{ ticker: string; historyRequired: number }>();
  const existing = await stateEnv.DB.prepare(
    "SELECT ticker FROM post_close_daily_bar_refresh_job_items WHERE job_id = ?",
  ).bind(jobId).all<{ ticker: string }>();
  const existingTickers = new Set(
    (existing.results ?? []).map((row) => row.ticker.trim().toUpperCase()).filter(Boolean),
  );
  const missingItems = planPostCloseJobItemMaterialization(universe.results ?? [], existingTickers);
  const statements = missingItems.map((row) => stateEnv.DB.prepare(
    `INSERT OR IGNORE INTO post_close_daily_bar_refresh_job_items
       (job_id, ordinal, ticker, history_required, status, updated_at)
     VALUES (?, ?, ?, ?, 'queued', CURRENT_TIMESTAMP)`,
  ).bind(jobId, row.ordinal, row.ticker, row.historyRequired));
  for (let index = 0; index < statements.length; index += 500) {
    await stateEnv.DB.batch(statements.slice(index, index + 500));
  }
}

async function loadPostCloseJobItemBatch(
  env: Env,
  jobId: string,
  cursorOffset: number,
  limit: number,
  phase: "exact" | "history",
): Promise<Array<{ ticker: string; ordinal: number; attemptCount: number; historyRequired: number }>> {
  const rows = await env.DB.prepare(
    `SELECT ticker, ordinal, attempt_count as attemptCount, history_required as historyRequired
     FROM post_close_daily_bar_refresh_job_items
     WHERE job_id = ?
       AND ordinal >= ?
       AND status NOT IN ('completed', 'unsupported')
       AND ${phase === "exact" ? "bar_date IS NULL" : "bar_date IS NOT NULL"}
       AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= CURRENT_TIMESTAMP)
       AND (lease_expires_at IS NULL OR datetime(lease_expires_at) <= CURRENT_TIMESTAMP)
     ORDER BY ordinal ASC
     LIMIT ?`,
  ).bind(jobId, cursorOffset, limit).all<{
    ticker: string;
    ordinal: number;
    attemptCount: number;
    historyRequired: number;
  }>();
  return rows.results ?? [];
}

async function hasIncompletePostCloseExactSession(env: Env, jobId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 as pending
       FROM post_close_daily_bar_refresh_job_items
      WHERE job_id = ?
        AND bar_date IS NULL
        AND status NOT IN ('completed', 'unsupported')
      LIMIT 1`,
  ).bind(jobId).first<{ pending: number }>();
  return Boolean(row?.pending);
}

async function updatePostCloseJobItems(
  env: Env,
  jobId: string,
  tickers: string[],
  input: {
    status: string;
    nextAttemptAt?: string | null;
    leaseExpiresAt?: string | null;
    leaseToken?: string | null;
    expectedLeaseToken?: string | null;
    lastError?: string | null;
    barDate?: string | null;
  },
): Promise<void> {
  if (tickers.length === 0) return;
  const statements = tickers.map((ticker) => env.DB.prepare(
    `UPDATE post_close_daily_bar_refresh_job_items
     SET status = ?,
         next_attempt_at = ?,
         lease_expires_at = ?,
         lease_token = ?,
         last_error = ?,
         bar_date = COALESCE(?, bar_date),
         updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ? AND ticker = ?
       AND (? IS NULL OR lease_token = ?)`,
  ).bind(
    input.status,
    input.nextAttemptAt ?? null,
    input.leaseExpiresAt ?? null,
    input.leaseToken ?? null,
    input.lastError ?? null,
    input.barDate ?? null,
    jobId,
    ticker,
    input.expectedLeaseToken ?? null,
    input.expectedLeaseToken ?? null,
  ));
  for (let index = 0; index < statements.length; index += 100) {
    await env.DB.batch(statements.slice(index, index + 100));
  }
}

async function leasePostCloseJobItems(
  env: Env,
  jobId: string,
  items: Array<{ ticker: string }>,
  leaseToken: string,
  leaseExpiresAt: string,
): Promise<Array<{ ticker: string; ordinal: number; attemptCount: number; historyRequired: number }>> {
  if (items.length === 0) return [];
  const statements = items.map((item) => env.DB.prepare(
    `UPDATE post_close_daily_bar_refresh_job_items
     SET status = 'running',
         attempt_count = attempt_count + 1,
         next_attempt_at = NULL,
         lease_token = ?,
         lease_expires_at = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ? AND ticker = ?
       AND status NOT IN ('completed', 'unsupported')
       AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= CURRENT_TIMESTAMP)
       AND (lease_expires_at IS NULL OR datetime(lease_expires_at) <= CURRENT_TIMESTAMP)`,
  ).bind(leaseToken, leaseExpiresAt, jobId, item.ticker));
  await env.DB.batch(statements);
  const rows = await env.DB.prepare(
    `SELECT ticker, ordinal, attempt_count as attemptCount, history_required as historyRequired
     FROM post_close_daily_bar_refresh_job_items
     WHERE job_id = ? AND lease_token = ?
     ORDER BY ordinal ASC`,
  ).bind(jobId, leaseToken).all<{
    ticker: string;
    ordinal: number;
    attemptCount: number;
    historyRequired: number;
  }>();
  return rows.results ?? [];
}

async function loadPostCloseJobItemSummary(env: Env, jobId: string): Promise<{
  itemCount: number;
  completedCount: number;
  currentCount: number;
  incompleteCount: number;
  readyCount: number;
  nextAttemptAt: string | null;
}> {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) as itemCount,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completedCount,
       SUM(CASE WHEN bar_date IS NOT NULL THEN 1 ELSE 0 END) as currentCount,
       SUM(CASE WHEN status NOT IN ('completed', 'unsupported') THEN 1 ELSE 0 END) as incompleteCount,
       SUM(CASE WHEN status NOT IN ('completed', 'unsupported')
                 AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= CURRENT_TIMESTAMP)
                 AND (lease_expires_at IS NULL OR datetime(lease_expires_at) <= CURRENT_TIMESTAMP)
                THEN 1 ELSE 0 END) as readyCount,
       MIN(CASE WHEN status NOT IN ('completed', 'unsupported') THEN next_attempt_at END) as nextAttemptAt
     FROM post_close_daily_bar_refresh_job_items
     WHERE job_id = ?`,
  ).bind(jobId).first<{
    itemCount: number | null;
    completedCount: number | null;
    currentCount: number | null;
    incompleteCount: number | null;
    readyCount: number | null;
    nextAttemptAt: string | null;
  }>();
  return {
    itemCount: Number(row?.itemCount ?? 0),
    completedCount: Number(row?.completedCount ?? 0),
    currentCount: Number(row?.currentCount ?? 0),
    incompleteCount: Number(row?.incompleteCount ?? 0),
    readyCount: Number(row?.readyCount ?? 0),
    nextAttemptAt: row?.nextAttemptAt ?? null,
  };
}

function retryDelayMinutes(attemptCount: number): number {
  return [15, 30, 60, 120][Math.min(Math.max(0, attemptCount - 1), 3)];
}

function addUtcDays(isoDate: string, days: number): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export type PostCloseErrorCode = "data-not-ready" | "rate-limited" | "auth-blocked" | "provider-error";

export function isRecentSipRestriction(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /subscription does not permit querying recent SIP data/i.test(message);
}

export function classifyPostCloseError(error: unknown): PostCloseErrorCode {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (isRecentSipRestriction(error)) return "data-not-ready";
  if (/\b429\b|rate.?limit|provider budget exceeded/i.test(message)) return "rate-limited";
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|auth/i.test(message)) return "auth-blocked";
  return "provider-error";
}

export function boundPostCloseProviderWork(input: { batchSize?: number; maxBatches?: number }): {
  batchSize: number;
  maxBatches: number;
} {
  return {
    batchSize: Math.min(
      MAX_POST_CLOSE_PROVIDER_BATCH_SIZE,
      Math.max(1, input.batchSize ?? DEFAULT_POST_CLOSE_BARS_BATCH_SIZE),
    ),
    maxBatches: Math.min(
      MAX_POST_CLOSE_PROVIDER_BATCHES_PER_TICK,
      Math.max(1, input.maxBatches ?? DEFAULT_POST_CLOSE_BARS_MAX_BATCHES_PER_TICK),
    ),
  };
}

function retryAtForPostCloseError(error: unknown, attemptCount: number): string | null {
  const code = classifyPostCloseError(error);
  if (code === "auth-blocked") return null;
  if (code === "data-not-ready") {
    return new Date(Date.now() + POST_CLOSE_DATA_NOT_READY_RETRY_MINUTES * 60_000).toISOString();
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  const retryAfterSeconds = message.match(/retry-after=(\d+(?:\.\d+)?)/i);
  if (retryAfterSeconds) {
    const seconds = Number(retryAfterSeconds[1]);
    if (Number.isFinite(seconds) && seconds >= 0) return new Date(Date.now() + seconds * 1000).toISOString();
  }
  const retryAfterDate = message.match(/retry-after=([^;]*?GMT)/i);
  if (retryAfterDate) {
    const parsed = Date.parse(retryAfterDate[1].trim());
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(Date.now() + retryDelayMinutes(attemptCount) * 60_000).toISOString();
}

type WorkerScheduleSettingsRow = {
  id: string;
  rsBackgroundEnabled: number | null;
  rsBackgroundBatchSize: number | null;
  rsBackgroundMaxBatchesPerTick: number | null;
  rsBackgroundTimeBudgetMs: number | null;
  rsManualCacheReuseEnabled: number | null;
  rsSharedConfigSnapshotFanoutEnabled: number | null;
  postCloseBarsEnabled: number | null;
  postCloseBarsOffsetMinutes: number | null;
  postCloseBarsBatchSize: number | null;
  postCloseBarsMaxBatchesPerTick: number | null;
  patternScanEnabled: number | null;
  patternScanOffsetMinutes: number | null;
  patternScanBatchSize: number | null;
  patternScanMaxBatchesPerTick: number | null;
};

type PostCloseDailyBarRefreshJobRecord = {
  id: string;
  tradingDate: string;
  scope: string;
  status: "queued" | "running" | "completed" | "failed" | "superseded";
  sourceProvider: string;
  sourceFeed: string;
  adjustment: string;
  requestEnd: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  totalTickers: number;
  processedTickers: number;
  cursorOffset: number;
  fetchedRows: number;
  writtenRows: number;
  currentDateTickers: number;
  missingCurrentDateTickers: number;
  currentDateCoveragePct: number;
  attemptCount: number;
  nextAttemptAt: string | null;
  errorCode: string | null;
  leaseExpiresAt: string | null;
};

export function postCloseJobIdentity(env: Pick<Env, "DATA_PROVIDER" | "ALPACA_DAILY_FEED" | "ALPACA_FEED" | "ALPACA_DAILY_ADJUSTMENT">): {
  scope: string;
  provider: string;
  feed: string;
  adjustment: string;
} {
  const provider = (env.DATA_PROVIDER ?? "alpaca").trim().toLowerCase() || "alpaca";
  const feed = (env.ALPACA_DAILY_FEED ?? env.ALPACA_FEED ?? "iex").trim().toLowerCase() || "iex";
  const adjustment = (env.ALPACA_DAILY_ADJUSTMENT ?? "split").trim().toLowerCase() || "split";
  return {
    scope: `${POST_CLOSE_SCOPE}:${provider}:${feed}:${adjustment}`,
    provider,
    feed,
    adjustment,
  };
}

export function postCloseInvocationBatchPlan(input: { batchSize?: number; maxBatches?: number }): {
  exactBatchSize: number;
  exactBatches: number;
  historyBatchSize: number;
  historyBatches: 1;
} {
  const bounded = boundPostCloseProviderWork(input);
  return {
    exactBatchSize: bounded.batchSize,
    exactBatches: bounded.maxBatches,
    historyBatchSize: Math.min(bounded.batchSize, MAX_POST_CLOSE_HISTORY_BATCH_SIZE),
    historyBatches: 1,
  };
}

function asBooleanFlag(value: number | null | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return Number(value) === 1;
}

function coerceInt(value: number | null | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function mapWorkerScheduleSettingsRow(row: WorkerScheduleSettingsRow | null): WorkerScheduleSettings {
  return {
    id: row?.id ?? DEFAULT_WORKER_SCHEDULE_ID,
    cronExpression: FIXED_WORKER_CRON_EXPRESSION,
    rsBackgroundEnabled: asBooleanFlag(row?.rsBackgroundEnabled, false),
    rsBackgroundBatchSize: Math.max(1, coerceInt(row?.rsBackgroundBatchSize, DEFAULT_RS_BACKGROUND_BATCH_SIZE)),
    rsBackgroundMaxBatchesPerTick: Math.max(1, coerceInt(row?.rsBackgroundMaxBatchesPerTick, DEFAULT_RS_BACKGROUND_MAX_BATCHES_PER_TICK)),
    rsBackgroundTimeBudgetMs: Math.max(1_000, coerceInt(row?.rsBackgroundTimeBudgetMs, DEFAULT_RS_BACKGROUND_TIME_BUDGET_MS)),
    rsManualCacheReuseEnabled: asBooleanFlag(row?.rsManualCacheReuseEnabled, true),
    rsSharedConfigSnapshotFanoutEnabled: asBooleanFlag(row?.rsSharedConfigSnapshotFanoutEnabled, true),
    postCloseBarsEnabled: asBooleanFlag(row?.postCloseBarsEnabled, true),
    postCloseBarsOffsetMinutes: Math.max(0, coerceInt(row?.postCloseBarsOffsetMinutes, DEFAULT_POST_CLOSE_BARS_OFFSET_MINUTES)),
    postCloseBarsBatchSize: Math.max(1, coerceInt(row?.postCloseBarsBatchSize, DEFAULT_POST_CLOSE_BARS_BATCH_SIZE)),
    postCloseBarsMaxBatchesPerTick: Math.max(1, coerceInt(row?.postCloseBarsMaxBatchesPerTick, DEFAULT_POST_CLOSE_BARS_MAX_BATCHES_PER_TICK)),
    patternScanEnabled: asBooleanFlag(row?.patternScanEnabled, false),
    patternScanOffsetMinutes: Math.max(0, coerceInt(row?.patternScanOffsetMinutes, DEFAULT_PATTERN_SCAN_OFFSET_MINUTES)),
    patternScanBatchSize: Math.max(1, coerceInt(row?.patternScanBatchSize, DEFAULT_PATTERN_SCAN_BATCH_SIZE)),
    patternScanMaxBatchesPerTick: Math.max(1, coerceInt(row?.patternScanMaxBatchesPerTick, DEFAULT_PATTERN_SCAN_MAX_BATCHES_PER_TICK)),
  };
}

async function ensureWorkerScheduleSettingsRow(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO worker_schedule_settings
      (id, rs_background_enabled, rs_background_batch_size, rs_background_max_batches_per_tick, rs_background_time_budget_ms, rs_manual_cache_reuse_enabled, rs_shared_config_snapshot_fanout_enabled, post_close_bars_enabled, post_close_bars_offset_minutes, post_close_bars_batch_size, post_close_bars_max_batches_per_tick, pattern_scan_enabled, pattern_scan_offset_minutes, pattern_scan_batch_size, pattern_scan_max_batches_per_tick, updated_at)
     VALUES (?, 0, ?, ?, ?, 1, 1, 1, ?, ?, ?, 0, ?, ?, ?, CURRENT_TIMESTAMP)`,
  )
    .bind(
      DEFAULT_WORKER_SCHEDULE_ID,
      DEFAULT_RS_BACKGROUND_BATCH_SIZE,
      DEFAULT_RS_BACKGROUND_MAX_BATCHES_PER_TICK,
      DEFAULT_RS_BACKGROUND_TIME_BUDGET_MS,
      DEFAULT_POST_CLOSE_BARS_OFFSET_MINUTES,
      DEFAULT_POST_CLOSE_BARS_BATCH_SIZE,
      DEFAULT_POST_CLOSE_BARS_MAX_BATCHES_PER_TICK,
      DEFAULT_PATTERN_SCAN_OFFSET_MINUTES,
      DEFAULT_PATTERN_SCAN_BATCH_SIZE,
      DEFAULT_PATTERN_SCAN_MAX_BATCHES_PER_TICK,
    )
    .run();
}

export async function loadWorkerScheduleSettings(env: Env): Promise<WorkerScheduleSettings> {
  await ensureWorkerScheduleSettingsRow(env);
  const row = await env.DB.prepare(
    `SELECT
       id,
       rs_background_enabled as rsBackgroundEnabled,
       rs_background_batch_size as rsBackgroundBatchSize,
       rs_background_max_batches_per_tick as rsBackgroundMaxBatchesPerTick,
       rs_background_time_budget_ms as rsBackgroundTimeBudgetMs,
       rs_manual_cache_reuse_enabled as rsManualCacheReuseEnabled,
       rs_shared_config_snapshot_fanout_enabled as rsSharedConfigSnapshotFanoutEnabled,
       post_close_bars_enabled as postCloseBarsEnabled,
       post_close_bars_offset_minutes as postCloseBarsOffsetMinutes,
       post_close_bars_batch_size as postCloseBarsBatchSize,
       post_close_bars_max_batches_per_tick as postCloseBarsMaxBatchesPerTick,
       pattern_scan_enabled as patternScanEnabled,
       pattern_scan_offset_minutes as patternScanOffsetMinutes,
       pattern_scan_batch_size as patternScanBatchSize,
       pattern_scan_max_batches_per_tick as patternScanMaxBatchesPerTick
     FROM worker_schedule_settings
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(DEFAULT_WORKER_SCHEDULE_ID)
    .first<WorkerScheduleSettingsRow>();
  return mapWorkerScheduleSettingsRow(row ?? null);
}

export async function updateWorkerScheduleSettings(
  env: Env,
  payload: Omit<WorkerScheduleSettings, "cronExpression">,
): Promise<WorkerScheduleSettings> {
  await ensureWorkerScheduleSettingsRow(env);
  await env.DB.prepare(
    `INSERT INTO worker_schedule_settings
      (id, rs_background_enabled, rs_background_batch_size, rs_background_max_batches_per_tick, rs_background_time_budget_ms, rs_manual_cache_reuse_enabled, rs_shared_config_snapshot_fanout_enabled, post_close_bars_enabled, post_close_bars_offset_minutes, post_close_bars_batch_size, post_close_bars_max_batches_per_tick, pattern_scan_enabled, pattern_scan_offset_minutes, pattern_scan_batch_size, pattern_scan_max_batches_per_tick, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       rs_background_enabled = excluded.rs_background_enabled,
       rs_background_batch_size = excluded.rs_background_batch_size,
       rs_background_max_batches_per_tick = excluded.rs_background_max_batches_per_tick,
       rs_background_time_budget_ms = excluded.rs_background_time_budget_ms,
       rs_manual_cache_reuse_enabled = excluded.rs_manual_cache_reuse_enabled,
       rs_shared_config_snapshot_fanout_enabled = excluded.rs_shared_config_snapshot_fanout_enabled,
       post_close_bars_enabled = excluded.post_close_bars_enabled,
       post_close_bars_offset_minutes = excluded.post_close_bars_offset_minutes,
       post_close_bars_batch_size = excluded.post_close_bars_batch_size,
       post_close_bars_max_batches_per_tick = excluded.post_close_bars_max_batches_per_tick,
       pattern_scan_enabled = excluded.pattern_scan_enabled,
       pattern_scan_offset_minutes = excluded.pattern_scan_offset_minutes,
       pattern_scan_batch_size = excluded.pattern_scan_batch_size,
       pattern_scan_max_batches_per_tick = excluded.pattern_scan_max_batches_per_tick,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      payload.id || DEFAULT_WORKER_SCHEDULE_ID,
      payload.rsBackgroundEnabled ? 1 : 0,
      payload.rsBackgroundBatchSize,
      payload.rsBackgroundMaxBatchesPerTick,
      payload.rsBackgroundTimeBudgetMs,
      payload.rsManualCacheReuseEnabled ? 1 : 0,
      payload.rsSharedConfigSnapshotFanoutEnabled ? 1 : 0,
      payload.postCloseBarsEnabled ? 1 : 0,
      payload.postCloseBarsOffsetMinutes,
      payload.postCloseBarsBatchSize,
      payload.postCloseBarsMaxBatchesPerTick,
      payload.patternScanEnabled ? 1 : 0,
      payload.patternScanOffsetMinutes,
      payload.patternScanBatchSize,
      payload.patternScanMaxBatchesPerTick,
    )
    .run();
  return await loadWorkerScheduleSettings(env);
}

export function isPostCloseBarsWindowOpen(
  now: Date,
  expectedTradingDate: string,
  offsetMinutes: number,
  marketCloseTime = "16:00",
): boolean {
  const ny = zonedParts(now, "America/New_York");
  const [closeHour, closeMinute] = marketCloseTime.split(":").map(Number);
  const closeMinutes = Number.isFinite(closeHour) && Number.isFinite(closeMinute)
    ? closeHour * 60 + closeMinute
    : 16 * 60;
  const closeMinutesWithOffset = closeMinutes + Math.max(0, offsetMinutes);
  if (ny.localDate > expectedTradingDate) return true;
  return ny.localDate === expectedTradingDate && ny.minutesOfDay >= closeMinutesWithOffset;
}

export type PostCloseBudgetProtectionDecision = {
  protect: boolean;
  expectedTradingDate: string;
  reason:
    | "disabled"
    | "before-window"
    | "missing-job"
    | "actionable-job"
    | "completed"
    | "auth-blocked"
    | "data-not-ready"
    | "retry-not-due"
    | "diagnostic-failed";
};

export function resolvePostCloseBudgetProtection(input: {
  now: Date;
  expectedTradingDate: string;
  settings: WorkerScheduleSettings;
  job: PostCloseDailyBarRefreshJob | null;
  marketCloseTime?: string;
}): PostCloseBudgetProtectionDecision {
  const { now, expectedTradingDate, settings, job, marketCloseTime } = input;
  if (!settings.postCloseBarsEnabled) {
    return { protect: false, expectedTradingDate, reason: "disabled" };
  }
  if (!isPostCloseBarsWindowOpen(now, expectedTradingDate, settings.postCloseBarsOffsetMinutes, marketCloseTime)) {
    return { protect: false, expectedTradingDate, reason: "before-window" };
  }
  if (!job) {
    return { protect: true, expectedTradingDate, reason: "missing-job" };
  }
  if (job.status === "completed") {
    return { protect: false, expectedTradingDate, reason: "completed" };
  }
  if (job.status === "failed" && job.errorCode === "auth-blocked") {
    if (isRecentSipRestriction(job.error)) {
      return { protect: true, expectedTradingDate, reason: "data-not-ready" };
    }
    return { protect: false, expectedTradingDate, reason: "auth-blocked" };
  }
  if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > now.getTime()) {
    return { protect: false, expectedTradingDate, reason: "retry-not-due" };
  }
  return { protect: true, expectedTradingDate, reason: "actionable-job" };
}

function mapPostCloseDailyBarRefreshJobRecord(
  record: PostCloseDailyBarRefreshJobRecord,
): PostCloseDailyBarRefreshJob {
  return {
    id: record.id,
    tradingDate: record.tradingDate,
    scope: record.scope,
    status: record.status,
    sourceProvider: record.sourceProvider,
    sourceFeed: record.sourceFeed,
    adjustment: record.adjustment,
    requestEnd: record.requestEnd ?? null,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    error: record.error,
    totalTickers: record.totalTickers,
    processedTickers: record.processedTickers,
    cursorOffset: record.cursorOffset,
    fetchedRows: Number(record.fetchedRows ?? 0),
    writtenRows: Number(record.writtenRows ?? 0),
    currentDateTickers: Number(record.currentDateTickers ?? 0),
    missingCurrentDateTickers: Number(record.missingCurrentDateTickers ?? 0),
    currentDateCoveragePct: Number(record.currentDateCoveragePct ?? 0),
    attemptCount: Number(record.attemptCount ?? 0),
    nextAttemptAt: record.nextAttemptAt ?? null,
    errorCode: record.errorCode ?? null,
  };
}

async function loadPostCloseDailyBarRefreshJobRecord(
  env: Env,
  jobId: string,
): Promise<PostCloseDailyBarRefreshJobRecord | null> {
  return await env.DB.prepare(
    `SELECT
       id,
       trading_date as tradingDate,
       scope,
       status,
       source_provider as sourceProvider,
       source_feed as sourceFeed,
       adjustment,
       request_end as requestEnd,
       started_at as startedAt,
       updated_at as updatedAt,
       completed_at as completedAt,
        error,
        total_tickers as totalTickers,
        processed_tickers as processedTickers,
        cursor_offset as cursorOffset,
        fetched_rows as fetchedRows,
        written_rows as writtenRows,
        current_date_tickers as currentDateTickers,
        missing_current_date_tickers as missingCurrentDateTickers,
        current_date_coverage_pct as currentDateCoveragePct,
        attempt_count as attemptCount,
        next_attempt_at as nextAttemptAt,
        error_code as errorCode,
        lease_expires_at as leaseExpiresAt
     FROM post_close_daily_bar_refresh_jobs
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(jobId)
    .first<PostCloseDailyBarRefreshJobRecord>();
}

async function loadLatestPostCloseDailyBarRefreshJobRecordForDate(
  env: Env,
  tradingDate: string,
  identity: ReturnType<typeof postCloseJobIdentity>,
): Promise<PostCloseDailyBarRefreshJobRecord | null> {
  return await env.DB.prepare(
    `SELECT
       id,
       trading_date as tradingDate,
       scope,
       status,
       source_provider as sourceProvider,
       source_feed as sourceFeed,
       adjustment,
       request_end as requestEnd,
       started_at as startedAt,
       updated_at as updatedAt,
       completed_at as completedAt,
        error,
        total_tickers as totalTickers,
        processed_tickers as processedTickers,
        cursor_offset as cursorOffset,
        fetched_rows as fetchedRows,
        written_rows as writtenRows,
        current_date_tickers as currentDateTickers,
        missing_current_date_tickers as missingCurrentDateTickers,
        current_date_coverage_pct as currentDateCoveragePct,
        attempt_count as attemptCount,
        next_attempt_at as nextAttemptAt,
        error_code as errorCode,
        lease_expires_at as leaseExpiresAt
     FROM post_close_daily_bar_refresh_jobs
     WHERE scope = ?
       AND trading_date = ?
     ORDER BY datetime(started_at) DESC
     LIMIT 1`,
  )
    .bind(identity.scope, tradingDate)
    .first<PostCloseDailyBarRefreshJobRecord>();
}

async function updatePostCloseDailyBarRefreshJobRecord(
  env: Env,
  jobId: string,
  input: Partial<{
    status: PostCloseDailyBarRefreshJobRecord["status"];
    processedTickers: number;
    cursorOffset: number;
    completedAt: string | null;
    error: string | null;
    fetchedRows: number;
    writtenRows: number;
    currentDateTickers: number;
    missingCurrentDateTickers: number;
    currentDateCoveragePct: number;
    attemptCount: number;
    nextAttemptAt: string | null;
    errorCode: string | null;
    leaseExpiresAt: string | null;
    requestEnd: string | null;
  }>,
): Promise<void> {
  const assignments: string[] = ["updated_at = CURRENT_TIMESTAMP"];
  const values: unknown[] = [];
  if (input.status) {
    assignments.push("status = ?");
    values.push(input.status);
  }
  if (typeof input.processedTickers === "number") {
    assignments.push("processed_tickers = ?");
    values.push(input.processedTickers);
  }
  if (typeof input.cursorOffset === "number") {
    assignments.push("cursor_offset = ?");
    values.push(input.cursorOffset);
  }
  if (input.completedAt !== undefined) {
    assignments.push("completed_at = ?");
    values.push(input.completedAt);
  }
  if (input.error !== undefined) {
    assignments.push("error = ?");
    values.push(input.error);
  }
  if (typeof input.fetchedRows === "number") {
    assignments.push("fetched_rows = ?");
    values.push(input.fetchedRows);
  }
  if (typeof input.writtenRows === "number") {
    assignments.push("written_rows = ?");
    values.push(input.writtenRows);
  }
  if (typeof input.currentDateTickers === "number") {
    assignments.push("current_date_tickers = ?");
    values.push(input.currentDateTickers);
  }
  if (typeof input.missingCurrentDateTickers === "number") {
    assignments.push("missing_current_date_tickers = ?");
    values.push(input.missingCurrentDateTickers);
  }
  if (typeof input.currentDateCoveragePct === "number") {
    assignments.push("current_date_coverage_pct = ?");
    values.push(input.currentDateCoveragePct);
  }
  if (typeof input.attemptCount === "number") {
    assignments.push("attempt_count = ?");
    values.push(input.attemptCount);
  }
  if (input.nextAttemptAt !== undefined) {
    assignments.push("next_attempt_at = ?");
    values.push(input.nextAttemptAt);
  }
  if (input.errorCode !== undefined) {
    assignments.push("error_code = ?");
    values.push(input.errorCode);
  }
  if (input.leaseExpiresAt !== undefined) {
    assignments.push("lease_expires_at = ?");
    values.push(input.leaseExpiresAt);
  }
  if (input.requestEnd !== undefined) {
    assignments.push("request_end = ?");
    values.push(input.requestEnd);
  }
  await env.DB.prepare(
    `UPDATE post_close_daily_bar_refresh_jobs
     SET ${assignments.join(", ")}
     WHERE id = ?`,
  )
    .bind(...values, jobId)
    .run();
}

async function loadPostCloseDailyBarUniverseCount(env: Env): Promise<number> {
  const row = await env.DB.prepare(buildPostCloseDailyBarUniverseQuery("count"))
    .first<{ count: number | string | null }>();
  return Math.max(0, Number(row?.count ?? 0) || 0);
}

async function loadTickersWithBarOnDate(env: Env, tickers: string[], date: string): Promise<Set<string>> {
  const unique = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  const out = new Set<string>();
  for (let i = 0; i < unique.length; i += 80) {
    const batch = unique.slice(i, i + 80);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => "?").join(",");
    const rows = await getMarketDataDb(env).prepare(
      `SELECT DISTINCT ticker
         FROM alpaca_daily_bars
        WHERE feed = ?
          AND date = ?
          AND ticker IN (${placeholders})`,
    ).bind(marketDataFeed(env), date, ...batch).all<{ ticker: string }>();
    for (const row of rows.results ?? []) {
      const ticker = row.ticker?.trim().toUpperCase();
      if (ticker) out.add(ticker);
    }
  }
  return out;
}

type OverviewHistoryState = {
  ticker: string;
  lookbackStart: string;
  throughDate: string;
};

export function planPostCloseProviderBatch<T extends {
  ticker: string;
  historyRequired: number;
}>(input: {
  items: T[];
  historyStates: Map<string, OverviewHistoryState>;
  currentTickers?: Set<string>;
  tradingDate: string;
  batchSize: number;
}): {
  items: T[];
  refreshStartDate: string;
  historyLookbackStart: string;
  mode: "exact" | "history" | "current";
} {
  const historyLookbackStart = addUtcDays(input.tradingDate, -OVERVIEW_HISTORY_LOOKBACK_DAYS);
  const historyStaleBoundary = addUtcDays(input.tradingDate, -7);
  const currentTickers = input.currentTickers ?? new Set<string>();
  const exactItems = input.items.filter((item) => !currentTickers.has(item.ticker));
  if (input.currentTickers && exactItems.length > 0) {
    return {
      items: exactItems.slice(0, input.batchSize),
      refreshStartDate: input.tradingDate,
      historyLookbackStart,
      mode: "exact",
    };
  }
  const historyCandidates = input.items.filter((item) => Number(item.historyRequired) === 1);
  const bootstrapItems = historyCandidates.filter((item) => {
    const state = input.historyStates.get(item.ticker);
    return !state
      || state.lookbackStart > historyLookbackStart
      || state.throughDate < historyStaleBoundary;
  });
  const items = bootstrapItems.length > 0
    ? bootstrapItems.slice(0, Math.min(input.batchSize, OVERVIEW_HISTORY_BOOTSTRAP_BATCH_SIZE))
    : input.items;
  const refreshStartDate = bootstrapItems.length > 0
    ? historyLookbackStart
    : items.reduce((earliest, item) => {
      if (Number(item.historyRequired) !== 1) return earliest;
      const throughDate = input.historyStates.get(item.ticker)?.throughDate;
      if (!throughDate) return earliest;
      const nextDate = addUtcDays(throughDate, 1);
      return nextDate < earliest ? nextDate : earliest;
    }, input.tradingDate);
  return {
    items,
    refreshStartDate,
    historyLookbackStart,
    mode: historyCandidates.length > 0 ? "history" : "current",
  };
}

export function shouldUseYahooRepair(input: {
  attemptCount: number;
  hasCurrentSession: boolean;
  mode: "exact" | "history" | "current";
}): boolean {
  return input.attemptCount >= 3 && (!input.hasCurrentSession || input.mode === "history");
}

async function loadOverviewHistoryStates(
  env: Env,
  tickers: string[],
  sourceFeed: string,
): Promise<Map<string, OverviewHistoryState>> {
  const unique = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  const out = new Map<string, OverviewHistoryState>();
  for (let index = 0; index < unique.length; index += 80) {
    const tickerChunk = unique.slice(index, index + 80);
    const placeholders = tickerChunk.map(() => "?").join(",");
    const rows = await getMarketDataDb(env).prepare(
      `SELECT ticker, lookback_start as lookbackStart, through_date as throughDate
       FROM overview_alpaca_history_state
       WHERE source_feed = ?
         AND status = 'completed'
         AND ticker IN (${placeholders})`,
    ).bind(sourceFeed, ...tickerChunk).all<OverviewHistoryState>();
    for (const row of rows.results ?? []) out.set(row.ticker.toUpperCase(), row);
  }
  return out;
}

async function checkpointOverviewHistoryStates(
  env: Env,
  tickers: string[],
  sourceFeed: string,
  lookbackStart: string,
  throughDate: string,
): Promise<void> {
  const db = getMarketDataDb(env);
  const statements = tickers.map((ticker) => db.prepare(
    `INSERT INTO overview_alpaca_history_state
       (ticker, source_feed, lookback_start, through_date, status, last_error, updated_at)
     VALUES (?, ?, ?, ?, 'completed', NULL, CURRENT_TIMESTAMP)
     ON CONFLICT(ticker, source_feed) DO UPDATE SET
       lookback_start = MIN(overview_alpaca_history_state.lookback_start, excluded.lookback_start),
       through_date = MAX(overview_alpaca_history_state.through_date, excluded.through_date),
       status = 'completed',
       last_error = NULL,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(ticker, sourceFeed, lookbackStart, throughDate));
  for (let index = 0; index < statements.length; index += 100) {
    await db.batch(statements.slice(index, index + 100));
  }
}

function isStaleRunningPostCloseJob(job: PostCloseDailyBarRefreshJobRecord, now = new Date()): boolean {
  if (job.status !== "running") return false;
  const updatedAtMs = Date.parse(job.updatedAt.endsWith("Z") ? job.updatedAt : `${job.updatedAt.replace(" ", "T")}Z`);
  return Number.isFinite(updatedAtMs) && now.getTime() - updatedAtMs > POST_CLOSE_STALE_RUNNING_MS;
}

async function loadNewestIncompletePriorPostCloseJobRecord(
  env: Env,
  tradingDate: string,
  identity: ReturnType<typeof postCloseJobIdentity>,
): Promise<PostCloseDailyBarRefreshJobRecord | null> {
  return await env.DB.prepare(
    `SELECT
       id, trading_date as tradingDate, scope, status,
       source_provider as sourceProvider, source_feed as sourceFeed, adjustment,
       request_end as requestEnd,
       started_at as startedAt, updated_at as updatedAt, completed_at as completedAt,
       error, total_tickers as totalTickers, processed_tickers as processedTickers,
       cursor_offset as cursorOffset, fetched_rows as fetchedRows, written_rows as writtenRows,
       current_date_tickers as currentDateTickers,
       missing_current_date_tickers as missingCurrentDateTickers,
       current_date_coverage_pct as currentDateCoveragePct,
       attempt_count as attemptCount, next_attempt_at as nextAttemptAt,
       error_code as errorCode, lease_expires_at as leaseExpiresAt
     FROM post_close_daily_bar_refresh_jobs
     WHERE scope = ?
       AND trading_date < ?
       AND status IN ('queued', 'running', 'failed')
       AND EXISTS (
         SELECT 1 FROM post_close_daily_bar_refresh_job_items item
         WHERE item.job_id = post_close_daily_bar_refresh_jobs.id
           AND item.bar_date IS NULL
           AND item.status NOT IN ('completed', 'unsupported')
       )
     ORDER BY trading_date DESC, datetime(started_at) DESC
     LIMIT 1`,
  ).bind(identity.scope, tradingDate).first<PostCloseDailyBarRefreshJobRecord>();
}

async function requeueRecentSipRestrictionJob(
  env: Env,
  job: PostCloseDailyBarRefreshJobRecord,
): Promise<PostCloseDailyBarRefreshJobRecord | null> {
  if (job.errorCode !== "auth-blocked" || !isRecentSipRestriction(job.error)) return null;
  await env.DB.prepare(
    `UPDATE post_close_daily_bar_refresh_job_items
        SET status = CASE WHEN bar_date IS NULL THEN 'queued' ELSE 'current-complete' END,
            next_attempt_at = NULL,
            lease_expires_at = NULL,
            lease_token = NULL,
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
        AND status = 'auth-blocked'
        AND instr(lower(COALESCE(last_error, '')), 'subscription does not permit querying recent sip data') > 0`,
  ).bind(job.id).run();
  await updatePostCloseDailyBarRefreshJobRecord(env, job.id, {
    status: "queued",
    error: null,
    errorCode: null,
    completedAt: null,
    nextAttemptAt: null,
    leaseExpiresAt: null,
  });
  return await loadPostCloseDailyBarRefreshJobRecord(env, job.id);
}

async function ensurePostCloseDailyBarRefreshJob(
  env: Env,
  tradingDate: string,
): Promise<PostCloseDailyBarRefreshJobRecord> {
  const stateEnv = postCloseStateEnv(env);
  await ensurePostCloseRetrySchema(stateEnv);
  const identity = postCloseJobIdentity(env);
  const existing = await loadLatestPostCloseDailyBarRefreshJobRecordForDate(stateEnv, tradingDate, identity);
  if (existing) {
    await materializePostCloseJobItems(env, stateEnv, existing.id, existing.totalTickers);
    const recoveredRecentSipJob = await requeueRecentSipRestrictionJob(stateEnv, existing);
    if (recoveredRecentSipJob) return recoveredRecentSipJob;
    if (isStaleRunningPostCloseJob(existing)) {
      await updatePostCloseDailyBarRefreshJobRecord(stateEnv, existing.id, {
        status: "queued",
        error: null,
        completedAt: null,
        leaseExpiresAt: null,
      });
      const reset = await loadPostCloseDailyBarRefreshJobRecord(stateEnv, existing.id);
      if (reset) return reset;
    }
    if (existing.status === "failed") {
      if (existing.errorCode === "auth-blocked") return existing;
      await updatePostCloseDailyBarRefreshJobRecord(stateEnv, existing.id, {
        status: "queued",
        error: null,
        errorCode: null,
        completedAt: null,
        nextAttemptAt: null,
        leaseExpiresAt: null,
      });
      const reset = await loadPostCloseDailyBarRefreshJobRecord(stateEnv, existing.id);
      if (reset) return reset;
    }
    return existing;
  }

  const id = crypto.randomUUID();
  const totalTickers = await loadPostCloseDailyBarUniverseCount(env);
  await stateEnv.DB.prepare(
    `UPDATE post_close_daily_bar_refresh_jobs
        SET status = 'superseded', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
            error = 'Superseded because the configured canonical source changed.'
      WHERE trading_date = ?
        AND instr(scope, ?) = 1
        AND scope <> ?
        AND status IN ('queued', 'running', 'failed')`,
  ).bind(tradingDate, POST_CLOSE_SCOPE, identity.scope).run();
  await stateEnv.DB.prepare(
    `INSERT INTO post_close_daily_bar_refresh_jobs
      (id, trading_date, scope, status, source_provider, source_feed, adjustment,
       started_at, updated_at, completed_at, error, total_tickers, processed_tickers, cursor_offset, missing_current_date_tickers)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, ?, 0, 0, ?)`,
  )
    .bind(id, tradingDate, identity.scope, identity.provider, identity.feed, identity.adjustment, totalTickers, totalTickers)
    .run();
  const created = await loadPostCloseDailyBarRefreshJobRecord(stateEnv, id);
  if (!created) throw new Error("Failed to create post-close daily bar refresh job.");
  await materializePostCloseJobItems(env, stateEnv, id, created.totalTickers);
  return created;
}

export async function processPostCloseDailyBarRefreshJob(
  env: Env,
  jobId: string,
  options?: { batchSize?: number; maxBatches?: number; maxHistoryBatches?: number },
): Promise<PostCloseDailyBarRefreshJob | null> {
  const stateEnv = postCloseStateEnv(env);
  await ensurePostCloseRetrySchema(stateEnv);
  let job = await loadPostCloseDailyBarRefreshJobRecord(stateEnv, jobId);
  if (!job) return null;
  if (job.status === "completed") {
    const summary = await loadPostCloseJobItemSummary(stateEnv, job.id);
    if (isPostCloseJobComplete(job.totalTickers, summary.itemCount, summary.incompleteCount)) {
      return mapPostCloseDailyBarRefreshJobRecord(job);
    }
    await updatePostCloseDailyBarRefreshJobRecord(stateEnv, job.id, {
      status: "queued",
      completedAt: null,
      nextAttemptAt: null,
    });
    job = await loadPostCloseDailyBarRefreshJobRecord(stateEnv, job.id);
    if (!job) return null;
  }
  if (job.status === "failed" || job.status === "superseded") {
    return mapPostCloseDailyBarRefreshJobRecord(job);
  }
  if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > Date.now()) {
    return mapPostCloseDailyBarRefreshJobRecord(job);
  }

  const attemptCount = Number(job.attemptCount ?? 0) + 1;
  let leasedItems: Array<{
    ticker: string;
    ordinal: number;
    attemptCount: number;
    historyRequired: number;
  }> = [];
  let activeLeaseToken: string | null = null;
  try {
    await updatePostCloseDailyBarRefreshJobRecord(stateEnv, job.id, {
      status: "running",
      error: null,
      errorCode: null,
      nextAttemptAt: null,
      attemptCount,
      leaseExpiresAt: new Date(Date.now() + POST_CLOSE_ITEM_LEASE_MS).toISOString(),
      requestEnd: alpacaHistoricalRequestEnd(job.tradingDate, job.sourceFeed),
    });
    let cursorOffset = job.cursorOffset;
    let fetchedRows = Number(job.fetchedRows ?? 0);
    let writtenRows = Number(job.writtenRows ?? 0);
    const invocationPlan = postCloseInvocationBatchPlan(options ?? {});
    const batchSize = invocationPlan.exactBatchSize;
    const maxBatches = invocationPlan.exactBatches;
    const maxHistoryBatches = Math.min(1, Math.max(0, Math.trunc(options?.maxHistoryBatches ?? 1)));
    let exactBatchCount = 0;
    let historyBatchCount = 0;
    const pinnedEnv: Env = {
      ...env,
      DATA_PROVIDER: job.sourceProvider,
      ALPACA_DAILY_FEED: job.sourceFeed,
      ALPACA_DAILY_ADJUSTMENT: job.adjustment,
    };
    const provider = getProvider(pinnedEnv, { fallbackEnabled: false });

    while (exactBatchCount < maxBatches || historyBatchCount < maxHistoryBatches) {
      if (cursorOffset >= job.totalTickers) cursorOffset = 0;
      const hasIncompleteExactSession = await hasIncompletePostCloseExactSession(stateEnv, job.id);
      const phase: "exact" | "history" = exactBatchCount < maxBatches && hasIncompleteExactSession
        ? "exact"
        : "history";
      if (phase === "history" && historyBatchCount >= maxHistoryBatches) break;
      const phaseCursor = phase === "exact" ? cursorOffset : 0;
      const phaseBatchSize = phase === "exact" ? batchSize : invocationPlan.historyBatchSize;
      let candidateItems = await loadPostCloseJobItemBatch(stateEnv, job.id, phaseCursor, phaseBatchSize, phase);
      if (candidateItems.length === 0) {
        if (phase === "exact" && cursorOffset > 0) {
          cursorOffset = 0;
          continue;
        }
        if (phase === "exact") {
          exactBatchCount = maxBatches;
          continue;
        }
        historyBatchCount += 1;
        break;
      }
      const sourceFeed = job.sourceFeed;
      const candidateCurrentTickers = await loadTickersWithBarOnDate(
        pinnedEnv,
        candidateItems.map((item) => item.ticker),
        job.tradingDate,
      );
      if (phase === "exact" && candidateCurrentTickers.size > 0) {
        const alreadyCurrentItems = candidateItems.filter((item) => candidateCurrentTickers.has(item.ticker));
        const priorTradingDate = previousUsMarketTradingDay(job.tradingDate);
        const alreadyCurrentHistoryItems = alreadyCurrentItems.filter((item) => Number(item.historyRequired) === 1);
        const alreadyCurrentHistoryStates = await loadOverviewHistoryStates(
          pinnedEnv,
          alreadyCurrentHistoryItems.map((item) => item.ticker),
          sourceFeed,
        );
        const advanceableHistoryTickers = alreadyCurrentHistoryItems
          .filter((item) => {
            const state = alreadyCurrentHistoryStates.get(item.ticker);
            return Boolean(
              state
              && state.lookbackStart <= addUtcDays(job.tradingDate, -OVERVIEW_HISTORY_LOOKBACK_DAYS)
              && state.throughDate >= priorTradingDate,
            );
          })
          .map((item) => item.ticker);
        const advanceableHistoryTickerSet = new Set(advanceableHistoryTickers);
        await updatePostCloseJobItems(
          stateEnv,
          job.id,
          alreadyCurrentHistoryItems
            .filter((item) => !advanceableHistoryTickerSet.has(item.ticker))
            .map((item) => item.ticker),
          {
            status: "current-complete",
            barDate: job.tradingDate,
            nextAttemptAt: null,
            leaseExpiresAt: null,
            leaseToken: null,
            lastError: null,
          },
        );
        await updatePostCloseJobItems(stateEnv, job.id, advanceableHistoryTickers, {
          status: "completed",
          barDate: job.tradingDate,
          nextAttemptAt: null,
          leaseExpiresAt: null,
          leaseToken: null,
          lastError: null,
        });
        await checkpointOverviewHistoryStates(
          pinnedEnv,
          advanceableHistoryTickers,
          sourceFeed,
          addUtcDays(job.tradingDate, -OVERVIEW_HISTORY_LOOKBACK_DAYS),
          job.tradingDate,
        );
        await updatePostCloseJobItems(
          stateEnv,
          job.id,
          alreadyCurrentItems.filter((item) => Number(item.historyRequired) !== 1).map((item) => item.ticker),
          {
            status: "completed",
            barDate: job.tradingDate,
            nextAttemptAt: null,
            leaseExpiresAt: null,
            leaseToken: null,
            lastError: null,
          },
        );
        const lastCandidateOrdinal = candidateItems.at(-1)?.ordinal ?? cursorOffset;
        candidateItems = candidateItems.filter((item) => !candidateCurrentTickers.has(item.ticker));
        if (candidateItems.length === 0) {
          cursorOffset = lastCandidateOrdinal + 1;
          exactBatchCount += 1;
          continue;
        }
      }
      const historyCandidates = candidateItems.filter((item) => Number(item.historyRequired) === 1);
      const historyStates = await loadOverviewHistoryStates(
        pinnedEnv,
        historyCandidates.map((item) => item.ticker),
        sourceFeed,
      );
      const batchPlan = planPostCloseProviderBatch({
        items: candidateItems,
        historyStates,
        currentTickers: candidateCurrentTickers,
        tradingDate: job.tradingDate,
        batchSize: phaseBatchSize,
      });
      const selectedBatchItems = batchPlan.items;
      const refreshStartDate = batchPlan.refreshStartDate;
      const historyLookbackStart = batchPlan.historyLookbackStart;
      activeLeaseToken = crypto.randomUUID();
      const itemLeaseExpiresAt = new Date(Date.now() + POST_CLOSE_ITEM_LEASE_MS).toISOString();
      const batchItems = await leasePostCloseJobItems(
        stateEnv,
        job.id,
        selectedBatchItems,
        activeLeaseToken,
        itemLeaseExpiresAt,
      );
      if (batchItems.length === 0) {
        if (phase === "exact") {
          cursorOffset = (selectedBatchItems.at(-1)?.ordinal ?? cursorOffset) + 1;
          exactBatchCount += 1;
        } else {
          historyBatchCount += 1;
        }
        activeLeaseToken = null;
        continue;
      }
      const batchTickers = batchItems.map((item) => item.ticker);
      leasedItems = batchItems;
      const providerKey = job.sourceProvider;
      const preCurrentTickers = await loadTickersWithBarOnDate(pinnedEnv, batchTickers, job.tradingDate);
      await clearProviderSymbolBackoff(pinnedEnv, providerKey, Array.from(preCurrentTickers));
      let refresh = { fetchedRows: 0, writtenRows: 0, currentDateTickers: 0 };
      if (refreshStartDate < job.tradingDate || preCurrentTickers.size < batchTickers.length) {
        const estimatedDays = Math.max(
          1,
          Math.floor((Date.parse(`${job.tradingDate}T00:00:00Z`) - Date.parse(`${refreshStartDate}T00:00:00Z`)) / 86_400_000) + 1,
        );
        if (phase === "exact") {
          await assertMarketDataCriticalWorkBudget(pinnedEnv, {
            rowsRead: batchTickers.length,
            rowsWritten: batchTickers.length,
          });
        } else {
          try {
            await assertMarketDataBackgroundWriteBudget(pinnedEnv, batchTickers.length * estimatedDays);
          } catch (error) {
            const retryAt = retryAtForPostCloseError(error, attemptCount)
              ?? new Date(Date.now() + POST_CLOSE_RETRY_MINUTES * 60_000).toISOString();
            await updatePostCloseJobItems(stateEnv, job.id, batchTickers, {
              status: "history-missing",
              nextAttemptAt: retryAt,
              leaseExpiresAt: null,
              leaseToken: null,
              expectedLeaseToken: activeLeaseToken,
              lastError: error instanceof Error ? error.message : "Historical repair paused by the background data budget.",
            });
            leasedItems = [];
            activeLeaseToken = null;
            historyBatchCount += 1;
            continue;
          }
        }
        refresh = await refreshDailyBarsIncremental(pinnedEnv, {
          provider,
          tickers: batchTickers,
          startDate: refreshStartDate,
          endDate: job.tradingDate,
          replaceExisting: true,
          providerBatchSize: MAX_POST_CLOSE_PROVIDER_BATCH_SIZE,
          target: "market",
          syncSymbolsToCore: true,
        });
      }
      let currentTickers = await loadTickersWithBarOnDate(pinnedEnv, batchTickers, job.tradingDate);
      const yahooRepairItem = batchItems.find((item) => shouldUseYahooRepair({
        attemptCount: Number(item.attemptCount),
        hasCurrentSession: currentTickers.has(item.ticker),
        mode: batchPlan.mode,
      }));
      if (yahooRepairItem) {
        const yahooProvider = getProvider(
          {
            ...pinnedEnv,
            DATA_PROVIDER: "stooq",
            FMP_API_KEY: undefined,
            ALPHA_VANTAGE_API_KEY: undefined,
          },
          {
            yahooPreferredTickers: [yahooRepairItem.ticker],
            fallbackEnabled: true,
            fallbackRequestLimit: 1,
          },
        );
        const repairStartDate = currentTickers.has(yahooRepairItem.ticker)
          ? refreshStartDate
          : job.tradingDate;
        await refreshDailyBarsIncremental(pinnedEnv, {
          provider: yahooProvider,
          tickers: [yahooRepairItem.ticker],
          startDate: repairStartDate,
          endDate: job.tradingDate,
          replaceExisting: true,
          providerBatchSize: 1,
          target: "market",
          repairMissingMarketDates: true,
          continueOnError: true,
        });
        currentTickers = await loadTickersWithBarOnDate(pinnedEnv, batchTickers, job.tradingDate);
      }
      await clearProviderSymbolBackoff(pinnedEnv, providerKey, Array.from(currentTickers));
      const missingTickers = batchTickers.filter((ticker) => !currentTickers.has(ticker));
      const completedTickers: string[] = [];
      const currentOnlyTickers: string[] = [];
      const historyMissingTickers: string[] = [];

      if (batchPlan.mode === "history") {
        const historyItems = batchItems.filter((item) => (
          Number(item.historyRequired) === 1 && currentTickers.has(item.ticker)
        ));
        const coverage = await verifyMarketBarCoverage(pinnedEnv, {
          tickers: historyItems.map((item) => item.ticker),
          requestedStart: historyLookbackStart,
          throughDate: job.tradingDate,
          feed: sourceFeed,
        });
        for (const item of historyItems) {
          if (coverageSatisfiesHistory(coverage.get(item.ticker))) completedTickers.push(item.ticker);
          else historyMissingTickers.push(item.ticker);
        }
        await checkpointOverviewHistoryStates(
          pinnedEnv,
          completedTickers,
          sourceFeed,
          historyLookbackStart,
          job.tradingDate,
        );
      } else {
        const priorTradingDate = previousUsMarketTradingDay(job.tradingDate);
        for (const item of batchItems) {
          if (!currentTickers.has(item.ticker)) continue;
          const state = historyStates.get(item.ticker);
          const historyAlreadyComplete = Number(item.historyRequired) !== 1
            || Boolean(
              state
              && state.lookbackStart <= historyLookbackStart
              && state.throughDate >= priorTradingDate,
            );
          if (historyAlreadyComplete) completedTickers.push(item.ticker);
          else currentOnlyTickers.push(item.ticker);
        }
        await checkpointOverviewHistoryStates(
          pinnedEnv,
          completedTickers.filter((ticker) => Number(batchItems.find((item) => item.ticker === ticker)?.historyRequired) === 1),
          sourceFeed,
          historyLookbackStart,
          job.tradingDate,
        );
      }
      const unresolvedAfterYahooRepair = new Set([...missingTickers, ...historyMissingTickers]);
      const unsupportedTickers = yahooRepairItem && unresolvedAfterYahooRepair.has(yahooRepairItem.ticker)
        ? [yahooRepairItem.ticker]
        : [];
      const retryHistoryMissingTickers = historyMissingTickers.filter((ticker) => !unsupportedTickers.includes(ticker));

      await updatePostCloseJobItems(stateEnv, job.id, completedTickers, {
        status: "completed",
        barDate: job.tradingDate,
        nextAttemptAt: null,
        leaseExpiresAt: null,
        leaseToken: null,
        expectedLeaseToken: activeLeaseToken,
        lastError: null,
      });
      await updatePostCloseJobItems(stateEnv, job.id, currentOnlyTickers, {
        status: "current-complete",
        barDate: job.tradingDate,
        nextAttemptAt: null,
        leaseExpiresAt: null,
        leaseToken: null,
        expectedLeaseToken: activeLeaseToken,
        lastError: null,
      });
      await updatePostCloseJobItems(stateEnv, job.id, retryHistoryMissingTickers, {
        status: "history-missing",
        barDate: job.tradingDate,
        nextAttemptAt: new Date(Date.now() + POST_CLOSE_RETRY_MINUTES * 60_000).toISOString(),
        leaseExpiresAt: null,
        leaseToken: null,
        expectedLeaseToken: activeLeaseToken,
        lastError: `Canonical ${sourceFeed} history still contains missing trading sessions.`,
      });
      await updatePostCloseJobItems(stateEnv, job.id, unsupportedTickers, {
        status: "unsupported",
        barDate: unsupportedTickers.some((ticker) => currentTickers.has(ticker)) ? job.tradingDate : null,
        nextAttemptAt: null,
        leaseExpiresAt: null,
        leaseToken: null,
        expectedLeaseToken: activeLeaseToken,
        lastError: "Alpaca returned no complete result after three attempts and the Yahoo repair attempt did not resolve the session.",
      });
      const missingByAttempt = new Map<number, string[]>();
      for (const item of batchItems) {
        if (!missingTickers.includes(item.ticker) || unsupportedTickers.includes(item.ticker)) continue;
        const itemAttempt = Math.max(1, Number(item.attemptCount ?? 1));
        const rows = missingByAttempt.get(itemAttempt) ?? [];
        rows.push(item.ticker);
        missingByAttempt.set(itemAttempt, rows);
      }
      for (const itemTickers of missingByAttempt.values()) {
        await updatePostCloseJobItems(stateEnv, job.id, itemTickers, {
          status: "missing",
          nextAttemptAt: new Date(Date.now() + POST_CLOSE_DATA_NOT_READY_RETRY_MINUTES * 60_000).toISOString(),
          leaseExpiresAt: null,
          leaseToken: null,
          expectedLeaseToken: activeLeaseToken,
          lastError: `No Alpaca ${sourceFeed} bar was returned for ${job.tradingDate}.`,
        });
      }
      if (phase === "exact") {
        cursorOffset = (batchItems.at(-1)?.ordinal ?? cursorOffset) + 1;
        exactBatchCount += 1;
      } else {
        historyBatchCount += 1;
      }
      fetchedRows += refresh.fetchedRows;
      writtenRows += refresh.writtenRows;
      leasedItems = [];
      activeLeaseToken = null;
      const summary = await loadPostCloseJobItemSummary(stateEnv, job.id);
      const currentDateTickers = summary.currentCount;
      const missingCurrentDateTickers = Math.max(0, job.totalTickers - currentDateTickers);
      const currentDateCoveragePct = job.totalTickers > 0 ? (currentDateTickers / job.totalTickers) * 100 : 0;
      await updatePostCloseDailyBarRefreshJobRecord(stateEnv, job.id, {
        status: "running",
        processedTickers: currentDateTickers,
        cursorOffset,
        fetchedRows,
        writtenRows,
        currentDateTickers,
        missingCurrentDateTickers,
        currentDateCoveragePct,
        leaseExpiresAt: null,
      });
    }

    const summary = await loadPostCloseJobItemSummary(stateEnv, job.id);
    const currentDateTickers = summary.currentCount;
    const missingCurrentDateTickers = Math.max(0, job.totalTickers - currentDateTickers);
    const currentDateCoveragePct = job.totalTickers > 0 ? (currentDateTickers / job.totalTickers) * 100 : 0;
    if (isPostCloseJobComplete(job.totalTickers, summary.itemCount, summary.incompleteCount)) {
      await updatePostCloseDailyBarRefreshJobRecord(stateEnv, job.id, {
        status: "completed",
        processedTickers: currentDateTickers,
        cursorOffset: job.totalTickers,
        completedAt: new Date().toISOString(),
        fetchedRows,
        writtenRows,
        currentDateTickers,
        missingCurrentDateTickers,
        currentDateCoveragePct,
        nextAttemptAt: null,
        leaseExpiresAt: null,
      });
    } else {
      const nextAttemptAt = summary.readyCount > 0
        ? null
        : summary.nextAttemptAt ?? new Date(Date.now() + POST_CLOSE_RETRY_MINUTES * 60_000).toISOString();
      await updatePostCloseDailyBarRefreshJobRecord(stateEnv, job.id, {
        status: "queued",
        processedTickers: currentDateTickers,
        cursorOffset: cursorOffset >= job.totalTickers ? 0 : cursorOffset,
        fetchedRows,
        writtenRows,
        currentDateTickers,
        missingCurrentDateTickers,
        currentDateCoveragePct,
        nextAttemptAt,
        leaseExpiresAt: null,
      });
    }
  } catch (error) {
    const errorCode = classifyPostCloseError(error);
    const retryGroups = new Map<string, string[]>();
    for (const item of leasedItems) {
      const itemAttempt = Math.max(1, Number(item.attemptCount ?? 1));
      const retryAt = retryAtForPostCloseError(error, itemAttempt);
      const key = retryAt ?? "terminal";
      const rows = retryGroups.get(key) ?? [];
      rows.push(item.ticker);
      retryGroups.set(key, rows);
    }
    for (const [retryKey, tickers] of retryGroups) {
      await updatePostCloseJobItems(stateEnv, job.id, tickers, {
        status: errorCode,
        nextAttemptAt: retryKey === "terminal" ? null : retryKey,
        leaseExpiresAt: null,
        leaseToken: null,
        expectedLeaseToken: activeLeaseToken,
        lastError: error instanceof Error ? error.message : "Post-close daily bar refresh failed.",
      });
    }
    const retryTimes = Array.from(retryGroups.keys()).filter((value) => value !== "terminal").sort();
    const nextAttemptAt = retryTimes[0]
      ?? (leasedItems.length === 0 ? retryAtForPostCloseError(error, attemptCount) : null);
    await updatePostCloseDailyBarRefreshJobRecord(stateEnv, job.id, {
      status: errorCode === "auth-blocked" ? "failed" : "queued",
      error: error instanceof Error ? error.message : "Post-close daily bar refresh failed.",
      errorCode,
      nextAttemptAt,
      leaseExpiresAt: null,
      completedAt: errorCode === "auth-blocked" ? new Date().toISOString() : null,
    });
  }

  const updated = await loadPostCloseDailyBarRefreshJobRecord(stateEnv, job.id);
  return updated ? mapPostCloseDailyBarRefreshJobRecord(updated) : null;
}

export async function maybeRunScheduledPostCloseDailyBarRefresh(
  env: Env,
  now: Date,
  settings: WorkerScheduleSettings,
): Promise<PostCloseDailyBarRefreshJob | null> {
  if (!settings.postCloseBarsEnabled) return null;
  const expectedTradingDate = latestUsMarketSessionAsOfDate(now);
  await ensureMarketCalendarCoverage(env, expectedTradingDate).catch((error) => {
    console.warn("market calendar refresh failed; using built-in holiday fallback", error);
  });
  const storedSession = await loadStoredMarketSession(env, expectedTradingDate).catch(() => null);
  if (!isPostCloseBarsWindowOpen(
    now,
    expectedTradingDate,
    settings.postCloseBarsOffsetMinutes,
    storedSession?.closeAt,
  )) return null;
  await cleanupMarketDataOperationalState(env, expectedTradingDate);
  const jobRecord = await ensurePostCloseDailyBarRefreshJob(env, expectedTradingDate);
  const stateEnv = postCloseStateEnv(env);
  const priorRecord = await loadNewestIncompletePriorPostCloseJobRecord(
    stateEnv,
    expectedTradingDate,
    postCloseJobIdentity(env),
  );
  const prior = priorRecord
    ? await requeueRecentSipRestrictionJob(stateEnv, priorRecord) ?? priorRecord
    : null;
  const invocationPlan = postCloseInvocationBatchPlan({
    batchSize: settings.postCloseBarsBatchSize,
    maxBatches: settings.postCloseBarsMaxBatchesPerTick,
  });
  const canProcessPrior = Boolean(
    prior
    && !(prior.status === "failed" && prior.errorCode === "auth-blocked")
    && invocationPlan.exactBatches >= 2,
  );
  const current = await processPostCloseDailyBarRefreshJob(env, jobRecord.id, {
    batchSize: invocationPlan.exactBatchSize,
    maxBatches: canProcessPrior ? invocationPlan.exactBatches - 1 : invocationPlan.exactBatches,
    maxHistoryBatches: 1,
  });
  if (canProcessPrior && prior) {
    await processPostCloseDailyBarRefreshJob(env, prior.id, {
      batchSize: invocationPlan.exactBatchSize,
      maxBatches: 1,
      maxHistoryBatches: 0,
    });
  }
  return current;
}

export async function loadLatestPostCloseDailyBarRefreshJobForDate(
  env: Env,
  tradingDate: string,
): Promise<PostCloseDailyBarRefreshJob | null> {
  const stateEnv = postCloseStateEnv(env);
  await ensurePostCloseRetrySchema(stateEnv);
  const record = await loadLatestPostCloseDailyBarRefreshJobRecordForDate(stateEnv, tradingDate, postCloseJobIdentity(env));
  return record ? mapPostCloseDailyBarRefreshJobRecord(record) : null;
}

export async function planPostCloseBudgetProtection(
  env: Env,
  now: Date,
  settings: WorkerScheduleSettings,
): Promise<PostCloseBudgetProtectionDecision> {
  const expectedTradingDate = latestUsMarketSessionAsOfDate(now);
  if (!settings.postCloseBarsEnabled) {
    return { protect: false, expectedTradingDate, reason: "disabled" };
  }
  if (!isPostCloseBarsWindowOpen(now, expectedTradingDate, settings.postCloseBarsOffsetMinutes)) {
    return { protect: false, expectedTradingDate, reason: "before-window" };
  }

  try {
    const stateEnv = postCloseStateEnv(env);
    const record = await loadLatestPostCloseDailyBarRefreshJobRecordForDate(stateEnv, expectedTradingDate, postCloseJobIdentity(env));
    const job = record ? mapPostCloseDailyBarRefreshJobRecord(record) : null;
    const storedSession = await loadStoredMarketSession(env, expectedTradingDate).catch(() => null);
    return resolvePostCloseBudgetProtection({
      now,
      expectedTradingDate,
      settings,
      job,
      marketCloseTime: storedSession?.closeAt,
    });
  } catch (error) {
    console.warn("post-close budget protection diagnostic failed", { expectedTradingDate, error });
    return { protect: true, expectedTradingDate, reason: "diagnostic-failed" };
  }
}
