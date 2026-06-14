CREATE TABLE IF NOT EXISTS watchlist_review_preps (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_set_id TEXT,
  source_set_name TEXT,
  watchlist_name TEXT,
  watchlist_run_id TEXT,
  symbol_count INTEGER NOT NULL,
  lookback_bars INTEGER NOT NULL,
  expected_as_of_date TEXT NOT NULL,
  provider_json TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  symbols_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'ready_with_warnings', 'blocked')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_watchlist_review_preps_created
  ON watchlist_review_preps(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_watchlist_review_preps_source
  ON watchlist_review_preps(source, source_set_id, watchlist_run_id, created_at DESC);

ALTER TABLE watchlist_review_runs ADD COLUMN prep_id TEXT;

CREATE INDEX IF NOT EXISTS idx_watchlist_review_runs_prep
  ON watchlist_review_runs(prep_id);

ALTER TABLE watchlist_review_apply_dispatches ADD COLUMN claim_owner TEXT;

CREATE INDEX IF NOT EXISTS idx_watchlist_review_apply_dispatches_claim_owner
  ON watchlist_review_apply_dispatches(claim_owner, claim_expires_at);
