ALTER TABLE earnings_gap_events
ADD COLUMN calculation_status TEXT NOT NULL DEFAULT 'complete';

ALTER TABLE earnings_gap_events
ADD COLUMN bar_provider TEXT;

ALTER TABLE earnings_gap_events
ADD COLUMN calculated_at TEXT;

UPDATE earnings_gap_events
SET
  calculation_status = CASE
    WHEN report_time = 'after-market'
      AND regular_open_gap_pct IS NULL
      AND postmarket_gap_pct > 0
      THEN 'provisional'
    WHEN regular_open_gap_pct IS NULL
      THEN 'deferred'
    ELSE 'complete'
  END,
  bar_provider = CASE
    WHEN regular_open_gap_pct IS NOT NULL AND postmarket_gap_pct IS NOT NULL THEN 'alpaca+tradingview'
    WHEN regular_open_gap_pct IS NOT NULL THEN 'alpaca'
    WHEN report_time = 'after-market' AND postmarket_gap_pct IS NOT NULL THEN 'tradingview'
    ELSE NULL
  END,
  calculated_at = COALESCE(updated_at, CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS idx_earnings_gap_calculation_status_report_date
  ON earnings_gap_events(calculation_status, report_date DESC, ticker);

ALTER TABLE earnings_gap_syncs
ADD COLUMN bars_requested INTEGER NOT NULL DEFAULT 0;

ALTER TABLE earnings_gap_syncs
ADD COLUMN bars_ready INTEGER NOT NULL DEFAULT 0;

ALTER TABLE earnings_gap_syncs
ADD COLUMN bars_fetched INTEGER NOT NULL DEFAULT 0;

ALTER TABLE earnings_gap_syncs
ADD COLUMN rows_deferred INTEGER NOT NULL DEFAULT 0;

ALTER TABLE earnings_gap_syncs
ADD COLUMN warning TEXT;
