CREATE TABLE IF NOT EXISTS brave_search_cache (
  cache_key TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  freshness TEXT NOT NULL,
  date_bucket TEXT NOT NULL,
  response_json TEXT NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_hit_at TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_brave_search_cache_expires_at
  ON brave_search_cache(expires_at);

CREATE TABLE IF NOT EXISTS brave_usage_daily (
  usage_day TEXT NOT NULL,
  caller TEXT NOT NULL CHECK (caller IN ('daily_commentary', 'weekly_review', 'fomc')),
  api_call_count INTEGER NOT NULL DEFAULT 0,
  api_error_count INTEGER NOT NULL DEFAULT 0,
  cache_hit_count INTEGER NOT NULL DEFAULT 0,
  last_called_at TEXT,
  last_error_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (usage_day, caller)
);
