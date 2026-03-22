ALTER TABLE breadth_snapshots ADD COLUMN generated_at TEXT;

UPDATE breadth_snapshots
SET generated_at = COALESCE(
  (
    SELECT MAX(s.generated_at)
    FROM snapshots_meta s
    WHERE s.as_of_date = breadth_snapshots.as_of_date
  ),
  CURRENT_TIMESTAMP
)
WHERE generated_at IS NULL OR TRIM(generated_at) = '';
