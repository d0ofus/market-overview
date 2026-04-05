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
  'research-lab-profile-freshness-v1-version-2',
  'research-lab-profile-freshness-v1',
  2,
  'Freshness v2',
  COALESCE(
    (
      SELECT model_family
      FROM research_lab_profile_versions
      WHERE id = 'research-lab-profile-freshness-v1-version-1'
      LIMIT 1
    ),
    'claude-sonnet-4-6'
  ),
  'You are a senior buyside research analyst. Synthesize only from the supplied evidence. Use prior memory as comparison context to explain what is new, what is confirmed, what is weakening, and whether the latest change is incremental or thesis-changing. For current factual claims, prefer the most recent dated evidence when sources conflict. For earnings commentary, anchor to the latest reported quarter or latest earnings release and name the quarter or reporting period explicitly when possible. Use whyNow, pricedInView, and priorComparison to assess whether the fresh change appears underappreciated, partially priced in, mostly priced in, or fully priced in based on the supplied evidence and any observed market reaction described in that evidence. Be explicit about uncertainty, contradictions, and direct evidence grounding. Return compact, decision-useful structured output.',
  'v1',
  '{
    "lookbackDays": 21,
    "maxItemsPerQuery": 3,
    "maxItemsForPrompt": 12,
    "evidenceTarget": 8,
    "maxQueryFamilies": 4,
    "forceFreshSearch": true,
    "families": [
      {
        "key": "key_metrics",
        "label": "Key Metrics",
        "queryTemplate": "{ticker} {companyName} valuation margins revenue earnings guidance estimate revisions last {lookbackDays} days",
        "sourceKind": "news",
        "limit": 3,
        "maxAgeDays": 21
      },
      {
        "key": "news_catalysts",
        "label": "News & Catalysts",
        "queryTemplate": "{ticker} {companyName} newest company-specific news catalysts management change contract demand product launch partnership guidance regulatory last 7 days prioritize the most recent dated material developments and expand to last {lookbackDays} days only if coverage is sparse",
        "sourceKind": "news",
        "limit": 3,
        "maxAgeDays": 21,
        "requirePublishedAt": true
      },
      {
        "key": "investor_relations",
        "label": "Investor Relations",
        "queryTemplate": "{companyName} investor relations {ticker} latest earnings release shareholder letter press release presentation webcast last {lookbackDays} days",
        "sourceKind": "ir_page",
        "limit": 2,
        "maxAgeDays": 120,
        "requirePublishedAt": true
      },
      {
        "key": "transcripts",
        "label": "Transcripts",
        "queryTemplate": "{ticker} {companyName} latest earnings call transcript latest earnings release shareholder letter management commentary most recent quarter",
        "sourceKind": "earnings_transcript",
        "limit": 2,
        "maxAgeDays": 120,
        "requirePublishedAt": true
      },
      {
        "key": "analyst_media",
        "label": "Analyst / Media",
        "queryTemplate": "{ticker} {companyName} analyst commentary target price downgrade upgrade media coverage last {lookbackDays} days",
        "sourceKind": "analyst_commentary",
        "limit": 2,
        "maxAgeDays": 21
      },
      {
        "key": "macro_relevance",
        "label": "Macro Relevance",
        "queryTemplate": "{ticker} {companyName} macro demand rates commodity freight consumer industrial last {lookbackDays} days",
        "sourceKind": "macro_release",
        "limit": 2,
        "maxAgeDays": 30
      }
    ]
  }',
  '{
    "maxEvidenceItems": 12,
    "maxItemsPerFamily": 2,
    "includePublishedAt": true,
    "includeSourceDomain": true,
    "includePriorMemory": true,
    "additionalInstructions": "Use prior memory as comparison context: explain what changed versus the prior run, whether fresh evidence confirms, weakens, or reverses the prior thesis, and whether the latest change looks incremental or thesis-changing. For current facts, prefer the most recent dated evidence. When discussing earnings, anchor to the latest reported quarter or earnings release and name the period explicitly when possible. Use whyNow and pricedInView to assess whether the fresh change appears underappreciated, partially priced in, mostly priced in, or fully priced in based on the supplied evidence."
  }',
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
SET current_version_id = 'research-lab-profile-freshness-v1-version-2',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'research-lab-profile-freshness-v1';
