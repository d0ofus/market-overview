ALTER TABLE etf_watchlists ADD COLUMN source_url TEXT;

UPDATE etf_watchlists SET source_url = 'https://www.invesco.com/us/en/financial-products/etfs/invesco-solar-etf.html'
WHERE ticker = 'TAN';

UPDATE etf_watchlists SET source_url = 'https://www.invesco.com/us/en/financial-products/etfs/invesco-wilderhill-clean-energy-etf.html'
WHERE ticker = 'PBW';

UPDATE etf_watchlists SET source_url = 'https://www.invesco.com/us/en/financial-products/etfs/invesco-pharmaceuticals-etf.html'
WHERE ticker = 'PJP';

UPDATE etf_watchlists SET source_url = 'https://www.invesco.com/us/en/financial-products/etfs/invesco-nasdaq-internet-etf.html'
WHERE ticker = 'PNQI';

UPDATE etf_watchlists SET source_url = 'https://www.invesco.com/us/en/financial-products/etfs/invesco-dynamic-food-and-beverage-etf.html'
WHERE ticker = 'PBJ';

UPDATE etf_watchlists SET source_url = 'https://www.invesco.com/us/en/financial-products/etfs/invesco-aerospace-defense-etf.html'
WHERE ticker = 'PPA';

UPDATE etf_watchlists SET source_url = 'https://www.invesco.com/us/en/financial-products/etfs/invesco-semiconductors-etf.html'
WHERE ticker = 'PSI';

UPDATE etf_watchlists SET source_url = 'https://www.invesco.com/us/en/financial-products/etfs/invesco-dynamic-leisure-and-entertainment-etf.html'
WHERE ticker = 'PEJ';

UPDATE etf_watchlists SET source_url = 'https://www.invesco.com/us/en/financial-products/etfs/invesco-db-agriculture-fund.html'
WHERE ticker = 'DBA';

UPDATE etf_watchlists SET source_url = 'https://www.invesco.com/us/en/financial-products/etfs/invesco-db-commodity-index-tracking-fund.html'
WHERE ticker = 'DBC';

UPDATE etf_watchlists SET source_url = 'https://www.invesco.com/us/en/financial-products/etfs/invesco-pharmaceuticals-etf.html'
WHERE ticker = 'PPH';
