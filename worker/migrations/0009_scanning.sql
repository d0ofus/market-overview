CREATE TABLE IF NOT EXISTS scan_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_value TEXT NOT NULL,
  fallback_source_type TEXT,
  fallback_source_value TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider_key, source_value)
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  status TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_value TEXT NOT NULL,
  fallback_used INTEGER NOT NULL DEFAULT 0,
  raw_result_count INTEGER NOT NULL DEFAULT 0,
  compiled_row_count INTEGER NOT NULL DEFAULT 0,
  unique_ticker_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  provider_trace_json TEXT,
  ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scan_id) REFERENCES scan_definitions(id)
);

CREATE INDEX IF NOT EXISTS idx_scan_runs_scan_ingested_desc
  ON scan_runs(scan_id, ingested_at DESC);

CREATE INDEX IF NOT EXISTS idx_scan_runs_ingested_desc
  ON scan_runs(ingested_at DESC);

CREATE TABLE IF NOT EXISTS scan_run_rows (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  display_name TEXT,
  exchange TEXT,
  provider_row_key TEXT,
  rank_value REAL,
  rank_label TEXT,
  price REAL,
  change_1d REAL,
  volume REAL,
  market_cap REAL,
  raw_json TEXT,
  canonical_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, canonical_key),
  FOREIGN KEY (run_id) REFERENCES scan_runs(id),
  FOREIGN KEY (scan_id) REFERENCES scan_definitions(id)
);

CREATE INDEX IF NOT EXISTS idx_scan_run_rows_scan_ticker
  ON scan_run_rows(scan_id, ticker);

CREATE INDEX IF NOT EXISTS idx_scan_run_rows_run_ticker
  ON scan_run_rows(run_id, ticker);
