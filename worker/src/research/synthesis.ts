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
  warning: string | null;
}> {
  const fallback = fallbackRankResearchCards(input);
  if (!env.ANTHROPIC_API_KEY || input.cards.length === 0) {
    return {
      ...fallback,
      usage: null,
      model: "rules",
      warning: !env.ANTHROPIC_API_KEY ? "Anthropic ranking skipped because ANTHROPIC_API_KEY is not configured." : null,
    };
  }
  const provider = getModelResearchProvider(env);
  try {
    const response = await provider.callJson<{
      rankings?: Array<{
        ticker: string;
        rank: number;
        attentionScore: number;
        priorityBucket: "high" | "medium" | "monitor";
        rankRationale: string;
      }>;
    }>(env, {
      model: env.ANTHROPIC_SONNET_MODEL?.trim() || input.prompt.modelFamily,
      fallbackModels: [env.ANTHROPIC_HAIKU_MODEL?.trim() ?? ""],
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
      maxTokens: 1200,
    });
    const rawRankings = Array.isArray(response.data?.rankings)
      ? response.data.rankings
      : Array.isArray(response.data)
        ? response.data as Array<{
          ticker: string;
          rank: number;
          attentionScore: number;
          priorityBucket: "high" | "medium" | "monitor";
          rankRationale: string;
        }>
        : [];
    if (rawRankings.length === 0) {
      return {
        ...fallback,
        usage: response.usage,
        model: response.model,
        warning: "Anthropic ranking returned no usable rankings array.",
      };
    }
    const rankingMap = new Map(rawRankings.map((ranking) => [ranking.ticker, ranking]));
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
}): Promise<{ deepDive: ResearchDeepDive; usage: Record<string, unknown> | null; model: string; warning: string | null }> {
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
      warning: "Anthropic deep dive skipped because ANTHROPIC_API_KEY is not configured.",
    };
  }
  const provider = getModelResearchProvider(env);
  try {
    const response = await provider.callJson<ResearchDeepDive>(env, {
      model: env.ANTHROPIC_SONNET_MODEL?.trim() || input.prompt.modelFamily,
      fallbackModels: [env.ANTHROPIC_HAIKU_MODEL?.trim() ?? ""],
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
      maxTokens: 1000,
    });
    const normalized: ResearchDeepDive = {
      summary: typeof response.data?.summary === "string" && response.data.summary.trim()
        ? response.data.summary.trim()
        : input.card.summary,
      watchItems: Array.isArray(response.data?.watchItems) && response.data.watchItems.length > 0
        ? response.data.watchItems.map((item) => String(item))
        : input.card.catalysts.slice(0, 3).map((item) => item.title),
      bullCase: typeof response.data?.bullCase === "string" && response.data.bullCase.trim()
        ? response.data.bullCase.trim()
        : input.card.catalysts[0]?.summary ?? "Fresh upside catalyst remains limited.",
      bearCase: typeof response.data?.bearCase === "string" && response.data.bearCase.trim()
        ? response.data.bearCase.trim()
        : input.card.risks[0]?.summary ?? "No dominant bear-case evidence was isolated.",
      model: response.model,
    };
    return {
      deepDive: normalized,
      usage: response.usage,
      model: response.model,
      warning: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Anthropic deep dive failed.";
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
      warning: message,
    };
  }
}
