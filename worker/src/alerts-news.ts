import type { Env } from "./types";

export type NewsCandidate = {
  provider: string;
  headline: string;
  source?: string | null;
  url?: string | null;
  publishedAt?: string | null;
  snippet?: string | null;
  providerPriority?: number;
};

export type NormalizedNewsItem = {
  ticker: string;
  tradingDay: string;
  headline: string;
  source: string;
  url: string;
  publishedAt: string | null;
  snippet: string | null;
  fetchedAt: string;
  canonicalKey: string;
};

type RankedNewsItem = NormalizedNewsItem & {
  provider: string;
  providerPriority: number;
  relevanceScore: number;
  normalizedTitle: string;
  canonicalUrl: string;
};

type NewsSearchContext = {
  ticker: string;
  companyName: string | null;
  tradingDay: string;
  startIso: string;
  endIso: string;
  maxItems: number;
};

type FetchTrace = {
  provider: string;
  status: "skipped" | "ok" | "empty" | "timeout" | "error";
  rawCount: number;
  acceptedCount: number;
  durationMs: number;
  error?: string;
};

export interface TickerNewsProvider {
  readonly name: string;
  readonly priority: number;
  readonly timeoutMs: number;
  isAvailable(env: Env): boolean;
  fetch(env: Env, context: NewsSearchContext): Promise<NewsCandidate[]>;
}

const SUCCESS_CACHE_TTL_MINUTES = 45;
const EMPTY_CACHE_TTL_MINUTES = 12;
const DEFAULT_USER_AGENT = "market-command-centre/1.0";
const COMPANY_SUFFIXES = new Set(["inc", "corp", "corporation", "co", "company", "ltd", "plc", "holdings", "holding", "group", "class", "limited"]);
const HIGH_SIGNAL_PATTERNS = [
  /\b(earnings|revenue|guidance|outlook|8-k|10-k|10-q|sec filing|sec|analyst|upgrade|downgrade|price target|merger|acquisition|m&a|lawsuit|legal|regulatory|probe|investigation|offering|dividend|buyback|contract|approval|fda|bankruptcy|restructuring|ceo|cfo)\b/i,
];
const GENERIC_MARKET_PATTERNS = [
  /\b(s&p 500|nasdaq composite|dow jones|wall street|stocks? (rise|fall|mixed|gain|slip)|futures|treasur(?:y|ies)|inflation|fed|economy|market wrap|market open|market close)\b/i,
];

let secTickerMapCache: Map<string, string> | null = null;
let secTickerMapFetchedAt = 0;

function addDays(isoDate: string, days: number): string {
  const value = new Date(`${isoDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "number") {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

function normalizeHeadline(value: string | null | undefined): string {
  return decodeHtml(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeSnippet(value: string | null | undefined): string | null {
  const normalized = decodeHtml(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, 800);
}

function normalizeTitleForDedupe(value: string): string {
  return normalizeHeadline(value)
    .toLowerCase()
    .replace(/\s+\|\s+.*$/g, "")
    .replace(/\s+-\s+(reuters|bloomberg|yahoo finance|marketwatch|benzinga|seeking alpha|google news)$/gi, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string | null | undefined): string[] {
  return normalizeTitleForDedupe(value ?? "")
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function uniqueTokens(value: string | null | undefined): string[] {
  return Array.from(new Set(tokenize(value)));
}

function simpleHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactWordRegex(value: string): RegExp {
  return new RegExp(`(^|[^A-Z0-9])${escapeRegExp(value.toUpperCase())}([^A-Z0-9]|$)`, "i");
}

function canonicalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const keep: Array<[string, string]> = [];
    for (const [key, value] of url.searchParams.entries()) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") || lower === "guccounter" || lower === "guce_referrer" || lower === "guce_referrer_sig") continue;
      keep.push([key, value]);
    }
    keep.sort((a, b) => `${a[0]}=${a[1]}`.localeCompare(`${b[0]}=${b[1]}`));
    const normalized = new URL(`${url.protocol}//${url.hostname.replace(/^www\./i, "")}${url.pathname}`);
    for (const [key, value] of keep) normalized.searchParams.append(key, value);
    normalized.hash = "";
    return normalized.toString();
  } catch {
    return null;
  }
}

function titleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const left = new Set(a.split(" ").filter(Boolean));
  const right = new Set(b.split(" ").filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / Math.max(left.size, right.size);
}

function sourceQuality(provider: string): number {
  switch (provider) {
    case "sec-edgar":
      return 100;
    case "finnhub":
      return 92;
    case "google-news-rss":
      return 78;
    case "alpha-vantage":
      return 70;
    case "fmp":
      return 66;
    case "yfinance-fallback":
      return 40;
    default:
      return 50;
  }
}

function companyTokens(companyName: string | null): string[] {
  return uniqueTokens(companyName).filter((token) => token.length >= 3 && !COMPANY_SUFFIXES.has(token));
}

export function scoreNewsCandidate(context: { ticker: string; companyName: string | null }, candidate: NewsCandidate): number {
  const ticker = context.ticker.toUpperCase();
  const title = normalizeHeadline(candidate.headline);
  const snippet = normalizeSnippet(candidate.snippet) ?? "";
  const titleUpper = title.toUpperCase();
  const snippetUpper = snippet.toUpperCase();
  const provider = candidate.provider;
  const company = normalizeHeadline(context.companyName ?? "");
  const titleTokens = new Set(tokenize(title));
  const snippetTokens = new Set(tokenize(snippet));
  const companyTokenList = companyTokens(company || null);
  const exactTicker = exactWordRegex(ticker);

  const titleTickerMatch = exactTicker.test(titleUpper);
  const snippetTickerMatch = exactTicker.test(snippetUpper);
  const titleCompanyMatch = company ? title.toLowerCase().includes(company.toLowerCase()) : false;
  const snippetCompanyMatch = company ? snippet.toLowerCase().includes(company.toLowerCase()) : false;
  const titleCompanyHits = companyTokenList.filter((token) => titleTokens.has(token)).length;
  const snippetCompanyHits = companyTokenList.filter((token) => snippetTokens.has(token)).length;
  const titleCompanyStrong = companyTokenList.length <= 1 ? titleCompanyHits >= 1 : titleCompanyHits >= 2;
  const snippetCompanyStrong = companyTokenList.length <= 1 ? snippetCompanyHits >= 1 : snippetCompanyHits >= 2;
  const highSignalTitle = HIGH_SIGNAL_PATTERNS.some((pattern) => pattern.test(title));
  const highSignalSnippet = HIGH_SIGNAL_PATTERNS.some((pattern) => pattern.test(snippet));
  const genericTitle = GENERIC_MARKET_PATTERNS.some((pattern) => pattern.test(title));
  const genericSnippet = GENERIC_MARKET_PATTERNS.some((pattern) => pattern.test(snippet));

  let score = sourceQuality(provider) / 10;
  if (provider === "sec-edgar") score += 25;
  if (titleTickerMatch) score += 44;
  if (snippetTickerMatch) score += 14;
  if (titleCompanyMatch) score += 40;
  if (snippetCompanyMatch) score += 12;
  if (titleCompanyStrong) score += 18;
  if (snippetCompanyStrong) score += 7;
  if (title.startsWith(`${ticker} `) || (company && title.toLowerCase().startsWith(company.toLowerCase()))) score += 10;
  if (highSignalTitle) score += 28;
  if (highSignalSnippet) score += 10;
  if (genericTitle) score -= 28;
  if (genericSnippet) score -= 8;

  const hasStrongIdentity = titleTickerMatch || titleCompanyMatch || titleCompanyStrong || provider === "sec-edgar";
  if (!hasStrongIdentity && !snippetTickerMatch && !snippetCompanyMatch && !snippetCompanyStrong) score -= 36;
  if (genericTitle && !hasStrongIdentity) score -= 18;
  return score;
}

export function rankAndDedupeNews(
  ticker: string,
  tradingDay: string,
  companyName: string | null,
  candidates: NewsCandidate[],
  maxItems: number,
  fetchedAt = new Date().toISOString(),
): NormalizedNewsItem[] {
  const ranked = candidates
    .map((candidate) => {
      const headline = normalizeHeadline(candidate.headline);
      const canonicalUrl = canonicalizeUrl(candidate.url) ?? candidate.url?.trim() ?? "";
      if (!headline || !canonicalUrl) return null;
      const normalizedTitle = normalizeTitleForDedupe(headline);
      const relevanceScore = scoreNewsCandidate({ ticker, companyName }, candidate);
      const canonicalKey = `${ticker.toUpperCase()}|${tradingDay}|${simpleHash(`${canonicalUrl.toLowerCase()}|${normalizedTitle}`)}`;
      return {
        ticker: ticker.toUpperCase(),
        tradingDay,
        headline,
        source: normalizeHeadline(candidate.source ?? "") || candidate.provider,
        url: canonicalUrl,
        publishedAt: toIso(candidate.publishedAt),
        snippet: normalizeSnippet(candidate.snippet),
        fetchedAt,
        canonicalKey,
        provider: candidate.provider,
        providerPriority: candidate.providerPriority ?? sourceQuality(candidate.provider),
        relevanceScore,
        normalizedTitle,
        canonicalUrl,
      } satisfies RankedNewsItem;
    })
    .filter((row): row is RankedNewsItem => Boolean(row))
    .filter((row) => row.relevanceScore >= 32)
    .sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
      if (b.providerPriority !== a.providerPriority) return b.providerPriority - a.providerPriority;
      return String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? ""));
    });

  const deduped: RankedNewsItem[] = [];
  for (const row of ranked) {
    const existingIndex = deduped.findIndex(
      (existing) =>
        existing.canonicalUrl === row.canonicalUrl ||
        existing.normalizedTitle === row.normalizedTitle ||
        titleSimilarity(existing.normalizedTitle, row.normalizedTitle) >= 0.88,
    );
    if (existingIndex < 0) {
      deduped.push(row);
      continue;
    }
    const existing = deduped[existingIndex];
    const replace =
      row.relevanceScore > existing.relevanceScore ||
      (row.relevanceScore === existing.relevanceScore && row.providerPriority > existing.providerPriority);
    if (replace) deduped[existingIndex] = row;
  }

  return deduped.slice(0, maxItems).map((row) => ({
    ticker: row.ticker,
    tradingDay: row.tradingDay,
    headline: row.headline,
    source: row.source,
    url: row.url,
    publishedAt: row.publishedAt,
    snippet: row.snippet,
    fetchedAt: row.fetchedAt,
    canonicalKey: row.canonicalKey,
  }));
}

export function normalizeNewsCandidates(
  ticker: string,
  tradingDay: string,
  candidates: NewsCandidate[],
  maxItems: number,
  fetchedAt = new Date().toISOString(),
): NormalizedNewsItem[] {
  const normalizedTicker = ticker.toUpperCase();
  const seen = new Set<string>();
  const rows: NormalizedNewsItem[] = [];

  for (const candidate of candidates) {
    const headline = normalizeHeadline(candidate.headline);
    const canonicalUrl = canonicalizeUrl(candidate.url) ?? candidate.url?.trim() ?? "";
    if (!headline || !canonicalUrl) continue;
    const dedupeSeed = `${canonicalUrl.toLowerCase()}|${normalizeTitleForDedupe(headline)}`;
    const dedupeKey = `${normalizedTicker}|${tradingDay}|${simpleHash(dedupeSeed)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    rows.push({
      ticker: normalizedTicker,
      tradingDay,
      headline,
      source: normalizeHeadline(candidate.source ?? "") || candidate.provider || "Unknown",
      url: canonicalUrl,
      publishedAt: toIso(candidate.publishedAt),
      snippet: normalizeSnippet(candidate.snippet),
      fetchedAt,
      canonicalKey: dedupeKey,
    });
    if (rows.length >= maxItems) break;
  }

  return rows;
}

async function fetchTextWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`request failed (${response.status}): ${body.slice(0, 160)}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithTimeout<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  return JSON.parse(await fetchTextWithTimeout(url, init, timeoutMs)) as T;
}

async function loadCompanyName(env: Env, ticker: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT name FROM symbols WHERE ticker = ? LIMIT 1").bind(ticker.toUpperCase()).first<{ name: string | null }>();
  const value = row?.name?.trim() ?? "";
  return value || null;
}

async function loadNewsCache(env: Env, ticker: string, tradingDay: string, maxItems: number): Promise<NormalizedNewsItem[]> {
  const rows = await env.DB.prepare(
    "SELECT ticker, trading_day as tradingDay, headline, source, url, published_at as publishedAt, snippet, fetched_at as fetchedAt, canonical_key as canonicalKey FROM ticker_news WHERE ticker = ? AND trading_day = ? ORDER BY datetime(COALESCE(published_at, fetched_at)) DESC LIMIT ?",
  )
    .bind(ticker.toUpperCase(), tradingDay, Math.max(1, maxItems))
    .all<NormalizedNewsItem>();
  return rows.results ?? [];
}

async function loadFetchCache(env: Env, ticker: string, tradingDay: string): Promise<{ lastAttemptAt: string | null; itemCount: number; status: string | null } | null> {
  return env.DB.prepare(
    "SELECT last_attempt_at as lastAttemptAt, item_count as itemCount, status FROM ticker_news_fetch_cache WHERE ticker = ? AND trading_day = ? LIMIT 1",
  )
    .bind(ticker.toUpperCase(), tradingDay)
    .first<{ lastAttemptAt: string | null; itemCount: number; status: string | null }>();
}

async function saveFetchCache(
  env: Env,
  ticker: string,
  tradingDay: string,
  status: "ok" | "empty" | "error",
  itemCount: number,
  providersTried: string[],
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO ticker_news_fetch_cache (ticker, trading_day, last_attempt_at, last_success_at, status, item_count, provider_trace_json, updated_at) VALUES (?, ?, ?, CASE WHEN ? = 'ok' THEN ? ELSE (SELECT last_success_at FROM ticker_news_fetch_cache WHERE ticker = ? AND trading_day = ?) END, ?, ?, ?, CURRENT_TIMESTAMP)",
  )
    .bind(
      ticker.toUpperCase(),
      tradingDay,
      now,
      status,
      now,
      ticker.toUpperCase(),
      tradingDay,
      status,
      itemCount,
      JSON.stringify(providersTried),
    )
    .run();
}

function isFetchCacheFresh(lastAttemptAt: string | null, status: string | null): boolean {
  if (!lastAttemptAt) return false;
  const then = new Date(lastAttemptAt).getTime();
  if (Number.isNaN(then)) return false;
  const maxAgeMinutes = status === "ok" ? SUCCESS_CACHE_TTL_MINUTES : EMPTY_CACHE_TTL_MINUTES;
  return Date.now() - then < maxAgeMinutes * 60_000;
}

class FinnhubNewsProvider implements TickerNewsProvider {
  readonly name = "finnhub";
  readonly priority = sourceQuality(this.name);
  readonly timeoutMs = 1800;

  isAvailable(env: Env): boolean {
    return Boolean(env.FINNHUB_API_KEY);
  }

  async fetch(env: Env, context: NewsSearchContext): Promise<NewsCandidate[]> {
    const params = new URLSearchParams({
      symbol: context.ticker,
      from: context.startIso.slice(0, 10),
      to: context.endIso.slice(0, 10),
      token: env.FINNHUB_API_KEY ?? "",
    });
    const rows = await fetchJsonWithTimeout<any[]>(
      `https://finnhub.io/api/v1/company-news?${params.toString()}`,
      { headers: { "User-Agent": DEFAULT_USER_AGENT } },
      this.timeoutMs,
    );
    return (rows ?? []).map((row: any) => ({
      provider: this.name,
      providerPriority: this.priority,
      headline: String(row.headline ?? "").trim(),
      source: String(row.source ?? "Finnhub").trim(),
      url: typeof row.url === "string" ? row.url : null,
      publishedAt: toIso(row.datetime),
      snippet: typeof row.summary === "string" ? row.summary : null,
    }));
  }
}

async function loadSecTickerMap(userAgent: string): Promise<Map<string, string>> {
  const now = Date.now();
  if (secTickerMapCache && now - secTickerMapFetchedAt < 12 * 60 * 60_000) return secTickerMapCache;
  const raw = await fetchJsonWithTimeout<Record<string, { ticker?: string; cik_str?: number }>>(
    "https://www.sec.gov/files/company_tickers.json",
    { headers: { "User-Agent": userAgent, Accept: "application/json" } },
    2200,
  );
  const next = new Map<string, string>();
  for (const row of Object.values(raw ?? {})) {
    const ticker = String(row?.ticker ?? "").trim().toUpperCase();
    const cikNum = Number(row?.cik_str ?? 0);
    if (!ticker || !Number.isFinite(cikNum) || cikNum <= 0) continue;
    next.set(ticker, String(cikNum).padStart(10, "0"));
  }
  secTickerMapCache = next;
  secTickerMapFetchedAt = now;
  return next;
}

class SecEdgarProvider implements TickerNewsProvider {
  readonly name = "sec-edgar";
  readonly priority = sourceQuality(this.name);
  readonly timeoutMs = 2200;

  isAvailable(env: Env): boolean {
    return Boolean(env.SEC_USER_AGENT);
  }

  async fetch(env: Env, context: NewsSearchContext): Promise<NewsCandidate[]> {
    const userAgent = env.SEC_USER_AGENT ?? "";
    if (!userAgent) return [];
    const tickerMap = await loadSecTickerMap(userAgent);
    const cik = tickerMap.get(context.ticker);
    if (!cik) return [];
    const payload = await fetchJsonWithTimeout<any>(
      `https://data.sec.gov/submissions/CIK${cik}.json`,
      { headers: { "User-Agent": userAgent, Accept: "application/json" } },
      this.timeoutMs,
    );
    const recent = payload?.filings?.recent;
    if (!recent) return [];
    const filingDates: string[] = Array.isArray(recent.filingDate) ? recent.filingDate : [];
    const forms: string[] = Array.isArray(recent.form) ? recent.form : [];
    const accessionNumbers: string[] = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : [];
    const primaryDocuments: string[] = Array.isArray(recent.primaryDocument) ? recent.primaryDocument : [];
    const descriptions: string[] = Array.isArray(recent.primaryDocDescription) ? recent.primaryDocDescription : [];
    const companyName = String(payload?.name ?? context.companyName ?? context.ticker).trim();
    const minDate = addDays(context.tradingDay, -7);
    const maxDate = addDays(context.tradingDay, 2);
    const items: NewsCandidate[] = [];

    for (let i = 0; i < filingDates.length; i += 1) {
      const filingDate = String(filingDates[i] ?? "");
      if (!filingDate || filingDate < minDate || filingDate > maxDate) continue;
      const accession = String(accessionNumbers[i] ?? "").trim();
      const accessionPath = accession.replace(/-/g, "");
      if (!accession || !accessionPath) continue;
      const primaryDoc = String(primaryDocuments[i] ?? "").trim() || "index.htm";
      const form = String(forms[i] ?? "").trim() || "SEC filing";
      const description = String(descriptions[i] ?? "").trim();
      items.push({
        provider: this.name,
        providerPriority: this.priority,
        headline: `${companyName} ${form} filed with SEC`,
        source: "SEC EDGAR",
        url: `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${accessionPath}/${primaryDoc}`,
        publishedAt: `${filingDate}T00:00:00Z`,
        snippet: description || `${companyName} submitted a ${form} filing to the SEC.`,
      });
    }

    return items;
  }
}

function extractXmlTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeHtml(match[1]).trim() : null;
}

class GoogleNewsRssProvider implements TickerNewsProvider {
  readonly name = "google-news-rss";
  readonly priority = sourceQuality(this.name);
  readonly timeoutMs = 1500;

  isAvailable(_env: Env): boolean {
    return true;
  }

  async fetch(_env: Env, context: NewsSearchContext): Promise<NewsCandidate[]> {
    const query = context.companyName
      ? `"${context.companyName}" OR "${context.ticker}"`
      : `"${context.ticker}"`;
    const params = new URLSearchParams({
      q: query,
      hl: "en-US",
      gl: "US",
      ceid: "US:en",
    });
    const xml = await fetchTextWithTimeout(
      `https://news.google.com/rss/search?${params.toString()}`,
      { headers: { "User-Agent": DEFAULT_USER_AGENT } },
      this.timeoutMs,
    );
    const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
    return items.slice(0, 12).map((item) => ({
      provider: this.name,
      providerPriority: this.priority,
      headline: extractXmlTag(item, "title") ?? "",
      source: extractXmlTag(item, "source") ?? "Google News",
      url: extractXmlTag(item, "link"),
      publishedAt: extractXmlTag(item, "pubDate"),
      snippet: extractXmlTag(item, "description"),
    }));
  }
}

class AlphaVantageNewsProvider implements TickerNewsProvider {
  readonly name = "alpha-vantage";
  readonly priority = sourceQuality(this.name);
  readonly timeoutMs = 1600;

  isAvailable(env: Env): boolean {
    return Boolean(env.ALPHA_VANTAGE_API_KEY);
  }

  async fetch(env: Env, context: NewsSearchContext): Promise<NewsCandidate[]> {
    const params = new URLSearchParams({
      function: "NEWS_SENTIMENT",
      tickers: context.ticker,
      limit: String(Math.max(6, context.maxItems * 4)),
      sort: "LATEST",
      apikey: env.ALPHA_VANTAGE_API_KEY ?? "",
    });
    const payload = await fetchJsonWithTimeout<{ feed?: any[] }>(
      `https://www.alphavantage.co/query?${params.toString()}`,
      { headers: { "User-Agent": DEFAULT_USER_AGENT } },
      this.timeoutMs,
    );
    return (payload.feed ?? []).map((row: any) => ({
      provider: this.name,
      providerPriority: this.priority,
      headline: String(row.title ?? "").trim(),
      source: String(row.source ?? "Alpha Vantage").trim(),
      url: typeof row.url === "string" ? row.url : null,
      publishedAt: toIso(row.time_published),
      snippet: typeof row.summary === "string" ? row.summary : null,
    }));
  }
}

class FmpNewsProvider implements TickerNewsProvider {
  readonly name = "fmp";
  readonly priority = sourceQuality(this.name);
  readonly timeoutMs = 1300;

  isAvailable(env: Env): boolean {
    return Boolean(env.FMP_API_KEY);
  }

  async fetch(env: Env, context: NewsSearchContext): Promise<NewsCandidate[]> {
    const params = new URLSearchParams({
      tickers: context.ticker,
      limit: String(Math.max(6, context.maxItems * 4)),
      apikey: env.FMP_API_KEY ?? "",
    });
    const rows = await fetchJsonWithTimeout<any[]>(
      `https://financialmodelingprep.com/api/v3/stock_news?${params.toString()}`,
      { headers: { "User-Agent": DEFAULT_USER_AGENT } },
      this.timeoutMs,
    );
    return (rows ?? []).map((row: any) => ({
      provider: this.name,
      providerPriority: this.priority,
      headline: String(row.title ?? "").trim(),
      source: String(row.site ?? row.source ?? "FMP").trim(),
      url: typeof row.url === "string" ? row.url : null,
      publishedAt: toIso(row.publishedDate ?? row.publishedAt),
      snippet: typeof row.text === "string" ? row.text : typeof row.snippet === "string" ? row.snippet : null,
    }));
  }
}

class YahooFallbackProvider implements TickerNewsProvider {
  readonly name = "yfinance-fallback";
  readonly priority = sourceQuality(this.name);
  readonly timeoutMs = 1100;

  isAvailable(env: Env): boolean {
    return (env.ALERTS_ENABLE_YFINANCE_FALLBACK ?? "true") === "true";
  }

  async fetch(_env: Env, context: NewsSearchContext): Promise<NewsCandidate[]> {
    const params = new URLSearchParams({
      q: context.companyName ? `${context.ticker} ${context.companyName}` : context.ticker,
      newsCount: String(Math.max(6, context.maxItems * 5)),
      quotesCount: "0",
    });
    const payload = await fetchJsonWithTimeout<{ news?: any[] }>(
      `https://query1.finance.yahoo.com/v1/finance/search?${params.toString()}`,
      { headers: { "User-Agent": DEFAULT_USER_AGENT } },
      this.timeoutMs,
    );
    return (payload.news ?? []).map((row: any) => ({
      provider: this.name,
      providerPriority: this.priority,
      headline: String(row.title ?? row.headline ?? "").trim(),
      source: String(row.publisher ?? row.source ?? "Yahoo Finance").trim(),
      url: typeof row.link === "string" ? row.link : typeof row.url === "string" ? row.url : null,
      publishedAt: toIso(row.providerPublishTime ?? row.published_at ?? row.publishedAt),
      snippet: typeof row.summary === "string" ? row.summary : typeof row.snippet === "string" ? row.snippet : null,
    }));
  }
}

function defaultProviders(): TickerNewsProvider[] {
  return [
    new FinnhubNewsProvider(),
    new SecEdgarProvider(),
    new GoogleNewsRssProvider(),
    new AlphaVantageNewsProvider(),
    new FmpNewsProvider(),
    new YahooFallbackProvider(),
  ];
}

export async function orchestrateTickerNews(
  env: Env,
  context: NewsSearchContext,
  providers = defaultProviders(),
): Promise<{ rows: NormalizedNewsItem[]; trace: FetchTrace[]; providersTried: string[] }> {
  const trace: FetchTrace[] = [];
  const providersTried: string[] = [];
  const collected: NewsCandidate[] = [];
  const fetchedAt = new Date().toISOString();

  for (const provider of providers) {
    if (!provider.isAvailable(env)) {
      trace.push({ provider: provider.name, status: "skipped", rawCount: 0, acceptedCount: 0, durationMs: 0 });
      continue;
    }
    const startedAt = Date.now();
    providersTried.push(provider.name);
    try {
      const raw = await provider.fetch(env, context);
      collected.push(...raw);
      const accepted = rankAndDedupeNews(context.ticker, context.tradingDay, context.companyName, collected, context.maxItems, fetchedAt);
      trace.push({
        provider: provider.name,
        status: raw.length > 0 ? "ok" : "empty",
        rawCount: raw.length,
        acceptedCount: accepted.length,
        durationMs: Date.now() - startedAt,
      });
      const strongEnough = accepted.length >= context.maxItems;
      if (strongEnough) {
        return { rows: accepted, trace, providersTried };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "provider failed";
      trace.push({
        provider: provider.name,
        status: /abort/i.test(message) ? "timeout" : "error",
        rawCount: 0,
        acceptedCount: rankAndDedupeNews(context.ticker, context.tradingDay, context.companyName, collected, context.maxItems, fetchedAt).length,
        durationMs: Date.now() - startedAt,
        error: message.slice(0, 180),
      });
    }
  }

  return {
    rows: rankAndDedupeNews(context.ticker, context.tradingDay, context.companyName, collected, context.maxItems, fetchedAt),
    trace,
    providersTried,
  };
}

export async function fetchTickerNews(
  env: Env,
  ticker: string,
  tradingDay: string,
  maxItems = 3,
): Promise<{ rows: NormalizedNewsItem[]; providersTried: string[] }> {
  const normalizedTicker = ticker.toUpperCase();
  const cachedRows = await loadNewsCache(env, normalizedTicker, tradingDay, maxItems);
  const cache = await loadFetchCache(env, normalizedTicker, tradingDay);
  if (cache && isFetchCacheFresh(cache.lastAttemptAt, cache.status)) {
    return {
      rows: cachedRows.slice(0, maxItems),
      providersTried: ["cache"],
    };
  }

  const companyName = await loadCompanyName(env, normalizedTicker);
  const context: NewsSearchContext = {
    ticker: normalizedTicker,
    companyName,
    tradingDay,
    startIso: `${addDays(tradingDay, -2)}T00:00:00Z`,
    endIso: `${addDays(tradingDay, 2)}T23:59:59Z`,
    maxItems,
  };
  const result = await orchestrateTickerNews(env, context);
  await saveFetchCache(
    env,
    normalizedTicker,
    tradingDay,
    result.rows.length > 0 ? "ok" : "empty",
    result.rows.length,
    result.trace.map((row) => `${row.provider}:${row.status}:${row.acceptedCount}`),
  );
  return {
    rows: result.rows,
    providersTried: result.providersTried,
  };
}
