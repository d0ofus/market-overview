ALTER TABLE worker_schedule_settings ADD COLUMN rs_manual_cache_reuse_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE worker_schedule_settings ADD COLUMN rs_shared_config_snapshot_fanout_enabled INTEGER NOT NULL DEFAULT 1;

UPDATE worker_schedule_settings
SET rs_manual_cache_reuse_enabled = COALESCE(rs_manual_cache_reuse_enabled, 1),
    rs_shared_config_snapshot_fanout_enabled = COALESCE(rs_shared_config_snapshot_fanout_enabled, 1),
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'default';
