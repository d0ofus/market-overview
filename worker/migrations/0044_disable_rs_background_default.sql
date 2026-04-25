UPDATE worker_schedule_settings
SET rs_background_enabled = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'default';
