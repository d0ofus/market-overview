CREATE TABLE IF NOT EXISTS research_profiles (
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

CREATE TABLE IF NOT EXISTS prompt_versions (
  id TEXT PRIMARY KEY,
  prompt_kind TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  label TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  model_family TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT 'v1',
  template_text TEXT,
  template_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(prompt_kind, version_number)
);

CREATE INDEX IF NOT EXISTS idx_prompt_versions_kind_version_desc
  ON prompt_versions(prompt_kind, version_number DESC);

CREATE TABLE IF NOT EXISTS rubric_versions (
  id TEXT PRIMARY KEY,
  version_number INTEGER NOT NULL UNIQUE,
  label TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT 'v1',
  rubric_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rubric_versions_version_desc
  ON rubric_versions(version_number DESC);

CREATE TABLE IF NOT EXISTS search_template_versions (
  id TEXT PRIMARY KEY,
  version_number INTEGER NOT NULL UNIQUE,
  label TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT 'v1',
  template_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_search_template_versions_version_desc
  ON search_template_versions(version_number DESC);

CREATE TABLE IF NOT EXISTS research_profile_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  prompt_version_id_haiku TEXT NOT NULL,
  prompt_version_id_sonnet_rank TEXT NOT NULL,
  prompt_version_id_sonnet_deep_dive TEXT NOT NULL,
  rubric_version_id TEXT NOT NULL,
  search_template_version_id TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(profile_id, version_number),
  FOREIGN KEY (profile_id) REFERENCES research_profiles(id),
  FOREIGN KEY (prompt_version_id_haiku) REFERENCES prompt_versions(id),
  FOREIGN KEY (prompt_version_id_sonnet_rank) REFERENCES prompt_versions(id),
  FOREIGN KEY (prompt_version_id_sonnet_deep_dive) REFERENCES prompt_versions(id),
  FOREIGN KEY (rubric_version_id) REFERENCES rubric_versions(id),
  FOREIGN KEY (search_template_version_id) REFERENCES search_template_versions(id)
);

CREATE INDEX IF NOT EXISTS idx_research_profile_versions_profile_created_desc
  ON research_profile_versions(profile_id, created_at DESC);

INSERT OR IGNORE INTO prompt_versions (
  id,
  prompt_kind,
  version_number,
  label,
  provider_key,
  model_family,
  schema_version,
  template_text,
  template_json
) VALUES
  (
    'prompt-haiku-extract-v1',
    'haiku_extract',
    1,
    'Default Haiku Extraction',
    'anthropic',
    'haiku-4.5',
    'v1',
    'Standardize fresh evidence into a swing-trading research card. Return strict JSON only and ground every claim in supplied evidence.',
    '{"responseShape":"research-card","maxEvidenceItems":14}'
  ),
  (
    'prompt-sonnet-rank-v1',
    'sonnet_rank',
    1,
    'Default Sonnet Ranking',
    'anthropic',
    'sonnet-4.6',
    'v1',
    'Rank standardized ticker cards for swing-trade attention. Return strict JSON only and preserve evidence-first reasoning.',
    '{"responseShape":"run-ranking","maxTickers":25}'
  ),
  (
    'prompt-sonnet-deep-dive-v1',
    'sonnet_deep_dive',
    1,
    'Default Sonnet Deep Dive',
    'anthropic',
    'sonnet-4.6',
    'v1',
    'Produce a concise deep dive for the selected ticker using current evidence and prior snapshot only as historical context.',
    '{"responseShape":"ticker-deep-dive","maxEvidenceItems":18}'
  );

INSERT OR IGNORE INTO rubric_versions (
  id,
  version_number,
  label,
  schema_version,
  rubric_json
) VALUES (
  'rubric-swing-v1',
  1,
  'Default Swing Rubric',
  'v1',
  '{
    "weights": {
      "valuation": 0.14,
      "earnings_quality": 0.18,
      "catalyst_quality": 0.22,
      "catalyst_freshness": 0.18,
      "risk": 0.18,
      "contradictions": 0.10
    },
    "priorityBuckets": {
      "high": 75,
      "medium": 55
    },
    "confidenceThresholds": {
      "high": 0.74,
      "medium": 0.5
    }
  }'
);

INSERT OR IGNORE INTO search_template_versions (
  id,
  version_number,
  label,
  schema_version,
  template_json
) VALUES (
  'search-template-swing-v1',
  1,
  'Default Swing Search',
  'v1',
  '{
    "tickerFamilies": [
      {
        "key": "news",
        "label": "Recent News",
        "queryTemplate": "{ticker} {companyName} stock news catalysts last {lookbackDays} days",
        "limit": 4
      },
      {
        "key": "earnings_transcript",
        "label": "Earnings Transcript",
        "queryTemplate": "{ticker} {companyName} earnings call transcript last 2 quarters",
        "limit": 2
      },
      {
        "key": "investor_relations",
        "label": "Investor Relations",
        "queryTemplate": "{companyName} investor relations {ticker} press release last {lookbackDays} days",
        "limit": 3
      },
      {
        "key": "analyst_commentary",
        "label": "Analyst Commentary",
        "queryTemplate": "{ticker} analyst upgrade downgrade target price summary last {lookbackDays} days",
        "limit": 3
      }
    ],
    "macroFamilies": [
      {
        "key": "macro_release",
        "label": "Macro Release",
        "queryTemplate": "latest us macro releases CPI PPI payrolls retail sales last 14 days",
        "limit": 2
      },
      {
        "key": "central_bank",
        "label": "Central Bank",
        "queryTemplate": "latest Federal Reserve statement speeches dot plot last 30 days",
        "limit": 2
      }
    ]
  }'
);

INSERT OR IGNORE INTO research_profiles (
  id,
  slug,
  name,
  description,
  is_active,
  is_default,
  current_version_id
) VALUES (
  'research-profile-swing-core',
  'swing-core',
  'Swing Core',
  'Balanced default profile for ranking watchlist names with fresh SEC and public-web evidence.',
  1,
  1,
  'research-profile-swing-core-v1'
);

INSERT OR IGNORE INTO research_profile_versions (
  id,
  profile_id,
  version_number,
  prompt_version_id_haiku,
  prompt_version_id_sonnet_rank,
  prompt_version_id_sonnet_deep_dive,
  rubric_version_id,
  search_template_version_id,
  settings_json,
  is_active
) VALUES (
  'research-profile-swing-core-v1',
  'research-profile-swing-core',
  1,
  'prompt-haiku-extract-v1',
  'prompt-sonnet-rank-v1',
  'prompt-sonnet-deep-dive-v1',
  'rubric-swing-v1',
  'search-template-swing-v1',
  '{
    "lookbackDays": 14,
    "includeMacroContext": true,
    "maxTickerQueries": 4,
    "maxEvidenceItemsPerTicker": 12,
    "maxSearchResultsPerQuery": 4,
    "maxTickersPerRun": 20,
    "deepDiveTopN": 3,
    "comparisonEnabled": true,
    "sourceFamilies": {
      "sec": true,
      "news": true,
      "earningsTranscripts": true,
      "investorRelations": true,
      "analystCommentary": true
    }
  }',
  1
);

UPDATE research_profiles
SET current_version_id = 'research-profile-swing-core-v1'
WHERE id = 'research-profile-swing-core'
  AND (current_version_id IS NULL OR current_version_id = '');
