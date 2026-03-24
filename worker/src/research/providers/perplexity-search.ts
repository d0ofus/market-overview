import type { Env } from "../../types";

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
};

export type PerplexitySearchItem = {
  title: string;
  url: string | null;
  summary: string;
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
  options?: { forceFresh?: boolean },
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
          "Response shape: {\"items\":[{\"title\":\"\",\"url\":\"\",\"summary\":\"\",\"publishedAt\":null,\"sourceDomain\":\"\"}]}",
          "Use only recent public evidence. If nothing useful is found, return {\"items\":[]}.",
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
        }),
      },
    ],
  };
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Perplexity search failed (${res.status}): ${detail.slice(0, 180)}`);
  }
  const json = await res.json() as Record<string, any>;
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
