import { z } from "zod";
import {
  DEFAULT_RESEARCH_SETTINGS,
  RESEARCH_DEFAULT_TOPIC_EVIDENCE_ITEMS,
  RESEARCH_DEFAULT_TOPIC_EXCERPTS,
  RESEARCH_MAX_PEER_CANDIDATES,
  RESEARCH_MAX_RANKING_ADJUSTMENT,
} from "./constants";
import type {
  PeerComparisonBlock,
  ResearchDeepDive,
  ResearchFactorCard,
  ResearchProfileSettings,
  ResearchRankingCard,
  StandardizedResearchCard,
} from "./types";

const evidenceIdsSchema = z.array(z.string().min(1)).default([]);

const profileSettingsSchema = z.object({
  lookbackDays: z.number().int().min(1).max(90),
  includeMacroContext: z.boolean(),
  maxTickerQueries: z.number().int().min(1).max(12),
  maxEvidenceItemsPerTicker: z.number().int().min(4).max(40),
  maxSearchResultsPerQuery: z.number().int().min(1).max(10),
  maxTickersPerRun: z.number().int().min(1).max(100),
  deepDiveTopN: z.number().int().min(0).max(20),
  comparisonEnabled: z.boolean(),
  peerComparisonEnabled: z.boolean().optional(),
  maxPeerCandidates: z.number().int().min(2).max(RESEARCH_MAX_PEER_CANDIDATES).optional(),
  maxTopicEvidenceItems: z.number().int().min(2).max(8).optional(),
  maxEvidenceExcerptsPerTopic: z.number().int().min(1).max(4).optional(),
  sourceFamilies: z.object({
    sec: z.boolean(),
    news: z.boolean(),
    earningsTranscripts: z.boolean(),
    investorRelations: z.boolean(),
    analystCommentary: z.boolean(),
  }),
});

const thesisOverviewSchema = z.object({
  stance: z.enum(["positive", "mixed", "negative", "unclear"]),
  oneParagraph: z.string().min(1),
  whyNow: z.string().min(1),
  whatWouldChangeMyMind: z.string().min(1),
  evidenceIds: evidenceIdsSchema,
});

const marketPricingSchema = z.object({
  pricedInAssessment: z.enum(["underappreciated", "partially_priced_in", "mostly_priced_in", "fully_priced_in", "unclear"]),
  whatExpectationsSeemEmbedded: z.string().min(1),
  whyUpsideDownsideMayStillRemain: z.string().min(1),
  evidenceIds: evidenceIdsSchema,
});

const earningsQualityDetailedSchema = z.object({
  revenueQuality: z.string().min(1),
  marginQuality: z.string().min(1),
  cashFlowQuality: z.string().min(1),
  guideQuality: z.string().min(1),
  beatOrMissQuality: z.string().min(1),
  oneOffsOrNoise: z.string().min(1),
  evidenceIds: evidenceIdsSchema,
});

const catalystAssessmentSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  strength: z.enum(["high", "medium_high", "medium", "low", "unclear"]),
  timing: z.enum(["immediate", "next_1_2_quarters", "next_3_6_months", "longer_term", "unclear"]),
  durability: z.enum(["high", "medium_high", "medium", "low", "unclear"]),
  pricedInStatus: z.enum(["not_priced_in", "partially_priced_in", "mostly_priced_in", "fully_priced_in", "unclear"]),
  direction: z.enum(["positive", "negative", "mixed"]),
  evidenceIds: evidenceIdsSchema,
});

const riskAssessmentSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  severity: z.enum(["high", "medium", "low"]),
  probability: z.enum(["high", "medium", "low", "unclear"]),
  timeframe: z.enum(["near_term", "medium_term", "long_term", "unclear"]),
  likelyImpact: z.string().min(1),
  evidenceIds: evidenceIdsSchema,
});

const contradictionDetailedSchema = z.object({
  tension: z.string().min(1),
  whyItMatters: z.string().min(1),
  likelyDirectionIfResolved: z.string().min(1),
  evidenceIds: evidenceIdsSchema,
});

const valuationViewSchema = z.object({
  label: z.enum(["attractive", "fair", "full", "stretched", "cheap", "somewhat_cheap", "somewhat_expensive", "expensive", "unclear"]),
  summary: z.string().min(1),
  metricsReferenced: z.array(z.string().min(1)).default([]),
  relativeVsHistory: z.enum(["below_history", "near_history", "above_history", "unclear"]),
  relativeVsPeers: z.enum(["cheap", "somewhat_cheap", "fair", "somewhat_expensive", "expensive", "unclear"]),
  multipleRisk: z.enum(["low", "moderate", "elevated", "high", "unclear"]),
  evidenceIds: evidenceIdsSchema,
});

const thematicFitSchema = z.object({
  themeName: z.string().min(1),
  label: z.enum(["strong", "average", "weak", "unclear"]),
  durability: z.enum(["high", "medium", "low", "unclear"]),
  adoptionSignal: z.string().min(1),
  competitiveDensity: z.enum(["low", "moderate", "high", "unclear"]),
  evidenceIds: evidenceIdsSchema,
});

const setupQualitySchema = z.object({
  label: z.enum(["high", "medium", "low", "unclear"]),
  summary: z.string().min(1),
  whatNeedsToHappenNext: z.string().min(1),
  invalidationTriggers: z.array(z.string().min(1)).default([]),
  evidenceIds: evidenceIdsSchema,
});

const peerComparisonSchemaBase = z.object({
  available: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  reasonUnavailable: z.string().nullable().default(null),
  peerGroupName: z.string().nullable().default(null),
  closestPeers: z.array(z.string().min(1)).default([]),
  whyTheseAreClosestPeers: z.string().default(""),
  earningsQualityRelative: z.enum(["leader", "above_average", "average", "below_average", "laggard", "unclear"]),
  growthOutlookRelative: z.enum(["leader", "above_average", "average", "below_average", "laggard", "unclear"]),
  historicalExecutionRelative: z.enum(["leader", "above_average", "average", "below_average", "laggard", "unclear"]),
  valuationRelative: z.enum(["cheap", "somewhat_cheap", "fair", "somewhat_expensive", "expensive", "unclear"]),
  priceLeadershipRelative: z.enum(["leader", "improving", "neutral", "weakening", "laggard", "unclear"]),
  fundamentalLeadershipRelative: z.enum(["leader", "strong_contender", "average", "weak", "laggard", "unclear"]),
  strategicPositionRelative: z.string().default(""),
  whatThisTickerDoesBetterThanPeers: z.string().default(""),
  whatPeersDoBetterThanThisTicker: z.string().default(""),
  peerRisksOrPeerAdvantages: z.string().default(""),
  evidenceIds: evidenceIdsSchema,
});

const peerComparisonSchema = peerComparisonSchemaBase.superRefine((value, ctx) => {
  if ((!value.available || value.confidence === "low") && !value.reasonUnavailable?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "peerComparison.reasonUnavailable is required when peer comparison is unavailable or low-confidence.",
      path: ["reasonUnavailable"],
    });
  }
  if (!value.available && value.closestPeers.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "peerComparison.closestPeers must be empty when available=false.",
      path: ["closestPeers"],
    });
  }
});

const overallConclusionSchema = z.object({
  thesis: z.string().min(1),
  bestBullArgument: z.string().min(1),
  bestBearArgument: z.string().min(1),
  keyWatchItems: z.array(z.string().min(1)).default([]),
  nextCatalystWindow: z.string().min(1),
  confidenceLabel: z.enum(["high", "medium", "low"]),
  confidenceScore: z.number().min(0).max(1),
  evidenceIds: evidenceIdsSchema,
});

const factorCardSchema = z.object({
  key: z.string().min(1),
  score: z.number().min(0).max(100),
  direction: z.enum(["positive", "neutral", "negative", "mixed"]),
  confidenceScore: z.number().min(0).max(1),
  weightApplied: z.number().min(0).max(1),
  summary: z.string().min(1),
  evidenceIds: evidenceIdsSchema,
});

export const standardizedResearchCardSchema = z.object({
  ticker: z.string().min(1),
  companyName: z.string().nullable(),
  thesisOverview: thesisOverviewSchema,
  marketPricing: marketPricingSchema,
  earningsQualityDetailed: earningsQualityDetailedSchema,
  catalystAssessment: z.array(catalystAssessmentSchema).default([]),
  riskAssessment: z.array(riskAssessmentSchema).default([]),
  contradictionsDetailed: z.array(contradictionDetailedSchema).default([]),
  valuationView: valuationViewSchema,
  thematicFit: thematicFitSchema,
  setupQuality: setupQualitySchema,
  peerComparison: peerComparisonSchema,
  overallConclusion: overallConclusionSchema,
  evidenceTopicSummaries: z.array(z.object({
    topic: z.string().min(1),
    confidenceScore: z.number().min(0).max(1),
    trustWeightedCoverage: z.number().min(0).max(100),
    evidenceCount: z.number().int().min(0),
  })).default([]),
  factorCards: z.array(factorCardSchema).default([]),
  topEvidenceIds: evidenceIdsSchema,
  model: z.string().min(1).default("rules"),
  reasoningBullets: z.array(z.string().min(1)).default([]),
  summary: z.string().min(1),
  valuation: z.object({
    label: z.enum(["attractive", "fair", "full", "stretched", "cheap", "somewhat_cheap", "somewhat_expensive", "expensive", "unclear"]),
    summary: z.string().min(1),
  }),
  earningsQuality: z.object({
    label: z.enum(["positive", "mixed", "negative", "unclear"]),
    summary: z.string().min(1),
  }),
  catalysts: z.array(z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    freshness: z.enum(["fresh", "recent", "stale", "unclear"]),
    direction: z.enum(["positive", "negative", "mixed"]),
    evidenceIds: evidenceIdsSchema,
  })).default([]),
  risks: z.array(z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    severity: z.enum(["high", "medium", "low"]),
    evidenceIds: evidenceIdsSchema,
  })).default([]),
  contradictions: z.array(z.string().min(1)).default([]),
  confidenceScore: z.number().min(0).max(1),
  confidenceLabel: z.enum(["high", "medium", "low"]),
  catalystFreshnessLabel: z.enum(["fresh", "recent", "stale", "unclear"]),
  riskLabel: z.enum(["low", "moderate", "high"]),
  valuationScore: z.number().min(0).max(100),
  earningsQualityScore: z.number().min(0).max(100),
  catalystQualityScore: z.number().min(0).max(100),
  catalystFreshnessScore: z.number().min(0).max(100),
  riskScore: z.number().min(0).max(100),
  contradictionScore: z.number().min(0).max(100),
});

export const researchRankingRowSchema = z.object({
  ticker: z.string().min(1),
  rank: z.number().int().min(1),
  attentionScore: z.number().min(0).max(100),
  priorityBucket: z.enum(["high", "medium", "monitor"]),
  rankRationale: z.string().min(1),
  scoreDeltaVsPrevious: z.number().nullable().optional(),
  deepDiveRequested: z.boolean().optional().default(false),
  convictionLevel: z.enum(["high", "medium", "low"]).optional(),
  relativeDifferentiation: z.string().optional(),
  deterministicBaseScore: z.number().min(0).max(100).optional(),
  deterministicAdjustmentNarrative: z.string().optional(),
  peerImpactNarrative: z.string().optional(),
});

export const rankingReconciliationSchema = z.object({
  rankings: z.array(researchRankingRowSchema).default([]),
});

export const researchDeepDiveSchema = z.object({
  summary: z.string().min(1),
  watchItems: z.array(z.string().min(1)).default([]),
  bullCase: z.string().min(1),
  bearCase: z.string().min(1),
  actualSetup: z.string().min(1),
  pricedInView: z.string().min(1),
  underappreciatedView: z.string().min(1),
  evidencePriorities: z.array(z.string().min(1)).default([]),
  peerTake: z.string().min(1),
  leadershipView: z.string().min(1),
  invalidation: z.string().min(1),
  swingWorkflowSoWhat: z.string().min(1),
  evidenceIdsBySection: z.record(z.array(z.string().min(1))).default({}),
  model: z.string().min(1).default("rules"),
});

export const researchRunCreateSchema = z.object({
  sourceType: z.enum(["watchlist_set", "manual"]).default("watchlist_set"),
  sourceId: z.string().nullable().optional(),
  sourceLabel: z.string().nullable().optional(),
  watchlistRunId: z.string().nullable().optional(),
  sourceBasis: z.enum(["compiled", "unique"]).optional().default("unique"),
  tickers: z.array(z.string().min(1).transform((value) => value.trim().toUpperCase())).optional(),
  selectedTickers: z.array(z.string().min(1).transform((value) => value.trim().toUpperCase())).optional(),
  profileId: z.string().nullable().optional(),
  maxTickers: z.number().int().min(1).max(100).nullable().optional(),
  refreshMode: z.enum(["reuse_fresh_search_cache", "force_fresh"]).optional().default("reuse_fresh_search_cache"),
  rankingMode: z.enum(["rank_only", "rank_and_deep_dive"]).optional().default("rank_only"),
  deepDiveTopN: z.number().int().min(0).max(20).nullable().optional(),
});

export const researchCompareQuerySchema = z.object({
  baselineSnapshotId: z.string().nullable().optional(),
});

export const researchProfileCreateSchema = z.object({
  slug: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  isActive: z.boolean().optional().default(true),
  isDefault: z.boolean().optional().default(false),
});

export const researchProfilePatchSchema = z.object({
  slug: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  currentVersionId: z.string().nullable().optional(),
});

export const researchProfileVersionCreateSchema = z.object({
  promptVersionIdHaiku: z.string().min(1),
  promptVersionIdSonnetRank: z.string().min(1),
  promptVersionIdSonnetDeepDive: z.string().min(1),
  rubricVersionId: z.string().min(1),
  searchTemplateVersionId: z.string().min(1),
  settings: profileSettingsSchema,
  activate: z.boolean().optional().default(true),
});

export const promptVersionCreateSchema = z.object({
  promptKind: z.enum(["haiku_extract", "sonnet_rank", "sonnet_deep_dive"]),
  label: z.string().trim().min(1).max(120),
  providerKey: z.string().trim().min(1).max(40).default("anthropic"),
  modelFamily: z.string().trim().min(1).max(80),
  schemaVersion: z.string().trim().min(1).max(20).default("v2"),
  templateText: z.string().trim().min(1).max(40000).nullable().optional(),
  templateJson: z.record(z.unknown()).nullable().optional(),
});

export const rubricVersionCreateSchema = z.object({
  label: z.string().trim().min(1).max(120),
  schemaVersion: z.string().trim().min(1).max(20).default("v2"),
  rubricJson: z.record(z.unknown()),
});

export const searchTemplateVersionCreateSchema = z.object({
  label: z.string().trim().min(1).max(120),
  schemaVersion: z.string().trim().min(1).max(20).default("v2"),
  templateJson: z.record(z.unknown()),
});

export function normalizeResearchProfileSettings(input: Partial<ResearchProfileSettings> | null | undefined): ResearchProfileSettings {
  const merged: ResearchProfileSettings = {
    ...DEFAULT_RESEARCH_SETTINGS,
    ...(input ?? {}),
    sourceFamilies: {
      ...DEFAULT_RESEARCH_SETTINGS.sourceFamilies,
      ...(input?.sourceFamilies ?? {}),
    },
  };
  if (merged.peerComparisonEnabled == null) {
    merged.peerComparisonEnabled = merged.comparisonEnabled;
  }
  if (merged.maxPeerCandidates == null) {
    merged.maxPeerCandidates = Math.min(RESEARCH_MAX_PEER_CANDIDATES, DEFAULT_RESEARCH_SETTINGS.maxPeerCandidates ?? 3);
  }
  if (merged.maxTopicEvidenceItems == null) {
    merged.maxTopicEvidenceItems = RESEARCH_DEFAULT_TOPIC_EVIDENCE_ITEMS;
  }
  if (merged.maxEvidenceExcerptsPerTopic == null) {
    merged.maxEvidenceExcerptsPerTopic = RESEARCH_DEFAULT_TOPIC_EXCERPTS;
  }
  return profileSettingsSchema.parse(merged);
}

export function validatePeerComparisonConsistency(value: PeerComparisonBlock): PeerComparisonBlock {
  return peerComparisonSchema.parse(value);
}

function ensureEvidenceIdsExist(candidateIds: string[], evidenceIds: Set<string>) {
  return candidateIds.filter((id) => evidenceIds.has(id));
}

export function validateResearchCardOutput(
  raw: unknown,
  availableEvidenceIds: Iterable<string>,
): StandardizedResearchCard {
  const parsed = standardizedResearchCardSchema.parse(raw);
  const evidenceIdSet = new Set(availableEvidenceIds);
  const sanitize = (ids: string[]) => ensureEvidenceIdsExist(ids, evidenceIdSet);
  parsed.topEvidenceIds = sanitize(parsed.topEvidenceIds);
  parsed.thesisOverview.evidenceIds = sanitize(parsed.thesisOverview.evidenceIds);
  parsed.marketPricing.evidenceIds = sanitize(parsed.marketPricing.evidenceIds);
  parsed.earningsQualityDetailed.evidenceIds = sanitize(parsed.earningsQualityDetailed.evidenceIds);
  parsed.catalystAssessment = parsed.catalystAssessment.map((item) => ({ ...item, evidenceIds: sanitize(item.evidenceIds) }));
  parsed.riskAssessment = parsed.riskAssessment.map((item) => ({ ...item, evidenceIds: sanitize(item.evidenceIds) }));
  parsed.contradictionsDetailed = parsed.contradictionsDetailed.map((item) => ({ ...item, evidenceIds: sanitize(item.evidenceIds) }));
  parsed.valuationView.evidenceIds = sanitize(parsed.valuationView.evidenceIds);
  parsed.thematicFit.evidenceIds = sanitize(parsed.thematicFit.evidenceIds);
  parsed.setupQuality.evidenceIds = sanitize(parsed.setupQuality.evidenceIds);
  parsed.peerComparison = {
    ...parsed.peerComparison,
    evidenceIds: sanitize(parsed.peerComparison.evidenceIds),
  };
  parsed.overallConclusion.evidenceIds = sanitize(parsed.overallConclusion.evidenceIds);
  parsed.factorCards = parsed.factorCards.map((item) => ({ ...item, evidenceIds: sanitize(item.evidenceIds) }));
  parsed.catalysts = parsed.catalysts.map((item) => ({ ...item, evidenceIds: sanitize(item.evidenceIds) }));
  parsed.risks = parsed.risks.map((item) => ({ ...item, evidenceIds: sanitize(item.evidenceIds) }));
  return parsed as StandardizedResearchCard;
}

export function validateRankingReconciliationOutput(raw: unknown): { rankings: ResearchRankingCard[] } {
  return rankingReconciliationSchema.parse(raw) as { rankings: ResearchRankingCard[] };
}

export function validateResearchDeepDiveOutput(
  raw: unknown,
  availableEvidenceIds: Iterable<string>,
): ResearchDeepDive {
  const parsed = researchDeepDiveSchema.parse(raw);
  const evidenceIdSet = new Set(availableEvidenceIds);
  parsed.evidenceIdsBySection = Object.fromEntries(
    Object.entries(parsed.evidenceIdsBySection).map(([key, ids]) => [key, ensureEvidenceIdsExist(ids, evidenceIdSet)]),
  );
  return parsed as ResearchDeepDive;
}

export function clampRankingAdjustment(candidate: number): number {
  if (!Number.isFinite(candidate)) return 0;
  return Math.max(-RESEARCH_MAX_RANKING_ADJUSTMENT, Math.min(RESEARCH_MAX_RANKING_ADJUSTMENT, candidate));
}

export function normalizeFactorCards(factors: ResearchFactorCard[]): ResearchFactorCard[] {
  return factors.map((factor) => ({
    ...factor,
    score: Math.max(0, Math.min(100, factor.score)),
    confidenceScore: Math.max(0, Math.min(1, factor.confidenceScore)),
    weightApplied: Math.max(0, Math.min(1, factor.weightApplied)),
  }));
}
