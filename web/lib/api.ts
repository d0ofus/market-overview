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

export type MarketCommentarySourceAudit = {
  sourceName: string;
  url: string | null;
  dataUsed: string;
  timestamp: string | null;
  note?: string | null;
};

export type MarketCommentaryDataQuality = {
  metric: string;
  status: "ok" | "stale" | "unavailable" | "not_configured";
  note: string;
};

export type MarketCommentaryReport = {
  id: string;
  sessionDate: string;
  asOf: string;
  generatedAt: string;
  marketSession: "pre_market" | "regular" | "after_hours" | "closed";
  marketSessionLabel: string;
  dataBasis: "intraday" | "closing" | "pre_market" | "closed_market";
  provider: string;
  model: string;
  status: "ready" | "failed";
  reportMarkdown: string;
  sourceAudit: MarketCommentarySourceAudit[];
  dataQuality: MarketCommentaryDataQuality[];
  error: string | null;
};

export type MarketCommentaryResponse = {
  status: "empty" | "ready" | "failed";
  warning: string | null;
  report: MarketCommentaryReport | null;
};

export type MarketCommentaryRefreshResponse = MarketCommentaryResponse & {
  ok: boolean;
};

export type WeeklyMarketReviewGenerationProvider = "hermes_gpt" | "gemini_fallback";
export type WeeklyMarketReviewGenerationMode = "external_publish" | "scheduled_fallback" | "manual_retry";

export type WeeklyMarketReviewKeyTicker = {
  ticker: string;
  companyName?: string | null;
  theme?: string | null;
  impact?: string | null;
  watch?: string | null;
};

export type WeeklyMarketReviewReport = {
  id: string;
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  asOf: string;
  provider: string;
  model: string;
  generationProvider: WeeklyMarketReviewGenerationProvider;
  generationMode: WeeklyMarketReviewGenerationMode;
  status: "ready" | "failed";
  title: string;
  marketTone: string | null;
  reviewMarkdown: string;
  sections: Record<string, unknown>;
  keyTickers: WeeklyMarketReviewKeyTicker[];
  sourceAudit: MarketCommentarySourceAudit[];
  dataQuality: MarketCommentaryDataQuality[];
  sourceSnapshot: Record<string, unknown>;
  error: string | null;
};

export type WeeklyMarketReviewResponse = {
  status: "empty" | "ready" | "failed";
  warning: string | null;
  report: WeeklyMarketReviewReport | null;
};

export type WeeklyMarketReviewGenerateResponse = WeeklyMarketReviewResponse & {
  ok: boolean;
};

export type MarketCommentarySettings = {
  id: string;
  enabled: boolean;
  systemPromptTemplate: string;
  staticSources: MarketCommentarySourceAudit[];
  braveQueries: string[];
  scheduleEnabled: boolean;
  scheduleTimezone: string;
  scheduleLocalTime: string;
  scheduleDays: string[];
  createdAt: string | null;
  updatedAt: string | null;
};

export type OverviewFocusItem = {
  id: string;
  configId: string;
  text: string;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OverviewFocusHistoryItem = {
  text: string;
  lastUsedAt: string;
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
  industry: string | null;
  marketCap: number | null;
  avgVolume: number | null;
  priceAvgVolume: number | null;
  news: AlertNewsRow[];
};

export type AlertIngestionStatus = {
  generatedAt: string;
  totals: {
    alerts: number;
    emails: number;
  };
  latestAlert: {
    id: string;
    ticker: string;
    receivedAt: string;
    tradingDay: string;
    marketSession: "premarket" | "regular" | "after-hours";
    rawEmailSubject: string | null;
  } | null;
  latestEmail: {
    id: string;
    messageId: string;
    sourceMailbox: string | null;
    parseStatus: string;
    rawEmailSubject: string | null;
    rawEmailFrom: string | null;
    rawEmailReceivedAt: string | null;
    createdAt: string;
    parseError: string | null;
  } | null;
  parseStatuses: Array<{
    parseStatus: string;
    count: number;
    latestRawEmailReceivedAt: string | null;
    latestCreatedAt: string | null;
  }>;
  sourceMailboxes: Array<{
    sourceMailbox: string | null;
    count: number;
    latestCreatedAt: string | null;
  }>;
  config: {
    directEmailHandlerEnabled: boolean;
    mailboxSyncConfigured: boolean;
    mailboxSyncAdapters: string[];
    reconcileEnabled: boolean;
    housekeepingEnabled: boolean;
    retentionDays: number;
    staleAfterHours: number;
  };
  stale: {
    isStale: boolean;
    latestAlertAgeHours: number | null;
    latestEmailAgeHours: number | null;
    staleBasis: "latest_email" | "latest_alert" | "none";
  };
};

export type SocialAlertHealthStatus =
  | "missing_token"
  | "configured"
  | "working"
  | "expired"
  | "rate_limited"
  | "function_unreachable"
  | "missing_config"
  | "error";

export type SocialAlertSourceRow = {
  id: string;
  handle: string;
  displayName: string | null;
  isActive: boolean;
  lastScrapedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SocialAlertMetrics = {
  tweets: number;
  cashtagHits: number;
  uniqueTickers: number;
  failures: number;
  runtimeMs: number;
};

export type SocialAlertResultRow = {
  id: string;
  handle: string;
  tweetId: string | null;
  tweetCreatedAt: string | null;
  cashtags: string[];
  text: string;
  url: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type SocialAlertBlacklistedCashtagRow = {
  ticker: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SocialAlertSettings = {
  id: string;
  dailyScrapeEnabled: boolean;
  dailyScrapeTimeLocal: string;
  dailyScrapeTimezone: string;
  dailyScrapeLookbackDays: number;
  scrapeIntervalHours: number;
  updatedAt: string;
};

export type SocialAlertMention = {
  postId: string;
  handle: string;
  tweetId: string | null;
  tweetCreatedAt: string | null;
  text: string;
  url: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type SocialAlertTickerSummary = {
  ticker: string;
  mentionCount: number;
  latestMention: SocialAlertMention;
  mentions: SocialAlertMention[];
};

export type SocialAlertRunSummary = {
  id: string;
  status: string;
  startDate: string;
  limitPerHandle: number;
  selectedHandles: string[];
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  trigger?: string | null;
  scheduledLocalDate?: string | null;
  scheduledLocalSlot?: string | null;
};

export type SocialAlertHealthResponse = {
  status: SocialAlertHealthStatus;
  tokenConfigured: boolean;
  tokenLast4: string | null;
  functionReachable: boolean;
  lastValidatedAt: string | null;
  updatedAt: string | null;
  message: string | null;
  scweetVersion?: string | null;
};

export type SocialAlertPublicResultsResponse = {
  run: SocialAlertRunSummary | null;
  metrics: SocialAlertMetrics;
  rows: SocialAlertResultRow[];
  uniqueTickers: string[];
  tickerSummaries: SocialAlertTickerSummary[];
  window: { startDate: string; endDate: string; lookbackDays: number };
  total: number;
  limit: number;
  offset: number;
};

export type SocialAlertResultsResponse = SocialAlertPublicResultsResponse & {
  blacklist: SocialAlertBlacklistedCashtagRow[];
};

export type SocialAlertScrapeResponse = {
  ok: boolean;
  run: { id: string; status: string; startDate: string; limitPerHandle: number };
  metrics: SocialAlertMetrics;
  results: SocialAlertResultRow[];
  failures: Array<{ handle?: string | null; error?: string | null; status?: string | null }>;
  authStatus: { status: SocialAlertHealthStatus; message: string | null };
};

export type FundamentalQuarterRow = {
  ticker: string;
  cik: string;
  companyName: string | null;
  fiscalYear: number;
  fiscalQuarter: number;
  periodEnd: string;
  filedAt: string | null;
  form: string | null;
  accession: string | null;
  currency: string;
  revenue: number | null;
  netIncome: number | null;
  revenueYoY: number | null;
  revenueQoQ: number | null;
  netIncomeYoY: number | null;
  netIncomeQoQ: number | null;
  revenueSourceTag: string | null;
  netIncomeSourceTag: string | null;
  derivation: string | null;
  warnings: string[];
};

export type FundamentalsResponse = {
  ticker: string;
  schemaReady: boolean;
  issuer: {
    ticker: string;
    cik: string;
    companyName: string;
    lastRefreshedAt: string | null;
    status: string | null;
    lastError: string | null;
  } | null;
  rows: FundamentalQuarterRow[];
  warning: string | null;
};

export type FundamentalTrendDirection = "up" | "down" | "mixed" | "unknown";

export type FundamentalTrendQuarter = {
  fiscalYear: number;
  fiscalQuarter: number;
  periodEnd: string;
  revenue: number | null;
  netIncome: number | null;
  revenueYoY: number | null;
  netIncomeYoY: number | null;
};

export type FundamentalTrendRow = {
  ticker: string;
  companyName: string | null;
  quarters: FundamentalTrendQuarter[];
  revenueTrend: FundamentalTrendDirection;
  netIncomeTrend: FundamentalTrendDirection;
  combinedTrend: FundamentalTrendDirection;
  latestRevenueYoY: number | null;
  latestNetIncomeYoY: number | null;
  warning: string | null;
};

export type FundamentalsTrendsResponse = {
  schemaReady: boolean;
  rows: FundamentalTrendRow[];
  warning: string | null;
};

export type FundamentalsRefreshResponse = {
  ok: boolean;
  ticker: string;
  cik: string;
  companyName: string;
  refreshedAt: string;
  rowsUpserted: number;
  selectedQuarters: number;
  completePeriodsFound: number;
  derivedQ4Count: number;
  warningCount: number;
  warnings: string[];
};

export type AdminEarningsStatus = {
  schemaReady: boolean;
  counts: Record<string, number>;
  dueCount: number;
  syncs: Array<{
    provider: string;
    status: string;
    horizon: string | null;
    lastStartedAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    rowsSeen: number | null;
    rowsUpserted: number | null;
    updatedAt: string | null;
  }>;
  upcoming: Array<{
    ticker: string;
    companyName: string | null;
    scheduledDate: string;
    timeHint: string | null;
    fiscalPeriod: string;
    provider: string;
    status: string;
    nextCheckAt: string | null;
  }>;
  warning: string | null;
};

export type AdminEarningsSyncResponse = {
  ok: boolean;
  horizon: string;
  providers: Array<{
    provider: string;
    rowsSeen: number;
    rowsEligible: number;
    status: "ok" | "skipped" | "error";
    error: string | null;
  }>;
  rowsUpserted: number;
  warning: string | null;
};

export type AdminEarningsProcessResponse = {
  ok: boolean;
  attempted: number;
  rows: Array<{
    ticker: string;
    previousStatus: string;
    status: string;
    rowsUpserted: number;
    secForm: string | null;
    error: string | null;
  }>;
};

export type AdminEarningsExclusionDataset = "surprises" | "gaps";

export type AdminEarningsExcludedRow = {
  id: string;
  dataset: AdminEarningsExclusionDataset;
  provider: string;
  sourceSymbol: string;
  ticker: string;
  exchange: string | null;
  companyName: string | null;
  reportDate: string;
  metricLabel: string;
  metricValue: number | null;
  reasons: string[];
};

export type AdminEarningsExclusionsResponse = {
  schemaReady: boolean;
  warning: string | null;
  generatedAt: string;
  dataset: AdminEarningsExclusionDataset;
  limit: number;
  offset: number;
  total: number;
  scanner: {
    primarySource: string;
    tradingViewMarket: string;
    tradingViewSymbolTypes: string[];
    backupProviders: string[];
    defaultExchangePolicy: string;
  };
  rules: string[];
  catalog: SymbolCatalogStatus | null;
  rows: AdminEarningsExcludedRow[];
};

export type EarningsSurpriseRow = {
  id: string;
  provider: string;
  sourceSymbol: string;
  ticker: string;
  exchange: string | null;
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  reportDate: string;
  reportTimestamp: number | null;
  reportTime: string | null;
  fiscalPeriodEnd: string | null;
  season: string;
  epsActual: number | null;
  epsEstimate: number | null;
  epsSurprise: number | null;
  epsSurprisePct: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
  revenueSurprise: number | null;
  revenueSurprisePct: number | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

export type EarningsSurpriseFacet = {
  value: string;
  count: number;
};

export type EarningsSurprisesResponse = {
  schemaReady: boolean;
  warning: string | null;
  generatedAt: string;
  total: number;
  limit: number;
  offset: number;
  rows: EarningsSurpriseRow[];
  facets: {
    seasons: EarningsSurpriseFacet[];
    sectors: EarningsSurpriseFacet[];
    industries: EarningsSurpriseFacet[];
    exchanges: EarningsSurpriseFacet[];
  };
};

export type EarningsSurprisesStatus = {
  schemaReady: boolean;
  warning: string | null;
  counts: {
    total: number;
    positive: number;
    negative: number;
    latestReportDate: string | null;
    earliestReportDate: string | null;
  };
  syncs: Array<{
    provider: string;
    status: string;
    mode: string | null;
    windowStart: string | null;
    windowEnd: string | null;
    lastStartedAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    rowsSeen: number | null;
    rowsUpserted: number | null;
    updatedAt: string | null;
  }>;
  latestRows: EarningsSurpriseRow[];
};

export type EarningsSurprisesQuery = {
  limit?: number;
  offset?: number;
  q?: string | null;
  season?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  minMarketCap?: number | null;
  maxMarketCap?: number | null;
  minEpsSurprisePct?: number | null;
  sector?: string | null;
  industry?: string | null;
  exchange?: string | null;
  includeOtc?: boolean;
  surpriseSide?: "all" | "positive" | "negative";
  sort?: string | null;
  sortDir?: "asc" | "desc";
};

export type EarningsSurpriseSyncResponse = {
  ok: boolean;
  mode: "incremental" | "backfill";
  windowStart: string;
  windowEnd: string;
  provider: string | null;
  providers: Array<{
    provider: string;
    status: "ok" | "skipped" | "error";
    rowsSeen: number;
    rowsUpserted: number;
    error: string | null;
  }>;
  rowsSeen: number;
  rowsUpserted: number;
  warning: string | null;
};

export type EarningsGapSource = "postmarket" | "regular_open" | "both";

export type EarningsGapRow = {
  id: string;
  provider: string;
  sourceSymbol: string;
  ticker: string;
  exchange: string | null;
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  price: number | null;
  avgVolume30d: number | null;
  avgDollarVolume30d: number | null;
  reportDate: string;
  season: string;
  reportTimestamp: number | null;
  reportTime: string | null;
  reactionDate: string | null;
  previousClose: number | null;
  reactionOpen: number | null;
  regularOpenGapPct: number | null;
  postmarketPrice: number | null;
  postmarketGapPct: number | null;
  postmarketVolume: number | null;
  qualifyingGapPct: number;
  gapSource: EarningsGapSource;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

export type EarningsGapsQuery = {
  limit?: number;
  offset?: number;
  q?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  season?: string | null;
  minMarketCap?: number | null;
  maxMarketCap?: number | null;
  minAvgDollarVolume?: number | null;
  minGapPct?: number | null;
  sector?: string | null;
  industry?: string | null;
  exchange?: string | null;
  includeOtc?: boolean;
  sort?: string | null;
  sortDir?: "asc" | "desc";
};

export type EarningsGapsResponse = {
  schemaReady: boolean;
  warning: string | null;
  generatedAt: string;
  total: number;
  limit: number;
  offset: number;
  rows: EarningsGapRow[];
  facets: {
    seasons: EarningsSurpriseFacet[];
    sectors: EarningsSurpriseFacet[];
    industries: EarningsSurpriseFacet[];
    exchanges: EarningsSurpriseFacet[];
    gapSources: EarningsSurpriseFacet[];
  };
};

export type EarningsGapsStatus = {
  schemaReady: boolean;
  warning: string | null;
  counts: {
    total: number;
    postmarket: number;
    regularOpen: number;
    both: number;
    latestReportDate: string | null;
    earliestReportDate: string | null;
  };
  syncs: Array<{
    id: string;
    provider: string;
    status: string;
    mode: string | null;
    scheduledLocalDate: string | null;
    windowStart: string | null;
    windowEnd: string | null;
    lastStartedAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    rowsSeen: number | null;
    rowsUpserted: number | null;
    updatedAt: string | null;
  }>;
  latestRows: EarningsGapRow[];
};

export type EarningsGapSyncResponse = {
  ok: boolean;
  mode: "incremental" | "backfill";
  windowStart: string;
  windowEnd: string;
  batchWindowStart: string;
  batchWindowEnd: string;
  totalWindowStart: string;
  totalWindowEnd: string;
  nextCursor: string | null;
  done: boolean;
  provider: string;
  rowsSeen: number;
  rowsUpserted: number;
  scheduledLocalDate: string | null;
  warning: string | null;
};

export type EarningsGapSyncOptions = {
  cursor?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
};

export type AdminFundamentalsSeedQueueRow = {
  ticker: string;
  companyName: string | null;
  exchange: string | null;
  marketCap: number | null;
  priorityRank: number;
  status: string;
  attempts: number;
  rowsUpserted?: number | null;
  latestPeriodEnd?: string | null;
  latestFiledAt?: string | null;
  lastRefreshedAt?: string | null;
  nextAttemptAt?: string | null;
  lastError?: string | null;
  updatedAt?: string | null;
};

export type AdminFundamentalsSeedRun = {
  id: string;
  runType: "build" | "process" | string;
  trigger: "manual" | "scheduled" | string;
  requestedLimit: number;
  fetchedRows: number;
  eligibleRows: number;
  queuedRows: number;
  processedRows: number;
  okRows: number;
  errorRows: number;
  noSupportedRows: number;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
};

export type AdminFundamentalsSeedStatus = {
  schemaReady: boolean;
  warning: string | null;
  counts: Record<string, number>;
  cached: {
    issuerCount: number;
    quarterRowCount: number;
    tickerWithQuarterCount: number;
  };
  queue: {
    total: number;
    progressPct: number;
    nextTickers: AdminFundamentalsSeedQueueRow[];
  };
  storageEstimate: {
    estimatedBytes: number;
    label: string;
    note: string;
  };
  recentRuns: AdminFundamentalsSeedRun[];
};

export type AdminFundamentalsSeedBuildResponse = {
  ok: boolean;
  providerLabel: string;
  requestedLimit: number;
  fetchedRows: number;
  marketEligibleRows: number;
  universeEligibleRows: number;
  queuedRows: number;
  skippedNoIssuer: number;
  completedAt: string;
};

export type AdminFundamentalsSeedProcessResponse = {
  ok: boolean;
  attempted: number;
  rows: Array<{
    ticker: string;
    previousStatus: string;
    status: string;
    rowsUpserted: number;
    latestPeriodEnd: string | null;
    latestFiledAt: string | null;
    error: string | null;
  }>;
};

export type AdminFundamentalsSeedErrorsResponse = {
  schemaReady: boolean;
  warning: string | null;
  rows: AdminFundamentalsSeedQueueRow[];
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
  factorScore: number | null;
  factorPassCount: number | null;
  factorUnknownCount: number | null;
  factorResultsJson: string | null;
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

export type ScanPresetType = "tradingview" | "relative-strength" | "vcp";
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
  vcpDailyPivotLookback: number;
  vcpWeeklyHighLookback: number;
  vcpPivotAgeBars: number;
  vcpDailyNearPct: number;
  vcpWeeklyNearPct: number;
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
  status: "ok" | "warning" | "error" | "empty" | "queued" | "running" | "completed" | "failed" | "cancelled";
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

export type ScanRefreshJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type ScanRefreshJob = {
  id: string;
  presetId: string;
  presetName: string;
  jobType: "relative-strength" | "vcp";
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
  lastProgressAt: string | null;
  lastAttemptCursorOffset: number | null;
  lastAttemptTicker: string | null;
  lastAttemptStage: string | null;
  lastAttemptElapsedMs: number | null;
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

export type PatternLabelValue = "approved" | "rejected" | "skipped";
export type PatternLabelStatus = "active" | "archived" | "deleted";
export type PatternSelectionMode = "chart_range" | "fixed_window";

export type PatternFeatureJson = Record<string, number | null>;
export type PatternShapeJson = Record<string, Array<number | null>>;

export type PatternScoreContribution = {
  featureKey: string;
  label: string;
  value: number | null;
  contribution: number;
};

export type PatternExampleReference = {
  labelId: string;
  ticker: string;
  setupDate: string;
  label: "approved" | "rejected";
  distance: number;
  similarity: number;
  tags: string[];
};

export type PatternScoreReasons = {
  score: number;
  mode: "heuristic" | "model";
  approvedSimilarity: number | null;
  rejectedSimilarity: number | null;
  scalarSimilarity: number | null;
  shapeSimilarity: number | null;
  activeLearningPriority: number;
  heuristicScore: number;
  positiveContributions: PatternScoreContribution[];
  negativeContributions: PatternScoreContribution[];
  summary: string[];
};

export type PatternCandidate = {
  id: string;
  runId: string;
  profileId: string;
  ticker: string;
  rank: number;
  score: number;
  reasons: PatternScoreReasons;
  nearestApproved: PatternExampleReference[];
  nearestRejected: PatternExampleReference[];
  featureJson: PatternFeatureJson;
  shapeJson: PatternShapeJson;
  sourceMetadata: Record<string, unknown>;
  createdAt?: string;
  tradingDate?: string;
  updatedAt?: string;
  reviewStatus?: PatternLabelValue | null;
  reviewedAt?: string | null;
};

export type PatternLabel = {
  id: string;
  profileId: string;
  ticker: string;
  setupDate: string;
  label: PatternLabelValue;
  status: PatternLabelStatus;
  source: string;
  contextWindowBars: number;
  patternWindowBars: number;
  patternStartDate: string | null;
  patternEndDate: string | null;
  selectedBarCount: number | null;
  selectionMode: PatternSelectionMode;
  tags: string[];
  notes: string | null;
  featureVersion: string;
  featureJson: PatternFeatureJson;
  shapeJson: PatternShapeJson;
  windowHash: string;
  createdAt: string;
  updatedAt: string;
};

export type PatternRun = {
  id: string;
  profileId: string;
  tradingDate: string;
  status: "queued" | "running" | "paused" | "cancelled" | "completed" | "failed";
  phase: string;
  totalCount: number;
  processedCount: number;
  matchedCount: number;
  cursorOffset: number;
  autoContinue: boolean;
  lastAdvancedAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  warning: string | null;
};

export type PatternFeatureRegistryRow = {
  featureKey: string;
  displayName: string;
  family: "scalar" | "shape";
  valueType: string;
  enabled: boolean;
  version: string;
  description: string | null;
};

export type PatternModelVersion = {
  id: string;
  profileId: string;
  modelType: string;
  featureVersion: string;
  model: Record<string, unknown>;
  metrics: PatternValidationMetrics;
  featureSummary: PatternFeatureSummary;
  approvedCount: number;
  rejectedCount: number;
  active: boolean;
  createdAt: string;
};

export type PatternValidationMetrics = {
  enoughLabels: boolean;
  approvedCount: number;
  rejectedCount: number;
  totalActiveLabels: number;
  chronologicalAccuracy: number | null;
  precisionAt25: number | null;
  precisionAt50: number | null;
  validationWindowSize: number;
};

export type PatternFeatureSummary = {
  scalarStats: Record<string, {
    approvedAvg: number | null;
    rejectedAvg: number | null;
    approvedMedian: number | null;
    rejectedMedian: number | null;
    delta: number | null;
  }>;
  topWeightedFeatures: Array<{ featureKey: string; weight: number; direction: "approved" | "rejected" | "neutral" }>;
};

export type PatternProfile = {
  id: string;
  name: string;
  description: string | null;
  benchmarkTickers: string[];
  prefilterConfig: { minPrice: number; minDollarVolume20d: number; minBars: number };
  activeModelId: string | null;
  settings: {
    contextWindowBars: number;
    patternWindowBars: number;
    candidateLimit: number;
    matchScoreThreshold: number;
    selectedResamplePoints?: number;
    candidatePatternLengths?: number[];
  };
  createdAt: string;
  updatedAt: string;
};

export type PatternChartBar = {
  ticker: string;
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
  rs: number | null;
};

export type PatternChartData = {
  ticker: string;
  endDate: string;
  benchmarkTicker: string;
  contextWindowBars: number;
  availableStartDate: string | null;
  availableEndDate: string | null;
  bars: PatternChartBar[];
  warnings: string[];
};

export type PatternCandidateScope = "matched" | "all";
export type PatternCandidateReviewedMode = "exclude" | "include";

export type PatternCandidateListResponse = {
  profileId: string;
  run: PatternRun | null;
  scope: PatternCandidateScope;
  reviewed: PatternCandidateReviewedMode;
  matchScoreThreshold: number;
  totalCandidateCount: number;
  reviewedHiddenCount: number;
  rows: PatternCandidate[];
};

export type PatternAnalysisResponse = {
  profile: PatternProfile;
  activeModel: PatternModelVersion | null;
  featureRegistry: PatternFeatureRegistryRow[];
  approvalCount: number;
  rejectionCount: number;
  featureSummary: PatternFeatureSummary;
  validationMetrics: PatternValidationMetrics;
  modelHistory: PatternModelVersion[];
  mlReadiness: {
    balancedLabels: number;
    logisticReady: boolean;
    neuralReady: boolean;
    guidance: string[];
  };
};

export type PatternFeatureIdeasResponse = {
  rows: Array<{ title: string; description: string; status: string }>;
  mlReadiness: Record<string, string>;
};

export type WatchlistReviewFlag = "red" | "blue" | "yellow" | "orange" | "unflagged" | "unknown";
export type WatchlistReviewProposedFlag = "red" | "blue" | "yellow" | "orange" | "keep" | "unflag" | "remove" | "manual_review";
export type WatchlistReviewRecommendationType =
  | "RED_TO_BLUE"
  | "RED_TO_YELLOW"
  | "BLUE_TO_RED"
  | "BLUE_TO_YELLOW"
  | "YELLOW_TO_BLUE"
  | "YELLOW_TO_RED"
  | "ANY_TO_UNFLAG"
  | "KEEP_CURRENT"
  | "MANUAL_REVIEW";
export type WatchlistReviewRunStatus = "draft" | "ready" | "partially_approved" | "applied" | "archived";
export type WatchlistReviewCandidateStatus = "pending" | "approved" | "skipped" | "overridden" | "applied";
export type WatchlistReviewAnalysisSource = "data_only" | "mini_chart" | "full_chart_vision" | "manual";
export type WatchlistReviewRunApplyStatus =
  | "not_queued"
  | "approved_ready"
  | "dispatching"
  | "waiting_for_hermes"
  | "claimed"
  | "applying"
  | "applied"
  | "partial_failed"
  | "apply_failed"
  | "cancelled";
export type WatchlistReviewCandidateApplyStatus = "not_queued" | "queued_for_apply" | "applying" | "applied" | "apply_failed" | "skipped";
export type WatchlistReviewDispatchStatus =
  | "approved_ready"
  | "dispatching"
  | "waiting_for_hermes"
  | "webhook_failed"
  | "claimed"
  | "applying"
  | "applied"
  | "partial_failed"
  | "apply_failed"
  | "cancelled";
export type WatchlistReviewCandidateAction =
  | "approve"
  | "skip"
  | "keep_current"
  | "move_red"
  | "move_blue"
  | "move_yellow_orange"
  | "unflag_remove"
  | "note";

export type WatchlistReviewSummaryCounts = {
  red_to_blue: number;
  red_to_yellow: number;
  blue_to_red: number;
  blue_to_yellow: number;
  yellow_to_blue: number;
  yellow_to_red: number;
  unflag: number;
  keep_current: number;
  manual_review: number;
};

export type WatchlistReviewRun = {
  id: string;
  prepId: string | null;
  analysisDispatchId: string | null;
  analysisMetadata: Record<string, unknown> | null;
  sourceWatchlistName: string | null;
  sourceWatchlistId: string | null;
  watchlistSetId: string | null;
  watchlistRunId: string | null;
  totalTickersScanned: number;
  status: WatchlistReviewRunStatus;
  notes: string | null;
  summaryCounts: WatchlistReviewSummaryCounts;
  generatedBy: "hermes" | "manual" | "import";
  analysisVersion: string | null;
  exportPath: string | null;
  applyStatus: WatchlistReviewRunApplyStatus;
  approvalRevision: number;
  approvedChecksum: string | null;
  activeApplyDispatchId: string | null;
  approvedApplyCount: number;
  skippedApplyCount: number;
  destructiveApplyCount: number;
  readyToApplyAt: string | null;
  dispatchRequestedAt: string | null;
  dispatchedToHermesAt: string | null;
  applyStartedAt: string | null;
  applyCompletedAt: string | null;
  applyFailedAt: string | null;
  applyError: string | null;
  applyResultSummary: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  candidateCount?: number;
  pendingCount?: number;
  approvedCount?: number;
  skippedCount?: number;
  destructiveCount?: number;
};

export type WatchlistReviewCandidate = {
  id: string;
  runId: string;
  ticker: string;
  companyName: string | null;
  currentFlag: WatchlistReviewFlag;
  proposedFlag: WatchlistReviewProposedFlag;
  recommendationType: WatchlistReviewRecommendationType;
  confidence: number;
  reasons: string[];
  metrics: Record<string, unknown>;
  sectorContext: Record<string, unknown> | null;
  chartImageUrl: string | null;
  chartSnapshotPath: string | null;
  tvSymbol: string | null;
  dataFreshness: Record<string, unknown>;
  analysisSource: WatchlistReviewAnalysisSource;
  destructiveAction: boolean;
  destructiveConfirmed: boolean;
  removalReason: string | null;
  status: WatchlistReviewCandidateStatus;
  userOverrideFlag: WatchlistReviewProposedFlag | null;
  userNote: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  appliedAt: string | null;
  applyStatus: WatchlistReviewCandidateApplyStatus;
  applyError: string | null;
  applyUpdatedAt: string | null;
  lastApplyDispatchId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WatchlistReviewEvent = {
  id: string;
  runId: string;
  candidateId: string | null;
  ticker: string | null;
  eventType: string;
  previousStatus: string | null;
  nextStatus: string | null;
  previousFlag: string | null;
  nextFlag: string | null;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type WatchlistReviewRunDetail = {
  run: WatchlistReviewRun;
  candidates: WatchlistReviewCandidate[];
  events: WatchlistReviewEvent[];
};

export type WatchlistReviewExportRow = {
  run_id: string;
  ticker: string;
  current_flag: WatchlistReviewFlag;
  proposed_flag: WatchlistReviewProposedFlag;
  recommendation_type: WatchlistReviewRecommendationType;
  approved_by: string;
  approved_at: string | null;
  reason: string;
  destructive_action: boolean;
  rollback_hint: string;
};

export type WatchlistReviewExportPayload = {
  ok: true;
  runId: string;
  generatedAt: string;
  approvedCount: number;
  destructiveCount: number;
  rows: WatchlistReviewExportRow[];
  json: WatchlistReviewExportRow[];
  csv: string;
  exportPath: string;
  message?: string;
};

export type WatchlistReviewReadyToApplyResponse = {
  ok: true;
  run: {
    id: string;
    applyStatus: WatchlistReviewRunApplyStatus;
    approvalRevision: number;
    approvedChecksum: string;
  };
  dispatch: {
    id: string;
    status: WatchlistReviewDispatchStatus;
    idempotencyKey: string;
    approvalRevision: number;
    checksum: string;
    approvedCount: number;
    skippedCount: number;
    destructiveCount: number;
  };
  webhook: {
    attempted: boolean;
    status: "sent" | "not_configured" | "failed" | "already_pending";
    responseStatus: number | null;
    error: string | null;
  };
};

export type WatchlistReviewPrepProvider = {
  primary: string;
  feed: string | null;
  adjustment?: string;
  fallbackEnabled: boolean;
  fallbacks?: string[];
};

export type WatchlistReviewPrepCoverage = {
  complete: number;
  stale: number;
  missing: number;
  coveragePct: number;
};

export type WatchlistReviewPrepSummary = {
  ok?: boolean;
  prepId: string;
  source: string;
  sourceSetId: string | null;
  sourceSetName: string | null;
  watchlistName: string | null;
  watchlistRunId: string | null;
  symbolCount: number;
  lookbackBars: number;
  expectedAsOfDate: string;
  provider: WatchlistReviewPrepProvider;
  coverage: WatchlistReviewPrepCoverage;
  status: "ready" | "ready_with_warnings" | "blocked";
  warnings: string[];
  timing: {
    refreshMs: number;
    dbReadMs: number;
    totalMs: number;
    requestedSymbols: number;
    refreshedSymbols: number;
    skippedFreshSymbols: number;
  };
  createdAt: string;
  updatedAt: string;
};

export type WatchlistReviewAnalysisDispatchStatus =
  | "queued"
  | "dispatching"
  | "waiting_for_hermes"
  | "webhook_failed"
  | "claimed"
  | "running"
  | "completed"
  | "partial_failed"
  | "failed"
  | "cancelled";

export type WatchlistReviewAnalysisWebhookStatus = "sent" | "not_configured" | "failed" | "already_pending";

export type WatchlistReviewAnalysisDispatchSummary = {
  dispatchId: string;
  prepId: string;
  status: WatchlistReviewAnalysisDispatchStatus;
  webhookStatus: WatchlistReviewAnalysisWebhookStatus;
  idempotencyKey: string;
  payloadChecksum: string;
  claimOwner: string | null;
  claimExpiresAt: string | null;
  createdReviewRunId: string | null;
  requestedAt: string;
  updatedAt: string;
  error: string | null;
};

export type WatchlistReviewAnalysisDispatch = {
  id: string;
  prepId: string;
  source: string;
  sourceSetId: string | null;
  sourceSetName: string | null;
  watchlistName: string | null;
  watchlistRunId: string | null;
  status: WatchlistReviewAnalysisDispatchStatus;
  idempotencyKey: string;
  payloadChecksum: string;
  payloadPreview: Record<string, unknown>;
  claimOwner: string | null;
  claimedAt: string | null;
  claimExpiresAt: string | null;
  heartbeatAt: string | null;
  requestedAt: string;
  webhookSentAt: string | null;
  webhookFailedAt: string | null;
  webhookResponseStatus: number | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  createdReviewRunId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WatchlistReviewPrepCreateResponse = WatchlistReviewPrepSummary & {
  ok: true;
  analysisDispatch: WatchlistReviewAnalysisDispatchSummary | null;
};

export type WatchlistReviewPrepBarsResponse = WatchlistReviewPrepSummary & {
  ok: boolean;
  symbols: Array<{
    ticker: string;
    tvSymbol: string | null;
    name: string | null;
    exchange: string | null;
    sector: string | null;
    industry: string | null;
    latestDate: string | null;
    availableBars: number;
    freshness: {
      latestDate: string | null;
      expectedAsOfDate: string;
      status: "fresh" | "stale" | "missing";
    };
    bars: Array<{ date: string; o: number; h: number; l: number; c: number; volume: number }>;
  }>;
  missing: string[];
  stale: string[];
};

export type WatchlistCompilerRunSummary = ScanRunSummary;

export type WatchlistFactorStatus = "pass" | "fail" | "unknown";

export type WatchlistFactorKey =
  | "priceAboveSma200"
  | "priceAbove"
  | "marketCapAbove"
  | "within52WeekHigh"
  | "priorStrongMove"
  | "strongSector"
  | "avg10dDollarVolume"
  | "increasingVolumeProfile"
  | "positiveRevenueGrowth"
  | "positiveEpsGrowth"
  | "acceleratingRevenueGrowth"
  | "acceleratingEpsGrowth"
  | "averageTradingRangePct";

export type WatchlistFactorConfig = {
  enabled: Partial<Record<WatchlistFactorKey, boolean>>;
  thresholds: {
    priceAbove: { minPrice: number };
    marketCapAbove: { minMarketCapMillions: number };
    within52WeekHigh: { maxDistancePct: number };
    priorStrongMove: { movePct: number; lookbackMonths: number };
    strongSector: { lookbackMonths: number };
    avg10dDollarVolume: { minDollarVolumeMillions: number };
    increasingVolumeProfile: { lookbackMonths: number; minTrendPct: number };
    acceleratingRevenueGrowth: { minAccelerationPct: number };
    acceleratingEpsGrowth: { minAccelerationPct: number };
    averageTradingRangePct: { minAtrPct: number };
  };
};

export type WatchlistFactorResult = {
  key: WatchlistFactorKey;
  label: string;
  status: WatchlistFactorStatus;
  value: number | string | boolean | null;
  threshold: number | string | null;
  source: string | null;
  details?: Record<string, unknown>;
};

export type WatchlistCompilerSetRow = {
  id: string;
  scanDefinitionId: string;
  name: string;
  slug: string;
  isActive: boolean;
  compileDaily: boolean;
  dailyCompileTimeLocal: string | null;
  dailyCompileTimezone: string | null;
  factorConfig: WatchlistFactorConfig;
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

export type WatchlistFactorSettings = {
  id: string;
  factorConfig: WatchlistFactorConfig;
  createdAt: string | null;
  updatedAt: string | null;
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

export type PerplexityFinancePeerLookup = {
  ticker: string;
  fetchedAt: string;
  source: "perplexity_finance_dashboard";
  provider?: "browserbase" | "local_chromium";
  browserbaseConfigured?: boolean;
  browserbaseSessionId?: string;
  browserbaseSessionUrl?: string;
  peersUrl: string;
  profileUrl: string;
  company: {
    name: string | null;
    exchange: string | null;
    sector: string | null;
    industry: string | null;
    description: string | null;
  };
  peers: Array<{
    ticker: string;
    name: string | null;
    exchange: string | null;
    rawText: string;
  }>;
  warning: string | null;
  status?: "ready" | "partial" | "pending_timeout" | "blocked" | "not_found" | "parse_error";
  profileStatus?: "ready" | "partial" | "pending_timeout" | "blocked" | "not_found" | "parse_error";
  peersStatus?: "ready" | "partial" | "pending_timeout" | "blocked" | "not_found" | "parse_error";
  cache?: {
    mode: "hit" | "miss" | "refresh" | "stale_on_error";
    storedAt: string | null;
    ageSeconds: number | null;
  };
  diagnostics?: {
    profileSource: string | null;
    peersSource: string | null;
    profileHttpStatus: number | null;
    peersHttpStatus: number | null;
    profileBodyState: string | null;
    peersBodyState: string | null;
    profileTimedOut: boolean;
    peersTimedOut: boolean;
    observedEndpoints: string[];
    blockedEndpoints: string[];
    providerWarning?: string | null;
  };
};

export type PerplexityFinanceNotableMovementLookup = {
  ticker: string;
  fetchedAt: string;
  source: "perplexity_finance_page";
  url: string;
  notablePriceMovement: string | null;
  status: "ready" | "blocked" | "not_found" | "parse_error" | "pending_timeout";
  warning: string | null;
  diagnostics: {
    provider: "browserbase" | "local_chromium";
    bodyState: string;
    matchedSelector: string | null;
    observedHeadings: string[];
  };
};

export type PerplexityBrowserbaseVerificationSession = {
  ok: true;
  sessionId: string;
  expiresAt: string;
  debuggerUrl: string;
  debuggerFullscreenUrl: string;
  targetUrl?: string;
  pages: Array<{
    id: string;
    debuggerUrl: string;
    debuggerFullscreenUrl: string;
    title: string;
    url: string;
  }>;
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
  patternScanEnabled: boolean;
  patternScanOffsetMinutes: number;
  patternScanBatchSize: number;
  patternScanMaxBatchesPerTick: number;
};

export type AdminCronJobField = {
  key: string;
  label: string;
  type: "boolean" | "number" | "time" | "timezone" | "weekdays" | "select";
  helper?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ label: string; value: string }>;
};

export type AdminCronJob = {
  key: string;
  label: string;
  category: string;
  description: string;
  kind: "local-time" | "window" | "interval" | "runtime" | "watchlist-set";
  cadence: string;
  fixedCronExpression: string;
  values: Record<string, boolean | number | string | string[] | null>;
  fields: AdminCronJobField[];
  meta?: Record<string, unknown>;
};

export type AdminCronJobsResponse = {
  fixedCronExpression: string;
  timezoneOptions: Array<{ label: string; value: string }>;
  jobs: AdminCronJob[];
};

export type PeerMetricRow = {
  ticker: string;
  price: number | null;
  change1d: number | null;
  change1w: number | null;
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

function adminProxyPath(path: string): string {
  if (path.startsWith("/api/admin")) return path;
  if (path.startsWith("/api/")) return `/api/admin/proxy${path}`;
  return path;
}

export function getDashboard(date?: string): Promise<SnapshotResponse> {
  return getJson(`/api/dashboard${date ? `?date=${date}` : ""}`);
}

export function getStatus(page?: "overview" | "breadth" | "sectors"): Promise<{
  timezone: string;
  autoRefreshLabel: string;
  autoRefreshLocalTime?: string;
  lastUpdated: string | null;
  asOfDate: string | null;
  providerLabel: string;
  expectedAsOfDate?: string | null;
  freshnessStatus?: "fresh" | "partial" | "stale";
  freshnessCoveragePct?: number | null;
  freshnessCurrentCount?: number | null;
  freshnessEligibleCount?: number | null;
  freshnessCriticalMissingTickers?: string[];
  freshnessMinBarDate?: string | null;
  freshnessMaxBarDate?: string | null;
  freshnessWarning?: string | null;
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

export function getMarketCommentary(init?: RequestInit) {
  return getJson<MarketCommentaryResponse>("/api/market-commentary", init);
}

export function getWeeklyMarketReview(init?: RequestInit) {
  return getJson<WeeklyMarketReviewResponse>("/api/weekly-market-review/latest", init);
}

export function getOverviewFocusItems(configId = "default") {
  return getJson<{ rows: OverviewFocusItem[] }>(appendQuery("/api/overview/focus", { configId }));
}

export function getOverviewFocusHistory(configId = "default") {
  return getJson<{ rows: OverviewFocusHistoryItem[] }>(appendQuery("/api/overview/focus/history", { configId }));
}

export function createOverviewFocusItem(text: string, configId = "default") {
  return adminFetch<{ ok: boolean; item: OverviewFocusItem }>("/api/admin/overview-focus", {
    method: "POST",
    body: JSON.stringify({ configId, text }),
  });
}

export function updateOverviewFocusItem(id: string, text: string) {
  return adminFetch<{ ok: boolean; item: OverviewFocusItem }>(`/api/admin/overview-focus/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ text }),
  });
}

export function deleteOverviewFocusItem(id: string) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/overview-focus/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function refreshMarketCommentary(force = false) {
  return adminFetch<MarketCommentaryRefreshResponse>(
    appendQuery("/api/admin/market-commentary/refresh", { force: force ? 1 : undefined }),
    { method: "POST" },
  );
}

export function generateWeeklyMarketReview(force = false) {
  return adminFetch<WeeklyMarketReviewGenerateResponse>("/api/admin/weekly-market-review/generate", {
    method: "POST",
    body: JSON.stringify({ force, mode: "manual_retry" }),
  });
}

export function getAdminMarketCommentarySettings() {
  return adminFetch<MarketCommentarySettings>("/api/admin/market-commentary/settings");
}

export function updateAdminMarketCommentarySettings(payload: Omit<MarketCommentarySettings, "createdAt" | "updatedAt">) {
  return adminFetch<{ ok: boolean; settings: MarketCommentarySettings }>("/api/admin/market-commentary/settings", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function resetAdminMarketCommentarySettings() {
  return adminFetch<{ ok: boolean; settings: MarketCommentarySettings }>("/api/admin/market-commentary/settings/reset", {
    method: "POST",
  });
}

export function getBreadthSummary() {
  return getJson<{ asOfDate: string | null; rows: any[]; unavailable: Array<{ id: string; name: string; reason: string }> }>("/api/breadth/summary");
}

export type TickerSeriesTimeframe = "1M" | "3M" | "6M" | "1Y" | "2Y" | "MAX";

export type TickerHistoryBackfillStatus =
  | { status: "queued"; lastRequestedAt: string }
  | { status: "recently_requested"; lastRequestedAt: string | null }
  | { status: "unavailable"; message: string };

export type TickerSeriesResponse = {
    symbol: { ticker: string; name: string; exchange: string };
    series: Array<{ date: string; c: number }>;
    historyStatus?: {
      timeframe: TickerSeriesTimeframe;
      requestedBars: number | null;
      availableBars: number;
      complete: boolean;
      backfill: TickerHistoryBackfillStatus | null;
    };
    tradingViewEnabled: boolean;
  };

export function getTicker(ticker: string, timeframe?: TickerSeriesTimeframe) {
  return getJson<TickerSeriesResponse>(
    appendQuery(`/api/ticker/${encodeURIComponent(ticker)}`, { timeframe }),
  );
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

export type SectorFocusNarrative = {
  id: string;
  sectorName: string;
  sortOrder: number;
  comment: string;
  createdAt: string;
  updatedAt: string;
};

export type SectorFocusNarrativeUpdate = {
  sectorName: string;
  comment?: string | null;
};

export type SectorMarketLeaderRow = {
  ticker: string;
  name: string | null;
  sourcePeerGroupId: string | null;
  sourcePeerGroupName: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export function getSectorFocusNarratives() {
  return getJson<{ rows: SectorFocusNarrative[] }>("/api/sectors/focus-narratives");
}

export function updateSectorFocusNarratives(focusNarratives: SectorFocusNarrativeUpdate[]) {
  return adminFetch<{ rows: SectorFocusNarrative[] }>("/api/sectors/focus-narratives", {
    method: "PUT",
    body: JSON.stringify({ focusNarratives }),
  });
}

export function getSectorMarketLeaders() {
  return getJson<{ rows: SectorMarketLeaderRow[] }>("/api/sectors/market-leaders");
}

export function addSectorMarketLeaders(payload: { tickers: string[]; sourcePeerGroupId?: string | null }) {
  return adminFetch<{ ok: boolean; rows: SectorMarketLeaderRow[] }>("/api/sectors/market-leaders", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteSectorMarketLeader(ticker: string) {
  return adminFetch<{ ok: boolean; ticker: string }>(`/api/sectors/market-leaders/${encodeURIComponent(ticker)}`, {
    method: "DELETE",
  });
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

export function getAdminAlertIngestionStatus() {
  return adminFetch<AlertIngestionStatus>("/api/admin/alerts/status");
}

export function getSocialAlertHandles() {
  return adminFetch<{ rows: SocialAlertSourceRow[] }>("/api/admin/social-alerts/handles");
}

export function createSocialAlertHandle(handle: string) {
  return adminFetch<{ ok: boolean; row: SocialAlertSourceRow }>("/api/admin/social-alerts/handles", {
    method: "POST",
    body: JSON.stringify({ handle }),
  });
}

export function getSocialAlertSettings() {
  return adminFetch<SocialAlertSettings>("/api/admin/social-alerts/settings");
}

export function updateSocialAlertSettings(payload: Omit<SocialAlertSettings, "id" | "updatedAt">) {
  return adminFetch<{ ok: boolean; settings: SocialAlertSettings }>("/api/admin/social-alerts/settings", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function getSocialAlertBlacklist() {
  return adminFetch<{ rows: SocialAlertBlacklistedCashtagRow[] }>("/api/admin/social-alerts/blacklist");
}

export function createSocialAlertBlacklistEntry(ticker: string, reason?: string | null) {
  return adminFetch<{ ok: boolean; row: SocialAlertBlacklistedCashtagRow }>("/api/admin/social-alerts/blacklist", {
    method: "POST",
    body: JSON.stringify({ ticker, reason: reason ?? null }),
  });
}

export function deleteSocialAlertBlacklistEntry(ticker: string) {
  return adminFetch<{ ok: boolean; ticker: string }>(`/api/admin/social-alerts/blacklist/${encodeURIComponent(ticker)}`, {
    method: "DELETE",
  });
}

export function getSocialAlertHealth(options?: { probe?: boolean; probeHandle?: string | null }) {
  return adminFetch<SocialAlertHealthResponse>(
    appendQuery("/api/admin/social-alerts/health", {
      probe: options?.probe ? 1 : undefined,
      probeHandle: options?.probeHandle ?? undefined,
    }),
  );
}

export function saveSocialAlertCredential(authToken: string, validate = true) {
  return adminFetch<{
    ok: boolean;
    status: SocialAlertHealthStatus;
    tokenLast4: string | null;
    updatedAt: string;
    message: string | null;
  }>("/api/admin/social-alerts/credentials", {
    method: "POST",
    body: JSON.stringify({ authToken, validate }),
  });
}

export function deleteSocialAlertCredential() {
  return adminFetch<{ ok: boolean; status: SocialAlertHealthStatus }>("/api/admin/social-alerts/credentials", {
    method: "DELETE",
  });
}

export function runSocialAlertScrape(payload: {
  allHandles?: boolean;
  handleIds?: string[];
  startDate: string;
  limitPerHandle: number;
}) {
  return adminFetch<SocialAlertScrapeResponse>("/api/admin/social-alerts/scrape", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getSocialAlertResults(params?: {
  runId?: string | null;
  ticker?: string | null;
  handle?: string | null;
  q?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  lookbackDays?: number;
  limit?: number;
  offset?: number;
}) {
  return adminFetch<SocialAlertResultsResponse>(
    appendQuery("/api/admin/social-alerts/results", {
      runId: params?.runId ?? undefined,
      ticker: params?.ticker ?? undefined,
      handle: params?.handle ?? undefined,
      q: params?.q ?? undefined,
      startDate: params?.startDate ?? undefined,
      endDate: params?.endDate ?? undefined,
      lookbackDays: params?.lookbackDays,
      limit: params?.limit,
      offset: params?.offset,
    }),
  );
}

export function getSocialAlertPublicResults(params?: {
  runId?: string | null;
  ticker?: string | null;
  handle?: string | null;
  q?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  lookbackDays?: number;
  limit?: number;
  offset?: number;
}) {
  return getJson<SocialAlertPublicResultsResponse>(
    appendQuery("/api/social-alerts/results", {
      runId: params?.runId ?? undefined,
      ticker: params?.ticker ?? undefined,
      handle: params?.handle ?? undefined,
      q: params?.q ?? undefined,
      startDate: params?.startDate ?? undefined,
      endDate: params?.endDate ?? undefined,
      lookbackDays: params?.lookbackDays,
      limit: params?.limit,
      offset: params?.offset,
    }),
  );
}

export function getTickerFundamentals(ticker: string, quarters = 8) {
  return getJson<FundamentalsResponse>(
    appendQuery(`/api/fundamentals/ticker/${encodeURIComponent(ticker)}`, { quarters }),
  );
}

export function getFundamentalsTrends(tickers: string[], quarters = 8) {
  const normalized = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))).slice(0, 48);
  return getJson<FundamentalsTrendsResponse>(
    appendQuery("/api/fundamentals/trends", { tickers: normalized.join(","), quarters }),
  );
}

export function refreshTickerFundamentals(ticker: string) {
  return adminFetch<FundamentalsRefreshResponse>(
    `/api/admin/fundamentals/ticker/${encodeURIComponent(ticker)}/refresh`,
    { method: "POST" },
  );
}

export function getAdminEarningsStatus() {
  return adminFetch<AdminEarningsStatus>("/api/admin/earnings/status");
}

export function syncAdminEarningsCalendar(horizon?: string) {
  return adminFetch<AdminEarningsSyncResponse>(
    appendQuery("/api/admin/earnings/sync", { horizon }),
    { method: "POST" },
  );
}

export function processAdminEarningsRefresh(limit = 5) {
  return adminFetch<AdminEarningsProcessResponse>(
    appendQuery("/api/admin/earnings/process", { limit }),
    { method: "POST" },
  );
}

export function getAdminEarningsExclusions(query?: {
  dataset?: AdminEarningsExclusionDataset;
  limit?: number;
  offset?: number;
}) {
  return adminFetch<AdminEarningsExclusionsResponse>(appendQuery("/api/admin/earnings/exclusions", {
    dataset: query?.dataset,
    limit: query?.limit,
    offset: query?.offset,
  }));
}

export function getEarningsSurprises(query?: EarningsSurprisesQuery) {
  return getJson<EarningsSurprisesResponse>(appendQuery("/api/earnings/surprises", {
    limit: query?.limit,
    offset: query?.offset,
    q: query?.q,
    season: query?.season,
    startDate: query?.startDate,
    endDate: query?.endDate,
    minMarketCap: query?.minMarketCap,
    maxMarketCap: query?.maxMarketCap,
    minEpsSurprisePct: query?.minEpsSurprisePct,
    sector: query?.sector,
    industry: query?.industry,
    exchange: query?.exchange,
    includeOtc: query?.includeOtc ? 1 : undefined,
    surpriseSide: query?.surpriseSide,
    sort: query?.sort,
    sortDir: query?.sortDir,
  }));
}

export function getEarningsSurprisesExportUrl(query?: EarningsSurprisesQuery, dateSuffix?: string | null) {
  return apiUrl(appendQuery("/api/earnings/surprises/export.txt", {
    limit: query?.limit,
    q: query?.q,
    season: query?.season,
    startDate: query?.startDate,
    endDate: query?.endDate,
    minMarketCap: query?.minMarketCap,
    maxMarketCap: query?.maxMarketCap,
    minEpsSurprisePct: query?.minEpsSurprisePct,
    sector: query?.sector,
    industry: query?.industry,
    exchange: query?.exchange,
    includeOtc: query?.includeOtc ? 1 : undefined,
    surpriseSide: query?.surpriseSide,
    sort: query?.sort,
    sortDir: query?.sortDir,
    dateSuffix: dateSuffix ?? undefined,
  }));
}

export function getEarningsSurprisesStatus() {
  return getJson<EarningsSurprisesStatus>("/api/earnings/surprises/status");
}

export function syncAdminEarningsSurprises(mode: "incremental" | "backfill" = "incremental") {
  return adminFetch<EarningsSurpriseSyncResponse>(
    appendQuery("/api/admin/earnings/surprises/sync", { mode }),
    { method: "POST" },
  );
}

export function getEarningsGaps(query?: EarningsGapsQuery) {
  return getJson<EarningsGapsResponse>(appendQuery("/api/earnings/gaps", {
    limit: query?.limit,
    offset: query?.offset,
    q: query?.q,
    startDate: query?.startDate,
    endDate: query?.endDate,
    season: query?.season,
    minMarketCap: query?.minMarketCap,
    maxMarketCap: query?.maxMarketCap,
    minAvgDollarVolume: query?.minAvgDollarVolume,
    minGapPct: query?.minGapPct,
    sector: query?.sector,
    industry: query?.industry,
    exchange: query?.exchange,
    includeOtc: query?.includeOtc ? 1 : undefined,
    sort: query?.sort,
    sortDir: query?.sortDir,
  }));
}

export function getEarningsGapsExportUrl(query?: EarningsGapsQuery, dateSuffix?: string | null) {
  return apiUrl(appendQuery("/api/earnings/gaps/export.txt", {
    limit: query?.limit,
    q: query?.q,
    startDate: query?.startDate,
    endDate: query?.endDate,
    season: query?.season,
    minMarketCap: query?.minMarketCap,
    maxMarketCap: query?.maxMarketCap,
    minAvgDollarVolume: query?.minAvgDollarVolume,
    minGapPct: query?.minGapPct,
    sector: query?.sector,
    industry: query?.industry,
    exchange: query?.exchange,
    includeOtc: query?.includeOtc ? 1 : undefined,
    sort: query?.sort,
    sortDir: query?.sortDir,
    dateSuffix: dateSuffix ?? undefined,
  }));
}

export function getEarningsGapsStatus() {
  return getJson<EarningsGapsStatus>("/api/earnings/gaps/status");
}

export function syncAdminEarningsGaps(mode: "incremental" | "backfill" = "incremental", options: EarningsGapSyncOptions = {}) {
  return adminFetch<EarningsGapSyncResponse>(
    appendQuery("/api/admin/earnings/gaps/sync", {
      mode,
      cursor: options.cursor,
      windowStart: options.windowStart,
      windowEnd: options.windowEnd,
    }),
    { method: "POST" },
  );
}

export function getAdminFundamentalsSeedStatus() {
  return adminFetch<AdminFundamentalsSeedStatus>("/api/admin/fundamentals/seed/status");
}

export function buildAdminFundamentalsSeedQueue(limit = 500) {
  return adminFetch<AdminFundamentalsSeedBuildResponse>(
    appendQuery("/api/admin/fundamentals/seed/build", { limit }),
    { method: "POST" },
  );
}

export function processAdminFundamentalsSeedQueue(limit = 10) {
  return adminFetch<AdminFundamentalsSeedProcessResponse>(
    appendQuery("/api/admin/fundamentals/seed/process", { limit }),
    { method: "POST" },
  );
}

export function getAdminFundamentalsSeedErrors(limit = 50) {
  return adminFetch<AdminFundamentalsSeedErrorsResponse>(
    appendQuery("/api/admin/fundamentals/seed/errors", { limit }),
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

export function cancelScanRefreshJob(jobId: string) {
  return adminFetch<{ ok: boolean; snapshot: ScanSnapshot | null; job: ScanRefreshJob }>(
    `/api/admin/scans/refresh-jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
  );
}

export function refreshScanCompilePreset(id: string) {
  return adminFetch<{ ok: boolean } & ScanCompilePresetRefreshResult>(
    `/api/admin/scans/compile-presets/${encodeURIComponent(id)}/refresh`,
    { method: "POST" },
  );
}

export function getPatternLatest(profileId = "default", limit = 100) {
  return getJson<{ profileId: string; rows: PatternCandidate[] }>(
    appendQuery("/api/pattern-scanner/latest", { profileId, limit }),
  );
}

export function getPatternCandidates(params?: {
  profileId?: string;
  scope?: PatternCandidateScope;
  reviewed?: PatternCandidateReviewedMode;
  limit?: number;
  runId?: string | null;
}) {
  const profileId = params?.profileId ?? "default";
  const scope = params?.scope ?? "matched";
  const reviewed = params?.reviewed ?? "exclude";
  const limit = params?.limit ?? 100;
  const path = appendQuery("/api/pattern-scanner/candidates", {
    profileId,
    scope,
    reviewed,
    limit,
    runId: params?.runId ?? undefined,
  });
  return getJson<PatternCandidateListResponse>(path).catch(async (error) => {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("API /api/pattern-scanner/candidates") || !message.includes("failed: 404")) {
      throw error;
    }
    const latest = await getPatternLatest(profileId, limit);
    const threshold = 0.6;
    const rows = scope === "matched"
      ? latest.rows.filter((candidate) => candidate.score >= threshold)
      : latest.rows;
    return {
      profileId,
      run: null,
      scope,
      reviewed,
      matchScoreThreshold: threshold,
      totalCandidateCount: rows.length,
      reviewedHiddenCount: 0,
      rows,
    };
  });
}

export function getPatternRuns(profileId = "default", limit = 25) {
  return getJson<{ profileId: string; rows: PatternRun[] }>(
    appendQuery("/api/pattern-scanner/runs", { profileId, limit }),
  );
}

export function getPatternRun(runId: string) {
  return getJson<{ run: PatternRun; candidates: PatternCandidate[] }>(
    `/api/pattern-scanner/runs/${encodeURIComponent(runId)}`,
  );
}

export function getPatternLabels(profileId = "default") {
  return getJson<{ profileId: string; rows: PatternLabel[] }>(
    appendQuery("/api/pattern-scanner/labels", { profileId }),
  );
}

export function getPatternChart(params: {
  profileId?: string;
  ticker: string;
  endDate: string;
  contextBars?: number;
}) {
  return getJson<PatternChartData>(
    appendQuery("/api/pattern-scanner/chart", {
      profileId: params.profileId ?? "default",
      ticker: params.ticker,
      endDate: params.endDate,
      contextBars: params.contextBars,
    }),
  );
}

export function getPatternFeatures() {
  return getJson<{ rows: PatternFeatureRegistryRow[] }>("/api/pattern-scanner/features");
}

export function getPatternFeatureIdeas() {
  return getJson<PatternFeatureIdeasResponse>("/api/pattern-scanner/feature-ideas");
}

export function getPatternModel(profileId = "default") {
  return getJson<{ profileId: string; model: PatternModelVersion | null; features: PatternFeatureRegistryRow[] }>(
    appendQuery("/api/pattern-scanner/model", { profileId }),
  );
}

export function getPatternAnalysis(profileId = "default") {
  return getJson<PatternAnalysisResponse>(appendQuery("/api/pattern-scanner/analysis", { profileId }));
}

export function getPatternExportUrl(profileId = "default") {
  return apiUrl(appendQuery("/api/pattern-scanner/export.txt", { profileId }));
}

export function createPatternLabel(payload: {
  profileId?: string;
  ticker: string;
  setupDate: string;
  label: PatternLabelValue;
  status?: PatternLabelStatus;
  source?: string;
  contextWindowBars?: number;
  patternWindowBars?: number;
  patternStartDate?: string | null;
  patternEndDate?: string | null;
  selectedBarCount?: number | null;
  selectionMode?: PatternSelectionMode;
  tags?: string[];
  notes?: string | null;
  runId?: string | null;
  candidateId?: string | null;
}) {
  return adminFetch<{ ok: boolean; label: PatternLabel | null }>("/api/admin/pattern-scanner/labels", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createPatternLabelsBulk(payload: {
  profileId?: string;
  csvText?: string;
  labels?: Array<{
    ticker: string;
    setupDate: string;
    label: PatternLabelValue;
    tags?: string[];
    notes?: string | null;
    patternStartDate?: string | null;
    patternEndDate?: string | null;
    selectedBarCount?: number | null;
    selectionMode?: PatternSelectionMode;
  }>;
  contextWindowBars?: number;
  patternWindowBars?: number;
}) {
  return adminFetch<{ ok: boolean; created: PatternLabel[]; errors: Array<{ row: number; error: string }> }>(
    "/api/admin/pattern-scanner/labels/bulk",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function updatePatternLabel(id: string, payload: {
  ticker?: string;
  setupDate?: string;
  label?: PatternLabelValue;
  status?: PatternLabelStatus;
  contextWindowBars?: number;
  patternWindowBars?: number;
  patternStartDate?: string | null;
  patternEndDate?: string | null;
  selectedBarCount?: number | null;
  selectionMode?: PatternSelectionMode;
  tags?: string[];
  notes?: string | null;
}) {
  return adminFetch<{ ok: boolean; label: PatternLabel }>(`/api/admin/pattern-scanner/labels/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deletePatternLabel(id: string, hard = false) {
  return adminFetch<{ ok: boolean; deleted: boolean; hard: boolean; profileId: string | null }>(
    appendQuery(`/api/admin/pattern-scanner/labels/${encodeURIComponent(id)}`, { hard: hard ? 1 : undefined }),
    { method: "DELETE" },
  );
}

export function createPatternRun(payload?: { profileId?: string; tradingDate?: string; force?: boolean; autoContinue?: boolean }) {
  return adminFetch<{ ok: boolean; run: PatternRun }>("/api/admin/pattern-scanner/runs", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export function continuePatternRun(runId: string) {
  return adminFetch<{ ok: boolean; run: PatternRun }>(
    `/api/admin/pattern-scanner/runs/${encodeURIComponent(runId)}/continue`,
    { method: "POST" },
  );
}

export function pausePatternRun(runId: string) {
  return adminFetch<{ ok: boolean; run: PatternRun }>(
    `/api/admin/pattern-scanner/runs/${encodeURIComponent(runId)}/pause`,
    { method: "POST" },
  );
}

export function resumePatternRun(runId: string) {
  return adminFetch<{ ok: boolean; run: PatternRun }>(
    `/api/admin/pattern-scanner/runs/${encodeURIComponent(runId)}/resume`,
    { method: "POST" },
  );
}

export function cancelPatternRun(runId: string) {
  return adminFetch<{ ok: boolean; run: PatternRun }>(
    `/api/admin/pattern-scanner/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );
}

export function updatePatternProfile(payload: {
  profileId?: string;
  minPrice?: number;
  minDollarVolume20d?: number;
  minBars?: number;
  candidateLimit?: number;
  matchScoreThreshold?: number;
  contextWindowBars?: number;
  candidatePatternLengths?: number[];
}) {
  return adminFetch<{ ok: boolean; profile: PatternProfile }>("/api/admin/pattern-scanner/profile", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function updatePatternFeature(featureKey: string, payload: { displayName?: string; enabled?: boolean; description?: string | null }) {
  return adminFetch<{ ok: boolean; feature: PatternFeatureRegistryRow }>(
    `/api/admin/pattern-scanner/features/${encodeURIComponent(featureKey)}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    },
  );
}

export function getWatchlistReviewRuns(limit = 25) {
  return adminFetch<{ rows: WatchlistReviewRun[] }>(appendQuery("/api/watchlist-review/runs", { limit }));
}

export function getWatchlistReviewRun(id: string) {
  return adminFetch<WatchlistReviewRunDetail>(`/api/watchlist-review/runs/${encodeURIComponent(id)}`);
}

export function createWatchlistReviewRun(payload: {
  run?: Record<string, unknown>;
  candidates: Array<Record<string, unknown>>;
  prepId?: string | null;
  analysisDispatchId?: string | null;
  analysisMetadata?: Record<string, unknown> | null;
  watchlistSetId?: string | null;
  watchlistRunId?: string | null;
}) {
  return adminFetch<{ ok: true } & WatchlistReviewRunDetail>("/api/watchlist-review/runs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createWatchlistReviewPrep(payload: {
  source: string;
  sourceSetId?: string | null;
  sourceSetName?: string | null;
  watchlistName?: string | null;
  watchlistRunId?: string | null;
  symbols: string[];
  lookbackBars?: number;
  refreshIfStale?: boolean;
  providerPreference?: "app-default";
  enqueueHermesAnalysis?: boolean;
}) {
  return adminFetch<WatchlistReviewPrepCreateResponse>("/api/watchlist-review/preps", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getWatchlistReviewPrep(prepId: string) {
  return adminFetch<WatchlistReviewPrepSummary & { ok: true }>(`/api/watchlist-review/preps/${encodeURIComponent(prepId)}`);
}

export function getWatchlistReviewAnalysisDispatch(dispatchId: string) {
  return adminFetch<{
    ok: true;
    dispatch: WatchlistReviewAnalysisDispatch;
    summary: WatchlistReviewAnalysisDispatchSummary;
  }>(`/api/watchlist-review/analysis-dispatches/${encodeURIComponent(dispatchId)}`);
}

export function getWatchlistReviewPrepBars(prepId: string, options?: { offset?: number; limit?: number; symbols?: string[] }) {
  return adminFetch<WatchlistReviewPrepBarsResponse>(
    appendQuery(`/api/watchlist-review/preps/${encodeURIComponent(prepId)}/bars`, {
      offset: options?.offset,
      limit: options?.limit,
      symbols: options?.symbols?.join(","),
    }),
  );
}

export function patchWatchlistReviewCandidate(id: string, payload: {
  action: WatchlistReviewCandidateAction;
  userNote?: string | null;
  removalReason?: string | null;
  destructiveConfirmed?: boolean;
  approvedBy?: string | null;
}) {
  return adminFetch<{ ok: true; candidate: WatchlistReviewCandidate }>(`/api/watchlist-review/candidates/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function approveAllWatchlistReviewCandidates(runId: string, payload: {
  candidateIds?: string[];
  destructiveConfirmed?: boolean;
  approvedBy?: string | null;
}) {
  return adminFetch<{ ok: true; updated: number; detail: WatchlistReviewRunDetail | null }>(
    `/api/watchlist-review/runs/${encodeURIComponent(runId)}/approve-all`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function skipAllWatchlistReviewCandidates(runId: string, payload: {
  candidateIds?: string[];
  approvedBy?: string | null;
}) {
  return adminFetch<{ ok: true; updated: number; detail: WatchlistReviewRunDetail | null }>(
    `/api/watchlist-review/runs/${encodeURIComponent(runId)}/skip-all`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function exportApprovedWatchlistReviewChanges(runId: string, payload: {
  destructiveConfirmed?: boolean;
  approvedBy?: string | null;
}) {
  return adminFetch<WatchlistReviewExportPayload>(
    `/api/watchlist-review/runs/${encodeURIComponent(runId)}/export-approved`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function applyApprovedWatchlistReviewChanges(runId: string, payload: {
  destructiveConfirmed?: boolean;
  approvedBy?: string | null;
}) {
  return adminFetch<WatchlistReviewExportPayload>(
    `/api/watchlist-review/runs/${encodeURIComponent(runId)}/apply-approved`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function readyToApplyWatchlistReviewRun(runId: string, payload: {
  destructiveConfirmed?: boolean;
  approvedBy?: string | null;
  retryWebhook?: boolean;
}) {
  return adminFetch<WatchlistReviewReadyToApplyResponse>(
    `/api/watchlist-review/runs/${encodeURIComponent(runId)}/ready-to-apply`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
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
  vcpDailyPivotLookback?: number;
  vcpWeeklyHighLookback?: number;
  vcpPivotAgeBars?: number;
  vcpDailyNearPct?: number;
  vcpWeeklyNearPct?: number;
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
  vcpDailyPivotLookback?: number;
  vcpWeeklyHighLookback?: number;
  vcpPivotAgeBars?: number;
  vcpDailyNearPct?: number;
  vcpWeeklyNearPct?: number;
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

export function getAdminWatchlistCompilerFactorConfig() {
  return adminFetch<WatchlistFactorSettings>("/api/admin/watchlist-compiler/factor-config");
}

export function updateAdminWatchlistCompilerFactorConfig(factorConfig: WatchlistFactorConfig) {
  return adminFetch<{ ok: boolean; settings: WatchlistFactorSettings }>("/api/admin/watchlist-compiler/factor-config", {
    method: "PATCH",
    body: JSON.stringify({ factorConfig }),
  });
}

export function createAdminWatchlistCompilerSet(payload: {
  name: string;
  slug?: string | null;
  isActive?: boolean;
  compileDaily?: boolean;
  dailyCompileTimeLocal?: string | null;
  dailyCompileTimezone?: string | null;
  factorConfig?: WatchlistFactorConfig;
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
  factorConfig?: WatchlistFactorConfig;
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

export function duplicateAdminWatchlistCompilerSet(id: string) {
  return adminFetch<{ ok: boolean; id: string }>(`/api/admin/watchlist-compiler/sets/${encodeURIComponent(id)}/duplicate`, {
    method: "POST",
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

export async function getPerplexityFinancePeers(ticker: string, options?: { refresh?: boolean }) {
  const path = appendQuery("/api/perplexity-finance/peers", {
    ticker,
    refresh: options?.refresh ? 1 : undefined,
  });
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
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
    throw new Error(`Perplexity Finance lookup failed: ${res.status}${detail}`);
  }
  return (await res.json()) as PerplexityFinancePeerLookup;
}

export async function getPerplexityFinanceNotableMovement(ticker: string, options?: { refresh?: boolean }) {
  const path = appendQuery("/api/perplexity-finance/notable-movement", {
    ticker,
    refresh: options?.refresh ? 1 : undefined,
  });
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
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
    throw new Error(`Perplexity Finance notable movement lookup failed: ${res.status}${detail}`);
  }
  return (await res.json()) as PerplexityFinanceNotableMovementLookup;
}

export async function createPerplexityBrowserbaseVerificationSession(options?: { targetUrl?: string | null }) {
  const res = await fetch("/api/perplexity-finance/browserbase/verify-session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      targetUrl: options?.targetUrl ?? undefined,
    }),
    credentials: "same-origin",
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
    throw new Error(`Browserbase verification session failed: ${res.status}${detail}`);
  }
  return (await res.json()) as PerplexityBrowserbaseVerificationSession;
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

export function searchAdminPeerTickers(q: string, options?: { resolve?: boolean; limit?: number }) {
  return adminFetch<{ rows: Array<{ ticker: string; name: string | null; exchange: string | null; sector: string | null; industry: string | null }> }>(
    appendQuery("/api/admin/peer-groups/ticker-search", {
      q,
      resolve: options?.resolve == null ? undefined : options.resolve ? 1 : 0,
      limit: options?.limit,
    }),
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

export function getAdminCronJobs() {
  return adminFetch<AdminCronJobsResponse>("/api/admin/cron-jobs");
}

export function updateAdminCronJob(key: string, values: AdminCronJob["values"]) {
  return adminFetch<AdminCronJobsResponse & { ok: boolean }>(`/api/admin/cron-jobs/${encodeURIComponent(key)}`, {
    method: "PATCH",
    body: JSON.stringify({ values }),
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
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(adminProxyPath(path), {
    ...init,
    headers,
    cache: "no-store",
    credentials: "same-origin",
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
    if (page === "pattern-scanner") {
      return { ok: true, page, refreshedTickers: 0, notes: "Legacy API host does not support pattern scanner refresh endpoint." };
    }
    if (page === "watchlist-compiler") {
      return { ok: true, page, refreshedTickers: 0, notes: "Legacy API host does not support watchlist compiler refresh endpoint." };
    }
    if (page === "gappers") {
      return { ok: true, page, refreshedTickers: 0, notes: "Legacy API host does not support gappers refresh endpoint." };
    }
    if (page === "earnings") {
      return { ok: true, page, refreshedTickers: 0, notes: "Legacy API host does not support earnings refresh endpoint." };
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
