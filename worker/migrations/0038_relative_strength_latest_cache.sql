ALTER TABLE scan_refresh_jobs ADD COLUMN config_key TEXT;

ALTER TABLE scan_refresh_jobs ADD COLUMN expected_trading_date TEXT;

ALTER TABLE scan_refresh_jobs ADD COLUMN benchmark_ticker TEXT;

ALTER TABLE scan_refresh_jobs ADD COLUMN rs_ma_type TEXT;

ALTER TABLE scan_refresh_jobs ADD COLUMN rs_ma_length INTEGER NOT NULL DEFAULT 21;

ALTER TABLE scan_refresh_jobs ADD COLUMN new_high_lookback INTEGER NOT NULL DEFAULT 252;

CREATE INDEX IF NOT EXISTS idx_scan_refresh_jobs_config_expected_status_updated
  ON scan_refresh_jobs(config_key, expected_trading_date, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_scan_refresh_jobs_config_started_desc
  ON scan_refresh_jobs(config_key, started_at DESC);

CREATE TABLE IF NOT EXISTS relative_strength_latest_cache (
  config_key TEXT NOT NULL,
  ticker TEXT NOT NULL,
  benchmark_ticker TEXT NOT NULL,
  rs_ma_type TEXT NOT NULL,
  rs_ma_length INTEGER NOT NULL,
  new_high_lookback INTEGER NOT NULL,
  trading_date TEXT NOT NULL,
  price_close REAL,
  change_1d REAL,
  rs_ratio_close REAL,
  rs_ratio_ma REAL,
  rs_above_ma INTEGER NOT NULL DEFAULT 0,
  rs_new_high INTEGER NOT NULL DEFAULT 0,
  rs_new_high_before_price INTEGER NOT NULL DEFAULT 0,
  bull_cross INTEGER NOT NULL DEFAULT 0,
  approx_rs_rating INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (config_key, ticker)
);

CREATE INDEX IF NOT EXISTS idx_relative_strength_latest_cache_lookup
  ON relative_strength_latest_cache(config_key, trading_date DESC, ticker ASC);

CREATE INDEX IF NOT EXISTS idx_relative_strength_latest_cache_ticker
  ON relative_strength_latest_cache(ticker, config_key, trading_date DESC);
