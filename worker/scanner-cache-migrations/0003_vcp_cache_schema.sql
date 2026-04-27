CREATE TABLE IF NOT EXISTS vcp_scan_runs (
  id TEXT PRIMARY KEY,
  active_slot TEXT NOT NULL DEFAULT 'vcp',
  preset_id TEXT NOT NULL,
  preset_name TEXT NOT NULL,
  config_key TEXT NOT NULL,
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
  lease_expires_at TEXT,
  cache_hit_tickers INTEGER NOT NULL DEFAULT 0,
  computed_tickers INTEGER NOT NULL DEFAULT 0,
  missing_bars_tickers INTEGER NOT NULL DEFAULT 0,
  insufficient_history_tickers INTEGER NOT NULL DEFAULT 0,
  error_tickers INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vcp_scan_runs_single_active
  ON vcp_scan_runs(active_slot)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_vcp_scan_runs_preset_created
  ON vcp_scan_runs(preset_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vcp_scan_runs_status_updated
  ON vcp_scan_runs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS vcp_scan_run_tickers (
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
  source TEXT NOT NULL DEFAULT 'computed',
  PRIMARY KEY (run_id, ticker),
  FOREIGN KEY (run_id) REFERENCES vcp_scan_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vcp_scan_run_tickers_cursor
  ON vcp_scan_run_tickers(run_id, cursor_offset ASC);

CREATE INDEX IF NOT EXISTS idx_vcp_scan_run_tickers_status
  ON vcp_scan_run_tickers(run_id, status);

CREATE TABLE IF NOT EXISTS vcp_features_latest (
  config_key TEXT NOT NULL,
  ticker TEXT NOT NULL,
  expected_trading_date TEXT,
  trading_date TEXT,
  price_close REAL,
  change_1d REAL,
  sma50 REAL,
  sma150 REAL,
  sma200 REAL,
  daily_pivot REAL,
  daily_pivot_gap_pct REAL,
  weekly_high REAL,
  weekly_high_gap_pct REAL,
  vol_sma20 REAL,
  trend_score INTEGER NOT NULL DEFAULT 0,
  trend_template INTEGER NOT NULL DEFAULT 0,
  pivot_stable INTEGER NOT NULL DEFAULT 0,
  daily_near INTEGER NOT NULL DEFAULT 0,
  weekly_near INTEGER NOT NULL DEFAULT 0,
  higher_lows INTEGER NOT NULL DEFAULT 0,
  volume_contracting INTEGER NOT NULL DEFAULT 0,
  vcp_signal INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  reason TEXT,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (config_key, ticker)
);

CREATE INDEX IF NOT EXISTS idx_vcp_features_latest_config_expected_ticker
  ON vcp_features_latest(config_key, expected_trading_date, ticker);

CREATE INDEX IF NOT EXISTS idx_vcp_features_latest_signal
  ON vcp_features_latest(config_key, expected_trading_date, vcp_signal, ticker);
