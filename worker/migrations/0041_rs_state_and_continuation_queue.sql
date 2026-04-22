ALTER TABLE scan_refresh_jobs ADD COLUMN full_candidate_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE scan_refresh_jobs ADD COLUMN materialization_candidate_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE scan_refresh_jobs ADD COLUMN already_current_candidate_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE scan_refresh_jobs ADD COLUMN last_advanced_at TEXT;

ALTER TABLE scan_refresh_job_candidates ADD COLUMN materialization_required INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_scan_refresh_job_candidates_job_materialization_cursor
  ON scan_refresh_job_candidates(job_id, materialization_required, cursor_offset ASC);

CREATE TABLE IF NOT EXISTS relative_strength_config_state (
  config_key TEXT NOT NULL,
  ticker TEXT NOT NULL,
  benchmark_ticker TEXT NOT NULL,
  rs_ma_type TEXT NOT NULL,
  rs_ma_length INTEGER NOT NULL,
  new_high_lookback INTEGER NOT NULL,
  state_version INTEGER NOT NULL,
  latest_trading_date TEXT NOT NULL,
  updated_at TEXT,
  price_close REAL,
  change_1d REAL,
  rs_ratio_close REAL,
  rs_ratio_ma REAL,
  rs_above_ma INTEGER NOT NULL DEFAULT 0,
  rs_new_high INTEGER NOT NULL DEFAULT 0,
  rs_new_high_before_price INTEGER NOT NULL DEFAULT 0,
  bull_cross INTEGER NOT NULL DEFAULT 0,
  approx_rs_rating REAL,
  price_close_history_json TEXT,
  benchmark_close_history_json TEXT,
  weighted_score_history_json TEXT,
  rs_new_high_window_json TEXT,
  price_new_high_window_json TEXT,
  sma_window_json TEXT,
  sma_sum REAL,
  ema_value REAL,
  previous_rs_close REAL,
  previous_rs_ma REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (config_key, ticker)
);

CREATE INDEX IF NOT EXISTS idx_relative_strength_config_state_config_date
  ON relative_strength_config_state(config_key, latest_trading_date DESC, ticker);

CREATE TABLE IF NOT EXISTS relative_strength_refresh_queue (
  job_id TEXT NOT NULL PRIMARY KEY,
  source TEXT,
  enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_attempted_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (job_id) REFERENCES scan_refresh_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_relative_strength_refresh_queue_enqueued
  ON relative_strength_refresh_queue(enqueued_at ASC);
