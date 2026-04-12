CREATE TABLE IF NOT EXISTS scan_compile_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scan_compile_preset_members (
  compile_preset_id TEXT NOT NULL,
  scan_preset_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (compile_preset_id, scan_preset_id),
  FOREIGN KEY (compile_preset_id) REFERENCES scan_compile_presets(id) ON DELETE CASCADE,
  FOREIGN KEY (scan_preset_id) REFERENCES scan_presets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scan_compile_presets_updated_desc
  ON scan_compile_presets(updated_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_scan_compile_preset_members_sort
  ON scan_compile_preset_members(compile_preset_id, sort_order ASC, scan_preset_id ASC);
