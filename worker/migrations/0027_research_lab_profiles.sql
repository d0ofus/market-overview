CREATE TABLE IF NOT EXISTS research_lab_profiles (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  current_version_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS research_lab_profile_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  label TEXT NOT NULL,
  model_family TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT 'v1',
  evidence_config_json TEXT NOT NULL,
  synthesis_config_json TEXT NOT NULL,
  modules_config_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(profile_id, version_number),
  FOREIGN KEY (profile_id) REFERENCES research_lab_profiles(id)
);

ALTER TABLE research_lab_runs ADD COLUMN profile_id TEXT;
ALTER TABLE research_lab_runs ADD COLUMN profile_version_id TEXT;
ALTER TABLE research_lab_outputs ADD COLUMN profile_id TEXT;
ALTER TABLE research_lab_outputs ADD COLUMN profile_version_id TEXT;

CREATE INDEX IF NOT EXISTS idx_research_lab_profiles_default ON research_lab_profiles(is_default, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_lab_profile_versions_profile ON research_lab_profile_versions(profile_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_research_lab_runs_profile_created ON research_lab_runs(profile_id, created_at DESC);

INSERT OR IGNORE INTO research_lab_profiles (
  id,
  slug,
  name,
  description,
  is_active,
  is_default,
  current_version_id
) VALUES (
  'research-lab-profile-default',
  'research-lab-default',
  'Research Lab Default',
  'Default research-lab profile seeded from the original prompt and evidence configs.',
  1,
  1,
  'research-lab-profile-default-v1'
);

INSERT OR IGNORE INTO research_lab_profile_versions (
  id,
  profile_id,
  version_number,
  label,
  model_family,
  system_prompt,
  schema_version,
  evidence_config_json,
  synthesis_config_json,
  modules_config_json,
  is_active
) VALUES (
  'research-lab-profile-default-v1',
  'research-lab-profile-default',
  1,
  'Default v1',
  COALESCE(
    (SELECT model_family FROM research_lab_prompt_configs WHERE id = 'research-lab-prompt-default-v1' LIMIT 1),
    'claude-sonnet-4-6'
  ),
  COALESCE(
    (SELECT system_prompt FROM research_lab_prompt_configs WHERE id = 'research-lab-prompt-default-v1' LIMIT 1),
    'You are a senior buyside research analyst. Synthesize only from the supplied evidence. Be explicit about uncertainty, contradictions, and how much is already priced in. Return compact, decision-useful structured output with direct evidence grounding.'
  ),
  'v1',
  COALESCE(
    (SELECT query_config_json FROM research_lab_evidence_profiles WHERE id = 'research-lab-evidence-default-v1' LIMIT 1),
    '{}'
  ),
  COALESCE(
    (SELECT synthesis_config_json FROM research_lab_prompt_configs WHERE id = 'research-lab-prompt-default-v1' LIMIT 1),
    '{}'
  ),
  '{
    "keyDrivers": {
      "enabled": false,
      "maxDrivers": 3,
      "requirePriceRelationship": true,
      "priceWindow": "90d"
    }
  }',
  1
);

UPDATE research_lab_profiles
SET current_version_id = 'research-lab-profile-default-v1',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'research-lab-profile-default'
  AND (current_version_id IS NULL OR current_version_id = '');

UPDATE research_lab_runs
SET profile_id = 'research-lab-profile-default',
    profile_version_id = 'research-lab-profile-default-v1'
WHERE profile_id IS NULL
  AND prompt_config_id = 'research-lab-prompt-default-v1'
  AND evidence_profile_id = 'research-lab-evidence-default-v1';

UPDATE research_lab_outputs
SET profile_id = 'research-lab-profile-default',
    profile_version_id = 'research-lab-profile-default-v1'
WHERE profile_id IS NULL
  AND prompt_config_id = 'research-lab-prompt-default-v1'
  AND evidence_profile_id = 'research-lab-evidence-default-v1';
