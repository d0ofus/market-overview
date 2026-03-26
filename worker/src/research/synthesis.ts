import type { Env } from "../types";
import { getModelResearchProvider } from "./providers";
import { computeAttentionScore, computeFactorCards, derivePriorityBucket } from "./scoring";
import { clampRankingAdjustment, validateRankingReconciliationOutput, validateResearchDeepDiveOutput } from "./validation";
import { buildAnthropicSonnetModels } from "./providers/anthropic";
import type {
  PeerContextPacket,
  PromptVersionRecord,
  ResearchDeepDive,
  ResearchFactorCard,
  ResearchProfileSettings,
  ResearchRankingCard,
  StandardizedResearchCard,
  TopicEvidencePacket,
} from "./types";

export function buildFallbackDeepDive(card: StandardizedResearchCard): ResearchDeepDive {
  return {
    summary: card.summary,
    watchItems: card.overallConclusion.keyWatchItems.slice(0, 5),
    bullCase: card.overallConclusion.bestBullArgument,
    bearCase: card.overallConclusion.bestBearArgument,
    actualSetup: card.setupQuality.summary,
    pricedInView: card.marketPricing.whyUpsideDownsideMayStillRemain,
    underappreciatedView: card.marketPricing.pricedInAssessment === "underappreciated" || card.marketPricing.pricedInAssessment === "partially_priced_in"
      ? "The current evidence suggests some of the setup may still be underappreciated relative to embedded expectations."
      : "The evidence does not yet establish a large gap between reality and embedded expectations.",
    evidencePriorities: [
      card.earningsQuality.summary,
      card.valuation.summary,
      card.catalysts[0]?.summary ?? "",
    ].filter(Boolean),
    peerTake: card.peerComparison.available
      ? card.peerComparison.strategicPositionRelative || "Peer context is directionally useful but should not override direct evidence."
      : card.peerComparison.reasonUnavailable ?? "Peer context was too weak to make a credible structured comparison.",
    leadershipView: card.peerComparison.available
      ? `Price leadership is ${card.peerComparison.priceLeadershipRelative}; fundamental leadership is ${card.peerComparison.fundamentalLeadershipRelative}.`
      : "Leadership needs to be judged from the ticker's own evidence because peer visibility is weak.",
    invalidation: card.setupQuality.invalidationTriggers.join(", ") || "Further evidence deterioration or valuation pressure would weaken the setup.",
    swingWorkflowSoWhat: card.overallConclusion.thesis,
    evidenceIdsBySection: {
      summary: card.topEvidenceIds.slice(0, 4),
      setup: card.setupQuality.evidenceIds,
      pricedIn: card.marketPricing.evidenceIds,
      peers: card.peerComparison.evidenceIds,
    },
    model: "rules",
  };
}

export function fallbackRankResearchCards(input: {
  cards: StandardizedResearchCard[];
  rubric: Record<string, unknown> | null | undefined;
  settings: ResearchProfileSettings;
  deepDiveTopN: number;
}): {
  rankings: ResearchRankingCard[];
  factorCardsByTicker: Map<string, ResearchFactorCard[]>;
} {
  const factorCardsByTicker = new Map<string, ResearchFactorCard[]>();
  const scored = input.cards.map((card) => {
    const factorCards = computeFactorCards(card, input.rubric);
    factorCardsByTicker.set(card.ticker, factorCards);
    const attentionScore = computeAttentionScore(factorCards);
    return {
      card,
      factorCards,
      attentionScore,
      priorityBucket: derivePriorityBucket(attentionScore),
    };
  }).sort((left, right) => right.attentionScore - left.attentionScore);
  return {
    factorCardsByTicker,
    rankings: scored.map((entry, index) => ({
      ticker: entry.card.ticker,
      rank: index + 1,
      attentionScore: entry.attentionScore,
      priorityBucket: entry.priorityBucket,
      rankRationale: entry.card.overallConclusion.thesis,
      scoreDeltaVsPrevious: null,
      deepDiveRequested: index < input.deepDiveTopN,
      convictionLevel: entry.card.confidenceLabel,
      relativeDifferentiation: entry.card.peerComparison.available
        ? entry.card.peerComparison.strategicPositionRelative
        : entry.card.marketPricing.whyUpsideDownsideMayStillRemain,
      deterministicBaseScore: entry.attentionScore,
      deterministicAdjustmentNarrative: "Deterministic factor scoring was used as the primary ranking signal.",
      peerImpactNarrative: entry.card.peerComparison.available
        ? "Peer context contributed to the base score because peer confidence was adequate."
        : "Peer context was excluded from scoring because it was unavailable or low-confidence.",
    })),
  };
}

export async function rankResearchCards(env: Env, input: {
  cards: StandardizedResearchCard[];
  prompt: PromptVersionRecord;
  rubric: Record<string, unknown> | null | undefined;
  settings: ResearchProfileSettings;
  deepDiveTopN: number;
}): Promise<{
  rankings: ResearchRankingCard[];
  factorCardsByTicker: Map<string, ResearchFactorCard[]>;
  usage: Record<string, unknown> | null;
  model: string;
  warning: string | null;
}> {
  const fallback = fallbackRankResearchCards(input);
  if (input.cards.length <= 1) {
    return {
      ...fallback,
      usage: null,
      model: "rules-singleton",
      warning: null,
    };
  }
  if (!env.ANTHROPIC_API_KEY || input.cards.length === 0) {
    return {
      ...fallback,
      usage: null,
      model: "rules",
      warning: !env.ANTHROPIC_API_KEY ? "Anthropic ranking skipped because ANTHROPIC_API_KEY is not configured." : null,
    };
  }
  const provider = getModelResearchProvider(env);
  const models = buildAnthropicSonnetModels(env, input.prompt.modelFamily);
  try {
    const response = await provider.callJson<{
      rankings?: Array<{
        ticker: string;
        rank: number;
        attentionScore: number;
        priorityBucket: "high" | "medium" | "monitor";
        rankRationale: string;
        convictionLevel?: "high" | "medium" | "low";
        relativeDifferentiation?: string;
        deterministicAdjustmentNarrative?: string;
        peerImpactNarrative?: string;
      }>;
    }>(env, {
      model: models.model,
      fallbackModels: models.fallbackModels,
      system: [
        input.prompt.templateText ?? "Rank swing-trading research cards.",
        "Return strict JSON only.",
        "Do not wrap the JSON in markdown fences.",
        "Keep explanations concise and specific to the supplied cards.",
        "Deterministic factor cards are the canonical base score.",
        "You may reconcile and explain modest differences, but you may not ignore the factor cards.",
      ].join(" "),
      user: JSON.stringify({
        outputContract: {
          rankings: [
            {
              ticker: "string",
              rank: "1-based integer",
              attentionScore: "0..100",
              priorityBucket: "high|medium|monitor",
              rankRationale: "string",
              convictionLevel: "high|medium|low",
              relativeDifferentiation: "string",
              deterministicAdjustmentNarrative: "string",
              peerImpactNarrative: "string",
            },
          ],
        },
        rubric: input.rubric ?? {},
        cards: input.cards.map((card) => ({
          ticker: card.ticker,
          thesisOverview: card.thesisOverview,
          marketPricing: card.marketPricing,
          earningsQualityDetailed: card.earningsQualityDetailed,
          valuationView: card.valuationView,
          thematicFit: card.thematicFit,
          setupQuality: card.setupQuality,
          peerComparison: card.peerComparison,
          overallConclusion: card.overallConclusion,
          evidenceTopicSummaries: card.evidenceTopicSummaries,
          factorCards: fallback.factorCardsByTicker.get(card.ticker) ?? [],
          deterministicBaseScore: fallback.rankings.find((row) => row.ticker === card.ticker)?.attentionScore ?? null,
        })),
      }),
      maxTokens: 1800,
    });
    const parsed = validateRankingReconciliationOutput(response.data);
    const rankingMap = new Map(parsed.rankings.map((ranking) => [ranking.ticker, ranking]));
    return {
      factorCardsByTicker: fallback.factorCardsByTicker,
      rankings: fallback.rankings
        .map((fallbackRow) => {
          const fromModel = rankingMap.get(fallbackRow.ticker);
          if (!fromModel) return fallbackRow;
          const delta = clampRankingAdjustment(fromModel.attentionScore - fallbackRow.attentionScore);
          const adjustedScore = Math.max(0, Math.min(100, Number((fallbackRow.attentionScore + delta).toFixed(1))));
          return {
            ...fallbackRow,
            rank: fromModel.rank,
            attentionScore: adjustedScore,
            priorityBucket: fromModel.priorityBucket,
            rankRationale: fromModel.rankRationale,
            convictionLevel: fromModel.convictionLevel ?? fallbackRow.convictionLevel,
            relativeDifferentiation: fromModel.relativeDifferentiation ?? fallbackRow.relativeDifferentiation,
            deterministicAdjustmentNarrative: fromModel.deterministicAdjustmentNarrative ?? `LLM reconciliation adjusted the base score by ${delta.toFixed(1)} points.`,
            peerImpactNarrative: fromModel.peerImpactNarrative ?? fallbackRow.peerImpactNarrative,
          };
        })
        .sort((left, right) => left.rank - right.rank)
        .map((row, index) => ({
          ...row,
          deepDiveRequested: index < input.deepDiveTopN,
        })),
      usage: response.usage,
      model: response.model,
      warning: null,
    };
  } catch (error) {
    return {
      ...fallback,
      usage: null,
      model: "rules",
      warning: error instanceof Error ? error.message : "Anthropic ranking failed.",
    };
  }
}

export async function deepDiveResearchCard(env: Env, input: {
  card: StandardizedResearchCard;
  prompt: PromptVersionRecord;
  topicPackets?: TopicEvidencePacket[] | null;
  peerContext?: PeerContextPacket | null;
}): Promise<{ deepDive: ResearchDeepDive; usage: Record<string, unknown> | null; model: string; warning: string | null }> {
  const fallback = buildFallbackDeepDive(input.card);
  if (!env.ANTHROPIC_API_KEY) {
    return {
      deepDive: fallback,
      usage: null,
      model: "rules",
      warning: "Anthropic deep dive skipped because ANTHROPIC_API_KEY is not configured.",
    };
  }
  const provider = getModelResearchProvider(env);
  const models = buildAnthropicSonnetModels(env, input.prompt.modelFamily);
  try {
    const response = await provider.callJson<ResearchDeepDive>(env, {
      model: models.model,
      fallbackModels: models.fallbackModels,
      system: [
        input.prompt.templateText ?? "Produce a true PM-style research synthesis.",
        "Return strict JSON only.",
        "Do not wrap the JSON in markdown fences.",
        "Keep each field concise and avoid repeating the same point across sections.",
        "Prioritize synthesis over repetition.",
        "Explain what is priced in, what is underappreciated, why the name matters now, and what would invalidate the thesis.",
        "If peer context is weak, say so explicitly and do not force peer claims.",
      ].join(" "),
      user: JSON.stringify({
        outputContract: {
          summary: "string",
          watchItems: ["string"],
          bullCase: "string",
          bearCase: "string",
          actualSetup: "string",
          pricedInView: "string",
          underappreciatedView: "string",
          evidencePriorities: ["string"],
          peerTake: "string",
          leadershipView: "string",
          invalidation: "string",
          swingWorkflowSoWhat: "string",
          evidenceIdsBySection: { summary: ["evidence-id"] },
        },
        card: input.card,
        topicEvidencePackets: input.topicPackets ?? [],
        peerContext: input.peerContext ?? null,
      }),
      maxTokens: 1400,
    });
    const deepDive = validateResearchDeepDiveOutput(response.data, input.card.topEvidenceIds);
    return {
      deepDive: {
        ...fallback,
        ...deepDive,
        model: response.model,
      },
      usage: response.usage,
      model: response.model,
      warning: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Anthropic deep dive failed.";
    return {
      deepDive: fallback,
      usage: null,
      model: "rules",
      warning: message,
    };
  }
}
