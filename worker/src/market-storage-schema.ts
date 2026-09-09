// Reviewed production market_prices schema captured 2026-09-09.
// Snapshot data and credentials are not embedded. Unexpected schema changes fail closed.
export const STORAGE_TABLES = [
  {
    "name": "alpaca_daily_bars",
    "columns": [
      "feed",
      "ticker",
      "date",
      "o",
      "h",
      "l",
      "c",
      "volume",
      "fetched_at",
      "source_provider",
      "adjustment",
      "observed_at",
      "reported_volume",
      "reported_volume_collected_at"
    ],
    "key": [
      "feed",
      "ticker",
      "date"
    ],
    "sql": "CREATE TABLE alpaca_daily_bars (\n  feed TEXT NOT NULL,\n  ticker TEXT NOT NULL,\n  date TEXT NOT NULL,\n  o REAL NOT NULL,\n  h REAL NOT NULL,\n  l REAL NOT NULL,\n  c REAL NOT NULL,\n  volume REAL,\n  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, source_provider TEXT NOT NULL DEFAULT 'alpaca', adjustment TEXT NOT NULL DEFAULT 'split', observed_at TEXT, reported_volume REAL, reported_volume_collected_at TEXT,\n  PRIMARY KEY (feed, ticker, date)\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "bar_coverage",
    "columns": [
      "feed",
      "ticker",
      "requested_start",
      "observed_start",
      "observed_end",
      "observed_sessions",
      "expected_sessions",
      "missing_sessions",
      "status",
      "verified_at"
    ],
    "key": [
      "feed",
      "ticker"
    ],
    "sql": "CREATE TABLE bar_coverage (\n  feed TEXT NOT NULL,\n  ticker TEXT NOT NULL,\n  requested_start TEXT NOT NULL,\n  observed_start TEXT,\n  observed_end TEXT,\n  observed_sessions INTEGER NOT NULL DEFAULT 0,\n  expected_sessions INTEGER NOT NULL DEFAULT 0,\n  missing_sessions INTEGER NOT NULL DEFAULT 0,\n  status TEXT NOT NULL,\n  verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (feed, ticker)\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "breadth_generations",
    "columns": [
      "id",
      "as_of_date",
      "expected_as_of_date",
      "generated_at",
      "provider_label",
      "status",
      "health",
      "warning",
      "created_at"
    ],
    "key": [
      "id"
    ],
    "sql": "CREATE TABLE breadth_generations (\n  id TEXT PRIMARY KEY,\n  as_of_date TEXT NOT NULL,\n  expected_as_of_date TEXT NOT NULL,\n  generated_at TEXT NOT NULL,\n  provider_label TEXT NOT NULL,\n  status TEXT NOT NULL,\n  health TEXT NOT NULL,\n  warning TEXT,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n)"
  },
  {
    "name": "breadth_publication_pointer",
    "columns": [
      "pointer_key",
      "generation_id",
      "updated_at"
    ],
    "key": [
      "pointer_key"
    ],
    "sql": "CREATE TABLE breadth_publication_pointer (\n  pointer_key TEXT PRIMARY KEY,\n  generation_id TEXT NOT NULL,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n)"
  },
  {
    "name": "breadth_snapshots",
    "columns": [
      "id",
      "generation_id",
      "as_of_date",
      "universe_id",
      "advancers",
      "decliners",
      "unchanged",
      "pct_above_20ma",
      "pct_above_50ma",
      "pct_above_200ma",
      "new_20d_highs",
      "new_20d_lows",
      "median_return_1d",
      "median_return_5d",
      "sentiment_json",
      "generated_at"
    ],
    "key": [
      "id"
    ],
    "sql": "CREATE TABLE breadth_snapshots (\n  id TEXT PRIMARY KEY,\n  generation_id TEXT,\n  as_of_date TEXT NOT NULL,\n  universe_id TEXT NOT NULL,\n  advancers INTEGER NOT NULL,\n  decliners INTEGER NOT NULL,\n  unchanged INTEGER NOT NULL,\n  pct_above_20ma REAL,\n  pct_above_50ma REAL,\n  pct_above_200ma REAL,\n  new_20d_highs INTEGER,\n  new_20d_lows INTEGER,\n  median_return_1d REAL NOT NULL,\n  median_return_5d REAL,\n  sentiment_json TEXT,\n  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  UNIQUE(as_of_date, universe_id)\n)"
  },
  {
    "name": "daily_market_features",
    "columns": [
      "feed",
      "ticker",
      "session_date",
      "close",
      "volume",
      "previous_close",
      "return_1d",
      "return_5d",
      "return_63d",
      "sma_5",
      "sma_20",
      "sma_50",
      "sma_100",
      "sma_200",
      "high_5",
      "high_20",
      "high_21",
      "high_63",
      "high_126",
      "high_252",
      "low_20",
      "source_sessions",
      "source_provider",
      "computed_at",
      "input_start_date",
      "alpaca_bar_count",
      "repair_bar_count",
      "input_last_observed_at",
      "input_revision"
    ],
    "key": [
      "feed",
      "ticker",
      "session_date"
    ],
    "sql": "CREATE TABLE daily_market_features (\n  feed TEXT NOT NULL,\n  ticker TEXT NOT NULL,\n  session_date TEXT NOT NULL,\n  close REAL NOT NULL,\n  volume REAL NOT NULL DEFAULT 0,\n  previous_close REAL,\n  return_1d REAL,\n  return_5d REAL,\n  return_63d REAL,\n  sma_5 REAL,\n  sma_20 REAL,\n  sma_50 REAL,\n  sma_100 REAL,\n  sma_200 REAL,\n  high_5 REAL,\n  high_20 REAL,\n  high_21 REAL,\n  high_63 REAL,\n  high_126 REAL,\n  high_252 REAL,\n  low_20 REAL,\n  source_sessions INTEGER NOT NULL DEFAULT 0,\n  source_provider TEXT NOT NULL DEFAULT 'alpaca',\n  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, input_start_date TEXT, alpaca_bar_count INTEGER NOT NULL DEFAULT 0, repair_bar_count INTEGER NOT NULL DEFAULT 0, input_last_observed_at TEXT, input_revision INTEGER,\n  PRIMARY KEY (feed, ticker, session_date)\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "data_readiness",
    "columns": [
      "domain",
      "scope",
      "expected_as_of_date",
      "source_as_of_date",
      "generation_id",
      "status",
      "coverage_pct",
      "warning",
      "updated_at"
    ],
    "key": [
      "domain",
      "scope"
    ],
    "sql": "CREATE TABLE data_readiness (\n  domain TEXT NOT NULL,\n  scope TEXT NOT NULL,\n  expected_as_of_date TEXT,\n  source_as_of_date TEXT,\n  generation_id TEXT,\n  status TEXT NOT NULL,\n  coverage_pct REAL,\n  warning TEXT,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (domain, scope)\n)"
  },
  {
    "name": "eod_adjustment_repairs",
    "columns": [
      "feed",
      "ticker",
      "status",
      "owner_token",
      "start_date",
      "updated_at"
    ],
    "key": [
      "feed",
      "ticker"
    ],
    "sql": "CREATE TABLE eod_adjustment_repairs (\n  feed TEXT NOT NULL,\n  ticker TEXT NOT NULL,\n  status TEXT NOT NULL CHECK(status IN ('pending','complete')),\n  owner_token TEXT,\n  start_date TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  PRIMARY KEY(feed,ticker)\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "eod_history_relocations",
    "columns": [
      "feed",
      "ticker",
      "date",
      "operation_id",
      "bar_identity"
    ],
    "key": [
      "feed",
      "ticker",
      "date"
    ],
    "sql": "CREATE TABLE eod_history_relocations (\n  feed TEXT NOT NULL,\n  ticker TEXT NOT NULL,\n  date TEXT NOT NULL,\n  operation_id TEXT NOT NULL,\n  bar_identity TEXT NOT NULL,\n  PRIMARY KEY(feed,ticker,date)\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "eod_input_clock",
    "columns": [
      "id",
      "revision"
    ],
    "key": [
      "id"
    ],
    "sql": "CREATE TABLE eod_input_clock (\n  id TEXT PRIMARY KEY CHECK(id='default'),\n  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0)\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "eod_input_revisions",
    "columns": [
      "feed",
      "ticker",
      "revision",
      "semantic_revision",
      "last_correction_revision",
      "append_high_water_date",
      "append_epoch_start_revision",
      "append_epoch_start_date",
      "updated_at"
    ],
    "key": [
      "feed",
      "ticker"
    ],
    "sql": "CREATE TABLE eod_input_revisions (\n  feed TEXT NOT NULL,\n  ticker TEXT NOT NULL,\n  revision INTEGER NOT NULL DEFAULT 1,\n  -- Constant-size semantic evidence, not a per-bar change journal. Unknown\n  -- writers leave semantic_revision behind and cannot authorize old catalogs.\n  semantic_revision INTEGER NOT NULL DEFAULT 0,\n  last_correction_revision INTEGER NOT NULL DEFAULT 0,\n  append_high_water_date TEXT,\n  append_epoch_start_revision INTEGER,\n  append_epoch_start_date TEXT,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY(feed,ticker)\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "eod_publication_pointers",
    "columns": [
      "scope",
      "publication_id",
      "session_date",
      "published_at"
    ],
    "key": [
      "scope"
    ],
    "sql": "CREATE TABLE eod_publication_pointers (\n  scope TEXT PRIMARY KEY,\n  publication_id TEXT NOT NULL REFERENCES eod_publications(id),\n  session_date TEXT NOT NULL,\n  published_at TEXT NOT NULL\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "eod_publications",
    "columns": [
      "id",
      "scope",
      "session_date",
      "revision",
      "input_hash",
      "methodology_version",
      "payload_json",
      "payload_checksum",
      "payload_codec",
      "payload_base64",
      "status",
      "created_at",
      "accepted_at"
    ],
    "key": [
      "id"
    ],
    "sql": "CREATE TABLE eod_publications (\n  id TEXT PRIMARY KEY,\n  scope TEXT NOT NULL,\n  session_date TEXT NOT NULL,\n  revision INTEGER NOT NULL,\n  input_hash TEXT NOT NULL,\n  methodology_version TEXT NOT NULL,\n  payload_json TEXT NOT NULL,\n  payload_checksum TEXT,\n  payload_codec TEXT NOT NULL DEFAULT 'json',\n  payload_base64 TEXT,\n  status TEXT NOT NULL CHECK(status IN ('candidate','accepted','rejected')),\n  created_at TEXT NOT NULL,\n  accepted_at TEXT,\n  UNIQUE(scope, session_date, input_hash)\n) STRICT"
  },
  {
    "name": "market_calendar_refresh_state",
    "columns": [
      "id",
      "covered_start",
      "covered_end",
      "verified_at"
    ],
    "key": [
      "id"
    ],
    "sql": "CREATE TABLE market_calendar_refresh_state (\n  id TEXT PRIMARY KEY,\n  covered_start TEXT NOT NULL,\n  covered_end TEXT NOT NULL,\n  verified_at TEXT NOT NULL\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "market_calendar_sessions",
    "columns": [
      "session_date",
      "open_at",
      "close_at",
      "source",
      "fetched_at"
    ],
    "key": [
      "session_date"
    ],
    "sql": "CREATE TABLE market_calendar_sessions (\n  session_date TEXT PRIMARY KEY,\n  open_at TEXT NOT NULL,\n  close_at TEXT NOT NULL,\n  source TEXT NOT NULL,\n  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "market_data_daily_usage",
    "columns": [
      "usage_date",
      "bars_written",
      "updated_at",
      "rows_read",
      "rows_written"
    ],
    "key": [
      "usage_date"
    ],
    "sql": "CREATE TABLE market_data_daily_usage (\n  usage_date TEXT PRIMARY KEY,\n  bars_written INTEGER NOT NULL DEFAULT 0,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n, rows_read INTEGER NOT NULL DEFAULT 0, rows_written INTEGER NOT NULL DEFAULT 0) STRICT, WITHOUT ROWID"
  },
  {
    "name": "market_data_maintenance_state",
    "columns": [
      "id",
      "last_run_date",
      "updated_at"
    ],
    "key": [
      "id"
    ],
    "sql": "CREATE TABLE market_data_maintenance_state (\n  id TEXT PRIMARY KEY,\n  last_run_date TEXT,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "overview_alpaca_history_state",
    "columns": [
      "ticker",
      "source_feed",
      "lookback_start",
      "through_date",
      "status",
      "last_error",
      "updated_at"
    ],
    "key": [
      "ticker",
      "source_feed"
    ],
    "sql": "CREATE TABLE overview_alpaca_history_state (\n  ticker TEXT NOT NULL,\n  source_feed TEXT NOT NULL,\n  lookback_start TEXT NOT NULL,\n  through_date TEXT NOT NULL,\n  status TEXT NOT NULL,\n  last_error TEXT,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (ticker, source_feed)\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "overview_current_data",
    "columns": [
      "config_id",
      "session_date",
      "ticker",
      "status",
      "reason",
      "price",
      "change_1d",
      "change_1w",
      "change_5d",
      "change_3m",
      "change_6m",
      "ytd",
      "pct_from_52w_high",
      "above_20_sma",
      "above_50_sma",
      "above_200_sma",
      "quote_source",
      "performance_source",
      "sma_source",
      "field_sources_json",
      "provider_statuses_json",
      "tradingview_symbol",
      "tradingview_time",
      "tradingview_last_bar_update_time",
      "tradingview_last_price_update_time",
      "tradingview_update_time",
      "tradingview_update_mode",
      "tradingview_current_session",
      "fetched_at",
      "updated_at"
    ],
    "key": [
      "config_id",
      "session_date",
      "ticker"
    ],
    "sql": "CREATE TABLE overview_current_data (\n  config_id TEXT NOT NULL,\n  session_date TEXT NOT NULL,\n  ticker TEXT NOT NULL,\n  status TEXT NOT NULL,\n  reason TEXT,\n  price REAL,\n  change_1d REAL,\n  change_1w REAL,\n  change_5d REAL,\n  change_3m REAL,\n  change_6m REAL,\n  ytd REAL,\n  pct_from_52w_high REAL,\n  above_20_sma INTEGER,\n  above_50_sma INTEGER,\n  above_200_sma INTEGER,\n  quote_source TEXT,\n  performance_source TEXT,\n  sma_source TEXT,\n  field_sources_json TEXT NOT NULL DEFAULT '{}',\n  provider_statuses_json TEXT NOT NULL DEFAULT '{}',\n  tradingview_symbol TEXT,\n  tradingview_time TEXT,\n  tradingview_last_bar_update_time TEXT,\n  tradingview_last_price_update_time TEXT,\n  tradingview_update_time TEXT,\n  tradingview_update_mode TEXT,\n  tradingview_current_session TEXT,\n  fetched_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (config_id, session_date, ticker)\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "overview_current_refresh_jobs",
    "columns": [
      "config_id",
      "session_date",
      "status",
      "attempt_count",
      "next_attempt_at",
      "requested_tickers",
      "fresh_tickers",
      "unavailable_tickers",
      "last_error",
      "started_at",
      "updated_at",
      "completed_at",
      "cycle_id",
      "cycle_started_at",
      "cursor_offset",
      "processed_tickers",
      "lease_token",
      "lease_expires_at",
      "last_error_code"
    ],
    "key": [
      "config_id",
      "session_date"
    ],
    "sql": "CREATE TABLE overview_current_refresh_jobs (\n  config_id TEXT NOT NULL,\n  session_date TEXT NOT NULL,\n  status TEXT NOT NULL,\n  attempt_count INTEGER NOT NULL DEFAULT 0,\n  next_attempt_at TEXT,\n  requested_tickers INTEGER NOT NULL DEFAULT 0,\n  fresh_tickers INTEGER NOT NULL DEFAULT 0,\n  unavailable_tickers INTEGER NOT NULL DEFAULT 0,\n  last_error TEXT,\n  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  completed_at TEXT, cycle_id TEXT, cycle_started_at TEXT, cursor_offset INTEGER NOT NULL DEFAULT 0, processed_tickers INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_expires_at TEXT, last_error_code TEXT,\n  PRIMARY KEY (config_id, session_date)\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "overview_generations",
    "columns": [
      "id",
      "config_id",
      "as_of_date",
      "generated_at",
      "provider_label",
      "expected_as_of_date",
      "status",
      "freshness_status",
      "current_count",
      "eligible_count",
      "coverage_pct",
      "critical_missing_json",
      "min_bar_date",
      "max_bar_date",
      "warning",
      "quote_requested_count",
      "quote_returned_count",
      "quote_error",
      "quote_missing_sample_json",
      "source_cycle_id",
      "publication_quality",
      "essential_current_coverage_pct",
      "publication_critical_missing_json",
      "created_at"
    ],
    "key": [
      "id"
    ],
    "sql": "CREATE TABLE overview_generations (\n  id TEXT PRIMARY KEY,\n  config_id TEXT NOT NULL,\n  as_of_date TEXT NOT NULL,\n  generated_at TEXT NOT NULL,\n  provider_label TEXT NOT NULL,\n  expected_as_of_date TEXT,\n  status TEXT NOT NULL,\n  freshness_status TEXT NOT NULL,\n  current_count INTEGER NOT NULL DEFAULT 0,\n  eligible_count INTEGER NOT NULL DEFAULT 0,\n  coverage_pct REAL NOT NULL DEFAULT 0,\n  critical_missing_json TEXT NOT NULL DEFAULT '[]',\n  min_bar_date TEXT,\n  max_bar_date TEXT,\n  warning TEXT,\n  quote_requested_count INTEGER,\n  quote_returned_count INTEGER,\n  quote_error TEXT,\n  quote_missing_sample_json TEXT,\n  source_cycle_id TEXT,\n  publication_quality TEXT,\n  essential_current_coverage_pct REAL,\n  publication_critical_missing_json TEXT,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n)"
  },
  {
    "name": "overview_provider_catalog_cache",
    "columns": [
      "provider_key",
      "catalog_date",
      "symbols_json",
      "fetched_at"
    ],
    "key": [
      "provider_key",
      "catalog_date"
    ],
    "sql": "CREATE TABLE overview_provider_catalog_cache (\n  provider_key TEXT NOT NULL,\n  catalog_date TEXT NOT NULL,\n  symbols_json TEXT NOT NULL,\n  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (provider_key, catalog_date)\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "overview_provider_symbols",
    "columns": [
      "provider_key",
      "ticker",
      "provider_symbol",
      "support_status",
      "reason",
      "checked_at"
    ],
    "key": [
      "provider_key",
      "ticker"
    ],
    "sql": "CREATE TABLE overview_provider_symbols (\n  provider_key TEXT NOT NULL,\n  ticker TEXT NOT NULL,\n  provider_symbol TEXT,\n  support_status TEXT NOT NULL,\n  reason TEXT,\n  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (provider_key, ticker)\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "overview_snapshot_pointer",
    "columns": [
      "config_id",
      "generation_id",
      "updated_at"
    ],
    "key": [
      "config_id"
    ],
    "sql": "CREATE TABLE overview_snapshot_pointer (\n  config_id TEXT PRIMARY KEY,\n  generation_id TEXT NOT NULL,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n)"
  },
  {
    "name": "post_close_daily_bar_refresh_job_items",
    "columns": [
      "job_id",
      "ordinal",
      "ticker",
      "history_required",
      "status",
      "attempt_count",
      "next_attempt_at",
      "lease_expires_at",
      "lease_token",
      "last_error",
      "bar_date",
      "updated_at"
    ],
    "key": [
      "job_id",
      "ticker"
    ],
    "sql": "CREATE TABLE post_close_daily_bar_refresh_job_items (\n  job_id TEXT NOT NULL,\n  ordinal INTEGER NOT NULL,\n  ticker TEXT NOT NULL,\n  history_required INTEGER NOT NULL DEFAULT 0,\n  status TEXT NOT NULL DEFAULT 'queued',\n  attempt_count INTEGER NOT NULL DEFAULT 0,\n  next_attempt_at TEXT,\n  lease_expires_at TEXT,\n  lease_token TEXT,\n  last_error TEXT,\n  bar_date TEXT,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (job_id, ticker)\n) STRICT, WITHOUT ROWID"
  },
  {
    "name": "post_close_daily_bar_refresh_jobs",
    "columns": [
      "id",
      "trading_date",
      "scope",
      "status",
      "started_at",
      "updated_at",
      "completed_at",
      "error",
      "total_tickers",
      "processed_tickers",
      "cursor_offset",
      "fetched_rows",
      "written_rows",
      "current_date_tickers",
      "missing_current_date_tickers",
      "current_date_coverage_pct",
      "attempt_count",
      "next_attempt_at",
      "error_code",
      "lease_expires_at",
      "source_provider",
      "source_feed",
      "adjustment",
      "request_end"
    ],
    "key": [
      "id"
    ],
    "sql": "CREATE TABLE post_close_daily_bar_refresh_jobs (\n  id TEXT PRIMARY KEY,\n  trading_date TEXT NOT NULL,\n  scope TEXT NOT NULL,\n  status TEXT NOT NULL,\n  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  completed_at TEXT,\n  error TEXT,\n  total_tickers INTEGER NOT NULL DEFAULT 0,\n  processed_tickers INTEGER NOT NULL DEFAULT 0,\n  cursor_offset INTEGER NOT NULL DEFAULT 0,\n  fetched_rows INTEGER NOT NULL DEFAULT 0,\n  written_rows INTEGER NOT NULL DEFAULT 0,\n  current_date_tickers INTEGER NOT NULL DEFAULT 0,\n  missing_current_date_tickers INTEGER NOT NULL DEFAULT 0,\n  current_date_coverage_pct REAL NOT NULL DEFAULT 0,\n  attempt_count INTEGER NOT NULL DEFAULT 0,\n  next_attempt_at TEXT,\n  error_code TEXT,\n  lease_expires_at TEXT, source_provider TEXT NOT NULL DEFAULT 'alpaca', source_feed TEXT NOT NULL DEFAULT 'iex', adjustment TEXT NOT NULL DEFAULT 'split', request_end TEXT,\n  UNIQUE (scope, trading_date)\n) STRICT"
  },
  {
    "name": "snapshot_rows",
    "columns": [
      "snapshot_id",
      "section_id",
      "group_id",
      "ticker",
      "display_name",
      "price",
      "change_1d",
      "change_1w",
      "change_5d",
      "change_3m",
      "change_6m",
      "change_21d",
      "ytd",
      "pct_from_52w_high",
      "sparkline_json",
      "rank_key",
      "holdings_json",
      "bar_date",
      "quote_price",
      "quote_prev_close",
      "quote_change_1d",
      "quote_source",
      "quote_fetched_at",
      "quote_freshness_status",
      "quote_freshness_reason",
      "bar_freshness_status",
      "bar_freshness_reason",
      "history_series_through_date",
      "history_series_status",
      "history_series_source",
      "history_series_reason",
      "above_20_sma",
      "above_50_sma",
      "above_200_sma",
      "relative_strength_30d_vs_spy_json"
    ],
    "key": [
      "snapshot_id",
      "group_id",
      "ticker"
    ],
    "sql": "CREATE TABLE snapshot_rows (\n  snapshot_id TEXT NOT NULL,\n  section_id TEXT NOT NULL,\n  group_id TEXT NOT NULL,\n  ticker TEXT NOT NULL,\n  display_name TEXT,\n  price REAL,\n  change_1d REAL,\n  change_1w REAL,\n  change_5d REAL,\n  change_3m REAL,\n  change_6m REAL,\n  change_21d REAL,\n  ytd REAL,\n  pct_from_52w_high REAL,\n  sparkline_json TEXT,\n  rank_key REAL,\n  holdings_json TEXT,\n  bar_date TEXT,\n  quote_price REAL,\n  quote_prev_close REAL,\n  quote_change_1d REAL,\n  quote_source TEXT,\n  quote_fetched_at TEXT,\n  quote_freshness_status TEXT,\n  quote_freshness_reason TEXT,\n  bar_freshness_status TEXT,\n  bar_freshness_reason TEXT,\n  history_series_through_date TEXT,\n  history_series_status TEXT,\n  history_series_source TEXT,\n  history_series_reason TEXT,\n  above_20_sma INTEGER,\n  above_50_sma INTEGER,\n  above_200_sma INTEGER,\n  relative_strength_30d_vs_spy_json TEXT,\n  PRIMARY KEY (snapshot_id, group_id, ticker)\n)"
  },
  {
    "name": "snapshots_meta",
    "columns": [
      "id",
      "config_id",
      "as_of_date",
      "generated_at",
      "provider_label",
      "expected_as_of_date",
      "freshness_status",
      "freshness_current_count",
      "freshness_eligible_count",
      "freshness_coverage_pct",
      "freshness_critical_missing_json",
      "freshness_min_bar_date",
      "freshness_max_bar_date",
      "freshness_warning",
      "quote_overlay_requested_count",
      "quote_overlay_returned_count",
      "quote_overlay_error",
      "quote_overlay_missing_sample_json"
    ],
    "key": [
      "id"
    ],
    "sql": "CREATE TABLE snapshots_meta (\n  id TEXT PRIMARY KEY,\n  config_id TEXT NOT NULL,\n  as_of_date TEXT NOT NULL,\n  generated_at TEXT NOT NULL,\n  provider_label TEXT NOT NULL,\n  expected_as_of_date TEXT,\n  freshness_status TEXT NOT NULL DEFAULT 'stale',\n  freshness_current_count INTEGER NOT NULL DEFAULT 0,\n  freshness_eligible_count INTEGER NOT NULL DEFAULT 0,\n  freshness_coverage_pct REAL NOT NULL DEFAULT 0,\n  freshness_critical_missing_json TEXT NOT NULL DEFAULT '[]',\n  freshness_min_bar_date TEXT,\n  freshness_max_bar_date TEXT,\n  freshness_warning TEXT,\n  quote_overlay_requested_count INTEGER,\n  quote_overlay_returned_count INTEGER,\n  quote_overlay_error TEXT,\n  quote_overlay_missing_sample_json TEXT,\n  UNIQUE(config_id, as_of_date)\n)"
  },
  {
    "name": "universe_symbols",
    "columns": [
      "universe_id",
      "ticker"
    ],
    "key": [
      "universe_id",
      "ticker"
    ],
    "sql": "CREATE TABLE universe_symbols (\n  universe_id TEXT NOT NULL,\n  ticker TEXT NOT NULL,\n  PRIMARY KEY (universe_id, ticker)\n)"
  },
  {
    "name": "universe_version_members",
    "columns": [
      "version_id",
      "ticker",
      "source_ticker",
      "issuer_name",
      "exchange",
      "asset_class"
    ],
    "key": [
      "version_id",
      "ticker"
    ],
    "sql": "CREATE TABLE universe_version_members (\n  version_id TEXT NOT NULL,\n  ticker TEXT NOT NULL,\n  source_ticker TEXT,\n  issuer_name TEXT,\n  exchange TEXT,\n  asset_class TEXT,\n  PRIMARY KEY (version_id, ticker)\n)"
  },
  {
    "name": "universe_versions",
    "columns": [
      "id",
      "universe_id",
      "source",
      "source_type",
      "source_url",
      "source_as_of_date",
      "status",
      "member_count",
      "source_member_count",
      "normalized_member_count",
      "resolved_member_count",
      "unresolved_count",
      "unresolved_symbols_json",
      "membership_hash",
      "previous_member_count",
      "change_pct",
      "validation_error",
      "created_at",
      "promoted_at"
    ],
    "key": [
      "id"
    ],
    "sql": "CREATE TABLE universe_versions (\n  id TEXT PRIMARY KEY,\n  universe_id TEXT NOT NULL,\n  source TEXT NOT NULL,\n  source_type TEXT,\n  source_url TEXT,\n  source_as_of_date TEXT,\n  status TEXT NOT NULL,\n  member_count INTEGER NOT NULL DEFAULT 0,\n  source_member_count INTEGER,\n  normalized_member_count INTEGER,\n  resolved_member_count INTEGER,\n  unresolved_count INTEGER,\n  unresolved_symbols_json TEXT,\n  membership_hash TEXT,\n  previous_member_count INTEGER,\n  change_pct REAL,\n  validation_error TEXT,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  promoted_at TEXT\n)"
  },
  {
    "name": "universes",
    "columns": [
      "id",
      "name",
      "active_version_id"
    ],
    "key": [
      "id"
    ],
    "sql": "CREATE TABLE universes (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  active_version_id TEXT\n)"
  }
] as const;
export const STORAGE_INDEXES = [
  {
    "type": "index",
    "name": "idx_bar_coverage_status_end",
    "tbl_name": "bar_coverage",
    "sql": "CREATE INDEX idx_bar_coverage_status_end\n  ON bar_coverage (status, observed_end)"
  },
  {
    "type": "index",
    "name": "idx_daily_market_features_recompute",
    "tbl_name": "daily_market_features",
    "sql": "CREATE INDEX idx_daily_market_features_recompute\n  ON daily_market_features (feed, session_date, computed_at)"
  },
  {
    "type": "index",
    "name": "idx_daily_market_features_session",
    "tbl_name": "daily_market_features",
    "sql": "CREATE INDEX idx_daily_market_features_session\n  ON daily_market_features (feed, session_date, ticker)"
  },
  {
    "type": "index",
    "name": "idx_eod_publications_history",
    "tbl_name": "eod_publications",
    "sql": "CREATE INDEX idx_eod_publications_history\n  ON eod_publications(scope, status, session_date DESC, revision DESC)"
  },
  {
    "type": "index",
    "name": "idx_market_breadth_generations_latest",
    "tbl_name": "breadth_generations",
    "sql": "CREATE INDEX idx_market_breadth_generations_latest\n  ON breadth_generations (status, as_of_date DESC, generated_at DESC)"
  },
  {
    "type": "index",
    "name": "idx_market_breadth_latest",
    "tbl_name": "breadth_snapshots",
    "sql": "CREATE INDEX idx_market_breadth_latest\n  ON breadth_snapshots (universe_id, as_of_date DESC, generated_at DESC)"
  },
  {
    "type": "index",
    "name": "idx_market_data_readiness_status",
    "tbl_name": "data_readiness",
    "sql": "CREATE INDEX idx_market_data_readiness_status\n  ON data_readiness (domain, status, updated_at DESC)"
  },
  {
    "type": "index",
    "name": "idx_market_overview_generations_status",
    "tbl_name": "overview_generations",
    "sql": "CREATE INDEX idx_market_overview_generations_status\n  ON overview_generations (config_id, status, generated_at DESC)"
  },
  {
    "type": "index",
    "name": "idx_market_snapshot_rows_snapshot",
    "tbl_name": "snapshot_rows",
    "sql": "CREATE INDEX idx_market_snapshot_rows_snapshot\n  ON snapshot_rows (snapshot_id, rank_key DESC)"
  },
  {
    "type": "index",
    "name": "idx_market_snapshots_meta_latest",
    "tbl_name": "snapshots_meta",
    "sql": "CREATE INDEX idx_market_snapshots_meta_latest\n  ON snapshots_meta (config_id, as_of_date DESC, generated_at DESC)"
  },
  {
    "type": "index",
    "name": "idx_market_universe_symbols_ticker",
    "tbl_name": "universe_symbols",
    "sql": "CREATE INDEX idx_market_universe_symbols_ticker\n  ON universe_symbols (ticker, universe_id)"
  },
  {
    "type": "index",
    "name": "idx_market_universe_version_members_ticker",
    "tbl_name": "universe_version_members",
    "sql": "CREATE INDEX idx_market_universe_version_members_ticker\n  ON universe_version_members (ticker, version_id)"
  },
  {
    "type": "index",
    "name": "idx_market_universe_versions_hash",
    "tbl_name": "universe_versions",
    "sql": "CREATE INDEX idx_market_universe_versions_hash\n  ON universe_versions (universe_id, membership_hash, created_at DESC)"
  },
  {
    "type": "index",
    "name": "idx_market_universe_versions_status",
    "tbl_name": "universe_versions",
    "sql": "CREATE INDEX idx_market_universe_versions_status\n  ON universe_versions (universe_id, status, created_at DESC)"
  },
  {
    "type": "index",
    "name": "idx_overview_current_data_session_status",
    "tbl_name": "overview_current_data",
    "sql": "CREATE INDEX idx_overview_current_data_session_status\n  ON overview_current_data (config_id, session_date, status)"
  },
  {
    "type": "index",
    "name": "idx_overview_current_refresh_jobs_due",
    "tbl_name": "overview_current_refresh_jobs",
    "sql": "CREATE INDEX idx_overview_current_refresh_jobs_due\n  ON overview_current_refresh_jobs (status, next_attempt_at, lease_expires_at, updated_at)"
  },
  {
    "type": "index",
    "name": "idx_post_close_bar_items_due",
    "tbl_name": "post_close_daily_bar_refresh_job_items",
    "sql": "CREATE INDEX idx_post_close_bar_items_due\n  ON post_close_daily_bar_refresh_job_items (job_id, status, next_attempt_at, ordinal)"
  },
  {
    "type": "index",
    "name": "idx_post_close_daily_bar_refresh_jobs_date_source",
    "tbl_name": "post_close_daily_bar_refresh_jobs",
    "sql": "CREATE INDEX idx_post_close_daily_bar_refresh_jobs_date_source\n  ON post_close_daily_bar_refresh_jobs (trading_date, source_provider, source_feed, adjustment, updated_at DESC)"
  },
  {
    "type": "index",
    "name": "idx_post_close_daily_bar_refresh_jobs_scope_date",
    "tbl_name": "post_close_daily_bar_refresh_jobs",
    "sql": "CREATE INDEX idx_post_close_daily_bar_refresh_jobs_scope_date\n  ON post_close_daily_bar_refresh_jobs (scope, trading_date DESC)"
  },
  {
    "type": "index",
    "name": "idx_post_close_daily_bar_refresh_jobs_status_updated",
    "tbl_name": "post_close_daily_bar_refresh_jobs",
    "sql": "CREATE INDEX idx_post_close_daily_bar_refresh_jobs_status_updated\n  ON post_close_daily_bar_refresh_jobs (status, updated_at DESC)"
  }
] as const;
export const STORAGE_TRIGGERS = [
  {
    "type": "trigger",
    "name": "eod_bar_delete",
    "tbl_name": "alpaca_daily_bars",
    "sql": "CREATE TRIGGER eod_bar_delete AFTER DELETE ON alpaca_daily_bars\nWHEN NOT EXISTS (SELECT 1 FROM eod_history_relocations relocation\n  WHERE relocation.feed=OLD.feed AND relocation.ticker=OLD.ticker AND relocation.date=OLD.date\n    AND relocation.bar_identity IS json_array(OLD.o,OLD.h,OLD.l,OLD.c,OLD.volume,OLD.reported_volume,\n      OLD.reported_volume_collected_at,OLD.source_provider,OLD.adjustment,OLD.observed_at,OLD.fetched_at)) BEGIN\n  INSERT INTO eod_input_revisions(feed,ticker,semantic_revision,last_correction_revision,append_high_water_date)\n  VALUES(OLD.feed,OLD.ticker,1,1,MAX(OLD.date,COALESCE(\n    (SELECT date FROM alpaca_daily_bars WHERE feed=OLD.feed AND ticker=OLD.ticker ORDER BY date DESC LIMIT 1),OLD.date)))\n  ON CONFLICT(feed,ticker) DO UPDATE SET revision=revision+1,semantic_revision=revision+1,\n    last_correction_revision=revision+1,append_epoch_start_revision=NULL,append_epoch_start_date=NULL,\n    append_high_water_date=MAX(COALESCE(append_high_water_date,excluded.append_high_water_date),excluded.append_high_water_date),updated_at=CURRENT_TIMESTAMP;\nEND"
  },
  {
    "type": "trigger",
    "name": "eod_bar_insert",
    "tbl_name": "alpaca_daily_bars",
    "sql": "CREATE TRIGGER eod_bar_insert AFTER INSERT ON alpaca_daily_bars BEGIN\n  INSERT INTO eod_input_revisions(feed,ticker,semantic_revision,last_correction_revision,\n    append_high_water_date,append_epoch_start_revision,append_epoch_start_date)\n  SELECT NEW.feed,NEW.ticker,1,\n    CASE WHEN high_water>NEW.date THEN 1 ELSE 0 END ,high_water,\n    CASE WHEN high_water>NEW.date THEN NULL ELSE 1 END ,\n    CASE WHEN high_water>NEW.date THEN NULL ELSE NEW.date END\n  FROM (SELECT date AS high_water FROM alpaca_daily_bars\n    WHERE feed=NEW.feed AND ticker=NEW.ticker ORDER BY date DESC LIMIT 1) WHERE 1\n  ON CONFLICT(feed,ticker) DO UPDATE SET\n    revision=revision+1,semantic_revision=revision+1,updated_at=CURRENT_TIMESTAMP,\n    last_correction_revision= CASE WHEN semantic_revision<>revision OR append_high_water_date IS NULL\n      OR NEW.date<=append_high_water_date THEN revision+1 ELSE last_correction_revision END ,\n    append_epoch_start_revision= CASE WHEN semantic_revision<>revision OR append_high_water_date IS NULL\n      OR NEW.date<=append_high_water_date THEN NULL ELSE COALESCE(append_epoch_start_revision,revision+1) END ,\n    append_epoch_start_date= CASE WHEN semantic_revision<>revision OR append_high_water_date IS NULL\n      OR NEW.date<=append_high_water_date THEN NULL ELSE COALESCE(append_epoch_start_date,NEW.date) END ,\n    append_high_water_date=MAX(COALESCE(append_high_water_date,excluded.append_high_water_date),excluded.append_high_water_date);\nEND"
  },
  {
    "type": "trigger",
    "name": "eod_bar_update",
    "tbl_name": "alpaca_daily_bars",
    "sql": "CREATE TRIGGER eod_bar_update AFTER UPDATE ON alpaca_daily_bars\nWHEN OLD.feed IS NOT NEW.feed OR OLD.ticker IS NOT NEW.ticker OR OLD.date IS NOT NEW.date\n  OR OLD.o IS NOT NEW.o OR OLD.h IS NOT NEW.h OR OLD.l IS NOT NEW.l\n  OR OLD.c IS NOT NEW.c OR OLD.volume IS NOT NEW.volume\n  OR OLD.reported_volume IS NOT NEW.reported_volume\n  OR OLD.adjustment IS NOT NEW.adjustment OR OLD.source_provider IS NOT NEW.source_provider\nBEGIN\n  INSERT INTO eod_input_revisions(feed,ticker,semantic_revision,last_correction_revision,append_high_water_date)\n  VALUES(NEW.feed,NEW.ticker,1,1,\n    (SELECT date FROM alpaca_daily_bars WHERE feed=NEW.feed AND ticker=NEW.ticker ORDER BY date DESC LIMIT 1))\n  ON CONFLICT(feed,ticker) DO UPDATE SET revision=revision+1,semantic_revision=revision+1,\n    last_correction_revision=revision+1,append_epoch_start_revision=NULL,append_epoch_start_date=NULL,\n    append_high_water_date=MAX(COALESCE(append_high_water_date,excluded.append_high_water_date),excluded.append_high_water_date),updated_at=CURRENT_TIMESTAMP;\n  -- Moving a bar also invalidates the security that lost it. A date-only move\n  -- belongs to the same security and is already covered by the increment above.\n  INSERT INTO eod_input_revisions(feed,ticker,semantic_revision,last_correction_revision,append_high_water_date)\n  SELECT OLD.feed,OLD.ticker,1,1,MAX(OLD.date,COALESCE(\n    (SELECT date FROM alpaca_daily_bars WHERE feed=OLD.feed AND ticker=OLD.ticker ORDER BY date DESC LIMIT 1),OLD.date))\n  WHERE OLD.feed IS NOT NEW.feed OR OLD.ticker IS NOT NEW.ticker\n  ON CONFLICT(feed,ticker) DO UPDATE SET revision=revision+1,semantic_revision=revision+1,\n    last_correction_revision=revision+1,append_epoch_start_revision=NULL,append_epoch_start_date=NULL,\n    append_high_water_date=MAX(COALESCE(append_high_water_date,excluded.append_high_water_date),excluded.append_high_water_date),updated_at=CURRENT_TIMESTAMP;\nEND"
  },
  {
    "type": "trigger",
    "name": "eod_revision_clock_delete",
    "tbl_name": "eod_input_revisions",
    "sql": "CREATE TRIGGER eod_revision_clock_delete AFTER DELETE ON eod_input_revisions\nWHEN OLD.feed IN ('sip','yahoo-eod') BEGIN\n  UPDATE eod_input_clock SET revision=revision+1 WHERE id='default';\nEND"
  },
  {
    "type": "trigger",
    "name": "eod_revision_clock_insert",
    "tbl_name": "eod_input_revisions",
    "sql": "CREATE TRIGGER eod_revision_clock_insert AFTER INSERT ON eod_input_revisions\nWHEN NEW.feed IN ('sip','yahoo-eod') BEGIN\n  UPDATE eod_input_clock SET revision=revision+1 WHERE id='default';\nEND"
  },
  {
    "type": "trigger",
    "name": "eod_revision_clock_update",
    "tbl_name": "eod_input_revisions",
    "sql": "CREATE TRIGGER eod_revision_clock_update AFTER UPDATE ON eod_input_revisions\nWHEN (OLD.feed IN ('sip','yahoo-eod') OR NEW.feed IN ('sip','yahoo-eod'))\n  AND (OLD.revision IS NOT NEW.revision OR OLD.feed IS NOT NEW.feed OR OLD.ticker IS NOT NEW.ticker) BEGIN\n  UPDATE eod_input_clock SET revision=revision+1 WHERE id='default';\nEND"
  }
] as const;
