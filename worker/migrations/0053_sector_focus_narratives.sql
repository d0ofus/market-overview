CREATE TABLE IF NOT EXISTS sector_focus_narratives (
  id TEXT PRIMARY KEY,
  sector_name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sector_focus_narratives_sort
  ON sector_focus_narratives(sort_order, sector_name);
