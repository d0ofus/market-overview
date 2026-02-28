CREATE TABLE IF NOT EXISTS filings_13f_managers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cik TEXT,
  aum_usd REAL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS filings_13f_reports (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL,
  report_quarter TEXT NOT NULL,
  filed_date TEXT NOT NULL,
  total_value_usd REAL,
  total_holdings_count INTEGER,
  UNIQUE(manager_id, report_quarter),
  FOREIGN KEY (manager_id) REFERENCES filings_13f_managers(id)
);

CREATE TABLE IF NOT EXISTS filings_13f_holdings (
  report_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  issuer_name TEXT NOT NULL,
  value_usd REAL NOT NULL,
  shares REAL,
  weight_pct REAL,
  PRIMARY KEY (report_id, ticker),
  FOREIGN KEY (report_id) REFERENCES filings_13f_reports(id)
);

CREATE TABLE IF NOT EXISTS sector_narratives (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sector_tracker_entries (
  id TEXT PRIMARY KEY,
  sector_name TEXT NOT NULL,
  event_date TEXT NOT NULL,
  trend_score REAL NOT NULL DEFAULT 0,
  notes TEXT,
  narrative_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (narrative_id) REFERENCES sector_narratives(id)
);

CREATE TABLE IF NOT EXISTS sector_tracker_entry_symbols (
  entry_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  PRIMARY KEY (entry_id, ticker),
  FOREIGN KEY (entry_id) REFERENCES sector_tracker_entries(id),
  FOREIGN KEY (ticker) REFERENCES symbols(ticker)
);

INSERT OR IGNORE INTO filings_13f_managers (id, name, cik, aum_usd) VALUES
('bridgewater', 'Bridgewater Associates', '0001350694', 124000000000),
('scion', 'Scion Asset Management', '0001649339', 1800000000),
('pershing', 'Pershing Square Capital Management', '0001336528', 13200000000),
('citadel', 'Citadel Advisors', '0001423053', 420000000000);

INSERT OR IGNORE INTO filings_13f_reports (id, manager_id, report_quarter, filed_date, total_value_usd, total_holdings_count) VALUES
('r-bridgewater-2025q4','bridgewater','2025Q4','2026-02-14',20800000000,602),
('r-scion-2025q4','scion','2025Q4','2026-02-14',254000000,16),
('r-pershing-2025q4','pershing','2025Q4','2026-02-14',11400000000,8),
('r-citadel-2025q4','citadel','2025Q4','2026-02-14',463000000000,5610);

INSERT OR IGNORE INTO filings_13f_holdings (report_id, ticker, issuer_name, value_usd, shares, weight_pct) VALUES
('r-bridgewater-2025q4','SPY','SPDR S&P 500 ETF Trust',1220000000,2380000,5.9),
('r-bridgewater-2025q4','IVV','iShares Core S&P 500 ETF',1180000000,2150000,5.7),
('r-bridgewater-2025q4','VWO','Vanguard FTSE Emerging Markets ETF',941000000,21500000,4.5),
('r-bridgewater-2025q4','QQQ','Invesco QQQ Trust',688000000,1310000,3.3),
('r-bridgewater-2025q4','EEM','iShares MSCI Emerging Markets ETF',674000000,17800000,3.2),
('r-scion-2025q4','GOOGL','Alphabet Inc',68000000,357000,26.8),
('r-scion-2025q4','JD','JD.com Inc',34000000,1210000,13.4),
('r-scion-2025q4','BABA','Alibaba Group Holding Ltd',30000000,449000,11.8),
('r-scion-2025q4','CVS','CVS Health Corp',27000000,402000,10.6),
('r-scion-2025q4','DG','Dollar General Corp',21000000,161000,8.3),
('r-pershing-2025q4','CMG','Chipotle Mexican Grill Inc',2520000000,3700000,22.1),
('r-pershing-2025q4','HLT','Hilton Worldwide Holdings Inc',1880000000,10200000,16.5),
('r-pershing-2025q4','GOOGL','Alphabet Inc',1770000000,9300000,15.5),
('r-pershing-2025q4','LOW','Lowe''s Companies Inc',1410000000,6000000,12.4),
('r-pershing-2025q4','QSR','Restaurant Brands International',970000000,11800000,8.5),
('r-citadel-2025q4','SPY','SPDR S&P 500 ETF Trust',15800000000,30900000,3.4),
('r-citadel-2025q4','QQQ','Invesco QQQ Trust',13300000000,25500000,2.9),
('r-citadel-2025q4','AAPL','Apple Inc',11200000000,66000000,2.4),
('r-citadel-2025q4','MSFT','Microsoft Corp',10800000000,24000000,2.3),
('r-citadel-2025q4','NVDA','NVIDIA Corp',9800000000,18200000,2.1);

INSERT OR IGNORE INTO sector_narratives (id, title, description) VALUES
('n-ai-capex', 'AI Capex Supercycle', 'Data center, semis, and power infrastructure beneficiaries.'),
('n-energy-transition', 'Energy Transition + Grid', 'Generation, utilities, and electrical equipment spend.'),
('n-rate-sensitive-rebound', 'Rate-Sensitive Rebound', 'Lower yields support housing, REITs, and small-caps.');

INSERT OR IGNORE INTO sector_tracker_entries (id, sector_name, event_date, trend_score, notes, narrative_id) VALUES
('se-1','Semiconductors','2026-02-18',82,'Earnings beats and AI capex guides accelerating.','n-ai-capex'),
('se-2','Utilities','2026-02-21',68,'Power demand upgrades from hyperscaler capex plans.','n-energy-transition'),
('se-3','Homebuilders','2026-02-24',61,'Mortgage rates eased, builders showing relative strength.','n-rate-sensitive-rebound');

INSERT OR IGNORE INTO symbols (ticker, name, exchange, asset_class, sector, industry) VALUES
('AAPL','Apple Inc','NASDAQ','equity','Technology','Consumer Electronics'),
('MSFT','Microsoft Corp','NASDAQ','equity','Technology','Software'),
('NVDA','NVIDIA Corp','NASDAQ','equity','Technology','Semiconductors'),
('IVV','iShares Core S&P 500 ETF','NYSEARCA','etf','Broad Market','Large Blend'),
('GOOGL','Alphabet Inc','NASDAQ','equity','Communication Services','Internet Content'),
('JD','JD.com Inc','NASDAQ','equity','Consumer Cyclical','Internet Retail'),
('BABA','Alibaba Group Holding Ltd','NYSE','equity','Consumer Cyclical','Internet Retail'),
('CVS','CVS Health Corp','NYSE','equity','Health Care','Pharmacy'),
('DG','Dollar General Corp','NYSE','equity','Consumer Defensive','Discount Stores'),
('CMG','Chipotle Mexican Grill Inc','NYSE','equity','Consumer Cyclical','Restaurants'),
('HLT','Hilton Worldwide Holdings Inc','NYSE','equity','Consumer Cyclical','Lodging'),
('LOW','Lowe''s Companies Inc','NYSE','equity','Consumer Cyclical','Home Improvement'),
('QSR','Restaurant Brands International','NYSE','equity','Consumer Cyclical','Restaurants'),
('AMD','Advanced Micro Devices Inc','NASDAQ','equity','Technology','Semiconductors'),
('AVGO','Broadcom Inc','NASDAQ','equity','Technology','Semiconductors'),
('NEE','NextEra Energy Inc','NYSE','equity','Utilities','Regulated Electric'),
('DUK','Duke Energy Corp','NYSE','equity','Utilities','Regulated Electric'),
('ITB','iShares U.S. Home Construction ETF','NYSEARCA','etf','Consumer Cyclical','Homebuilders'),
('XHB','SPDR S&P Homebuilders ETF','NYSEARCA','etf','Consumer Cyclical','Homebuilders'),
('LEN','Lennar Corp','NYSE','equity','Consumer Cyclical','Homebuilders');

INSERT OR IGNORE INTO sector_tracker_entry_symbols (entry_id, ticker) VALUES
('se-1','SMH'),('se-1','NVDA'),('se-1','AMD'),('se-1','AVGO'),
('se-2','XLU'),('se-2','NEE'),('se-2','DUK'),
('se-3','ITB'),('se-3','XHB'),('se-3','LEN');
