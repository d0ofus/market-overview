export type ResearchLabRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "partial";

export type ResearchLabRunItemStatus =
  | "queued"
  | "memory_loading"
  | "gathering"
  | "gathering_failed"
  | "synthesizing"
  | "synthesizing_failed"
  | "persisting"
  | "completed"
  | "failed";

export type ResearchLabEventLevel = "info" | "warn" | "error";

export type ResearchLabEventType =
  | "run_created"
  | "memory_load_started"
  | "memory_load_finished"
  | "gathering_started"
  | "gathering_finished"
  | "gathering_failed"
  | "synthesis_started"
  | "synthesis_finished"
  | "synthesis_failed"
  | "persistence_started"
  | "persistence_finished"
  | "comparison_attached"
  | "run_completed";

export type ResearchLabEvidenceKind =
  | "key_metrics"
  | "news_catalysts"
  | "investor_relations"
  | "transcripts"
  | "analyst_media"
  | "macro_relevance";

export type ResearchLabProviderKey = "perplexity" | "anthropic";
export type ResearchLabSourceType = "manual" | "watchlist_set";

export type ResearchLabOpinion = "positive" | "mixed" | "negative" | "unclear";
export type ResearchLabConfidenceLabel = "high" | "medium" | "low";
export type ResearchLabValuationLabel = "cheap" | "fair" | "expensive" | "unclear";
export type ResearchLabQualityLabel = "strong" | "mixed" | "weak" | "unclear";
export type ResearchLabPricedInLabel = "underappreciated" | "partially_priced_in" | "mostly_priced_in" | "fully_priced_in" | "unclear";

export type ResearchLabTickerIdentity = {
  ticker: string;
  companyName: string | null;
  exchange: string | null;
  secCik: string | null;
  irDomain: string | null;
};

export type ResearchLabRunCreateRequest = {
  tickers: string[];
  promptConfigId?: string | null;
  evidenceProfileId?: string | null;
};

export type ResearchLabEvidenceProfileRecord = {
  id: string;
  name: string;
  description: string | null;
  configFamily: string;
  isDefault: boolean;
  queryConfigJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ResearchLabPromptConfigRecord = {
  id: string;
  name: string;
  description: string | null;
  configFamily: string;
  modelFamily: string;
  systemPrompt: string;
  schemaVersion: string;
  isDefault: boolean;
  synthesisConfigJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ResearchLabRunRecord = {
  id: string;
  sourceType: ResearchLabSourceType;
  sourceId: string | null;
  sourceLabel: string | null;
  promptConfigId: string | null;
  evidenceProfileId: string | null;
  status: ResearchLabRunStatus;
  requestedTickerCount: number;
  completedTickerCount: number;
  failedTickerCount: number;
  inputJson: Record<string, unknown> | null;
  providerUsageJson: Record<string, unknown> | null;
  metadataJson: Record<string, unknown> | null;
  errorSummary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ResearchLabRunItemRecord = {
  id: string;
  runId: string;
  ticker: string;
  sortOrder: number;
  companyName: string | null;
  exchange: string | null;
  secCik: string | null;
  irDomain: string | null;
  status: ResearchLabRunItemStatus;
  lastError: string | null;
  memoryOutputId: string | null;
  gatherProviderKey: string | null;
  gatherModel: string | null;
  gatherUsageJson: Record<string, unknown> | null;
  gatherLatencyMs: number | null;
  synthProviderKey: string | null;
  synthModel: string | null;
  synthUsageJson: Record<string, unknown> | null;
  synthLatencyMs: number | null;
  metadataJson: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ResearchLabRunEventRecord = {
  id: string;
  runId: string;
  runItemId: string | null;
  ticker: string | null;
  eventType: ResearchLabEventType;
  level: ResearchLabEventLevel;
  message: string;
  contextJson: Record<string, unknown> | null;
  createdAt: string;
};

export type ResearchLabEvidenceRecord = {
  id: string;
  runId: string;
  runItemId: string;
  ticker: string;
  providerKey: ResearchLabProviderKey;
  evidenceKind: ResearchLabEvidenceKind;
  queryLabel: string;
  canonicalUrl: string | null;
  sourceDomain: string | null;
  title: string;
  publishedAt: string | null;
  summary: string;
  excerpt: string | null;
  bullets: string[];
  contentHash: string;
  providerPayloadJson: Record<string, unknown> | null;
  createdAt: string;
};

export type ResearchLabEvidenceFamilyPacket = {
  kind: ResearchLabEvidenceKind;
  label: string;
  items: Array<{
    id: string;
    title: string;
    summary: string;
    excerpt: string | null;
    publishedAt: string | null;
    sourceDomain: string | null;
    canonicalUrl: string | null;
  }>;
};

export type ResearchLabCatalyst = {
  title: string;
  summary: string;
  direction: "positive" | "negative" | "mixed";
  timeframe: string;
  evidenceIds: string[];
};

export type ResearchLabRisk = {
  title: string;
  summary: string;
  severity: "high" | "medium" | "low";
  evidenceIds: string[];
};

export type ResearchLabContradiction = {
  title: string;
  summary: string;
  evidenceIds: string[];
};

export type ResearchLabSynthesis = {
  ticker: string;
  companyName: string | null;
  opinion: ResearchLabOpinion;
  overallSummary: string;
  whyNow: string;
  valuationView: {
    label: ResearchLabValuationLabel;
    summary: string;
  };
  earningsQualityView: {
    label: ResearchLabQualityLabel;
    summary: string;
  };
  pricedInView: {
    label: ResearchLabPricedInLabel;
    summary: string;
  };
  catalysts: ResearchLabCatalyst[];
  risks: ResearchLabRisk[];
  contradictions: ResearchLabContradiction[];
  confidence: {
    label: ResearchLabConfidenceLabel;
    score: number;
    summary: string;
  };
  monitoringPoints: string[];
  priorComparison: {
    summary: string;
    changed: boolean;
  } | null;
  evidenceIds: string[];
};

export type ResearchLabMemorySummary = {
  opinion: ResearchLabOpinion;
  overallSummary: string;
  pricedInLabel: ResearchLabPricedInLabel;
  confidenceLabel: ResearchLabConfidenceLabel;
  topCatalysts: string[];
  topRisks: string[];
  evidenceIds: string[];
};

export type ResearchLabOutputDelta = {
  opinionChanged: boolean;
  previousOpinion: ResearchLabOpinion | null;
  currentOpinion: ResearchLabOpinion;
  newCatalysts: string[];
  resolvedCatalysts: string[];
  newRisks: string[];
  resolvedRisks: string[];
  confidenceChanged: boolean;
  previousConfidenceLabel: ResearchLabConfidenceLabel | null;
  currentConfidenceLabel: ResearchLabConfidenceLabel;
  pricedInChanged: boolean;
  previousPricedInLabel: ResearchLabPricedInLabel | null;
  currentPricedInLabel: ResearchLabPricedInLabel;
  summary: string | null;
};

export type ResearchLabOutputRecord = {
  id: string;
  runId: string;
  runItemId: string;
  ticker: string;
  promptConfigId: string | null;
  evidenceProfileId: string | null;
  priorOutputId: string | null;
  synthesisJson: ResearchLabSynthesis;
  memorySummaryJson: ResearchLabMemorySummary;
  deltaJson: ResearchLabOutputDelta | null;
  sourceEvidenceIds: string[];
  model: string;
  usageJson: Record<string, unknown> | null;
  createdAt: string;
};

export type ResearchLabMemoryHeadRecord = {
  ticker: string;
  promptConfigFamily: string;
  latestOutputId: string;
  updatedAt: string;
};

export type ResearchLabRunListRow = {
  run: ResearchLabRunRecord;
  promptConfigName: string | null;
  evidenceProfileName: string | null;
};

export type ResearchLabRunStatusResponse = {
  run: ResearchLabRunRecord;
  items: ResearchLabRunItemRecord[];
  events: ResearchLabRunEventRecord[];
  promptConfig: ResearchLabPromptConfigRecord | null;
  evidenceProfile: ResearchLabEvidenceProfileRecord | null;
};

export type ResearchLabRunItemResult = {
  item: ResearchLabRunItemRecord;
  events: ResearchLabRunEventRecord[];
  evidence: ResearchLabEvidenceRecord[];
  output: ResearchLabOutputRecord | null;
};

export type ResearchLabRunResultsResponse = {
  run: ResearchLabRunRecord;
  items: ResearchLabRunItemResult[];
  promptConfig: ResearchLabPromptConfigRecord | null;
  evidenceProfile: ResearchLabEvidenceProfileRecord | null;
};

export type ResearchLabTickerHistoryEntry = {
  output: ResearchLabOutputRecord;
  run: ResearchLabRunRecord | null;
};
