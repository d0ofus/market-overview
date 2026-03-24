CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT,
  source_label TEXT,
  status TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version_id TEXT NOT NULL,
  prompt_bundle_version_id TEXT,
  requested_ticker_count INTEGER NOT NULL DEFAULT 0,
  completed_ticker_count INTEGER NOT NULL DEFAULT 0,
  failed_ticker_count INTEGER NOT NULL DEFAULT 0,
  deep_dive_top_n INTEGER NOT NULL DEFAULT 0,
  refresh_mode TEXT NOT NULL DEFAULT 'reuse_fresh_search_cache',
  ranking_mode TEXT NOT NULL DEFAULT 'rank_only',
  input_json TEXT,
  provider_usage_json TEXT,
  provenance_json TEXT,
  error_summary TEXT,
  started_at TEXT,
  completed_at TEXT,
  heartbeat_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_research_runs_created_desc
  ON research_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_runs_status_created_desc
  ON research_runs(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_runs_source_created_desc
  ON research_runs(source_type, source_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_runs_profile_created_desc
  ON research_runs(profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS research_run_tickers (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  company_name TEXT,
  exchange TEXT,
  sec_cik TEXT,
  ir_domain TEXT,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  previous_snapshot_id TEXT,
  snapshot_id TEXT,
  ranking_row_id TEXT,
  normalization_json TEXT,
  working_json TEXT,
  stage_metrics_json TEXT,
  started_at TEXT,
  completed_at TEXT,
  heartbeat_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, ticker),
  FOREIGN KEY (run_id) REFERENCES research_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_research_run_tickers_run_sort
  ON research_run_tickers(run_id, sort_order ASC);

CREATE INDEX IF NOT EXISTS idx_research_run_tickers_run_status_sort
  ON research_run_tickers(run_id, status, sort_order ASC);

CREATE INDEX IF NOT EXISTS idx_research_run_tickers_ticker_created_desc
  ON research_run_tickers(ticker, created_at DESC);

CREATE TABLE IF NOT EXISTS research_evidence (
  id TEXT PRIMARY KEY,
  provider_key TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  ticker TEXT,
  sec_cik TEXT,
  canonical_url TEXT,
  source_domain TEXT,
  title TEXT NOT NULL,
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  cache_key TEXT NOT NULL UNIQUE,
  artifact_size_bytes INTEGER,
  r2_key TEXT,
  snippet_json TEXT,
  metadata_json TEXT,
  provider_payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_research_evidence_ticker_published_desc
  ON research_evidence(ticker, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_evidence_provider_retrieved_desc
  ON research_evidence(provider_key, retrieved_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_evidence_source_published_desc
  ON research_evidence(source_kind, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_evidence_canonical_url
  ON research_evidence(canonical_url);

CREATE TABLE IF NOT EXISTS research_run_evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  run_ticker_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  role TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_ticker_id, evidence_id),
  FOREIGN KEY (run_id) REFERENCES research_runs(id),
  FOREIGN KEY (run_ticker_id) REFERENCES research_run_tickers(id),
  FOREIGN KEY (evidence_id) REFERENCES research_evidence(id)
);

CREATE INDEX IF NOT EXISTS idx_research_run_evidence_run_ticker_sort
  ON research_run_evidence(run_ticker_id, sort_order ASC);

CREATE INDEX IF NOT EXISTS idx_research_run_evidence_evidence
  ON research_run_evidence(evidence_id);

CREATE TABLE IF NOT EXISTS research_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  run_ticker_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version_id TEXT NOT NULL,
  previous_snapshot_id TEXT,
  schema_version TEXT NOT NULL DEFAULT 'v1',
  overall_score REAL,
  attention_rank INTEGER,
  confidence_label TEXT,
  confidence_score REAL,
  valuation_label TEXT,
  earnings_quality_label TEXT,
  catalyst_freshness_label TEXT,
  risk_label TEXT,
  contradiction_flag INTEGER NOT NULL DEFAULT 0,
  thesis_json TEXT NOT NULL,
  change_json TEXT,
  citation_json TEXT,
  model_output_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES research_runs(id),
  FOREIGN KEY (run_ticker_id) REFERENCES research_run_tickers(id)
);

CREATE INDEX IF NOT EXISTS idx_research_snapshots_ticker_created_desc
  ON research_snapshots(ticker, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_snapshots_run_score_desc
  ON research_snapshots(run_id, overall_score DESC);

CREATE INDEX IF NOT EXISTS idx_research_snapshots_previous
  ON research_snapshots(previous_snapshot_id);

CREATE INDEX IF NOT EXISTS idx_research_snapshots_profile_ticker_created_desc
  ON research_snapshots(profile_id, ticker, created_at DESC);

CREATE TABLE IF NOT EXISTS research_factors (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  factor_key TEXT NOT NULL,
  score REAL NOT NULL,
  direction TEXT NOT NULL,
  confidence_score REAL,
  weight_applied REAL NOT NULL,
  explanation_json TEXT,
  supporting_evidence_ids_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (snapshot_id) REFERENCES research_snapshots(id)
);

CREATE INDEX IF NOT EXISTS idx_research_factors_snapshot_factor
  ON research_factors(snapshot_id, factor_key);

CREATE INDEX IF NOT EXISTS idx_research_factors_ticker_factor_created_desc
  ON research_factors(ticker, factor_key, created_at DESC);

CREATE TABLE IF NOT EXISTS research_rankings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  rank INTEGER NOT NULL,
  attention_score REAL NOT NULL,
  priority_bucket TEXT NOT NULL,
  deep_dive_requested INTEGER NOT NULL DEFAULT 0,
  deep_dive_completed INTEGER NOT NULL DEFAULT 0,
  ranking_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, ticker),
  FOREIGN KEY (run_id) REFERENCES research_runs(id),
  FOREIGN KEY (snapshot_id) REFERENCES research_snapshots(id)
);

CREATE INDEX IF NOT EXISTS idx_research_rankings_run_rank
  ON research_rankings(run_id, rank ASC);

CREATE INDEX IF NOT EXISTS idx_research_rankings_run_score_desc
  ON research_rankings(run_id, attention_score DESC);

CREATE TABLE IF NOT EXISTS ticker_research_heads (
  ticker TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  latest_snapshot_id TEXT NOT NULL,
  latest_run_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticker, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_ticker_research_heads_updated_desc
  ON ticker_research_heads(updated_at DESC);
