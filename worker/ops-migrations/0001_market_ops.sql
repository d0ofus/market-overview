CREATE TABLE IF NOT EXISTS provider_budget_counters (
  provider_key TEXT NOT NULL,
  window_kind TEXT NOT NULL CHECK (window_kind IN ('minute', 'day')),
  window_bucket TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider_key, window_kind, window_bucket)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_provider_budget_counters_window
  ON provider_budget_counters (window_kind, window_bucket);

CREATE TABLE IF NOT EXISTS provider_usage_daily (
  usage_day TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  endpoint_key TEXT NOT NULL,
  caller TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  rate_limited_count INTEGER NOT NULL DEFAULT 0,
  timeout_count INTEGER NOT NULL DEFAULT 0,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  cache_hit_count INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_error TEXT,
  last_called_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (usage_day, provider_key, endpoint_key, caller)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_provider_usage_daily_provider_day
  ON provider_usage_daily (provider_key, usage_day DESC);

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
) STRICT;

CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_job_started
  ON scheduled_job_runs (job_key, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_lane_started
  ON scheduled_job_runs (lane, started_at DESC);

CREATE TABLE IF NOT EXISTS market_pipeline_runs (
  id TEXT PRIMARY KEY,
  pipeline TEXT NOT NULL,
  session_date TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('paused', 'canary', 'active')),
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  expected_count INTEGER,
  completed_count INTEGER,
  unsupported_count INTEGER,
  error_count INTEGER,
  error_code TEXT,
  error_message TEXT,
  checkpoint_json TEXT,
  next_attempt_at TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS idx_market_pipeline_runs_due
  ON market_pipeline_runs (pipeline, status, next_attempt_at, started_at DESC);

CREATE TABLE IF NOT EXISTS universe_source_sync_state (
  source_key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  source_label TEXT NOT NULL,
  source_type TEXT,
  source_url TEXT,
  source_as_of_date TEXT,
  content_hash TEXT,
  etag TEXT,
  last_modified TEXT,
  last_verified_source_date TEXT,
  last_verified_at TEXT,
  records_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_success_at TEXT,
  next_attempt_at TEXT,
  error_code TEXT,
  error_message TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_universe_source_sync_due
  ON universe_source_sync_state (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS capacity_health_samples (
  id TEXT PRIMARY KEY,
  database_key TEXT NOT NULL,
  observed_bytes INTEGER,
  level TEXT NOT NULL,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS idx_capacity_health_database_observed
  ON capacity_health_samples (database_key, observed_at DESC);
