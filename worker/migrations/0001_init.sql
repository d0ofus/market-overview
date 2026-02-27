CREATE TABLE IF NOT EXISTS symbols (
  ticker TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  exchange TEXT,
  asset_class TEXT NOT NULL,
  sector TEXT,
  industry TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_bars (
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  o REAL NOT NULL,
  h REAL NOT NULL,
  l REAL NOT NULL,
  c REAL NOT NULL,
  volume REAL,
  PRIMARY KEY (ticker, date),
  FOREIGN KEY (ticker) REFERENCES symbols(ticker)
);

CREATE TABLE IF NOT EXISTS dashboard_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL,
  eod_run_time_label TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dashboard_sections (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  is_collapsible INTEGER NOT NULL DEFAULT 1,
  default_collapsed INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (config_id) REFERENCES dashboard_configs(id)
);

CREATE TABLE IF NOT EXISTS dashboard_groups (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  title TEXT NOT NULL,
  data_type TEXT NOT NULL,
  ranking_window_default TEXT NOT NULL DEFAULT '1W',
  show_sparkline INTEGER NOT NULL DEFAULT 1,
  pin_top10 INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (section_id) REFERENCES dashboard_sections(id)
);

CREATE TABLE IF NOT EXISTS dashboard_items (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  display_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  tags_json TEXT,
  holdings_json TEXT,
  FOREIGN KEY (group_id) REFERENCES dashboard_groups(id)
);

CREATE TABLE IF NOT EXISTS dashboard_columns (
  group_id TEXT PRIMARY KEY,
  columns_json TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES dashboard_groups(id)
);

CREATE TABLE IF NOT EXISTS universes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS universe_symbols (
  universe_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  PRIMARY KEY (universe_id, ticker),
  FOREIGN KEY (universe_id) REFERENCES universes(id),
  FOREIGN KEY (ticker) REFERENCES symbols(ticker)
);

CREATE TABLE IF NOT EXISTS snapshots_meta (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  provider_label TEXT NOT NULL,
  UNIQUE(config_id, as_of_date)
);

CREATE TABLE IF NOT EXISTS snapshot_rows (
  snapshot_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  display_name TEXT,
  price REAL,
  change_1d REAL,
  change_1w REAL,
  change_5d REAL,
  change_21d REAL,
  ytd REAL,
  pct_from_52w_high REAL,
  sparkline_json TEXT,
  rank_key REAL,
  holdings_json TEXT,
  PRIMARY KEY (snapshot_id, group_id, ticker)
);

CREATE TABLE IF NOT EXISTS breadth_snapshots (
  id TEXT PRIMARY KEY,
  as_of_date TEXT NOT NULL,
  universe_id TEXT NOT NULL,
  advancers INTEGER NOT NULL,
  decliners INTEGER NOT NULL,
  unchanged INTEGER NOT NULL,
  pct_above_20ma REAL NOT NULL,
  pct_above_50ma REAL NOT NULL,
  pct_above_200ma REAL NOT NULL,
  new_20d_highs INTEGER NOT NULL,
  new_20d_lows INTEGER NOT NULL,
  median_return_1d REAL NOT NULL,
  median_return_5d REAL NOT NULL,
  sentiment_json TEXT,
  UNIQUE(as_of_date, universe_id)
);

CREATE TABLE IF NOT EXISTS config_audit (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
