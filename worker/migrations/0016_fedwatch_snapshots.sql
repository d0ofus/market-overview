CREATE TABLE IF NOT EXISTS fedwatch_snapshots (
  id TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  current_target_range TEXT,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fedwatch_snapshots_generated_desc
  ON fedwatch_snapshots(generated_at DESC);
