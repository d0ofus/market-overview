CREATE INDEX IF NOT EXISTS idx_pattern_review_events_run_candidate
  ON pattern_review_events(run_id, candidate_id, event_type);
