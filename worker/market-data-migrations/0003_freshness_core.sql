ALTER TABLE alpaca_daily_bars ADD COLUMN source_provider TEXT NOT NULL DEFAULT 'alpaca';
ALTER TABLE alpaca_daily_bars ADD COLUMN adjustment TEXT NOT NULL DEFAULT 'split';
ALTER TABLE alpaca_daily_bars ADD COLUMN observed_at TEXT;

ALTER TABLE market_data_daily_usage ADD COLUMN rows_read INTEGER NOT NULL DEFAULT 0;
ALTER TABLE market_data_daily_usage ADD COLUMN rows_written INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS bar_coverage (
  feed TEXT NOT NULL,
  ticker TEXT NOT NULL,
  requested_start TEXT NOT NULL,
  observed_start TEXT,
  observed_end TEXT,
  observed_sessions INTEGER NOT NULL DEFAULT 0,
  expected_sessions INTEGER NOT NULL DEFAULT 0,
  missing_sessions INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (feed, ticker)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_bar_coverage_status_end
  ON bar_coverage (status, observed_end);

CREATE TABLE IF NOT EXISTS daily_market_features (
  feed TEXT NOT NULL,
  ticker TEXT NOT NULL,
  session_date TEXT NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL DEFAULT 0,
  previous_close REAL,
  return_1d REAL,
  return_5d REAL,
  return_63d REAL,
  sma_5 REAL,
  sma_20 REAL,
  sma_50 REAL,
  sma_100 REAL,
  sma_200 REAL,
  high_5 REAL,
  high_20 REAL,
  high_21 REAL,
  high_63 REAL,
  high_126 REAL,
  high_252 REAL,
  low_20 REAL,
  source_sessions INTEGER NOT NULL DEFAULT 0,
  source_provider TEXT NOT NULL DEFAULT 'alpaca',
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (feed, ticker, session_date)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_daily_market_features_session
  ON daily_market_features (feed, session_date, ticker);

CREATE TABLE IF NOT EXISTS market_calendar_sessions (
  session_date TEXT PRIMARY KEY,
  open_at TEXT NOT NULL,
  close_at TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT, WITHOUT ROWID;
