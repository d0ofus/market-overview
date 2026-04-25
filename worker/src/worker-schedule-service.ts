import { refreshDailyBarsIncremental } from "./daily-bars";
import { latestUsSessionAsOfDate, zonedParts } from "./refresh-timing";
import type { Env, PostCloseDailyBarRefreshJob, WorkerScheduleSettings } from "./types";

const DEFAULT_WORKER_SCHEDULE_ID = "default";
const DEFAULT_RS_BACKGROUND_BATCH_SIZE = 50;
const DEFAULT_RS_BACKGROUND_MAX_BATCHES_PER_TICK = 20;
const DEFAULT_RS_BACKGROUND_TIME_BUDGET_MS = 15_000;
const DEFAULT_POST_CLOSE_BARS_OFFSET_MINUTES = 60;
const DEFAULT_POST_CLOSE_BARS_BATCH_SIZE = 400;
const DEFAULT_POST_CLOSE_BARS_MAX_BATCHES_PER_TICK = 4;
const POST_CLOSE_SCOPE = "active-us-common-stocks";
export const FIXED_WORKER_CRON_EXPRESSION = "*/15 * * * *";

type WorkerScheduleSettingsRow = {
  id: string;
  rsBackgroundEnabled: number | null;
  rsBackgroundBatchSize: number | null;
  rsBackgroundMaxBatchesPerTick: number | null;
  rsBackgroundTimeBudgetMs: number | null;
  postCloseBarsEnabled: number | null;
  postCloseBarsOffsetMinutes: number | null;
  postCloseBarsBatchSize: number | null;
  postCloseBarsMaxBatchesPerTick: number | null;
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
    postCloseBarsEnabled: asBooleanFlag(row?.postCloseBarsEnabled, true),
    postCloseBarsOffsetMinutes: Math.max(0, coerceInt(row?.postCloseBarsOffsetMinutes, DEFAULT_POST_CLOSE_BARS_OFFSET_MINUTES)),
    postCloseBarsBatchSize: Math.max(1, coerceInt(row?.postCloseBarsBatchSize, DEFAULT_POST_CLOSE_BARS_BATCH_SIZE)),
    postCloseBarsMaxBatchesPerTick: Math.max(1, coerceInt(row?.postCloseBarsMaxBatchesPerTick, DEFAULT_POST_CLOSE_BARS_MAX_BATCHES_PER_TICK)),
  };
}

async function ensureWorkerScheduleSettingsRow(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO worker_schedule_settings
      (id, rs_background_enabled, rs_background_batch_size, rs_background_max_batches_per_tick, rs_background_time_budget_ms, post_close_bars_enabled, post_close_bars_offset_minutes, post_close_bars_batch_size, post_close_bars_max_batches_per_tick, updated_at)
     VALUES (?, 0, ?, ?, ?, 1, ?, ?, ?, CURRENT_TIMESTAMP)`,
  )
    .bind(
      DEFAULT_WORKER_SCHEDULE_ID,
      DEFAULT_RS_BACKGROUND_BATCH_SIZE,
      DEFAULT_RS_BACKGROUND_MAX_BATCHES_PER_TICK,
      DEFAULT_RS_BACKGROUND_TIME_BUDGET_MS,
      DEFAULT_POST_CLOSE_BARS_OFFSET_MINUTES,
      DEFAULT_POST_CLOSE_BARS_BATCH_SIZE,
      DEFAULT_POST_CLOSE_BARS_MAX_BATCHES_PER_TICK,
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
       post_close_bars_enabled as postCloseBarsEnabled,
       post_close_bars_offset_minutes as postCloseBarsOffsetMinutes,
       post_close_bars_batch_size as postCloseBarsBatchSize,
       post_close_bars_max_batches_per_tick as postCloseBarsMaxBatchesPerTick
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
      (id, rs_background_enabled, rs_background_batch_size, rs_background_max_batches_per_tick, rs_background_time_budget_ms, post_close_bars_enabled, post_close_bars_offset_minutes, post_close_bars_batch_size, post_close_bars_max_batches_per_tick, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       rs_background_enabled = excluded.rs_background_enabled,
       rs_background_batch_size = excluded.rs_background_batch_size,
       rs_background_max_batches_per_tick = excluded.rs_background_max_batches_per_tick,
       rs_background_time_budget_ms = excluded.rs_background_time_budget_ms,
       post_close_bars_enabled = excluded.post_close_bars_enabled,
       post_close_bars_offset_minutes = excluded.post_close_bars_offset_minutes,
       post_close_bars_batch_size = excluded.post_close_bars_batch_size,
       post_close_bars_max_batches_per_tick = excluded.post_close_bars_max_batches_per_tick,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      payload.id || DEFAULT_WORKER_SCHEDULE_ID,
      payload.rsBackgroundEnabled ? 1 : 0,
      payload.rsBackgroundBatchSize,
      payload.rsBackgroundMaxBatchesPerTick,
      payload.rsBackgroundTimeBudgetMs,
      payload.postCloseBarsEnabled ? 1 : 0,
      payload.postCloseBarsOffsetMinutes,
      payload.postCloseBarsBatchSize,
      payload.postCloseBarsMaxBatchesPerTick,
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
       cursor_offset as cursorOffset
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
       cursor_offset as cursorOffset
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
  await env.DB.prepare(
    `UPDATE post_close_daily_bar_refresh_jobs
     SET ${assignments.join(", ")}
     WHERE id = ?`,
  )
    .bind(...values, jobId)
    .run();
}

async function loadPostCloseDailyBarUniverseCount(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count
     FROM symbols s
     WHERE COALESCE(s.is_active, 1) = 1
       AND COALESCE(s.catalog_managed, 0) = 1
       AND lower(COALESCE(s.asset_class, '')) IN ('equity', 'stock')`,
  )
    .first<{ count: number | string | null }>();
  return Math.max(0, Number(row?.count ?? 0) || 0);
}

async function loadPostCloseDailyBarUniverseBatch(
  env: Env,
  cursorOffset: number,
  limit: number,
): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT s.ticker as ticker
     FROM symbols s
     WHERE COALESCE(s.is_active, 1) = 1
       AND COALESCE(s.catalog_managed, 0) = 1
       AND lower(COALESCE(s.asset_class, '')) IN ('equity', 'stock')
     ORDER BY s.ticker ASC
     LIMIT ?
     OFFSET ?`,
  )
    .bind(limit, cursorOffset)
    .all<{ ticker: string }>();
  return (rows.results ?? [])
    .map((row) => row.ticker.trim().toUpperCase())
    .filter(Boolean);
}

async function ensurePostCloseDailyBarRefreshJob(
  env: Env,
  tradingDate: string,
): Promise<PostCloseDailyBarRefreshJobRecord> {
  const existing = await loadLatestPostCloseDailyBarRefreshJobRecordForDate(env, tradingDate);
  if (existing) {
    if (existing.status === "failed") {
      await updatePostCloseDailyBarRefreshJobRecord(env, existing.id, {
        status: "queued",
        error: null,
        completedAt: null,
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
      (id, trading_date, scope, status, started_at, updated_at, completed_at, error, total_tickers, processed_tickers, cursor_offset)
     VALUES (?, ?, ?, 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, ?, 0, 0)`,
  )
    .bind(id, tradingDate, POST_CLOSE_SCOPE, totalTickers)
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
    const batchSize = Math.max(1, options?.batchSize ?? DEFAULT_POST_CLOSE_BARS_BATCH_SIZE);
    const maxBatches = Math.max(1, options?.maxBatches ?? DEFAULT_POST_CLOSE_BARS_MAX_BATCHES_PER_TICK);
    let processedBatchCount = 0;

    while (cursorOffset < job.totalTickers && processedBatchCount < maxBatches) {
      const tickers = await loadPostCloseDailyBarUniverseBatch(env, cursorOffset, batchSize);
      if (tickers.length === 0) break;
      await refreshDailyBarsIncremental(env, {
        tickers,
        startDate: job.tradingDate,
        endDate: job.tradingDate,
      });
      cursorOffset += tickers.length;
      processedBatchCount += 1;
      await updatePostCloseDailyBarRefreshJobRecord(env, job.id, {
        status: "running",
        processedTickers: cursorOffset,
        cursorOffset,
      });
    }

    if (cursorOffset >= job.totalTickers) {
      await updatePostCloseDailyBarRefreshJobRecord(env, job.id, {
        status: "completed",
        processedTickers: cursorOffset,
        cursorOffset,
        completedAt: new Date().toISOString(),
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
  const expectedTradingDate = latestUsSessionAsOfDate(now);
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
