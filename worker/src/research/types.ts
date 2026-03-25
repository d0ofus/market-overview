export type ResearchRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "partial";

export type ResearchTickerStatus =
  | "queued"
  | "normalizing"
  | "retrieving"
  | "extracting"
  | "ranking_ready"
  | "deep_dive"
  | "completed"
  | "cancelled"
  | "failed"
  | "skipped";

export type ResearchRefreshMode = "reuse_fresh_search_cache" | "force_fresh";
export type ResearchRankingMode = "rank_only" | "rank_and_deep_dive";
export type ResearchSourceType = "watchlist_set" | "manual";

export type ResearchProviderKey = "sec_direct" | "perplexity_search" | "anthropic" | "rules";

export type ResearchEvidenceSourceKind =
  | "sec_submission"
  | "sec_facts"
  | "earnings_transcript"
  | "ir_page"
  | "news"
  | "analyst_commentary"
  | "macro_release"
  | "central_bank"
  | "media";

export type ResearchEvidenceScopeKind = "ticker" | "macro" | "market";

export type ResearchPriorityBucket = "high" | "medium" | "monitor";

export type ResearchConfidenceLabel = "high" | "medium" | "low";
export type ResearchOpinionLabel = "positive" | "mixed" | "negative" | "unclear";
export type ResearchCatalystFreshnessLabel = "fresh" | "recent" | "stale" | "unclear";
export type ResearchRiskLabel = "low" | "moderate" | "high";
export type ResearchFactorDirection = "positive" | "neutral" | "negative" | "mixed";

export type ResearchSourceFamilySettings = {
  sec: boolean;
  news: boolean;
  earningsTranscripts: boolean;
  investorRelations: boolean;
  analystCommentary: boolean;
};

export type ResearchProfileSettings = {
  lookbackDays: number;
  includeMacroContext: boolean;
  maxTickerQueries: number;
  maxEvidenceItemsPerTicker: number;
  maxSearchResultsPerQuery: number;
  maxTickersPerRun: number;
  deepDiveTopN: number;
  comparisonEnabled: boolean;
  sourceFamilies: ResearchSourceFamilySettings;
};

export type PromptVersionRecord = {
  id: string;
  promptKind: "haiku_extract" | "sonnet_rank" | "sonnet_deep_dive";
  versionNumber: number;
  label: string;
  providerKey: string;
  modelFamily: string;
  schemaVersion: string;
  templateText: string | null;
  templateJson: Record<string, unknown> | null;
  isActive: boolean;
  createdAt: string;
};

export type RubricVersionRecord = {
  id: string;
  versionNumber: number;
  label: string;
  schemaVersion: string;
  rubricJson: Record<string, unknown>;
  createdAt: string;
};

export type SearchTemplateVersionRecord = {
  id: string;
  versionNumber: number;
  label: string;
  schemaVersion: string;
  templateJson: Record<string, unknown>;
  createdAt: string;
};

export type ResearchProfileVersionRecord = {
  id: string;
  profileId: string;
  versionNumber: number;
  promptVersionIdHaiku: string;
  promptVersionIdSonnetRank: string;
  promptVersionIdSonnetDeepDive: string;
  rubricVersionId: string;
  searchTemplateVersionId: string;
  settings: ResearchProfileSettings;
  isActive: boolean;
  createdAt: string;
};

export type ResearchProfileRecord = {
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

export type ResearchProfileDetail = ResearchProfileRecord & {
  currentVersion: ResearchProfileVersionRecord | null;
};

export type ResearchPromptBundle = {
  haiku: PromptVersionRecord;
  sonnetRank: PromptVersionRecord;
  sonnetDeepDive: PromptVersionRecord;
  rubric: RubricVersionRecord;
  searchTemplate: SearchTemplateVersionRecord;
};

export type ResolvedResearchProfile = {
  profile: ResearchProfileRecord;
  version: ResearchProfileVersionRecord;
  bundle: ResearchPromptBundle;
};

export type ResearchRunRequest = {
  sourceType: ResearchSourceType;
  sourceId?: string | null;
  sourceLabel?: string | null;
  watchlistRunId?: string | null;
  sourceBasis?: "compiled" | "unique";
  tickers?: string[];
  selectedTickers?: string[];
  profileId?: string | null;
  maxTickers?: number | null;
  refreshMode?: ResearchRefreshMode;
  rankingMode?: ResearchRankingMode;
  deepDiveTopN?: number | null;
};

export type ResearchRunRecord = {
  id: string;
  sourceType: ResearchSourceType;
  sourceId: string | null;
  sourceLabel: string | null;
  status: ResearchRunStatus;
  profileId: string;
  profileVersionId: string;
  requestedTickerCount: number;
  completedTickerCount: number;
  failedTickerCount: number;
  deepDiveTopN: number;
  refreshMode: ResearchRefreshMode;
  rankingMode: ResearchRankingMode;
  inputJson: Record<string, unknown> | null;
  providerUsageJson: Record<string, unknown> | null;
  provenanceJson: Record<string, unknown> | null;
  errorSummary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ResearchRunTickerRecord = {
  id: string;
  runId: string;
  ticker: string;
  sortOrder: number;
  companyName: string | null;
  exchange: string | null;
  secCik: string | null;
  irDomain: string | null;
  status: ResearchTickerStatus;
  attemptCount: number;
  lastError: string | null;
  previousSnapshotId: string | null;
  snapshotId: string | null;
  rankingRowId: string | null;
  normalizationJson: Record<string, unknown> | null;
  workingJson: Record<string, unknown> | null;
  stageMetricsJson: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ResearchEvidenceSnippet = {
  summary: string;
  excerpt?: string | null;
  bullets?: string[];
};

export type ResearchEvidenceRecord = {
  id: string;
  providerKey: ResearchProviderKey;
  sourceKind: ResearchEvidenceSourceKind;
  scopeKind: ResearchEvidenceScopeKind;
  ticker: string | null;
  secCik: string | null;
  canonicalUrl: string | null;
  sourceDomain: string | null;
  title: string;
  publishedAt: string | null;
  retrievedAt: string;
  contentHash: string;
  cacheKey: string;
  artifactSizeBytes: number | null;
  r2Key: string | null;
  snippet: ResearchEvidenceSnippet | null;
  metadata: Record<string, unknown> | null;
  providerPayload: Record<string, unknown> | null;
  createdAt: string;
};

export type ResearchEvidenceInput = Omit<ResearchEvidenceRecord, "createdAt">;

export type ResearchCatalyst = {
  title: string;
  summary: string;
  freshness: ResearchCatalystFreshnessLabel;
  direction: "positive" | "negative" | "mixed";
  evidenceIds: string[];
};

export type ResearchRisk = {
  title: string;
  summary: string;
  severity: "high" | "medium" | "low";
  evidenceIds: string[];
};

export type ResearchFactorCard = {
  key: string;
  score: number;
  direction: ResearchFactorDirection;
  confidenceScore: number;
  weightApplied: number;
  summary: string;
  evidenceIds: string[];
};

export type StandardizedResearchCard = {
  ticker: string;
  companyName: string | null;
  summary: string;
  valuation: {
    label: ResearchOpinionLabel;
    summary: string;
  };
  earningsQuality: {
    label: ResearchOpinionLabel;
    summary: string;
  };
  catalysts: ResearchCatalyst[];
  risks: ResearchRisk[];
  contradictions: string[];
  confidenceScore: number;
  confidenceLabel: ResearchConfidenceLabel;
  catalystFreshnessLabel: ResearchCatalystFreshnessLabel;
  riskLabel: ResearchRiskLabel;
  factorCards: ResearchFactorCard[];
  topEvidenceIds: string[];
  valuationScore: number;
  earningsQualityScore: number;
  catalystQualityScore: number;
  catalystFreshnessScore: number;
  riskScore: number;
  contradictionScore: number;
  model: string;
  reasoningBullets: string[];
};

export type ResearchRankingCard = {
  ticker: string;
  rank: number;
  attentionScore: number;
  priorityBucket: ResearchPriorityBucket;
  rankRationale: string;
  scoreDeltaVsPrevious: number | null;
  deepDiveRequested: boolean;
};

export type ResearchDeepDive = {
  summary: string;
  watchItems: string[];
  bullCase: string;
  bearCase: string;
  model: string;
};

export type ResearchSnapshotRecord = {
  id: string;
  runId: string;
  runTickerId: string;
  ticker: string;
  profileId: string;
  profileVersionId: string;
  previousSnapshotId: string | null;
  schemaVersion: string;
  overallScore: number | null;
  attentionRank: number | null;
  confidenceLabel: ResearchConfidenceLabel | null;
  confidenceScore: number | null;
  valuationLabel: ResearchOpinionLabel | null;
  earningsQualityLabel: ResearchOpinionLabel | null;
  catalystFreshnessLabel: ResearchCatalystFreshnessLabel | null;
  riskLabel: ResearchRiskLabel | null;
  contradictionFlag: boolean;
  thesisJson: Record<string, unknown>;
  changeJson: Record<string, unknown> | null;
  citationJson: Record<string, unknown> | null;
  modelOutputJson: Record<string, unknown> | null;
  createdAt: string;
};

export type ResearchFactorRecord = {
  id: string;
  snapshotId: string;
  ticker: string;
  factorKey: string;
  score: number;
  direction: ResearchFactorDirection;
  confidenceScore: number | null;
  weightApplied: number;
  explanationJson: Record<string, unknown> | null;
  supportingEvidenceIds: string[];
  createdAt: string;
};

export type ResearchRankingRecord = {
  id: string;
  runId: string;
  snapshotId: string;
  ticker: string;
  rank: number;
  attentionScore: number;
  priorityBucket: ResearchPriorityBucket;
  deepDiveRequested: boolean;
  deepDiveCompleted: boolean;
  rankingJson: Record<string, unknown> | null;
  createdAt: string;
};

export type ResearchSnapshotComparison = {
  ticker: string;
  currentSnapshotId: string;
  previousSnapshotId: string | null;
  summary: string;
  thesisEvolution: string[];
  newCatalysts: string[];
  newRisks: string[];
  resolvedRisks: string[];
  contradictionsIntroduced: string[];
  contradictionsResolved: string[];
  scoreDelta: number | null;
  confidenceDelta: number | null;
};

export type ResearchRunListItem = {
  run: ResearchRunRecord;
  profileName: string | null;
  profileVersionNumber: number | null;
};

export type ResearchTickerResult = {
  snapshotId: string;
  ticker: string;
  companyName: string | null;
  overallScore: number | null;
  attentionRank: number | null;
  confidenceLabel: ResearchConfidenceLabel | null;
  confidenceScore: number | null;
  valuationLabel: ResearchOpinionLabel | null;
  earningsQualityLabel: ResearchOpinionLabel | null;
  catalystFreshnessLabel: ResearchCatalystFreshnessLabel | null;
  riskLabel: ResearchRiskLabel | null;
  contradictionFlag: boolean;
  summary: string;
  catalysts: ResearchCatalyst[];
  risks: ResearchRisk[];
  changeSummary: string | null;
  citations: Array<{ evidenceId: string; title: string; url: string | null; sourceDomain: string | null; publishedAt: string | null }>;
};

export type ResearchRunResultsResponse = {
  run: ResearchRunRecord;
  profile: ResearchProfileRecord | null;
  results: ResearchTickerResult[];
  providerUsage: Record<string, unknown> | null;
  warnings: string[];
};

export type ResearchRunStatusResponse = {
  run: ResearchRunRecord;
  profile: ResearchProfileRecord | null;
  tickers: ResearchRunTickerRecord[];
};

export type ResearchAdminVersionsResponse = {
  profiles: ResearchProfileDetail[];
  promptVersions: PromptVersionRecord[];
  rubricVersions: RubricVersionRecord[];
  searchTemplateVersions: SearchTemplateVersionRecord[];
};
