ALTER TABLE symbols ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;

ALTER TABLE symbols ADD COLUMN catalog_managed INTEGER NOT NULL DEFAULT 0;

ALTER TABLE symbols ADD COLUMN listing_source TEXT;

ALTER TABLE symbols ADD COLUMN catalog_last_seen_at TEXT;

ALTER TABLE symbols ADD COLUMN deactivated_at TEXT;

CREATE TABLE IF NOT EXISTS symbol_catalog_sync_status (
  source_key TEXT PRIMARY KEY,
  last_synced_at TEXT,
  status TEXT,
  error TEXT,
  records_count INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_symbols_active_ticker
  ON symbols(is_active, ticker);

CREATE INDEX IF NOT EXISTS idx_symbols_catalog_managed_active
  ON symbols(catalog_managed, is_active, ticker);

CREATE INDEX IF NOT EXISTS idx_symbols_listing_source_active
  ON symbols(listing_source, is_active, ticker);
