CREATE TABLE IF NOT EXISTS pattern_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  benchmark_tickers_json TEXT NOT NULL DEFAULT '["SPY"]',
  prefilter_config_json TEXT NOT NULL DEFAULT '{}',
  active_model_id TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pattern_labels (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  setup_date TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('approved', 'rejected', 'skipped')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  source TEXT NOT NULL DEFAULT 'manual',
  context_window_bars INTEGER NOT NULL DEFAULT 260,
  pattern_window_bars INTEGER NOT NULL DEFAULT 40,
  tags_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  feature_version TEXT NOT NULL,
  feature_json TEXT NOT NULL DEFAULT '{}',
  shape_json TEXT NOT NULL DEFAULT '{}',
  window_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pattern_labels_profile_status_label
  ON pattern_labels(profile_id, status, label, setup_date DESC);

CREATE INDEX IF NOT EXISTS idx_pattern_labels_ticker_date
  ON pattern_labels(ticker, setup_date DESC);

CREATE TABLE IF NOT EXISTS pattern_model_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  model_type TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  model_json TEXT NOT NULL DEFAULT '{}',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  feature_summary_json TEXT NOT NULL DEFAULT '{}',
  approved_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pattern_model_versions_profile_active
  ON pattern_model_versions(profile_id, active, created_at DESC);

CREATE TABLE IF NOT EXISTS pattern_runs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  trading_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  phase TEXT NOT NULL DEFAULT 'queued',
  total_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  cursor_offset INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  error TEXT,
  warning TEXT,
  UNIQUE(profile_id, trading_date)
);

CREATE INDEX IF NOT EXISTS idx_pattern_runs_profile_date
  ON pattern_runs(profile_id, trading_date DESC);

CREATE INDEX IF NOT EXISTS idx_pattern_runs_status_updated
  ON pattern_runs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS pattern_run_candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '{}',
  nearest_approved_json TEXT NOT NULL DEFAULT '[]',
  nearest_rejected_json TEXT NOT NULL DEFAULT '[]',
  feature_json TEXT NOT NULL DEFAULT '{}',
  shape_json TEXT NOT NULL DEFAULT '{}',
  source_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_pattern_run_candidates_run_score
  ON pattern_run_candidates(run_id, score DESC, ticker ASC);

CREATE INDEX IF NOT EXISTS idx_pattern_run_candidates_profile_ticker
  ON pattern_run_candidates(profile_id, ticker);

CREATE TABLE IF NOT EXISTS pattern_scores_latest (
  profile_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  trading_date TEXT NOT NULL,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '{}',
  nearest_approved_json TEXT NOT NULL DEFAULT '[]',
  nearest_rejected_json TEXT NOT NULL DEFAULT '[]',
  feature_json TEXT NOT NULL DEFAULT '{}',
  shape_json TEXT NOT NULL DEFAULT '{}',
  source_metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_pattern_scores_latest_profile_score
  ON pattern_scores_latest(profile_id, score DESC, ticker ASC);

CREATE TABLE IF NOT EXISTS pattern_feature_registry (
  feature_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('scalar', 'shape')),
  value_type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  version TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS pattern_review_events (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  run_id TEXT,
  candidate_id TEXT,
  label_id TEXT,
  ticker TEXT,
  setup_date TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pattern_review_events_profile_created
  ON pattern_review_events(profile_id, created_at DESC);

INSERT OR IGNORE INTO pattern_profiles (
  id,
  name,
  description,
  benchmark_tickers_json,
  prefilter_config_json,
  settings_json
) VALUES (
  'default',
  'Default',
  'Default pattern-learning profile.',
  '["SPY"]',
  '{"minPrice":3,"minDollarVolume20d":5000000,"minBars":260}',
  '{"contextWindowBars":260,"patternWindowBars":40,"candidateLimit":100}'
);

INSERT OR IGNORE INTO pattern_feature_registry (feature_key, display_name, family, value_type, enabled, version, description) VALUES
('range_10d_pct', '10D Range %', 'scalar', 'number', 1, 'v1', 'High-low range over the last 10 bars as a percent of close.'),
('range_20d_pct', '20D Range %', 'scalar', 'number', 1, 'v1', 'High-low range over the last 20 bars as a percent of close.'),
('atr_10', 'ATR 10', 'scalar', 'number', 1, 'v1', 'Average true range over 10 bars.'),
('atr_50', 'ATR 50', 'scalar', 'number', 1, 'v1', 'Average true range over 50 bars.'),
('atr_contraction_ratio', 'ATR Contraction', 'scalar', 'number', 1, 'v1', 'ATR 10 divided by ATR 50.'),
('volume_dryup_ratio', 'Volume Dry-Up', 'scalar', 'number', 1, 'v1', 'Recent average volume divided by longer average volume.'),
('close_vs_20sma_pct', 'Close vs 20SMA %', 'scalar', 'number', 1, 'v1', 'Close relative to 20-day simple moving average.'),
('close_vs_50sma_pct', 'Close vs 50SMA %', 'scalar', 'number', 1, 'v1', 'Close relative to 50-day simple moving average.'),
('close_vs_200sma_pct', 'Close vs 200SMA %', 'scalar', 'number', 1, 'v1', 'Close relative to 200-day simple moving average.'),
('distance_from_52w_high_pct', 'Distance From 52W High %', 'scalar', 'number', 1, 'v1', 'Close distance from the 252-bar high.'),
('higher_lows_count', 'Higher Lows Count', 'scalar', 'number', 1, 'v1', 'Count of rising low segments in the pattern window.'),
('rs_line_near_high', 'RS Line Near High', 'scalar', 'number', 1, 'v1', 'Binary relative-strength line near recent highs.'),
('prior_runup_60d_pct', 'Prior 60D Run-Up %', 'scalar', 'number', 1, 'v1', 'Price run-up over the prior 60 bars.'),
('base_depth_pct', 'Base Depth %', 'scalar', 'number', 1, 'v1', 'Pattern-window drawdown from high to low.'),
('base_length_bars', 'Base Length Bars', 'scalar', 'number', 1, 'v1', 'Configured pattern window length.'),
('price_tightness_10d', '10D Price Tightness', 'scalar', 'number', 1, 'v1', 'Average absolute close-to-close change over 10 bars.'),
('up_down_volume_ratio_20d', '20D Up/Down Volume', 'scalar', 'number', 1, 'v1', 'Up-day volume divided by down-day volume over 20 bars.'),
('dollar_volume_20d', '20D Dollar Volume', 'scalar', 'number', 1, 'v1', 'Average dollar volume over 20 bars.'),
('relative_volume_20d', 'Relative Volume 20D', 'scalar', 'number', 1, 'v1', 'Latest volume divided by 20-day average volume.'),
('price_path_20d', '20D Price Path', 'shape', 'number[]', 1, 'v1', 'Normalized close path over 20 bars.'),
('price_path_40d', '40D Price Path', 'shape', 'number[]', 1, 'v1', 'Normalized close path over 40 bars.'),
('price_path_60d', '60D Price Path', 'shape', 'number[]', 1, 'v1', 'Normalized close path over 60 bars.'),
('high_low_range_path_40d', '40D Range Path', 'shape', 'number[]', 1, 'v1', 'High-low range path over 40 bars.'),
('volume_path_40d', '40D Volume Path', 'shape', 'number[]', 1, 'v1', 'Volume path normalized by median.'),
('rolling_atr_path_40d', '40D Rolling ATR Path', 'shape', 'number[]', 1, 'v1', 'Rolling ATR path normalized by median.'),
('relative_strength_path_60d', '60D RS Path', 'shape', 'number[]', 1, 'v1', 'Relative-strength path normalized to start at 1.0.'),
('distance_from_20sma_path_40d', '40D Distance From 20SMA', 'shape', 'number[]', 1, 'v1', 'Distance from 20SMA path.'),
('distance_from_50sma_path_40d', '40D Distance From 50SMA', 'shape', 'number[]', 1, 'v1', 'Distance from 50SMA path.');
