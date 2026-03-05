ALTER TABLE dashboard_configs
ADD COLUMN IF NOT EXISTS eod_run_local_time TEXT NOT NULL DEFAULT '08:15';

UPDATE dashboard_configs
SET eod_run_local_time = CASE
  WHEN eod_run_local_time IS NULL OR TRIM(eod_run_local_time) = '' THEN '08:15'
  ELSE eod_run_local_time
END,
updated_at = CURRENT_TIMESTAMP;
