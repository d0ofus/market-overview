CREATE TABLE IF NOT EXISTS scan_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  rules_json TEXT NOT NULL,
  sort_field TEXT NOT NULL DEFAULT 'change',
  sort_direction TEXT NOT NULL DEFAULT 'desc',
  row_limit INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_presets_default
  ON scan_presets(is_default)
  WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS scan_snapshots (
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL,
  provider_label TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  row_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  FOREIGN KEY (preset_id) REFERENCES scan_presets(id)
);

CREATE INDEX IF NOT EXISTS idx_scan_snapshots_preset_generated_desc
  ON scan_snapshots(preset_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS scan_rows (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  name TEXT,
  sector TEXT,
  industry TEXT,
  change_1d REAL,
  market_cap REAL,
  price REAL,
  avg_volume REAL,
  price_avg_volume REAL,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (snapshot_id) REFERENCES scan_snapshots(id)
);

CREATE INDEX IF NOT EXISTS idx_scan_rows_snapshot_change_desc
  ON scan_rows(snapshot_id, change_1d DESC, ticker ASC);

INSERT OR IGNORE INTO scan_presets (
  id,
  name,
  is_default,
  is_active,
  rules_json,
  sort_field,
  sort_direction,
  row_limit
) VALUES (
  'scan-preset-top-gainers',
  'Top Gainers',
  1,
  1,
  '[{"id":"rule-close","field":"close","operator":"gt","value":1},{"id":"rule-change","field":"change","operator":"gt","value":3},{"id":"rule-type","field":"type","operator":"in","value":["stock","dr"]},{"id":"rule-exchange","field":"exchange","operator":"in","value":["NASDAQ","NYSE","AMEX"]},{"id":"rule-volume","field":"volume","operator":"gt","value":100000},{"id":"rule-value-traded","field":"Value.Traded","operator":"gt","value":10000000},{"id":"rule-industry-excludes","field":"industry","operator":"not_in","value":["Biotechnology","Pharmaceuticals: generic","Pharmaceuticals: major","Pharmaceuticals: other"]}]',
  'change',
  'desc',
  100
);
