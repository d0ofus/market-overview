ALTER TABLE etf_constituent_sync_status ADD COLUMN coverage TEXT;
ALTER TABLE etf_constituent_sync_status ADD COLUMN source_tier TEXT;
ALTER TABLE etf_constituent_sync_status ADD COLUMN source_url TEXT;
ALTER TABLE etf_constituent_sync_status ADD COLUMN provider_records_count INTEGER;
ALTER TABLE etf_constituent_sync_status ADD COLUMN expected_min_records INTEGER;
ALTER TABLE etf_constituent_sync_status ADD COLUMN last_full_synced_at TEXT;
ALTER TABLE etf_constituent_sync_status ADD COLUMN last_partial_synced_at TEXT;
