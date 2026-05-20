CREATE TABLE IF NOT EXISTS earnings_surprise_syncs (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  mode TEXT,
  window_start TEXT,
  window_end TEXT,
  last_started_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  rows_seen INTEGER NOT NULL DEFAULT 0,
  rows_upserted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS earnings_surprise_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  source_symbol TEXT NOT NULL,
  ticker TEXT NOT NULL,
  exchange TEXT,
  company_name TEXT,
  sector TEXT,
  industry TEXT,
  market_cap REAL,
  report_date TEXT NOT NULL,
  report_timestamp INTEGER,
  report_time TEXT,
  fiscal_period_end TEXT NOT NULL DEFAULT '',
  season TEXT NOT NULL,
  eps_actual REAL,
  eps_estimate REAL,
  eps_surprise REAL,
  eps_surprise_pct REAL,
  revenue_actual REAL,
  revenue_estimate REAL,
  revenue_surprise REAL,
  revenue_surprise_pct REAL,
  raw_json TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(ticker, report_date, fiscal_period_end)
);

CREATE INDEX IF NOT EXISTS idx_earnings_surprise_report_date
  ON earnings_surprise_events(report_date DESC, ticker);

CREATE INDEX IF NOT EXISTS idx_earnings_surprise_season
  ON earnings_surprise_events(season, eps_surprise_pct DESC);

CREATE INDEX IF NOT EXISTS idx_earnings_surprise_eps_pct
  ON earnings_surprise_events(eps_surprise_pct DESC);

CREATE INDEX IF NOT EXISTS idx_earnings_surprise_ticker_date
  ON earnings_surprise_events(ticker, report_date DESC);

CREATE INDEX IF NOT EXISTS idx_earnings_surprise_market_cap
  ON earnings_surprise_events(market_cap DESC);

CREATE INDEX IF NOT EXISTS idx_earnings_surprise_sector_industry
  ON earnings_surprise_events(sector, industry);

CREATE INDEX IF NOT EXISTS idx_earnings_surprise_exchange
  ON earnings_surprise_events(exchange, report_date DESC);
