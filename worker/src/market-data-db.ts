import type { Env } from "./types";

// About 550 US sessions, with headroom for holidays and leap years. A single
// conservative window avoids cross-database retention joins during rollout.
const DEFAULT_RETENTION_DAYS = 800;
const DEFAULT_DAILY_WRITE_BUDGET = 90_000;
const DEFAULT_CRITICAL_WRITE_RESERVE = 20_000;
const DEFAULT_DAILY_READ_BUDGET = 4_500_000;
const DEFAULT_CRITICAL_READ_RESERVE = 500_000;
const DEFAULT_WARN_BYTES = 400_000_000;
const DEFAULT_HALT_BYTES = 450_000_000;
const MARKET_DATA_TICKER_QUERY_CHUNK_SIZE = 1000;

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
  return (env.ALPACA_DAILY_FEED ?? env.ALPACA_FEED ?? "iex").trim().toLowerCase() || "iex";
}

export async function loadMarketDataTickersWithBarOnDate(
  env: Env,
  tickers: string[],
  date: string,
): Promise<Set<string>> {
  const unique = Array.from(
    new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)),
  );
  const found = new Set<string>();
  const db = getMarketDataDb(env);
  const feed = marketDataFeed(env);

  for (let offset = 0; offset < unique.length; offset += MARKET_DATA_TICKER_QUERY_CHUNK_SIZE) {
    const chunk = unique.slice(offset, offset + MARKET_DATA_TICKER_QUERY_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const rows = await db.prepare(
      `SELECT ticker
       FROM alpaca_daily_bars
       WHERE feed = ?
         AND ticker IN (SELECT CAST(value AS TEXT) FROM json_each(?))
         AND date = ?`,
    )
      .bind(feed, JSON.stringify(chunk), date)
      .all<{ ticker: string }>();
    for (const row of rows.results ?? []) found.add(row.ticker.toUpperCase());
  }

  return found;
}

export function marketDataRetentionCutoff(env: Env, asOfDate: string): string {
  const days = Math.max(800, positiveInteger(env.MARKET_DATA_RETENTION_DAYS, DEFAULT_RETENTION_DAYS));
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
  await assertMarketDataWriteLimit(env, budget, "daily rate limit", now);
  await assertMarketDataReadLimit(
    env,
    positiveInteger(env.MARKET_DATA_DAILY_READ_BUDGET, DEFAULT_DAILY_READ_BUDGET),
    "daily read limit",
    now,
  );
}

export async function assertMarketDataBackgroundWriteBudget(
  env: Env,
  estimatedWrites = 0,
  now = new Date(),
): Promise<void> {
  const budget = positiveInteger(env.MARKET_DATA_DAILY_WRITE_BUDGET, DEFAULT_DAILY_WRITE_BUDGET);
  if (budget === 0) return;
  const reserve = Math.min(
    budget,
    positiveInteger(env.MARKET_DATA_CRITICAL_WRITE_RESERVE, DEFAULT_CRITICAL_WRITE_RESERVE),
  );
  await assertMarketDataWriteLimit(
    env,
    Math.max(0, budget - reserve),
    "background rate limit (critical write reserve)",
    now,
    Math.max(0, Math.trunc(estimatedWrites)),
  );
  const readBudget = positiveInteger(env.MARKET_DATA_DAILY_READ_BUDGET, DEFAULT_DAILY_READ_BUDGET);
  const readReserve = Math.min(
    readBudget,
    positiveInteger(env.MARKET_DATA_CRITICAL_READ_RESERVE, DEFAULT_CRITICAL_READ_RESERVE),
  );
  await assertMarketDataReadLimit(env, Math.max(0, readBudget - readReserve), "background read limit", now);
}

export async function assertMarketDataCriticalWorkBudget(
  env: Env,
  estimates: { rowsRead?: number; rowsWritten?: number },
  now = new Date(),
): Promise<void> {
  const writeBudget = positiveInteger(env.MARKET_DATA_DAILY_WRITE_BUDGET, DEFAULT_DAILY_WRITE_BUDGET);
  const readBudget = positiveInteger(env.MARKET_DATA_DAILY_READ_BUDGET, DEFAULT_DAILY_READ_BUDGET);
  if (writeBudget > 0) {
    await assertMarketDataWriteLimit(
      env,
      writeBudget,
      "daily rate limit",
      now,
      Math.max(0, Math.trunc(estimates.rowsWritten ?? 0)),
    );
  }
  if (readBudget > 0) {
    await assertMarketDataReadLimit(
      env,
      readBudget,
      "daily read limit",
      now,
      Math.max(0, Math.trunc(estimates.rowsRead ?? 0)),
    );
  }
}

async function assertMarketDataReadLimit(
  env: Env,
  limit: number,
  reason: string,
  now: Date,
  estimatedReads = 0,
): Promise<void> {
  if (limit === 0) return;
  const usageDate = now.toISOString().slice(0, 10);
  const row = await getMarketDataDb(env).prepare(
    "SELECT rows_read as rowsRead FROM market_data_daily_usage WHERE usage_date = ? LIMIT 1",
  ).bind(usageDate).first<{ rowsRead: number | null }>();
  const used = Number(row?.rowsRead ?? 0);
  const exhausted = estimatedReads > 0 ? used + estimatedReads > limit : used >= limit;
  if (exhausted) {
    const retryAt = nextUtcReset(now);
    const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(retryAt) - now.getTime()) / 1000));
    throw new Error(`Market-data ${reason} reached; retry-after=${retryAfterSeconds}; reset=${retryAt}`);
  }
}

async function assertMarketDataWriteLimit(
  env: Env,
  limit: number,
  reason: string,
  now: Date,
  estimatedWrites = 0,
): Promise<void> {
  const usageDate = now.toISOString().slice(0, 10);
  const row = await getMarketDataDb(env).prepare(
    "SELECT rows_written as rowsWritten FROM market_data_daily_usage WHERE usage_date = ? LIMIT 1",
  ).bind(usageDate).first<{ rowsWritten: number | null }>();
  const used = Number(row?.rowsWritten ?? 0);
  const exhausted = estimatedWrites > 0 ? used + estimatedWrites > limit : used >= limit;
  if (exhausted) {
    const retryAt = nextUtcReset(now);
    const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(retryAt) - now.getTime()) / 1000));
    throw new Error(`Market-data ${reason} reached; retry-after=${retryAfterSeconds}; reset=${retryAt}`);
  }
}

export async function recordMarketDataBarsWritten(env: Env, count: number, now = new Date()): Promise<void> {
  if (count <= 0) return;
  await getMarketDataDb(env).prepare(
    `INSERT INTO market_data_daily_usage (usage_date, bars_written, rows_written, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(usage_date) DO UPDATE SET
       bars_written = market_data_daily_usage.bars_written + excluded.bars_written,
       rows_written = market_data_daily_usage.rows_written + excluded.rows_written,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(now.toISOString().slice(0, 10), count, count).run();
}

export async function recordMarketDataD1Usage(
  env: Env,
  usage: { rowsRead?: number; rowsWritten?: number; barsChanged?: number },
  now = new Date(),
): Promise<void> {
  const rowsRead = Math.max(0, Math.trunc(usage.rowsRead ?? 0));
  const rowsWritten = Math.max(0, Math.trunc(usage.rowsWritten ?? 0));
  const barsChanged = Math.max(0, Math.trunc(usage.barsChanged ?? 0));
  if (rowsRead === 0 && rowsWritten === 0 && barsChanged === 0) return;
  await getMarketDataDb(env).prepare(
    `INSERT INTO market_data_daily_usage
       (usage_date, bars_written, rows_read, rows_written, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(usage_date) DO UPDATE SET
       bars_written = market_data_daily_usage.bars_written + excluded.bars_written,
       rows_read = market_data_daily_usage.rows_read + excluded.rows_read,
       rows_written = market_data_daily_usage.rows_written + excluded.rows_written,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(now.toISOString().slice(0, 10), barsChanged, rowsRead, rowsWritten).run();
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
  const state = await db.prepare(
    "SELECT last_run_date as lastRunDate FROM market_data_maintenance_state WHERE id = 'default' LIMIT 1",
  ).first<{ lastRunDate: string | null }>();
  const runDate = new Date().toISOString().slice(0, 10);
  if (state?.lastRunDate === runDate) return;
  const currentDataCutoff = subtractUtcDays(asOfDate, 120);
  const jobCutoff = subtractUtcDays(asOfDate, 14);
  const barCutoff = marketDataRetentionCutoff(env, asOfDate);
  const results = await db.batch([
    db.prepare("DELETE FROM alpaca_daily_bars WHERE date < ?").bind(barCutoff),
    db.prepare(
      `DELETE FROM daily_market_features
        WHERE session_date NOT IN (
          SELECT session_date
          FROM (
            SELECT DISTINCT session_date
            FROM daily_market_features
            ORDER BY session_date DESC
            LIMIT 10
          ) retained_sessions
        )`,
    ),
    db.prepare("DELETE FROM overview_current_data WHERE session_date < ?").bind(currentDataCutoff),
    db.prepare("DELETE FROM overview_current_refresh_jobs WHERE session_date < ?").bind(currentDataCutoff),
    db.prepare("DELETE FROM overview_provider_catalog_cache WHERE catalog_date < ?").bind(subtractUtcDays(runDate, 7)),
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
  const usage = results.reduce((total, result) => ({
    rowsRead: total.rowsRead + Number(result.meta?.rows_read ?? 0),
    rowsWritten: total.rowsWritten + Number(result.meta?.rows_written ?? result.meta?.changes ?? 0),
  }), { rowsRead: 0, rowsWritten: 0 });
  await recordMarketDataD1Usage(env, usage);
}
