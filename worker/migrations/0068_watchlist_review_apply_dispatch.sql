ALTER TABLE watchlist_review_runs ADD COLUMN apply_status TEXT NOT NULL DEFAULT 'not_queued'
  CHECK (apply_status IN ('not_queued', 'approved_ready', 'dispatching', 'waiting_for_hermes', 'claimed', 'applying', 'applied', 'partial_failed', 'apply_failed', 'cancelled'));

ALTER TABLE watchlist_review_runs ADD COLUMN approval_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchlist_review_runs ADD COLUMN approved_checksum TEXT;
ALTER TABLE watchlist_review_runs ADD COLUMN active_apply_dispatch_id TEXT;
ALTER TABLE watchlist_review_runs ADD COLUMN approved_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchlist_review_runs ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchlist_review_runs ADD COLUMN destructive_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchlist_review_runs ADD COLUMN ready_to_apply_at TEXT;
ALTER TABLE watchlist_review_runs ADD COLUMN dispatch_requested_at TEXT;
ALTER TABLE watchlist_review_runs ADD COLUMN dispatched_to_hermes_at TEXT;
ALTER TABLE watchlist_review_runs ADD COLUMN apply_started_at TEXT;
ALTER TABLE watchlist_review_runs ADD COLUMN apply_completed_at TEXT;
ALTER TABLE watchlist_review_runs ADD COLUMN apply_failed_at TEXT;
ALTER TABLE watchlist_review_runs ADD COLUMN apply_error TEXT;
ALTER TABLE watchlist_review_runs ADD COLUMN apply_result_summary_json TEXT;

ALTER TABLE watchlist_review_candidates ADD COLUMN tv_symbol TEXT;
ALTER TABLE watchlist_review_candidates ADD COLUMN apply_status TEXT NOT NULL DEFAULT 'not_queued'
  CHECK (apply_status IN ('not_queued', 'queued_for_apply', 'applying', 'applied', 'apply_failed', 'skipped'));
ALTER TABLE watchlist_review_candidates ADD COLUMN apply_error TEXT;
ALTER TABLE watchlist_review_candidates ADD COLUMN apply_updated_at TEXT;
ALTER TABLE watchlist_review_candidates ADD COLUMN last_apply_dispatch_id TEXT;

CREATE TABLE IF NOT EXISTS watchlist_review_apply_dispatches (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  approval_revision INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('approved_ready', 'dispatching', 'waiting_for_hermes', 'webhook_failed', 'claimed', 'applying', 'applied', 'partial_failed', 'apply_failed', 'cancelled')),
  approved_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  destructive_count INTEGER NOT NULL DEFAULT 0,
  approved_set_json TEXT NOT NULL,
  payload_preview_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  requested_at TEXT NOT NULL,
  webhook_sent_at TEXT,
  webhook_failed_at TEXT,
  webhook_response_status INTEGER,
  claimed_at TEXT,
  heartbeat_at TEXT,
  claim_expires_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES watchlist_review_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_review_apply_dispatches_run_revision
  ON watchlist_review_apply_dispatches(run_id, approval_revision DESC);

CREATE INDEX IF NOT EXISTS idx_watchlist_review_apply_dispatches_status_updated
  ON watchlist_review_apply_dispatches(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_watchlist_review_apply_dispatches_idempotency
  ON watchlist_review_apply_dispatches(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_watchlist_review_apply_dispatches_claim
  ON watchlist_review_apply_dispatches(claim_expires_at);
