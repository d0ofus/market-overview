ALTER TABLE overview_generations ADD COLUMN source_cycle_id TEXT;
ALTER TABLE overview_generations ADD COLUMN publication_quality TEXT;
ALTER TABLE overview_generations ADD COLUMN essential_current_coverage_pct REAL;
ALTER TABLE overview_generations ADD COLUMN publication_critical_missing_json TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_overview_generations_source_cycle
  ON overview_generations (config_id, as_of_date, source_cycle_id)
  WHERE source_cycle_id IS NOT NULL;

UPDATE overview_generations
SET publication_quality = CASE
  WHEN status = 'rejected' THEN 'rejected'
  WHEN status = 'ready' THEN 'ready'
  ELSE publication_quality
END
WHERE publication_quality IS NULL;
