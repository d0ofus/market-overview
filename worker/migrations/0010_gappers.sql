CREATE TABLE IF NOT EXISTS gappers_snapshots (
  id TEXT PRIMARY KEY,
  market_session TEXT NOT NULL,
  provider_label TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_gappers_snapshots_generated_desc
  ON gappers_snapshots(generated_at DESC);

CREATE TABLE IF NOT EXISTS gappers_rows (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  name TEXT,
  sector TEXT,
  industry TEXT,
  market_cap REAL,
  price REAL,
  prev_close REAL,
  premarket_price REAL,
  gap_pct REAL,
  premarket_volume REAL,
  news_json TEXT NOT NULL,
  analysis_json TEXT,
  composite_score REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(snapshot_id, ticker),
  FOREIGN KEY (snapshot_id) REFERENCES gappers_snapshots(id)
);

CREATE INDEX IF NOT EXISTS idx_gappers_rows_snapshot_gap_desc
  ON gappers_rows(snapshot_id, gap_pct DESC);

CREATE INDEX IF NOT EXISTS idx_gappers_rows_ticker_created_desc
  ON gappers_rows(ticker, created_at DESC);
