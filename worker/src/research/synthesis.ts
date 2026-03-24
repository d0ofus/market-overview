import type { Env } from "../types";
import { getModelResearchProvider } from "./providers";
import { computeAttentionScore, computeFactorCards, derivePriorityBucket } from "./scoring";
import type {
  PromptVersionRecord,
  ResearchDeepDive,
  ResearchFactorCard,
  ResearchProfileSettings,
  ResearchRankingCard,
  StandardizedResearchCard,
} from "./types";

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
      rankRationale: entry.card.reasoningBullets[0] ?? entry.card.summary,
      scoreDeltaVsPrevious: null,
      deepDiveRequested: index < input.deepDiveTopN,
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
}> {
  const fallback = fallbackRankResearchCards(input);
  if (!env.ANTHROPIC_API_KEY || input.cards.length === 0) {
    return { ...fallback, usage: null, model: "rules" };
  }
  const provider = getModelResearchProvider(env);
  try {
    const response = await provider.callJson<{
      rankings: Array<{
        ticker: string;
        rank: number;
        attentionScore: number;
        priorityBucket: "high" | "medium" | "monitor";
        rankRationale: string;
      }>;
    }>(env, {
      model: env.ANTHROPIC_SONNET_MODEL?.trim() || input.prompt.modelFamily,
      system: [
        input.prompt.templateText ?? "Rank swing-trading research cards.",
        "Return strict JSON only.",
        "Use the supplied rubric and factor scores as the primary ranking signal.",
      ].join(" "),
      user: JSON.stringify({
        rubric: input.rubric ?? {},
        cards: input.cards.map((card) => ({
          ticker: card.ticker,
          summary: card.summary,
          valuation: card.valuation,
          earningsQuality: card.earningsQuality,
          catalysts: card.catalysts,
          risks: card.risks,
          contradictions: card.contradictions,
          confidenceScore: card.confidenceScore,
        })),
      }),
      maxTokens: 1800,
    });
    const rankingMap = new Map(response.data.rankings.map((ranking) => [ranking.ticker, ranking]));
    return {
      factorCardsByTicker: fallback.factorCardsByTicker,
      rankings: fallback.rankings
        .map((fallbackRow) => {
          const fromModel = rankingMap.get(fallbackRow.ticker);
          return fromModel ? {
            ...fallbackRow,
            rank: fromModel.rank,
            attentionScore: fromModel.attentionScore,
            priorityBucket: fromModel.priorityBucket,
            rankRationale: fromModel.rankRationale,
          } : fallbackRow;
        })
        .sort((left, right) => left.rank - right.rank),
      usage: response.usage,
      model: response.model,
    };
  } catch {
    return { ...fallback, usage: null, model: "rules" };
  }
}

export async function deepDiveResearchCard(env: Env, input: {
  card: StandardizedResearchCard;
  prompt: PromptVersionRecord;
}): Promise<{ deepDive: ResearchDeepDive; usage: Record<string, unknown> | null; model: string }> {
  if (!env.ANTHROPIC_API_KEY) {
    return {
      deepDive: {
        summary: input.card.summary,
        watchItems: input.card.catalysts.slice(0, 3).map((item) => item.title),
        bullCase: input.card.catalysts[0]?.summary ?? "Fresh upside catalyst remains limited.",
        bearCase: input.card.risks[0]?.summary ?? "No dominant bear-case evidence was isolated.",
        model: "rules",
      },
      usage: null,
      model: "rules",
    };
  }
  const provider = getModelResearchProvider(env);
  const response = await provider.callJson<ResearchDeepDive>(env, {
    model: env.ANTHROPIC_SONNET_MODEL?.trim() || input.prompt.modelFamily,
    system: [
      input.prompt.templateText ?? "Produce a concise deep-dive summary.",
      "Return strict JSON only.",
      "Use current evidence only, and treat prior summaries as historical context if they are present.",
    ].join(" "),
    user: JSON.stringify({
      ticker: input.card.ticker,
      companyName: input.card.companyName,
      summary: input.card.summary,
      valuation: input.card.valuation,
      earningsQuality: input.card.earningsQuality,
      catalysts: input.card.catalysts,
      risks: input.card.risks,
      contradictions: input.card.contradictions,
      reasoningBullets: input.card.reasoningBullets,
    }),
    maxTokens: 1400,
  });
  return {
    deepDive: {
      ...response.data,
      model: response.model,
    },
    usage: response.usage,
    model: response.model,
  };
}
