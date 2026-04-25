DELETE FROM relative_strength_refresh_queue;

DELETE FROM relative_strength_materialization_queue;

DELETE FROM relative_strength_materialization_run_deferred_tickers;

DELETE FROM relative_strength_materialization_run_candidates;

DELETE FROM relative_strength_materialization_runs;

DELETE FROM scan_refresh_job_top_rows
WHERE job_id IN (
  SELECT id
  FROM scan_refresh_jobs
  WHERE job_type = 'relative-strength'
);

DELETE FROM scan_refresh_job_candidates
WHERE job_id IN (
  SELECT id
  FROM scan_refresh_jobs
  WHERE job_type = 'relative-strength'
);

DELETE FROM scan_refresh_jobs
WHERE job_type = 'relative-strength';
