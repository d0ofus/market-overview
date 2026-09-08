-- Public status polls read the latest completed delivery from the compact run
-- ledger instead of scanning and grouping immutable publication history.
CREATE INDEX IF NOT EXISTS eod_runs_completed_delivery
  ON eod_runs(mode,status,session_date DESC)
  WHERE mode='active' AND status='completed' AND purpose IN ('daily','reconcile');
