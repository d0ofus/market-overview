CREATE TABLE IF NOT EXISTS option_chain_snapshots (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  watchlist_set_id TEXT,
  watchlist_set_name TEXT,
  watchlist_run_id TEXT,
  ticker TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'ibkr_bridge',
  bridge_status TEXT NOT NULL DEFAULT 'unknown',
  underlying_price REAL,
  underlying_quote_time TEXT,
  options_available INTEGER NOT NULL DEFAULT 0,
  iv_rank_52w REAL,
  iv_percentile_52w REAL,
  data_mode TEXT,
  latest_rth_session_date TEXT,
  contract_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  raw_summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_option_chain_snapshots_ticker_created
  ON option_chain_snapshots (ticker, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_option_chain_snapshots_watchlist_created
  ON option_chain_snapshots (watchlist_set_id, watchlist_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_option_chain_snapshots_expires
  ON option_chain_snapshots (expires_at);

CREATE TABLE IF NOT EXISTS option_contract_quotes (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  watchlist_set_id TEXT,
  watchlist_run_id TEXT,
  ticker TEXT NOT NULL,
  strategy TEXT NOT NULL,
  contract_key TEXT NOT NULL,
  ibkr_con_id INTEGER,
  local_symbol TEXT,
  expiry TEXT,
  strike REAL,
  right TEXT,
  bid REAL,
  ask REAL,
  mid REAL,
  last REAL,
  volume INTEGER,
  open_interest INTEGER,
  iv REAL,
  delta REAL,
  gamma REAL,
  theta REAL,
  vega REAL,
  quote_time TEXT,
  data_mode TEXT,
  rth_session_date TEXT,
  spread_basis TEXT NOT NULL DEFAULT 'unavailable',
  rth_last_bid REAL,
  rth_last_ask REAL,
  rth_median_spread_pct REAL,
  rth_p75_spread_pct REAL,
  rth_max_spread_pct REAL,
  rth_sample_count INTEGER,
  rth_first_sample_time TEXT,
  rth_last_sample_time TEXT,
  score_liquidity REAL,
  score_spread REAL,
  score_iv REAL,
  score_strategy REAL,
  score REAL,
  debit REAL,
  width REAL,
  breakeven REAL,
  max_loss REAL,
  legs_json TEXT NOT NULL DEFAULT '[]',
  score_inputs_json TEXT NOT NULL DEFAULT '{}',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (snapshot_id) REFERENCES option_chain_snapshots(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_option_contract_quotes_snapshot
  ON option_contract_quotes (snapshot_id);

CREATE INDEX IF NOT EXISTS idx_option_contract_quotes_ticker_score
  ON option_contract_quotes (ticker, score DESC);

CREATE INDEX IF NOT EXISTS idx_option_contract_quotes_strategy_score
  ON option_contract_quotes (strategy, score DESC);

CREATE INDEX IF NOT EXISTS idx_option_contract_quotes_watchlist_score
  ON option_contract_quotes (watchlist_set_id, watchlist_run_id, score DESC);

CREATE INDEX IF NOT EXISTS idx_option_contract_quotes_expires
  ON option_contract_quotes (expires_at);
