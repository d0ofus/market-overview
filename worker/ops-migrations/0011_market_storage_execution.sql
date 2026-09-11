-- Execution upgrades preserve original source captures and copy checkpoints.
-- Immutable approval evidence is stored in eod_rollout_evidence.
ALTER TABLE market_storage_migrations ADD COLUMN execution_revision TEXT;
ALTER TABLE market_storage_migrations ADD COLUMN execution_evidence_hash TEXT;
