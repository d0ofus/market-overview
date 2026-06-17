CREATE TABLE IF NOT EXISTS fomc_commentary_items (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('press_conference', 'minutes')),
  meeting_date TEXT NOT NULL,
  release_date TEXT,
  source_url TEXT NOT NULL,
  source_title TEXT,
  source_text TEXT,
  source_fetched_at TEXT,
  source_mode TEXT NOT NULL DEFAULT 'official' CHECK (source_mode IN ('official', 'official_plus_brave', 'fallback_context')),
  brave_sources_json TEXT NOT NULL DEFAULT '[]',
  citation_sources_json TEXT NOT NULL DEFAULT '[]',
  summary_markdown TEXT,
  highlights_json TEXT NOT NULL DEFAULT '[]',
  trading_read_through TEXT,
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending_source', 'ready', 'failed')),
  error TEXT,
  generated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fomc_commentary_unique_event
  ON fomc_commentary_items(event_type, meeting_date, source_url);

CREATE INDEX IF NOT EXISTS idx_fomc_commentary_latest
  ON fomc_commentary_items(release_date DESC, meeting_date DESC, updated_at DESC);
