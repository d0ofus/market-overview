ALTER TABLE earnings_surprise_events ADD COLUMN avg_dollar_volume_30d REAL;

UPDATE earnings_surprise_events
SET avg_dollar_volume_30d = (
  SELECT gap.avg_dollar_volume_30d
  FROM earnings_gap_events AS gap
  WHERE gap.ticker = earnings_surprise_events.ticker
    AND gap.report_date = earnings_surprise_events.report_date
    AND gap.avg_dollar_volume_30d IS NOT NULL
  ORDER BY COALESCE(gap.last_seen_at, '') DESC, gap.id ASC
  LIMIT 1
)
WHERE avg_dollar_volume_30d IS NULL
  AND EXISTS (
    SELECT 1
    FROM earnings_gap_events AS gap
    WHERE gap.ticker = earnings_surprise_events.ticker
      AND gap.report_date = earnings_surprise_events.report_date
      AND gap.avg_dollar_volume_30d IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_earnings_surprise_avg_dollar_volume
  ON earnings_surprise_events(avg_dollar_volume_30d DESC);
