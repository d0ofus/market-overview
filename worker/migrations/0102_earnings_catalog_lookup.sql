-- Earnings eligibility intentionally compares tickers case-insensitively.
-- A plain ticker primary key cannot serve UPPER(ticker) in its correlated
-- catalog lookup, causing a full symbols scan for each earnings row.
-- Keep the existing eligibility semantics while making that lookup indexed.
CREATE INDEX IF NOT EXISTS idx_symbols_upper_ticker ON symbols(UPPER(ticker));
