CREATE TABLE IF NOT EXISTS worker_schedule_settings (
  id TEXT PRIMARY KEY,
  rs_background_enabled INTEGER NOT NULL DEFAULT 1,
  rs_background_max_batches_per_tick INTEGER NOT NULL DEFAULT 20,
  rs_background_time_budget_ms INTEGER NOT NULL DEFAULT 15000,
  post_close_bars_enabled INTEGER NOT NULL DEFAULT 1,
  post_close_bars_offset_minutes INTEGER NOT NULL DEFAULT 60,
  post_close_bars_batch_size INTEGER NOT NULL DEFAULT 400,
  post_close_bars_max_batches_per_tick INTEGER NOT NULL DEFAULT 4,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO worker_schedule_settings (
  id,
  rs_background_enabled,
  rs_background_max_batches_per_tick,
  rs_background_time_budget_ms,
  post_close_bars_enabled,
  post_close_bars_offset_minutes,
  post_close_bars_batch_size,
  post_close_bars_max_batches_per_tick,
  updated_at
) VALUES (
  'default',
  1,
  20,
  15000,
  1,
  60,
  400,
  4,
  CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS post_close_daily_bar_refresh_jobs (
  id TEXT PRIMARY KEY,
  trading_date TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  error TEXT,
  total_tickers INTEGER NOT NULL DEFAULT 0,
  processed_tickers INTEGER NOT NULL DEFAULT 0,
  cursor_offset INTEGER NOT NULL DEFAULT 0,
  UNIQUE(scope, trading_date)
);

CREATE INDEX IF NOT EXISTS idx_post_close_daily_bar_refresh_jobs_scope_date
  ON post_close_daily_bar_refresh_jobs(scope, trading_date DESC);

CREATE INDEX IF NOT EXISTS idx_post_close_daily_bar_refresh_jobs_status_updated
  ON post_close_daily_bar_refresh_jobs(status, updated_at DESC);
