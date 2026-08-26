ALTER TABLE rs_scan_runs ADD COLUMN source_post_close_job_id TEXT;
ALTER TABLE rs_scan_runs ADD COLUMN universe_fingerprint TEXT;
ALTER TABLE rs_scan_runs ADD COLUMN provider_fetch_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rs_scan_runs ADD COLUMN storage_read_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rs_scan_runs ADD COLUMN math_compute_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rs_scan_runs ADD COLUMN storage_write_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rs_scan_runs ADD COLUMN continuation_wait_ms INTEGER NOT NULL DEFAULT 0;

ALTER TABLE rs_scan_run_tickers ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rs_scan_run_tickers ADD COLUMN last_error TEXT;
ALTER TABLE rs_scan_run_tickers ADD COLUMN rs_ratio_close REAL;
ALTER TABLE rs_scan_run_tickers ADD COLUMN rs_ratio_ma REAL;
ALTER TABLE rs_scan_run_tickers ADD COLUMN rs_above_ma INTEGER;
ALTER TABLE rs_scan_run_tickers ADD COLUMN rs_new_high INTEGER;
ALTER TABLE rs_scan_run_tickers ADD COLUMN rs_new_high_before_price INTEGER;
ALTER TABLE rs_scan_run_tickers ADD COLUMN bull_cross INTEGER;
ALTER TABLE rs_scan_run_tickers ADD COLUMN approx_rs_rating INTEGER;

CREATE INDEX IF NOT EXISTS idx_rs_scan_runs_config_date_completed
  ON rs_scan_runs(config_key, expected_trading_date, status, completed_at DESC);

CREATE TABLE IF NOT EXISTS rs_publications (
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL,
  config_key TEXT NOT NULL,
  expected_trading_date TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  matched_row_count INTEGER NOT NULL DEFAULT 0,
  warning TEXT,
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES rs_scan_runs(id)
) STRICT;

CREATE TABLE IF NOT EXISTS rs_publication_tickers (
  publication_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  rank INTEGER NOT NULL,
  PRIMARY KEY (publication_id, ticker),
  UNIQUE (publication_id, rank),
  FOREIGN KEY (publication_id) REFERENCES rs_publications(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS rs_preset_publications (
  preset_id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (publication_id) REFERENCES rs_publications(id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_rs_publications_run ON rs_publications(run_id);
CREATE INDEX IF NOT EXISTS idx_rs_publications_preset_published ON rs_publications(preset_id, published_at DESC);
