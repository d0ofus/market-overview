import type { Env } from "./types";

const DEFAULT_RETENTION_DAYS = 450;
const DEFAULT_DAILY_WRITE_BUDGET = 75_000;
const DEFAULT_WARN_BYTES = 300_000_000;
const DEFAULT_HALT_BYTES = 375_000_000;

function enabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

export function getMarketDataDb(env: Env): D1Database {
  if (env.MARKET_DATA_DB) return env.MARKET_DATA_DB;
  if (enabled(env.MARKET_DATA_DB_REQUIRED)) {
    throw new Error("MARKET_DATA_DB is required but is not bound.");
  }
  return env.DB;
}

export function withDatabase(env: Env, db: D1Database): Env {
  return { ...env, DB: db };
}

export function marketDataFeed(env: Env): string {
  return (env.ALPACA_FEED ?? "iex").trim().toLowerCase() || "iex";
}

export function marketDataRetentionCutoff(env: Env, asOfDate: string): string {
  const days = Math.max(365, positiveInteger(env.MARKET_DATA_RETENTION_DAYS, DEFAULT_RETENTION_DAYS));
  const date = new Date(`${asOfDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function nextUtcReset(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5)).toISOString();
}

export async function assertMarketDataWriteBudget(env: Env, now = new Date()): Promise<void> {
  const budget = positiveInteger(env.MARKET_DATA_DAILY_WRITE_BUDGET, DEFAULT_DAILY_WRITE_BUDGET);
  if (budget === 0) return;
  const usageDate = now.toISOString().slice(0, 10);
  const row = await getMarketDataDb(env).prepare(
    "SELECT bars_written as barsWritten FROM market_data_daily_usage WHERE usage_date = ? LIMIT 1",
  ).bind(usageDate).first<{ barsWritten: number | null }>();
  if (Number(row?.barsWritten ?? 0) >= budget) {
    const retryAt = nextUtcReset(now);
    const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(retryAt) - now.getTime()) / 1000));
    throw new Error(`Market-data daily rate limit reached; retry-after=${retryAfterSeconds}; reset=${retryAt}`);
  }
}

export async function recordMarketDataBarsWritten(env: Env, count: number, now = new Date()): Promise<void> {
  if (count <= 0) return;
  await getMarketDataDb(env).prepare(
    `INSERT INTO market_data_daily_usage (usage_date, bars_written, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(usage_date) DO UPDATE SET
       bars_written = market_data_daily_usage.bars_written + excluded.bars_written,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(now.toISOString().slice(0, 10), count).run();
}

export function inspectMarketDataSize(env: Env, sizeAfter: number | undefined): void {
  if (!Number.isFinite(sizeAfter)) return;
  const size = Number(sizeAfter);
  const warnBytes = positiveInteger(env.MARKET_DATA_WARN_BYTES, DEFAULT_WARN_BYTES);
  const haltBytes = positiveInteger(env.MARKET_DATA_HALT_BYTES, DEFAULT_HALT_BYTES);
  if (warnBytes > 0 && size >= warnBytes) {
    console.warn("market-data D1 capacity warning", { sizeAfter: size, warnBytes, haltBytes });
  }
}

export async function assertMarketDataCapacity(env: Env): Promise<void> {
  const result = await getMarketDataDb(env).prepare("SELECT 1 as ok").all<{ ok: number }>();
  const size = Number(result.meta?.size_after);
  inspectMarketDataSize(env, size);
  const haltBytes = positiveInteger(env.MARKET_DATA_HALT_BYTES, DEFAULT_HALT_BYTES);
  if (Number.isFinite(size) && haltBytes > 0 && size >= haltBytes) {
    throw new Error(`Market-data D1 capacity halt reached (${size} bytes >= ${haltBytes} bytes).`);
  }
}

function subtractUtcDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export async function cleanupMarketDataOperationalState(env: Env, asOfDate: string): Promise<void> {
  const db = getMarketDataDb(env);
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS market_data_maintenance_state (
       id TEXT PRIMARY KEY,
       last_run_date TEXT,
       updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) STRICT, WITHOUT ROWID`,
  ).run();
  const state = await db.prepare(
    "SELECT last_run_date as lastRunDate FROM market_data_maintenance_state WHERE id = 'default' LIMIT 1",
  ).first<{ lastRunDate: string | null }>();
  const runDate = new Date().toISOString().slice(0, 10);
  if (state?.lastRunDate === runDate) return;
  const currentDataCutoff = subtractUtcDays(asOfDate, 120);
  const jobCutoff = subtractUtcDays(asOfDate, 14);
  await db.batch([
    db.prepare("DELETE FROM overview_current_data WHERE session_date < ?").bind(currentDataCutoff),
    db.prepare("DELETE FROM overview_current_refresh_jobs WHERE session_date < ?").bind(currentDataCutoff),
    db.prepare(
      `DELETE FROM post_close_daily_bar_refresh_job_items
       WHERE job_id IN (
         SELECT id FROM post_close_daily_bar_refresh_jobs
         WHERE trading_date < ?
         ORDER BY trading_date ASC
         LIMIT 1
       )`,
    ).bind(jobCutoff),
    db.prepare(
      `DELETE FROM post_close_daily_bar_refresh_jobs
       WHERE trading_date < ?
         AND id NOT IN (SELECT DISTINCT job_id FROM post_close_daily_bar_refresh_job_items)`,
    ).bind(jobCutoff),
    db.prepare("DELETE FROM market_data_daily_usage WHERE usage_date < ?").bind(subtractUtcDays(runDate, 14)),
    db.prepare(
      `INSERT INTO market_data_maintenance_state (id, last_run_date, updated_at)
       VALUES ('default', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET last_run_date = excluded.last_run_date, updated_at = CURRENT_TIMESTAMP`,
    ).bind(runDate),
  ]);
}
