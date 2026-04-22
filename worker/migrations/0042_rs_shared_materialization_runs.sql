ALTER TABLE scan_refresh_jobs ADD COLUMN shared_run_id TEXT;

CREATE INDEX IF NOT EXISTS idx_scan_refresh_jobs_shared_run_id
  ON scan_refresh_jobs(shared_run_id);

CREATE TABLE IF NOT EXISTS relative_strength_materialization_runs (
  id TEXT PRIMARY KEY,
  config_key TEXT NOT NULL,
  expected_trading_date TEXT NOT NULL,
  benchmark_ticker TEXT NOT NULL,
  rs_ma_type TEXT NOT NULL,
  rs_ma_length INTEGER NOT NULL,
  new_high_lookback INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  error TEXT,
  benchmark_bars_json TEXT,
  required_bar_count INTEGER NOT NULL DEFAULT 0,
  full_candidate_count INTEGER NOT NULL DEFAULT 0,
  materialization_candidate_count INTEGER NOT NULL DEFAULT 0,
  already_current_candidate_count INTEGER NOT NULL DEFAULT 0,
  processed_candidates INTEGER NOT NULL DEFAULT 0,
  matched_candidates INTEGER NOT NULL DEFAULT 0,
  cursor_offset INTEGER NOT NULL DEFAULT 0,
  last_advanced_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rs_materialization_runs_config_date
  ON relative_strength_materialization_runs(config_key, expected_trading_date);

CREATE INDEX IF NOT EXISTS idx_rs_materialization_runs_status_updated
  ON relative_strength_materialization_runs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS relative_strength_materialization_run_candidates (
  run_id TEXT NOT NULL,
  cursor_offset INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  PRIMARY KEY (run_id, ticker),
  FOREIGN KEY (run_id) REFERENCES relative_strength_materialization_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rs_materialization_run_candidates_run_cursor
  ON relative_strength_materialization_run_candidates(run_id, cursor_offset ASC);

CREATE TABLE IF NOT EXISTS relative_strength_materialization_queue (
  run_id TEXT NOT NULL PRIMARY KEY,
  priority INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_attempted_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (run_id) REFERENCES relative_strength_materialization_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rs_materialization_queue_priority_enqueued
  ON relative_strength_materialization_queue(priority DESC, enqueued_at ASC);
