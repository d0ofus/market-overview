CREATE TABLE IF NOT EXISTS scan_refresh_jobs (
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  error TEXT,
  total_candidates INTEGER NOT NULL DEFAULT 0,
  processed_candidates INTEGER NOT NULL DEFAULT 0,
  matched_candidates INTEGER NOT NULL DEFAULT 0,
  cursor_offset INTEGER NOT NULL DEFAULT 0,
  latest_snapshot_id TEXT,
  requested_by TEXT,
  benchmark_bars_json TEXT,
  required_bar_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (preset_id) REFERENCES scan_presets(id),
  FOREIGN KEY (latest_snapshot_id) REFERENCES scan_snapshots(id)
);

CREATE INDEX IF NOT EXISTS idx_scan_refresh_jobs_preset_started_desc
  ON scan_refresh_jobs(preset_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_scan_refresh_jobs_status_updated_desc
  ON scan_refresh_jobs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS scan_refresh_job_candidates (
  job_id TEXT NOT NULL,
  cursor_offset INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  name TEXT,
  sector TEXT,
  industry TEXT,
  market_cap REAL,
  relative_volume REAL,
  avg_volume REAL,
  price_avg_volume REAL,
  PRIMARY KEY (job_id, cursor_offset),
  FOREIGN KEY (job_id) REFERENCES scan_refresh_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scan_refresh_job_candidates_job_cursor
  ON scan_refresh_job_candidates(job_id, cursor_offset ASC);

CREATE TABLE IF NOT EXISTS scan_refresh_job_top_rows (
  job_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  name TEXT,
  sector TEXT,
  industry TEXT,
  change_1d REAL,
  market_cap REAL,
  price REAL,
  avg_volume REAL,
  price_avg_volume REAL,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job_id, ticker),
  FOREIGN KEY (job_id) REFERENCES scan_refresh_jobs(id) ON DELETE CASCADE
);
