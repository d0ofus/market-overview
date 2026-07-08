CREATE INDEX IF NOT EXISTS idx_breadth_snapshots_universe_latest
  ON breadth_snapshots(universe_id, as_of_date DESC, generated_at DESC);
