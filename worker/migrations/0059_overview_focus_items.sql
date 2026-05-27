CREATE TABLE IF NOT EXISTS overview_focus_items (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL DEFAULT 'default',
  text TEXT NOT NULL,
  text_normalized TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_overview_focus_items_active_unique
  ON overview_focus_items(config_id, text_normalized)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_overview_focus_items_active_order
  ON overview_focus_items(config_id, deleted_at, sort_order, created_at);

CREATE INDEX IF NOT EXISTS idx_overview_focus_items_history
  ON overview_focus_items(config_id, text_normalized, updated_at DESC);
