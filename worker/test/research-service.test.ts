import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSnapshotComparison } from "../src/research/history";
import { buildMarketSearchQueries, buildTickerSearchQueries } from "../src/research/search-queries";
import { computeAttentionScore, computeFactorCards } from "../src/research/scoring";
import { rankResearchCards } from "../src/research/synthesis";
import type { SearchTemplateVersionRecord, StandardizedResearchCard } from "../src/research/types";

const template: SearchTemplateVersionRecord = {
  id: "search-template-swing-v2",
  versionNumber: 2,
  label: "Default",
  schemaVersion: "v2",
  createdAt: new Date().toISOString(),
  templateJson: {
    tickerFamilies: [
      { key: "pricing_expectations", label: "Pricing", queryTemplate: "{ticker} {companyName} priced in expectations last {lookbackDays} days", limit: 3 },
      { key: "earnings_transcript", label: "Transcript", queryTemplate: "{ticker} earnings call transcript", limit: 2 },
      { key: "valuation", label: "Valuation", queryTemplate: "{ticker} valuation multiple target price last {lookbackDays} days", limit: 3 },
    ],
    macroFamilies: [
      { key: "macro_release", label: "Macro", queryTemplate: "latest CPI release", limit: 1 },
    ],
  },
};

const card: StandardizedResearchCard = {
  ticker: "NVDA",
  companyName: "NVIDIA Corporation",
  thesisOverview: {
    stance: "positive",
    oneParagraph: "Demand remains strong.",
    whyNow: "Fresh catalysts are still active.",
    whatWouldChangeMyMind: "Evidence of weakening demand or deteriorating execution.",
    evidenceIds: ["e1", "e2"],
  },
  marketPricing: {
    pricedInAssessment: "partially_priced_in",
    whatExpectationsSeemEmbedded: "The market expects durable AI-led growth.",
    whyUpsideDownsideMayStillRemain: "Execution can still beat a high bar, but valuation leaves less room for error.",
    evidenceIds: ["e1", "e2"],
  },
  earningsQualityDetailed: {
    revenueQuality: "Demand remains broad.",
    marginQuality: "Margins remain healthy.",
    cashFlowQuality: "Cash flow is still strong.",
    guideQuality: "Guidance remains constructive.",
    beatOrMissQuality: "Recent beats were supported by demand.",
    oneOffsOrNoise: "Some quarter-to-quarter noise remains.",
    evidenceIds: ["e1"],
  },
  catalystAssessment: [{ title: "Product cycle", summary: "Launch cadence remains active.", strength: "high", timing: "immediate", durability: "medium_high", pricedInStatus: "partially_priced_in", direction: "positive", evidenceIds: ["e1"] }],
  riskAssessment: [{ title: "Crowded positioning", summary: "Expectations are elevated.", severity: "medium", probability: "medium", timeframe: "near_term", likelyImpact: "Could compress multiples.", evidenceIds: ["e2"] }],
  contradictionsDetailed: [],
  valuationView: {
    label: "full",
    summary: "Valuation is not cheap.",
    metricsReferenced: ["forward_pe"],
    relativeVsHistory: "above_history",
    relativeVsPeers: "somewhat_expensive",
    multipleRisk: "elevated",
    evidenceIds: ["e2"],
  },
  thematicFit: {
    themeName: "AI infrastructure",
    label: "strong",
    durability: "high",
    adoptionSignal: "Demand remains strong.",
    competitiveDensity: "moderate",
    evidenceIds: ["e1"],
  },
  setupQuality: {
    label: "high",
    summary: "Attention-worthy if execution continues to beat expectations.",
    whatNeedsToHappenNext: "Need continued strong execution.",
    invalidationTriggers: ["Weak guide"],
    evidenceIds: ["e1", "e2"],
  },
  peerComparison: {
    available: false,
    confidence: "low",
    reasonUnavailable: "Peer context unavailable in test fixture.",
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
    thesis: "Demand remains strong.",
    bestBullArgument: "Execution can continue to outrun expectations.",
    bestBearArgument: "Valuation is already full.",
    keyWatchItems: ["Product cycle"],
    nextCatalystWindow: "next earnings",
    confidenceLabel: "medium",
    confidenceScore: 0.72,
    evidenceIds: ["e1", "e2"],
  },
  evidenceTopicSummaries: [],
  summary: "Demand remains strong.",
  valuation: { label: "full", summary: "Valuation is not cheap." },
  earningsQuality: { label: "positive", summary: "Cash flow remains strong." },
  catalysts: [{ title: "Product cycle", summary: "Launch cadence remains active.", freshness: "fresh", direction: "positive", evidenceIds: ["e1"] }],
  risks: [{ title: "Crowded positioning", summary: "Expectations are elevated.", severity: "medium", evidenceIds: ["e2"] }],
  contradictions: [],
  confidenceScore: 0.72,
  confidenceLabel: "medium",
  catalystFreshnessLabel: "fresh",
  riskLabel: "moderate",
  factorCards: [],
  topEvidenceIds: ["e1", "e2"],
  valuationScore: 42,
  earningsQualityScore: 73,
  catalystQualityScore: 76,
  catalystFreshnessScore: 82,
  riskScore: 55,
  contradictionScore: 78,
  model: "rules",
  reasoningBullets: ["Fresh product-cycle catalyst is still in play."],
};

describe("research search query builder", () => {
  it("builds ticker and market queries from a template", () => {
    const settings = {
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
    const tickerQueries = buildTickerSearchQueries({
      ticker: "NVDA",
      companyName: "NVIDIA Corporation",
      irDomain: "nvidia.com",
      template,
      settings,
    });
    const marketQueries = buildMarketSearchQueries({ template, settings });
    expect(tickerQueries[0]?.query).toContain("NVDA");
    expect(tickerQueries.length).toBeGreaterThan(0);
    expect(tickerQueries.length).toBeLessThanOrEqual(4);
    expect(marketQueries.length).toBe(1);
  });
});

describe("research scoring", () => {
  it("computes weighted factor cards and attention score", () => {
    const factors = computeFactorCards(card, {
      weights: {
        market_pricing_mismatch: 0.16,
        earnings_quality: 0.18,
        catalyst_strength: 0.22,
        catalyst_durability: 0.12,
        valuation_attractiveness: 0.12,
        risk_severity_inverse: 0.12,
        contradiction_burden_inverse: 0.08,
        thematic_strength: 0.05,
        setup_quality: 0.05,
        evidence_quality_confidence: 0.1,
      },
    });
    expect(factors.length).toBeGreaterThanOrEqual(10);
    expect(computeAttentionScore(factors)).toBeGreaterThan(60);
  });
});

describe("research history compare", () => {
  it("captures changed catalysts and risks", () => {
    const comparison = buildSnapshotComparison({
      currentSnapshot: {
        id: "s2",
        runId: "r1",
        runTickerId: "rt1",
        ticker: "NVDA",
        profileId: "p1",
        profileVersionId: "pv1",
        previousSnapshotId: "s1",
        schemaVersion: "v2",
        overallScore: 72,
        attentionRank: 1,
        confidenceLabel: "medium",
        confidenceScore: 0.72,
        valuationLabel: "full",
        earningsQualityLabel: "positive",
        catalystFreshnessLabel: "fresh",
        riskLabel: "moderate",
        contradictionFlag: false,
        thesisJson: {},
        changeJson: null,
        citationJson: null,
        modelOutputJson: null,
        createdAt: new Date().toISOString(),
      },
      currentCard: card,
      previousSnapshot: {
        id: "s1",
        runId: "r0",
        runTickerId: "rt0",
        ticker: "NVDA",
        profileId: "p1",
        profileVersionId: "pv1",
        previousSnapshotId: null,
        schemaVersion: "v2",
        overallScore: 66,
        attentionRank: 2,
        confidenceLabel: "medium",
        confidenceScore: 0.61,
        valuationLabel: "stretched",
        earningsQualityLabel: "mixed",
        catalystFreshnessLabel: "recent",
        riskLabel: "high",
        contradictionFlag: false,
        thesisJson: {
          catalysts: [{ title: "Old catalyst" }],
          risks: [{ title: "Crowded positioning" }],
          contradictions: [],
        },
        changeJson: null,
        citationJson: null,
        modelOutputJson: null,
        createdAt: new Date().toISOString(),
      },
    });
    expect(comparison.newCatalysts).toContain("Product cycle");
    expect(comparison.resolvedRisks).toHaveLength(0);
    expect(comparison.scoreDelta).toBe(6);
  });
});

describe("research ranking synthesis", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the LLM even for singleton runs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [
        {
          text: JSON.stringify({
            rankings: [{
              ticker: "NVDA",
              rank: 1,
              attentionScore: 74,
              priorityBucket: "high",
              rankRationale: "Fresh catalysts and strong execution keep the name at the top.",
              convictionLevel: "medium",
              relativeDifferentiation: "Execution still stands out.",
              deterministicAdjustmentNarrative: "No material change from the deterministic base score.",
              peerImpactNarrative: "Peer context is limited in this fixture.",
            }],
          }),
        },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
      model: "claude-test",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const result = await rankResearchCards({
      ANTHROPIC_API_KEY: "present",
    } as any, {
      cards: [card],
      prompt: {
        id: "p1",
        promptKind: "sonnet_rank",
        versionNumber: 1,
        label: "rank",
        providerKey: "anthropic",
        modelFamily: "claude",
        schemaVersion: "v1",
        templateText: null,
        templateJson: null,
        isActive: true,
        createdAt: new Date().toISOString(),
      },
      rubric: {},
      settings: {
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
      },
      deepDiveTopN: 1,
    });

    expect(result.rankings).toHaveLength(1);
    expect(result.rankings[0]?.rank).toBe(1);
    expect(result.model).toBe("claude-test");
    expect(result.warning).toBeNull();
  });
});
