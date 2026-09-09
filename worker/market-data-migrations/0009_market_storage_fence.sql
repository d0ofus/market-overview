-- The OPEN singleton does not pause any writer. Reviewed per-table source-only
-- triggers are installed separately; an explicit operator action freezes it.
-- This migration metadata is not copied from a frozen source to a new target.
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
