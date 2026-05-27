ALTER TABLE market_commentary_reports
  ADD COLUMN generation_trigger TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE market_commentary_reports
  ADD COLUMN scheduled_local_date TEXT;

ALTER TABLE market_commentary_reports
  ADD COLUMN scheduled_timezone TEXT;

ALTER TABLE market_commentary_reports
  ADD COLUMN scheduled_local_time TEXT;

CREATE INDEX IF NOT EXISTS idx_market_commentary_scheduled_attempt
  ON market_commentary_reports (generation_trigger, scheduled_local_date, session_date, created_at DESC);
