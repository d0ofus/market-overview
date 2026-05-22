ALTER TABLE social_alert_settings ADD COLUMN scrape_interval_hours INTEGER NOT NULL DEFAULT 6;

ALTER TABLE social_alert_runs ADD COLUMN scheduled_local_slot TEXT;

UPDATE social_alert_runs
SET scheduled_local_slot = scheduled_local_date || 'T10:00'
WHERE "trigger" = 'scheduled'
  AND scheduled_local_date IS NOT NULL
  AND scheduled_local_slot IS NULL;

CREATE INDEX IF NOT EXISTS idx_social_alert_runs_schedule_slot
  ON social_alert_runs("trigger", scheduled_local_slot);
