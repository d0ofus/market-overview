CREATE TABLE IF NOT EXISTS sector_market_leaders (
  ticker TEXT PRIMARY KEY,
  source_peer_group_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticker) REFERENCES symbols(ticker),
  FOREIGN KEY (source_peer_group_id) REFERENCES peer_groups(id)
);

CREATE INDEX IF NOT EXISTS idx_sector_market_leaders_sort
  ON sector_market_leaders(sort_order, created_at, ticker);
