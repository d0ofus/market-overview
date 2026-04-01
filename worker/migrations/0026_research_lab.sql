CREATE TABLE IF NOT EXISTS research_lab_prompt_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  config_family TEXT NOT NULL,
  model_family TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT 'v1',
  is_default INTEGER NOT NULL DEFAULT 0,
  synthesis_config_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS research_lab_evidence_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  config_family TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  query_config_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS research_lab_runs (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_id TEXT,
  source_label TEXT,
  prompt_config_id TEXT,
  evidence_profile_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  requested_ticker_count INTEGER NOT NULL DEFAULT 0,
  completed_ticker_count INTEGER NOT NULL DEFAULT 0,
  failed_ticker_count INTEGER NOT NULL DEFAULT 0,
  input_json TEXT,
  provider_usage_json TEXT,
  metadata_json TEXT,
  error_summary TEXT,
  started_at TEXT,
  completed_at TEXT,
  heartbeat_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (prompt_config_id) REFERENCES research_lab_prompt_configs(id),
  FOREIGN KEY (evidence_profile_id) REFERENCES research_lab_evidence_profiles(id)
);

CREATE TABLE IF NOT EXISTS research_lab_run_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  company_name TEXT,
  exchange TEXT,
  sec_cik TEXT,
  ir_domain TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  last_error TEXT,
  memory_output_id TEXT,
  gather_provider_key TEXT,
  gather_model TEXT,
  gather_usage_json TEXT,
  gather_latency_ms INTEGER,
  synth_provider_key TEXT,
  synth_model TEXT,
  synth_usage_json TEXT,
  synth_latency_ms INTEGER,
  metadata_json TEXT,
  started_at TEXT,
  completed_at TEXT,
  heartbeat_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES research_lab_runs(id),
  FOREIGN KEY (memory_output_id) REFERENCES research_lab_outputs(id)
);

CREATE TABLE IF NOT EXISTS research_lab_run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  run_item_id TEXT,
  ticker TEXT,
  event_type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  context_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES research_lab_runs(id),
  FOREIGN KEY (run_item_id) REFERENCES research_lab_run_items(id)
);

CREATE TABLE IF NOT EXISTS research_lab_evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  run_item_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  query_label TEXT NOT NULL,
  canonical_url TEXT,
  source_domain TEXT,
  title TEXT NOT NULL,
  published_at TEXT,
  summary TEXT NOT NULL,
  excerpt TEXT,
  bullets_json TEXT,
  content_hash TEXT NOT NULL,
  provider_payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES research_lab_runs(id),
  FOREIGN KEY (run_item_id) REFERENCES research_lab_run_items(id)
);

CREATE TABLE IF NOT EXISTS research_lab_outputs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  run_item_id TEXT NOT NULL UNIQUE,
  ticker TEXT NOT NULL,
  prompt_config_id TEXT,
  evidence_profile_id TEXT,
  prior_output_id TEXT,
  synthesis_json TEXT NOT NULL,
  memory_summary_json TEXT NOT NULL,
  delta_json TEXT,
  source_evidence_ids_json TEXT NOT NULL,
  model TEXT NOT NULL,
  usage_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES research_lab_runs(id),
  FOREIGN KEY (run_item_id) REFERENCES research_lab_run_items(id),
  FOREIGN KEY (prior_output_id) REFERENCES research_lab_outputs(id),
  FOREIGN KEY (prompt_config_id) REFERENCES research_lab_prompt_configs(id),
  FOREIGN KEY (evidence_profile_id) REFERENCES research_lab_evidence_profiles(id)
);

CREATE TABLE IF NOT EXISTS research_lab_memory_heads (
  ticker TEXT NOT NULL,
  prompt_config_family TEXT NOT NULL,
  latest_output_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticker, prompt_config_family),
  FOREIGN KEY (latest_output_id) REFERENCES research_lab_outputs(id)
);

CREATE INDEX IF NOT EXISTS idx_research_lab_runs_created_at ON research_lab_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_lab_run_items_run_sort ON research_lab_run_items(run_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_research_lab_run_items_ticker_created ON research_lab_run_items(ticker, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_lab_run_events_run_created ON research_lab_run_events(run_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_research_lab_evidence_run_item ON research_lab_evidence(run_item_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_research_lab_outputs_ticker_created ON research_lab_outputs(ticker, created_at DESC);

INSERT OR IGNORE INTO research_lab_prompt_configs (
  id,
  name,
  description,
  config_family,
  model_family,
  system_prompt,
  schema_version,
  is_default,
  synthesis_config_json
) VALUES (
  'research-lab-prompt-default-v1',
  'Research Lab Default Prompt',
  'Default Sonnet synthesis prompt for isolated stock research lab runs.',
  'research_lab_default',
  'claude-sonnet-4-6',
  'You are a senior buyside research analyst. Synthesize only from the supplied evidence. Be explicit about uncertainty, contradictions, and how much is already priced in. Return compact, decision-useful structured output with direct evidence grounding.',
  'v1',
  1,
  '{"maxEvidenceItems":12,"maxItemsPerFamily":2,"additionalInstructions":"Keep each section concise and avoid repeating the same evidence across sections unless it materially supports multiple conclusions."}'
);

INSERT OR IGNORE INTO research_lab_evidence_profiles (
  id,
  name,
  description,
  config_family,
  is_default,
  query_config_json
) VALUES (
  'research-lab-evidence-default-v1',
  'Research Lab Default Evidence',
  'Balanced evidence coverage for valuation, catalysts, transcripts, IR, analyst commentary, and macro context.',
  'research_lab_default',
  1,
  '{
    "lookbackDays": 21,
    "maxItemsPerQuery": 3,
    "maxItemsForPrompt": 12,
    "families": [
      {
        "key": "key_metrics",
        "label": "Key Metrics",
        "queryTemplate": "{ticker} {companyName} valuation margins revenue earnings guidance last {lookbackDays} days",
        "sourceKind": "news",
        "limit": 3
      },
      {
        "key": "news_catalysts",
        "label": "News & Catalysts",
        "queryTemplate": "{ticker} {companyName} recent news catalysts contract demand product launch regulatory last {lookbackDays} days",
        "sourceKind": "news",
        "limit": 3
      },
      {
        "key": "investor_relations",
        "label": "Investor Relations",
        "queryTemplate": "{companyName} investor relations {ticker} press release presentation last {lookbackDays} days",
        "sourceKind": "ir_page",
        "limit": 2
      },
      {
        "key": "transcripts",
        "label": "Transcripts",
        "queryTemplate": "{ticker} {companyName} earnings call transcript quarter management commentary",
        "sourceKind": "earnings_transcript",
        "limit": 2
      },
      {
        "key": "analyst_media",
        "label": "Analyst / Media",
        "queryTemplate": "{ticker} {companyName} analyst commentary target price downgrade upgrade media coverage last {lookbackDays} days",
        "sourceKind": "analyst_commentary",
        "limit": 2
      },
      {
        "key": "macro_relevance",
        "label": "Macro Relevance",
        "queryTemplate": "{ticker} {companyName} macro demand rates commodity freight consumer industrial last {lookbackDays} days",
        "sourceKind": "macro_release",
        "limit": 2
      }
    ]
  }'
);
