import type { Env } from "../../types";
import { fetchTextWithTimeout } from "./http";

export type AnthropicJsonResponse<T> = {
  data: T;
  usage: Record<string, unknown> | null;
  model: string;
};

const ANTHROPIC_MAX_ATTEMPTS = 2;
const DEFAULT_ANTHROPIC_HAIKU_MODEL = "claude-3-5-haiku-20241022";
const LEGACY_ANTHROPIC_HAIKU_MODEL = "claude-3-haiku-20240307";
const DEFAULT_ANTHROPIC_SONNET_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_SONNET_MODEL_CANDIDATES = [
  DEFAULT_ANTHROPIC_SONNET_MODEL,
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-sonnet-20241022",
] as const;
const ANTHROPIC_HAIKU_MODEL_CANDIDATES = [
  "claude-3-5-haiku-latest",
  DEFAULT_ANTHROPIC_HAIKU_MODEL,
  LEGACY_ANTHROPIC_HAIKU_MODEL,
] as const;

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

function isSonnetModel(model: string): boolean {
  return /sonnet/i.test(model);
}

export function buildAnthropicExtractionModels(env: Env, promptModel: string): { model: string; fallbackModels: string[] } {
  const requested = normalizeModelName(env.ANTHROPIC_HAIKU_MODEL) ?? normalizeModelName(promptModel);
  const model = requested && !isSonnetModel(requested) ? requested : DEFAULT_ANTHROPIC_HAIKU_MODEL;
  return {
    model,
    fallbackModels: uniqueModels([
      env.ANTHROPIC_HAIKU_MODEL,
      !isSonnetModel(promptModel) ? promptModel : null,
      ...ANTHROPIC_HAIKU_MODEL_CANDIDATES,
      env.ANTHROPIC_SONNET_MODEL,
      ...ANTHROPIC_SONNET_MODEL_CANDIDATES,
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
      ...ANTHROPIC_SONNET_MODEL_CANDIDATES,
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

function shouldFallbackModel(status: number, detail: string): boolean {
  if (status === 404) return true;
  return /not_found_error|model[^a-z0-9]+.*not found|unknown model/i.test(detail);
}

function shouldRetryAnthropicTransportError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  return /timed out|network|fetch failed|connection|socket|econnreset|enotfound|tls|temporarily unavailable/i.test(detail);
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

async function repairAnthropicJson<T>(apiKey: string, model: string, rawText: string, timeoutMs: number): Promise<T> {
  const { response, text } = await fetchTextWithTimeout("https://api.anthropic.com/v1/messages", {
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
  }, timeoutMs, `Anthropic JSON repair for ${model}`);
  if (!response.ok) {
    throw new Error(`Anthropic JSON repair failed for ${model} (${response.status}): ${text.slice(0, 180)}`);
  }
  const json = JSON.parse(text) as Record<string, any>;
  return extractJson<T>(json?.content);
}

export async function callAnthropicJson<T>(env: Env, input: {
  model: string;
  fallbackModels?: string[];
  system: string;
  user: string;
  maxTokens?: number;
  requestTimeoutMs?: number;
  jsonRepairTimeoutMs?: number;
  maxAttemptsPerModel?: number;
}): Promise<AnthropicJsonResponse<T>> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("Anthropic API key is not configured.");
  const requestTimeoutMs = Math.max(5_000, input.requestTimeoutMs ?? 25_000);
  const jsonRepairTimeoutMs = Math.max(3_000, input.jsonRepairTimeoutMs ?? 15_000);
  const maxAttemptsPerModel = Math.max(1, input.maxAttemptsPerModel ?? ANTHROPIC_MAX_ATTEMPTS);
  let lastError: Error | null = null;
  const modelCandidates = Array.from(new Set([
    input.model,
    ...(input.fallbackModels ?? []),
  ].map((candidate) => candidate.trim()).filter(Boolean)));
  for (let modelIndex = 0; modelIndex < modelCandidates.length; modelIndex += 1) {
    const model = modelCandidates[modelIndex]!;
    for (let attempt = 0; attempt < maxAttemptsPerModel; attempt += 1) {
      let response: Response;
      let text: string;
      try {
        ({ response, text } = await fetchTextWithTimeout("https://api.anthropic.com/v1/messages", {
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
        }, requestTimeoutMs, `Anthropic request for ${model}`));
      } catch (error) {
        const transportError = error instanceof Error ? error : new Error("Anthropic request failed.");
        lastError = transportError;
        const hasModelFallback = modelIndex < modelCandidates.length - 1;
        if (!shouldRetryAnthropicTransportError(transportError)) {
          throw transportError;
        }
        if (attempt < maxAttemptsPerModel - 1) {
          await scheduler.wait(retryDelayMs(attempt));
          continue;
        }
        if (hasModelFallback) {
          await scheduler.wait(retryDelayMs(attempt));
          break;
        }
        throw transportError;
      }
      if (response.ok) {
        const json = JSON.parse(text) as Record<string, any>;
        let data: T;
        try {
          data = extractJson<T>(json?.content);
        } catch (error) {
          try {
            const repairModel = modelCandidates[Math.min(modelIndex + 1, modelCandidates.length - 1)] ?? model;
            data = await repairAnthropicJson<T>(apiKey, repairModel, anthropicContentToText(json?.content), jsonRepairTimeoutMs);
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
          if (attempt < maxAttemptsPerModel - 1) {
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

      const detail = text;
      const error = new Error(`Anthropic request failed for ${model} (${response.status}): ${detail.slice(0, 180)}`);
      lastError = error;
      const hasModelFallback = modelIndex < modelCandidates.length - 1;
      if (hasModelFallback && shouldFallbackModel(response.status, detail)) {
        break;
      }
      if (!shouldRetryAnthropic(response.status, detail)) {
        throw error;
      }
      if (attempt < maxAttemptsPerModel - 1) {
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
