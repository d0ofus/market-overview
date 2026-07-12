CREATE TABLE IF NOT EXISTS market_data_maintenance_state (
  id TEXT PRIMARY KEY,
  last_run_date TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT, WITHOUT ROWID;

INSERT OR IGNORE INTO market_data_maintenance_state (id, last_run_date)
VALUES ('default', NULL);
