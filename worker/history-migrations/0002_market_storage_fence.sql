-- An open singleton only. Reviewed guards are installed by the storage runner
-- before a stable baseline or verification capture; history remains readable.
CREATE TABLE IF NOT EXISTS market_storage_fence (
  id TEXT PRIMARY KEY CHECK(id='default'),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','frozen')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  migration_id TEXT,
  code_revision TEXT,
  schema_hash TEXT,
  snapshot_revision INTEGER,
  frozen_at TEXT,
  released_at TEXT
) STRICT, WITHOUT ROWID;
INSERT INTO market_storage_fence(id) VALUES('default') ON CONFLICT(id) DO NOTHING;
