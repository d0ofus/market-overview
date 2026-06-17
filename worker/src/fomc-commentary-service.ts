import type { BraveSearchResult } from "./market-report-common";
import { braveSearch, generateMarkdownWithGemini } from "./market-report-common";
import { fetchWithTimeout, resolveFetchTimeoutMs } from "./timeout";
import type { Env } from "./types";

const FED_HOST_SUFFIX = "federalreserve.gov";
const DEFAULT_SOURCE_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const MIN_OFFICIAL_TEXT_CHARS = 1_000;
const MAX_SOURCE_TEXT_CHARS = 80_000;
const FOMC_AUTO_REFRESH_LIMIT = 4;
const ALLOWED_BRAVE_DOMAINS = [
  "federalreserve.gov",
  "reuters.com",
  "apnews.com",
  "bloomberg.com",
  "wsj.com",
  "ft.com",
  "cnbc.com",
  "marketwatch.com",
];

export type FomcCommentaryEventType = "press_conference" | "minutes";
export type FomcCommentarySourceMode = "official" | "official_plus_brave" | "fallback_context";
export type FomcCommentaryStatus = "pending_source" | "ready" | "failed";
export type FomcCommentaryCitationUse = "discovery" | "context" | "fallback" | "official";

export type FomcCommentaryCitationSource = {
  sourceName: string;
  url: string;
  title: string | null;
  snippet: string | null;
  usedFor: FomcCommentaryCitationUse;
};

export type FomcCommentaryItem = {
  id: string;
  eventType: FomcCommentaryEventType;
  meetingDate: string;
  releaseDate: string | null;
  sourceUrl: string;
  sourceTitle: string | null;
  sourceMode: FomcCommentarySourceMode;
  status: FomcCommentaryStatus;
  summaryMarkdown: string | null;
  highlights: string[];
  tradingReadThrough: string | null;
  citationSources: FomcCommentaryCitationSource[];
  generatedAt: string | null;
  provider: string | null;
  model: string | null;
  error: string | null;
};

type StoredFomcCommentaryRow = {
  id: string;
  eventType: FomcCommentaryEventType;
  meetingDate: string;
  releaseDate: string | null;
  sourceUrl: string;
  sourceTitle: string | null;
  sourceMode: FomcCommentarySourceMode;
  status: FomcCommentaryStatus;
  summaryMarkdown: string | null;
  highlightsJson: string | null;
  tradingReadThrough: string | null;
  citationSourcesJson: string | null;
  generatedAt: string | null;
  provider: string | null;
  model: string | null;
  error: string | null;
};

type ExistingFomcCommentaryRow = StoredFomcCommentaryRow & {
  sourceText: string | null;
  braveSourcesJson: string | null;
};

type FomcSummaryJson = {
  highlights: string[];
  tradingReadThrough: string;
  summaryMarkdown: string;
  usedCitationUrls: string[];
};

type RefreshOptions = {
  eventType?: FomcCommentaryEventType;
  meetingDate?: string;
  sourceUrl?: string;
  force?: boolean;
  now?: Date;
};

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value ?? "").trim()).filter(Boolean).slice(0, 6);
}

export function normalizeFomcCommentaryRow(row: StoredFomcCommentaryRow): FomcCommentaryItem {
  const highlights = normalizeStringArray(parseJsonArray<unknown>(row.highlightsJson));
  const citations = parseJsonArray<FomcCommentaryCitationSource>(row.citationSourcesJson)
    .map((source) => ({
      sourceName: String(source.sourceName ?? "Unknown source").trim() || "Unknown source",
      url: String(source.url ?? "").trim(),
      title: source.title == null ? null : String(source.title).trim() || null,
      snippet: source.snippet == null ? null : String(source.snippet).trim() || null,
      usedFor: ["discovery", "context", "fallback", "official"].includes(source.usedFor) ? source.usedFor : "context",
    }))
    .filter((source) => source.url);
  return {
    id: row.id,
    eventType: row.eventType,
    meetingDate: row.meetingDate,
    releaseDate: row.releaseDate ?? null,
    sourceUrl: row.sourceUrl,
    sourceTitle: row.sourceTitle ?? null,
    sourceMode: row.sourceMode,
    status: row.status,
    summaryMarkdown: row.summaryMarkdown ?? null,
    highlights,
    tradingReadThrough: row.tradingReadThrough ?? null,
    citationSources: citations,
    generatedAt: row.generatedAt ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    error: row.error ?? null,
  };
}

export async function loadLatestFomcCommentary(env: Env, limit = 4): Promise<FomcCommentaryItem[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT id,
              event_type as eventType,
              meeting_date as meetingDate,
              release_date as releaseDate,
              source_url as sourceUrl,
              source_title as sourceTitle,
              source_mode as sourceMode,
              status,
              summary_markdown as summaryMarkdown,
              highlights_json as highlightsJson,
              trading_read_through as tradingReadThrough,
              citation_sources_json as citationSourcesJson,
              generated_at as generatedAt,
              provider,
              model,
              error
         FROM fomc_commentary_items
        ORDER BY COALESCE(release_date, meeting_date) DESC, datetime(updated_at) DESC
        LIMIT ?`,
    ).bind(Math.max(1, Math.min(10, limit))).all<StoredFomcCommentaryRow>();
    return (rows.results ?? []).map(normalizeFomcCommentaryRow);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table|fomc_commentary_items/i.test(message)) return [];
    throw error;
  }
}

function hostnameOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isFedUrl(rawUrl: string): boolean {
  const host = hostnameOf(rawUrl);
  return Boolean(host && (host === FED_HOST_SUFFIX || host.endsWith(`.${FED_HOST_SUFFIX}`)));
}

function sourceNameFromUrl(rawUrl: string): string {
  const host = hostnameOf(rawUrl);
  if (!host) return "Unknown source";
  if (host.endsWith("federalreserve.gov")) return "Federal Reserve";
  if (host.endsWith("reuters.com")) return "Reuters";
  if (host.endsWith("apnews.com")) return "Associated Press";
  if (host.endsWith("bloomberg.com")) return "Bloomberg";
  if (host.endsWith("wsj.com")) return "Wall Street Journal";
  if (host.endsWith("ft.com")) return "Financial Times";
  if (host.endsWith("cnbc.com")) return "CNBC";
  if (host.endsWith("marketwatch.com")) return "MarketWatch";
  return host;
}

function isAllowedBraveDomain(rawUrl: string, allowedDomains = ALLOWED_BRAVE_DOMAINS): boolean {
  const host = hostnameOf(rawUrl);
  if (!host) return false;
  return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractReadableTextFromHtml(html: string): string {
  return stripHtml(html);
}

export async function fetchOfficialFedText(env: Env, sourceUrl: string): Promise<{ text: string; title: string | null; fetchedAt: string }> {
  if (!isFedUrl(sourceUrl)) throw new Error("Official FOMC source URL must be on federalreserve.gov.");
  const timeoutMs = resolveFetchTimeoutMs(env.FOMC_COMMENTARY_TIMEOUT_MS, 20_000);
  const response = await fetchWithTimeout(sourceUrl, {
    headers: {
      "Accept": "text/html,application/pdf,text/plain;q=0.9,*/*;q=0.8",
      "User-Agent": "market-command-centre/1.0",
    },
  }, timeoutMs);
  if (!response.ok) throw new Error(`Federal Reserve source fetch failed with HTTP ${response.status}`);
  const raw = await response.text();
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? null;
  return { text: extractReadableTextFromHtml(raw).slice(0, MAX_SOURCE_TEXT_CHARS), title, fetchedAt: new Date().toISOString() };
}

function canonicalUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return rawUrl.trim();
  }
}

export function normalizeBraveFomcSources(
  results: BraveSearchResult[],
  usedFor: FomcCommentaryCitationUse,
  allowedDomains = ALLOWED_BRAVE_DOMAINS,
): FomcCommentaryCitationSource[] {
  const seen = new Set<string>();
  const out: FomcCommentaryCitationSource[] = [];
  for (const result of results) {
    const url = canonicalUrl(result.url);
    if (!url || seen.has(url) || !isAllowedBraveDomain(url, allowedDomains)) continue;
    seen.add(url);
    out.push({
      sourceName: result.source?.trim() || sourceNameFromUrl(url),
      url,
      title: result.title?.trim() || null,
      snippet: result.description?.trim() || null,
      usedFor: isFedUrl(url) ? "discovery" : usedFor,
    });
  }
  return out;
}


type OfficialFomcSource = {
  eventType: FomcCommentaryEventType;
  meetingDate: string;
  sourceUrl: string;
};

function toAbsoluteFedUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl, "https://www.federalreserve.gov").toString();
  } catch {
    return rawUrl.trim();
  }
}

export function extractOfficialFomcSourcesFromCalendar(html: string, now = new Date()): OfficialFomcSource[] {
  const today = now.toISOString().slice(0, 10).replace(/-/g, "");
  const candidates: OfficialFomcSource[] = [];
  const linkPattern = /href=["']([^"']*(?:fomcpresconf|fomcminutes)(\d{8})\.htm)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(html)) !== null) {
    const rawUrl = match[1] ?? "";
    const compactDate = match[2] ?? "";
    if (!compactDate || compactDate > today) continue;
    const eventType: FomcCommentaryEventType = rawUrl.includes("fomcpresconf") ? "press_conference" : "minutes";
    candidates.push({
      eventType,
      meetingDate: `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`,
      sourceUrl: canonicalUrl(toAbsoluteFedUrl(rawUrl)),
    });
  }

  const latestByType = new Map<FomcCommentaryEventType, OfficialFomcSource>();
  for (const source of candidates.sort((a, b) => b.meetingDate.localeCompare(a.meetingDate))) {
    if (!latestByType.has(source.eventType)) latestByType.set(source.eventType, source);
  }
  return [latestByType.get("press_conference"), latestByType.get("minutes")].filter(Boolean) as OfficialFomcSource[];
}

async function discoverLatestOfficialFomcSources(env: Env, now = new Date()): Promise<OfficialFomcSource[]> {
  const timeoutMs = resolveFetchTimeoutMs(env.FOMC_COMMENTARY_TIMEOUT_MS, 20_000);
  const response = await fetchWithTimeout(DEFAULT_SOURCE_URL, {
    headers: {
      "Accept": "text/html,*/*;q=0.8",
      "User-Agent": "market-command-centre/1.0",
    },
  }, timeoutMs);
  if (!response.ok) throw new Error(`Federal Reserve calendar fetch failed with HTTP ${response.status}`);
  return extractOfficialFomcSourcesFromCalendar(await response.text(), now);
}

async function collectBraveFomcSources(env: Env, eventType: FomcCommentaryEventType, meetingDate: string): Promise<FomcCommentaryCitationSource[]> {
  const apiKey = env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) return [];
  const label = eventType === "minutes" ? "FOMC minutes" : "Federal Reserve Chair Powell press conference transcript";
  const queries = [
    `site:federalreserve.gov ${label} ${meetingDate}`,
    `${label} ${meetingDate} Federal Reserve`,
    `Reuters ${label} highlights ${meetingDate}`,
  ];
  const batches = await Promise.all(queries.map(async (query, index) => {
    const results = await braveSearch(apiKey, query, { freshness: "py", count: 5, timeoutMs: env.BRAVE_SEARCH_TIMEOUT_MS });
    return normalizeBraveFomcSources(results, index === 0 ? "discovery" : "context");
  }));
  const seen = new Set<string>();
  return batches.flat().filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

function buildFomcPrompt(input: {
  eventType: FomcCommentaryEventType;
  meetingDate: string;
  sourceMode: FomcCommentarySourceMode;
  officialText: string;
  citations: FomcCommentaryCitationSource[];
}): string {
  const label = input.eventType === "minutes" ? "FOMC minutes" : "Fed Chair press conference";
  const citationLines = input.citations.map((source, index) => (
    `${index + 1}. ${source.sourceName} | ${source.usedFor} | ${source.title ?? "Untitled"} | ${source.url} | ${source.snippet ?? ""}`
  ));
  return [
    "You are summarizing FOMC material for a US equity/rates trader.",
    "Primary source text is authoritative. Brave Search sources, when supplied, are context/fallback only and must be cited.",
    "Do not add outside facts beyond the supplied official text and supplied cited sources.",
    input.sourceMode === "fallback_context"
      ? "This is SECONDARY-SOURCE FALLBACK context because official transcript/minutes text is pending. Do not imply official transcript/minutes wording."
      : "Official Federal Reserve text is the source of truth.",
    "Return strict JSON only:",
    '{"highlights":["3-6 bullets, each <= 160 chars"],"tradingReadThrough":"<= 450 chars","summaryMarkdown":"compact markdown with sections: Policy signal, Inflation/labor, Market read-through","usedCitationUrls":["URLs that materially influenced the answer"]}',
    "Focus on changes in tone, rate path, inflation, labor, balance sheet/liquidity, risk assets.",
    "If the text lacks evidence for a claim, omit it.",
    `Event: ${label}`,
    `Meeting date: ${input.meetingDate}`,
    `Source mode: ${input.sourceMode}`,
    "Cited Brave/Fed evidence:",
    citationLines.length ? citationLines.join("\n") : "None",
    "Source text:",
    input.officialText.slice(0, MAX_SOURCE_TEXT_CHARS),
  ].join("\n\n");
}

export const testExports = { buildFomcPrompt, extractOfficialFomcSourcesFromCalendar };

export function parseGeminiFomcJson(text: string): FomcSummaryJson {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Gemini did not return JSON.");
  const parsed = JSON.parse(match[0]) as Partial<FomcSummaryJson>;
  const highlights = normalizeStringArray(parsed.highlights).slice(0, 6);
  const tradingReadThrough = String(parsed.tradingReadThrough ?? "").trim();
  const summaryMarkdown = String(parsed.summaryMarkdown ?? "").trim();
  const usedCitationUrls = normalizeStringArray(parsed.usedCitationUrls);
  if (highlights.length === 0 || !tradingReadThrough) throw new Error("Gemini JSON missing highlights or tradingReadThrough.");
  return { highlights, tradingReadThrough, summaryMarkdown, usedCitationUrls };
}

async function loadExisting(env: Env, eventType: FomcCommentaryEventType, meetingDate: string, sourceUrl: string): Promise<ExistingFomcCommentaryRow | null> {
  try {
    return await env.DB.prepare(
      `SELECT id,
              event_type as eventType,
              meeting_date as meetingDate,
              release_date as releaseDate,
              source_url as sourceUrl,
              source_title as sourceTitle,
              source_text as sourceText,
              source_mode as sourceMode,
              brave_sources_json as braveSourcesJson,
              status,
              summary_markdown as summaryMarkdown,
              highlights_json as highlightsJson,
              trading_read_through as tradingReadThrough,
              citation_sources_json as citationSourcesJson,
              generated_at as generatedAt,
              provider,
              model,
              error
         FROM fomc_commentary_items
        WHERE event_type = ? AND meeting_date = ? AND source_url = ?
        LIMIT 1`,
    ).bind(eventType, meetingDate, sourceUrl).first<ExistingFomcCommentaryRow>();
  } catch {
    return null;
  }
}

async function upsertFomcCommentaryItem(env: Env, input: {
  id: string;
  eventType: FomcCommentaryEventType;
  meetingDate: string;
  releaseDate: string | null;
  sourceUrl: string;
  sourceTitle: string | null;
  sourceText: string | null;
  sourceFetchedAt: string | null;
  sourceMode: FomcCommentarySourceMode;
  braveSources: FomcCommentaryCitationSource[];
  citationSources: FomcCommentaryCitationSource[];
  summaryMarkdown: string | null;
  highlights: string[];
  tradingReadThrough: string | null;
  provider: string | null;
  model: string | null;
  status: FomcCommentaryStatus;
  error: string | null;
  generatedAt: string | null;
  now: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO fomc_commentary_items
      (id, event_type, meeting_date, release_date, source_url, source_title, source_text, source_fetched_at,
       source_mode, brave_sources_json, citation_sources_json, summary_markdown, highlights_json,
       trading_read_through, provider, model, status, error, generated_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_type, meeting_date, source_url) DO UPDATE SET
       release_date = excluded.release_date,
       source_title = excluded.source_title,
       source_text = excluded.source_text,
       source_fetched_at = excluded.source_fetched_at,
       source_mode = excluded.source_mode,
       brave_sources_json = excluded.brave_sources_json,
       citation_sources_json = excluded.citation_sources_json,
       summary_markdown = excluded.summary_markdown,
       highlights_json = excluded.highlights_json,
       trading_read_through = excluded.trading_read_through,
       provider = excluded.provider,
       model = excluded.model,
       status = excluded.status,
       error = excluded.error,
       generated_at = excluded.generated_at,
       updated_at = excluded.updated_at`,
  ).bind(
    input.id,
    input.eventType,
    input.meetingDate,
    input.releaseDate,
    input.sourceUrl,
    input.sourceTitle,
    input.sourceText,
    input.sourceFetchedAt,
    input.sourceMode,
    JSON.stringify(input.braveSources),
    JSON.stringify(input.citationSources),
    input.summaryMarkdown,
    JSON.stringify(input.highlights),
    input.tradingReadThrough,
    input.provider,
    input.model,
    input.status,
    input.error,
    input.generatedAt,
    input.now,
    input.now,
  ).run();
}

export async function refreshFomcCommentary(env: Env, options: RefreshOptions = {}): Promise<{ ok: boolean; items: FomcCommentaryItem[]; warning: string | null }> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const eventType = options.eventType ?? "minutes";
  const meetingDate = options.meetingDate?.trim() || nowIso.slice(0, 10);
  const braveSources = await collectBraveFomcSources(env, eventType, meetingDate).catch(() => []);
  const discoveredOfficial = braveSources.find((source) => isFedUrl(source.url))?.url;
  const explicitSourceUrl = options.sourceUrl?.trim() || null;
  const sourceUrl = explicitSourceUrl || discoveredOfficial || DEFAULT_SOURCE_URL;
  const shouldFetchOfficialText = Boolean(explicitSourceUrl || discoveredOfficial);

  let officialText: string | null = null;
  let sourceTitle: string | null = null;
  let fetchedAt: string | null = null;
  let sourceError: string | null = null;
  if (shouldFetchOfficialText && isFedUrl(sourceUrl)) {
    try {
      const fetched = await fetchOfficialFedText(env, sourceUrl);
      officialText = fetched.text;
      sourceTitle = fetched.title;
      fetchedAt = fetched.fetchedAt;
      if (officialText.length < MIN_OFFICIAL_TEXT_CHARS) sourceError = "Official Federal Reserve source text is not available yet or is too short to summarize.";
    } catch (error) {
      sourceError = error instanceof Error ? error.message : "Official Federal Reserve source fetch failed.";
    }
  } else if (shouldFetchOfficialText) {
    sourceError = "Official FOMC source URL must be on federalreserve.gov.";
  } else {
    sourceError = "Official Federal Reserve transcript/minutes URL has not been found yet.";
  }

  const contextSources = braveSources.filter((source) => source.usedFor === "context");
  const fallbackSources = braveSources.filter((source) => source.usedFor !== "discovery" && !isFedUrl(source.url));
  const hasOfficialText = Boolean(officialText && officialText.length >= MIN_OFFICIAL_TEXT_CHARS);
  const sourceMode: FomcCommentarySourceMode = hasOfficialText
    ? (contextSources.length ? "official_plus_brave" : "official")
    : (fallbackSources.length ? "fallback_context" : "official");
  const synthesisText = hasOfficialText
    ? officialText!
    : fallbackSources.map((source) => `${source.sourceName}: ${source.title ?? ""}. ${source.snippet ?? ""} URL: ${source.url}`).join("\n");
  const citationsForPrompt = sourceMode === "official" ? [] : (sourceMode === "fallback_context" ? fallbackSources : contextSources);

  const existing = await loadExisting(env, eventType, meetingDate, sourceUrl);
  if (!options.force && existing?.status === "ready" && existing.sourceText === officialText && existing.braveSourcesJson === JSON.stringify(braveSources)) {
    return { ok: true, warning: null, items: [normalizeFomcCommentaryRow(existing)] };
  }

  const id = existing?.id ?? crypto.randomUUID();
  let stored: Parameters<typeof upsertFomcCommentaryItem>[1] = {
    id,
    eventType,
    meetingDate,
    releaseDate: nowIso.slice(0, 10),
    sourceUrl,
    sourceTitle,
    sourceText: officialText,
    sourceFetchedAt: fetchedAt,
    sourceMode,
    braveSources,
    citationSources: [],
    summaryMarkdown: null,
    highlights: [],
    tradingReadThrough: null,
    provider: null,
    model: null,
    status: "pending_source",
    error: sourceError,
    generatedAt: null,
    now: nowIso,
  };

  if (!hasOfficialText && sourceMode !== "fallback_context") {
    await upsertFomcCommentaryItem(env, stored);
    return { ok: false, warning: sourceError, items: await loadLatestFomcCommentary(env, 4) };
  }

  try {
    const prompt = buildFomcPrompt({ eventType, meetingDate, sourceMode, officialText: synthesisText, citations: citationsForPrompt });
    const generated = await generateMarkdownWithGemini(env, prompt, { temperature: 0.15, maxOutputTokens: 2500 });
    const parsed = parseGeminiFomcJson(generated.text);
    const usedUrls = new Set(parsed.usedCitationUrls.map(canonicalUrl));
    const citationSources = citationsForPrompt.filter((source) => usedUrls.has(canonicalUrl(source.url)));
    stored = {
      ...stored,
      citationSources: sourceMode === "official" ? [] : (citationSources.length ? citationSources : citationsForPrompt),
      summaryMarkdown: parsed.summaryMarkdown,
      highlights: parsed.highlights,
      tradingReadThrough: sourceMode === "fallback_context"
        ? `Secondary-source read-through: ${parsed.tradingReadThrough.replace(/^secondary-source read-through:\s*/i, "")}`
        : parsed.tradingReadThrough,
      provider: generated.provider,
      model: generated.model,
      status: "ready",
      error: null,
      generatedAt: nowIso,
    };
  } catch (error) {
    stored = {
      ...stored,
      status: "failed",
      error: error instanceof Error ? error.message : "FOMC commentary Gemini synthesis failed.",
    };
  }

  await upsertFomcCommentaryItem(env, stored);
  const items = await loadLatestFomcCommentary(env, 4);
  return { ok: stored.status === "ready", warning: stored.error, items };
}


export async function refreshLatestFomcCommentary(env: Env, options: { force?: boolean; now?: Date } = {}): Promise<{ ok: boolean; items: FomcCommentaryItem[]; warning: string | null }> {
  const warnings: string[] = [];
  const sources = await discoverLatestOfficialFomcSources(env, options.now).catch((error) => {
    warnings.push(error instanceof Error ? error.message : "Federal Reserve calendar discovery failed.");
    return [] as OfficialFomcSource[];
  });

  if (sources.length === 0) {
    const existing = await loadLatestFomcCommentary(env, FOMC_AUTO_REFRESH_LIMIT);
    return { ok: existing.some((item) => item.status === "ready"), items: existing, warning: warnings[0] ?? "No official FOMC press conference/minutes links found." };
  }

  const refreshed: FomcCommentaryItem[] = [];
  for (const source of sources) {
    const result = await refreshFomcCommentary(env, {
      eventType: source.eventType,
      meetingDate: source.meetingDate,
      sourceUrl: source.sourceUrl,
      force: options.force,
      now: options.now,
    }).catch((error) => ({ ok: false, warning: error instanceof Error ? error.message : "FOMC commentary refresh failed.", items: [] as FomcCommentaryItem[] }));
    if (result.warning) warnings.push(`${source.eventType}: ${result.warning}`);
    refreshed.push(...result.items.filter((item) => item.eventType === source.eventType && item.meetingDate === source.meetingDate));
  }

  const items = await loadLatestFomcCommentary(env, FOMC_AUTO_REFRESH_LIMIT);
  return {
    ok: items.some((item) => item.status === "ready"),
    items: items.length ? items : refreshed,
    warning: warnings.length ? warnings.join("; ") : null,
  };
}

export async function loadOrRefreshLatestFomcCommentary(env: Env, limit = FOMC_AUTO_REFRESH_LIMIT): Promise<FomcCommentaryItem[]> {
  const existing = await loadLatestFomcCommentary(env, limit);
  const readyTypes = new Set(existing.filter((item) => item.status === "ready").map((item) => item.eventType));
  if (readyTypes.has("press_conference") && readyTypes.has("minutes")) return existing;
  const refreshed = await refreshLatestFomcCommentary(env).catch(() => null);
  return refreshed?.items?.length ? refreshed.items.slice(0, Math.max(1, Math.min(10, limit))) : existing;
}
