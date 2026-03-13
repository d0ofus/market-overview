CREATE TABLE IF NOT EXISTS tv_watchlist_sets (
  id TEXT PRIMARY KEY,
  scan_definition_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  compile_daily INTEGER NOT NULL DEFAULT 0,
  daily_compile_time_local TEXT,
  daily_compile_timezone TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scan_definition_id) REFERENCES scan_definitions(id)
);

CREATE TABLE IF NOT EXISTS tv_watchlist_sources (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(set_id, source_url),
  FOREIGN KEY (set_id) REFERENCES tv_watchlist_sets(id)
);

CREATE INDEX IF NOT EXISTS idx_tv_watchlist_sets_active
  ON tv_watchlist_sets(is_active, compile_daily, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tv_watchlist_sets_scan_definition
  ON tv_watchlist_sets(scan_definition_id);

CREATE INDEX IF NOT EXISTS idx_tv_watchlist_sources_set_sort
  ON tv_watchlist_sources(set_id, sort_order ASC, created_at ASC);
