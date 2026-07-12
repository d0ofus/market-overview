CREATE TABLE IF NOT EXISTS alpaca_daily_bars (
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
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS overview_provider_symbols (
  provider_key TEXT NOT NULL,
  ticker TEXT NOT NULL,
  provider_symbol TEXT,
  support_status TEXT NOT NULL,
  reason TEXT,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider_key, ticker)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS overview_current_data (
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
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_overview_current_data_session_status
  ON overview_current_data (config_id, session_date, status);

CREATE TABLE IF NOT EXISTS overview_current_refresh_jobs (
  config_id TEXT NOT NULL,
  session_date TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  requested_tickers INTEGER NOT NULL DEFAULT 0,
  fresh_tickers INTEGER NOT NULL DEFAULT 0,
  unavailable_tickers INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  PRIMARY KEY (config_id, session_date)
) STRICT, WITHOUT ROWID;

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
  fetched_rows INTEGER NOT NULL DEFAULT 0,
  written_rows INTEGER NOT NULL DEFAULT 0,
  current_date_tickers INTEGER NOT NULL DEFAULT 0,
  missing_current_date_tickers INTEGER NOT NULL DEFAULT 0,
  current_date_coverage_pct REAL NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  error_code TEXT,
  lease_expires_at TEXT,
  UNIQUE (scope, trading_date)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_post_close_daily_bar_refresh_jobs_scope_date
  ON post_close_daily_bar_refresh_jobs (scope, trading_date DESC);

CREATE INDEX IF NOT EXISTS idx_post_close_daily_bar_refresh_jobs_status_updated
  ON post_close_daily_bar_refresh_jobs (status, updated_at DESC);

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

CREATE INDEX IF NOT EXISTS idx_post_close_bar_items_due
  ON post_close_daily_bar_refresh_job_items (job_id, status, next_attempt_at, ordinal);

CREATE TABLE IF NOT EXISTS overview_alpaca_history_state (
  ticker TEXT NOT NULL,
  source_feed TEXT NOT NULL,
  lookback_start TEXT NOT NULL,
  through_date TEXT NOT NULL,
  status TEXT NOT NULL,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticker, source_feed)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS market_data_daily_usage (
  usage_date TEXT PRIMARY KEY,
  bars_written INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT, WITHOUT ROWID;
