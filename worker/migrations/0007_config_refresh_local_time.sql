PRAGMA foreign_keys = OFF;

CREATE TABLE dashboard_configs__new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL,
  eod_run_local_time TEXT NOT NULL DEFAULT '08:15',
  eod_run_time_label TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO dashboard_configs__new (
  id,
  name,
  is_default,
  timezone,
  eod_run_local_time,
  eod_run_time_label,
  created_at,
  updated_at
)
SELECT
  id,
  name,
  is_default,
  timezone,
  CASE
    WHEN timezone = 'America/New_York' AND eod_run_time_label = '22:15 ET' THEN '22:15'
    ELSE '08:15'
  END,
  eod_run_time_label,
  created_at,
  CURRENT_TIMESTAMP
FROM dashboard_configs;

DROP TABLE dashboard_configs;
ALTER TABLE dashboard_configs__new RENAME TO dashboard_configs;

PRAGMA foreign_keys = ON;
