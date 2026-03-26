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
    'prompt-haiku-extract-v2',
    'haiku_extract',
    2,
    'Research Extraction V2',
    'anthropic',
    'claude-3-haiku-20240307',
    'v2',
    'Extract a deep, evidence-grounded research card. Preserve evidence IDs, separate facts from inferences, make peer comparison optional but first-class, and return strict JSON only.',
    '{"responseShape":"research-card-v2","maxEvidenceItems":20}'
  ),
  (
    'prompt-sonnet-rank-v2',
    'sonnet_rank',
    2,
    'Research Ranking V2',
    'anthropic',
    'claude-3-5-sonnet-20241022',
    'v2',
    'Reconcile deterministic factor cards into an auditable final ranking. Use the factor cards as the canonical base signal, make only bounded adjustments, and return strict JSON only.',
    '{"responseShape":"run-ranking-v2","maxTickers":25}'
  ),
  (
    'prompt-sonnet-deep-dive-v2',
    'sonnet_deep_dive',
    2,
    'Research Deep Dive V2',
    'anthropic',
    'claude-3-5-sonnet-20241022',
    'v2',
    'Write a true PM-style research synthesis from the structured card plus evidence packets. Prioritize priced-in analysis, underappreciated evidence, leadership, invalidation, and peer context when credible.',
    '{"responseShape":"ticker-deep-dive-v2","maxEvidenceItems":24}'
  );

INSERT OR IGNORE INTO rubric_versions (
  id,
  version_number,
  label,
  schema_version,
  rubric_json
) VALUES (
  'rubric-swing-v2',
  2,
  'Default Swing Rubric V2',
  'v2',
  '{
    "weights": {
      "market_pricing_mismatch": 0.16,
      "earnings_quality": 0.14,
      "catalyst_strength": 0.12,
      "catalyst_durability": 0.10,
      "valuation_attractiveness": 0.10,
      "risk_severity_inverse": 0.10,
      "contradiction_burden_inverse": 0.08,
      "thematic_strength": 0.07,
      "setup_quality": 0.07,
      "evidence_quality_confidence": 0.06,
      "peer_earnings_quality": 0.02,
      "peer_growth_outlook": 0.02,
      "peer_historical_execution": 0.02,
      "peer_price_leadership": 0.02,
      "peer_fundamental_leadership": 0.02
    },
    "priorityBuckets": {
      "high": 75,
      "medium": 55
    },
    "maxRankingAdjustment": 10
  }'
);

INSERT OR IGNORE INTO search_template_versions (
  id,
  version_number,
  label,
  schema_version,
  template_json
) VALUES (
  'search-template-swing-v2',
  2,
  'Default Swing Search V2',
  'v2',
  '{
    "tickerFamilies": [
      {
        "key": "pricing_expectations",
        "label": "Pricing / Expectations",
        "queryTemplate": "{ticker} {companyName} stock expectations consensus valuation priced in last {lookbackDays} days",
        "limit": 3
      },
      {
        "key": "earnings_transcript",
        "label": "Earnings Transcript",
        "queryTemplate": "{ticker} {companyName} earnings call transcript last 2 quarters",
        "limit": 2
      },
      {
        "key": "earnings_quality_news",
        "label": "Earnings Quality",
        "queryTemplate": "{ticker} {companyName} earnings guide margins cash flow quality last {lookbackDays} days",
        "limit": 3
      },
      {
        "key": "valuation",
        "label": "Valuation",
        "queryTemplate": "{ticker} {companyName} valuation multiple target price relative valuation last {lookbackDays} days",
        "limit": 3
      },
      {
        "key": "thematic_context",
        "label": "Thematic Context",
        "queryTemplate": "{ticker} {companyName} secular theme demand adoption competition last {lookbackDays} days",
        "limit": 3
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
        "limit": 2
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
  'research-profile-swing-core-v2',
  'research-profile-swing-core',
  2,
  'prompt-haiku-extract-v2',
  'prompt-sonnet-rank-v2',
  'prompt-sonnet-deep-dive-v2',
  'rubric-swing-v2',
  'search-template-swing-v2',
  '{
    "lookbackDays": 14,
    "includeMacroContext": true,
    "maxTickerQueries": 7,
    "maxEvidenceItemsPerTicker": 16,
    "maxSearchResultsPerQuery": 4,
    "maxTickersPerRun": 20,
    "deepDiveTopN": 3,
    "comparisonEnabled": true,
    "peerComparisonEnabled": true,
    "maxPeerCandidates": 3,
    "maxTopicEvidenceItems": 4,
    "maxEvidenceExcerptsPerTopic": 2,
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
SET current_version_id = 'research-profile-swing-core-v2'
WHERE id = 'research-profile-swing-core';
