import type { Env } from "../types";
import { searchPerplexity } from "../research/providers/perplexity-search";
import { buildAnthropicSonnetModels, callAnthropicJson } from "../research/providers/anthropic";
import {
  RESEARCH_LAB_ANTHROPIC_MAX_ATTEMPTS,
  RESEARCH_LAB_ANTHROPIC_JSON_REPAIR_TIMEOUT_MS,
  RESEARCH_LAB_ANTHROPIC_MAX_TOKENS,
  RESEARCH_LAB_ANTHROPIC_TIMEOUT_MS,
  RESEARCH_LAB_PERPLEXITY_MAX_ATTEMPTS,
  RESEARCH_LAB_PERPLEXITY_TIMEOUT_MS,
} from "./constants";
import type { ResearchLabPromptConfigRecord } from "./types";

export function resolveResearchLabSonnetModels(env: Env, promptConfig: ResearchLabPromptConfigRecord) {
  return buildAnthropicSonnetModels(env, promptConfig.modelFamily);
}

export async function callResearchLabSonnetJson<T>(env: Env, input: {
  promptConfig: ResearchLabPromptConfigRecord;
  user: string;
  maxTokens?: number;
  onHeartbeat?: () => Promise<void> | void;
}): Promise<{ data: T; usage: Record<string, unknown> | null; model: string }> {
  const models = resolveResearchLabSonnetModels(env, input.promptConfig);
  return callAnthropicJson<T>(env, {
    model: models.model,
    fallbackModels: models.fallbackModels,
    system: input.promptConfig.systemPrompt,
    user: input.user,
    maxTokens: input.maxTokens ?? RESEARCH_LAB_ANTHROPIC_MAX_TOKENS,
    requestTimeoutMs: RESEARCH_LAB_ANTHROPIC_TIMEOUT_MS,
    jsonRepairTimeoutMs: RESEARCH_LAB_ANTHROPIC_JSON_REPAIR_TIMEOUT_MS,
    maxAttemptsPerModel: RESEARCH_LAB_ANTHROPIC_MAX_ATTEMPTS,
    onHeartbeat: input.onHeartbeat,
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
    maxAgeDays?: number;
    requirePublishedAt?: boolean;
  },
): Promise<Awaited<ReturnType<typeof searchPerplexity>>> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < RESEARCH_LAB_PERPLEXITY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await searchPerplexity(env, {
        key: query.key,
        label: query.label,
        query: query.query,
        scopeKind: query.key === "macro_relevance" ? "market" : "ticker",
        sourceKind: query.sourceKind,
        limit: query.limit,
        ticker: query.key === "macro_relevance" ? null : query.ticker,
        maxAgeDays: query.maxAgeDays ?? null,
        requirePublishedAt: Boolean(query.requirePublishedAt),
      }, {
        forceFresh: Boolean(query.forceFresh),
        timeoutMs: RESEARCH_LAB_PERPLEXITY_TIMEOUT_MS,
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Perplexity search failed.");
      const isTimeout = /timed out/i.test(lastError.message);
      if (!isTimeout || attempt >= RESEARCH_LAB_PERPLEXITY_MAX_ATTEMPTS - 1) {
        throw lastError;
      }
    }
  }
  throw lastError ?? new Error("Perplexity search failed.");
}
