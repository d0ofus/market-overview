import { adminFetch, apiUrl } from "./api";

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

export type ResearchLabSourceType = "manual" | "watchlist_set";
export type ResearchLabSourceBasis = "compiled" | "unique";

export type ResearchLabProfileRecord = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isDefault: boolean;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ResearchLabProfileVersionRecord = {
  id: string;
  profileId: string;
  versionNumber: number;
  label: string;
  modelFamily: string;
  systemPrompt: string;
  schemaVersion: string;
  evidenceConfigJson: Record<string, unknown>;
  synthesisConfigJson: Record<string, unknown>;
  modulesConfigJson: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
};

export type ResearchLabProfileDetail = ResearchLabProfileRecord & {
  currentVersion: ResearchLabProfileVersionRecord | null;
};

export type ResearchLabRunRecord = {
  id: string;
  sourceType: ResearchLabSourceType;
  sourceId: string | null;
  sourceLabel: string | null;
  profileId: string | null;
  profileVersionId: string | null;
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
  profileName: string | null;
  profileVersionNumber: number | null;
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
  profileId?: string | null;
  profileVersionId?: string | null;
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

export type ResearchLabKeyDriver = {
  title: string;
  whyItMatters: string;
  direction: "positive" | "negative" | "mixed";
  timeframe: string;
  priceRelationship: string;
  confidence: "high" | "medium" | "low";
  evidenceIds: string[];
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
  modules?: {
    keyDrivers?: {
      summary: string;
      drivers: ResearchLabKeyDriver[];
    } | null;
  } | null;
  evidenceIds: string[];
};

export type ResearchLabOutputRecord = {
  id: string;
  runId: string;
  runItemId: string;
  ticker: string;
  profileId: string | null;
  profileVersionId: string | null;
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
  profile: ResearchLabProfileRecord | null;
  profileVersion: ResearchLabProfileVersionRecord | null;
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
  profile: ResearchLabProfileRecord | null;
  profileVersion: ResearchLabProfileVersionRecord | null;
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
  sourceType?: ResearchLabSourceType;
  sourceId?: string | null;
  sourceLabel?: string | null;
  watchlistRunId?: string | null;
  sourceBasis?: ResearchLabSourceBasis;
  selectedTickers?: string[];
  maxTickers?: number | null;
  profileId?: string | null;
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

export function pumpResearchLabRun(id: string) {
  return getJson<{ ok: true; runId: string }>(`/api/research-lab/runs/${encodeURIComponent(id)}/pump`, {
    method: "POST",
  });
}

export function getResearchLabRuns(params?: number | {
  sourceType?: ResearchLabSourceType | null;
  sourceId?: string | null;
  limit?: number;
}) {
  const normalized = typeof params === "number" ? { limit: params } : params;
  const query = new URLSearchParams();
  if (normalized?.sourceType) query.set("sourceType", normalized.sourceType);
  if (normalized?.sourceId) query.set("sourceId", normalized.sourceId);
  if (normalized?.limit) query.set("limit", String(normalized.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return getJson<{ rows: ResearchLabRunListRow[] }>(`/api/research-lab/runs${suffix}`);
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

export function getResearchLabProfiles() {
  return getJson<{ rows: ResearchLabProfileDetail[] }>("/api/research-lab/profiles");
}

export function getAdminResearchLabProfiles() {
  return adminFetch<{ profiles: ResearchLabProfileDetail[]; versions: ResearchLabProfileVersionRecord[] }>("/api/admin/research-lab/profiles");
}

export function createAdminResearchLabProfile(payload: {
  slug: string;
  name: string;
  description?: string | null;
  isActive?: boolean;
  isDefault?: boolean;
}) {
  return adminFetch<{ ok: true; id: string }>("/api/admin/research-lab/profiles", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateAdminResearchLabProfile(id: string, payload: {
  slug?: string;
  name?: string;
  description?: string | null;
  isActive?: boolean;
  isDefault?: boolean;
  currentVersionId?: string | null;
}) {
  return adminFetch<{ ok: true; id: string }>(`/api/admin/research-lab/profiles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function createAdminResearchLabProfileVersion(id: string, payload: {
  label: string;
  modelFamily: string;
  systemPrompt: string;
  schemaVersion?: string;
  evidenceConfigJson: Record<string, unknown>;
  synthesisConfigJson: Record<string, unknown>;
  modulesConfigJson?: Record<string, unknown>;
  activate?: boolean;
}) {
  return adminFetch<{ ok: true; id: string; versionNumber: number }>(`/api/admin/research-lab/profiles/${encodeURIComponent(id)}/versions`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
