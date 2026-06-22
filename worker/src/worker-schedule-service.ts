import { refreshDailyBarsIncremental } from "./daily-bars";
import { latestUsMarketSessionAsOfDate } from "./market-calendar";
import {
  clearProviderSymbolBackoff,
  loadActiveProviderBackoffTickers,
  recordProviderSymbolNoDataBackoff,
} from "./provider-backoff";
import { zonedParts } from "./refresh-timing";
import type { Env, PostCloseDailyBarRefreshJob, WorkerScheduleSettings } from "./types";

const DEFAULT_WORKER_SCHEDULE_ID = "default";
const DEFAULT_RS_BACKGROUND_BATCH_SIZE = 50;
const DEFAULT_RS_BACKGROUND_MAX_BATCHES_PER_TICK = 20;
const DEFAULT_RS_BACKGROUND_TIME_BUDGET_MS = 15_000;
const DEFAULT_POST_CLOSE_BARS_OFFSET_MINUTES = 60;
const DEFAULT_POST_CLOSE_BARS_BATCH_SIZE = 400;
const DEFAULT_POST_CLOSE_BARS_MAX_BATCHES_PER_TICK = 4;
const POST_CLOSE_STALE_RUNNING_MS = 30 * 60_000;
const DEFAULT_PATTERN_SCAN_OFFSET_MINUTES = 75;
const DEFAULT_PATTERN_SCAN_BATCH_SIZE = 40;
const DEFAULT_PATTERN_SCAN_MAX_BATCHES_PER_TICK = 4;
export const POST_CLOSE_SCOPE = "active-us-common-stocks-plus-overview";
export const FIXED_WORKER_CRON_EXPRESSION = "*/15 * * * *";

const POST_CLOSE_DAILY_BAR_UNIVERSE_SELECT = `
  SELECT ticker, MIN(priority) as priority
  FROM (
    SELECT UPPER(TRIM(di.ticker)) as ticker, 0 as priority
    FROM dashboard_items di
    JOIN dashboard_groups dg ON dg.id = di.group_id
    JOIN dashboard_sections ds ON ds.id = dg.section_id
    JOIN dashboard_configs dc ON dc.id = ds.config_id
    WHERE dc.is_default = 1
      AND di.enabled = 1
      AND (ds.title LIKE '%Macro%' OR ds.title LIKE '%Equities%')
    UNION ALL
    SELECT UPPER(TRIM(s.ticker)) as ticker, 1 as priority
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
  status: "queued" | "running" | "completed" | "failed";
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
};

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
): boolean {
  const ny = zonedParts(now, "America/New_York");
  const closeMinutesWithOffset = 16 * 60 + Math.max(0, offsetMinutes);
  if (ny.localDate > expectedTradingDate) return true;
  return ny.localDate === expectedTradingDate && ny.minutesOfDay >= closeMinutesWithOffset;
}

function mapPostCloseDailyBarRefreshJobRecord(
  record: PostCloseDailyBarRefreshJobRecord,
): PostCloseDailyBarRefreshJob {
  return {
    id: record.id,
    tradingDate: record.tradingDate,
    scope: record.scope,
    status: record.status,
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
        current_date_coverage_pct as currentDateCoveragePct
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
): Promise<PostCloseDailyBarRefreshJobRecord | null> {
  return await env.DB.prepare(
    `SELECT
       id,
       trading_date as tradingDate,
       scope,
       status,
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
        current_date_coverage_pct as currentDateCoveragePct
     FROM post_close_daily_bar_refresh_jobs
     WHERE scope = ?
       AND trading_date = ?
     ORDER BY datetime(started_at) DESC
     LIMIT 1`,
  )
    .bind(POST_CLOSE_SCOPE, tradingDate)
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

async function loadPostCloseDailyBarUniverseBatch(
  env: Env,
  cursorOffset: number,
  limit: number,
): Promise<string[]> {
  const rows = await env.DB.prepare(buildPostCloseDailyBarUniverseQuery("batch"))
    .bind(limit, cursorOffset)
    .all<{ ticker: string }>();
  return (rows.results ?? [])
    .map((row) => row.ticker.trim().toUpperCase())
    .filter(Boolean);
}

async function loadTickersWithBarOnDate(env: Env, tickers: string[], date: string): Promise<Set<string>> {
  const unique = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  const out = new Set<string>();
  for (let i = 0; i < unique.length; i += 80) {
    const batch = unique.slice(i, i + 80);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT DISTINCT ticker
         FROM daily_bars
        WHERE date = ?
          AND ticker IN (${placeholders})`,
    ).bind(date, ...batch).all<{ ticker: string }>();
    for (const row of rows.results ?? []) {
      const ticker = row.ticker?.trim().toUpperCase();
      if (ticker) out.add(ticker);
    }
  }
  return out;
}

async function loadPostCloseNoDataBackoffProtectedTickers(env: Env, tickers: string[]): Promise<Set<string>> {
  const unique = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  const out = new Set<string>();
  for (let i = 0; i < unique.length; i += 80) {
    const batch = unique.slice(i, i + 80);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => "?").join(",");
    try {
      const rows = await env.DB.prepare(
        `SELECT UPPER(TRIM(di.ticker)) as ticker
           FROM dashboard_items di
           JOIN dashboard_groups dg ON dg.id = di.group_id
           JOIN dashboard_sections ds ON ds.id = dg.section_id
           JOIN dashboard_configs dc ON dc.id = ds.config_id
          WHERE dc.is_default = 1
            AND di.enabled = 1
            AND (ds.title LIKE '%Macro%' OR ds.title LIKE '%Equities%')
            AND UPPER(TRIM(di.ticker)) IN (${placeholders})
         UNION
         SELECT UPPER(TRIM(ticker)) as ticker
           FROM etf_watchlists
          WHERE UPPER(TRIM(ticker)) IN (${placeholders})
         UNION
         SELECT UPPER(TRIM(ticker)) as ticker
           FROM symbols
          WHERE lower(COALESCE(asset_class, '')) = 'etf'
            AND UPPER(TRIM(ticker)) IN (${placeholders})`,
      ).bind(...batch, ...batch, ...batch).all<{ ticker: string }>();
      for (const row of rows.results ?? []) {
        const ticker = row.ticker?.trim().toUpperCase();
        if (ticker) out.add(ticker);
      }
    } catch (error) {
      console.warn("post-close backoff protected ticker lookup failed", { batchSize: batch.length, error });
      for (const ticker of batch) out.add(ticker);
    }
  }
  return out;
}

function isStaleRunningPostCloseJob(job: PostCloseDailyBarRefreshJobRecord, now = new Date()): boolean {
  if (job.status !== "running") return false;
  const updatedAtMs = Date.parse(job.updatedAt.endsWith("Z") ? job.updatedAt : `${job.updatedAt.replace(" ", "T")}Z`);
  return Number.isFinite(updatedAtMs) && now.getTime() - updatedAtMs > POST_CLOSE_STALE_RUNNING_MS;
}

async function ensurePostCloseDailyBarRefreshJob(
  env: Env,
  tradingDate: string,
): Promise<PostCloseDailyBarRefreshJobRecord> {
  const existing = await loadLatestPostCloseDailyBarRefreshJobRecordForDate(env, tradingDate);
  if (existing) {
    if (isStaleRunningPostCloseJob(existing)) {
      await updatePostCloseDailyBarRefreshJobRecord(env, existing.id, {
        status: "queued",
        error: null,
        completedAt: null,
      });
      const reset = await loadPostCloseDailyBarRefreshJobRecord(env, existing.id);
      if (reset) return reset;
    }
    if (existing.status === "failed") {
      await updatePostCloseDailyBarRefreshJobRecord(env, existing.id, {
        status: "queued",
        error: null,
        completedAt: null,
        fetchedRows: 0,
        writtenRows: 0,
        currentDateTickers: 0,
        missingCurrentDateTickers: existing.totalTickers,
        currentDateCoveragePct: 0,
      });
      const reset = await loadPostCloseDailyBarRefreshJobRecord(env, existing.id);
      if (reset) return reset;
    }
    return existing;
  }

  const id = crypto.randomUUID();
  const totalTickers = await loadPostCloseDailyBarUniverseCount(env);
  await env.DB.prepare(
    `INSERT INTO post_close_daily_bar_refresh_jobs
      (id, trading_date, scope, status, started_at, updated_at, completed_at, error, total_tickers, processed_tickers, cursor_offset, missing_current_date_tickers)
     VALUES (?, ?, ?, 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, ?, 0, 0, ?)`,
  )
    .bind(id, tradingDate, POST_CLOSE_SCOPE, totalTickers, totalTickers)
    .run();
  const created = await loadPostCloseDailyBarRefreshJobRecord(env, id);
  if (!created) throw new Error("Failed to create post-close daily bar refresh job.");
  return created;
}

export async function processPostCloseDailyBarRefreshJob(
  env: Env,
  jobId: string,
  options?: { batchSize?: number; maxBatches?: number },
): Promise<PostCloseDailyBarRefreshJob | null> {
  const job = await loadPostCloseDailyBarRefreshJobRecord(env, jobId);
  if (!job) return null;
  if (job.status === "completed" || job.status === "failed") {
    return mapPostCloseDailyBarRefreshJobRecord(job);
  }

  try {
    await updatePostCloseDailyBarRefreshJobRecord(env, job.id, { status: "running", error: null });
    let cursorOffset = job.cursorOffset;
    let fetchedRows = Number(job.fetchedRows ?? 0);
    let writtenRows = Number(job.writtenRows ?? 0);
    let currentDateTickers = Number(job.currentDateTickers ?? 0);
    let missingCurrentDateTickers = Number(job.missingCurrentDateTickers ?? Math.max(0, job.totalTickers - currentDateTickers));
    let currentDateCoveragePct = Number(job.currentDateCoveragePct ?? 0);
    const batchSize = Math.max(1, options?.batchSize ?? DEFAULT_POST_CLOSE_BARS_BATCH_SIZE);
    const maxBatches = Math.max(1, options?.maxBatches ?? DEFAULT_POST_CLOSE_BARS_MAX_BATCHES_PER_TICK);
    let processedBatchCount = 0;

    while (cursorOffset < job.totalTickers && processedBatchCount < maxBatches) {
      const batchTickers = await loadPostCloseDailyBarUniverseBatch(env, cursorOffset, batchSize);
      if (batchTickers.length === 0) break;
      const providerKey = (env.DATA_PROVIDER ?? "alpaca").trim().toLowerCase() || "alpaca";
      const protectedTickers = await loadPostCloseNoDataBackoffProtectedTickers(env, batchTickers);
      const preCurrentTickers = await loadTickersWithBarOnDate(env, batchTickers, job.tradingDate);
      await clearProviderSymbolBackoff(env, providerKey, Array.from(preCurrentTickers));
      const backoffEligibleTickers = batchTickers.filter((ticker) => !protectedTickers.has(ticker) && !preCurrentTickers.has(ticker));
      const activeBackoffTickers = await loadActiveProviderBackoffTickers(env, providerKey, backoffEligibleTickers);
      const tickers = batchTickers.filter((ticker) => !activeBackoffTickers.has(ticker));
      let refresh = { fetchedRows: 0, writtenRows: 0, currentDateTickers: 0 };
      if (tickers.length > 0) {
        refresh = await refreshDailyBarsIncremental(env, {
          tickers,
          startDate: job.tradingDate,
          endDate: job.tradingDate,
        });
      }
      const currentTickers = await loadTickersWithBarOnDate(env, batchTickers, job.tradingDate);
      await clearProviderSymbolBackoff(env, providerKey, Array.from(currentTickers));
      const noDataTickers = tickers.filter((ticker) => !protectedTickers.has(ticker) && !currentTickers.has(ticker));
      await recordProviderSymbolNoDataBackoff(env, providerKey, noDataTickers, "post_close_no_current_bar", 7);
      cursorOffset += batchTickers.length;
      fetchedRows += refresh.fetchedRows;
      writtenRows += refresh.writtenRows;
      currentDateTickers += currentTickers.size;
      missingCurrentDateTickers = Math.max(0, job.totalTickers - currentDateTickers);
      currentDateCoveragePct = job.totalTickers > 0 ? (currentDateTickers / job.totalTickers) * 100 : 0;
      processedBatchCount += 1;
      await updatePostCloseDailyBarRefreshJobRecord(env, job.id, {
        status: "running",
        processedTickers: cursorOffset,
        cursorOffset,
        fetchedRows,
        writtenRows,
        currentDateTickers,
        missingCurrentDateTickers,
        currentDateCoveragePct,
      });
    }

    if (cursorOffset >= job.totalTickers) {
      await updatePostCloseDailyBarRefreshJobRecord(env, job.id, {
        status: "completed",
        processedTickers: cursorOffset,
        cursorOffset,
        completedAt: new Date().toISOString(),
        fetchedRows,
        writtenRows,
        currentDateTickers,
        missingCurrentDateTickers,
        currentDateCoveragePct,
      });
    }
  } catch (error) {
    await updatePostCloseDailyBarRefreshJobRecord(env, job.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Post-close daily bar refresh failed.",
      completedAt: new Date().toISOString(),
    });
  }

  const updated = await loadPostCloseDailyBarRefreshJobRecord(env, job.id);
  return updated ? mapPostCloseDailyBarRefreshJobRecord(updated) : null;
}

export async function maybeRunScheduledPostCloseDailyBarRefresh(
  env: Env,
  now: Date,
  settings: WorkerScheduleSettings,
): Promise<PostCloseDailyBarRefreshJob | null> {
  if (!settings.postCloseBarsEnabled) return null;
  const expectedTradingDate = latestUsMarketSessionAsOfDate(now);
  if (!isPostCloseBarsWindowOpen(now, expectedTradingDate, settings.postCloseBarsOffsetMinutes)) return null;
  const jobRecord = await ensurePostCloseDailyBarRefreshJob(env, expectedTradingDate);
  return await processPostCloseDailyBarRefreshJob(env, jobRecord.id, {
    batchSize: settings.postCloseBarsBatchSize,
    maxBatches: settings.postCloseBarsMaxBatchesPerTick,
  });
}

export async function loadLatestPostCloseDailyBarRefreshJobForDate(
  env: Env,
  tradingDate: string,
): Promise<PostCloseDailyBarRefreshJob | null> {
  const record = await loadLatestPostCloseDailyBarRefreshJobRecordForDate(env, tradingDate);
  return record ? mapPostCloseDailyBarRefreshJobRecord(record) : null;
}
