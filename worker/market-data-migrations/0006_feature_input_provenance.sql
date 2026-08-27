ALTER TABLE daily_market_features ADD COLUMN input_start_date TEXT;
ALTER TABLE daily_market_features ADD COLUMN alpaca_bar_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_market_features ADD COLUMN repair_bar_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_market_features ADD COLUMN input_last_observed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_daily_market_features_recompute
  ON daily_market_features (feed, session_date, computed_at);
