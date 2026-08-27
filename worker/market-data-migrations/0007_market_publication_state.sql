CREATE TABLE IF NOT EXISTS universes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active_version_id TEXT
);

CREATE TABLE IF NOT EXISTS universe_symbols (
  universe_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  PRIMARY KEY (universe_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_market_universe_symbols_ticker
  ON universe_symbols (ticker, universe_id);

CREATE TABLE IF NOT EXISTS universe_versions (
  id TEXT PRIMARY KEY,
  universe_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_type TEXT,
  source_url TEXT,
  source_as_of_date TEXT,
  status TEXT NOT NULL,
  member_count INTEGER NOT NULL DEFAULT 0,
  source_member_count INTEGER,
  normalized_member_count INTEGER,
  resolved_member_count INTEGER,
  unresolved_count INTEGER,
  unresolved_symbols_json TEXT,
  membership_hash TEXT,
  previous_member_count INTEGER,
  change_pct REAL,
  validation_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  promoted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_market_universe_versions_status
  ON universe_versions (universe_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_universe_versions_hash
  ON universe_versions (universe_id, membership_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS universe_version_members (
  version_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  source_ticker TEXT,
  issuer_name TEXT,
  exchange TEXT,
  asset_class TEXT,
  PRIMARY KEY (version_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_market_universe_version_members_ticker
  ON universe_version_members (ticker, version_id);

CREATE TABLE IF NOT EXISTS breadth_snapshots (
  id TEXT PRIMARY KEY,
  generation_id TEXT,
  as_of_date TEXT NOT NULL,
  universe_id TEXT NOT NULL,
  advancers INTEGER NOT NULL,
  decliners INTEGER NOT NULL,
  unchanged INTEGER NOT NULL,
  pct_above_20ma REAL,
  pct_above_50ma REAL,
  pct_above_200ma REAL,
  new_20d_highs INTEGER,
  new_20d_lows INTEGER,
  median_return_1d REAL NOT NULL,
  median_return_5d REAL,
  sentiment_json TEXT,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(as_of_date, universe_id)
);

CREATE INDEX IF NOT EXISTS idx_market_breadth_latest
  ON breadth_snapshots (universe_id, as_of_date DESC, generated_at DESC);

CREATE TABLE IF NOT EXISTS breadth_generations (
  id TEXT PRIMARY KEY,
  as_of_date TEXT NOT NULL,
  expected_as_of_date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  provider_label TEXT NOT NULL,
  status TEXT NOT NULL,
  health TEXT NOT NULL,
  warning TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_market_breadth_generations_latest
  ON breadth_generations (status, as_of_date DESC, generated_at DESC);

CREATE TABLE IF NOT EXISTS breadth_publication_pointer (
  pointer_key TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS data_readiness (
  domain TEXT NOT NULL,
  scope TEXT NOT NULL,
  expected_as_of_date TEXT,
  source_as_of_date TEXT,
  generation_id TEXT,
  status TEXT NOT NULL,
  coverage_pct REAL,
  warning TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (domain, scope)
);

CREATE INDEX IF NOT EXISTS idx_market_data_readiness_status
  ON data_readiness (domain, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS overview_generations (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  provider_label TEXT NOT NULL,
  expected_as_of_date TEXT,
  status TEXT NOT NULL,
  freshness_status TEXT NOT NULL,
  current_count INTEGER NOT NULL DEFAULT 0,
  eligible_count INTEGER NOT NULL DEFAULT 0,
  coverage_pct REAL NOT NULL DEFAULT 0,
  critical_missing_json TEXT NOT NULL DEFAULT '[]',
  min_bar_date TEXT,
  max_bar_date TEXT,
  warning TEXT,
  quote_requested_count INTEGER,
  quote_returned_count INTEGER,
  quote_error TEXT,
  quote_missing_sample_json TEXT,
  source_cycle_id TEXT,
  publication_quality TEXT,
  essential_current_coverage_pct REAL,
  publication_critical_missing_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_market_overview_generations_status
  ON overview_generations (config_id, status, generated_at DESC);

CREATE TABLE IF NOT EXISTS overview_snapshot_pointer (
  config_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS snapshots_meta (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  provider_label TEXT NOT NULL,
  expected_as_of_date TEXT,
  freshness_status TEXT NOT NULL DEFAULT 'stale',
  freshness_current_count INTEGER NOT NULL DEFAULT 0,
  freshness_eligible_count INTEGER NOT NULL DEFAULT 0,
  freshness_coverage_pct REAL NOT NULL DEFAULT 0,
  freshness_critical_missing_json TEXT NOT NULL DEFAULT '[]',
  freshness_min_bar_date TEXT,
  freshness_max_bar_date TEXT,
  freshness_warning TEXT,
  quote_overlay_requested_count INTEGER,
  quote_overlay_returned_count INTEGER,
  quote_overlay_error TEXT,
  quote_overlay_missing_sample_json TEXT,
  UNIQUE(config_id, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_market_snapshots_meta_latest
  ON snapshots_meta (config_id, as_of_date DESC, generated_at DESC);

CREATE TABLE IF NOT EXISTS snapshot_rows (
  snapshot_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  display_name TEXT,
  price REAL,
  change_1d REAL,
  change_1w REAL,
  change_5d REAL,
  change_3m REAL,
  change_6m REAL,
  change_21d REAL,
  ytd REAL,
  pct_from_52w_high REAL,
  sparkline_json TEXT,
  rank_key REAL,
  holdings_json TEXT,
  bar_date TEXT,
  quote_price REAL,
  quote_prev_close REAL,
  quote_change_1d REAL,
  quote_source TEXT,
  quote_fetched_at TEXT,
  quote_freshness_status TEXT,
  quote_freshness_reason TEXT,
  bar_freshness_status TEXT,
  bar_freshness_reason TEXT,
  history_series_through_date TEXT,
  history_series_status TEXT,
  history_series_source TEXT,
  history_series_reason TEXT,
  above_20_sma INTEGER,
  above_50_sma INTEGER,
  above_200_sma INTEGER,
  relative_strength_30d_vs_spy_json TEXT,
  PRIMARY KEY (snapshot_id, group_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_market_snapshot_rows_snapshot
  ON snapshot_rows (snapshot_id, rank_key DESC);
