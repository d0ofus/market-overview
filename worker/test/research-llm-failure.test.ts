import { afterEach, describe, expect, it, vi } from "vitest";
import { extractResearchCard } from "../src/research/extraction";
import { deepDiveResearchCard, rankResearchCards } from "../src/research/synthesis";
import type {
  PromptVersionRecord,
  ResearchEvidenceRecord,
  ResearchProfileSettings,
  StandardizedResearchCard,
} from "../src/research/types";

const env = {
  ANTHROPIC_API_KEY: "test-key",
} as any;

const settings: ResearchProfileSettings = {
  lookbackDays: 14,
  includeMacroContext: true,
  maxTickerQueries: 4,
  maxEvidenceItemsPerTicker: 12,
  maxSearchResultsPerQuery: 4,
  maxTickersPerRun: 20,
  deepDiveTopN: 3,
  comparisonEnabled: true,
  peerComparisonEnabled: true,
  maxPeerCandidates: 3,
  maxTopicEvidenceItems: 4,
  maxEvidenceExcerptsPerTopic: 2,
  sourceFamilies: {
    sec: true,
    news: true,
    earningsTranscripts: true,
    investorRelations: true,
    analystCommentary: true,
  },
};

const extractPrompt: PromptVersionRecord = {
  id: "prompt-haiku-extract-v2",
  promptKind: "haiku_extract",
  versionNumber: 2,
  label: "extract",
  providerKey: "anthropic",
  modelFamily: "claude-3-5-haiku-20241022",
  schemaVersion: "v2",
  templateText: "Extract a deep, evidence-grounded research card.",
  templateJson: null,
  isActive: true,
  createdAt: new Date().toISOString(),
};

const sonnetPrompt: PromptVersionRecord = {
  id: "prompt-sonnet-rank-v2",
  promptKind: "sonnet_rank",
  versionNumber: 2,
  label: "rank",
  providerKey: "anthropic",
  modelFamily: "claude-3-7-sonnet-latest",
  schemaVersion: "v2",
  templateText: "Rank the supplied cards.",
  templateJson: null,
  isActive: true,
  createdAt: new Date().toISOString(),
};

const evidence: ResearchEvidenceRecord[] = [{
  id: "e1",
  providerKey: "perplexity_search",
  sourceKind: "news",
  scopeKind: "ticker",
  ticker: "CLMT",
  secCik: null,
  canonicalUrl: "https://example.com/catalyst",
  sourceDomain: "example.com",
  title: "CLMT wins new contract and sees demand accelerate",
  publishedAt: new Date().toISOString(),
  retrievedAt: new Date().toISOString(),
  artifactSizeBytes: null,
  r2Key: null,
  snippet: {
    summary: "Management highlighted stronger demand and a new contract win.",
    excerpt: "Demand accelerated after the company announced a new contract.",
    bullets: ["new contract", "demand accelerated"],
  },
  metadata: null,
  providerPayload: null,
  contentHash: "hash",
  cacheKey: "cache",
  createdAt: new Date().toISOString(),
}];

const card: StandardizedResearchCard = {
  ticker: "CLMT",
  companyName: "Calumet",
  thesisOverview: {
    stance: "positive",
    oneParagraph: "Demand remains constructive.",
    whyNow: "Fresh positive news is in the evidence set.",
    whatWouldChangeMyMind: "Execution slips or demand fades.",
    evidenceIds: ["e1"],
  },
  marketPricing: {
    pricedInAssessment: "partially_priced_in",
    whatExpectationsSeemEmbedded: "The market expects some improvement.",
    whyUpsideDownsideMayStillRemain: "Fresh evidence may still be underappreciated.",
    evidenceIds: ["e1"],
  },
  earningsQualityDetailed: {
    revenueQuality: "Limited in fixture.",
    marginQuality: "Limited in fixture.",
    cashFlowQuality: "Limited in fixture.",
    guideQuality: "Limited in fixture.",
    beatOrMissQuality: "Limited in fixture.",
    oneOffsOrNoise: "Limited in fixture.",
    evidenceIds: ["e1"],
  },
  catalystAssessment: [{
    title: "Contract win",
    summary: "Fresh positive contract news.",
    strength: "medium",
    timing: "immediate",
    durability: "medium",
    pricedInStatus: "partially_priced_in",
    direction: "positive",
    evidenceIds: ["e1"],
  }],
  riskAssessment: [{
    title: "Execution risk",
    summary: "Execution still has to follow through.",
    severity: "medium",
    probability: "medium",
    timeframe: "near_term",
    likelyImpact: "Would weaken the setup.",
    evidenceIds: ["e1"],
  }],
  contradictionsDetailed: [],
  valuationView: {
    label: "fair",
    summary: "Valuation looks fair in the fixture.",
    metricsReferenced: [],
    relativeVsHistory: "unclear",
    relativeVsPeers: "unclear",
    multipleRisk: "moderate",
    evidenceIds: ["e1"],
  },
  thematicFit: {
    themeName: "Energy demand",
    label: "average",
    durability: "medium",
    adoptionSignal: "Demand accelerated.",
    competitiveDensity: "moderate",
    evidenceIds: ["e1"],
  },
  setupQuality: {
    label: "medium",
    summary: "Needs LLM synthesis to validate.",
    whatNeedsToHappenNext: "Fresh evidence needs to be synthesized.",
    invalidationTriggers: ["Demand fades"],
    evidenceIds: ["e1"],
  },
  peerComparison: {
    available: false,
    confidence: "low",
    reasonUnavailable: "No peer context in fixture.",
    peerGroupName: null,
    closestPeers: [],
    whyTheseAreClosestPeers: "",
    earningsQualityRelative: "unclear",
    growthOutlookRelative: "unclear",
    historicalExecutionRelative: "unclear",
    valuationRelative: "unclear",
    priceLeadershipRelative: "unclear",
    fundamentalLeadershipRelative: "unclear",
    strategicPositionRelative: "",
    whatThisTickerDoesBetterThanPeers: "",
    whatPeersDoBetterThanThisTicker: "",
    peerRisksOrPeerAdvantages: "",
    evidenceIds: [],
  },
  overallConclusion: {
    thesis: "Fresh evidence looks constructive.",
    bestBullArgument: "Positive demand news may matter.",
    bestBearArgument: "Execution risk remains.",
    keyWatchItems: ["Contract win"],
    nextCatalystWindow: "near_term",
    confidenceLabel: "medium",
    confidenceScore: 0.6,
    evidenceIds: ["e1"],
  },
  evidenceTopicSummaries: [],
  summary: "Fresh evidence looks constructive.",
  valuation: { label: "fair", summary: "Valuation looks fair in the fixture." },
  earningsQuality: { label: "mixed", summary: "Limited in fixture." },
  catalysts: [{ title: "Contract win", summary: "Fresh positive contract news.", freshness: "fresh", direction: "positive", evidenceIds: ["e1"] }],
  risks: [{ title: "Execution risk", summary: "Execution still has to follow through.", severity: "medium", evidenceIds: ["e1"] }],
  contradictions: [],
  confidenceScore: 0.6,
  confidenceLabel: "medium",
  catalystFreshnessLabel: "fresh",
  riskLabel: "moderate",
  factorCards: [],
  topEvidenceIds: ["e1"],
  valuationScore: 60,
  earningsQualityScore: 55,
  catalystQualityScore: 70,
  catalystFreshnessScore: 82,
  riskScore: 55,
  contradictionScore: 80,
  model: "claude",
  reasoningBullets: ["fixture"],
};

describe("research LLM failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fails extraction instead of returning a deterministic fallback card", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));

    await expect(extractResearchCard(env, {
      ticker: "CLMT",
      companyName: "Calumet",
      evidence,
      prompt: extractPrompt,
      settings,
    })).rejects.toThrow(/LLM extraction failed/);
  });

  it("fails ranking instead of returning a deterministic fallback ranking", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));

    await expect(rankResearchCards(env, {
      cards: [card, { ...card, ticker: "BG", companyName: "Bunge" }],
      prompt: sonnetPrompt,
      rubric: {},
      settings,
      deepDiveTopN: 1,
    })).rejects.toThrow(/LLM ranking failed/);
  });

  it("fails deep dive instead of returning a deterministic fallback narrative", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));

    await expect(deepDiveResearchCard(env, {
      card,
      prompt: {
        ...sonnetPrompt,
        id: "prompt-sonnet-deep-dive-v2",
        promptKind: "sonnet_deep_dive",
      },
    })).rejects.toThrow(/LLM deep dive failed/);
  });
});
