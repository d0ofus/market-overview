CREATE TABLE IF NOT EXISTS social_alert_blacklisted_cashtags (
  ticker TEXT PRIMARY KEY,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS social_alert_settings (
  id TEXT PRIMARY KEY,
  daily_scrape_enabled INTEGER NOT NULL DEFAULT 0,
  daily_scrape_time_local TEXT NOT NULL DEFAULT '10:00',
  daily_scrape_timezone TEXT NOT NULL DEFAULT 'Australia/Melbourne',
  daily_scrape_lookback_days INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO social_alert_settings (
  id,
  daily_scrape_enabled,
  daily_scrape_time_local,
  daily_scrape_timezone,
  daily_scrape_lookback_days,
  updated_at
) VALUES (
  'default',
  0,
  '10:00',
  'Australia/Melbourne',
  1,
  CURRENT_TIMESTAMP
);

ALTER TABLE social_alert_runs ADD COLUMN "trigger" TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE social_alert_runs ADD COLUMN scheduled_local_date TEXT;

CREATE INDEX IF NOT EXISTS idx_social_alert_runs_schedule
  ON social_alert_runs("trigger", scheduled_local_date);
