import type { Env } from "./types";

export type PerplexityFinanceLookupStatus =
  | "ready"
  | "partial"
  | "pending_timeout"
  | "blocked"
  | "not_found"
  | "parse_error";

export type PerplexityFinanceCompany = {
  name: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  description: string | null;
};

export type PerplexityFinancePeer = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  rawText: string;
};

export type PerplexityFinanceCacheLookup = {
  ticker: string;
  fetchedAt: string;
  source: "perplexity_finance_dashboard";
  peersUrl: string;
  profileUrl: string;
  company: PerplexityFinanceCompany;
  peers: PerplexityFinancePeer[];
  warning: string | null;
  status: PerplexityFinanceLookupStatus;
  profileStatus: PerplexityFinanceLookupStatus;
  peersStatus: PerplexityFinanceLookupStatus;
};

export type PerplexityFinanceCacheReadResult =
  | {
    hit: true;
    lookup: PerplexityFinanceCacheLookup;
    storedAt: string;
    ageSeconds: number | null;
  }
  | {
    hit: false;
    warning?: string;
  };

export type PerplexityFinanceCacheWriteResult = {
  ok: true;
  cached: boolean;
  ticker: string;
  storedAt: string | null;
  reason: string | null;
};

type CacheRow = {
  ticker: string;
  fetchedAt: string;
  storedAt: string;
  status: PerplexityFinanceLookupStatus;
  profileStatus: PerplexityFinanceLookupStatus | null;
  peersStatus: PerplexityFinanceLookupStatus | null;
  warning: string | null;
  profileUrl: string;
  peersUrl: string;
  companyName: string | null;
  companyExchange: string | null;
  companySector: string | null;
  companyIndustry: string | null;
  companyDescription: string | null;
  peersJson: string;
  payloadVersion: number;
};

const TICKER_PATTERN = /^[A-Z0-9]{1,8}(?:[.-][A-Z0-9]{1,5})?$/;
const STATUSES = new Set<PerplexityFinanceLookupStatus>([
  "ready",
  "partial",
  "pending_timeout",
  "blocked",
  "not_found",
  "parse_error",
]);

export class PerplexityFinanceCacheInputError extends Error {
  readonly status = 400;
}

export class PerplexityFinanceCacheUnavailableError extends Error {
  readonly status = 503;
}

function normalizeTicker(value: unknown): string | null {
  const ticker = String(value ?? "").trim().toUpperCase();
  return TICKER_PATTERN.test(ticker) ? ticker : null;
}

function stringOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function statusOrDefault(value: unknown, fallback: PerplexityFinanceLookupStatus): PerplexityFinanceLookupStatus {
  return STATUSES.has(value as PerplexityFinanceLookupStatus) ? value as PerplexityFinanceLookupStatus : fallback;
}

function parsePeersJson(value: string, rootTicker: string): PerplexityFinancePeer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const found = new Map<string, PerplexityFinancePeer>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const ticker = normalizeTicker(record.ticker);
    if (!ticker || ticker === rootTicker || found.has(ticker)) continue;
    found.set(ticker, {
      ticker,
      name: stringOrNull(record.name),
      exchange: stringOrNull(record.exchange),
      rawText: stringOrNull(record.rawText) ?? ticker,
    });
  }
  return Array.from(found.values()).slice(0, 50);
}

function compactPeers(peers: unknown, rootTicker: string): PerplexityFinancePeer[] {
  if (!Array.isArray(peers)) return [];
  const found = new Map<string, PerplexityFinancePeer>();
  for (const item of peers) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const ticker = normalizeTicker(record.ticker);
    if (!ticker || ticker === rootTicker || found.has(ticker)) continue;
    found.set(ticker, {
      ticker,
      name: stringOrNull(record.name),
      exchange: stringOrNull(record.exchange),
      rawText: stringOrNull(record.rawText) ?? ticker,
    });
  }
  return Array.from(found.values()).slice(0, 50);
}

function compactCompany(value: unknown): PerplexityFinanceCompany {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    name: stringOrNull(record.name),
    exchange: stringOrNull(record.exchange),
    sector: stringOrNull(record.sector),
    industry: stringOrNull(record.industry),
    description: stringOrNull(record.description),
  };
}

function hasCompanyData(company: PerplexityFinanceCompany): boolean {
  return Boolean(company.name || company.exchange || company.sector || company.industry || company.description);
}

function isCacheableLookup(lookup: PerplexityFinanceCacheLookup): boolean {
  if (lookup.status !== "ready" && lookup.status !== "partial") return false;
  if (lookup.peers.length === 0) return false;
  return hasCompanyData(lookup.company) || lookup.peers.length > 0;
}

function rowToLookup(row: CacheRow): PerplexityFinanceCacheLookup {
  const ticker = normalizeTicker(row.ticker) ?? row.ticker.toUpperCase();
  return {
    ticker,
    fetchedAt: row.fetchedAt,
    source: "perplexity_finance_dashboard",
    peersUrl: row.peersUrl,
    profileUrl: row.profileUrl,
    company: {
      name: row.companyName,
      exchange: row.companyExchange,
      sector: row.companySector,
      industry: row.companyIndustry,
      description: row.companyDescription,
    },
    peers: parsePeersJson(row.peersJson, ticker),
    warning: row.warning,
    status: statusOrDefault(row.status, "partial"),
    profileStatus: statusOrDefault(row.profileStatus, "partial"),
    peersStatus: statusOrDefault(row.peersStatus, "ready"),
  };
}

function ageSeconds(storedAt: string): number | null {
  const parsed = Date.parse(storedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

function db(env: Env): D1Database | null {
  return env.PERPLEXITY_CACHE_DB ?? null;
}

export function parsePerplexityFinanceCachePayload(input: unknown, expectedTicker: string): PerplexityFinanceCacheLookup {
  const ticker = normalizeTicker(expectedTicker);
  if (!ticker) throw new PerplexityFinanceCacheInputError("Invalid ticker.");
  if (!input || typeof input !== "object") {
    throw new PerplexityFinanceCacheInputError("Invalid Perplexity cache payload.");
  }
  const record = input as Record<string, unknown>;
  const payloadTicker = normalizeTicker(record.ticker);
  if (payloadTicker !== ticker) throw new PerplexityFinanceCacheInputError("Payload ticker does not match the route ticker.");
  const fetchedAt = stringOrNull(record.fetchedAt);
  const profileUrl = stringOrNull(record.profileUrl);
  const peersUrl = stringOrNull(record.peersUrl);
  if (!fetchedAt || !profileUrl || !peersUrl) {
    throw new PerplexityFinanceCacheInputError("Payload is missing fetchedAt, profileUrl, or peersUrl.");
  }
  const company = compactCompany(record.company);
  return {
    ticker,
    fetchedAt,
    source: "perplexity_finance_dashboard",
    peersUrl,
    profileUrl,
    company,
    peers: compactPeers(record.peers, ticker),
    warning: stringOrNull(record.warning),
    status: statusOrDefault(record.status, "parse_error"),
    profileStatus: statusOrDefault(record.profileStatus, "parse_error"),
    peersStatus: statusOrDefault(record.peersStatus, "parse_error"),
  };
}

export async function loadPerplexityFinanceCache(env: Env, tickerInput: string): Promise<PerplexityFinanceCacheReadResult> {
  const ticker = normalizeTicker(tickerInput);
  if (!ticker) throw new PerplexityFinanceCacheInputError("Invalid ticker.");
  const storage = db(env);
  if (!storage) {
    return { hit: false, warning: "PERPLEXITY_CACHE_DB binding is not configured." };
  }
  const row = await storage.prepare(
    `SELECT ticker,
            fetched_at as fetchedAt,
            stored_at as storedAt,
            status,
            profile_status as profileStatus,
            peers_status as peersStatus,
            warning,
            profile_url as profileUrl,
            peers_url as peersUrl,
            company_name as companyName,
            company_exchange as companyExchange,
            company_sector as companySector,
            company_industry as companyIndustry,
            company_description as companyDescription,
            peers_json as peersJson,
            payload_version as payloadVersion
     FROM perplexity_finance_cache
     WHERE ticker = ?
     LIMIT 1`,
  )
    .bind(ticker)
    .first<CacheRow>();
  if (!row) return { hit: false };
  const lookup = rowToLookup(row);
  if (lookup.peers.length === 0) return { hit: false, warning: "Cached Perplexity row had no valid peers." };
  return {
    hit: true,
    lookup,
    storedAt: row.storedAt,
    ageSeconds: ageSeconds(row.storedAt),
  };
}

export async function upsertPerplexityFinanceCache(
  env: Env,
  tickerInput: string,
  payload: unknown,
): Promise<PerplexityFinanceCacheWriteResult> {
  const ticker = normalizeTicker(tickerInput);
  if (!ticker) throw new PerplexityFinanceCacheInputError("Invalid ticker.");
  const storage = db(env);
  if (!storage) throw new PerplexityFinanceCacheUnavailableError("PERPLEXITY_CACHE_DB binding is not configured.");
  const lookup = parsePerplexityFinanceCachePayload(payload, ticker);
  if (!isCacheableLookup(lookup)) {
    return {
      ok: true,
      cached: false,
      ticker,
      storedAt: null,
      reason: "Lookup status or peer payload is not cacheable.",
    };
  }
  const storedAt = new Date().toISOString();
  await storage.prepare(
    `INSERT INTO perplexity_finance_cache (
       ticker,
       fetched_at,
       stored_at,
       status,
       profile_status,
       peers_status,
       warning,
       profile_url,
       peers_url,
       company_name,
       company_exchange,
       company_sector,
       company_industry,
       company_description,
       peers_json,
       payload_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(ticker) DO UPDATE SET
       fetched_at = excluded.fetched_at,
       stored_at = excluded.stored_at,
       status = excluded.status,
       profile_status = excluded.profile_status,
       peers_status = excluded.peers_status,
       warning = excluded.warning,
       profile_url = excluded.profile_url,
       peers_url = excluded.peers_url,
       company_name = excluded.company_name,
       company_exchange = excluded.company_exchange,
       company_sector = excluded.company_sector,
       company_industry = excluded.company_industry,
       company_description = excluded.company_description,
       peers_json = excluded.peers_json,
       payload_version = excluded.payload_version`,
  )
    .bind(
      ticker,
      lookup.fetchedAt,
      storedAt,
      lookup.status,
      lookup.profileStatus,
      lookup.peersStatus,
      lookup.warning,
      lookup.profileUrl,
      lookup.peersUrl,
      lookup.company.name,
      lookup.company.exchange,
      lookup.company.sector,
      lookup.company.industry,
      lookup.company.description,
      JSON.stringify(lookup.peers),
    )
    .run();
  return {
    ok: true,
    cached: true,
    ticker,
    storedAt,
    reason: null,
  };
}
