CREATE TABLE IF NOT EXISTS pattern_runs_next (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  trading_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'paused', 'cancelled', 'completed', 'failed')),
  phase TEXT NOT NULL DEFAULT 'queued',
  total_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  cursor_offset INTEGER NOT NULL DEFAULT 0,
  auto_continue INTEGER NOT NULL DEFAULT 0,
  last_advanced_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  error TEXT,
  warning TEXT
);

INSERT INTO pattern_runs_next (
  id,
  profile_id,
  trading_date,
  status,
  phase,
  total_count,
  processed_count,
  matched_count,
  cursor_offset,
  auto_continue,
  last_advanced_at,
  lease_owner,
  lease_expires_at,
  started_at,
  updated_at,
  completed_at,
  error,
  warning
)
SELECT
  id,
  profile_id,
  trading_date,
  CASE WHEN status IN ('queued', 'running', 'completed', 'failed') THEN status ELSE 'failed' END,
  phase,
  total_count,
  processed_count,
  matched_count,
  cursor_offset,
  CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END,
  CASE WHEN processed_count > 0 THEN updated_at ELSE NULL END,
  NULL,
  NULL,
  started_at,
  updated_at,
  completed_at,
  error,
  warning
FROM pattern_runs;

DROP TABLE pattern_runs;

ALTER TABLE pattern_runs_next RENAME TO pattern_runs;

CREATE INDEX IF NOT EXISTS idx_pattern_runs_profile_date
  ON pattern_runs(profile_id, trading_date DESC);

CREATE INDEX IF NOT EXISTS idx_pattern_runs_status_updated
  ON pattern_runs(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_pattern_runs_auto_continue
  ON pattern_runs(auto_continue, status, updated_at DESC);
