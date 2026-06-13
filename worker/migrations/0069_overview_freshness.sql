ALTER TABLE snapshots_meta ADD COLUMN expected_as_of_date TEXT;
ALTER TABLE snapshots_meta ADD COLUMN freshness_status TEXT NOT NULL DEFAULT 'stale';
ALTER TABLE snapshots_meta ADD COLUMN freshness_current_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE snapshots_meta ADD COLUMN freshness_eligible_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE snapshots_meta ADD COLUMN freshness_coverage_pct REAL NOT NULL DEFAULT 0;
ALTER TABLE snapshots_meta ADD COLUMN freshness_critical_missing_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE snapshots_meta ADD COLUMN freshness_min_bar_date TEXT;
ALTER TABLE snapshots_meta ADD COLUMN freshness_max_bar_date TEXT;
ALTER TABLE snapshots_meta ADD COLUMN freshness_warning TEXT;

ALTER TABLE snapshot_rows ADD COLUMN bar_date TEXT;

UPDATE market_commentary_settings
SET brave_queries_json = '["US stock market today S&P 500 Nasdaq Dow Russell sector performance {latestCompletedSessionDate} Reuters CNBC MarketWatch","US economic calendar Fed speakers Treasury auctions CPI PPI PCE GDP jobs ISM {latestCompletedSessionDate}","CBOE VIX put call ratio market volatility today {latestCompletedSessionDate}","US stocks earnings catalysts mega cap tech semiconductors banks energy today {latestCompletedSessionDate}"]',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'default'
  AND brave_queries_json = '["US stock market today S&P 500 Nasdaq Dow Russell sector performance {nyDate} Reuters CNBC MarketWatch","US economic calendar today Fed speakers Treasury auctions CPI PPI PCE GDP jobs ISM {nyDate}","CBOE VIX put call ratio market volatility today {nyDate}","US stocks earnings catalysts mega cap tech semiconductors banks energy today {nyDate}"]';
