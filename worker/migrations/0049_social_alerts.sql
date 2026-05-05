CREATE TABLE IF NOT EXISTS social_alert_sources (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  display_name TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_scraped_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(handle COLLATE NOCASE)
);

CREATE INDEX IF NOT EXISTS idx_social_alert_sources_active
  ON social_alert_sources(is_active, handle COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS social_alert_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  start_date TEXT NOT NULL,
  limit_per_handle INTEGER NOT NULL,
  selected_handles_json TEXT NOT NULL,
  auth_status TEXT,
  error TEXT,
  tweets INTEGER NOT NULL DEFAULT 0,
  cashtag_hits INTEGER NOT NULL DEFAULT 0,
  unique_tickers INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  runtime_ms INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_social_alert_runs_created_at
  ON social_alert_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS social_alert_posts (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL,
  tweet_id TEXT,
  tweet_url TEXT NOT NULL,
  handle TEXT NOT NULL,
  tweet_created_at TEXT,
  text TEXT NOT NULL,
  cashtags_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  raw_json TEXT,
  UNIQUE(canonical_key)
);

CREATE INDEX IF NOT EXISTS idx_social_alert_posts_handle
  ON social_alert_posts(handle COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_social_alert_posts_seen_at
  ON social_alert_posts(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS social_alert_run_posts (
  run_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, post_id),
  FOREIGN KEY (run_id) REFERENCES social_alert_runs(id),
  FOREIGN KEY (post_id) REFERENCES social_alert_posts(id)
);

CREATE INDEX IF NOT EXISTS idx_social_alert_run_posts_post
  ON social_alert_run_posts(post_id);

CREATE TABLE IF NOT EXISTS social_alert_credentials (
  credential_key TEXT PRIMARY KEY,
  ciphertext_base64 TEXT NOT NULL,
  iv_base64 TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  token_last4 TEXT,
  status TEXT NOT NULL DEFAULT 'configured',
  last_validated_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
