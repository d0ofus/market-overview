ALTER TABLE worker_schedule_settings ADD COLUMN pattern_scan_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE worker_schedule_settings ADD COLUMN pattern_scan_offset_minutes INTEGER NOT NULL DEFAULT 75;

ALTER TABLE worker_schedule_settings ADD COLUMN pattern_scan_batch_size INTEGER NOT NULL DEFAULT 40;

ALTER TABLE worker_schedule_settings ADD COLUMN pattern_scan_max_batches_per_tick INTEGER NOT NULL DEFAULT 4;
