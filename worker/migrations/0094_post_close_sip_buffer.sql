UPDATE worker_schedule_settings
SET post_close_bars_offset_minutes = 35,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'default'
  AND post_close_bars_offset_minutes = 20;
