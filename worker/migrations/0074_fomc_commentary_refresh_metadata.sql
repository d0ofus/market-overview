ALTER TABLE fomc_commentary_items ADD COLUMN source_text_hash TEXT;
ALTER TABLE fomc_commentary_items ADD COLUMN last_checked_at TEXT;
ALTER TABLE fomc_commentary_items ADD COLUMN last_unchanged_at TEXT;
ALTER TABLE fomc_commentary_items ADD COLUMN last_refresh_attempt_at TEXT;
ALTER TABLE fomc_commentary_items ADD COLUMN refresh_attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_fomc_commentary_check_state
  ON fomc_commentary_items(event_type, meeting_date, source_text_hash, last_checked_at DESC);
