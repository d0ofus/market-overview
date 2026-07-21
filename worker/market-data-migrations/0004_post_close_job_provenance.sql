ALTER TABLE post_close_daily_bar_refresh_jobs ADD COLUMN source_provider TEXT NOT NULL DEFAULT 'alpaca';
ALTER TABLE post_close_daily_bar_refresh_jobs ADD COLUMN source_feed TEXT NOT NULL DEFAULT 'iex';
ALTER TABLE post_close_daily_bar_refresh_jobs ADD COLUMN adjustment TEXT NOT NULL DEFAULT 'split';

CREATE INDEX IF NOT EXISTS idx_post_close_daily_bar_refresh_jobs_date_source
  ON post_close_daily_bar_refresh_jobs (trading_date, source_provider, source_feed, adjustment, updated_at DESC);
