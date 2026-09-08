-- Immutable, verified blocks. A pointer moves only after payload read-back verification.
CREATE TABLE IF NOT EXISTS market_history_blocks (
  id TEXT PRIMARY KEY,
  feed TEXT NOT NULL,
  ticker TEXT NOT NULL,
  calendar_year INTEGER NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  codec TEXT NOT NULL CHECK (codec = 'gzip-json-v1'),
  checksum TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  first_date TEXT NOT NULL,
  last_date TEXT NOT NULL,
  uncompressed_bytes INTEGER NOT NULL CHECK (uncompressed_bytes > 0),
  payload_base64 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  verified_at TEXT
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_market_history_blocks_security_year
  ON market_history_blocks (feed, ticker, calendar_year);

CREATE TABLE IF NOT EXISTS market_history_block_pointers (
  feed TEXT NOT NULL,
  ticker TEXT NOT NULL,
  calendar_year INTEGER NOT NULL,
  block_id TEXT NOT NULL REFERENCES market_history_blocks(id),
  previous_block_id TEXT REFERENCES market_history_blocks(id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (feed, ticker, calendar_year)
) STRICT, WITHOUT ROWID;
