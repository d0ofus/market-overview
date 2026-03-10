UPDATE dashboard_configs
SET timezone = 'Australia/Melbourne',
    eod_run_time_label = '08:15 AEST (prev US close)',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'default';

INSERT OR IGNORE INTO symbols (ticker, name, exchange, asset_class, sector, industry) VALUES
('AAPL', 'Apple Inc', 'NASDAQ', 'equity', 'Technology', 'Consumer Electronics'),
('AMZN', 'Amazon.com Inc', 'NASDAQ', 'equity', 'Consumer Discretionary', 'Internet Retail'),
('NFLX', 'Netflix Inc', 'NASDAQ', 'equity', 'Communication Services', 'Streaming'),
('META', 'Meta Platforms Inc', 'NASDAQ', 'equity', 'Communication Services', 'Internet Content'),
('GOOGL', 'Alphabet Inc', 'NASDAQ', 'equity', 'Communication Services', 'Internet Content'),
('MSFT', 'Microsoft Corp', 'NASDAQ', 'equity', 'Technology', 'Software');

INSERT OR IGNORE INTO dashboard_groups (id, section_id, sort_order, title, data_type, ranking_window_default, show_sparkline, pin_top10)
VALUES ('g-market-leaders', 'sec-equities', 5, 'Market Leaders (FAANG)', 'equities', '1W', 1, 1);

INSERT OR REPLACE INTO dashboard_columns (group_id, columns_json)
VALUES ('g-market-leaders', '["ticker","name","price","1D","1W","5D","YTD","sparkline"]');

INSERT OR IGNORE INTO dashboard_items (id, group_id, sort_order, ticker, display_name, enabled, tags_json, holdings_json) VALUES
('i37','g-market-leaders',1,'META',NULL,1,'[]',NULL),
('i38','g-market-leaders',2,'AAPL',NULL,1,'[]',NULL),
('i39','g-market-leaders',3,'AMZN',NULL,1,'[]',NULL),
('i40','g-market-leaders',4,'NFLX',NULL,1,'[]',NULL),
('i41','g-market-leaders',5,'GOOGL',NULL,1,'[]',NULL),
('i42','g-market-leaders',6,'MSFT',NULL,1,'[]',NULL);
