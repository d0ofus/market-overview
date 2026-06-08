ALTER TABLE post_close_daily_bar_refresh_jobs ADD COLUMN fetched_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE post_close_daily_bar_refresh_jobs ADD COLUMN written_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE post_close_daily_bar_refresh_jobs ADD COLUMN current_date_tickers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE post_close_daily_bar_refresh_jobs ADD COLUMN missing_current_date_tickers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE post_close_daily_bar_refresh_jobs ADD COLUMN current_date_coverage_pct REAL NOT NULL DEFAULT 0;
