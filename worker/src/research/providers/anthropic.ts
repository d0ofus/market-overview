import type { Env } from "../../types";
import { fetchWithTimeout } from "./http";

export type AnthropicJsonResponse<T> = {
  data: T;
  usage: Record<string, unknown> | null;
  model: string;
};

const ANTHROPIC_MAX_ATTEMPTS = 4;

function shouldRetryAnthropic(status: number, detail: string): boolean {
  if (status === 429 || status === 529) return true;
  if (status >= 500 && status <= 599) return true;
  return /overloaded_error|rate_limit_error|temporarily unavailable/i.test(detail);
}

function retryDelayMs(attempt: number): number {
  const base = 800 * (2 ** attempt);
  return base + Math.floor(Math.random() * 300);
}

function extractJson<T>(content: unknown): T {
  const text = Array.isArray(content)
    ? content.map((part) => String((part as { text?: unknown })?.text ?? "")).join("\n")
    : String(content ?? "");
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }
    throw new Error("Anthropic response was not valid JSON.");
  }
}

export async function callAnthropicJson<T>(env: Env, input: {
  model: string;
  fallbackModels?: string[];
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<AnthropicJsonResponse<T>> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("Anthropic API key is not configured.");
  let lastError: Error | null = null;
  const modelCandidates = Array.from(new Set([
    input.model,
    ...(input.fallbackModels ?? []),
  ].map((candidate) => candidate.trim()).filter(Boolean)));
  for (let modelIndex = 0; modelIndex < modelCandidates.length; modelIndex += 1) {
    const model = modelCandidates[modelIndex]!;
    for (let attempt = 0; attempt < ANTHROPIC_MAX_ATTEMPTS; attempt += 1) {
      const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: input.maxTokens ?? 1800,
          temperature: 0.1,
          system: input.system,
          messages: [
            {
              role: "user",
              content: input.user,
            },
          ],
        }),
      }, 25_000, `Anthropic request for ${model}`);
      if (res.ok) {
        const json = await res.json() as Record<string, any>;
        return {
          data: extractJson<T>(json?.content),
          usage: (json?.usage && typeof json.usage === "object") ? json.usage as Record<string, unknown> : null,
          model: String(json?.model ?? model),
        };
      }

      const detail = await res.text();
      const error = new Error(`Anthropic request failed for ${model} (${res.status}): ${detail.slice(0, 180)}`);
      lastError = error;
      const hasModelFallback = modelIndex < modelCandidates.length - 1;
      if (!shouldRetryAnthropic(res.status, detail)) {
        throw error;
      }
      if (attempt < ANTHROPIC_MAX_ATTEMPTS - 1) {
        await scheduler.wait(retryDelayMs(attempt));
        continue;
      }
      if (hasModelFallback) {
        await scheduler.wait(retryDelayMs(attempt));
        break;
      }
      throw error;
    }
  }
  throw lastError ?? new Error("Anthropic request failed.");
}
