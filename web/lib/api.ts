import type { SnapshotResponse } from "@/types/dashboard";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8787";

export type AlertsSessionFilter = "all" | "premarket" | "regular" | "after-hours";

export type FedFundsPathRow = {
  meeting: string;
  meetingIso: string;
  impliedRatePostMeeting: number;
  probMovePct: number;
  probIsCut: boolean;
  numMoves: number;
  numMovesIsCut: boolean;
  changeBps: number;
};

export type FedFundsComparisonSeries = {
  key: "ago_1w" | "ago_3w" | "ago_6w" | "ago_10w";
  label: string;
  usedDate: string | null;
  effr: number | null;
  rows: Array<{
    meeting: string;
    meetingIso: string;
    implied: number;
  }>;
};

export type FedWatchData = {
  generatedAt: string;
  sourceUrl: string;
  asOf: string | null;
  currentBand: string | null;
  midpoint: number | null;
  mostRecentEffr: number | null;
  assumedMoveBps: number | null;
  rows: FedFundsPathRow[];
  comparisons: FedFundsComparisonSeries[];
};

export type FedWatchResponse = {
  status: "ok" | "stale" | "unavailable";
  warning: string | null;
  data: FedWatchData | null;
};

export type AlertLogRow = {
  id: string;
  ticker: string;
  alertType: string | null;
  strategyName: string | null;
  rawPayload: string | null;
  rawEmailSubject: string | null;
  rawEmailFrom: string | null;
  rawEmailReceivedAt: string | null;
  receivedAt: string;
  marketSession: "premarket" | "regular" | "after-hours";
  tradingDay: string;
  source: string;
  createdAt: string;
};

export type AlertNewsRow = {
  id: string;
  ticker: string;
  tradingDay: string;
  headline: string;
  source: string;
  url: string;
  publishedAt: string | null;
  snippet: string | null;
  fetchedAt: string;
};

export type AlertTickerDayRow = {
  ticker: string;
  tradingDay: string;
  latestReceivedAt: string;
  alertCount: number;
  marketSession: "premarket" | "regular" | "after-hours";
  price: number | null;
  change1d: number | null;
  marketCap: number | null;
  avgVolume: number | null;
  news: AlertNewsRow[];
};

export type ScanSourceType = "tradingview-public-link" | "csv-text" | "ticker-list";
export type ScanStatus = "ok" | "empty" | "error";

export type ScanRunSummary = {
  id: string;
  scanId: string;
  providerKey: string;
  status: ScanStatus;
  sourceType: ScanSourceType;
  sourceValue: string;
  fallbackUsed: boolean;
  rawResultCount: number;
  compiledRowCount: number;
  uniqueTickerCount: number;
  error: string | null;
  providerTraceJson: string | null;
  ingestedAt: string;
};

export type ScanDefinitionRow = {
  id: string;
  name: string;
  providerKey: string;
  sourceType: ScanSourceType;
  sourceValue: string;
  fallbackSourceType: ScanSourceType | null;
  fallbackSourceValue: string | null;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  latestRun: ScanRunSummary | null;
};

export type ScanCompiledRow = {
  id: string;
  runId: string;
  scanId: string;
  ticker: string;
  displayName: string | null;
  exchange: string | null;
  providerRowKey: string | null;
  rankValue: number | null;
  rankLabel: string | null;
  price: number | null;
  change1d: number | null;
  volume: number | null;
  marketCap: number | null;
  rawJson: string | null;
  canonicalKey: string;
  createdAt: string;
};

export type ScanUniqueTickerRow = {
  ticker: string;
  displayName: string | null;
  occurrences: number;
  latestRankValue: number | null;
  latestRankLabel: string | null;
  latestPrice: number | null;
  latestChange1d: number | null;
};

export type ScanRuleOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "in" | "not_in";

export type ScanRuleScalar = string | number | boolean;

export type ScanRuleFieldReference = {
  type: "field";
  field: string;
  multiplier?: number;
};

export type ScanRule = {
  id: string;
  field: string;
  operator: ScanRuleOperator;
  value: ScanRuleScalar | Array<ScanRuleScalar> | ScanRuleFieldReference;
};

export type ScanPresetType = "tradingview" | "relative-strength";
export type RelativeStrengthMaType = "SMA" | "EMA";
export type RelativeStrengthOutputMode = "all" | "rs_new_high_only" | "rs_new_high_before_price_only" | "both";

export type ScanPreset = {
  id: string;
  name: string;
  scanType: ScanPresetType;
  isDefault: boolean;
  isActive: boolean;
  rules: ScanRule[];
  prefilterRules: ScanRule[];
  benchmarkTicker: string | null;
  verticalOffset: number;
  rsMaLength: number;
  rsMaType: RelativeStrengthMaType;
  newHighLookback: number;
  outputMode: RelativeStrengthOutputMode;
  sortField: string;
  sortDirection: "asc" | "desc";
  rowLimit: number;
  createdAt: string;
  updatedAt: string;
};

export type ScanCompilePresetMember = {
  scanPresetId: string;
  scanPresetName: string;
  sortOrder: number;
};

export type ScanCompilePresetRow = {
  id: string;
  name: string;
  memberCount: number;
  presetIds: string[];
  presetNames: string[];
  createdAt: string;
  updatedAt: string;
};

export type ScanCompilePresetDetail = ScanCompilePresetRow & {
  members: ScanCompilePresetMember[];
};

export type ScanRow = {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  change1d: number | null;
  marketCap: number | null;
  relativeVolume: number | null;
  price: number | null;
  avgVolume: number | null;
  priceAvgVolume: number | null;
  rsClose: number | null;
  rsMa: number | null;
  rsAboveMa: boolean;
  rsNewHigh: boolean;
  rsNewHighBeforePrice: boolean;
  bullCross: boolean;
  approxRsRating: number | null;
  rawJson: string | null;
};

export type ScanSnapshot = {
  id: string;
  presetId: string;
  presetName: string;
  providerLabel: string;
  generatedAt: string;
  rowCount: number;
  matchedRowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
  rows: ScanRow[];
};

export type CompiledScanUniqueTickerRow = {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  occurrences: number;
  presetIds: string[];
  presetNames: string[];
  latestPrice: number | null;
  latestChange1d: number | null;
  latestMarketCap: number | null;
  latestRelativeVolume: number | null;
};

export type CompiledScansSnapshot = {
  compilePresetId: string | null;
  compilePresetName: string | null;
  presetIds: string[];
  presetNames: string[];
  generatedAt: string;
  rows: CompiledScanUniqueTickerRow[];
};

export type ScanCompilePresetRefreshMemberResult = {
  presetId: string;
  presetName: string;
  status: "ok" | "warning" | "error" | "empty" | "queued" | "running" | "completed" | "failed";
  rowCount: number;
  error: string | null;
  snapshot: ScanSnapshot | null;
  usableSnapshot: ScanSnapshot | null;
  usedFallback: boolean;
  includedInCompiled: boolean;
};

export type ScanCompilePresetRefreshResult = {
  compilePresetId: string;
  compilePresetName: string;
  refreshedCount: number;
  failedCount: number;
  snapshot: CompiledScansSnapshot;
  memberResults: ScanCompilePresetRefreshMemberResult[];
};

export type ScanRefreshJobStatus = "queued" | "running" | "completed" | "failed";

export type ScanRefreshJob = {
  id: string;
  presetId: string;
  presetName: string;
  jobType: "relative-strength";
  status: ScanRefreshJobStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  totalCandidates: number;
  processedCandidates: number;
  matchedCandidates: number;
  cursorOffset: number;
  latestSnapshotId: string | null;
  requestedBy: string | null;
  configKey: string | null;
  expectedTradingDate: string | null;
  fullCandidateCount: number;
  materializationCandidateCount: number;
  alreadyCurrentCandidateCount: number;
  lastAdvancedAt: string | null;
  deferredTickerCount: number;
  warning: string | null;
  phase: string | null;
  elapsedMs?: number | null;
  durationMs?: number | null;
  cacheHitCount?: number;
  computedCount?: number;
  missingBarsCount?: number;
  insufficientHistoryCount?: number;
  errorCount?: number;
  staleBenchmarkCount?: number;
  appliesToPreset?: boolean;
};

export type ScanRefreshResponse = {
  ok: boolean;
  async: boolean;
  snapshot: ScanSnapshot | null;
  job: ScanRefreshJob | null;
};

export type WatchlistCompilerRunSummary = ScanRunSummary;

export type WatchlistCompilerSetRow = {
  id: string;
  scanDefinitionId: string;
  name: string;
  slug: string;
  isActive: boolean;
  compileDaily: boolean;
  dailyCompileTimeLocal: string | null;
  dailyCompileTimezone: string | null;
  createdAt: string;
  updatedAt: string;
  sourceCount: number;
  latestRun: WatchlistCompilerRunSummary | null;
};

export type WatchlistCompilerSourceRow = {
  id: string;
  setId: string;
  sourceName: string | null;
  sourceUrl: string;
  sourceSections: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WatchlistCompilerSetDetail = WatchlistCompilerSetRow & {
  sources: WatchlistCompilerSourceRow[];
};

export type ResearchRefreshMode = "reuse_fresh_search_cache" | "force_fresh";
export type ResearchRankingMode = "rank_only" | "rank_and_deep_dive";
export type ResearchRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "partial";
export type ResearchTickerStatus = "queued" | "normalizing" | "retrieving" | "peer_context_ready" | "extracting" | "ranking_ready" | "deep_dive" | "completed" | "cancelled" | "failed" | "skipped";

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
  sourceFamilies: {
    sec: boolean;
    news: boolean;
    earningsTranscripts: boolean;
    investorRelations: boolean;
    analystCommentary: boolean;
  };
};

export type PromptVersionRow = {
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

export type RubricVersionRow = {
  id: string;
  versionNumber: number;
  label: string;
  schemaVersion: string;
  rubricJson: Record<string, unknown>;
  createdAt: string;
};

export type SearchTemplateVersionRow = {
  id: string;
  versionNumber: number;
  label: string;
  schemaVersion: string;
  templateJson: Record<string, unknown>;
  createdAt: string;
};

export type ResearchProfileVersionRow = {
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

export type ResearchProfileRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isDefault: boolean;
  currentVersionId: string | null;
  currentVersion: ResearchProfileVersionRow | null;
};

export type ResearchRunRow = {
  id: string;
  sourceType: "watchlist_set" | "manual";
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

export type ResearchRunListRow = {
  run: ResearchRunRow;
  profileName: string | null;
  profileVersionNumber: number | null;
};

export type ResearchRunTickerRow = {
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

export type ResearchCatalyst = {
  title: string;
  summary: string;
  freshness: "fresh" | "recent" | "stale" | "unclear";
  direction: "positive" | "negative" | "mixed";
  evidenceIds: string[];
};

export type ResearchRisk = {
  title: string;
  summary: string;
  severity: "high" | "medium" | "low";
  evidenceIds: string[];
};

export type ResearchTickerResult = {
  snapshotId: string;
  ticker: string;
  companyName: string | null;
  overallScore: number | null;
  attentionRank: number | null;
  confidenceLabel: "high" | "medium" | "low" | null;
  confidenceScore: number | null;
  valuationLabel: "attractive" | "fair" | "full" | "stretched" | "cheap" | "somewhat_cheap" | "somewhat_expensive" | "expensive" | "unclear" | null;
  earningsQualityLabel: "positive" | "mixed" | "negative" | "unclear" | null;
  catalystFreshnessLabel: "fresh" | "recent" | "stale" | "unclear" | null;
  riskLabel: "low" | "moderate" | "high" | null;
  contradictionFlag: boolean;
  summary: string;
  catalysts: ResearchCatalyst[];
  risks: ResearchRisk[];
  changeSummary: string | null;
  pricedInAssessmentLabel?: "underappreciated" | "partially_priced_in" | "mostly_priced_in" | "fully_priced_in" | "unclear" | null;
  setupQualityLabel?: "high" | "medium" | "low" | "unclear" | null;
  thematicFitLabel?: "strong" | "average" | "weak" | "unclear" | null;
  peerComparisonAvailable?: boolean;
  peerComparisonConfidence?: "high" | "medium" | "low" | null;
  overallConclusion?: string | null;
  citations: Array<{
    evidenceId: string;
    title: string;
    url: string | null;
    sourceDomain: string | null;
    publishedAt: string | null;
  }>;
};

export type ResearchRunStatusResponse = {
  run: ResearchRunRow;
  profile: ResearchProfileRow | null;
  tickers: ResearchRunTickerRow[];
};

export type ResearchRunResultsResponse = {
  run: ResearchRunRow;
  profile: ResearchProfileRow | null;
  results: ResearchTickerResult[];
  providerUsage: Record<string, unknown> | null;
  warnings: string[];
};

export type ResearchEvidenceRow = {
  id: string;
  providerKey: string;
  sourceKind: string;
  scopeKind: string;
  ticker: string | null;
  secCik: string | null;
  canonicalUrl: string | null;
  sourceDomain: string | null;
  title: string;
  publishedAt: string | null;
  retrievedAt: string;
  snippet: { summary: string; excerpt?: string | null; bullets?: string[] } | null;
  metadata: Record<string, unknown> | null;
};

export type ResearchFactorRow = {
  id: string;
  snapshotId: string;
  ticker: string;
  factorKey: string;
  score: number;
  direction: string;
  confidenceScore: number | null;
  weightApplied: number;
  explanationJson: Record<string, unknown> | null;
  supportingEvidenceIds: string[];
  createdAt: string;
};

export type ResearchSnapshotRow = {
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
  confidenceLabel: string | null;
  confidenceScore: number | null;
  valuationLabel: string | null;
  earningsQualityLabel: string | null;
  catalystFreshnessLabel: string | null;
  riskLabel: string | null;
  contradictionFlag: boolean;
  thesisJson: Record<string, unknown>;
  changeJson: Record<string, unknown> | null;
  citationJson: Record<string, unknown> | null;
  modelOutputJson: Record<string, unknown> | null;
  createdAt: string;
};

export type ResearchSnapshotDetailResponse = {
  snapshot: ResearchSnapshotRow;
  factors: ResearchFactorRow[];
  evidence: ResearchEvidenceRow[];
};

export type ResearchCardThesisOverview = {
  stance: "positive" | "mixed" | "negative" | "unclear";
  oneParagraph: string;
  whyNow: string;
  whatWouldChangeMyMind: string;
  evidenceIds: string[];
};

export type ResearchCardMarketPricing = {
  pricedInAssessment: "underappreciated" | "partially_priced_in" | "mostly_priced_in" | "fully_priced_in" | "unclear";
  whatExpectationsSeemEmbedded: string;
  whyUpsideDownsideMayStillRemain: string;
  evidenceIds: string[];
};

export type ResearchCardEarningsQualityDetailed = {
  revenueQuality: string;
  marginQuality: string;
  cashFlowQuality: string;
  guideQuality: string;
  beatOrMissQuality: string;
  oneOffsOrNoise: string;
  evidenceIds: string[];
};

export type ResearchCardCatalystAssessment = {
  title: string;
  summary: string;
  strength: string;
  timing: string;
  durability: string;
  pricedInStatus: string;
  direction: "positive" | "negative" | "mixed";
  evidenceIds: string[];
};

export type ResearchCardRiskAssessment = {
  title: string;
  summary: string;
  severity: "high" | "medium" | "low";
  probability: string;
  timeframe: string;
  likelyImpact: string;
  evidenceIds: string[];
};

export type ResearchCardContradiction = {
  tension: string;
  whyItMatters: string;
  likelyDirectionIfResolved: string;
  evidenceIds: string[];
};

export type ResearchCardValuationView = {
  label: string;
  summary: string;
  metricsReferenced: string[];
  relativeVsHistory: string;
  relativeVsPeers: string;
  multipleRisk: string;
  evidenceIds: string[];
};

export type ResearchCardThematicFit = {
  themeName: string;
  label: "strong" | "average" | "weak" | "unclear";
  durability: string;
  adoptionSignal: string;
  competitiveDensity: string;
  evidenceIds: string[];
};

export type ResearchCardSetupQuality = {
  label: "high" | "medium" | "low" | "unclear";
  summary: string;
  whatNeedsToHappenNext: string;
  invalidationTriggers: string[];
  evidenceIds: string[];
};

export type ResearchCardPeerComparison = {
  available: boolean;
  confidence: "high" | "medium" | "low";
  reasonUnavailable: string | null;
  peerGroupName: string | null;
  closestPeers: string[];
  whyTheseAreClosestPeers: string;
  earningsQualityRelative: string;
  growthOutlookRelative: string;
  historicalExecutionRelative: string;
  valuationRelative: string;
  priceLeadershipRelative: string;
  fundamentalLeadershipRelative: string;
  strategicPositionRelative: string;
  whatThisTickerDoesBetterThanPeers: string;
  whatPeersDoBetterThanThisTicker: string;
  peerRisksOrPeerAdvantages: string;
  evidenceIds: string[];
};

export type ResearchCardOverallConclusion = {
  thesis: string;
  bestBullArgument: string;
  bestBearArgument: string;
  keyWatchItems: string[];
  nextCatalystWindow: string;
  confidenceLabel: "high" | "medium" | "low";
  confidenceScore: number;
  evidenceIds: string[];
};

export type ResearchDeepDiveV2 = {
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

export type ResearchSnapshotCompareResponse = {
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

export type GapperNewsItem = {
  headline: string;
  source: string;
  url: string;
  publishedAt: string | null;
  snippet: string | null;
};

export type GapperAnalysis = {
  summary: string;
  freshnessLabel: "fresh" | "stale" | "unclear";
  freshnessScore: number;
  impactLabel: "high" | "medium" | "low" | "noise";
  impactScore: number;
  liquidityRiskLabel: "normal" | "thin" | "likely-order-driven";
  liquidityRiskScore: number;
  compositeScore: number;
  reasoningBullets: string[];
  model: string;
};

export type GapperRow = {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  price: number;
  prevClose: number;
  premarketPrice: number;
  gapPct: number;
  premarketVolume: number;
  news: GapperNewsItem[];
  analysis: GapperAnalysis | null;
  compositeScore: number | null;
};

export type GappersSnapshot = {
  id: string;
  marketSession: string;
  providerLabel: string;
  generatedAt: string;
  rowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
  warning: string | null;
  rows: GapperRow[];
};

export type LlmProvider = "openai" | "anthropic";

export type GappersLlmConfig = {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl?: string | null;
};

export type GappersScanFilters = {
  limit: number;
  minMarketCap?: number | null;
  maxMarketCap?: number | null;
  industries?: string[];
  minPrice?: number | null;
  maxPrice?: number | null;
  minGapPct?: number | null;
  maxGapPct?: number | null;
};

export type PeerGroupType = "fundamental" | "technical" | "custom";
export type PeerMembershipSource = "manual" | "fmp_seed" | "finnhub_seed" | "system";

export type PeerGroupRow = {
  id: string;
  slug: string;
  name: string;
  groupType: PeerGroupType;
  description: string | null;
  priority: number;
  isActive: boolean;
  memberCount?: number;
};

export type PeerDirectoryRow = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  symbolIsActive: boolean;
  listingSource: string | null;
  groups: PeerGroupRow[];
};

export type PeerTickerMember = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  source: PeerMembershipSource;
  confidence: number | null;
};

export type PeerTickerDetail = {
  symbol: {
    ticker: string;
    name: string | null;
    exchange: string | null;
    sector: string | null;
    industry: string | null;
    sharesOutstanding: number | null;
    persisted: boolean;
    isActive: boolean;
    listingSource: string | null;
    catalogManaged: boolean;
    catalogLastSeenAt: string | null;
    deactivatedAt: string | null;
  };
  groups: Array<PeerGroupRow & { members: PeerTickerMember[] }>;
};

export type SymbolCatalogStatus = {
  sourceKey: string;
  scheduledEnabled: boolean;
  schemaReady: boolean;
  lastSyncedAt: string | null;
  status: string | null;
  error: string | null;
  recordsCount: number | null;
  updatedAt: string | null;
  totalCount: number;
  activeCount: number;
  inactiveCount: number;
  manualCount: number;
  catalogManagedCount: number;
};

export type WorkerScheduleSettings = {
  id: string;
  cronExpression: string;
  rsBackgroundEnabled: boolean;
  rsBackgroundBatchSize: number;
  rsBackgroundMaxBatchesPerTick: number;
  rsBackgroundTimeBudgetMs: number;
  rsManualCacheReuseEnabled: boolean;
  rsSharedConfigSnapshotFanoutEnabled: boolean;
  postCloseBarsEnabled: boolean;
  postCloseBarsOffsetMinutes: number;
  postCloseBarsBatchSize: number;
  postCloseBarsMaxBatchesPerTick: number;
};

export type PeerMetricRow = {
  ticker: string;
  price: number | null;
  change1d: number | null;
  marketCap: number | null;
  avgVolume: number | null;
  asOf: string;
  source: string;
};

export type CorrelationLookback = "60D" | "120D" | "252D" | "2Y" | "5Y";
export type CorrelationRollingWindow = "20D" | "60D" | "120D";
export type CorrelationTickerStatus = "ok" | "stale";

export type CorrelationResolvedTicker = {
  ticker: string;
  displayName: string | null;
  lastBarDate: string | null;
  barCount: number;
  status: CorrelationTickerStatus;
};

export type CorrelationUnresolvedTicker = {
  ticker: string;
  reason: "unknown_ticker" | "missing_history";
};

export type CorrelationMatrixResponse = {
  requestedTickers: string[];
  lookback: CorrelationLookback;
  returnPeriods: number;
  generatedAt: string;
  expectedAsOfDate: string;
  latestAvailableDate: string | null;
  resolvedTickers: CorrelationResolvedTicker[];
  unresolvedTickers: CorrelationUnresolvedTicker[];
  matrix: Array<Array<number | null>>;
  overlapCounts: number[][];
  warnings: string[];
  defaultPair: { left: string; right: string } | null;
};

export type CorrelationPairResponse = {
  lookback: CorrelationLookback;
  rollingWindow: CorrelationRollingWindow;
  generatedAt: string;
  warnings: string[];
  pair: {
    left: CorrelationResolvedTicker;
    right: CorrelationResolvedTicker;
    overlapStartDate: string | null;
    overlapEndDate: string | null;
    priceObservationCount: number;
    returnObservationCount: number;
  };
  overview: {
    normalizedSeries: Array<{ date: string; left: number; right: number }>;
    regressionPoints: Array<{ date: string; x: number; y: number }>;
    regressionLine: Array<{ x: number; y: number }>;
    stats: {
      beta: number | null;
      intercept: number | null;
      correlation: number | null;
      rSquared: number | null;
      observationCount: number;
    };
  };
  spread: {
    series: Array<{
      date: string;
      spread: number;
      mean: number | null;
      upper2Sigma: number | null;
      lower2Sigma: number | null;
      zScore: number | null;
    }>;
    latest: {
      spread: number | null;
      zScore: number | null;
    };
  };
  dynamics: {
    rollingCorrelation: Array<{ date: string; value: number | null }>;
    leadLag: {
      confidenceBand: number | null;
      bestLag: { lag: number; correlation: number; observationCount: number } | null;
      rows: Array<{ lag: number; correlation: number | null; observationCount: number }>;
    };
    lagOverlay: Array<{ date: string; left: number | null; right: number | null }>;
  };
};

function sortNewsNewestFirst<T extends { publishedAt: string | null; fetchedAt?: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const left = Date.parse(a.publishedAt ?? a.fetchedAt ?? "") || 0;
    const right = Date.parse(b.publishedAt ?? b.fetchedAt ?? "") || 0;
    return right - left;
  });
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json() as { error?: string };
      if (body?.error) detail = ` - ${body.error}`;
    } catch {
      // no-op
    }
    throw new Error(`API ${path} failed: ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

function appendQuery(path: string, query: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === "") continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  if (!encoded) return path;
  return `${path}?${encoded}`;
}

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function getDashboard(date?: string): Promise<SnapshotResponse> {
  return getJson(`/api/dashboard${date ? `?date=${date}` : ""}`);
}

export function getStatus(page?: "overview" | "breadth"): Promise<{
  timezone: string;
  autoRefreshLabel: string;
  autoRefreshLocalTime?: string;
  lastUpdated: string | null;
  asOfDate: string | null;
  providerLabel: string;
}> {
  const query = page ? `?page=${page}` : "";
  return getJson(`/api/status${query}`);
}

export function getBreadth(universeId = "sp500-core") {
  return getJson<{ requestedUniverseId: string; universeId: string; rows: any[] }>(`/api/breadth?universeId=${universeId}&limit=120`);
}

export function getFedWatch(force = false) {
  return getJson<FedWatchResponse>(appendQuery("/api/fedwatch", { force: force ? 1 : undefined }));
}

export function getBreadthSummary() {
  return getJson<{ asOfDate: string | null; rows: any[]; unavailable: Array<{ id: string; name: string; reason: string }> }>("/api/breadth/summary");
}

export function getTicker(ticker: string) {
  return getJson<{
    symbol: { ticker: string; name: string; exchange: string };
    series: Array<{ date: string; c: number }>;
    tradingViewEnabled: boolean;
  }>(`/api/ticker/${ticker}`);
}

export function getCorrelationMatrix(params: {
  tickers: string;
  lookback?: CorrelationLookback;
}) {
  return getJson<CorrelationMatrixResponse>(appendQuery("/api/correlation/matrix", {
    tickers: params.tickers,
    lookback: params.lookback ?? "252D",
  }));
}

export function getCorrelationPair(params: {
  left: string;
  right: string;
  lookback?: CorrelationLookback;
  rollingWindow?: CorrelationRollingWindow;
}) {
  return getJson<CorrelationPairResponse>(appendQuery("/api/correlation/pair", {
    left: params.left,
    right: params.right,
    lookback: params.lookback ?? "252D",
    rollingWindow: params.rollingWindow ?? "60D",
  }));
}

export function get13fOverview() {
  return getJson<{ managers: any[]; topHoldings: any[] }>("/api/13f/overview");
}

export function get13fManager(id: string) {
  return getJson<{ manager: any; reports: any[]; latestHoldings: any[] }>(`/api/13f/manager/${id}`);
}

export function getSectorTrending(days = 30) {
  return getJson<{ days: number; sectors: any[] }>(`/api/sectors/trending?days=${days}`);
}

export function getSectorEtfs() {
  return getJson<{ rows: any[] }>("/api/etfs/sector");
}

export function getIndustryEtfs() {
  return getJson<{ rows: any[] }>("/api/etfs/industry");
}

export function getEtfConstituents(ticker: string, forceSync = false) {
  return getJson<{ etf: any; rows: any[]; syncStatus: any; warning: string | null }>(`/api/etf/${ticker}/constituents${forceSync ? "?force=1" : ""}`);
}

export function getSectorEntries() {
  return getJson<{ rows: any[] }>("/api/sectors/entries");
}

export function getSectorCalendar(month: string) {
  return getJson<{ month: string; rows: any[] }>(`/api/sectors/calendar?month=${month}`);
}

export function getSectorNarratives() {
  return getJson<{ rows: any[] }>("/api/sectors/narratives");
}

export function getSectorSymbolOptions(sector?: string) {
  return getJson<{ rows: any[] }>(`/api/sectors/symbol-options${sector ? `?sector=${encodeURIComponent(sector)}` : ""}`);
}

export function getSectorTickerMetrics(tickers: string[]) {
  const uniqueTickers = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  return getJson<{ rows: PeerMetricRow[]; error: string | null }>(
    appendQuery("/api/sectors/metrics", { tickers: uniqueTickers.join(",") }),
  );
}

export function getAlerts(params: {
  startDate?: string;
  endDate?: string;
  session?: AlertsSessionFilter;
  limit?: number;
}) {
  return getJson<{ filters: { startDate: string; endDate: string; session: AlertsSessionFilter; limit: number }; rows: AlertLogRow[] }>(
    appendQuery("/api/alerts", params),
  );
}

export function getAlertTickerDays(params: {
  startDate?: string;
  endDate?: string;
  session?: AlertsSessionFilter;
  limit?: number;
  offset?: number;
}) {
  return getJson<{
    filters: { startDate: string; endDate: string; session: AlertsSessionFilter; limit: number };
    total: number;
    limit: number;
    offset: number;
    rows: AlertTickerDayRow[];
  }>(
    appendQuery("/api/alerts/unique-tickers", params),
  );
}

export function getAlertNews(ticker: string, tradingDay: string) {
  return getJson<{ ticker: string; tradingDay: string; rows: AlertNewsRow[] }>(
    appendQuery("/api/alerts/news", { ticker, tradingDay }),
  );
}

export function getTickerNews(ticker: string, tradingDay?: string | null, limit = 5) {
  return getJson<{ ticker: string; tradingDay: string; providersTried?: string[]; rows: AlertNewsRow[] }>(
    appendQuery(`/api/ticker/${encodeURIComponent(ticker)}/news`, {
      tradingDay: tradingDay ?? undefined,
      limit,
    }),
  ).then((payload) => ({
    ...payload,
    rows: sortNewsNewestFirst(payload.rows ?? []),
  }));
}

export function getScansSnapshot(presetId?: string | null) {
  return getJson<ScanSnapshot>(appendQuery("/api/scans", { presetId: presetId ?? undefined }));
}

export function getScanExportUrl(presetId?: string | null, dateSuffix?: string | null) {
  return apiUrl(appendQuery("/api/scans/export.txt", {
    presetId: presetId ?? undefined,
    dateSuffix: dateSuffix ?? undefined,
  }));
}

export function getScanPresets() {
  return getJson<{ rows: ScanPreset[] }>("/api/scans/presets");
}

export function getScanCompilePresets() {
  return getJson<{ rows: ScanCompilePresetRow[] }>("/api/scans/compile-presets");
}

export function getScanCompilePreset(id: string) {
  return getJson<ScanCompilePresetDetail>(`/api/scans/compile-presets/${encodeURIComponent(id)}`);
}

export function getCompiledScansSnapshot(presetIds: string[]) {
  return getJson<CompiledScansSnapshot>(appendQuery("/api/scans/compiled", {
    presetIds: presetIds.join(","),
  }));
}

export function getCompiledScansExportUrl(presetIds: string[], dateSuffix?: string | null) {
  return apiUrl(appendQuery("/api/scans/compiled/export.txt", {
    presetIds: presetIds.join(","),
    dateSuffix: dateSuffix ?? undefined,
  }));
}

export function getScanCompilePresetSnapshot(id: string) {
  return getJson<CompiledScansSnapshot>(`/api/scans/compile-presets/${encodeURIComponent(id)}/compiled`);
}

export function getScanCompilePresetExportUrl(id: string, dateSuffix?: string | null) {
  return apiUrl(appendQuery(`/api/scans/compile-presets/${encodeURIComponent(id)}/export.txt`, {
    dateSuffix: dateSuffix ?? undefined,
  }));
}

export function refreshScansSnapshot(presetId?: string | null) {
  return adminFetch<ScanRefreshResponse>("/api/admin/scans/refresh", {
    method: "POST",
    body: JSON.stringify({ presetId: presetId ?? null }),
  });
}

export function getLatestScanRefreshJob(presetId: string) {
  return adminFetch<{ ok: boolean; snapshot: ScanSnapshot | null; job: ScanRefreshJob | null }>(
    appendQuery("/api/admin/scans/refresh-jobs/latest", { presetId }),
  );
}

export function getScanRefreshJob(jobId: string) {
  return adminFetch<{ ok: boolean; snapshot: ScanSnapshot | null; job: ScanRefreshJob | null }>(
    `/api/admin/scans/refresh-jobs/${encodeURIComponent(jobId)}`,
  );
}

export function refreshScanCompilePreset(id: string) {
  return adminFetch<{ ok: boolean } & ScanCompilePresetRefreshResult>(
    `/api/admin/scans/compile-presets/${encodeURIComponent(id)}/refresh`,
    { method: "POST" },
  );
}

export function createScanPreset(payload: {
  name: string;
  scanType?: ScanPresetType;
  isDefault?: boolean;
  isActive?: boolean;
  rules?: ScanRule[];
  prefilterRules?: ScanRule[];
  benchmarkTicker?: string | null;
  verticalOffset?: number;
  rsMaLength?: number;
  rsMaType?: RelativeStrengthMaType;
  newHighLookback?: number;
  outputMode?: RelativeStrengthOutputMode;
  sortField?: string;
  sortDirection?: "asc" | "desc";
  rowLimit?: number;
}) {
  return adminFetch<{ ok: boolean; preset: ScanPreset }>("/api/admin/scans/presets", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateScanPreset(id: string, payload: {
  name?: string;
  scanType?: ScanPresetType;
  isDefault?: boolean;
  isActive?: boolean;
  rules?: ScanRule[];
  prefilterRules?: ScanRule[];
  benchmarkTicker?: string | null;
  verticalOffset?: number;
  rsMaLength?: number;
  rsMaType?: RelativeStrengthMaType;
  newHighLookback?: number;
  outputMode?: RelativeStrengthOutputMode;
  sortField?: string;
  sortDirection?: "asc" | "desc";
  rowLimit?: number;
}) {
  return adminFetch<{ ok: boolean; preset: ScanPreset }>(`/api/admin/scans/presets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function duplicateScanPreset(id: string) {
  return adminFetch<{ ok: boolean; preset: ScanPreset }>(`/api/admin/scans/presets/${encodeURIComponent(id)}/duplicate`, {
    method: "POST",
  });
}

export function deleteScanPreset(id: string) {
  return adminFetch<{ ok: boolean; presetId: string }>(`/api/admin/scans/presets/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function createScanCompilePreset(payload: {
  name: string;
  scanPresetIds: string[];
}) {
  return adminFetch<{ ok: boolean; preset: ScanCompilePresetDetail }>("/api/admin/scans/compile-presets", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateScanCompilePreset(id: string, payload: {
  name?: string;
  scanPresetIds?: string[];
}) {
  return adminFetch<{ ok: boolean; preset: ScanCompilePresetDetail }>(`/api/admin/scans/compile-presets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteScanCompilePreset(id: string) {
  return adminFetch<{ ok: boolean; compilePresetId: string }>(`/api/admin/scans/compile-presets/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function getWatchlistCompilerSets(includeInactive = false) {
  return getJson<{ rows: WatchlistCompilerSetRow[] }>(
    appendQuery("/api/watchlist-compiler/sets", { includeInactive: includeInactive ? 1 : undefined }),
  );
}

export function getWatchlistCompilerSet(id: string) {
  return getJson<WatchlistCompilerSetDetail>(`/api/watchlist-compiler/sets/${encodeURIComponent(id)}`);
}

export function getWatchlistCompilerRuns(id: string, limit = 25) {
  return getJson<{ rows: WatchlistCompilerRunSummary[] }>(
    appendQuery(`/api/watchlist-compiler/sets/${encodeURIComponent(id)}/runs`, { limit }),
  );
}

export function getWatchlistCompilerCompiled(id: string, runId?: string | null) {
  return getJson<{ set: WatchlistCompilerSetDetail; runId: string | null; rows: ScanCompiledRow[] }>(
    appendQuery(`/api/watchlist-compiler/sets/${encodeURIComponent(id)}/compiled`, { runId: runId ?? undefined }),
  );
}

export function getWatchlistCompilerUnique(id: string, runId?: string | null) {
  return getJson<{ set: WatchlistCompilerSetDetail; runId: string | null; rows: ScanUniqueTickerRow[] }>(
    appendQuery(`/api/watchlist-compiler/sets/${encodeURIComponent(id)}/unique`, { runId: runId ?? undefined }),
  );
}

export function getWatchlistCompilerExportUrl(
  id: string,
  format: "csv" | "txt",
  mode: "compiled" | "unique",
  options?: { runId?: string | null; dateSuffix?: string | null },
) {
  return apiUrl(appendQuery(`/api/watchlist-compiler/sets/${encodeURIComponent(id)}/export.${format}`, {
    mode,
    runId: options?.runId ?? undefined,
    dateSuffix: options?.dateSuffix ?? undefined,
  }));
}

export function getAdminWatchlistCompilerSets() {
  return adminFetch<{ rows: WatchlistCompilerSetRow[] }>("/api/admin/watchlist-compiler/sets");
}

export function createAdminWatchlistCompilerSet(payload: {
  name: string;
  slug?: string | null;
  isActive?: boolean;
  compileDaily?: boolean;
  dailyCompileTimeLocal?: string | null;
  dailyCompileTimezone?: string | null;
}) {
  return adminFetch<{ ok: boolean; id: string }>("/api/admin/watchlist-compiler/sets", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateAdminWatchlistCompilerSet(id: string, payload: {
  name?: string;
  slug?: string | null;
  isActive?: boolean;
  compileDaily?: boolean;
  dailyCompileTimeLocal?: string | null;
  dailyCompileTimezone?: string | null;
}) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/watchlist-compiler/sets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteAdminWatchlistCompilerSet(id: string) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/watchlist-compiler/sets/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function createAdminWatchlistCompilerSource(setId: string, payload: { sourceName?: string | null; sourceUrl: string; sourceSections?: string | null; isActive?: boolean }) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/watchlist-compiler/sets/${encodeURIComponent(setId)}/sources`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateAdminWatchlistCompilerSource(id: string, payload: { sourceName?: string | null; sourceUrl?: string; sourceSections?: string | null; sortOrder?: number; isActive?: boolean }) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/watchlist-compiler/sources/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteAdminWatchlistCompilerSource(id: string) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/watchlist-compiler/sources/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function compileAdminWatchlistCompilerSet(id: string) {
  return adminFetch<{ ok: boolean; run: WatchlistCompilerRunSummary; set: WatchlistCompilerSetDetail }>(
    `/api/admin/watchlist-compiler/sets/${encodeURIComponent(id)}/compile`,
    { method: "POST" },
  );
}

export function getResearchProfiles() {
  return getJson<{ rows: ResearchProfileRow[] }>("/api/research/profiles");
}

export function getResearchRuns(params?: { sourceType?: string | null; sourceId?: string | null; limit?: number }) {
  return getJson<{ rows: ResearchRunListRow[] }>(appendQuery("/api/research/runs", {
    sourceType: params?.sourceType ?? undefined,
    sourceId: params?.sourceId ?? undefined,
    limit: params?.limit,
  }));
}

export function getResearchRunStatus(id: string) {
  return getJson<ResearchRunStatusResponse>(`/api/research/runs/${encodeURIComponent(id)}`);
}

export function getResearchRunResults(id: string) {
  return getJson<ResearchRunResultsResponse>(`/api/research/runs/${encodeURIComponent(id)}/results`);
}

export function getTickerResearchHistory(ticker: string, profileId?: string | null) {
  return getJson<{ rows: ResearchSnapshotRow[] }>(appendQuery(`/api/research/ticker/${encodeURIComponent(ticker)}/history`, {
    profileId: profileId ?? undefined,
  }));
}

export function getResearchSnapshot(id: string) {
  return getJson<ResearchSnapshotDetailResponse>(`/api/research/snapshots/${encodeURIComponent(id)}`);
}

export function getResearchSnapshotCompare(id: string, baselineSnapshotId?: string | null) {
  return getJson<ResearchSnapshotCompareResponse>(appendQuery(`/api/research/snapshots/${encodeURIComponent(id)}/compare`, {
    baselineSnapshotId: baselineSnapshotId ?? undefined,
  }));
}

export function getAdminResearchProfiles() {
  return adminFetch<{
    profiles: ResearchProfileRow[];
    promptVersions: PromptVersionRow[];
    rubricVersions: RubricVersionRow[];
    searchTemplateVersions: SearchTemplateVersionRow[];
  }>("/api/admin/research/profiles");
}

export function createAdminResearchRun(payload: {
  sourceType: "watchlist_set" | "manual";
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
}) {
  return adminFetch<{ ok: boolean; run: ResearchRunRow }>("/api/admin/research/runs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function cancelAdminResearchRun(id: string) {
  return adminFetch<{ ok: boolean; run: ResearchRunRow }>(`/api/admin/research/runs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
}

export function createAdminResearchProfile(payload: {
  slug: string;
  name: string;
  description?: string | null;
  isActive?: boolean;
  isDefault?: boolean;
}) {
  return adminFetch<{ ok: boolean; id: string }>("/api/admin/research/profiles", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateAdminResearchProfile(id: string, payload: {
  slug?: string;
  name?: string;
  description?: string | null;
  isActive?: boolean;
  isDefault?: boolean;
  currentVersionId?: string | null;
}) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/research/profiles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function createAdminResearchProfileVersion(id: string, payload: {
  promptVersionIdHaiku: string;
  promptVersionIdSonnetRank: string;
  promptVersionIdSonnetDeepDive: string;
  rubricVersionId: string;
  searchTemplateVersionId: string;
  settings: ResearchProfileSettings;
  activate?: boolean;
}) {
  return adminFetch<{ ok: boolean; id: string; versionNumber: number }>(`/api/admin/research/profiles/${encodeURIComponent(id)}/versions`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createAdminPromptVersion(payload: {
  promptKind: "haiku_extract" | "sonnet_rank" | "sonnet_deep_dive";
  label: string;
  providerKey?: string;
  modelFamily: string;
  schemaVersion?: string;
  templateText?: string | null;
  templateJson?: Record<string, unknown> | null;
}) {
  return adminFetch<{ ok: boolean; id: string }>("/api/admin/research/prompt-versions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createAdminRubricVersion(payload: {
  label: string;
  schemaVersion?: string;
  rubricJson: Record<string, unknown>;
}) {
  return adminFetch<{ ok: boolean; id: string }>("/api/admin/research/rubric-versions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createAdminSearchTemplateVersion(payload: {
  label: string;
  schemaVersion?: string;
  templateJson: Record<string, unknown>;
}) {
  return adminFetch<{ ok: boolean; id: string }>("/api/admin/research/search-template-versions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getGappers(limit = 50, force = false, filters?: GappersScanFilters | null) {
  return getJson<GappersSnapshot>(appendQuery("/api/gappers", {
    limit,
    force: force ? 1 : undefined,
    minMarketCap: filters?.minMarketCap,
    maxMarketCap: filters?.maxMarketCap,
    industries: filters?.industries?.join(","),
    minPrice: filters?.minPrice,
    maxPrice: filters?.maxPrice,
    minGapPct: filters?.minGapPct,
    maxGapPct: filters?.maxGapPct,
  }));
}

export function getGappersWithConfig(
  limit = 50,
  force = false,
  llmConfig?: GappersLlmConfig | null,
  filters?: GappersScanFilters | null,
) {
  const headers: Record<string, string> = {};
  if (llmConfig?.provider) headers["x-llm-provider"] = llmConfig.provider;
  if (llmConfig?.apiKey) headers["x-llm-api-key"] = llmConfig.apiKey;
  if (llmConfig?.model) headers["x-llm-model"] = llmConfig.model;
  if (llmConfig?.baseUrl) headers["x-llm-base-url"] = llmConfig.baseUrl;
  return getJson<GappersSnapshot>(appendQuery("/api/gappers", {
    limit,
    force: force ? 1 : undefined,
    minMarketCap: filters?.minMarketCap,
    maxMarketCap: filters?.maxMarketCap,
    industries: filters?.industries?.join(","),
    minPrice: filters?.minPrice,
    maxPrice: filters?.maxPrice,
    minGapPct: filters?.minGapPct,
    maxGapPct: filters?.maxGapPct,
  }), { headers });
}

export function getPeerGroups(includeInactive = false) {
  return getJson<{ rows: PeerGroupRow[] }>(appendQuery("/api/peer-groups/groups", { includeInactive: includeInactive ? 1 : undefined }));
}

export function getPeerDirectory(params: {
  q?: string;
  groupId?: string;
  groupType?: PeerGroupType | "";
  active?: "1" | "0" | "";
  limit?: number;
  offset?: number;
}) {
  return getJson<{ rows: PeerDirectoryRow[]; total: number; limit: number; offset: number }>(
    appendQuery("/api/peer-groups/directory", params),
  );
}

export function getPeerTickerDetail(ticker: string) {
  return getJson<PeerTickerDetail>(`/api/peer-groups/ticker/${encodeURIComponent(ticker)}`);
}

export function getPeerTickerMetrics(ticker: string) {
  return getJson<{ ticker: string; rows: PeerMetricRow[]; error: string | null }>(
    `/api/peer-groups/ticker/${encodeURIComponent(ticker)}/metrics`,
  );
}

export function getAdminPeerGroups() {
  return adminFetch<{ rows: PeerGroupRow[] }>("/api/admin/peer-groups");
}

export function createAdminPeerGroup(payload: {
  name: string;
  slug?: string | null;
  groupType?: PeerGroupType;
  description?: string | null;
  priority?: number;
  isActive?: boolean;
}) {
  return adminFetch<{ ok: boolean; id: string }>("/api/admin/peer-groups", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateAdminPeerGroup(id: string, payload: {
  name?: string;
  slug?: string | null;
  groupType?: PeerGroupType;
  description?: string | null;
  priority?: number | null;
  isActive?: boolean;
}) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/peer-groups/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteAdminPeerGroup(id: string) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/peer-groups/${id}`, {
    method: "DELETE",
  });
}

export function searchAdminPeerTickers(q: string) {
  return adminFetch<{ rows: Array<{ ticker: string; name: string | null; exchange: string | null; sector: string | null; industry: string | null }> }>(
    appendQuery("/api/admin/peer-groups/ticker-search", { q }),
  );
}

export function getAdminPeerTickerDetail(ticker: string) {
  return adminFetch<PeerTickerDetail>(`/api/admin/peer-groups/ticker/${encodeURIComponent(ticker)}`);
}

export function addAdminSymbolToDirectory(ticker: string) {
  return adminFetch<{ ok: boolean; ticker: string; created: boolean; reactivated: boolean; detail: PeerTickerDetail | null }>(
    "/api/admin/symbols/add",
    {
      method: "POST",
      body: JSON.stringify({ ticker }),
    },
  );
}

export function getAdminSymbolCatalogStatus() {
  return adminFetch<SymbolCatalogStatus>("/api/admin/symbols/status");
}

export function getAdminWorkerSchedule() {
  return adminFetch<WorkerScheduleSettings>("/api/admin/worker-schedule");
}

export function updateAdminWorkerSchedule(payload: Omit<WorkerScheduleSettings, "cronExpression">) {
  return adminFetch<{ ok: boolean; settings: WorkerScheduleSettings }>("/api/admin/worker-schedule", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function syncAdminSymbolCatalog() {
  return adminFetch<{
    ok: boolean;
    sourceKey: string;
    trigger: "manual" | "scheduled";
    fetched: number;
    inserted: number;
    updated: number;
    reactivated: number;
    deactivated: number;
    completedAt: string;
    status: "ok";
  }>("/api/admin/symbols/sync", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function setAdminSymbolCatalogSchedule(enabled: boolean) {
  return adminFetch<{ ok: boolean; enabled: boolean; status: SymbolCatalogStatus }>("/api/admin/symbols/schedule", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export function addAdminPeerGroupMember(groupId: string, payload: {
  ticker: string;
  source?: PeerMembershipSource;
  confidence?: number | null;
}) {
  return adminFetch<{ ok: boolean; ticker: string }>(`/api/admin/peer-groups/${groupId}/members`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function removeAdminPeerGroupMember(groupId: string, ticker: string) {
  return adminFetch<{ ok: boolean; ticker: string }>(`/api/admin/peer-groups/${groupId}/members/${encodeURIComponent(ticker)}`, {
    method: "DELETE",
  });
}

export function seedAdminPeerGroup(ticker: string) {
  return adminFetch<{ ok: boolean; groupId: string; ticker: string; insertedTickers: string[]; sourceBreakdown: Record<string, number> }>(
    "/api/admin/peer-groups/seed",
    {
      method: "POST",
      body: JSON.stringify({ ticker }),
    },
  );
}

export function bootstrapAdminPeerGroups(payload?: {
  tickers?: string[];
  limit?: number;
  offset?: number;
  q?: string;
  onlyUnseeded?: boolean;
  providerMode?: "both" | "finnhub" | "fmp";
  enrichPeers?: boolean;
}) {
  return adminFetch<{
    ok: boolean;
    requested: number;
    attempted: number;
    rows: Array<{
      ticker: string;
      ok: boolean;
      groupId?: string;
      insertedTickers?: string[];
      sourceBreakdown?: Record<string, number>;
      error?: string;
    }>;
  }>("/api/admin/peer-groups/bootstrap", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const secret = process.env.NEXT_PUBLIC_ADMIN_SECRET ?? "";
  const headers: Record<string, string> = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return getJson<T>(path, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
}

export function refreshPageData(page: string, ticker?: string | null) {
  return adminFetch<{ ok: boolean; page: string; refreshedTickers: number; notes?: string }>("/api/admin/refresh-page", {
    method: "POST",
    body: JSON.stringify({ page, ticker: ticker ?? null }),
  }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (!message.includes("API /api/admin/refresh-page failed: 404")) throw error;

    // Backward-compatible fallback for older worker deployments.
    if (page === "breadth") {
      await adminFetch<{ ok: boolean; asOfDate: string; universeCount: number }>("/api/admin/run-breadth", { method: "POST" });
      return { ok: true, page, refreshedTickers: 0, notes: "Fallback breadth refresh completed (legacy API)." };
    }
    if (page === "alerts") {
      return { ok: true, page, refreshedTickers: 0, notes: "Legacy API host does not support alerts refresh endpoint." };
    }
    if (page === "scans") {
      return { ok: true, page, refreshedTickers: 0, notes: "Legacy API host does not support scans refresh endpoint." };
    }
    if (page === "watchlist-compiler") {
      return { ok: true, page, refreshedTickers: 0, notes: "Legacy API host does not support watchlist compiler refresh endpoint." };
    }
    if (page === "gappers") {
      return { ok: true, page, refreshedTickers: 0, notes: "Legacy API host does not support gappers refresh endpoint." };
    }

    await adminFetch<{ ok: boolean; snapshotId: string; asOfDate: string }>("/api/admin/run-eod", { method: "POST" });
    return { ok: true, page, refreshedTickers: 0, notes: "Fallback refresh completed (legacy API)." };
  });
}

export function updateSectorEntry(
  id: string,
  payload: { sectorName: string; eventDate: string; trendScore?: number; notes?: string | null; narrativeId?: string | null; symbols?: string[] },
) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/sectors/entries/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteSectorEntry(id: string) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/sectors/entries/${id}`, {
    method: "DELETE",
  });
}
