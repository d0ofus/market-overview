import type { Env } from "../types";
import { getModelResearchProvider } from "./providers";
import {
  buildTopicEvidencePackets,
  computeTopicEvidenceConfidence,
  inferEvidenceTopic,
  summarizeEvidenceTopics,
  summarizeEvidence,
} from "./evidence";
import { buildAnthropicExtractionModels } from "./providers/anthropic";
import { normalizeResearchProfileSettings, validateResearchCardOutput } from "./validation";
import type {
  PeerComparisonBlock,
  PeerContextPacket,
  PromptVersionRecord,
  ResearchConfidenceLabel,
  ResearchEvidenceRecord,
  ResearchMarketPricingBlock,
  ResearchProfileSettings,
  StandardizedResearchCard,
  TopicEvidencePacket,
} from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function inferOpinion(score: number): "positive" | "mixed" | "negative" | "unclear" {
  if (score >= 68) return "positive";
  if (score <= 38) return "negative";
  if (score > 0) return "mixed";
  return "unclear";
}

function inferFreshness(records: ResearchEvidenceRecord[]): "fresh" | "recent" | "stale" | "unclear" {
  const newest = records
    .map((record) => Date.parse(record.publishedAt ?? record.retrievedAt))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left)[0];
  if (!Number.isFinite(newest)) return "unclear";
  const ageDays = (Date.now() - newest) / 86400_000;
  if (ageDays <= 3) return "fresh";
  if (ageDays <= 14) return "recent";
  return "stale";
}

function sourceSummary(packets: TopicEvidencePacket[], topic: TopicEvidencePacket["topic"]): string {
  const packet = packets.find((item) => item.topic === topic);
  return packet?.items[0]?.summary || packet?.items[0]?.excerpt || "Evidence was limited.";
}

function summarizePeerContext(peerContext?: PeerContextPacket | null): PeerComparisonBlock {
  if (!peerContext?.available || peerContext.confidence === "low") {
    return {
      available: false,
      confidence: "low",
      reasonUnavailable: peerContext?.reasonUnavailable ?? "Peer context was too weak or unavailable for a credible comparison.",
      peerGroupName: peerContext?.peerGroupName ?? null,
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
    };
  }
  return {
    available: true,
    confidence: peerContext.confidence,
    reasonUnavailable: null,
    peerGroupName: peerContext.peerGroupName,
    closestPeers: peerContext.closestPeers.map((peer) => peer.ticker),
    whyTheseAreClosestPeers: peerContext.whyTheseAreClosestPeers,
    earningsQualityRelative: "average",
    growthOutlookRelative: "average",
    historicalExecutionRelative: "average",
    valuationRelative: "fair",
    priceLeadershipRelative: "neutral",
    fundamentalLeadershipRelative: "average",
    strategicPositionRelative: "Peer positioning appears credible but incomplete; treat this as directional rather than precise.",
    whatThisTickerDoesBetterThanPeers: "Direct evidence shows some differentiated strengths, but peer evidence remains only partly structured.",
    whatPeersDoBetterThanThisTicker: "Some peers may offer cleaner relative valuation or execution evidence.",
    peerRisksOrPeerAdvantages: "Peer framing is useful, but confidence depends on the quality of the selected peer group and available evidence.",
    evidenceIds: [],
  };
}

function confidenceLabel(score: number): ResearchConfidenceLabel {
  if (score >= 0.8) return "high";
  if (score >= 0.55) return "medium";
  return "low";
}

function deriveCompatibilityFields(card: any): StandardizedResearchCard {
  const catalysts = card.catalystAssessment.map((item) => ({
    title: item.title,
    summary: item.summary,
    freshness: item.timing === "immediate" ? "fresh" : item.timing === "next_1_2_quarters" ? "recent" : item.timing === "longer_term" ? "stale" : "unclear",
    direction: item.direction,
    evidenceIds: item.evidenceIds,
  }));
  const risks = card.riskAssessment.map((item) => ({
    title: item.title,
    summary: item.summary,
    severity: item.severity,
    evidenceIds: item.evidenceIds,
  }));
  const contradictions = card.contradictionsDetailed.map((item) => item.tension);
  const confidenceScore = clamp(card.overallConclusion.confidenceScore, 0, 1);
  const catalystFreshnessLabel = catalysts[0]?.freshness ?? "unclear";
  const valuationScore =
    card.valuationView.label === "attractive" || card.valuationView.label === "cheap" ? 75
      : card.valuationView.label === "fair" || card.valuationView.label === "somewhat_cheap" ? 60
        : card.valuationView.label === "full" || card.valuationView.label === "somewhat_expensive" ? 45
          : card.valuationView.label === "stretched" || card.valuationView.label === "expensive" ? 30
            : 50;
  const earningsQualityScore =
    card.earningsQualityDetailed.evidenceIds.length >= 3 ? 70
      : card.earningsQualityDetailed.evidenceIds.length >= 1 ? 58
        : 45;
  const catalystQualityScore = clamp(
    Math.round(card.catalystAssessment.reduce((sum, item) => sum + (
      item.strength === "high" ? 85
        : item.strength === "medium_high" ? 72
          : item.strength === "medium" ? 58
            : item.strength === "low" ? 38
              : 45
    ), 0) / Math.max(card.catalystAssessment.length, 1)),
    0,
    100,
  );
  const catalystFreshnessScore = catalystFreshnessLabel === "fresh" ? 82 : catalystFreshnessLabel === "recent" ? 66 : catalystFreshnessLabel === "stale" ? 38 : 30;
  const riskScore = clamp(
    100 - Math.round(card.riskAssessment.reduce((sum, item) => sum + (item.severity === "high" ? 70 : item.severity === "medium" ? 50 : 28), 0) / Math.max(card.riskAssessment.length, 1)),
    0,
    100,
  );
  const contradictionScore = clamp(100 - (contradictions.length * 18), 20, 100);
  return {
    ...card,
    summary: card.thesisOverview.oneParagraph,
    valuation: {
      label: card.valuationView.label,
      summary: card.valuationView.summary,
    },
    earningsQuality: {
      label: inferOpinion(earningsQualityScore),
      summary: [
        card.earningsQualityDetailed.revenueQuality,
        card.earningsQualityDetailed.marginQuality,
        card.earningsQualityDetailed.cashFlowQuality,
      ].filter(Boolean).join(" "),
    },
    catalysts,
    risks,
    contradictions,
    confidenceScore,
    confidenceLabel: card.overallConclusion.confidenceLabel,
    catalystFreshnessLabel,
    riskLabel: riskScore >= 70 ? "low" : riskScore >= 50 ? "moderate" : "high",
    valuationScore,
    earningsQualityScore,
    catalystQualityScore,
    catalystFreshnessScore,
    riskScore,
    contradictionScore,
  };
}

export function fallbackExtractResearchCard(input: {
  ticker: string;
  companyName: string | null;
  evidence: ResearchEvidenceRecord[];
  settings?: ResearchProfileSettings | null;
  peerContext?: PeerContextPacket | null;
  topicPackets?: TopicEvidencePacket[] | null;
}): StandardizedResearchCard {
  const settings = normalizeResearchProfileSettings(input.settings ?? {});
  const packets = input.topicPackets ?? buildTopicEvidencePackets(input.evidence, settings);
  const topEvidenceIds = summarizeEvidence(input.evidence, 8).map((item) => item.id);
  const secFacts = input.evidence.filter((record) => record.sourceKind === "sec_facts");
  const freshCatalystRecords = input.evidence.filter((record) => inferEvidenceTopic(record) === "catalysts");
  const riskRecords = input.evidence.filter((record) => inferEvidenceTopic(record) === "risks");
  const confidenceScore = clamp(
    computeTopicEvidenceConfidence(input.evidence.slice(0, Math.max(1, settings.maxEvidenceItemsPerTicker))),
    0.25,
    0.88,
  );
  const marketPricing: ResearchMarketPricingBlock = {
    pricedInAssessment: freshCatalystRecords.length >= 2 ? "partially_priced_in" : "unclear",
    whatExpectationsSeemEmbedded: sourceSummary(packets, "market_pricing"),
    whyUpsideDownsideMayStillRemain: riskRecords.length > 0
      ? sourceSummary(packets, "risks")
      : "Evidence does not yet separate what is already priced in from what may still be underappreciated.",
    evidenceIds: packets.find((packet) => packet.topic === "market_pricing")?.evidenceIds ?? [],
  };
  const base = {
    ticker: input.ticker,
    companyName: input.companyName,
    thesisOverview: {
      stance: freshCatalystRecords.length > Math.max(1, riskRecords.length) ? "positive" : riskRecords.length > freshCatalystRecords.length ? "negative" : "mixed",
      oneParagraph: sourceSummary(packets, "general") || `${input.ticker} has limited evidence coverage in this run; review the citations before acting.`,
      whyNow: sourceSummary(packets, "catalysts"),
      whatWouldChangeMyMind: riskRecords[0]?.snippet?.summary ?? "A change in the evidence mix, guidance quality, or valuation backdrop would alter the stance.",
      evidenceIds: topEvidenceIds.slice(0, 3),
    },
    marketPricing,
    earningsQualityDetailed: {
      revenueQuality: sourceSummary(packets, "earnings_quality"),
      marginQuality: secFacts[0]?.snippet?.summary ?? "Margin evidence was limited.",
      cashFlowQuality: secFacts.find((item) => /cash/i.test(item.title))?.snippet?.summary ?? "Cash flow evidence was limited.",
      guideQuality: sourceSummary(packets, "general"),
      beatOrMissQuality: sourceSummary(packets, "earnings_quality"),
      oneOffsOrNoise: "The fallback path cannot fully separate recurring drivers from one-offs without richer extraction output.",
      evidenceIds: packets.find((packet) => packet.topic === "earnings_quality")?.evidenceIds ?? topEvidenceIds.slice(0, 3),
    },
    catalystAssessment: freshCatalystRecords.slice(0, 3).map((record) => ({
      title: record.title,
      summary: record.snippet?.summary ?? "",
      strength: "medium",
      timing: inferFreshness([record]) === "fresh" ? "immediate" : "next_1_2_quarters",
      durability: "medium",
      pricedInStatus: "partially_priced_in",
      direction: "positive" as const,
      evidenceIds: [record.id],
    })),
    riskAssessment: [
      ...riskRecords.slice(0, 3).map((record) => ({
        title: record.title,
        summary: record.snippet?.summary ?? "",
        severity: "medium" as const,
        probability: "medium" as const,
        timeframe: "near_term" as const,
        likelyImpact: "Would weaken the setup and reduce attention priority.",
        evidenceIds: [record.id],
      })),
      ...(riskRecords.length === 0 ? [{
        title: "Limited risk visibility",
        summary: "Evidence was too thin to build a high-confidence downside map.",
        severity: "medium" as const,
        probability: "unclear" as const,
        timeframe: "unclear" as const,
        likelyImpact: "Low visibility lowers confidence even if the thesis remains interesting.",
        evidenceIds: [],
      }] : []),
    ].slice(0, 3),
    contradictionsDetailed: [],
    valuationView: {
      label: secFacts.length > 1 ? "fair" : "unclear",
      summary: secFacts.length > 1
        ? "Structured company facts provide a basic valuation frame, but the fallback path cannot fully judge what the market has already discounted."
        : "Valuation remains unclear because structured financial coverage was thin.",
      metricsReferenced: secFacts.map((item) => item.title).slice(0, 4),
      relativeVsHistory: "unclear" as const,
      relativeVsPeers: input.peerContext?.available ? "fair" : "unclear",
      multipleRisk: "moderate" as const,
      evidenceIds: packets.find((packet) => packet.topic === "valuation")?.evidenceIds ?? topEvidenceIds.slice(0, 2),
    },
    thematicFit: {
      themeName: "Unclear / mixed theme support",
      label: freshCatalystRecords.length > 0 ? "average" : "unclear",
      durability: freshCatalystRecords.length > 0 ? "medium" : "unclear",
      adoptionSignal: sourceSummary(packets, "thematic_fit"),
      competitiveDensity: "unclear" as const,
      evidenceIds: packets.find((packet) => packet.topic === "thematic_fit")?.evidenceIds ?? [],
    },
    setupQuality: {
      label: freshCatalystRecords.length >= 2 ? "medium" : "low",
      summary: sourceSummary(packets, "setup_quality") || "The fallback setup view is driven by evidence density rather than deep analytical synthesis.",
      whatNeedsToHappenNext: "Evidence quality, earnings confirmation, and clearer priced-in framing need to improve.",
      invalidationTriggers: riskRecords.slice(0, 2).map((record) => record.title),
      evidenceIds: packets.find((packet) => packet.topic === "setup_quality")?.evidenceIds ?? topEvidenceIds.slice(0, 2),
    },
    peerComparison: summarizePeerContext(input.peerContext),
    overallConclusion: {
      thesis: sourceSummary(packets, "general") || `${input.ticker} remains a low-visibility setup until evidence coverage improves.`,
      bestBullArgument: freshCatalystRecords[0]?.snippet?.summary ?? "There may still be upside if emerging catalysts are underappreciated.",
      bestBearArgument: riskRecords[0]?.snippet?.summary ?? "Weak evidence quality limits conviction and can mask real downside.",
      keyWatchItems: [
        ...freshCatalystRecords.slice(0, 2).map((record) => record.title),
        ...riskRecords.slice(0, 2).map((record) => record.title),
      ].slice(0, 4),
      nextCatalystWindow: freshCatalystRecords.length > 0 ? "next_1_2_quarters" : "unclear",
      confidenceLabel: confidenceLabel(confidenceScore),
      confidenceScore,
      evidenceIds: topEvidenceIds.slice(0, 4),
    },
    evidenceTopicSummaries: summarizeEvidenceTopics(packets),
    factorCards: [],
    topEvidenceIds,
    model: "rules",
    reasoningBullets: [
      `${input.evidence.length} evidence item(s) were normalized for this ticker.`,
      `${packets.length} topic packet(s) were assembled for extraction.`,
      input.peerContext?.available ? `Peer context included ${input.peerContext.closestPeers.length} peer(s).` : "Peer context was unavailable or too weak to use confidently.",
    ],
  };
  return deriveCompatibilityFields(base);
}

export async function extractResearchCard(env: Env, input: {
  ticker: string;
  companyName: string | null;
  evidence: ResearchEvidenceRecord[];
  prompt: PromptVersionRecord;
  settings?: ResearchProfileSettings | null;
  peerContext?: PeerContextPacket | null;
  topicPackets?: TopicEvidencePacket[] | null;
}): Promise<{ card: StandardizedResearchCard; usage: Record<string, unknown> | null; model: string; warning: string | null }> {
  const settings = normalizeResearchProfileSettings(input.settings ?? {});
  const packets = input.topicPackets ?? buildTopicEvidencePackets(input.evidence, settings);
  const fallback = fallbackExtractResearchCard({ ...input, settings, topicPackets: packets });
  if (!env.ANTHROPIC_API_KEY) {
    return { card: fallback, usage: null, model: fallback.model, warning: "Anthropic extraction skipped because ANTHROPIC_API_KEY is not configured." };
  }
  const modelProvider = getModelResearchProvider(env);
  const models = buildAnthropicExtractionModels(env, input.prompt.modelFamily);
  try {
    const response = await modelProvider.callJson<StandardizedResearchCard>(env, {
      model: models.model,
      fallbackModels: models.fallbackModels,
      system: [
        input.prompt.templateText ?? "Standardize evidence into a structured, evidence-grounded swing research card.",
        "Return strict JSON only.",
        "Keep every narrative field concise: one or two sentences at most.",
        "Ground every material judgment in the supplied evidence IDs.",
        "Separate direct facts from inferred judgments.",
        "Do not invent facts, peers, or valuation metrics.",
        "If peer context is weak, mark peerComparison unavailable or low-confidence and explain why.",
      ].join(" "),
      user: JSON.stringify({
        ticker: input.ticker,
        companyName: input.companyName,
        outputContract: {
          thesisOverview: {
            stance: "positive|mixed|negative|unclear",
            oneParagraph: "string",
            whyNow: "string",
            whatWouldChangeMyMind: "string",
            evidenceIds: ["evidence-id"],
          },
          marketPricing: {
            pricedInAssessment: "underappreciated|partially_priced_in|mostly_priced_in|fully_priced_in|unclear",
            whatExpectationsSeemEmbedded: "string",
            whyUpsideDownsideMayStillRemain: "string",
            evidenceIds: ["evidence-id"],
          },
          earningsQualityDetailed: {
            revenueQuality: "string",
            marginQuality: "string",
            cashFlowQuality: "string",
            guideQuality: "string",
            beatOrMissQuality: "string",
            oneOffsOrNoise: "string",
            evidenceIds: ["evidence-id"],
          },
          catalystAssessment: [{
            title: "string",
            summary: "string",
            strength: "high|medium_high|medium|low|unclear",
            timing: "immediate|next_1_2_quarters|next_3_6_months|longer_term|unclear",
            durability: "high|medium_high|medium|low|unclear",
            pricedInStatus: "not_priced_in|partially_priced_in|mostly_priced_in|fully_priced_in|unclear",
            direction: "positive|negative|mixed",
            evidenceIds: ["evidence-id"],
          }],
          riskAssessment: [{
            title: "string",
            summary: "string",
            severity: "high|medium|low",
            probability: "high|medium|low|unclear",
            timeframe: "near_term|medium_term|long_term|unclear",
            likelyImpact: "string",
            evidenceIds: ["evidence-id"],
          }],
          contradictionsDetailed: [{
            tension: "string",
            whyItMatters: "string",
            likelyDirectionIfResolved: "string",
            evidenceIds: ["evidence-id"],
          }],
          valuationView: {
            label: "attractive|fair|full|stretched|cheap|somewhat_cheap|somewhat_expensive|expensive|unclear",
            summary: "string",
            metricsReferenced: ["string"],
            relativeVsHistory: "below_history|near_history|above_history|unclear",
            relativeVsPeers: "cheap|somewhat_cheap|fair|somewhat_expensive|expensive|unclear",
            multipleRisk: "low|moderate|elevated|high|unclear",
            evidenceIds: ["evidence-id"],
          },
          thematicFit: {
            themeName: "string",
            label: "strong|average|weak|unclear",
            durability: "high|medium|low|unclear",
            adoptionSignal: "string",
            competitiveDensity: "low|moderate|high|unclear",
            evidenceIds: ["evidence-id"],
          },
          setupQuality: {
            label: "high|medium|low|unclear",
            summary: "string",
            whatNeedsToHappenNext: "string",
            invalidationTriggers: ["string"],
            evidenceIds: ["evidence-id"],
          },
          peerComparison: {
            available: "boolean",
            confidence: "high|medium|low",
            reasonUnavailable: "string|null",
            peerGroupName: "string|null",
            closestPeers: ["ticker"],
            whyTheseAreClosestPeers: "string",
            earningsQualityRelative: "leader|above_average|average|below_average|laggard|unclear",
            growthOutlookRelative: "leader|above_average|average|below_average|laggard|unclear",
            historicalExecutionRelative: "leader|above_average|average|below_average|laggard|unclear",
            valuationRelative: "cheap|somewhat_cheap|fair|somewhat_expensive|expensive|unclear",
            priceLeadershipRelative: "leader|improving|neutral|weakening|laggard|unclear",
            fundamentalLeadershipRelative: "leader|strong_contender|average|weak|laggard|unclear",
            strategicPositionRelative: "string",
            whatThisTickerDoesBetterThanPeers: "string",
            whatPeersDoBetterThanThisTicker: "string",
            peerRisksOrPeerAdvantages: "string",
            evidenceIds: ["evidence-id"],
          },
          overallConclusion: {
            thesis: "string",
            bestBullArgument: "string",
            bestBearArgument: "string",
            keyWatchItems: ["string"],
            nextCatalystWindow: "string",
            confidenceLabel: "high|medium|low",
            confidenceScore: "0..1",
            evidenceIds: ["evidence-id"],
          },
        },
        topicEvidencePackets: packets,
        topEvidence: summarizeEvidence(input.evidence, Math.min(12, settings.maxEvidenceItemsPerTicker)).map((item) => ({
          ...item,
          title: item.title.slice(0, 180),
          summary: item.summary.slice(0, 340),
          excerpt: item.excerpt?.slice(0, 220) ?? null,
        })),
        peerContext: input.peerContext ?? null,
      }),
      maxTokens: 2600,
    });
    const parsed = validateResearchCardOutput({
      ...fallback,
      ...response.data,
      model: response.model,
    }, input.evidence.map((item) => item.id));
    const card = deriveCompatibilityFields(parsed);
    return { card, usage: response.usage, model: response.model, warning: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Anthropic extraction failed.";
    return {
      card: {
        ...fallback,
        reasoningBullets: [...fallback.reasoningBullets.slice(0, 2), "Extraction fell back to deterministic synthesis after model output validation failed."],
      },
      usage: null,
      model: "rules",
      warning: message,
    };
  }
}
