CREATE TABLE breadth_snapshots_nullable_metrics (
  id TEXT PRIMARY KEY,
  as_of_date TEXT NOT NULL,
  universe_id TEXT NOT NULL,
  advancers INTEGER NOT NULL,
  decliners INTEGER NOT NULL,
  unchanged INTEGER NOT NULL,
  pct_above_20ma REAL,
  pct_above_50ma REAL,
  pct_above_200ma REAL,
  new_20d_highs INTEGER,
  new_20d_lows INTEGER,
  median_return_1d REAL NOT NULL,
  median_return_5d REAL,
  sentiment_json TEXT,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(as_of_date, universe_id)
);

INSERT INTO breadth_snapshots_nullable_metrics (
  id,
  as_of_date,
  universe_id,
  advancers,
  decliners,
  unchanged,
  pct_above_20ma,
  pct_above_50ma,
  pct_above_200ma,
  new_20d_highs,
  new_20d_lows,
  median_return_1d,
  median_return_5d,
  sentiment_json,
  generated_at
)
SELECT
  id,
  as_of_date,
  universe_id,
  advancers,
  decliners,
  unchanged,
  pct_above_20ma,
  pct_above_50ma,
  pct_above_200ma,
  new_20d_highs,
  new_20d_lows,
  median_return_1d,
  median_return_5d,
  sentiment_json,
  generated_at
FROM breadth_snapshots;

DROP TABLE breadth_snapshots;
ALTER TABLE breadth_snapshots_nullable_metrics RENAME TO breadth_snapshots;

CREATE INDEX IF NOT EXISTS idx_breadth_snapshots_universe_latest
  ON breadth_snapshots(universe_id, as_of_date DESC, generated_at DESC);
