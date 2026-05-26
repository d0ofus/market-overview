import type { Env } from "./types";
import {
  canUseEarningsSymbolCatalog,
  earningsDefaultEligibleListedEquitySql,
  earningsEligibleSecuritySql,
  earningsMajorUsExchangeSql,
  filterRowsByEarningsSymbolCatalog,
  isExcludedEarningsIssue,
  normalizeEarningsQueryLimit,
  normalizeEarningsQueryOffset,
} from "./earnings-issue-filter";

const TV_SCAN_URL = "https://scanner.tradingview.com/america/scan";
const PRIMARY_PROVIDER = "tradingview";
const BACKFILL_DAYS = 183;
const INCREMENTAL_LOOKBACK_DAYS = 7;
const RETENTION_DAYS = 183;
const TV_PAGE_SIZE = 500;
const TV_MAX_PROVIDER_ROWS = 10_000;
const SYNC_BATCH_SIZE = 80;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 250;
const EXPORT_MAX_LIMIT = 1000;
const FMP_EARNINGS_URL = "https://financialmodelingprep.com/stable/earnings-calendar";
const FINNHUB_EARNINGS_URL = "https://finnhub.io/api/v1/calendar/earnings";

type EarningsSurpriseProvider = "tradingview" | "fmp" | "finnhub";
type EarningsSurpriseSyncMode = "incremental" | "backfill";
type SurpriseSide = "all" | "positive" | "negative";

type TradingViewFilter = {
  left: string;
  operation: string;
  right: number | string | boolean | Array<number | string | boolean>;
};

export type TradingViewEarningsSurprisePayload = {
  markets: string[];
  symbols: { query: { types: string[] }; tickers: string[] };
  options: { lang: string };
  columns: string[];
  sort: { sortBy: string; sortOrder: "asc" | "desc"; nullsFirst?: boolean };
  range: [number, number];
  filter: TradingViewFilter[];
};

type TradingViewScanResponse = {
  totalCount?: number;
  data?: Array<{ s?: string; d?: unknown[] }>;
};

export type EarningsSurpriseEventInput = {
  provider: EarningsSurpriseProvider;
  sourceSymbol: string;
  ticker: string;
  exchange: string | null;
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  reportDate: string;
  reportTimestamp: number | null;
  reportTime: string | null;
  fiscalPeriodEnd: string | null;
  season: string;
  epsActual: number | null;
  epsEstimate: number | null;
  epsSurprise: number | null;
  epsSurprisePct: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
  revenueSurprise: number | null;
  revenueSurprisePct: number | null;
  rawJson: string | null;
};

export type EarningsSurpriseRow = {
  id: string;
  provider: string;
  sourceSymbol: string;
  ticker: string;
  exchange: string | null;
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  reportDate: string;
  reportTimestamp: number | null;
  reportTime: string | null;
  fiscalPeriodEnd: string | null;
  season: string;
  epsActual: number | null;
  epsEstimate: number | null;
  epsSurprise: number | null;
  epsSurprisePct: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
  revenueSurprise: number | null;
  revenueSurprisePct: number | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

export type EarningsSurprisesQuery = {
  limit?: number | null;
  offset?: number | null;
  q?: string | null;
  season?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  minMarketCap?: number | null;
  maxMarketCap?: number | null;
  minEpsSurprisePct?: number | null;
  sector?: string | string[] | null;
  industry?: string | string[] | null;
  exchange?: string | string[] | null;
  includeOtc?: boolean | null;
  surpriseSide?: SurpriseSide | null;
  sort?: string | null;
  sortDir?: "asc" | "desc" | null;
};

export type EarningsSurprisesResponse = {
  schemaReady: boolean;
  warning: string | null;
  generatedAt: string;
  total: number;
  limit: number;
  offset: number;
  rows: EarningsSurpriseRow[];
  facets: {
    seasons: Array<{ value: string; count: number }>;
    sectors: Array<{ value: string; count: number }>;
    industries: Array<{ value: string; count: number }>;
    exchanges: Array<{ value: string; count: number }>;
  };
};

export type EarningsSurpriseSyncResult = {
  ok: boolean;
  mode: EarningsSurpriseSyncMode;
  windowStart: string;
  windowEnd: string;
  provider: EarningsSurpriseProvider | null;
  providers: Array<{
    provider: string;
    status: "ok" | "skipped" | "error";
    rowsSeen: number;
    rowsUpserted: number;
    error: string | null;
  }>;
  rowsSeen: number;
  rowsUpserted: number;
  warning: string | null;
};

export type EarningsSurprisesStatus = {
  schemaReady: boolean;
  warning: string | null;
  counts: {
    total: number;
    positive: number;
    negative: number;
    latestReportDate: string | null;
    earliestReportDate: string | null;
  };
  syncs: Array<{
    provider: string;
    status: string;
    mode: string | null;
    windowStart: string | null;
    windowEnd: string | null;
    lastStartedAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    rowsSeen: number | null;
    rowsUpserted: number | null;
    updatedAt: string | null;
  }>;
  latestRows: EarningsSurpriseRow[];
};

const TV_COLUMNS = [
  "description",
  "name",
  "exchange",
  "type",
  "sector",
  "industry",
  "market_cap_basic",
  "earnings_per_share_fq",
  "earnings_per_share_forecast_fq",
  "eps_surprise_fq",
  "eps_surprise_percent_fq",
  "revenue_fq",
  "revenue_forecast_fq",
  "revenue_surprise_fq",
  "revenue_surprise_percent_fq",
  "earnings_release_date",
  "earnings_release_time",
  "earnings_release_calendar_date",
];

const SORT_COLUMNS: Record<string, string> = {
  reportDate: "report_date",
  ticker: "ticker",
  companyName: "company_name",
  marketCap: "market_cap",
  epsSurprise: "eps_surprise",
  epsSurprisePct: "eps_surprise_pct",
  revenueSurprise: "revenue_surprise",
  revenueSurprisePct: "revenue_surprise_pct",
  season: "season",
  sector: "sector",
  industry: "industry",
  exchange: "exchange",
};

function normalizeTicker(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function normalizeExchange(value: unknown): string | null {
  const text = normalizeText(value);
  return text ? text.toUpperCase() : null;
}

function parseMaybeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null) return null;
  const text = String(value).trim().replace(/,/g, "");
  if (!text || /^none|null|nan|-$/i.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function timestampToUtcDate(timestampSeconds: number | null): string | null {
  if (timestampSeconds == null || !Number.isFinite(timestampSeconds)) return null;
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
}

function timestampToNewYorkDate(timestampSeconds: number | null): string | null {
  if (timestampSeconds == null || !Number.isFinite(timestampSeconds)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestampSeconds * 1000));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoDateDaysAgo(days: number, now = new Date()): string {
  return addDays(now, -days).toISOString().slice(0, 10);
}

function todayIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
}

function dateToUnixStart(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 1000);
}

function dateToUnixEnd(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T23:59:59Z`) / 1000);
}

function seasonForDate(isoDate: string | null): string {
  const normalized = normalizeDate(isoDate);
  if (!normalized) return "Unknown";
  const year = Number(normalized.slice(0, 4));
  const month = Number(normalized.slice(5, 7));
  const quarter = Math.max(1, Math.min(4, Math.ceil(month / 3)));
  return `${year} Q${quarter}`;
}

export function deriveEarningsSeason(fiscalPeriodEnd: string | null, reportDate: string): string {
  return seasonForDate(fiscalPeriodEnd ?? reportDate);
}

function normalizeReportTime(value: unknown): string | null {
  const numeric = parseMaybeNumber(value);
  if (numeric === -1) return "before-market";
  if (numeric === 1) return "after-market";
  if (numeric === 0) return null;
  const text = normalizeText(value);
  return text ? text.slice(0, 32) : null;
}

function parseTradingViewTicker(sourceSymbol: unknown): string {
  const raw = String(sourceSymbol ?? "").trim().toUpperCase();
  if (!raw) return "";
  const parts = raw.split(":");
  return parts[parts.length - 1] ?? raw;
}

function toJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function simpleHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function eventId(row: Pick<EarningsSurpriseEventInput, "ticker" | "reportDate" | "fiscalPeriodEnd">): string {
  return `earnings-surprise-${row.ticker}-${row.reportDate}-${simpleHash(row.fiscalPeriodEnd ?? "")}`;
}

async function tableExists(env: Env, tableName: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).bind(tableName).first<{ count: number }>();
  return Number(row?.count ?? 0) > 0;
}

export async function hasEarningsSurpriseSchema(env: Env): Promise<boolean> {
  const [eventsReady, syncsReady] = await Promise.all([
    tableExists(env, "earnings_surprise_events"),
    tableExists(env, "earnings_surprise_syncs"),
  ]);
  return eventsReady && syncsReady;
}

async function requireEarningsSurpriseSchema(env: Env): Promise<void> {
  if (!(await hasEarningsSurpriseSchema(env))) {
    throw new Error("Earnings surprise schema is missing. Apply worker/migrations/0051_earnings_surprises.sql.");
  }
}

export function buildTradingViewEarningsSurprisePayload(input: {
  startDate: string;
  endDate: string;
  side: "positive" | "negative";
  offset?: number;
  limit?: number;
}): TradingViewEarningsSurprisePayload {
  const offset = Math.max(0, Number(input.offset ?? 0));
  const limit = Math.max(1, Math.min(TV_PAGE_SIZE, Number(input.limit ?? TV_PAGE_SIZE)));
  const isPositive = input.side === "positive";
  return {
    markets: ["america"],
    symbols: { query: { types: ["stock"] }, tickers: [] },
    options: { lang: "en" },
    columns: TV_COLUMNS,
    sort: { sortBy: "eps_surprise_percent_fq", sortOrder: isPositive ? "desc" : "asc" },
    range: [offset, offset + limit],
    filter: [
      { left: "eps_surprise_percent_fq", operation: isPositive ? "greater" : "less", right: 0 },
      { left: "earnings_release_date", operation: "in_range", right: [dateToUnixStart(input.startDate), dateToUnixEnd(input.endDate)] },
    ],
  };
}

export function parseTradingViewEarningsSurpriseRows(response: TradingViewScanResponse): EarningsSurpriseEventInput[] {
  return (response.data ?? [])
    .map((entry) => {
      const data = Array.isArray(entry.d) ? entry.d : [];
      const sourceSymbol = String(entry.s ?? "").trim().toUpperCase();
      const ticker = parseTradingViewTicker(sourceSymbol);
      const companyName = normalizeText(data[0]) ?? normalizeText(data[1]);
      const issueType = normalizeText(data[3]);
      const reportTimestamp = parseMaybeNumber(data[15]);
      const reportDate = timestampToNewYorkDate(reportTimestamp);
      if (!ticker || !reportDate) return null;
      if (isExcludedEarningsIssue({ ticker, sourceSymbol, companyName, issueType })) return null;
      const fiscalPeriodEnd = timestampToUtcDate(parseMaybeNumber(data[17]));
      const epsActual = parseMaybeNumber(data[7]);
      const epsEstimate = parseMaybeNumber(data[8]);
      const epsSurprise = parseMaybeNumber(data[9]);
      const epsSurprisePct = parseMaybeNumber(data[10]);
      if (epsSurprisePct == null || epsSurprisePct === 0) return null;
      return {
        provider: PRIMARY_PROVIDER,
        sourceSymbol,
        ticker,
        exchange: normalizeExchange(data[2]),
        companyName,
        sector: normalizeText(data[4]),
        industry: normalizeText(data[5]),
        marketCap: parseMaybeNumber(data[6]),
        reportDate,
        reportTimestamp,
        reportTime: normalizeReportTime(data[16]),
        fiscalPeriodEnd,
        season: deriveEarningsSeason(fiscalPeriodEnd, reportDate),
        epsActual,
        epsEstimate,
        epsSurprise,
        epsSurprisePct,
        revenueActual: parseMaybeNumber(data[11]),
        revenueEstimate: parseMaybeNumber(data[12]),
        revenueSurprise: parseMaybeNumber(data[13]),
        revenueSurprisePct: parseMaybeNumber(data[14]),
        rawJson: toJson(entry),
      } satisfies EarningsSurpriseEventInput;
    })
    .filter((row): row is EarningsSurpriseEventInput => Boolean(row));
}

function dedupeEvents(rows: EarningsSurpriseEventInput[]): EarningsSurpriseEventInput[] {
  const byKey = new Map<string, EarningsSurpriseEventInput>();
  for (const row of rows) {
    const key = `${row.ticker}|${row.reportDate}|${row.fiscalPeriodEnd ?? ""}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    const preferred = row.provider === PRIMARY_PROVIDER || existing.provider !== PRIMARY_PROVIDER ? row : existing;
    const fallback = preferred === row ? existing : row;
    byKey.set(key, {
      ...preferred,
      sourceSymbol: preferred.sourceSymbol || fallback.sourceSymbol,
      exchange: preferred.exchange ?? fallback.exchange,
      companyName: preferred.companyName ?? fallback.companyName,
      sector: preferred.sector ?? fallback.sector,
      industry: preferred.industry ?? fallback.industry,
      marketCap: preferred.marketCap ?? fallback.marketCap,
      epsActual: preferred.epsActual ?? fallback.epsActual,
      epsEstimate: preferred.epsEstimate ?? fallback.epsEstimate,
      epsSurprise: preferred.epsSurprise ?? fallback.epsSurprise,
      epsSurprisePct: preferred.epsSurprisePct ?? fallback.epsSurprisePct,
      revenueActual: preferred.revenueActual ?? fallback.revenueActual,
      revenueEstimate: preferred.revenueEstimate ?? fallback.revenueEstimate,
      revenueSurprise: preferred.revenueSurprise ?? fallback.revenueSurprise,
      revenueSurprisePct: preferred.revenueSurprisePct ?? fallback.revenueSurprisePct,
    });
  }
  return Array.from(byKey.values()).sort((left, right) => {
    if (right.reportDate !== left.reportDate) return right.reportDate.localeCompare(left.reportDate);
    return left.ticker.localeCompare(right.ticker);
  });
}

async function fetchTradingViewPage(payload: TradingViewEarningsSurprisePayload): Promise<TradingViewScanResponse> {
  const response = await fetch(TV_SCAN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "market-command-centre/1.0",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`TradingView earnings surprise request failed (${response.status}): ${body.slice(0, 180)}`);
  }
  return response.json() as Promise<TradingViewScanResponse>;
}

async function fetchTradingViewEarningsSurprises(startDate: string, endDate: string): Promise<EarningsSurpriseEventInput[]> {
  const allRows: EarningsSurpriseEventInput[] = [];
  for (const side of ["positive", "negative"] as const) {
    let offset = 0;
    let totalCount = Number.POSITIVE_INFINITY;
    while (offset < totalCount && offset < TV_MAX_PROVIDER_ROWS) {
      const payload = buildTradingViewEarningsSurprisePayload({ startDate, endDate, side, offset, limit: TV_PAGE_SIZE });
      const page = await fetchTradingViewPage(payload);
      totalCount = Math.min(Number(page.totalCount ?? 0), TV_MAX_PROVIDER_ROWS);
      const rows = parseTradingViewEarningsSurpriseRows(page);
      allRows.push(...rows);
      const pageCount = page.data?.length ?? 0;
      if (pageCount <= 0) break;
      offset += pageCount;
      if (pageCount < TV_PAGE_SIZE) break;
    }
  }
  return dedupeEvents(allRows);
}

function pick(row: Record<string, unknown>, names: string[]): unknown {
  const entries = Object.entries(row);
  for (const name of names) {
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const match = entries.find(([key]) => key.toLowerCase().replace(/[^a-z0-9]/g, "") === normalizedName);
    if (match) return match[1];
  }
  return null;
}

async function fetchJson<T>(url: string, label: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "market-command-centre/1.0" } });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${label} failed (${response.status}): ${body.slice(0, 180)}`);
  }
  return response.json() as Promise<T>;
}

function normalizeProviderEvent(raw: unknown, provider: Exclude<EarningsSurpriseProvider, "tradingview">): EarningsSurpriseEventInput | null {
  const row = raw as Record<string, unknown>;
  const ticker = normalizeTicker(pick(row, ["symbol", "ticker"]));
  const companyName = normalizeText(pick(row, ["name", "companyName"]));
  const reportDate = normalizeDate(pick(row, ["date", "reportDate"]));
  if (!ticker || !reportDate) return null;
  if (isExcludedEarningsIssue({ ticker, sourceSymbol: ticker, companyName, issueType: pick(row, ["type", "securityType", "assetType"]) })) return null;
  const epsActual = parseMaybeNumber(pick(row, ["epsActual", "eps", "actualEarningResult", "actual"]));
  const epsEstimate = parseMaybeNumber(pick(row, ["epsEstimate", "epsEstimated", "estimatedEarning", "estimate"]));
  const epsSurprise = epsActual != null && epsEstimate != null ? epsActual - epsEstimate : parseMaybeNumber(pick(row, ["epsSurprise", "surprise"]));
  const epsSurprisePct = epsActual != null && epsEstimate != null && epsEstimate !== 0
    ? ((epsActual - epsEstimate) / Math.abs(epsEstimate)) * 100
    : parseMaybeNumber(pick(row, ["epsSurprisePercentage", "surprisePercentage", "epsSurprisePercent"]));
  if (epsSurprisePct == null || epsSurprisePct === 0) return null;
  const fiscalPeriodEnd = normalizeDate(pick(row, ["fiscalDateEnding", "fiscalPeriod", "period"]));
  const revenueActual = parseMaybeNumber(pick(row, ["revenueActual", "revenue"]));
  const revenueEstimate = parseMaybeNumber(pick(row, ["revenueEstimate", "revenueEstimated"]));
  return {
    provider,
    sourceSymbol: ticker,
    ticker,
    exchange: normalizeExchange(pick(row, ["exchange"])),
    companyName,
    sector: null,
    industry: null,
    marketCap: null,
    reportDate,
    reportTimestamp: null,
    reportTime: normalizeReportTime(pick(row, ["hour", "time"])),
    fiscalPeriodEnd,
    season: deriveEarningsSeason(fiscalPeriodEnd, reportDate),
    epsActual,
    epsEstimate,
    epsSurprise,
    epsSurprisePct,
    revenueActual,
    revenueEstimate,
    revenueSurprise: revenueActual != null && revenueEstimate != null ? revenueActual - revenueEstimate : parseMaybeNumber(pick(row, ["revenueSurprise"])),
    revenueSurprisePct: revenueActual != null && revenueEstimate != null && revenueEstimate !== 0
      ? ((revenueActual - revenueEstimate) / Math.abs(revenueEstimate)) * 100
      : parseMaybeNumber(pick(row, ["revenueSurprisePercentage", "revenueSurprisePercent"])),
    rawJson: toJson(row),
  };
}

async function fetchFmpBackupEvents(env: Env, startDate: string, endDate: string): Promise<EarningsSurpriseEventInput[] | null> {
  if (!env.FMP_API_KEY) return null;
  const url = `${FMP_EARNINGS_URL}?${new URLSearchParams({ from: startDate, to: endDate, apikey: env.FMP_API_KEY }).toString()}`;
  const rows = await fetchJson<unknown[]>(url, "FMP earnings calendar");
  return dedupeEvents(rows.map((row) => normalizeProviderEvent(row, "fmp")).filter((row): row is EarningsSurpriseEventInput => Boolean(row)));
}

async function fetchFinnhubBackupEvents(env: Env, startDate: string, endDate: string): Promise<EarningsSurpriseEventInput[] | null> {
  if (!env.FINNHUB_API_KEY) return null;
  const url = `${FINNHUB_EARNINGS_URL}?${new URLSearchParams({ from: startDate, to: endDate, token: env.FINNHUB_API_KEY }).toString()}`;
  const json = await fetchJson<{ earningsCalendar?: unknown[] }>(url, "Finnhub earnings calendar");
  return dedupeEvents((json.earningsCalendar ?? []).map((row) => normalizeProviderEvent(row, "finnhub")).filter((row): row is EarningsSurpriseEventInput => Boolean(row)));
}

async function fetchBackupEvents(env: Env, startDate: string, endDate: string): Promise<{
  provider: Exclude<EarningsSurpriseProvider, "tradingview"> | null;
  rows: EarningsSurpriseEventInput[];
  results: EarningsSurpriseSyncResult["providers"];
}> {
  const results: EarningsSurpriseSyncResult["providers"] = [];
  for (const [provider, fetcher] of [
    ["fmp", fetchFmpBackupEvents],
    ["finnhub", fetchFinnhubBackupEvents],
  ] as const) {
    try {
      const rows = await fetcher(env, startDate, endDate);
      if (!rows) {
        results.push({ provider, status: "skipped", rowsSeen: 0, rowsUpserted: 0, error: "API key is not configured." });
        continue;
      }
      results.push({ provider, status: "ok", rowsSeen: rows.length, rowsUpserted: 0, error: null });
      if (rows.length > 0) return { provider, rows, results };
    } catch (error) {
      results.push({ provider, status: "error", rowsSeen: 0, rowsUpserted: 0, error: error instanceof Error ? error.message : "Provider failed." });
    }
  }
  results.push({ provider: "alpha_vantage", status: "skipped", rowsSeen: 0, rowsUpserted: 0, error: "No bulk historical surprise endpoint is configured for this scanner." });
  return { provider: null, rows: [], results };
}

async function recordSync(
  env: Env,
  provider: string,
  input: {
    status: "running" | "ok" | "skipped" | "error";
    mode: EarningsSurpriseSyncMode;
    windowStart: string;
    windowEnd: string;
    startedAt?: string | null;
    successAt?: string | null;
    error?: string | null;
    rowsSeen?: number;
    rowsUpserted?: number;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO earnings_surprise_syncs (
       provider, status, mode, window_start, window_end, last_started_at, last_success_at,
       last_error, rows_seen, rows_upserted, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(provider) DO UPDATE SET
       status = excluded.status,
       mode = excluded.mode,
       window_start = excluded.window_start,
       window_end = excluded.window_end,
       last_started_at = COALESCE(excluded.last_started_at, earnings_surprise_syncs.last_started_at),
       last_success_at = CASE WHEN excluded.status = 'ok' THEN excluded.last_success_at ELSE earnings_surprise_syncs.last_success_at END,
       last_error = excluded.last_error,
       rows_seen = excluded.rows_seen,
       rows_upserted = excluded.rows_upserted,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(
    provider,
    input.status,
    input.mode,
    input.windowStart,
    input.windowEnd,
    input.startedAt ?? null,
    input.successAt ?? null,
    input.error ?? null,
    input.rowsSeen ?? 0,
    input.rowsUpserted ?? 0,
  ).run();
}

async function upsertEvents(env: Env, rows: EarningsSurpriseEventInput[]): Promise<number> {
  const now = new Date().toISOString();
  const statements = rows.map((row) => env.DB.prepare(
    `INSERT INTO earnings_surprise_events (
       id, provider, source_symbol, ticker, exchange, company_name, sector, industry, market_cap,
       report_date, report_timestamp, report_time, fiscal_period_end, season,
       eps_actual, eps_estimate, eps_surprise, eps_surprise_pct,
       revenue_actual, revenue_estimate, revenue_surprise, revenue_surprise_pct,
       raw_json, first_seen_at, last_seen_at, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(ticker, report_date, fiscal_period_end) DO UPDATE SET
       provider = CASE WHEN excluded.provider = 'tradingview' THEN excluded.provider ELSE earnings_surprise_events.provider END,
       source_symbol = COALESCE(excluded.source_symbol, earnings_surprise_events.source_symbol),
       exchange = COALESCE(excluded.exchange, earnings_surprise_events.exchange),
       company_name = COALESCE(excluded.company_name, earnings_surprise_events.company_name),
       sector = COALESCE(excluded.sector, earnings_surprise_events.sector),
       industry = COALESCE(excluded.industry, earnings_surprise_events.industry),
       market_cap = COALESCE(excluded.market_cap, earnings_surprise_events.market_cap),
       report_timestamp = COALESCE(excluded.report_timestamp, earnings_surprise_events.report_timestamp),
       report_time = COALESCE(excluded.report_time, earnings_surprise_events.report_time),
       season = excluded.season,
       eps_actual = COALESCE(excluded.eps_actual, earnings_surprise_events.eps_actual),
       eps_estimate = COALESCE(excluded.eps_estimate, earnings_surprise_events.eps_estimate),
       eps_surprise = COALESCE(excluded.eps_surprise, earnings_surprise_events.eps_surprise),
       eps_surprise_pct = COALESCE(excluded.eps_surprise_pct, earnings_surprise_events.eps_surprise_pct),
       revenue_actual = COALESCE(excluded.revenue_actual, earnings_surprise_events.revenue_actual),
       revenue_estimate = COALESCE(excluded.revenue_estimate, earnings_surprise_events.revenue_estimate),
       revenue_surprise = COALESCE(excluded.revenue_surprise, earnings_surprise_events.revenue_surprise),
       revenue_surprise_pct = COALESCE(excluded.revenue_surprise_pct, earnings_surprise_events.revenue_surprise_pct),
       raw_json = COALESCE(excluded.raw_json, earnings_surprise_events.raw_json),
       last_seen_at = excluded.last_seen_at,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(
    eventId(row),
    row.provider,
    row.sourceSymbol,
    row.ticker,
    row.exchange,
    row.companyName,
    row.sector,
    row.industry,
    row.marketCap,
    row.reportDate,
    row.reportTimestamp,
    row.reportTime,
    row.fiscalPeriodEnd ?? "",
    row.season,
    row.epsActual,
    row.epsEstimate,
    row.epsSurprise,
    row.epsSurprisePct,
    row.revenueActual,
    row.revenueEstimate,
    row.revenueSurprise,
    row.revenueSurprisePct,
    row.rawJson,
    now,
    now,
  ));
  for (let index = 0; index < statements.length; index += SYNC_BATCH_SIZE) {
    const chunk = statements.slice(index, index + SYNC_BATCH_SIZE);
    if (chunk.length > 0) await env.DB.batch(chunk);
  }
  return statements.length;
}

export async function cleanupOldEarningsSurpriseEvents(env: Env, retentionDays = RETENTION_DAYS, now = new Date()): Promise<number> {
  if (!(await hasEarningsSurpriseSchema(env))) return 0;
  const cutoff = isoDateDaysAgo(retentionDays, now);
  const result = await env.DB.prepare(
    "DELETE FROM earnings_surprise_events WHERE report_date < ?",
  ).bind(cutoff).run();
  return Number(result.meta?.changes ?? 0);
}

export async function syncEarningsSurprises(
  env: Env,
  options: { mode?: EarningsSurpriseSyncMode; now?: Date } = {},
): Promise<EarningsSurpriseSyncResult> {
  await requireEarningsSurpriseSchema(env);
  const mode = options.mode ?? "incremental";
  const now = options.now ?? new Date();
  const windowEnd = todayIso(now);
  const windowStart = mode === "backfill"
    ? isoDateDaysAgo(BACKFILL_DAYS, now)
    : isoDateDaysAgo(INCREMENTAL_LOOKBACK_DAYS, now);
  const providers: EarningsSurpriseSyncResult["providers"] = [];
  const startedAt = new Date().toISOString();
  await recordSync(env, PRIMARY_PROVIDER, { status: "running", mode, windowStart, windowEnd, startedAt });

  let rows: EarningsSurpriseEventInput[] = [];
  let provider: EarningsSurpriseProvider | null = PRIMARY_PROVIDER;
  try {
    rows = await filterRowsByEarningsSymbolCatalog(env, await fetchTradingViewEarningsSurprises(windowStart, windowEnd));
    const upserted = rows.length > 0 ? await upsertEvents(env, rows) : 0;
    await recordSync(env, PRIMARY_PROVIDER, {
      status: "ok",
      mode,
      windowStart,
      windowEnd,
      successAt: new Date().toISOString(),
      rowsSeen: rows.length,
      rowsUpserted: upserted,
    });
    providers.push({ provider: PRIMARY_PROVIDER, status: "ok", rowsSeen: rows.length, rowsUpserted: upserted, error: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "TradingView provider failed.";
    await recordSync(env, PRIMARY_PROVIDER, { status: "error", mode, windowStart, windowEnd, error: message });
    providers.push({ provider: PRIMARY_PROVIDER, status: "error", rowsSeen: 0, rowsUpserted: 0, error: message });
    rows = [];
  }

  let rowsUpserted = providers.find((row) => row.provider === PRIMARY_PROVIDER)?.rowsUpserted ?? 0;
  if (rows.length === 0) {
    const backup = await fetchBackupEvents(env, windowStart, windowEnd);
    providers.push(...backup.results);
    provider = backup.provider;
    if (backup.rows.length > 0 && backup.provider) {
      rows = await filterRowsByEarningsSymbolCatalog(env, backup.rows);
      rowsUpserted = await upsertEvents(env, rows);
      await recordSync(env, backup.provider, {
        status: "ok",
        mode,
        windowStart,
        windowEnd,
        successAt: new Date().toISOString(),
        rowsSeen: backup.rows.length,
        rowsUpserted,
      });
      const providerResult = providers.find((row) => row.provider === backup.provider);
      if (providerResult) providerResult.rowsUpserted = rowsUpserted;
    }
  }

  await cleanupOldEarningsSurpriseEvents(env, RETENTION_DAYS, now);
  return {
    ok: rows.length > 0,
    mode,
    windowStart,
    windowEnd,
    provider,
    providers,
    rowsSeen: rows.length,
    rowsUpserted,
    warning: rows.length === 0 ? "No earnings surprise rows were returned by the configured providers." : null,
  };
}

function normalizeArrayFilter(value: string | string[] | null | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildWhereClause(query: EarningsSurprisesQuery, options: { includeCatalog?: boolean } = {}): { sql: string; args: unknown[] } {
  const clauses = ["report_date >= ?", earningsEligibleSecuritySql("earnings_surprise_events", { includeCatalog: options.includeCatalog })];
  const args: unknown[] = [query.startDate ? normalizeDate(query.startDate) ?? isoDateDaysAgo(RETENTION_DAYS) : isoDateDaysAgo(RETENTION_DAYS)];
  if (query.endDate && normalizeDate(query.endDate)) {
    clauses.push("report_date <= ?");
    args.push(normalizeDate(query.endDate));
  }
  const q = String(query.q ?? "").trim();
  if (q) {
    clauses.push("(ticker LIKE ? OR company_name LIKE ? COLLATE NOCASE)");
    args.push(`${q.toUpperCase()}%`, `%${q}%`);
  }
  if (query.season) {
    clauses.push("season = ?");
    args.push(query.season);
  }
  if (query.minMarketCap != null && Number.isFinite(query.minMarketCap)) {
    clauses.push("market_cap >= ?");
    args.push(query.minMarketCap);
  }
  if (query.maxMarketCap != null && Number.isFinite(query.maxMarketCap)) {
    clauses.push("market_cap <= ?");
    args.push(query.maxMarketCap);
  }
  if (query.minEpsSurprisePct != null && Number.isFinite(query.minEpsSurprisePct)) {
    clauses.push("eps_surprise_pct >= ?");
    args.push(query.minEpsSurprisePct);
  }
  const sectors = normalizeArrayFilter(query.sector);
  if (sectors.length > 0) {
    clauses.push(`sector IN (${sectors.map(() => "?").join(",")})`);
    args.push(...sectors);
  }
  const industries = normalizeArrayFilter(query.industry);
  if (industries.length > 0) {
    clauses.push(`industry IN (${industries.map(() => "?").join(",")})`);
    args.push(...industries);
  }
  const exchanges = normalizeArrayFilter(query.exchange).map((value) => value.toUpperCase());
  if (exchanges.length > 0) {
    clauses.push(`UPPER(exchange) IN (${exchanges.map(() => "?").join(",")})`);
    args.push(...exchanges);
  } else if (!query.includeOtc) {
    clauses.push(earningsMajorUsExchangeSql());
  }
  if (query.surpriseSide === "positive") clauses.push("eps_surprise_pct > 0");
  if (query.surpriseSide === "negative") clauses.push("eps_surprise_pct < 0");
  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    args,
  };
}

function mapRow(row: Record<string, unknown>): EarningsSurpriseRow {
  return {
    id: String(row.id ?? ""),
    provider: String(row.provider ?? ""),
    sourceSymbol: String(row.sourceSymbol ?? row.source_symbol ?? ""),
    ticker: String(row.ticker ?? ""),
    exchange: row.exchange == null ? null : String(row.exchange),
    companyName: row.companyName == null ? null : String(row.companyName),
    sector: row.sector == null ? null : String(row.sector),
    industry: row.industry == null ? null : String(row.industry),
    marketCap: parseMaybeNumber(row.marketCap),
    reportDate: String(row.reportDate ?? ""),
    reportTimestamp: parseMaybeNumber(row.reportTimestamp),
    reportTime: row.reportTime == null ? null : String(row.reportTime),
    fiscalPeriodEnd: row.fiscalPeriodEnd == null || row.fiscalPeriodEnd === "" ? null : String(row.fiscalPeriodEnd),
    season: String(row.season ?? ""),
    epsActual: parseMaybeNumber(row.epsActual),
    epsEstimate: parseMaybeNumber(row.epsEstimate),
    epsSurprise: parseMaybeNumber(row.epsSurprise),
    epsSurprisePct: parseMaybeNumber(row.epsSurprisePct),
    revenueActual: parseMaybeNumber(row.revenueActual),
    revenueEstimate: parseMaybeNumber(row.revenueEstimate),
    revenueSurprise: parseMaybeNumber(row.revenueSurprise),
    revenueSurprisePct: parseMaybeNumber(row.revenueSurprisePct),
    firstSeenAt: row.firstSeenAt == null ? null : String(row.firstSeenAt),
    lastSeenAt: row.lastSeenAt == null ? null : String(row.lastSeenAt),
  };
}

async function loadFacet(env: Env, field: "season" | "sector" | "industry" | "exchange", whereSql: string, args: unknown[]): Promise<Array<{ value: string; count: number }>> {
  const rows = await env.DB.prepare(
    `SELECT ${field} as value, COUNT(*) as count
     FROM earnings_surprise_events
     ${whereSql}
       ${whereSql ? "AND" : "WHERE"} ${field} IS NOT NULL AND ${field} <> ''
     GROUP BY ${field}
     ORDER BY count DESC, value ASC
     LIMIT 80`,
  ).bind(...args).all<{ value: string; count: number }>();
  return (rows.results ?? []).map((row) => ({ value: row.value, count: Number(row.count ?? 0) }));
}

export async function queryEarningsSurprises(env: Env, query: EarningsSurprisesQuery = {}): Promise<EarningsSurprisesResponse> {
  if (!(await hasEarningsSurpriseSchema(env))) {
    return {
      schemaReady: false,
      warning: "Earnings surprise schema is missing. Apply worker/migrations/0051_earnings_surprises.sql.",
      generatedAt: new Date().toISOString(),
      total: 0,
      limit: DEFAULT_QUERY_LIMIT,
      offset: 0,
      rows: [],
      facets: { seasons: [], sectors: [], industries: [], exchanges: [] },
    };
  }
  const limit = normalizeEarningsQueryLimit(query.limit, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
  const offset = normalizeEarningsQueryOffset(query.offset, query.limit);
  const sortColumn = SORT_COLUMNS[String(query.sort ?? "epsSurprisePct")] ?? SORT_COLUMNS.epsSurprisePct;
  const sortDir = query.sortDir === "asc" ? "asc" : "desc";
  const { sql: whereSql, args } = buildWhereClause(query, { includeCatalog: await canUseEarningsSymbolCatalog(env) });
  const count = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM earnings_surprise_events ${whereSql}`,
  ).bind(...args).first<{ count: number }>();
  const rows = await env.DB.prepare(
    `SELECT
       id, provider, source_symbol as sourceSymbol, ticker, exchange, company_name as companyName,
       sector, industry, market_cap as marketCap, report_date as reportDate,
       report_timestamp as reportTimestamp, report_time as reportTime,
       fiscal_period_end as fiscalPeriodEnd, season,
       eps_actual as epsActual, eps_estimate as epsEstimate, eps_surprise as epsSurprise,
       eps_surprise_pct as epsSurprisePct, revenue_actual as revenueActual,
       revenue_estimate as revenueEstimate, revenue_surprise as revenueSurprise,
       revenue_surprise_pct as revenueSurprisePct, first_seen_at as firstSeenAt,
       last_seen_at as lastSeenAt
     FROM earnings_surprise_events
     ${whereSql}
     ORDER BY ${sortColumn} ${sortDir.toUpperCase()}, ticker ASC
     LIMIT ? OFFSET ?`,
  ).bind(...args, limit, offset).all<Record<string, unknown>>();
  const [seasons, sectors, industries, exchanges] = await Promise.all([
    loadFacet(env, "season", whereSql, args),
    loadFacet(env, "sector", whereSql, args),
    loadFacet(env, "industry", whereSql, args),
    loadFacet(env, "exchange", whereSql, args),
  ]);
  return {
    schemaReady: true,
    warning: null,
    generatedAt: new Date().toISOString(),
    total: Number(count?.count ?? 0),
    limit,
    offset,
    rows: (rows.results ?? []).map(mapRow),
    facets: { seasons, sectors, industries, exchanges },
  };
}

export async function exportEarningsSurpriseTickers(env: Env, query: EarningsSurprisesQuery = {}): Promise<string[]> {
  if (!(await hasEarningsSurpriseSchema(env))) return [];
  const limit = normalizeEarningsQueryLimit(query.limit, DEFAULT_QUERY_LIMIT, EXPORT_MAX_LIMIT);
  const sortColumn = SORT_COLUMNS[String(query.sort ?? "epsSurprisePct")] ?? SORT_COLUMNS.epsSurprisePct;
  const sortDir = query.sortDir === "asc" ? "asc" : "desc";
  const { sql: whereSql, args } = buildWhereClause(query, { includeCatalog: await canUseEarningsSymbolCatalog(env) });
  const rows = await env.DB.prepare(
    `SELECT ticker
     FROM earnings_surprise_events
     ${whereSql}
     ORDER BY ${sortColumn} ${sortDir.toUpperCase()}, ticker ASC
     LIMIT ?`,
  ).bind(...args, limit).all<{ ticker: string }>();
  return (rows.results ?? []).map((row) => String(row.ticker ?? "").trim()).filter(Boolean);
}

export async function loadEarningsSurprisesStatus(env: Env): Promise<EarningsSurprisesStatus> {
  if (!(await hasEarningsSurpriseSchema(env))) {
    return {
      schemaReady: false,
      warning: "Earnings surprise schema is missing. Apply worker/migrations/0051_earnings_surprises.sql.",
      counts: { total: 0, positive: 0, negative: 0, latestReportDate: null, earliestReportDate: null },
      syncs: [],
      latestRows: [],
    };
  }
  const includeCatalog = await canUseEarningsSymbolCatalog(env);
  const defaultEligibilitySql = earningsDefaultEligibleListedEquitySql("earnings_surprise_events", { includeCatalog });
  const [counts, syncs, latest] = await Promise.all([
    env.DB.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN eps_surprise_pct > 0 THEN 1 ELSE 0 END) as positive,
         SUM(CASE WHEN eps_surprise_pct < 0 THEN 1 ELSE 0 END) as negative,
         MAX(report_date) as latestReportDate,
         MIN(report_date) as earliestReportDate
       FROM earnings_surprise_events
       WHERE ${defaultEligibilitySql}`,
    ).first<{ total: number; positive: number | null; negative: number | null; latestReportDate: string | null; earliestReportDate: string | null }>(),
    env.DB.prepare(
      `SELECT provider, status, mode, window_start as windowStart, window_end as windowEnd,
        last_started_at as lastStartedAt, last_success_at as lastSuccessAt,
        last_error as lastError, rows_seen as rowsSeen, rows_upserted as rowsUpserted,
        updated_at as updatedAt
       FROM earnings_surprise_syncs
       ORDER BY updated_at DESC`,
    ).all<EarningsSurprisesStatus["syncs"][number]>(),
    queryEarningsSurprises(env, { limit: 12, offset: 0, includeOtc: false, sort: "reportDate", sortDir: "desc" }),
  ]);
  return {
    schemaReady: true,
    warning: null,
    counts: {
      total: Number(counts?.total ?? 0),
      positive: Number(counts?.positive ?? 0),
      negative: Number(counts?.negative ?? 0),
      latestReportDate: counts?.latestReportDate ?? null,
      earliestReportDate: counts?.earliestReportDate ?? null,
    },
    syncs: syncs.results ?? [],
    latestRows: latest.rows,
  };
}

function newYorkParts(now: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour") || 0),
  };
}

export async function maybeRunScheduledEarningsSurpriseSync(env: Env, now = new Date()): Promise<EarningsSurpriseSyncResult | null> {
  if (!(await hasEarningsSurpriseSchema(env))) return null;
  const ny = newYorkParts(now);
  if (!(ny.hour >= 21 || ny.hour <= 5)) return null;
  const latest = await env.DB.prepare(
    "SELECT last_success_at as lastSuccessAt FROM earnings_surprise_syncs WHERE provider = ? AND status = 'ok' LIMIT 1",
  ).bind(PRIMARY_PROVIDER).first<{ lastSuccessAt: string | null }>();
  const lastSuccessTime = latest?.lastSuccessAt ? Date.parse(latest.lastSuccessAt) : 0;
  if (Number.isFinite(lastSuccessTime) && now.getTime() - lastSuccessTime < 20 * 60 * 60_000) return null;
  return syncEarningsSurprises(env, { mode: "incremental", now });
}
