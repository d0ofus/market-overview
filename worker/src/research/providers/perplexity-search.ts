import type { Env } from "../../types";
import { RESEARCH_SEARCH_TIMEOUT_MS } from "../constants";
import { fetchTextWithTimeout } from "./http";

export type PerplexitySearchQuery = {
  key: string;
  label: string;
  query: string;
  scopeKind: "ticker" | "macro" | "market";
  sourceKind:
    | "news"
    | "earnings_transcript"
    | "ir_page"
    | "analyst_commentary"
    | "macro_release"
    | "central_bank"
    | "media";
  limit: number;
  ticker?: string | null;
  maxAgeDays?: number | null;
  requirePublishedAt?: boolean;
};

export type PerplexitySearchItem = {
  title: string;
  url: string | null;
  summary: string;
  excerpt?: string | null;
  bullets?: string[] | null;
  publishedAt: string | null;
  sourceDomain: string | null;
  sourceKind: PerplexitySearchQuery["sourceKind"];
  scopeKind: PerplexitySearchQuery["scopeKind"];
  ticker: string | null;
};

export type PerplexitySearchResult = {
  items: PerplexitySearchItem[];
  usage: Record<string, unknown> | null;
  raw: Record<string, unknown> | null;
};

function extractJsonBlock(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function searchPerplexity(
  env: Env,
  query: PerplexitySearchQuery,
  options?: { forceFresh?: boolean; timeoutMs?: number },
): Promise<PerplexitySearchResult> {
  const apiKey = env.PERPLEXITY_API_KEY?.trim();
  if (!apiKey) {
    return { items: [], usage: null, raw: { warning: "missing_api_key" } };
  }
  const body = {
    model: env.PERPLEXITY_MODEL?.trim() || "sonar-pro",
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: [
          "You are a retrieval layer for a swing-trading research system.",
          "Search recent public web evidence and return strict JSON only.",
          "Response shape: {\"items\":[{\"title\":\"\",\"url\":\"\",\"summary\":\"\",\"excerpt\":null,\"bullets\":[],\"publishedAt\":null,\"sourceDomain\":\"\"}]}",
          "Return newest items first.",
          "Always include publishedAt when it can be determined from the source.",
          "If a recency window is requested, exclude items older than that window rather than returning stale results.",
          "Prefer company-specific developments over generic background coverage.",
          "If nothing useful is found within the requested recency window, return {\"items\":[]}.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          query: query.query,
          limit: query.limit,
          focus: query.label,
          ticker: query.ticker ?? null,
          forceFresh: Boolean(options?.forceFresh),
          sourceKind: query.sourceKind,
          maxAgeDays: query.maxAgeDays ?? null,
          requirePublishedAt: Boolean(query.requirePublishedAt),
          retrievalRules: [
            "Prefer the newest dated items first.",
            query.maxAgeDays
              ? `Exclude items older than ${query.maxAgeDays} days.`
              : "Prefer recent items over older background items.",
            query.requirePublishedAt
              ? "Exclude items without a reliable publishedAt value."
              : "Include publishedAt whenever available.",
            query.key === "news_catalysts"
              ? "For News & Catalysts, prefer company-specific developments such as management changes, guidance, partnerships, product launches, regulatory updates, and material operating news."
              : null,
            query.key === "transcripts" || query.key === "investor_relations"
              ? "Prefer the latest quarter's earnings materials and latest dated investor materials."
              : null,
          ].filter(Boolean),
        }),
      },
    ],
  };
  const timeoutMs = Math.max(1, Number(options?.timeoutMs ?? RESEARCH_SEARCH_TIMEOUT_MS));
  const { response, text } = await fetchTextWithTimeout("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  }, timeoutMs, `Perplexity search for ${query.ticker ?? query.key}`);
  if (!response.ok) {
    throw new Error(`Perplexity search failed (${response.status}): ${text.slice(0, 180)}`);
  }
  let json: Record<string, any>;
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch (error) {
    throw new Error(`Perplexity search returned invalid JSON: ${error instanceof Error ? error.message : "Unknown parse error."}`);
  }
  const content = json?.choices?.[0]?.message?.content;
  const parsed = extractJsonBlock(typeof content === "string" ? content : Array.isArray(content) ? content.map((entry) => entry?.text ?? "").join("\n") : "");
  const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];
  const citations = Array.isArray(json?.citations) ? json.citations : [];
  const items = rawItems
    .map((item, index) => {
      const url = typeof item?.url === "string" && item.url.trim() ? item.url.trim() : typeof citations[index] === "string" ? citations[index] : null;
      return {
        title: String(item?.title ?? query.label).trim() || query.label,
        url,
        summary: String(item?.summary ?? "").trim(),
        excerpt: typeof item?.excerpt === "string" ? item.excerpt.trim() : null,
        bullets: Array.isArray(item?.bullets) ? item.bullets.map((entry: unknown) => String(entry ?? "").trim()).filter(Boolean).slice(0, 3) : null,
        publishedAt: typeof item?.publishedAt === "string" ? item.publishedAt : null,
        sourceDomain: typeof item?.sourceDomain === "string" ? item.sourceDomain : (() => {
          try {
            return url ? new URL(url).hostname.replace(/^www\./i, "") : null;
          } catch {
            return null;
          }
        })(),
        sourceKind: query.sourceKind,
        scopeKind: query.scopeKind,
        ticker: query.ticker ?? null,
      } satisfies PerplexitySearchItem;
    })
    .filter((item) => item.summary || item.url || item.title)
    .slice(0, query.limit);
  return {
    items,
    usage: (json?.usage && typeof json.usage === "object") ? json.usage as Record<string, unknown> : null,
    raw: json,
  };
}
