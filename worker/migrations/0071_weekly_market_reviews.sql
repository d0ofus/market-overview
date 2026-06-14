CREATE TABLE IF NOT EXISTS weekly_market_reviews (
  id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  as_of TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  generation_provider TEXT NOT NULL CHECK (generation_provider IN ('hermes_gpt', 'gemini_fallback')),
  generation_mode TEXT NOT NULL CHECK (generation_mode IN ('external_publish', 'scheduled_fallback', 'manual_retry')),
  status TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
  title TEXT NOT NULL,
  market_tone TEXT,
  review_markdown TEXT NOT NULL,
  sections_json TEXT NOT NULL DEFAULT '{}',
  key_tickers_json TEXT NOT NULL DEFAULT '[]',
  source_audit_json TEXT NOT NULL DEFAULT '[]',
  data_quality_json TEXT NOT NULL DEFAULT '[]',
  source_snapshot_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_weekly_market_reviews_week
  ON weekly_market_reviews (week_end DESC, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_weekly_market_reviews_created
  ON weekly_market_reviews (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_weekly_market_reviews_provider_week
  ON weekly_market_reviews (generation_provider, week_end DESC);
