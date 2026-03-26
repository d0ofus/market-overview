export type ResearchRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "partial";

export type ResearchTickerStatus =
  | "queued"
  | "normalizing"
  | "retrieving"
  | "peer_context_ready"
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
export type ResearchEvidenceTopic =
  | "thesis"
  | "market_pricing"
  | "earnings_quality"
  | "catalysts"
  | "risks"
  | "contradictions"
  | "valuation"
  | "thematic_fit"
  | "setup_quality"
  | "peer_comparison"
  | "macro_context"
  | "general";

export type ResearchPriorityBucket = "high" | "medium" | "monitor";

export type ResearchConfidenceLabel = "high" | "medium" | "low";
export type ResearchOpinionLabel = "positive" | "mixed" | "negative" | "unclear";
export type ResearchValuationLabel =
  | "attractive"
  | "fair"
  | "full"
  | "stretched"
  | "cheap"
  | "somewhat_cheap"
  | "somewhat_expensive"
  | "expensive"
  | "unclear";
export type ResearchSetupLabel = "high" | "medium" | "low" | "unclear";
export type ResearchThematicLabel = "strong" | "average" | "weak" | "unclear";
export type ResearchCatalystFreshnessLabel = "fresh" | "recent" | "stale" | "unclear";
export type ResearchRiskLabel = "low" | "moderate" | "high";
export type ResearchFactorDirection = "positive" | "neutral" | "negative" | "mixed";
export type ResearchSourceTrustClass = "filing" | "official" | "news" | "analyst" | "low_trust";
export type ResearchPeerComparisonConfidence = "high" | "medium" | "low";

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
  peerComparisonEnabled?: boolean;
  maxPeerCandidates?: number;
  maxTopicEvidenceItems?: number;
  maxEvidenceExcerptsPerTopic?: number;
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

export type ResearchEvidencePacketItem = {
  id: string;
  title: string;
  summary: string;
  excerpt: string | null;
  bullets: string[];
  url: string | null;
  sourceKind: ResearchEvidenceSourceKind;
  sourceDomain: string | null;
  sourceClass: ResearchSourceTrustClass;
  trustTier: 1 | 2 | 3 | 4 | 5;
  isOfficialSource: boolean;
  publishedAt: string | null;
  recencyDays: number | null;
};

export type TopicEvidencePacket = {
  topic: ResearchEvidenceTopic;
  label: string;
  items: ResearchEvidencePacketItem[];
  evidenceIds: string[];
  sourceClassBreakdown: Record<string, number>;
  confidenceScore: number;
};

export type ResearchEvidenceTopicSummary = {
  topic: ResearchEvidenceTopic;
  confidenceScore: number;
  trustWeightedCoverage: number;
  evidenceCount: number;
};

export type PeerContextMember = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  source: string | null;
  confidence: number | null;
  price: number | null;
  change1d: number | null;
  marketCap: number | null;
  avgVolume: number | null;
};

export type PeerContextPacket = {
  available: boolean;
  confidence: ResearchPeerComparisonConfidence;
  reasonUnavailable: string | null;
  peerGroupId: string | null;
  peerGroupName: string | null;
  source: "peer_groups" | "fallback" | "none";
  whyTheseAreClosestPeers: string;
  closestPeers: PeerContextMember[];
};

export type ResearchThesisOverview = {
  stance: ResearchOpinionLabel;
  oneParagraph: string;
  whyNow: string;
  whatWouldChangeMyMind: string;
  evidenceIds: string[];
};

export type ResearchMarketPricingBlock = {
  pricedInAssessment: "underappreciated" | "partially_priced_in" | "mostly_priced_in" | "fully_priced_in" | "unclear";
  whatExpectationsSeemEmbedded: string;
  whyUpsideDownsideMayStillRemain: string;
  evidenceIds: string[];
};

export type ResearchEarningsQualityDetailed = {
  revenueQuality: string;
  marginQuality: string;
  cashFlowQuality: string;
  guideQuality: string;
  beatOrMissQuality: string;
  oneOffsOrNoise: string;
  evidenceIds: string[];
};

export type ResearchCatalystAssessment = {
  title: string;
  summary: string;
  strength: "high" | "medium_high" | "medium" | "low" | "unclear";
  timing: "immediate" | "next_1_2_quarters" | "next_3_6_months" | "longer_term" | "unclear";
  durability: "high" | "medium_high" | "medium" | "low" | "unclear";
  pricedInStatus: "not_priced_in" | "partially_priced_in" | "mostly_priced_in" | "fully_priced_in" | "unclear";
  direction: "positive" | "negative" | "mixed";
  evidenceIds: string[];
};

export type ResearchRiskAssessment = {
  title: string;
  summary: string;
  severity: "high" | "medium" | "low";
  probability: "high" | "medium" | "low" | "unclear";
  timeframe: "near_term" | "medium_term" | "long_term" | "unclear";
  likelyImpact: string;
  evidenceIds: string[];
};

export type ResearchContradictionDetailed = {
  tension: string;
  whyItMatters: string;
  likelyDirectionIfResolved: string;
  evidenceIds: string[];
};

export type ResearchValuationView = {
  label: ResearchValuationLabel;
  summary: string;
  metricsReferenced: string[];
  relativeVsHistory: "below_history" | "near_history" | "above_history" | "unclear";
  relativeVsPeers: "cheap" | "somewhat_cheap" | "fair" | "somewhat_expensive" | "expensive" | "unclear";
  multipleRisk: "low" | "moderate" | "elevated" | "high" | "unclear";
  evidenceIds: string[];
};

export type ResearchThematicFit = {
  themeName: string;
  label: ResearchThematicLabel;
  durability: "high" | "medium" | "low" | "unclear";
  adoptionSignal: string;
  competitiveDensity: "low" | "moderate" | "high" | "unclear";
  evidenceIds: string[];
};

export type ResearchSetupQuality = {
  label: ResearchSetupLabel;
  summary: string;
  whatNeedsToHappenNext: string;
  invalidationTriggers: string[];
  evidenceIds: string[];
};

export type PeerRelativeBucket = "leader" | "above_average" | "average" | "below_average" | "laggard" | "unclear";
export type PeerRelativeValuationBucket = "cheap" | "somewhat_cheap" | "fair" | "somewhat_expensive" | "expensive" | "unclear";
export type PeerRelativePriceBucket = "leader" | "improving" | "neutral" | "weakening" | "laggard" | "unclear";
export type PeerRelativeFundamentalBucket = "leader" | "strong_contender" | "average" | "weak" | "laggard" | "unclear";

export type PeerComparisonBlock = {
  available: boolean;
  confidence: ResearchPeerComparisonConfidence;
  reasonUnavailable: string | null;
  peerGroupName: string | null;
  closestPeers: string[];
  whyTheseAreClosestPeers: string;
  earningsQualityRelative: PeerRelativeBucket;
  growthOutlookRelative: PeerRelativeBucket;
  historicalExecutionRelative: PeerRelativeBucket;
  valuationRelative: PeerRelativeValuationBucket;
  priceLeadershipRelative: PeerRelativePriceBucket;
  fundamentalLeadershipRelative: PeerRelativeFundamentalBucket;
  strategicPositionRelative: string;
  whatThisTickerDoesBetterThanPeers: string;
  whatPeersDoBetterThanThisTicker: string;
  peerRisksOrPeerAdvantages: string;
  evidenceIds: string[];
};

export type ResearchOverallConclusion = {
  thesis: string;
  bestBullArgument: string;
  bestBearArgument: string;
  keyWatchItems: string[];
  nextCatalystWindow: string;
  confidenceLabel: ResearchConfidenceLabel;
  confidenceScore: number;
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

export type ResearchDeterministicScoring = {
  baseAttentionScore: number;
  activeWeightTotal: number;
  peerFactorsActive: boolean;
  evidenceQualityScore: number;
  factorCards: ResearchFactorCard[];
};

export type StandardizedResearchCard = {
  ticker: string;
  companyName: string | null;
  thesisOverview: ResearchThesisOverview;
  marketPricing: ResearchMarketPricingBlock;
  earningsQualityDetailed: ResearchEarningsQualityDetailed;
  catalystAssessment: ResearchCatalystAssessment[];
  riskAssessment: ResearchRiskAssessment[];
  contradictionsDetailed: ResearchContradictionDetailed[];
  valuationView: ResearchValuationView;
  thematicFit: ResearchThematicFit;
  setupQuality: ResearchSetupQuality;
  peerComparison: PeerComparisonBlock;
  overallConclusion: ResearchOverallConclusion;
  evidenceTopicSummaries: ResearchEvidenceTopicSummary[];
  factorCards: ResearchFactorCard[];
  topEvidenceIds: string[];
  model: string;
  reasoningBullets: string[];
  summary: string;
  valuation: {
    label: ResearchValuationLabel;
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
  valuationScore: number;
  earningsQualityScore: number;
  catalystQualityScore: number;
  catalystFreshnessScore: number;
  riskScore: number;
  contradictionScore: number;
};

export type ResearchRankingCard = {
  ticker: string;
  rank: number;
  attentionScore: number;
  priorityBucket: ResearchPriorityBucket;
  rankRationale: string;
  scoreDeltaVsPrevious: number | null;
  deepDiveRequested: boolean;
  convictionLevel?: ResearchConfidenceLabel;
  relativeDifferentiation?: string;
  deterministicBaseScore?: number;
  deterministicAdjustmentNarrative?: string;
  peerImpactNarrative?: string;
};

export type ResearchDeepDive = {
  summary: string;
  watchItems: string[];
  bullCase: string;
  bearCase: string;
  actualSetup: string;
  pricedInView: string;
  underappreciatedView: string;
  evidencePriorities: string[];
  peerTake: string;
  leadershipView: string;
  invalidation: string;
  swingWorkflowSoWhat: string;
  evidenceIdsBySection: Record<string, string[]>;
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
  valuationLabel: ResearchValuationLabel | null;
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
  valuationLabel: ResearchValuationLabel | null;
  earningsQualityLabel: ResearchOpinionLabel | null;
  catalystFreshnessLabel: ResearchCatalystFreshnessLabel | null;
  riskLabel: ResearchRiskLabel | null;
  contradictionFlag: boolean;
  summary: string;
  catalysts: ResearchCatalyst[];
  risks: ResearchRisk[];
  changeSummary: string | null;
  pricedInAssessmentLabel?: ResearchMarketPricingBlock["pricedInAssessment"] | null;
  setupQualityLabel?: ResearchSetupLabel | null;
  thematicFitLabel?: ResearchThematicLabel | null;
  peerComparisonAvailable?: boolean;
  peerComparisonConfidence?: ResearchPeerComparisonConfidence | null;
  overallConclusion?: string | null;
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
