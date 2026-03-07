import type { Env } from "./types";

export type NewsCandidate = {
  headline: string;
  source?: string | null;
  url?: string | null;
  publishedAt?: string | null;
  snippet?: string | null;
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

interface TickerNewsProvider {
  readonly name: string;
  isAvailable(env: Env): boolean;
  fetch(env: Env, ticker: string, startIso: string, endIso: string, limit: number): Promise<NewsCandidate[]>;
}

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

function normalizeHeadline(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeSnippet(value: string | null | undefined): string | null {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, 800);
}

function simpleHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const keep: Array<[string, string]> = [];
    for (const [key, value] of url.searchParams.entries()) {
      if (key.toLowerCase().startsWith("utm_")) continue;
      keep.push([key, value]);
    }
    const normalized = new URL(`${url.protocol}//${url.hostname.replace(/^www\./i, "")}${url.pathname}`);
    for (const [key, value] of keep) normalized.searchParams.append(key, value);
    normalized.hash = "";
    return normalized.toString();
  } catch {
    return null;
  }
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
    if (!headline) continue;
    const canonicalUrl = canonicalizeUrl(candidate.url) ?? candidate.url?.trim() ?? "";
    if (!canonicalUrl) continue;
    const dedupeSeed = `${canonicalUrl.toLowerCase()}|${headline.toLowerCase()}`;
    const dedupeKey = `${normalizedTicker}|${tradingDay}|${simpleHash(dedupeSeed)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    rows.push({
      ticker: normalizedTicker,
      tradingDay,
      headline,
      source: normalizeHeadline(candidate.source ?? "") || "Unknown",
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

class AlpacaNewsProvider implements TickerNewsProvider {
  readonly name = "alpaca";

  isAvailable(env: Env): boolean {
    return Boolean(env.ALPACA_API_KEY && env.ALPACA_API_SECRET);
  }

  async fetch(env: Env, ticker: string, startIso: string, endIso: string, limit: number): Promise<NewsCandidate[]> {
    if (!this.isAvailable(env)) return [];
    const params = new URLSearchParams({
      symbols: ticker.toUpperCase(),
      start: startIso,
      end: endIso,
      limit: String(Math.max(3, Math.min(50, limit * 4))),
      sort: "desc",
    });
    const response = await fetch(`https://data.alpaca.markets/v1beta1/news?${params.toString()}`, {
      headers: {
        "APCA-API-KEY-ID": env.ALPACA_API_KEY ?? "",
        "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET ?? "",
        "User-Agent": "market-command-centre/1.0",
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`alpaca news fetch failed (${response.status}): ${body.slice(0, 120)}`);
    }
    const payload = (await response.json()) as { news?: any[] } | any[];
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload.news) ? payload.news : [];
    return rows.map((row: any) => ({
      headline: String(row.headline ?? row.title ?? "").trim(),
      source: String(row.source ?? row.author ?? "Alpaca").trim(),
      url: typeof row.url === "string" ? row.url : null,
      publishedAt: toIso(row.created_at ?? row.updated_at ?? row.published_at),
      snippet: typeof row.summary === "string" ? row.summary : typeof row.content === "string" ? row.content : null,
    }));
  }
}

class IbkrNewsAdapter implements TickerNewsProvider {
  readonly name = "ibkr-adapter";

  isAvailable(env: Env): boolean {
    return (env.IBKR_NEWS_ENABLED ?? "false") === "true" && Boolean(env.IBKR_NEWS_ENDPOINT);
  }

  async fetch(env: Env, ticker: string, startIso: string, endIso: string, limit: number): Promise<NewsCandidate[]> {
    if (!this.isAvailable(env)) return [];
    const endpoint = env.IBKR_NEWS_ENDPOINT ?? "";
    const params = new URLSearchParams({
      ticker: ticker.toUpperCase(),
      start: startIso,
      end: endIso,
      limit: String(Math.max(3, Math.min(20, limit * 3))),
    });
    const response = await fetch(`${endpoint}?${params.toString()}`, {
      headers: {
        Authorization: env.IBKR_NEWS_TOKEN ? `Bearer ${env.IBKR_NEWS_TOKEN}` : "",
        "User-Agent": "market-command-centre/1.0",
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`ibkr adapter fetch failed (${response.status}): ${body.slice(0, 120)}`);
    }
    const payload = (await response.json()) as { news?: any[] } | any[];
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload.news) ? payload.news : [];
    return rows.map((row: any) => ({
      headline: String(row.headline ?? row.title ?? "").trim(),
      source: String(row.source ?? "IBKR").trim(),
      url: typeof row.url === "string" ? row.url : null,
      publishedAt: toIso(row.published_at ?? row.publishedAt ?? row.timestamp),
      snippet: typeof row.summary === "string" ? row.summary : typeof row.snippet === "string" ? row.snippet : null,
    }));
  }
}

class YFinanceFallbackProvider implements TickerNewsProvider {
  readonly name = "yfinance-fallback";

  isAvailable(env: Env): boolean {
    return (env.ALERTS_ENABLE_YFINANCE_FALLBACK ?? "true") === "true";
  }

  async fetch(_: Env, ticker: string, _startIso: string, _endIso: string, limit: number): Promise<NewsCandidate[]> {
    const params = new URLSearchParams({
      q: ticker.toUpperCase(),
      newsCount: String(Math.max(3, Math.min(50, limit * 5))),
      quotesCount: "0",
    });
    const response = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?${params.toString()}`, {
      headers: {
        "User-Agent": "market-command-centre/1.0",
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`yfinance fallback fetch failed (${response.status}): ${body.slice(0, 120)}`);
    }
    const payload = (await response.json()) as { news?: any[] };
    const rows = Array.isArray(payload.news) ? payload.news : [];
    return rows.map((row: any) => ({
      headline: String(row.title ?? row.headline ?? "").trim(),
      source: String(row.publisher ?? row.source ?? "Yahoo Finance").trim(),
      url: typeof row.link === "string" ? row.link : typeof row.url === "string" ? row.url : null,
      publishedAt: toIso(row.providerPublishTime ?? row.published_at ?? row.publishedAt),
      snippet: typeof row.summary === "string" ? row.summary : typeof row.snippet === "string" ? row.snippet : null,
    }));
  }
}

export async function fetchTickerNews(
  env: Env,
  ticker: string,
  tradingDay: string,
  maxItems = 3,
): Promise<{ rows: NormalizedNewsItem[]; providersTried: string[] }> {
  const providers: TickerNewsProvider[] = [new AlpacaNewsProvider(), new IbkrNewsAdapter(), new YFinanceFallbackProvider()];
  const providersTried: string[] = [];
  const collected: NormalizedNewsItem[] = [];
  const seen = new Set<string>();
  const fetchedAt = new Date().toISOString();

  const startIso = `${addDays(tradingDay, -1)}T00:00:00Z`;
  const endIso = `${addDays(tradingDay, 1)}T23:59:59Z`;

  for (const provider of providers) {
    if (!provider.isAvailable(env)) continue;
    providersTried.push(provider.name);
    try {
      const raw = await provider.fetch(env, ticker, startIso, endIso, maxItems);
      const normalized = normalizeNewsCandidates(ticker, tradingDay, raw, Math.max(maxItems * 2, 6), fetchedAt);
      for (const row of normalized) {
        if (seen.has(row.canonicalKey)) continue;
        seen.add(row.canonicalKey);
        collected.push(row);
        if (collected.length >= maxItems) break;
      }
      if (collected.length >= maxItems) break;
    } catch (error) {
      console.error(`news provider failed: ${provider.name}`, { ticker, tradingDay, error });
    }
  }

  return {
    rows: collected.slice(0, maxItems),
    providersTried,
  };
}

