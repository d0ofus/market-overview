CREATE TABLE IF NOT EXISTS scheduled_job_runs (
  id TEXT PRIMARY KEY,
  lane TEXT NOT NULL,
  cron TEXT,
  job_key TEXT NOT NULL,
  scheduled_time TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  metadata_json TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_job_started
  ON scheduled_job_runs (job_key, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_lane_started
  ON scheduled_job_runs (lane, started_at DESC);
