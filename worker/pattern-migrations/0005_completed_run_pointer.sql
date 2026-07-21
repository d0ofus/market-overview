CREATE TABLE IF NOT EXISTS pattern_completed_run_pointer (
  profile_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO pattern_completed_run_pointer (profile_id, run_id, updated_at)
SELECT profile_id, id, COALESCE(completed_at, updated_at, CURRENT_TIMESTAMP)
FROM (
  SELECT
    id,
    profile_id,
    completed_at,
    updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY profile_id
      ORDER BY datetime(COALESCE(completed_at, updated_at)) DESC, id DESC
    ) AS row_number
  FROM pattern_runs
  WHERE status = 'completed'
)
WHERE row_number = 1
ON CONFLICT(profile_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_pattern_completed_run_pointer_run
  ON pattern_completed_run_pointer(run_id);
