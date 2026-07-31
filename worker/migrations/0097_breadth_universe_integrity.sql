ALTER TABLE universe_versions ADD COLUMN source_type TEXT;
ALTER TABLE universe_versions ADD COLUMN source_url TEXT;
ALTER TABLE universe_versions ADD COLUMN source_member_count INTEGER;
ALTER TABLE universe_versions ADD COLUMN normalized_member_count INTEGER;
ALTER TABLE universe_versions ADD COLUMN resolved_member_count INTEGER;
ALTER TABLE universe_versions ADD COLUMN unresolved_count INTEGER;
ALTER TABLE universe_versions ADD COLUMN unresolved_symbols_json TEXT;
ALTER TABLE universe_versions ADD COLUMN membership_hash TEXT;

ALTER TABLE universe_version_members ADD COLUMN source_ticker TEXT;
ALTER TABLE universe_version_members ADD COLUMN issuer_name TEXT;
ALTER TABLE universe_version_members ADD COLUMN exchange TEXT;
ALTER TABLE universe_version_members ADD COLUMN asset_class TEXT;

UPDATE universe_versions
   SET source_member_count = member_count,
       normalized_member_count = member_count,
       resolved_member_count = member_count,
       unresolved_count = 0
 WHERE source_member_count IS NULL;

CREATE INDEX IF NOT EXISTS idx_universe_versions_membership_hash
  ON universe_versions(universe_id, membership_hash, status);
