ALTER TABLE sector_focus_narratives
ADD COLUMN source_narrative_name TEXT;

ALTER TABLE sector_focus_narratives
ADD COLUMN source_peer_group_id TEXT;

ALTER TABLE sector_focus_narratives
ADD COLUMN manual_name TEXT;

CREATE TABLE sector_focus_narrative_symbols (
  focus_narrative_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (focus_narrative_id, ticker),
  FOREIGN KEY (focus_narrative_id) REFERENCES sector_focus_narratives(id) ON DELETE CASCADE,
  FOREIGN KEY (ticker) REFERENCES symbols(ticker)
);

CREATE INDEX idx_sector_focus_narrative_symbols_order
  ON sector_focus_narrative_symbols(focus_narrative_id, sort_order, ticker);

DELETE FROM sector_focus_narratives
WHERE NOT EXISTS (
  SELECT 1
  FROM sector_tracker_entries e
  WHERE TRIM(e.sector_name) = TRIM(sector_focus_narratives.sector_name)
);

UPDATE sector_focus_narratives
SET source_narrative_name = sector_name
WHERE source_narrative_name IS NULL;

INSERT OR IGNORE INTO sector_focus_narrative_symbols (
  focus_narrative_id,
  ticker,
  sort_order
)
SELECT
  f.id,
  UPPER(es.ticker),
  ROW_NUMBER() OVER (
    PARTITION BY f.id
    ORDER BY UPPER(es.ticker)
  ) - 1
FROM sector_focus_narratives f
JOIN sector_tracker_entries e
  ON TRIM(e.sector_name) = TRIM(f.sector_name)
JOIN sector_tracker_entry_symbols es
  ON es.entry_id = e.id;
