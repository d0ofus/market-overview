CREATE TABLE IF NOT EXISTS rs_scan_runs (
  id TEXT PRIMARY KEY,
  active_slot TEXT NOT NULL DEFAULT 'global',
  preset_id TEXT NOT NULL,
  preset_name TEXT NOT NULL,
  config_key TEXT NOT NULL,
  benchmark_ticker TEXT NOT NULL,
  rs_ma_type TEXT NOT NULL,
  rs_ma_length INTEGER NOT NULL,
  new_high_lookback INTEGER NOT NULL,
  expected_trading_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  requested_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  heartbeat_at TEXT,
  completed_at TEXT,
  error TEXT,
  warning TEXT,
  total_tickers INTEGER NOT NULL DEFAULT 0,
  processed_tickers INTEGER NOT NULL DEFAULT 0,
  matched_tickers INTEGER NOT NULL DEFAULT 0,
  cursor_offset INTEGER NOT NULL DEFAULT 0,
  latest_snapshot_id TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rs_scan_runs_single_active
  ON rs_scan_runs(active_slot)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_rs_scan_runs_preset_created
  ON rs_scan_runs(preset_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rs_scan_runs_status_updated
  ON rs_scan_runs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS rs_scan_run_tickers (
  run_id TEXT NOT NULL,
  cursor_offset INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  name TEXT,
  sector TEXT,
  industry TEXT,
  exchange TEXT,
  asset_class TEXT,
  market_cap REAL,
  relative_volume REAL,
  avg_volume REAL,
  price_avg_volume REAL,
  price REAL,
  change_1d REAL,
  status TEXT NOT NULL DEFAULT 'queued',
  reason TEXT,
  latest_trading_date TEXT,
  computed_at TEXT,
  PRIMARY KEY (run_id, ticker),
  FOREIGN KEY (run_id) REFERENCES rs_scan_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rs_scan_run_tickers_cursor
  ON rs_scan_run_tickers(run_id, cursor_offset ASC);

CREATE INDEX IF NOT EXISTS idx_rs_scan_run_tickers_status
  ON rs_scan_run_tickers(run_id, status);

CREATE TABLE IF NOT EXISTS rs_features_latest (
  config_key TEXT NOT NULL,
  ticker TEXT NOT NULL,
  trading_date TEXT,
  benchmark_ticker TEXT NOT NULL,
  rs_ma_type TEXT NOT NULL,
  rs_ma_length INTEGER NOT NULL,
  new_high_lookback INTEGER NOT NULL,
  price_close REAL,
  change_1d REAL,
  rs_ratio_close REAL,
  rs_ratio_ma REAL,
  rs_above_ma INTEGER NOT NULL DEFAULT 0,
  rs_new_high INTEGER NOT NULL DEFAULT 0,
  rs_new_high_before_price INTEGER NOT NULL DEFAULT 0,
  bull_cross INTEGER NOT NULL DEFAULT 0,
  approx_rs_rating INTEGER,
  status TEXT NOT NULL,
  reason TEXT,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (config_key, ticker)
);

CREATE INDEX IF NOT EXISTS idx_rs_features_latest_config_date
  ON rs_features_latest(config_key, trading_date DESC, ticker ASC);

CREATE INDEX IF NOT EXISTS idx_rs_features_latest_status
  ON rs_features_latest(config_key, status, ticker);

CREATE TABLE IF NOT EXISTS rs_scan_rows_latest (
  preset_id TEXT NOT NULL,
  config_key TEXT NOT NULL,
  ticker TEXT NOT NULL,
  rank INTEGER NOT NULL,
  name TEXT,
  sector TEXT,
  industry TEXT,
  change_1d REAL,
  market_cap REAL,
  relative_volume REAL,
  price REAL,
  avg_volume REAL,
  price_avg_volume REAL,
  rs_close REAL,
  rs_ma REAL,
  rs_above_ma INTEGER NOT NULL DEFAULT 0,
  rs_new_high INTEGER NOT NULL DEFAULT 0,
  rs_new_high_before_price INTEGER NOT NULL DEFAULT 0,
  bull_cross INTEGER NOT NULL DEFAULT 0,
  approx_rs_rating INTEGER,
  raw_json TEXT,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (preset_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_rs_scan_rows_latest_rank
  ON rs_scan_rows_latest(preset_id, rank ASC);

CREATE INDEX IF NOT EXISTS idx_rs_scan_rows_latest_config
  ON rs_scan_rows_latest(config_key, rank ASC);
