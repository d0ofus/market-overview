INSERT OR IGNORE INTO dashboard_configs (id, name, is_default, timezone, eod_run_time_label)
VALUES ('default', 'Default Swing Dashboard', 1, 'America/New_York', '22:15 ET');

INSERT OR IGNORE INTO dashboard_sections (id, config_id, sort_order, title, description, is_collapsible, default_collapsed) VALUES
('sec-macro', 'default', 1, '01 Macro Overview', 'Macro risk regime and cross-asset leadership', 1, 0),
('sec-equities', 'default', 2, '02 Equities Overview', 'ETF and sector leadership', 1, 0),
('sec-breadth', 'default', 3, '03 Market Breadth & Sentiment', 'Internals and participation', 1, 0),
('sec-tools', 'default', 4, '04 Position Sizing Calculator', 'Risk based trade sizing', 1, 0);

INSERT OR IGNORE INTO dashboard_groups (id, section_id, sort_order, title, data_type, ranking_window_default, show_sparkline, pin_top10) VALUES
('g-us-index', 'sec-macro', 1, 'US Index Futures', 'macro', '1W', 1, 1),
('g-vol-dollar', 'sec-macro', 2, 'Volatility & Dollar', 'macro', '1W', 1, 0),
('g-crypto', 'sec-macro', 3, 'Crypto Proxies', 'macro', '1W', 1, 0),
('g-metals-energy', 'sec-macro', 4, 'Metals & Energy', 'macro', '5D', 1, 0),
('g-global', 'sec-macro', 5, 'Global Indices', 'macro', '1W', 1, 0),
('g-major-etf', 'sec-equities', 1, 'Major ETF Stats', 'equities', '1W', 1, 1),
('g-sector-etf', 'sec-equities', 2, 'Sector ETFs', 'equities', '1W', 1, 1),
('g-thematic', 'sec-equities', 3, 'Thematic ETFs', 'equities', '5D', 1, 1),
('g-country', 'sec-equities', 4, 'Country ETFs', 'equities', '1W', 1, 0),
('g-breadth', 'sec-breadth', 1, 'Market Internals Dashboard', 'breadth', '1D', 0, 0);

INSERT OR IGNORE INTO dashboard_columns (group_id, columns_json) VALUES
('g-us-index', '["ticker","name","price","1D","1W","5D","YTD","pctFrom52WHigh","sparkline"]'),
('g-vol-dollar', '["ticker","name","price","1D","1W","YTD","sparkline"]'),
('g-crypto', '["ticker","name","price","1D","1W","5D","sparkline"]'),
('g-metals-energy', '["ticker","name","price","1D","5D","1W","sparkline"]'),
('g-global', '["ticker","name","price","1D","1W","YTD","sparkline"]'),
('g-major-etf', '["ticker","name","price","1D","1W","5D","YTD","pctFrom52WHigh","sparkline"]'),
('g-sector-etf', '["ticker","name","price","1D","1W","5D","YTD","sparkline"]'),
('g-thematic', '["ticker","name","price","1D","5D","1W","YTD","sparkline"]'),
('g-country', '["ticker","name","price","1D","1W","YTD","sparkline"]');

INSERT OR IGNORE INTO symbols (ticker, name, exchange, asset_class, sector, industry) VALUES
('SPY', 'SPDR S&P 500 ETF', 'NYSEARCA', 'etf', 'Broad Market', 'Large Blend'),
('QQQ', 'Invesco QQQ Trust', 'NASDAQ', 'etf', 'Broad Market', 'Large Growth'),
('IWM', 'iShares Russell 2000 ETF', 'NYSEARCA', 'etf', 'Broad Market', 'Small Blend'),
('DIA', 'SPDR Dow Jones ETF', 'NYSEARCA', 'etf', 'Broad Market', 'Large Value'),
('VIXY', 'ProShares VIX Short-Term Futures ETF', 'NYSEARCA', 'etf', 'Volatility', 'Alternatives'),
('UUP', 'Invesco DB US Dollar Index Bullish Fund', 'NYSEARCA', 'etf', 'FX', 'Currency'),
('GLD', 'SPDR Gold Shares', 'NYSEARCA', 'etf', 'Commodities', 'Metals'),
('SLV', 'iShares Silver Trust', 'NYSEARCA', 'etf', 'Commodities', 'Metals'),
('USO', 'United States Oil Fund', 'NYSEARCA', 'etf', 'Commodities', 'Energy'),
('BITO', 'ProShares Bitcoin Strategy ETF', 'NYSEARCA', 'etf', 'Crypto', 'Digital Assets'),
('XLF', 'Financial Select Sector SPDR', 'NYSEARCA', 'etf', 'Financials', 'Sector'),
('XLK', 'Technology Select Sector SPDR', 'NYSEARCA', 'etf', 'Technology', 'Sector'),
('XLE', 'Energy Select Sector SPDR', 'NYSEARCA', 'etf', 'Energy', 'Sector'),
('XLV', 'Health Care Select Sector SPDR', 'NYSEARCA', 'etf', 'Health Care', 'Sector'),
('XLY', 'Consumer Discretionary Select Sector SPDR', 'NYSEARCA', 'etf', 'Consumer', 'Sector'),
('XLI', 'Industrial Select Sector SPDR', 'NYSEARCA', 'etf', 'Industrials', 'Sector'),
('XLP', 'Consumer Staples Select Sector SPDR', 'NYSEARCA', 'etf', 'Consumer Staples', 'Sector'),
('XLU', 'Utilities Select Sector SPDR', 'NYSEARCA', 'etf', 'Utilities', 'Sector'),
('XLB', 'Materials Select Sector SPDR', 'NYSEARCA', 'etf', 'Materials', 'Sector'),
('XLRE', 'Real Estate Select Sector SPDR', 'NYSEARCA', 'etf', 'Real Estate', 'Sector'),
('IYR', 'iShares U.S. Real Estate ETF', 'NYSEARCA', 'etf', 'Real Estate', 'Thematic'),
('ARKK', 'ARK Innovation ETF', 'NYSEARCA', 'etf', 'Innovation', 'Thematic'),
('SMH', 'VanEck Semiconductor ETF', 'NASDAQ', 'etf', 'Technology', 'Thematic'),
('KWEB', 'KraneShares CSI China Internet ETF', 'NYSEARCA', 'etf', 'International', 'Country'),
('EWJ', 'iShares MSCI Japan ETF', 'NYSEARCA', 'etf', 'International', 'Country'),
('EEM', 'iShares MSCI Emerging Markets ETF', 'NYSEARCA', 'etf', 'International', 'Country'),
('VGK', 'Vanguard FTSE Europe ETF', 'NYSEARCA', 'etf', 'International', 'Country'),
('INDA', 'iShares MSCI India ETF', 'NYSEARCA', 'etf', 'International', 'Country');

INSERT OR IGNORE INTO dashboard_items (id, group_id, sort_order, ticker, display_name, enabled, tags_json, holdings_json) VALUES
('i1','g-us-index',1,'SPY',NULL,1,'[]',NULL),('i2','g-us-index',2,'QQQ',NULL,1,'[]',NULL),('i3','g-us-index',3,'IWM',NULL,1,'[]',NULL),('i4','g-us-index',4,'DIA',NULL,1,'[]',NULL),
('i5','g-vol-dollar',1,'VIXY',NULL,1,'[]',NULL),('i6','g-vol-dollar',2,'UUP',NULL,1,'[]',NULL),
('i7','g-crypto',1,'BITO',NULL,1,'[]',NULL),
('i8','g-metals-energy',1,'GLD',NULL,1,'[]',NULL),('i9','g-metals-energy',2,'SLV',NULL,1,'[]',NULL),('i10','g-metals-energy',3,'USO',NULL,1,'[]',NULL),
('i11','g-global',1,'EWJ',NULL,1,'[]',NULL),('i12','g-global',2,'EEM',NULL,1,'[]',NULL),('i13','g-global',3,'VGK',NULL,1,'[]',NULL),('i14','g-global',4,'INDA',NULL,1,'[]',NULL),
('i15','g-major-etf',1,'SPY',NULL,1,'[]',NULL),('i16','g-major-etf',2,'QQQ',NULL,1,'[]',NULL),('i17','g-major-etf',3,'IWM',NULL,1,'[]',NULL),('i18','g-major-etf',4,'DIA',NULL,1,'[]',NULL),
('i19','g-sector-etf',1,'XLK',NULL,1,'[]',NULL),('i20','g-sector-etf',2,'XLF',NULL,1,'[]',NULL),('i21','g-sector-etf',3,'XLE',NULL,1,'[]',NULL),('i22','g-sector-etf',4,'XLV',NULL,1,'[]',NULL),('i23','g-sector-etf',5,'XLY',NULL,1,'[]',NULL),('i24','g-sector-etf',6,'XLI',NULL,1,'[]',NULL),('i25','g-sector-etf',7,'XLP',NULL,1,'[]',NULL),('i26','g-sector-etf',8,'XLU',NULL,1,'[]',NULL),('i27','g-sector-etf',9,'XLB',NULL,1,'[]',NULL),('i28','g-sector-etf',10,'XLRE',NULL,1,'[]',NULL),
('i29','g-thematic',1,'ARKK',NULL,1,'["high-beta"]','["TSLA","ROKU","COIN","CRSP","PATH"]'),
('i30','g-thematic',2,'SMH',NULL,1,'["semis"]','["NVDA","TSM","AVGO","AMD","ASML"]'),
('i31','g-thematic',3,'IYR',NULL,1,'["rates-sensitive"]','["PLD","AMT","EQIX","SPG","O"]'),
('i32','g-country',1,'EEM',NULL,1,'[]',NULL),('i33','g-country',2,'EWJ',NULL,1,'[]',NULL),('i34','g-country',3,'VGK',NULL,1,'[]',NULL),('i35','g-country',4,'INDA',NULL,1,'[]',NULL),('i36','g-country',5,'KWEB',NULL,1,'[]',NULL);

INSERT OR IGNORE INTO universes (id, name) VALUES ('sp500-lite', 'S&P 500 Lite Universe');
INSERT OR IGNORE INTO universe_symbols (universe_id, ticker) VALUES
('sp500-lite','SPY'),('sp500-lite','QQQ'),('sp500-lite','IWM'),('sp500-lite','DIA'),
('sp500-lite','XLK'),('sp500-lite','XLF'),('sp500-lite','XLE'),('sp500-lite','XLV'),
('sp500-lite','XLY'),('sp500-lite','XLI'),('sp500-lite','XLP'),('sp500-lite','XLU'),
('sp500-lite','XLB'),('sp500-lite','XLRE');


