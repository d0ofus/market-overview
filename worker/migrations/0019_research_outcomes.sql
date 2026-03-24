CREATE TABLE IF NOT EXISTS research_outcomes (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  return_pct REAL,
  max_upside_pct REAL,
  max_drawdown_pct REAL,
  benchmark_return_pct REAL,
  outcome_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (snapshot_id) REFERENCES research_snapshots(id)
);

CREATE INDEX IF NOT EXISTS idx_research_outcomes_snapshot_horizon
  ON research_outcomes(snapshot_id, horizon_days);

CREATE INDEX IF NOT EXISTS idx_research_outcomes_ticker_created_desc
  ON research_outcomes(ticker, created_at DESC);
