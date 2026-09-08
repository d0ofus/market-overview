-- Official rate facts are cached separately from third-party market probabilities.
CREATE TABLE IF NOT EXISTS official_rate_snapshots (
  source TEXT PRIMARY KEY,
  effective_date TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  last_error TEXT
);

-- All eleven GICS sector proxies must remain present, regardless of ranking.
INSERT OR IGNORE INTO symbols (ticker, name, exchange, asset_class, sector, industry)
VALUES ('XLC', 'Communication Services Select Sector SPDR Fund', 'NYSEARCA', 'etf', 'Communication Services', 'Sector');
INSERT OR IGNORE INTO dashboard_items (id, group_id, sort_order, ticker, display_name, enabled, tags_json, holdings_json)
SELECT 'i-sector-xlc', 'g-sector-etf', 11, 'XLC', NULL, 1, '[]', NULL
WHERE EXISTS (SELECT 1 FROM dashboard_groups WHERE id = 'g-sector-etf')
  AND NOT EXISTS (SELECT 1 FROM dashboard_items WHERE group_id = 'g-sector-etf' AND ticker = 'XLC');
UPDATE dashboard_groups SET pin_top10 = 0 WHERE title IN ('Sector ETFs', 'Sector ETFs (Equal Weight)');
