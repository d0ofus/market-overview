import type { Env } from "./types";
import { fetchWithTimeout, resolveFetchTimeoutMs } from "./timeout";

export type MarketReportSourceAudit = {
  sourceName: string;
  url: string | null;
  dataUsed: string;
  timestamp: string | null;
  note?: string | null;
};

export type MarketReportDataQuality = {
  metric: string;
  status: "ok" | "stale" | "unavailable" | "not_configured";
  note: string;
};

export type BraveSearchResult = {
  title: string;
  url: string;
  description: string | null;
  source: string | null;
  publishedAt: string | null;
};

export const GEMINI_PROVIDER = "gemini";
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

export function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

export function parseJsonObject<T extends Record<string, unknown>>(value: string | null | undefined): T {
  if (!value) return {} as T;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : {} as T;
  } catch {
    return {} as T;
  }
}

export function normalizeSourceAuditRows(rows: MarketReportSourceAudit[]): MarketReportSourceAudit[] {
  return rows
    .map((row) => ({
      sourceName: row.sourceName?.trim() || "Unknown source",
      url: row.url?.trim() || null,
      dataUsed: row.dataUsed?.trim() || "Report evidence",
      timestamp: row.timestamp?.trim() || null,
      note: row.note?.trim() || null,
    }))
    .filter((row) => row.sourceName && row.dataUsed);
}

export async function braveSearch(apiKey: string, query: string, options?: { freshness?: string; count?: number; timeoutMs?: string | number }): Promise<BraveSearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.max(1, Math.min(10, options?.count ?? 5))));
  url.searchParams.set("country", "us");
  url.searchParams.set("search_lang", "en");
  url.searchParams.set("freshness", options?.freshness ?? "pd");
  const timeoutMs = resolveFetchTimeoutMs(options?.timeoutMs, 15_000);
  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  }, timeoutMs);
  if (!response.ok) {
    throw new Error(`Brave Search failed with HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
        profile?: { name?: string };
        age?: string;
      }>;
    };
  };
  return (payload.web?.results ?? [])
    .filter((result) => result.url && result.title)
    .map((result) => ({
      title: String(result.title),
      url: String(result.url),
      description: result.description ? String(result.description).replace(/<[^>]+>/g, "") : null,
      source: result.profile?.name ? String(result.profile.name) : null,
      publishedAt: result.age ? String(result.age) : null,
    }));
}

export async function summarizeBraveSearch(
  env: Env,
  queries: string[],
  dataQuality: MarketReportDataQuality[],
  sourceAudit: MarketReportSourceAudit[],
  options?: { metric?: string; freshness?: string; dataUsedPrefix?: string },
): Promise<string> {
  const metric = options?.metric ?? "Fresh web/news search";
  const apiKey = env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) {
    dataQuality.push({
      metric,
      status: "not_configured",
      note: "BRAVE_SEARCH_API_KEY is not configured; report will rely on existing app data and static official-source references.",
    });
    return `${metric}: N/A. BRAVE_SEARCH_API_KEY is not configured.`;
  }

  try {
    const uniqueQueries = Array.from(new Set(queries.map((query) => query.trim()).filter(Boolean))).slice(0, 12);
    const batches = await Promise.all(uniqueQueries.map(async (query) => ({
      query,
      results: await braveSearch(apiKey, query, { freshness: options?.freshness ?? "pw", timeoutMs: env.BRAVE_SEARCH_TIMEOUT_MS }),
    })));
    const lines: string[] = [];
    let resultCount = 0;
    for (const batch of batches) {
      lines.push(`Query: ${batch.query}`);
      for (const result of batch.results) {
        resultCount += 1;
        sourceAudit.push({
          sourceName: result.source ?? result.title,
          url: result.url,
          dataUsed: `${options?.dataUsedPrefix ?? "Brave Search result for"}: ${batch.query}`,
          timestamp: result.publishedAt,
        });
        lines.push(`- ${result.title} (${result.source ?? "source N/A"}): ${result.description ?? "N/A"} URL: ${result.url}`);
      }
    }
    dataQuality.push({
      metric,
      status: resultCount > 0 ? "ok" : "unavailable",
      note: resultCount > 0 ? `Loaded ${resultCount} Brave Search results.` : "Brave Search returned no usable results.",
    });
    return lines.join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Brave Search failed.";
    dataQuality.push({ metric, status: "unavailable", note: message });
    return `${metric}: N/A. ${message}`;
  }
}

export async function generateMarkdownWithGemini(
  env: Env,
  prompt: string,
  options?: { maxOutputTokens?: number; temperature?: number; topP?: number },
): Promise<{ text: string; sources: MarketReportSourceAudit[]; model: string; provider: string }> {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");

  const model = env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const groundingEnabled = env.GEMINI_SEARCH_GROUNDING_ENABLED?.trim().toLowerCase() === "true";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const timeoutMs = resolveFetchTimeoutMs(env.GEMINI_TIMEOUT_MS, 90_000);
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ...(groundingEnabled ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: {
        temperature: options?.temperature ?? 0.2,
        topP: options?.topP ?? 0.9,
        maxOutputTokens: options?.maxOutputTokens ?? 24000,
      },
    }),
  }, timeoutMs);

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gemini request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }

  const payload = await response.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: {
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      };
    }>;
  };
  const candidate = payload.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("").trim() ?? "";
  if (!text) throw new Error("Gemini returned an empty report.");

  const sources = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((chunk): MarketReportSourceAudit | null => {
      const uri = chunk.web?.uri;
      if (!uri) return null;
      return {
        sourceName: chunk.web?.title ?? "Gemini Google Search grounding",
        url: uri,
        dataUsed: "Gemini grounding citation",
        timestamp: null,
      };
    })
    .filter((source): source is MarketReportSourceAudit => Boolean(source));

  return { text, sources, model, provider: GEMINI_PROVIDER };
}
