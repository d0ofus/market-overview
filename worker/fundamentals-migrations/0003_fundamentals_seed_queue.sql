CREATE TABLE IF NOT EXISTS fundamental_seed_queue (
  ticker TEXT PRIMARY KEY,
  cik TEXT NOT NULL,
  company_name TEXT NOT NULL,
  exchange TEXT,
  market_cap REAL,
  priority_rank INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'tradingview_market_cap',
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  rows_upserted INTEGER NOT NULL DEFAULT 0,
  latest_period_end TEXT,
  latest_filed_at TEXT,
  last_error TEXT,
  last_refreshed_at TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fundamental_seed_queue_status_priority
  ON fundamental_seed_queue(status, priority_rank);

CREATE INDEX IF NOT EXISTS idx_fundamental_seed_queue_next_attempt
  ON fundamental_seed_queue(status, next_attempt_at, priority_rank);

CREATE INDEX IF NOT EXISTS idx_fundamental_seed_queue_market_cap
  ON fundamental_seed_queue(market_cap DESC);

CREATE TABLE IF NOT EXISTS fundamental_seed_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  requested_limit INTEGER NOT NULL DEFAULT 0,
  fetched_rows INTEGER NOT NULL DEFAULT 0,
  eligible_rows INTEGER NOT NULL DEFAULT 0,
  queued_rows INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  ok_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  no_supported_rows INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fundamental_seed_runs_type_created
  ON fundamental_seed_runs(run_type, created_at DESC);
