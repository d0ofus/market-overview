ALTER TABLE scan_presets ADD COLUMN vcp_daily_pivot_lookback INTEGER NOT NULL DEFAULT 100;
ALTER TABLE scan_presets ADD COLUMN vcp_weekly_high_lookback INTEGER NOT NULL DEFAULT 100;
ALTER TABLE scan_presets ADD COLUMN vcp_pivot_age_bars INTEGER NOT NULL DEFAULT 10;
ALTER TABLE scan_presets ADD COLUMN vcp_daily_near_pct REAL NOT NULL DEFAULT 7.0;
ALTER TABLE scan_presets ADD COLUMN vcp_weekly_near_pct REAL NOT NULL DEFAULT 20.0;
