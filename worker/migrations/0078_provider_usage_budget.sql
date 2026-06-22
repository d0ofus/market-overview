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
);

CREATE INDEX IF NOT EXISTS idx_provider_usage_daily_provider_day
  ON provider_usage_daily(provider_key, usage_day DESC);

CREATE TABLE IF NOT EXISTS provider_symbol_backoff (
  provider_key TEXT NOT NULL,
  ticker TEXT NOT NULL,
  reason TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  no_data_until TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT,
  PRIMARY KEY (provider_key, ticker)
);

CREATE INDEX IF NOT EXISTS idx_provider_symbol_backoff_until
  ON provider_symbol_backoff(provider_key, no_data_until);
