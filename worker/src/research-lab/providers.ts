import type { Env } from "../types";
import { fetchWithTimeout } from "../research/providers/http";
import { searchPerplexity } from "../research/providers/perplexity-search";
import { RESEARCH_LAB_ANTHROPIC_TIMEOUT_MS, RESEARCH_LAB_PERPLEXITY_TIMEOUT_MS } from "./constants";
import type { ResearchLabPromptConfigRecord } from "./types";

function anthropicContentToText(content: unknown): string {
  return Array.isArray(content)
    ? content.map((part) => String((part as { text?: unknown })?.text ?? "")).join("\n")
    : String(content ?? "");
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function parseStrictJson<T>(rawText: string): T {
  const candidate = stripJsonFence(rawText);
  return JSON.parse(candidate) as T;
}

export function resolveResearchLabSonnetModel(env: Env, promptConfig: ResearchLabPromptConfigRecord): string {
  return env.ANTHROPIC_SONNET_MODEL?.trim() || promptConfig.modelFamily;
}

export async function callResearchLabSonnetJson<T>(env: Env, input: {
  promptConfig: ResearchLabPromptConfigRecord;
  user: string;
  maxTokens?: number;
}): Promise<{ data: T; usage: Record<string, unknown> | null; model: string }> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Anthropic API key is not configured.");
  }
  const model = resolveResearchLabSonnetModel(env, input.promptConfig);
  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: input.maxTokens ?? 2200,
      temperature: 0,
      system: input.promptConfig.systemPrompt,
      messages: [{
        role: "user",
        content: input.user,
      }],
    }),
  }, RESEARCH_LAB_ANTHROPIC_TIMEOUT_MS, `Anthropic request for ${model}`);

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Anthropic request failed for ${model} (${response.status}): ${detail.slice(0, 180)}`);
  }

  const json = await response.json() as Record<string, any>;
  const rawText = anthropicContentToText(json?.content);
  let data: T;
  try {
    data = parseStrictJson<T>(rawText);
  } catch (error) {
    throw new Error(`Anthropic response was not valid strict JSON: ${error instanceof Error ? error.message : "Unknown parse error."}`);
  }
  return {
    data,
    usage: (json?.usage && typeof json.usage === "object") ? json.usage as Record<string, unknown> : null,
    model: String(json?.model ?? model),
  };
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
