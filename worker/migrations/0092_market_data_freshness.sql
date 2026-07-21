CREATE TABLE IF NOT EXISTS universe_versions (
  id TEXT PRIMARY KEY,
  universe_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_as_of_date TEXT,
  status TEXT NOT NULL,
  member_count INTEGER NOT NULL DEFAULT 0,
  previous_member_count INTEGER,
  change_pct REAL,
  validation_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  promoted_at TEXT,
  FOREIGN KEY (universe_id) REFERENCES universes(id)
);

CREATE INDEX IF NOT EXISTS idx_universe_versions_universe_status
  ON universe_versions (universe_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS universe_version_members (
  version_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  PRIMARY KEY (version_id, ticker),
  FOREIGN KEY (version_id) REFERENCES universe_versions(id)
);

ALTER TABLE universes ADD COLUMN active_version_id TEXT;

CREATE TABLE IF NOT EXISTS overview_generations (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  provider_label TEXT NOT NULL,
  expected_as_of_date TEXT,
  status TEXT NOT NULL,
  freshness_status TEXT NOT NULL,
  current_count INTEGER NOT NULL DEFAULT 0,
  eligible_count INTEGER NOT NULL DEFAULT 0,
  coverage_pct REAL NOT NULL DEFAULT 0,
  critical_missing_json TEXT NOT NULL DEFAULT '[]',
  min_bar_date TEXT,
  max_bar_date TEXT,
  warning TEXT,
  quote_requested_count INTEGER,
  quote_returned_count INTEGER,
  quote_error TEXT,
  quote_missing_sample_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_overview_generations_config_status
  ON overview_generations (config_id, status, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_overview_generations_retention
  ON overview_generations (as_of_date, generated_at);

CREATE TABLE IF NOT EXISTS overview_snapshot_pointer (
  config_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (generation_id) REFERENCES overview_generations(id)
);

CREATE TABLE IF NOT EXISTS data_readiness (
  domain TEXT NOT NULL,
  scope TEXT NOT NULL,
  expected_as_of_date TEXT,
  source_as_of_date TEXT,
  generation_id TEXT,
  status TEXT NOT NULL,
  coverage_pct REAL,
  warning TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (domain, scope)
);

CREATE INDEX IF NOT EXISTS idx_data_readiness_status
  ON data_readiness (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS refresh_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  page TEXT NOT NULL,
  ticker TEXT,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at TEXT,
  next_attempt_at TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_jobs_due
  ON refresh_jobs (status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS provider_usage_minute (
  minute_bucket TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (minute_bucket, provider_key)
);

CREATE INDEX IF NOT EXISTS idx_provider_usage_minute_updated
  ON provider_usage_minute (updated_at);

CREATE TABLE IF NOT EXISTS peer_metric_cache (
  ticker TEXT PRIMARY KEY,
  price REAL,
  change_1d REAL,
  change_1w REAL,
  market_cap REAL,
  avg_volume REAL,
  as_of TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_peer_metric_cache_as_of
  ON peer_metric_cache (as_of DESC);

UPDATE worker_schedule_settings
SET post_close_bars_offset_minutes = 20,
    updated_at = CURRENT_TIMESTAMP
WHERE post_close_bars_offset_minutes = 60;
