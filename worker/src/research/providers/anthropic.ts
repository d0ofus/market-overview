import type { Env } from "../../types";
import { fetchWithTimeout } from "./http";

export type AnthropicJsonResponse<T> = {
  data: T;
  usage: Record<string, unknown> | null;
  model: string;
};

const ANTHROPIC_MAX_ATTEMPTS = 2;
const DEFAULT_ANTHROPIC_SONNET_MODEL = "claude-3-5-sonnet-20241022";

function normalizeModelName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function uniqueModels(candidates: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeModelName(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    models.push(normalized);
  }
  return models;
}

function isHaikuModel(model: string): boolean {
  return /haiku/i.test(model);
}

export function buildAnthropicExtractionModels(env: Env, promptModel: string): { model: string; fallbackModels: string[] } {
  const model = normalizeModelName(env.ANTHROPIC_HAIKU_MODEL) ?? normalizeModelName(promptModel) ?? "claude-3-haiku-20240307";
  return {
    model,
    fallbackModels: uniqueModels([
      env.ANTHROPIC_SONNET_MODEL,
      DEFAULT_ANTHROPIC_SONNET_MODEL,
    ]).filter((candidate) => candidate !== model),
  };
}

export function buildAnthropicSonnetModels(env: Env, promptModel: string): { model: string; fallbackModels: string[] } {
  const requested = normalizeModelName(env.ANTHROPIC_SONNET_MODEL) ?? normalizeModelName(promptModel) ?? DEFAULT_ANTHROPIC_SONNET_MODEL;
  const model = isHaikuModel(requested) ? DEFAULT_ANTHROPIC_SONNET_MODEL : requested;
  return {
    model,
    fallbackModels: uniqueModels([
      env.ANTHROPIC_SONNET_MODEL,
      !isHaikuModel(promptModel) ? promptModel : null,
      DEFAULT_ANTHROPIC_SONNET_MODEL,
    ]).filter((candidate) => candidate !== model),
  };
}

function shouldRetryAnthropic(status: number, detail: string): boolean {
  if (status === 429 || status === 529) return true;
  if (status >= 500 && status <= 599) return true;
  return /overloaded_error|rate_limit_error|temporarily unavailable/i.test(detail);
}

function retryDelayMs(attempt: number): number {
  const base = 800 * (2 ** attempt);
  return base + Math.floor(Math.random() * 300);
}

function anthropicContentToText(content: unknown): string {
  return Array.isArray(content)
    ? content.map((part) => String((part as { text?: unknown })?.text ?? "")).join("\n")
    : String(content ?? "");
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function findBalancedJsonValue(text: string): string | null {
  const trimmed = text.trim();
  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const candidates = [objectStart, arrayStart].filter((value) => value >= 0).sort((left, right) => left - right);
  if (candidates.length === 0) return null;
  const start = candidates[0]!;
  const stack: string[] = [];
  let inString = false;
  let escaping = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const opener = stack.pop();
      if (!opener) return null;
      if ((char === "}" && opener !== "{") || (char === "]" && opener !== "[")) {
        return null;
      }
      if (stack.length === 0) {
        return trimmed.slice(start, index + 1);
      }
    }
  }
  return null;
}

function removeTrailingCommas(text: string): string {
  let current = text;
  while (true) {
    const next = current.replace(/,\s*([}\]])/g, "$1");
    if (next === current) return current;
    current = next;
  }
}

function buildJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const stripped = stripCodeFence(trimmed);
  const candidates = [
    trimmed,
    stripped,
    findBalancedJsonValue(trimmed),
    findBalancedJsonValue(stripped),
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));
  const output: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    for (const variant of [candidate.trim(), removeTrailingCommas(candidate.trim())]) {
      if (!variant || seen.has(variant)) continue;
      seen.add(variant);
      output.push(variant);
    }
  }
  return output;
}

function extractJson<T>(content: unknown): T {
  const text = anthropicContentToText(content);
  const candidates = buildJsonCandidates(text);
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unknown JSON parse error.");
    }
  }
  const detail = lastError?.message ?? "No JSON object or array could be isolated.";
  throw new Error(`Anthropic response was not valid JSON: ${detail}`);
}

async function repairAnthropicJson<T>(apiKey: string, model: string, rawText: string): Promise<T> {
  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      temperature: 0,
      system: [
        "You repair malformed JSON.",
        "Return strict JSON only.",
        "Preserve the original structure and wording where possible.",
        "If the JSON is truncated, complete it conservatively and minimally.",
      ].join(" "),
      messages: [
        {
          role: "user",
          content: rawText,
        },
      ],
    }),
  }, 15_000, `Anthropic JSON repair for ${model}`);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Anthropic JSON repair failed for ${model} (${res.status}): ${detail.slice(0, 180)}`);
  }
  const json = await res.json() as Record<string, any>;
  return extractJson<T>(json?.content);
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
          temperature: 0,
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
        let data: T;
        try {
          data = extractJson<T>(json?.content);
        } catch (error) {
          try {
            const repairModel = modelCandidates[Math.min(modelIndex + 1, modelCandidates.length - 1)] ?? model;
            data = await repairAnthropicJson<T>(apiKey, repairModel, anthropicContentToText(json?.content));
            return {
              data,
              usage: (json?.usage && typeof json.usage === "object") ? json.usage as Record<string, unknown> : null,
              model: String(json?.model ?? model),
            };
          } catch {
            // Fall through to retry / fallback handling below.
          }
          const parseError = error instanceof Error
            ? new Error(`Anthropic JSON parse failed for ${model}: ${error.message}`)
            : new Error(`Anthropic JSON parse failed for ${model}.`);
          lastError = parseError;
          const hasModelFallback = modelIndex < modelCandidates.length - 1;
          if (attempt < ANTHROPIC_MAX_ATTEMPTS - 1) {
            await scheduler.wait(retryDelayMs(attempt));
            continue;
          }
          if (hasModelFallback) {
            await scheduler.wait(retryDelayMs(attempt));
            break;
          }
          throw parseError;
        }
        return {
          data,
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
