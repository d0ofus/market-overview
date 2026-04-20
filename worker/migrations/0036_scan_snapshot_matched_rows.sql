ALTER TABLE scan_snapshots ADD COLUMN matched_row_count INTEGER;

UPDATE scan_snapshots
SET matched_row_count = row_count
WHERE matched_row_count IS NULL;
