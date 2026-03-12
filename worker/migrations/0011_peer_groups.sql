ALTER TABLE symbols ADD COLUMN shares_outstanding REAL;

ALTER TABLE symbols ADD COLUMN updated_at TEXT;

CREATE TABLE IF NOT EXISTS peer_groups (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  group_type TEXT NOT NULL CHECK(group_type IN ('fundamental', 'technical', 'custom')),
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ticker_peer_groups (
  ticker TEXT NOT NULL,
  peer_group_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manual', 'fmp_seed', 'finnhub_seed', 'system')),
  confidence REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticker, peer_group_id),
  FOREIGN KEY (ticker) REFERENCES symbols(ticker),
  FOREIGN KEY (peer_group_id) REFERENCES peer_groups(id)
);

CREATE INDEX IF NOT EXISTS idx_symbols_ticker_nocase
  ON symbols(ticker COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_symbols_name_nocase
  ON symbols(name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_peer_groups_name_nocase
  ON peer_groups(name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_peer_groups_type_active_priority
  ON peer_groups(group_type, is_active, priority DESC, name);

CREATE INDEX IF NOT EXISTS idx_ticker_peer_groups_group_ticker
  ON ticker_peer_groups(peer_group_id, ticker);

CREATE INDEX IF NOT EXISTS idx_ticker_peer_groups_ticker_group
  ON ticker_peer_groups(ticker, peer_group_id);
