CREATE TABLE IF NOT EXISTS ticker_history_backfill_status (
  ticker TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  target_bars INTEGER NOT NULL DEFAULT 0,
  bar_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  last_requested_at TEXT,
  last_attempted_at TEXT,
  last_completed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticker, timeframe)
);

CREATE INDEX IF NOT EXISTS idx_ticker_history_backfill_status_updated
  ON ticker_history_backfill_status(status, updated_at);
