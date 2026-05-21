CREATE TABLE IF NOT EXISTS earnings_gap_syncs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT,
  scheduled_local_date TEXT,
  window_start TEXT,
  window_end TEXT,
  last_started_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  rows_seen INTEGER NOT NULL DEFAULT 0,
  rows_upserted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_earnings_gap_syncs_updated_desc
  ON earnings_gap_syncs(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_earnings_gap_syncs_scheduled_date
  ON earnings_gap_syncs(scheduled_local_date, status);

CREATE TABLE IF NOT EXISTS earnings_gap_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  source_symbol TEXT NOT NULL,
  ticker TEXT NOT NULL,
  exchange TEXT,
  company_name TEXT,
  sector TEXT,
  industry TEXT,
  market_cap REAL,
  price REAL,
  avg_volume_30d REAL,
  avg_dollar_volume_30d REAL,
  report_date TEXT NOT NULL,
  report_timestamp INTEGER,
  report_time TEXT,
  reaction_date TEXT,
  previous_close REAL,
  reaction_open REAL,
  regular_open_gap_pct REAL,
  postmarket_price REAL,
  postmarket_gap_pct REAL,
  postmarket_volume REAL,
  qualifying_gap_pct REAL NOT NULL,
  gap_source TEXT NOT NULL,
  raw_json TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(ticker, report_date)
);

CREATE INDEX IF NOT EXISTS idx_earnings_gap_report_date
  ON earnings_gap_events(report_date DESC, ticker);

CREATE INDEX IF NOT EXISTS idx_earnings_gap_qualifying_gap
  ON earnings_gap_events(qualifying_gap_pct DESC);

CREATE INDEX IF NOT EXISTS idx_earnings_gap_avg_dollar_volume
  ON earnings_gap_events(avg_dollar_volume_30d DESC);

CREATE INDEX IF NOT EXISTS idx_earnings_gap_market_cap
  ON earnings_gap_events(market_cap DESC);

CREATE INDEX IF NOT EXISTS idx_earnings_gap_sector_industry
  ON earnings_gap_events(sector, industry);

CREATE INDEX IF NOT EXISTS idx_earnings_gap_exchange
  ON earnings_gap_events(exchange, report_date DESC);
