-- History depth is explicit and durable before GitHub dispatch. Existing runs
-- retain full-catalog 520-session repair; deep requests must be bounded.
ALTER TABLE eod_runs ADD COLUMN history_tickers_json TEXT
  CHECK(history_tickers_json IS NULL OR (
    purpose='backfill' AND json_valid(history_tickers_json)
    AND json_type(history_tickers_json)='array'
    AND json_array_length(history_tickers_json) BETWEEN 1 AND 100
  ));
ALTER TABLE eod_runs ADD COLUMN history_sessions INTEGER NOT NULL DEFAULT 520
  CHECK(history_sessions=520 OR (
    history_sessions=1400 AND purpose='backfill' AND history_tickers_json IS NOT NULL
  ));

-- Captured before final publication: corrections arriving during/after the run
-- remain detectable even if all six published session dates still match.
ALTER TABLE eod_runs ADD COLUMN completed_input_clock INTEGER
  CHECK(completed_input_clock IS NULL OR completed_input_clock>=0);
