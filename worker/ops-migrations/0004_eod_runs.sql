CREATE TABLE IF NOT EXISTS eod_runs (
  id TEXT PRIMARY KEY,
  session_date TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('daily','reconcile','backfill','maintenance')),
  mode TEXT NOT NULL CHECK(mode IN ('shadow','active')),
  status TEXT NOT NULL DEFAULT 'queued',
  stage TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until TEXT,
  next_attempt_at TEXT,
  deadline_at TEXT,
  deadline_missed INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL DEFAULT '{}',
  progress_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  github_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(session_date,purpose,mode)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_eod_runs_due ON eod_runs(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS eod_checkpoints (
  run_id TEXT NOT NULL,
  chunk_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id,chunk_key)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS eod_usage (
  usage_date TEXT PRIMARY KEY,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  reserved_reads INTEGER NOT NULL DEFAULT 0,
  reserved_writes INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS eod_budget_reservations (
  id TEXT PRIMARY KEY,
  usage_date TEXT NOT NULL,
  run_id TEXT NOT NULL,
  reads INTEGER NOT NULL,
  writes INTEGER NOT NULL,
  settled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;
