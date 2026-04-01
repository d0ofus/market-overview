import type { Env } from "../types";
import { searchPerplexity } from "../research/providers/perplexity-search";
import { buildAnthropicSonnetModels, callAnthropicJson } from "../research/providers/anthropic";
import { RESEARCH_LAB_ANTHROPIC_TIMEOUT_MS, RESEARCH_LAB_PERPLEXITY_TIMEOUT_MS } from "./constants";
import type { ResearchLabPromptConfigRecord } from "./types";

export function resolveResearchLabSonnetModels(env: Env, promptConfig: ResearchLabPromptConfigRecord) {
  return buildAnthropicSonnetModels(env, promptConfig.modelFamily);
}

export async function callResearchLabSonnetJson<T>(env: Env, input: {
  promptConfig: ResearchLabPromptConfigRecord;
  user: string;
  maxTokens?: number;
}): Promise<{ data: T; usage: Record<string, unknown> | null; model: string }> {
  const models = resolveResearchLabSonnetModels(env, input.promptConfig);
  return callAnthropicJson<T>(env, {
    model: models.model,
    fallbackModels: models.fallbackModels,
    system: input.promptConfig.systemPrompt,
    user: input.user,
    maxTokens: input.maxTokens ?? 2200,
    requestTimeoutMs: RESEARCH_LAB_ANTHROPIC_TIMEOUT_MS,
    maxAttemptsPerModel: 1,
  });
}

export async function runResearchLabPerplexityQuery(
  env: Env,
  query: {
    key: string;
    label: string;
    query: string;
    ticker: string;
    limit: number;
    sourceKind: "news" | "earnings_transcript" | "ir_page" | "analyst_commentary" | "macro_release" | "media";
    forceFresh?: boolean;
  },
): Promise<Awaited<ReturnType<typeof searchPerplexity>>> {
  return searchPerplexity(env, {
    key: query.key,
    label: query.label,
    query: query.query,
    scopeKind: query.key === "macro_relevance" ? "market" : "ticker",
    sourceKind: query.sourceKind,
    limit: query.limit,
    ticker: query.key === "macro_relevance" ? null : query.ticker,
  }, {
    forceFresh: Boolean(query.forceFresh),
    timeoutMs: RESEARCH_LAB_PERPLEXITY_TIMEOUT_MS,
  });
}
