ALTER TABLE relative_strength_materialization_runs ADD COLUMN deferred_ticker_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE relative_strength_materialization_runs ADD COLUMN warning TEXT;
ALTER TABLE relative_strength_materialization_runs ADD COLUMN phase TEXT;
ALTER TABLE relative_strength_materialization_runs ADD COLUMN lease_owner TEXT;
ALTER TABLE relative_strength_materialization_runs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE relative_strength_materialization_runs ADD COLUMN heartbeat_at TEXT;

ALTER TABLE scan_refresh_jobs ADD COLUMN deferred_ticker_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_refresh_jobs ADD COLUMN warning TEXT;
ALTER TABLE scan_refresh_jobs ADD COLUMN phase TEXT;

CREATE TABLE IF NOT EXISTS relative_strength_materialization_run_deferred_tickers (
  run_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  deferred_at TEXT,
  PRIMARY KEY (run_id, ticker),
  FOREIGN KEY (run_id) REFERENCES relative_strength_materialization_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rs_materialization_run_deferred_tickers_run
  ON relative_strength_materialization_run_deferred_tickers(run_id, deferred_at);
