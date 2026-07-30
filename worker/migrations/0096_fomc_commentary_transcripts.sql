ALTER TABLE fomc_commentary_items ADD COLUMN transcript_url TEXT;
ALTER TABLE fomc_commentary_items ADD COLUMN transcript_kind TEXT;

CREATE INDEX IF NOT EXISTS idx_fomc_commentary_meeting_date
  ON fomc_commentary_items(meeting_date DESC, event_type, updated_at DESC);
