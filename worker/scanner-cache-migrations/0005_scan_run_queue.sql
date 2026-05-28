CREATE TABLE IF NOT EXISTS scanner_cache_scan_run_queue (
  run_id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL CHECK(run_type IN ('relative-strength', 'vcp')),
  source TEXT,
  priority INTEGER NOT NULL DEFAULT 50,
  enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_attempted_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_scanner_cache_scan_run_queue_due
  ON scanner_cache_scan_run_queue(next_attempt_at, priority DESC, enqueued_at ASC);
