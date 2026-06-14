ALTER TABLE rs_scan_runs ADD COLUMN last_progress_at TEXT;
ALTER TABLE rs_scan_runs ADD COLUMN last_attempt_cursor_offset INTEGER;
ALTER TABLE rs_scan_runs ADD COLUMN last_attempt_ticker TEXT;
ALTER TABLE rs_scan_runs ADD COLUMN last_attempt_stage TEXT;
ALTER TABLE rs_scan_runs ADD COLUMN last_attempt_elapsed_ms INTEGER;
