CREATE TABLE IF NOT EXISTS overview_provider_symbols (
  provider_key TEXT NOT NULL,
  ticker TEXT NOT NULL,
  provider_symbol TEXT,
  support_status TEXT NOT NULL,
  reason TEXT,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider_key, ticker)
);

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
);

CREATE INDEX IF NOT EXISTS idx_overview_current_data_session_status
  ON overview_current_data (config_id, session_date, status);

ALTER TABLE daily_bars ADD COLUMN source_provider TEXT;
ALTER TABLE daily_bars ADD COLUMN source_feed TEXT;
ALTER TABLE daily_bars ADD COLUMN fetched_at TEXT;

CREATE INDEX IF NOT EXISTS idx_daily_bars_provider_feed_ticker_date
  ON daily_bars (source_provider, source_feed, ticker, date);

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
);

ALTER TABLE post_close_daily_bar_refresh_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE post_close_daily_bar_refresh_jobs ADD COLUMN next_attempt_at TEXT;
ALTER TABLE post_close_daily_bar_refresh_jobs ADD COLUMN error_code TEXT;
ALTER TABLE post_close_daily_bar_refresh_jobs ADD COLUMN lease_expires_at TEXT;

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
);

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
);

UPDATE daily_bars
SET source_provider = 'legacy-unverified',
    source_feed = NULL
WHERE source_provider IS NULL;

UPDATE worker_schedule_settings
SET post_close_bars_batch_size = MIN(post_close_bars_batch_size, 80),
    post_close_bars_max_batches_per_tick = MIN(post_close_bars_max_batches_per_tick, 4),
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'default';
