ALTER TABLE eod_runs ADD COLUMN deadline_checked_at TEXT;
ALTER TABLE eod_runs ADD COLUMN deadline_missing_scopes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE eod_runs ADD COLUMN dispatch_token TEXT;
ALTER TABLE eod_runs ADD COLUMN dispatch_requested_at TEXT;
ALTER TABLE eod_runs ADD COLUMN dispatch_checked_at TEXT;
CREATE INDEX IF NOT EXISTS idx_eod_runs_unchecked_deadlines
  ON eod_runs(deadline_checked_at, deadline_at);
