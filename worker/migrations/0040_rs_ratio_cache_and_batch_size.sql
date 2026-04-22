ALTER TABLE worker_schedule_settings
  ADD COLUMN rs_background_batch_size INTEGER NOT NULL DEFAULT 20;

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
