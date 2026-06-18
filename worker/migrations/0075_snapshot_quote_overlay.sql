ALTER TABLE snapshot_rows ADD COLUMN quote_price REAL;
ALTER TABLE snapshot_rows ADD COLUMN quote_prev_close REAL;
ALTER TABLE snapshot_rows ADD COLUMN quote_change_1d REAL;
ALTER TABLE snapshot_rows ADD COLUMN quote_source TEXT;
ALTER TABLE snapshot_rows ADD COLUMN quote_fetched_at TEXT;
ALTER TABLE snapshot_rows ADD COLUMN quote_freshness_status TEXT;
ALTER TABLE snapshot_rows ADD COLUMN quote_freshness_reason TEXT;
