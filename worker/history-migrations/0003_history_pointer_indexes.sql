-- SQLite checks both child references when an obsolete immutable block is
-- deleted. Index them separately so each check uses its referenced block ID
-- instead of scanning every security/year pointer. Foreign keys stay enabled.
CREATE INDEX IF NOT EXISTS idx_market_history_pointers_block_id
  ON market_history_block_pointers (block_id);

CREATE INDEX IF NOT EXISTS idx_market_history_pointers_previous_block_id
  ON market_history_block_pointers (previous_block_id);
