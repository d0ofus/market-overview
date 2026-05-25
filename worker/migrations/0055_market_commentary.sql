CREATE TABLE IF NOT EXISTS market_commentary_reports (
  id TEXT PRIMARY KEY,
  session_date TEXT NOT NULL,
  as_of TEXT NOT NULL,
  market_session TEXT NOT NULL,
  market_session_label TEXT NOT NULL,
  data_basis TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
  report_markdown TEXT NOT NULL,
  source_audit_json TEXT NOT NULL DEFAULT '[]',
  data_quality_json TEXT NOT NULL DEFAULT '[]',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_market_commentary_latest
  ON market_commentary_reports (session_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_commentary_created_at
  ON market_commentary_reports (created_at DESC);
