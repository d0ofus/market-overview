CREATE INDEX IF NOT EXISTS idx_rs_scan_runs_retention
  ON rs_scan_runs(status, updated_at, preset_id);

CREATE INDEX IF NOT EXISTS idx_vcp_scan_runs_retention
  ON vcp_scan_runs(status, updated_at, preset_id);
