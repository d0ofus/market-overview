ALTER TABLE snapshot_rows ADD COLUMN change_3m REAL;
ALTER TABLE snapshot_rows ADD COLUMN change_6m REAL;
ALTER TABLE snapshot_rows ADD COLUMN above_20_sma INTEGER;
ALTER TABLE snapshot_rows ADD COLUMN above_50_sma INTEGER;
ALTER TABLE snapshot_rows ADD COLUMN above_200_sma INTEGER;
ALTER TABLE snapshot_rows ADD COLUMN relative_strength_30d_vs_spy_json TEXT;
