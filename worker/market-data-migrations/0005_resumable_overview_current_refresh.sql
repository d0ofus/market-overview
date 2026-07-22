ALTER TABLE overview_current_refresh_jobs ADD COLUMN cycle_id TEXT;
ALTER TABLE overview_current_refresh_jobs ADD COLUMN cycle_started_at TEXT;
ALTER TABLE overview_current_refresh_jobs ADD COLUMN cursor_offset INTEGER NOT NULL DEFAULT 0;
ALTER TABLE overview_current_refresh_jobs ADD COLUMN processed_tickers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE overview_current_refresh_jobs ADD COLUMN lease_token TEXT;
ALTER TABLE overview_current_refresh_jobs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE overview_current_refresh_jobs ADD COLUMN last_error_code TEXT;
ALTER TABLE post_close_daily_bar_refresh_jobs ADD COLUMN request_end TEXT;

CREATE INDEX IF NOT EXISTS idx_overview_current_refresh_jobs_due
  ON overview_current_refresh_jobs (status, next_attempt_at, lease_expires_at, updated_at);

CREATE TABLE IF NOT EXISTS overview_provider_catalog_cache (
  provider_key TEXT NOT NULL,
  catalog_date TEXT NOT NULL,
  symbols_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider_key, catalog_date)
) STRICT, WITHOUT ROWID;
