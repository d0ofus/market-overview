import { apiUrl } from "./api";

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

export type ResearchLabRunRecord = {
  id: string;
  sourceType: "manual" | "watchlist_set";
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

export type ResearchLabRunListRow = {
  run: ResearchLabRunRecord;
  promptConfigName: string | null;
  evidenceProfileName: string | null;
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
  eventType: string;
  level: "info" | "warn" | "error";
  message: string;
  contextJson: Record<string, unknown> | null;
  createdAt: string;
};

export type ResearchLabEvidenceRecord = {
  id: string;
  runId: string;
  runItemId: string;
  ticker: string;
  providerKey: "perplexity" | "anthropic";
  evidenceKind: "key_metrics" | "news_catalysts" | "investor_relations" | "transcripts" | "analyst_media" | "macro_relevance";
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

export type ResearchLabSynthesis = {
  ticker: string;
  companyName: string | null;
  opinion: "positive" | "mixed" | "negative" | "unclear";
  overallSummary: string;
  whyNow: string;
  valuationView: {
    label: "cheap" | "fair" | "expensive" | "unclear";
    summary: string;
  };
  earningsQualityView: {
    label: "strong" | "mixed" | "weak" | "unclear";
    summary: string;
  };
  pricedInView: {
    label: "underappreciated" | "partially_priced_in" | "mostly_priced_in" | "fully_priced_in" | "unclear";
    summary: string;
  };
  catalysts: Array<{
    title: string;
    summary: string;
    direction: "positive" | "negative" | "mixed";
    timeframe: string;
    evidenceIds: string[];
  }>;
  risks: Array<{
    title: string;
    summary: string;
    severity: "high" | "medium" | "low";
    evidenceIds: string[];
  }>;
  contradictions: Array<{
    title: string;
    summary: string;
    evidenceIds: string[];
  }>;
  confidence: {
    label: "high" | "medium" | "low";
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

export type ResearchLabOutputRecord = {
  id: string;
  runId: string;
  runItemId: string;
  ticker: string;
  promptConfigId: string | null;
  evidenceProfileId: string | null;
  priorOutputId: string | null;
  synthesisJson: ResearchLabSynthesis;
  memorySummaryJson: {
    opinion: "positive" | "mixed" | "negative" | "unclear";
    overallSummary: string;
    pricedInLabel: "underappreciated" | "partially_priced_in" | "mostly_priced_in" | "fully_priced_in" | "unclear";
    confidenceLabel: "high" | "medium" | "low";
    topCatalysts: string[];
    topRisks: string[];
    evidenceIds: string[];
  };
  deltaJson: {
    opinionChanged: boolean;
    previousOpinion: "positive" | "mixed" | "negative" | "unclear" | null;
    currentOpinion: "positive" | "mixed" | "negative" | "unclear";
    newCatalysts: string[];
    resolvedCatalysts: string[];
    newRisks: string[];
    resolvedRisks: string[];
    confidenceChanged: boolean;
    previousConfidenceLabel: "high" | "medium" | "low" | null;
    currentConfidenceLabel: "high" | "medium" | "low";
    pricedInChanged: boolean;
    previousPricedInLabel: "underappreciated" | "partially_priced_in" | "mostly_priced_in" | "fully_priced_in" | "unclear" | null;
    currentPricedInLabel: "underappreciated" | "partially_priced_in" | "mostly_priced_in" | "fully_priced_in" | "unclear";
    summary: string | null;
  } | null;
  sourceEvidenceIds: string[];
  model: string;
  usageJson: Record<string, unknown> | null;
  createdAt: string;
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

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`API ${path} failed: ${response.status} ${detail}`);
  }
  return response.json() as Promise<T>;
}

export function createResearchLabRun(payload: {
  tickers: string[];
  promptConfigId?: string | null;
  evidenceProfileId?: string | null;
}) {
  return getJson<{ ok: true; run: ResearchLabRunRecord }>("/api/research-lab/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export function cancelResearchLabRun(id: string) {
  return getJson<{ ok: true; run: ResearchLabRunRecord }>(`/api/research-lab/runs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
}

export function getResearchLabRuns(limit = 10) {
  return getJson<{ rows: ResearchLabRunListRow[] }>(`/api/research-lab/runs?limit=${encodeURIComponent(String(limit))}`);
}

export function getResearchLabRunStatus(id: string) {
  return getJson<ResearchLabRunStatusResponse>(`/api/research-lab/runs/${encodeURIComponent(id)}`);
}

export function getResearchLabRunResults(id: string) {
  return getJson<ResearchLabRunResultsResponse>(`/api/research-lab/runs/${encodeURIComponent(id)}/results`);
}

export function getResearchLabTickerHistory(ticker: string) {
  return getJson<{ rows: ResearchLabTickerHistoryEntry[] }>(`/api/research-lab/ticker/${encodeURIComponent(ticker)}/history`);
}
