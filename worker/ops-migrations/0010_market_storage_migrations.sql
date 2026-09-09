CREATE TABLE IF NOT EXISTS market_storage_migrations (
  id TEXT PRIMARY KEY,
  source_database_id TEXT NOT NULL,
  target_database_id TEXT NOT NULL,
  history_database_id TEXT NOT NULL,
  session_date TEXT NOT NULL,
  code_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN
    ('queued','dispatching','dispatched','running','retrying','awaiting-evidence','awaiting-cutover','completed','aborting','aborted')),
  stage TEXT NOT NULL DEFAULT 'queued',
  source_schema_hash TEXT,
  source_revision INTEGER,
  freeze_authorized INTEGER NOT NULL DEFAULT 0 CHECK(freeze_authorized IN (0,1)),
  freeze_evidence_hash TEXT,
  lease_token TEXT,
  lease_until TEXT,
  next_attempt_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  dispatch_token TEXT,
  dispatch_requested_at TEXT,
  github_run_id TEXT,
  progress_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK(source_database_id<>target_database_id AND source_database_id<>history_database_id
    AND target_database_id<>history_database_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_market_storage_migrations_due
  ON market_storage_migrations(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS market_storage_checkpoints (
  migration_id TEXT NOT NULL REFERENCES market_storage_migrations(id),
  checkpoint_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(migration_id,checkpoint_key)
) STRICT, WITHOUT ROWID;
