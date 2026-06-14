CREATE TABLE IF NOT EXISTS watchlist_review_analysis_dispatches (
  id TEXT PRIMARY KEY,
  prep_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_set_id TEXT,
  source_set_name TEXT,
  watchlist_name TEXT,
  watchlist_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'queued',
    'dispatching',
    'waiting_for_hermes',
    'webhook_failed',
    'claimed',
    'running',
    'completed',
    'partial_failed',
    'failed',
    'cancelled'
  )),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_checksum TEXT NOT NULL,
  payload_preview_json TEXT NOT NULL DEFAULT '{}',
  claim_owner TEXT,
  claimed_at TEXT,
  claim_expires_at TEXT,
  heartbeat_at TEXT,
  requested_at TEXT NOT NULL,
  webhook_sent_at TEXT,
  webhook_failed_at TEXT,
  webhook_response_status INTEGER,
  started_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  error TEXT,
  result_json TEXT,
  created_review_run_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (prep_id) REFERENCES watchlist_review_preps(id)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_review_analysis_dispatches_status
  ON watchlist_review_analysis_dispatches(status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_watchlist_review_analysis_dispatches_prep
  ON watchlist_review_analysis_dispatches(prep_id);

CREATE INDEX IF NOT EXISTS idx_watchlist_review_analysis_dispatches_claim
  ON watchlist_review_analysis_dispatches(claim_owner, claim_expires_at);

ALTER TABLE watchlist_review_runs ADD COLUMN analysis_dispatch_id TEXT;
ALTER TABLE watchlist_review_runs ADD COLUMN analysis_metadata_json TEXT;

CREATE INDEX IF NOT EXISTS idx_watchlist_review_runs_analysis_dispatch
  ON watchlist_review_runs(analysis_dispatch_id);
