ALTER TABLE scan_presets ADD COLUMN scan_type TEXT NOT NULL DEFAULT 'tradingview';

ALTER TABLE scan_presets ADD COLUMN prefilter_rules_json TEXT;

ALTER TABLE scan_presets ADD COLUMN benchmark_ticker TEXT;

ALTER TABLE scan_presets ADD COLUMN vertical_offset REAL NOT NULL DEFAULT 30.0;

ALTER TABLE scan_presets ADD COLUMN rs_ma_length INTEGER NOT NULL DEFAULT 21;

ALTER TABLE scan_presets ADD COLUMN rs_ma_type TEXT NOT NULL DEFAULT 'EMA';

ALTER TABLE scan_presets ADD COLUMN new_high_lookback INTEGER NOT NULL DEFAULT 252;

ALTER TABLE scan_presets ADD COLUMN output_mode TEXT NOT NULL DEFAULT 'all';

CREATE TABLE IF NOT EXISTS relative_strength_cache (
  ticker TEXT NOT NULL,
  benchmark_ticker TEXT NOT NULL,
  trading_date TEXT NOT NULL,
  price_close REAL,
  change_1d REAL,
  rs_open REAL,
  rs_high REAL,
  rs_low REAL,
  rs_close REAL,
  rs_ma REAL,
  rs_above_ma INTEGER NOT NULL DEFAULT 0,
  rs_new_high INTEGER NOT NULL DEFAULT 0,
  rs_new_high_before_price INTEGER NOT NULL DEFAULT 0,
  bull_cross INTEGER NOT NULL DEFAULT 0,
  approx_rs_rating INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticker, benchmark_ticker, trading_date)
);

CREATE INDEX IF NOT EXISTS idx_relative_strength_cache_lookup
  ON relative_strength_cache(benchmark_ticker, trading_date DESC, ticker ASC);

CREATE INDEX IF NOT EXISTS idx_relative_strength_cache_ticker
  ON relative_strength_cache(ticker, benchmark_ticker, trading_date DESC);
