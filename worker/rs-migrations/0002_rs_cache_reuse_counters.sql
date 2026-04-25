ALTER TABLE rs_scan_runs ADD COLUMN cache_hit_tickers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rs_scan_runs ADD COLUMN computed_tickers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rs_scan_runs ADD COLUMN missing_bars_tickers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rs_scan_runs ADD COLUMN insufficient_history_tickers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rs_scan_runs ADD COLUMN error_tickers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rs_scan_runs ADD COLUMN stale_benchmark_tickers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rs_scan_runs ADD COLUMN duration_ms INTEGER;

ALTER TABLE rs_scan_run_tickers ADD COLUMN source TEXT NOT NULL DEFAULT 'computed';

ALTER TABLE rs_features_latest ADD COLUMN expected_trading_date TEXT;

UPDATE rs_features_latest
SET expected_trading_date = COALESCE(
  (
    SELECT r.expected_trading_date
    FROM rs_scan_runs r
    WHERE r.config_key = rs_features_latest.config_key
      AND r.status = 'completed'
    ORDER BY datetime(r.completed_at) DESC, datetime(r.created_at) DESC
    LIMIT 1
  ),
  trading_date
)
WHERE expected_trading_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_rs_features_latest_config_expected_ticker
  ON rs_features_latest(config_key, expected_trading_date, ticker);

CREATE INDEX IF NOT EXISTS idx_rs_scan_run_tickers_source_status
  ON rs_scan_run_tickers(run_id, source, status);
