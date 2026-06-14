ALTER TABLE tv_watchlist_sets ADD COLUMN factor_config_json TEXT;

ALTER TABLE scan_run_rows ADD COLUMN factor_score REAL;
ALTER TABLE scan_run_rows ADD COLUMN factor_pass_count INTEGER;
ALTER TABLE scan_run_rows ADD COLUMN factor_unknown_count INTEGER;
ALTER TABLE scan_run_rows ADD COLUMN factor_results_json TEXT;
