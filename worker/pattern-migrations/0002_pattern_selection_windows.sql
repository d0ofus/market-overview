ALTER TABLE pattern_labels ADD COLUMN pattern_start_date TEXT;

ALTER TABLE pattern_labels ADD COLUMN pattern_end_date TEXT;

ALTER TABLE pattern_labels ADD COLUMN selected_bar_count INTEGER;

ALTER TABLE pattern_labels ADD COLUMN selection_mode TEXT NOT NULL DEFAULT 'fixed_window';

CREATE INDEX IF NOT EXISTS idx_pattern_labels_profile_window
  ON pattern_labels(profile_id, pattern_start_date, pattern_end_date);

UPDATE pattern_labels
SET pattern_end_date = setup_date,
    selected_bar_count = pattern_window_bars,
    selection_mode = 'fixed_window'
WHERE pattern_end_date IS NULL;

UPDATE pattern_profiles
SET settings_json = json_set(
  COALESCE(NULLIF(settings_json, ''), '{}'),
  '$.selectedResamplePoints', 64,
  '$.candidatePatternLengths', json('[20,40,60,80,120]')
)
WHERE id = 'default';

INSERT OR IGNORE INTO pattern_feature_registry (feature_key, display_name, family, value_type, enabled, version, description) VALUES
('selected_price_path_64', 'Selected Price Path 64', 'shape', 'number[]', 1, 'v2', 'User-selected or scanner-matched pattern price path resampled to 64 points.'),
('selected_volume_path_64', 'Selected Volume Path 64', 'shape', 'number[]', 1, 'v2', 'Selected pattern volume path resampled to 64 points and normalized by median.'),
('selected_range_path_64', 'Selected Range Path 64', 'shape', 'number[]', 1, 'v2', 'Selected pattern high-low range path resampled to 64 points and normalized by median.'),
('selected_atr_path_64', 'Selected ATR Path 64', 'shape', 'number[]', 1, 'v2', 'Selected rolling ATR path resampled to 64 points and normalized by median.'),
('selected_rs_path_64', 'Selected RS Path 64', 'shape', 'number[]', 1, 'v2', 'Selected relative-strength path resampled to 64 points and normalized to start at 1.0.'),
('selected_distance_from_20sma_path_64', 'Selected 20SMA Distance Path 64', 'shape', 'number[]', 1, 'v2', 'Selected distance from 20SMA path resampled to 64 points.'),
('selected_distance_from_50sma_path_64', 'Selected 50SMA Distance Path 64', 'shape', 'number[]', 1, 'v2', 'Selected distance from 50SMA path resampled to 64 points.');
