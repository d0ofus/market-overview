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

export type BraveSearchCaller = "daily_commentary" | "weekly_review" | "fomc";

export type BraveUsageDailyRow = {
  usageDay: string;
  caller: BraveSearchCaller;
  apiCallCount: number;
  apiErrorCount: number;
  cacheHitCount: number;
  lastCalledAt: string | null;
  lastErrorAt: string | null;
  updatedAt: string;
};

export type AdminBraveUsageResponse = {
  days: number;
  rows: BraveUsageDailyRow[];
  totals: {
    apiCallCount: number;
    apiErrorCount: number;
    cacheHitCount: number;
  };
};

type BraveSearchCacheRow = {
  responseJson: string;
  expiresAt: string;
};

export const GEMINI_PROVIDER = "gemini";
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

function normalizeBraveQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const bytesOut = new Uint8Array(digest);
  let hex = "";
  for (let index = 0; index < bytesOut.length; index += 1) {
    hex += bytesOut[index].toString(16).padStart(2, "0");
  }
  return hex;
}

async function braveCacheKey(input: { query: string; freshness: string; count: number; dateBucket: string }): Promise<string> {
  return await sha256Hex(`v1|freshness=${input.freshness}|count=${input.count}|bucket=${input.dateBucket}|q=${input.query}`);
}

function isMissingBraveUsageTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /no such table|brave_usage_daily/i.test(message);
}

async function incrementBraveUsage(
  env: Env,
  caller: BraveSearchCaller,
  nowIso: string,
  delta: { apiCalls?: number; apiErrors?: number; cacheHits?: number },
): Promise<void> {
  const apiCalls = delta.apiCalls ?? 0;
  const apiErrors = delta.apiErrors ?? 0;
  const cacheHits = delta.cacheHits ?? 0;
  const lastCalledAt = apiCalls > 0 ? nowIso : null;
  const lastErrorAt = apiErrors > 0 ? nowIso : null;
  await env.DB.prepare(
    `INSERT INTO brave_usage_daily
       (usage_day, caller, api_call_count, api_error_count, cache_hit_count, last_called_at, last_error_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(usage_day, caller) DO UPDATE SET
       api_call_count = brave_usage_daily.api_call_count + excluded.api_call_count,
       api_error_count = brave_usage_daily.api_error_count + excluded.api_error_count,
       cache_hit_count = brave_usage_daily.cache_hit_count + excluded.cache_hit_count,
       last_called_at = COALESCE(excluded.last_called_at, brave_usage_daily.last_called_at),
       last_error_at = COALESCE(excluded.last_error_at, brave_usage_daily.last_error_at),
       updated_at = excluded.updated_at`,
  )
    .bind(nowIso.slice(0, 10), caller, apiCalls, apiErrors, cacheHits, lastCalledAt, lastErrorAt, nowIso)
    .run();
}

async function tryIncrementBraveUsage(
  env: Env,
  caller: BraveSearchCaller,
  nowIso: string,
  delta: { apiCalls?: number; apiErrors?: number; cacheHits?: number },
): Promise<void> {
  try {
    await incrementBraveUsage(env, caller, nowIso, delta);
  } catch (error) {
    console.warn("Brave Search usage logging failed", { caller, error });
  }
}

async function readBraveCache(env: Env, cacheKey: string, nowIso: string): Promise<BraveSearchResult[] | null> {
  const row = await env.DB.prepare(
    `SELECT response_json as responseJson, expires_at as expiresAt
       FROM brave_search_cache
      WHERE cache_key = ? AND expires_at > ?
      LIMIT 1`,
  ).bind(cacheKey, nowIso).first<BraveSearchCacheRow>();
  if (!row) return null;
  const parsed = JSON.parse(row.responseJson) as BraveSearchResult[];
  return Array.isArray(parsed) ? parsed : null;
}

async function markBraveCacheHit(env: Env, cacheKey: string, nowIso: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE brave_search_cache
        SET last_hit_at = ?,
            hit_count = hit_count + 1
      WHERE cache_key = ?`,
  ).bind(nowIso, cacheKey).run();
}

async function writeBraveCache(env: Env, input: {
  cacheKey: string;
  query: string;
  freshness: string;
  dateBucket: string;
  results: BraveSearchResult[];
  fetchedAt: string;
  expiresAt: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO brave_search_cache
       (cache_key, query, freshness, date_bucket, response_json, result_count, fetched_at, expires_at, last_hit_at, hit_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
     ON CONFLICT(cache_key) DO UPDATE SET
       query = excluded.query,
       freshness = excluded.freshness,
       date_bucket = excluded.date_bucket,
       response_json = excluded.response_json,
       result_count = excluded.result_count,
       fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at`,
  )
    .bind(
      input.cacheKey,
      input.query,
      input.freshness,
      input.dateBucket,
      JSON.stringify(input.results),
      input.results.length,
      input.fetchedAt,
      input.expiresAt,
    )
    .run();
}

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

function normalizeCitationText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isInternalSourceLinkText(linkText: string, internalSourceNames: string[]): boolean {
  const normalizedLinkText = normalizeCitationText(linkText);
  if (!normalizedLinkText) return false;
  return internalSourceNames.some((sourceName) => {
    const normalizedSourceName = normalizeCitationText(sourceName);
    return normalizedSourceName
      && (normalizedSourceName.includes(normalizedLinkText) || normalizedLinkText.includes(normalizedSourceName));
  });
}

export function sourceCitationPolicyPrompt(): string {
  return [
    "SOURCE CITATION POLICY",
    "- Only create markdown links for SOURCE AUDIT INPUTS rows that include a non-null url.",
    "- Internal app sources with url=null, including scan presets and stored dashboard snapshots, must be cited as plain text source names, never as markdown links.",
    "- Do not attach external URLs to internal app source names unless that exact URL appears on the same source audit row.",
  ].join("\n");
}

export function sanitizeInternalSourceMarkdownLinks(markdown: string, sourceAudit: MarketReportSourceAudit[]): string {
  const internalSourceNames = normalizeSourceAuditRows(sourceAudit)
    .filter((source) => !source.url)
    .map((source) => source.sourceName);
  if (internalSourceNames.length === 0) return markdown;
  return markdown.replace(/\[([^\]\n]+)]\((https?:\/\/[^)\s]+)\)/g, (match, linkText: string) => (
    isInternalSourceLinkText(linkText, internalSourceNames) ? linkText : match
  ));
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

export async function cachedBraveSearch(
  env: Env,
  query: string,
  options: {
    caller: BraveSearchCaller;
    freshness?: string;
    count?: number;
    timeoutMs?: string | number;
    dateBucket: string;
    ttlSeconds: number;
    now?: Date;
  },
): Promise<BraveSearchResult[]> {
  const apiKey = env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) throw new Error("BRAVE_SEARCH_API_KEY is not configured.");

  const normalizedQuery = normalizeBraveQuery(query);
  if (!normalizedQuery) return [];

  const freshness = options.freshness ?? "pd";
  const count = Math.max(1, Math.min(10, options.count ?? 5));
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const cacheKey = await braveCacheKey({
    query: normalizedQuery,
    freshness,
    count,
    dateBucket: options.dateBucket,
  });

  try {
    const cached = await readBraveCache(env, cacheKey, nowIso);
    if (cached) {
      await Promise.all([
        markBraveCacheHit(env, cacheKey, nowIso).catch((error) => console.warn("Brave Search cache hit update failed", { caller: options.caller, error })),
        tryIncrementBraveUsage(env, options.caller, nowIso, { cacheHits: 1 }),
      ]);
      return cached;
    }
  } catch (error) {
    console.warn("Brave Search cache lookup failed", { caller: options.caller, error });
  }

  await tryIncrementBraveUsage(env, options.caller, nowIso, { apiCalls: 1 });
  try {
    const results = await braveSearch(apiKey, normalizedQuery, { freshness, count, timeoutMs: options.timeoutMs });
    const ttlSeconds = Math.max(1, Math.floor(options.ttlSeconds));
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    await writeBraveCache(env, {
      cacheKey,
      query: normalizedQuery,
      freshness,
      dateBucket: options.dateBucket,
      results,
      fetchedAt: nowIso,
      expiresAt,
    }).catch((error) => console.warn("Brave Search cache write failed", { caller: options.caller, error }));
    return results;
  } catch (error) {
    await tryIncrementBraveUsage(env, options.caller, nowIso, { apiErrors: 1 });
    throw error;
  }
}

export async function summarizeBraveSearch(
  env: Env,
  queries: string[],
  dataQuality: MarketReportDataQuality[],
  sourceAudit: MarketReportSourceAudit[],
  options?: { metric?: string; freshness?: string; dataUsedPrefix?: string; caller?: BraveSearchCaller; dateBucket?: string; ttlSeconds?: number; now?: Date },
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
    const now = options?.now ?? new Date();
    const dateBucket = options?.dateBucket ?? `daily:${now.toISOString().slice(0, 10)}`;
    const batches = await Promise.all(uniqueQueries.map(async (query) => ({
      query,
      results: await cachedBraveSearch(env, query, {
        caller: options?.caller ?? "weekly_review",
        freshness: options?.freshness ?? "pw",
        timeoutMs: env.BRAVE_SEARCH_TIMEOUT_MS,
        dateBucket,
        ttlSeconds: options?.ttlSeconds ?? 86400,
        now,
      }),
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

export async function loadBraveUsageDaily(env: Env, daysInput = 14, now = new Date()): Promise<AdminBraveUsageResponse> {
  const days = Math.max(1, Math.min(90, Math.floor(Number(daysInput) || 14)));
  const cutoff = new Date(now.getTime() - (days - 1) * 24 * 60 * 60_000).toISOString().slice(0, 10);
  try {
    const rowsResult = await env.DB.prepare(
      `SELECT usage_day as usageDay,
              caller,
              api_call_count as apiCallCount,
              api_error_count as apiErrorCount,
              cache_hit_count as cacheHitCount,
              last_called_at as lastCalledAt,
              last_error_at as lastErrorAt,
              updated_at as updatedAt
         FROM brave_usage_daily
        WHERE usage_day >= ?
        ORDER BY usage_day DESC, caller ASC`,
    ).bind(cutoff).all<BraveUsageDailyRow>();
    const rows = (rowsResult.results ?? []).map((row) => ({
      usageDay: row.usageDay,
      caller: row.caller,
      apiCallCount: Number(row.apiCallCount ?? 0),
      apiErrorCount: Number(row.apiErrorCount ?? 0),
      cacheHitCount: Number(row.cacheHitCount ?? 0),
      lastCalledAt: row.lastCalledAt ?? null,
      lastErrorAt: row.lastErrorAt ?? null,
      updatedAt: row.updatedAt,
    }));
    const totals = rows.reduce((acc, row) => ({
      apiCallCount: acc.apiCallCount + row.apiCallCount,
      apiErrorCount: acc.apiErrorCount + row.apiErrorCount,
      cacheHitCount: acc.cacheHitCount + row.cacheHitCount,
    }), { apiCallCount: 0, apiErrorCount: 0, cacheHitCount: 0 });
    return { days, rows, totals };
  } catch (error) {
    if (isMissingBraveUsageTable(error)) {
      return {
        days,
        rows: [],
        totals: { apiCallCount: 0, apiErrorCount: 0, cacheHitCount: 0 },
      };
    }
    throw error;
  }
}

export async function generateMarkdownWithGemini(
  env: Env,
  prompt: string,
  options?: { maxOutputTokens?: number; temperature?: number; topP?: number; responseMimeType?: string },
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
        ...(options?.responseMimeType ? { responseMimeType: options.responseMimeType } : {}),
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
