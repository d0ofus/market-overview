CREATE TABLE IF NOT EXISTS eod_account_usage (
  usage_date TEXT PRIMARY KEY,
  rows_read INTEGER NOT NULL,
  rows_written INTEGER NOT NULL,
  sampled_at TEXT NOT NULL,
  error TEXT
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS eod_rollout_evidence (
  id TEXT PRIMARY KEY,
  evidence_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
