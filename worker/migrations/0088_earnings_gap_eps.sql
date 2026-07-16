ALTER TABLE earnings_gap_events ADD COLUMN eps_provider TEXT;
ALTER TABLE earnings_gap_events ADD COLUMN eps_actual REAL;
ALTER TABLE earnings_gap_events ADD COLUMN eps_estimate REAL;
ALTER TABLE earnings_gap_events ADD COLUMN eps_surprise REAL;
ALTER TABLE earnings_gap_events ADD COLUMN eps_surprise_pct REAL;

WITH ranked_surprises AS (
  SELECT
    provider,
    ticker,
    report_date,
    eps_actual,
    eps_estimate,
    eps_surprise,
    eps_surprise_pct,
    ROW_NUMBER() OVER (
      PARTITION BY ticker, report_date
      ORDER BY
        CASE provider
          WHEN 'tradingview' THEN 0
          WHEN 'fmp' THEN 1
          WHEN 'finnhub' THEN 2
          ELSE 3
        END,
        COALESCE(last_seen_at, '') DESC,
        COALESCE(fiscal_period_end, '') DESC
    ) AS provider_rank
  FROM earnings_surprise_events
)
UPDATE earnings_gap_events
SET
  eps_provider = (
    SELECT provider
    FROM ranked_surprises
    WHERE provider_rank = 1
      AND ranked_surprises.ticker = earnings_gap_events.ticker
      AND ranked_surprises.report_date = earnings_gap_events.report_date
  ),
  eps_actual = (
    SELECT eps_actual
    FROM ranked_surprises
    WHERE provider_rank = 1
      AND ranked_surprises.ticker = earnings_gap_events.ticker
      AND ranked_surprises.report_date = earnings_gap_events.report_date
  ),
  eps_estimate = (
    SELECT eps_estimate
    FROM ranked_surprises
    WHERE provider_rank = 1
      AND ranked_surprises.ticker = earnings_gap_events.ticker
      AND ranked_surprises.report_date = earnings_gap_events.report_date
  ),
  eps_surprise = (
    SELECT eps_surprise
    FROM ranked_surprises
    WHERE provider_rank = 1
      AND ranked_surprises.ticker = earnings_gap_events.ticker
      AND ranked_surprises.report_date = earnings_gap_events.report_date
  ),
  eps_surprise_pct = (
    SELECT eps_surprise_pct
    FROM ranked_surprises
    WHERE provider_rank = 1
      AND ranked_surprises.ticker = earnings_gap_events.ticker
      AND ranked_surprises.report_date = earnings_gap_events.report_date
  )
WHERE EXISTS (
  SELECT 1
  FROM ranked_surprises
  WHERE provider_rank = 1
    AND ranked_surprises.ticker = earnings_gap_events.ticker
    AND ranked_surprises.report_date = earnings_gap_events.report_date
);

CREATE INDEX IF NOT EXISTS idx_earnings_gap_eps_pct
  ON earnings_gap_events(eps_surprise_pct DESC);

CREATE INDEX IF NOT EXISTS idx_earnings_gap_eps_diff
  ON earnings_gap_events(eps_surprise DESC);
