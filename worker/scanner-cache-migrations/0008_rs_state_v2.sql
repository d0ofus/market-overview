CREATE TABLE IF NOT EXISTS rs_state_latest (
  config_key TEXT NOT NULL,
  ticker TEXT NOT NULL,
  benchmark_ticker TEXT NOT NULL,
  rs_ma_type TEXT NOT NULL,
  rs_ma_length INTEGER NOT NULL,
  new_high_lookback INTEGER NOT NULL,
  state_version INTEGER NOT NULL,
  latest_trading_date TEXT NOT NULL,
  price_close_history_json TEXT NOT NULL,
  benchmark_close_history_json TEXT NOT NULL,
  weighted_score_history_json TEXT NOT NULL,
  rs_new_high_window_json TEXT NOT NULL,
  price_new_high_window_json TEXT NOT NULL,
  sma_window_json TEXT NOT NULL,
  sma_sum REAL,
  ema_value REAL,
  last_rs_close REAL,
  last_rs_ma REAL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (config_key, ticker)
);

CREATE TABLE IF NOT EXISTS rs_state_v2_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_parity_at TEXT,
  checked_count INTEGER NOT NULL DEFAULT 0,
  mismatch_count INTEGER NOT NULL DEFAULT 0,
  last_details_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO rs_state_v2_status (id) VALUES (1);
