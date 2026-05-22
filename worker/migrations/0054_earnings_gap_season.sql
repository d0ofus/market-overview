ALTER TABLE earnings_gap_events ADD COLUMN season TEXT;

UPDATE earnings_gap_events
SET season = substr(report_date, 1, 4) || ' Q' || CAST(((CAST(substr(report_date, 6, 2) AS INTEGER) + 2) / 3) AS INTEGER)
WHERE season IS NULL OR season = '';

CREATE INDEX IF NOT EXISTS idx_earnings_gap_season
  ON earnings_gap_events(season, qualifying_gap_pct DESC);
