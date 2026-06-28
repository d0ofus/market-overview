CREATE TABLE IF NOT EXISTS market_commentary_schedule_attempts (
  id TEXT PRIMARY KEY,
  scheduled_local_date TEXT NOT NULL,
  session_date TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  report_id TEXT,
  scheduled_timezone TEXT,
  scheduled_local_time TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_market_commentary_schedule_attempts_latest
  ON market_commentary_schedule_attempts (scheduled_local_date, session_date, updated_at DESC);
