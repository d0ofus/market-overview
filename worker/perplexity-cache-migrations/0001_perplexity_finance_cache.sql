CREATE TABLE IF NOT EXISTS perplexity_finance_cache (
  ticker TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  stored_at TEXT NOT NULL,
  status TEXT NOT NULL,
  profile_status TEXT,
  peers_status TEXT,
  warning TEXT,
  profile_url TEXT NOT NULL,
  peers_url TEXT NOT NULL,
  company_name TEXT,
  company_exchange TEXT,
  company_sector TEXT,
  company_industry TEXT,
  company_description TEXT,
  peers_json TEXT NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1
);
