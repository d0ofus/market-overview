CREATE TABLE IF NOT EXISTS post_close_daily_bar_refresh_jobs (
  id TEXT PRIMARY KEY,
  trading_date TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  source_provider TEXT NOT NULL DEFAULT 'alpaca',
  source_feed TEXT NOT NULL DEFAULT 'sip',
  adjustment TEXT NOT NULL DEFAULT 'split',
  request_end TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  error TEXT,
  total_tickers INTEGER NOT NULL DEFAULT 0,
  processed_tickers INTEGER NOT NULL DEFAULT 0,
  cursor_offset INTEGER NOT NULL DEFAULT 0,
  fetched_rows INTEGER NOT NULL DEFAULT 0,
  written_rows INTEGER NOT NULL DEFAULT 0,
  current_date_tickers INTEGER NOT NULL DEFAULT 0,
  missing_current_date_tickers INTEGER NOT NULL DEFAULT 0,
  current_date_coverage_pct REAL NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  error_code TEXT,
  lease_expires_at TEXT,
  UNIQUE(scope, trading_date)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ops_post_close_jobs_due
  ON post_close_daily_bar_refresh_jobs (status, next_attempt_at, trading_date DESC);

CREATE TABLE IF NOT EXISTS post_close_daily_bar_refresh_job_items (
  job_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  history_required INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  lease_expires_at TEXT,
  lease_token TEXT,
  last_error TEXT,
  bar_date TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job_id, ticker)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_ops_post_close_items_due
  ON post_close_daily_bar_refresh_job_items (job_id, status, next_attempt_at, ordinal);

CREATE TABLE IF NOT EXISTS refresh_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  page TEXT NOT NULL,
  ticker TEXT,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at TEXT,
  next_attempt_at TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ops_refresh_jobs_due
  ON refresh_jobs (status, next_attempt_at, created_at);
