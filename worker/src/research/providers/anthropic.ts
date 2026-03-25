import type { Env } from "../../types";
import { fetchWithTimeout } from "./http";

export type AnthropicJsonResponse<T> = {
  data: T;
  usage: Record<string, unknown> | null;
  model: string;
};

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
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<AnthropicJsonResponse<T>> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("Anthropic API key is not configured.");
  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: input.model,
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
  }, 25_000, `Anthropic request for ${input.model}`);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Anthropic request failed (${res.status}): ${detail.slice(0, 180)}`);
  }
  const json = await res.json() as Record<string, any>;
  return {
    data: extractJson<T>(json?.content),
    usage: (json?.usage && typeof json.usage === "object") ? json.usage as Record<string, unknown> : null,
    model: String(json?.model ?? input.model),
  };
}
