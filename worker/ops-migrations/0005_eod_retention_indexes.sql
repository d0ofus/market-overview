CREATE INDEX IF NOT EXISTS idx_eod_runs_status_session
  ON eod_runs (status, session_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_eod_reservations_retention
  ON eod_budget_reservations (settled, created_at, id);
