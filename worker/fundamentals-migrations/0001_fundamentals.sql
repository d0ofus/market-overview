CREATE TABLE IF NOT EXISTS fundamental_issuers (
  ticker TEXT PRIMARY KEY,
  cik TEXT NOT NULL,
  company_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  last_refreshed_at TEXT,
  next_refresh_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fundamental_quarters (
  ticker TEXT NOT NULL,
  cik TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  fiscal_quarter INTEGER NOT NULL,
  period_end TEXT NOT NULL,
  filed_at TEXT,
  form TEXT,
  accession TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  revenue REAL,
  net_income REAL,
  revenue_yoy REAL,
  revenue_qoq REAL,
  net_income_yoy REAL,
  net_income_qoq REAL,
  revenue_source_tag TEXT,
  net_income_source_tag TEXT,
  derivation TEXT,
  warnings_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticker, fiscal_year, fiscal_quarter, period_end)
);

CREATE INDEX IF NOT EXISTS idx_fundamental_quarters_ticker_period
  ON fundamental_quarters(ticker, period_end DESC);

CREATE INDEX IF NOT EXISTS idx_fundamental_issuers_next_refresh
  ON fundamental_issuers(next_refresh_at, ticker);
