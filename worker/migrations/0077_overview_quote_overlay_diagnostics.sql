ALTER TABLE snapshots_meta ADD COLUMN quote_overlay_requested_count INTEGER;
ALTER TABLE snapshots_meta ADD COLUMN quote_overlay_returned_count INTEGER;
ALTER TABLE snapshots_meta ADD COLUMN quote_overlay_error TEXT;
ALTER TABLE snapshots_meta ADD COLUMN quote_overlay_missing_sample_json TEXT;
