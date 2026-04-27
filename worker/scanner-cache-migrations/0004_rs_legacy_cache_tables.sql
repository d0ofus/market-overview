CREATE TABLE IF NOT EXISTS rs_ratio_cache (
  benchmark_ticker TEXT NOT NULL,
  ticker TEXT NOT NULL,
  trading_date TEXT NOT NULL,
  price_close REAL,
  benchmark_close REAL,
  rs_ratio_close REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (benchmark_ticker, ticker, trading_date)
);

CREATE INDEX IF NOT EXISTS idx_rs_ratio_cache_benchmark_date_ticker
  ON rs_ratio_cache(benchmark_ticker, trading_date DESC, ticker);

CREATE INDEX IF NOT EXISTS idx_rs_ratio_cache_ticker_benchmark_date
  ON rs_ratio_cache(ticker, benchmark_ticker, trading_date DESC);

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

CREATE TABLE IF NOT EXISTS relative_strength_config_state (
  config_key TEXT NOT NULL,
  ticker TEXT NOT NULL,
  benchmark_ticker TEXT NOT NULL,
  rs_ma_type TEXT NOT NULL,
  rs_ma_length INTEGER NOT NULL,
  new_high_lookback INTEGER NOT NULL,
  state_version INTEGER NOT NULL,
  latest_trading_date TEXT NOT NULL,
  updated_at TEXT,
  price_close REAL,
  change_1d REAL,
  rs_ratio_close REAL,
  rs_ratio_ma REAL,
  rs_above_ma INTEGER NOT NULL DEFAULT 0,
  rs_new_high INTEGER NOT NULL DEFAULT 0,
  rs_new_high_before_price INTEGER NOT NULL DEFAULT 0,
  bull_cross INTEGER NOT NULL DEFAULT 0,
  approx_rs_rating REAL,
  price_close_history_json TEXT,
  benchmark_close_history_json TEXT,
  weighted_score_history_json TEXT,
  rs_new_high_window_json TEXT,
  price_new_high_window_json TEXT,
  sma_window_json TEXT,
  sma_sum REAL,
  ema_value REAL,
  previous_rs_close REAL,
  previous_rs_ma REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (config_key, ticker)
);

CREATE INDEX IF NOT EXISTS idx_relative_strength_config_state_config_date
  ON relative_strength_config_state(config_key, latest_trading_date DESC, ticker);
