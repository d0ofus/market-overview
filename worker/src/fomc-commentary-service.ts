import type { BraveSearchResult } from "./market-report-common";
import { cachedBraveSearch, generateMarkdownWithGemini } from "./market-report-common";
import { zonedParts } from "./refresh-timing";
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
  sourceFetchedAt: string | null;
  sourceTextHash: string | null;
  lastCheckedAt: string | null;
  lastUnchangedAt: string | null;
  lastRefreshAttemptAt: string | null;
  refreshAttemptCount: number;
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
  sourceFetchedAt: string | null;
  sourceTextHash: string | null;
  lastCheckedAt: string | null;
  lastUnchangedAt: string | null;
  lastRefreshAttemptAt: string | null;
  refreshAttemptCount: number | null;
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

function normalizeSourceTextForHash(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
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

export function shouldGenerateFomcSummary(input: {
  force?: boolean;
  existingStatus?: FomcCommentaryStatus | null;
  existingSourceTextHash?: string | null;
  nextSourceTextHash?: string | null;
  hasOfficialText: boolean;
  sourceMode: FomcCommentarySourceMode;
}): boolean {
  if (input.force) return true;
  if (input.existingStatus !== "ready") return true;
  if (!input.hasOfficialText || !input.nextSourceTextHash) return input.sourceMode === "fallback_context";
  return input.existingSourceTextHash !== input.nextSourceTextHash;
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
    sourceFetchedAt: row.sourceFetchedAt ?? null,
    sourceTextHash: row.sourceTextHash ?? null,
    lastCheckedAt: row.lastCheckedAt ?? null,
    lastUnchangedAt: row.lastUnchangedAt ?? null,
    lastRefreshAttemptAt: row.lastRefreshAttemptAt ?? null,
    refreshAttemptCount: Number(row.refreshAttemptCount ?? 0),
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
              error,
              source_fetched_at as sourceFetchedAt,
              source_text_hash as sourceTextHash,
              last_checked_at as lastCheckedAt,
              last_unchanged_at as lastUnchangedAt,
              last_refresh_attempt_at as lastRefreshAttemptAt,
              refresh_attempt_count as refreshAttemptCount
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

function fomcReleaseWindowEndMinutes(eventType: FomcCommentaryEventType): number {
  return eventType === "minutes" ? 15 * 60 + 30 : 16 * 60 + 30;
}

function isInFomcReleaseWindow(now: Date, eventType: FomcCommentaryEventType): boolean {
  const ny = zonedParts(now, "America/New_York");
  const start = 13 * 60 + 45;
  const end = fomcReleaseWindowEndMinutes(eventType);
  return ny.minutesOfDay >= start && ny.minutesOfDay <= end;
}

function isInAnyFomcReleaseWindow(now: Date): boolean {
  const ny = zonedParts(now, "America/New_York");
  return ny.minutesOfDay >= 13 * 60 + 45 && ny.minutesOfDay <= 16 * 60 + 30;
}

async function hasRelevantFomcReleaseMetadata(env: Env, now: Date): Promise<boolean> {
  const ny = zonedParts(now, "America/New_York");
  const rows = await env.DB.prepare(
    `SELECT event_type as eventType
       FROM fomc_commentary_items
      WHERE meeting_date = ?
         OR release_date = ?
         OR (status = 'pending_source' AND substr(COALESCE(last_checked_at, updated_at, created_at), 1, 10) = ?)
      LIMIT 10`,
  ).bind(ny.localDate, ny.localDate, ny.localDate).all<{ eventType: FomcCommentaryEventType }>();
  return (rows.results ?? []).some((row) => (
    (row.eventType === "minutes" || row.eventType === "press_conference") && isInFomcReleaseWindow(now, row.eventType)
  ));
}

export async function shouldRunScheduledFomcRefresh(env: Env, now = new Date()): Promise<boolean> {
  const hourlyTick = now.getUTCMinutes() < 15;
  if (!isInAnyFomcReleaseWindow(now)) return hourlyTick;
  try {
    return await hasRelevantFomcReleaseMetadata(env, now) ? true : hourlyTick;
  } catch {
    return hourlyTick;
  }
}

function fomcBraveCacheOptions(eventType: FomcCommentaryEventType, meetingDate: string, now: Date, pendingSource: boolean): { dateBucket: string; ttlSeconds: number } {
  if (pendingSource || isInFomcReleaseWindow(now, eventType)) {
    return {
      dateBucket: `fomc-hourly:${eventType}:${meetingDate}:${now.toISOString().slice(0, 13)}`,
      ttlSeconds: 3600,
    };
  }
  return {
    dateBucket: `fomc-daily:${eventType}:${meetingDate}:${now.toISOString().slice(0, 10)}`,
    ttlSeconds: 86400,
  };
}

async function collectBraveFomcSources(
  env: Env,
  eventType: FomcCommentaryEventType,
  meetingDate: string,
  options: { now?: Date; pendingSource?: boolean } = {},
): Promise<FomcCommentaryCitationSource[]> {
  if (!env.BRAVE_SEARCH_API_KEY?.trim()) return [];
  const now = options.now ?? new Date();
  const cacheOptions = fomcBraveCacheOptions(eventType, meetingDate, now, Boolean(options.pendingSource));
  const label = eventType === "minutes" ? "FOMC minutes" : "Federal Reserve Chair Powell press conference transcript";
  const queries = [
    `site:federalreserve.gov ${label} ${meetingDate}`,
    `${label} ${meetingDate} Federal Reserve`,
    `Reuters ${label} highlights ${meetingDate}`,
  ];
  const batches = await Promise.all(queries.map(async (query, index) => {
    const results = await cachedBraveSearch(env, query, {
      caller: "fomc",
      freshness: "py",
      count: 5,
      timeoutMs: env.BRAVE_SEARCH_TIMEOUT_MS,
      dateBucket: cacheOptions.dateBucket,
      ttlSeconds: cacheOptions.ttlSeconds,
      now,
    });
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


function truncateSentence(value: string, limit = 160): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit - 1).trim()}…`;
}

function extractSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 40 && sentence.length <= 320);
}

function firstMatchingSentence(sentences: string[], pattern: RegExp): string | null {
  return sentences.find((sentence) => pattern.test(sentence)) ?? null;
}

function buildExtractiveFomcSummary(input: { eventType: FomcCommentaryEventType; meetingDate: string; officialText: string }): FomcSummaryJson {
  const sentences = extractSentences(input.officialText);
  const policy = firstMatchingSentence(sentences, /federal funds rate|target range|monetary policy|policy stance|restrictive/i);
  const inflation = firstMatchingSentence(sentences, /inflation|price|prices|disinflation/i);
  const labor = firstMatchingSentence(sentences, /labor|employment|unemployment|job gains|wage/i);
  const risks = firstMatchingSentence(sentences, /risk|uncertain|uncertainty|outlook|balance of risks/i);
  const balanceSheet = firstMatchingSentence(sentences, /balance sheet|securities holdings|treasury securities|agency debt|mortgage-backed/i);
  const selected = [policy, inflation, labor, risks, balanceSheet]
    .filter((sentence): sentence is string => Boolean(sentence))
    .filter((sentence, index, array) => array.indexOf(sentence) === index);
  const highlights = selected.length ? selected.slice(0, 5).map((sentence) => truncateSentence(sentence)) : [
    `${input.eventType === "minutes" ? "FOMC minutes" : "Fed press conference"} official text is available for ${input.meetingDate}.`,
    "Gemini synthesis was unavailable, so this is an extractive official-source fallback.",
  ];
  const policyLine = policy ? truncateSentence(policy, 500) : "No concise policy sentence was extracted from the official text.";
  const inflationLine = inflation || labor ? [inflation, labor].filter(Boolean).map((sentence) => truncateSentence(sentence!, 300)).join(" ") : "No concise inflation/labor sentence was extracted from the official text.";
  const marketLine = risks || balanceSheet ? [risks, balanceSheet].filter(Boolean).map((sentence) => truncateSentence(sentence!, 300)).join(" ") : "Use the official source link for full context; model synthesis was unavailable.";
  return {
    highlights,
    tradingReadThrough: "Official-source extractive fallback: review the cited Fed text directly; Gemini synthesis was unavailable for this refresh.",
    summaryMarkdown: [
      "## Policy signal",
      policyLine,
      "",
      "## Inflation/labor",
      inflationLine,
      "",
      "## Market read-through",
      marketLine,
    ].join("\n"),
    usedCitationUrls: [],
  };
}

export const testExports = { buildFomcPrompt, extractOfficialFomcSourcesFromCalendar, normalizeSourceTextForHash, buildExtractiveFomcSummary };

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
              error,
              source_fetched_at as sourceFetchedAt,
              source_text_hash as sourceTextHash,
              last_checked_at as lastCheckedAt,
              last_unchanged_at as lastUnchangedAt,
              last_refresh_attempt_at as lastRefreshAttemptAt,
              refresh_attempt_count as refreshAttemptCount
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
  sourceTextHash: string | null;
  lastCheckedAt: string | null;
  lastUnchangedAt: string | null;
  lastRefreshAttemptAt: string | null;
  refreshAttemptCount: number;
  now: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO fomc_commentary_items
      (id, event_type, meeting_date, release_date, source_url, source_title, source_text, source_fetched_at,
       source_mode, brave_sources_json, citation_sources_json, summary_markdown, highlights_json,
       trading_read_through, provider, model, status, error, generated_at, source_text_hash, last_checked_at,
       last_unchanged_at, last_refresh_attempt_at, refresh_attempt_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       source_text_hash = excluded.source_text_hash,
       last_checked_at = excluded.last_checked_at,
       last_unchanged_at = excluded.last_unchanged_at,
       last_refresh_attempt_at = excluded.last_refresh_attempt_at,
       refresh_attempt_count = excluded.refresh_attempt_count,
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
    input.sourceTextHash,
    input.lastCheckedAt,
    input.lastUnchangedAt,
    input.lastRefreshAttemptAt,
    input.refreshAttemptCount,
    input.now,
    input.now,
  ).run();
}

async function markFomcCommentaryUnchanged(env: Env, id: string, nowIso: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE fomc_commentary_items
        SET last_checked_at = ?,
            last_unchanged_at = ?,
            updated_at = ?
      WHERE id = ?`,
  ).bind(nowIso, nowIso, nowIso, id).run();
}

export async function refreshFomcCommentary(env: Env, options: RefreshOptions = {}): Promise<{ ok: boolean; items: FomcCommentaryItem[]; warning: string | null }> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const eventType = options.eventType ?? "minutes";
  const meetingDate = options.meetingDate?.trim() || nowIso.slice(0, 10);
  const explicitSourceUrl = options.sourceUrl?.trim() || null;
  let braveSources: FomcCommentaryCitationSource[] = [];
  let sourceUrl = explicitSourceUrl || DEFAULT_SOURCE_URL;
  let officialText: string | null = null;
  let sourceTitle: string | null = null;
  let fetchedAt: string | null = null;
  let sourceError: string | null = null;

  if (explicitSourceUrl && isFedUrl(sourceUrl)) {
    try {
      const fetched = await fetchOfficialFedText(env, sourceUrl);
      officialText = fetched.text;
      sourceTitle = fetched.title;
      fetchedAt = fetched.fetchedAt;
      if (officialText.length < MIN_OFFICIAL_TEXT_CHARS) sourceError = "Official Federal Reserve source text is not available yet or is too short to summarize.";
    } catch (error) {
      sourceError = error instanceof Error ? error.message : "Official Federal Reserve source fetch failed.";
    }
  } else if (explicitSourceUrl) {
    sourceError = "Official FOMC source URL must be on federalreserve.gov.";
  }

  let hasOfficialText = Boolean(officialText && officialText.length >= MIN_OFFICIAL_TEXT_CHARS);
  let sourceTextHash = hasOfficialText ? await sha256Hex(normalizeSourceTextForHash(officialText)) : null;
  let existing = explicitSourceUrl ? await loadExisting(env, eventType, meetingDate, sourceUrl) : null;
  if (explicitSourceUrl && existing?.status === "ready" && hasOfficialText && sourceTextHash) {
    const shouldGenerateOfficial = shouldGenerateFomcSummary({
      force: options.force,
      existingStatus: existing.status,
      existingSourceTextHash: existing.sourceTextHash,
      nextSourceTextHash: sourceTextHash,
      hasOfficialText,
      sourceMode: "official",
    });
    if (!shouldGenerateOfficial) {
      await markFomcCommentaryUnchanged(env, existing.id, nowIso);
      return { ok: true, warning: null, items: await loadLatestFomcCommentary(env, 4) };
    }
  }

  const shouldCollectBrave = !explicitSourceUrl || options.force || !hasOfficialText || !existing || existing.status !== "ready" || existing.sourceTextHash !== sourceTextHash;
  if (shouldCollectBrave) {
    braveSources = await collectBraveFomcSources(env, eventType, meetingDate, { now, pendingSource: !hasOfficialText }).catch(() => []);
  }

  if (!explicitSourceUrl) {
    const discoveredOfficial = braveSources.find((source) => isFedUrl(source.url))?.url;
    sourceUrl = discoveredOfficial || DEFAULT_SOURCE_URL;
    if (discoveredOfficial && isFedUrl(sourceUrl)) {
      try {
        const fetched = await fetchOfficialFedText(env, sourceUrl);
        officialText = fetched.text;
        sourceTitle = fetched.title;
        fetchedAt = fetched.fetchedAt;
        if (officialText.length < MIN_OFFICIAL_TEXT_CHARS) sourceError = "Official Federal Reserve source text is not available yet or is too short to summarize.";
      } catch (error) {
        sourceError = error instanceof Error ? error.message : "Official Federal Reserve source fetch failed.";
      }
    } else {
      sourceError = "Official Federal Reserve transcript/minutes URL has not been found yet.";
    }
    hasOfficialText = Boolean(officialText && officialText.length >= MIN_OFFICIAL_TEXT_CHARS);
    sourceTextHash = hasOfficialText ? await sha256Hex(normalizeSourceTextForHash(officialText)) : null;
    existing = await loadExisting(env, eventType, meetingDate, sourceUrl);
  }

  const contextSources = braveSources.filter((source) => source.usedFor === "context");
  const fallbackSources = braveSources.filter((source) => source.usedFor !== "discovery" && !isFedUrl(source.url));
  const sourceMode: FomcCommentarySourceMode = hasOfficialText
    ? (contextSources.length ? "official_plus_brave" : "official")
    : (fallbackSources.length ? "fallback_context" : "official");
  const synthesisText = hasOfficialText
    ? officialText!
    : fallbackSources.map((source) => `${source.sourceName}: ${source.title ?? ""}. ${source.snippet ?? ""} URL: ${source.url}`).join("\n");
  const citationsForPrompt = sourceMode === "official" ? [] : (sourceMode === "fallback_context" ? fallbackSources : contextSources);

  const shouldGenerate = shouldGenerateFomcSummary({
    force: options.force,
    existingStatus: existing?.status ?? null,
    existingSourceTextHash: existing?.sourceTextHash ?? null,
    nextSourceTextHash: sourceTextHash,
    hasOfficialText,
    sourceMode,
  });
  if (!shouldGenerate && existing?.status === "ready") {
    await markFomcCommentaryUnchanged(env, existing.id, nowIso);
    return { ok: true, warning: null, items: await loadLatestFomcCommentary(env, 4) };
  }

  const id = existing?.id ?? crypto.randomUUID();
  const refreshAttemptCount = Number(existing?.refreshAttemptCount ?? 0) + (shouldGenerate && (hasOfficialText || sourceMode === "fallback_context") ? 1 : 0);
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
    sourceTextHash,
    lastCheckedAt: nowIso,
    lastUnchangedAt: null,
    lastRefreshAttemptAt: shouldGenerate && (hasOfficialText || sourceMode === "fallback_context") ? nowIso : null,
    refreshAttemptCount,
    now: nowIso,
  };

  if (!hasOfficialText && sourceMode !== "fallback_context") {
    await upsertFomcCommentaryItem(env, stored);
    return { ok: false, warning: sourceError, items: await loadLatestFomcCommentary(env, 4) };
  }

  try {
    const prompt = buildFomcPrompt({ eventType, meetingDate, sourceMode, officialText: synthesisText, citations: citationsForPrompt });
    const generated = await generateMarkdownWithGemini(env, prompt, { temperature: 0.15, maxOutputTokens: 2500, responseMimeType: "application/json" });
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
    if (existing?.status === "ready") {
      stored = {
        ...stored,
        citationSources: parseJsonArray<FomcCommentaryCitationSource>(existing.citationSourcesJson),
        summaryMarkdown: existing.summaryMarkdown,
        highlights: parseJsonArray<string>(existing.highlightsJson),
        tradingReadThrough: existing.tradingReadThrough,
        provider: existing.provider,
        model: existing.model,
        status: "ready",
        error: error instanceof Error ? `Latest refresh failed; serving previous summary. ${error.message}` : "Latest refresh failed; serving previous summary.",
        generatedAt: existing.generatedAt,
      };
    } else if (hasOfficialText) {
      const fallback = buildExtractiveFomcSummary({ eventType, meetingDate, officialText: synthesisText });
      stored = {
        ...stored,
        citationSources: [],
        summaryMarkdown: fallback.summaryMarkdown,
        highlights: fallback.highlights,
        tradingReadThrough: fallback.tradingReadThrough,
        provider: "extractive_fallback",
        model: "official-fed-text",
        status: "ready",
        error: error instanceof Error ? `Gemini refresh failed; serving official-source extractive fallback. ${error.message}` : "Gemini refresh failed; serving official-source extractive fallback.",
        generatedAt: nowIso,
      };
    } else {
      stored = {
        ...stored,
        status: "failed",
        error: error instanceof Error ? error.message : "FOMC commentary Gemini synthesis failed.",
      };
    }
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
