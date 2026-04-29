CREATE TABLE IF NOT EXISTS earnings_calendar_syncs (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  horizon TEXT,
  last_started_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  rows_seen INTEGER NOT NULL DEFAULT 0,
  rows_upserted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS earnings_events (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  cik TEXT NOT NULL,
  company_name TEXT NOT NULL,
  scheduled_date TEXT NOT NULL,
  time_hint TEXT,
  fiscal_period TEXT NOT NULL DEFAULT '',
  eps_estimate REAL,
  revenue_estimate REAL,
  eps_actual REAL,
  revenue_actual REAL,
  provider TEXT NOT NULL,
  provider_confidence REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled',
  last_provider_seen_at TEXT,
  last_sec_checked_at TEXT,
  sec_form TEXT,
  sec_accession TEXT,
  release_confirmed_at TEXT,
  fundamentals_refreshed_at TEXT,
  next_check_at TEXT,
  last_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(ticker, scheduled_date, fiscal_period)
);

CREATE INDEX IF NOT EXISTS idx_earnings_events_status_next_check
  ON earnings_events(status, next_check_at, scheduled_date);

CREATE INDEX IF NOT EXISTS idx_earnings_events_scheduled_date
  ON earnings_events(scheduled_date, ticker);

CREATE INDEX IF NOT EXISTS idx_earnings_events_ticker_date
  ON earnings_events(ticker, scheduled_date DESC);
