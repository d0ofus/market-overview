import { zonedParts } from "./refresh-timing";
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
const BACKFILL_DAYS = 90;
const BACKFILL_BATCH_DAYS = 7;
const INCREMENTAL_LOOKBACK_DAYS = 7;
const RETENTION_DAYS = 90;
const TV_PAGE_SIZE = 500;
const TV_MAX_PROVIDER_ROWS = 10_000;
const SYNC_BATCH_SIZE = 80;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 250;
const EXPORT_MAX_LIMIT = 1000;
const DAILY_SCAN_MINUTES_ET = 20 * 60;

type EarningsGapSyncMode = "incremental" | "backfill";
export type EarningsGapSource = "postmarket" | "regular_open" | "both";

type TradingViewFilter = {
  left: string;
  operation: string;
  right: number | string | boolean | Array<number | string | boolean>;
};

export type TradingViewEarningsGapPayload = {
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

export type EarningsGapReleaseInput = {
  provider: string;
  sourceSymbol: string;
  ticker: string;
  exchange: string | null;
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  price: number | null;
  avgVolume30d: number | null;
  avgDollarVolume30d: number | null;
  reportDate: string;
  season: string;
  reportTimestamp: number | null;
  reportTime: string | null;
  postmarketPrice: number | null;
  postmarketVolume: number | null;
  rawJson: string | null;
};

export type EarningsGapEventInput = EarningsGapReleaseInput & {
  reactionDate: string | null;
  previousClose: number | null;
  reactionOpen: number | null;
  regularOpenGapPct: number | null;
  postmarketGapPct: number | null;
  qualifyingGapPct: number;
  gapSource: EarningsGapSource;
};

export type EarningsGapRow = {
  id: string;
  provider: string;
  sourceSymbol: string;
  ticker: string;
  exchange: string | null;
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  price: number | null;
  avgVolume30d: number | null;
  avgDollarVolume30d: number | null;
  reportDate: string;
  season: string;
  reportTimestamp: number | null;
  reportTime: string | null;
  reactionDate: string | null;
  previousClose: number | null;
  reactionOpen: number | null;
  regularOpenGapPct: number | null;
  postmarketPrice: number | null;
  postmarketGapPct: number | null;
  postmarketVolume: number | null;
  qualifyingGapPct: number;
  gapSource: EarningsGapSource;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

export type EarningsGapsQuery = {
  limit?: number | null;
  offset?: number | null;
  q?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  season?: string | string[] | null;
  minMarketCap?: number | null;
  maxMarketCap?: number | null;
  minAvgDollarVolume?: number | null;
  minGapPct?: number | null;
  sector?: string | string[] | null;
  industry?: string | string[] | null;
  exchange?: string | string[] | null;
  includeOtc?: boolean | null;
  sort?: string | null;
  sortDir?: "asc" | "desc" | null;
};

export type EarningsGapsResponse = {
  schemaReady: boolean;
  warning: string | null;
  generatedAt: string;
  total: number;
  limit: number;
  offset: number;
  rows: EarningsGapRow[];
  facets: {
    seasons: Array<{ value: string; count: number }>;
    sectors: Array<{ value: string; count: number }>;
    industries: Array<{ value: string; count: number }>;
    exchanges: Array<{ value: string; count: number }>;
    gapSources: Array<{ value: string; count: number }>;
  };
};

export type EarningsGapSyncResult = {
  ok: boolean;
  mode: EarningsGapSyncMode;
  windowStart: string;
  windowEnd: string;
  batchWindowStart: string;
  batchWindowEnd: string;
  totalWindowStart: string;
  totalWindowEnd: string;
  nextCursor: string | null;
  done: boolean;
  provider: string;
  rowsSeen: number;
  rowsUpserted: number;
  scheduledLocalDate: string | null;
  warning: string | null;
};

export type EarningsGapsStatus = {
  schemaReady: boolean;
  warning: string | null;
  counts: {
    total: number;
    postmarket: number;
    regularOpen: number;
    both: number;
    latestReportDate: string | null;
    earliestReportDate: string | null;
  };
  syncs: Array<{
    id: string;
    provider: string;
    status: string;
    mode: string | null;
    scheduledLocalDate: string | null;
    windowStart: string | null;
    windowEnd: string | null;
    lastStartedAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    rowsSeen: number | null;
    rowsUpserted: number | null;
    updatedAt: string | null;
  }>;
  latestRows: EarningsGapRow[];
};

type DailyBar = {
  ticker: string;
  date: string;
  o: number;
  c: number;
};

const TV_COLUMNS = [
  "description",
  "name",
  "exchange",
  "type",
  "sector",
  "industry",
  "market_cap_basic",
  "close",
  "average_volume_30d_calc",
  "AvgValue.Traded_30d",
  "earnings_release_date",
  "earnings_release_time",
  "earnings_release_calendar_date",
  "postmarket_close",
  "postmarket_change",
  "postmarket_change_abs",
  "postmarket_volume",
];

const SORT_COLUMNS: Record<string, string> = {
  reportDate: "report_date",
  ticker: "ticker",
  companyName: "company_name",
  season: "season",
  marketCap: "market_cap",
  avgDollarVolume30d: "avg_dollar_volume_30d",
  regularOpenGapPct: "regular_open_gap_pct",
  postmarketGapPct: "postmarket_gap_pct",
  qualifyingGapPct: "qualifying_gap_pct",
  gapSource: "gap_source",
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
  if (!text) return null;
  return text.toUpperCase();
}

function normalizeDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function parseMaybeNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.replace(/,/g, "").trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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

function addDaysIso(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function minDateIso(left: string, right: string): string {
  return left <= right ? left : right;
}

function maxDateIso(left: string, right: string): string {
  return left >= right ? left : right;
}

function isoDateDaysAgo(days: number, now = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
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

function deriveEarningsGapSeason(reportDate: string): string {
  return seasonForDate(reportDate);
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
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function simpleHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function eventId(row: { ticker: string; reportDate: string }): string {
  return `earnings-gap-${row.ticker}-${row.reportDate}-${simpleHash(row.ticker)}`;
}

function pctChange(next: number | null, previous: number | null): number | null {
  if (next == null || previous == null || !Number.isFinite(next) || !Number.isFinite(previous) || previous === 0) return null;
  return ((next - previous) / Math.abs(previous)) * 100;
}

async function tableExists(env: Env, tableName: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).bind(tableName).first<{ count: number }>();
  return Number(row?.count ?? 0) > 0;
}

async function columnExists(env: Env, tableName: string, columnName: string): Promise<boolean> {
  const safeTable = tableName === "earnings_gap_events" ? "earnings_gap_events" : tableName;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM pragma_table_info('${safeTable}') WHERE name = ?`,
  ).bind(columnName).first<{ count: number }>();
  return Number(row?.count ?? 0) > 0;
}

async function earningsGapSchemaWarning(env: Env): Promise<string | null> {
  const [events, syncs] = await Promise.all([
    tableExists(env, "earnings_gap_events"),
    tableExists(env, "earnings_gap_syncs"),
  ]);
  if (!events || !syncs) {
    return "Earnings gap schema is missing. Apply worker/migrations/0052_earnings_gaps.sql.";
  }
  if (!(await columnExists(env, "earnings_gap_events", "season"))) {
    return "Earnings gap season schema is missing. Apply worker/migrations/0054_earnings_gap_season.sql.";
  }
  return null;
}

async function hasEarningsGapSchema(env: Env): Promise<boolean> {
  return (await earningsGapSchemaWarning(env)) == null;
}

async function requireEarningsGapSchema(env: Env): Promise<void> {
  const warning = await earningsGapSchemaWarning(env);
  if (warning) throw new Error(warning);
}

export function buildTradingViewEarningsGapPayload(input: {
  startDate: string;
  endDate: string;
  offset?: number;
  limit?: number;
}): TradingViewEarningsGapPayload {
  const offset = Math.max(0, Number(input.offset ?? 0));
  const limit = Math.max(1, Math.min(TV_PAGE_SIZE, Number(input.limit ?? TV_PAGE_SIZE)));
  return {
    markets: ["america"],
    symbols: { query: { types: ["stock"] }, tickers: [] },
    options: { lang: "en" },
    columns: TV_COLUMNS,
    sort: { sortBy: "earnings_release_date", sortOrder: "desc" },
    range: [offset, offset + limit],
    filter: [
      { left: "earnings_release_date", operation: "in_range", right: [dateToUnixStart(input.startDate), dateToUnixEnd(input.endDate)] },
    ],
  };
}

export function parseTradingViewEarningsGapRows(response: TradingViewScanResponse): EarningsGapReleaseInput[] {
  return (response.data ?? [])
    .map((entry) => {
      const data = Array.isArray(entry.d) ? entry.d : [];
      const sourceSymbol = String(entry.s ?? "").trim().toUpperCase();
      const ticker = parseTradingViewTicker(sourceSymbol);
      const companyName = normalizeText(data[0]) ?? normalizeText(data[1]);
      const issueType = normalizeText(data[3]);
      const reportTimestamp = parseMaybeNumber(data[10]);
      const reportDate = timestampToNewYorkDate(reportTimestamp) ?? normalizeDate(data[12]);
      if (!ticker || !reportDate) return null;
      if (isExcludedEarningsIssue({ ticker, sourceSymbol, companyName, issueType })) return null;
      const price = parseMaybeNumber(data[7]);
      const avgVolume30d = parseMaybeNumber(data[8]);
      const avgDollarVolume30d = parseMaybeNumber(data[9]) ?? (
        price != null && avgVolume30d != null ? price * avgVolume30d : null
      );
      return {
        provider: PRIMARY_PROVIDER,
        sourceSymbol,
        ticker,
        exchange: normalizeExchange(data[2]),
        companyName,
        sector: normalizeText(data[4]),
        industry: normalizeText(data[5]),
        marketCap: parseMaybeNumber(data[6]),
        price,
        avgVolume30d,
        avgDollarVolume30d,
        reportDate,
        season: deriveEarningsGapSeason(reportDate),
        reportTimestamp,
        reportTime: normalizeReportTime(data[11]),
        postmarketPrice: parseMaybeNumber(data[13]),
        postmarketVolume: parseMaybeNumber(data[16]),
        rawJson: toJson(entry),
      } satisfies EarningsGapReleaseInput;
    })
    .filter((row): row is EarningsGapReleaseInput => Boolean(row));
}

function dedupeReleases(rows: EarningsGapReleaseInput[]): EarningsGapReleaseInput[] {
  const byKey = new Map<string, EarningsGapReleaseInput>();
  for (const row of rows) {
    const existing = byKey.get(`${row.ticker}|${row.reportDate}`);
    if (!existing) {
      byKey.set(`${row.ticker}|${row.reportDate}`, row);
      continue;
    }
    byKey.set(`${row.ticker}|${row.reportDate}`, {
      ...existing,
      exchange: existing.exchange ?? row.exchange,
      companyName: existing.companyName ?? row.companyName,
      sector: existing.sector ?? row.sector,
      industry: existing.industry ?? row.industry,
      marketCap: existing.marketCap ?? row.marketCap,
      price: existing.price ?? row.price,
      avgVolume30d: existing.avgVolume30d ?? row.avgVolume30d,
      avgDollarVolume30d: existing.avgDollarVolume30d ?? row.avgDollarVolume30d,
      season: existing.season || row.season,
      reportTimestamp: existing.reportTimestamp ?? row.reportTimestamp,
      reportTime: existing.reportTime ?? row.reportTime,
      postmarketPrice: existing.postmarketPrice ?? row.postmarketPrice,
      postmarketVolume: existing.postmarketVolume ?? row.postmarketVolume,
      rawJson: existing.rawJson ?? row.rawJson,
    });
  }
  return Array.from(byKey.values()).sort((left, right) => {
    if (right.reportDate !== left.reportDate) return right.reportDate.localeCompare(left.reportDate);
    return left.ticker.localeCompare(right.ticker);
  });
}

async function fetchTradingViewPage(payload: TradingViewEarningsGapPayload): Promise<TradingViewScanResponse> {
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
    throw new Error(`TradingView earnings gap request failed (${response.status}): ${body.slice(0, 180)}`);
  }
  return response.json() as Promise<TradingViewScanResponse>;
}

async function fetchTradingViewEarningsReleases(startDate: string, endDate: string): Promise<EarningsGapReleaseInput[]> {
  const allRows: EarningsGapReleaseInput[] = [];
  let offset = 0;
  let totalCount = Number.POSITIVE_INFINITY;
  while (offset < totalCount && offset < TV_MAX_PROVIDER_ROWS) {
    const payload = buildTradingViewEarningsGapPayload({ startDate, endDate, offset, limit: TV_PAGE_SIZE });
    const page = await fetchTradingViewPage(payload);
    totalCount = Math.min(Number(page.totalCount ?? 0), TV_MAX_PROVIDER_ROWS);
    allRows.push(...parseTradingViewEarningsGapRows(page));
    const pageCount = page.data?.length ?? 0;
    if (pageCount <= 0) break;
    offset += pageCount;
    if (pageCount < TV_PAGE_SIZE) break;
  }
  return dedupeReleases(allRows);
}

async function loadDailyBarsByTicker(
  env: Env,
  tickers: string[],
  startDate: string,
  endDate: string,
): Promise<Map<string, DailyBar[]>> {
  const uniqueTickers = Array.from(new Set(tickers.map(normalizeTicker).filter(Boolean)));
  const byTicker = new Map<string, DailyBar[]>();
  for (let index = 0; index < uniqueTickers.length; index += 80) {
    const chunk = uniqueTickers.slice(index, index + 80);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT ticker, date, o, c
       FROM daily_bars
       WHERE ticker IN (${placeholders}) AND date >= ? AND date <= ?
       ORDER BY ticker ASC, date ASC`,
    ).bind(...chunk, startDate, endDate).all<DailyBar>();
    for (const row of rows.results ?? []) {
      const ticker = normalizeTicker(row.ticker);
      const current = byTicker.get(ticker) ?? [];
      current.push({
        ticker,
        date: String(row.date),
        o: Number(row.o),
        c: Number(row.c),
      });
      byTicker.set(ticker, current);
    }
  }
  return byTicker;
}

function findRegularOpenGap(release: EarningsGapReleaseInput, bars: DailyBar[]): {
  reactionDate: string | null;
  previousClose: number | null;
  reactionOpen: number | null;
  regularOpenGapPct: number | null;
} {
  const strictAfterReportDate = release.reportTime === "after-market";
  const reactionBar = bars.find((bar) => strictAfterReportDate ? bar.date > release.reportDate : bar.date >= release.reportDate) ?? null;
  if (!reactionBar) {
    return { reactionDate: null, previousClose: null, reactionOpen: null, regularOpenGapPct: null };
  }
  const previousBar = [...bars].reverse().find((bar) => bar.date < reactionBar.date) ?? null;
  const previousClose = previousBar?.c ?? null;
  const reactionOpen = Number.isFinite(reactionBar.o) ? reactionBar.o : null;
  return {
    reactionDate: reactionBar.date,
    previousClose,
    reactionOpen,
    regularOpenGapPct: pctChange(reactionOpen, previousClose),
  };
}

export async function computeEarningsGapEvents(
  env: Env,
  releases: EarningsGapReleaseInput[],
  now = new Date(),
): Promise<EarningsGapEventInput[]> {
  const ny = zonedParts(now, "America/New_York");
  const normalized = dedupeReleases(releases);
  if (normalized.length === 0) return [];
  const minDate = normalized.map((row) => row.reportDate).sort()[0] ?? todayIso(now);
  const maxDate = normalized.map((row) => row.reportDate).sort().at(-1) ?? todayIso(now);
  const barsByTicker = await loadDailyBarsByTicker(env, normalized.map((row) => row.ticker), addDaysIso(minDate, -14), addDaysIso(maxDate, 14));
  return normalized
    .map((release) => {
      const regular = findRegularOpenGap(release, barsByTicker.get(release.ticker) ?? []);
      const postmarketGapPct = release.reportDate === ny.localDate
        ? pctChange(release.postmarketPrice, release.price)
        : null;
      const postmarketQualifies = postmarketGapPct != null && postmarketGapPct > 0;
      const regularQualifies = regular.regularOpenGapPct != null && regular.regularOpenGapPct > 0;
      if (!postmarketQualifies && !regularQualifies) return null;
      const qualifyingGapPct = Math.max(
        postmarketQualifies ? postmarketGapPct : Number.NEGATIVE_INFINITY,
        regularQualifies ? regular.regularOpenGapPct ?? Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY,
      );
      const gapSource: EarningsGapSource = postmarketQualifies && regularQualifies
        ? "both"
        : postmarketQualifies
          ? "postmarket"
          : "regular_open";
      return {
        ...release,
        ...regular,
        postmarketGapPct,
        qualifyingGapPct,
        gapSource,
      } satisfies EarningsGapEventInput;
    })
    .filter((row): row is EarningsGapEventInput => Boolean(row));
}

async function recordSyncStart(
  env: Env,
  id: string,
  input: {
    mode: EarningsGapSyncMode;
    scheduledLocalDate?: string | null;
    windowStart: string;
    windowEnd: string;
    startedAt: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO earnings_gap_syncs (
       id, provider, status, mode, scheduled_local_date, window_start, window_end,
       last_started_at, last_success_at, last_error, rows_seen, rows_upserted, updated_at
     )
     VALUES (?, ?, 'running', ?, ?, ?, ?, ?, NULL, NULL, 0, 0, CURRENT_TIMESTAMP)`,
  ).bind(
    id,
    PRIMARY_PROVIDER,
    input.mode,
    input.scheduledLocalDate ?? null,
    input.windowStart,
    input.windowEnd,
    input.startedAt,
  ).run();
}

async function recordSyncDone(
  env: Env,
  id: string,
  input: {
    status: "ok" | "error";
    successAt?: string | null;
    error?: string | null;
    rowsSeen?: number;
    rowsUpserted?: number;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE earnings_gap_syncs
     SET status = ?,
         last_success_at = CASE WHEN ? = 'ok' THEN ? ELSE last_success_at END,
         last_error = ?,
         rows_seen = ?,
         rows_upserted = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(
    input.status,
    input.status,
    input.successAt ?? null,
    input.error ?? null,
    input.rowsSeen ?? 0,
    input.rowsUpserted ?? 0,
    id,
  ).run();
}

async function upsertEvents(env: Env, rows: EarningsGapEventInput[]): Promise<number> {
  const now = new Date().toISOString();
  const statements = rows.map((row) => env.DB.prepare(
    `INSERT INTO earnings_gap_events (
       id, provider, source_symbol, ticker, exchange, company_name, sector, industry,
       market_cap, price, avg_volume_30d, avg_dollar_volume_30d,
       report_date, season, report_timestamp, report_time, reaction_date, previous_close,
       reaction_open, regular_open_gap_pct, postmarket_price, postmarket_gap_pct,
       postmarket_volume, qualifying_gap_pct, gap_source, raw_json,
       first_seen_at, last_seen_at, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(ticker, report_date) DO UPDATE SET
       provider = excluded.provider,
       source_symbol = COALESCE(excluded.source_symbol, earnings_gap_events.source_symbol),
       exchange = COALESCE(excluded.exchange, earnings_gap_events.exchange),
       company_name = COALESCE(excluded.company_name, earnings_gap_events.company_name),
       sector = COALESCE(excluded.sector, earnings_gap_events.sector),
       industry = COALESCE(excluded.industry, earnings_gap_events.industry),
       market_cap = COALESCE(excluded.market_cap, earnings_gap_events.market_cap),
       price = COALESCE(excluded.price, earnings_gap_events.price),
       avg_volume_30d = COALESCE(excluded.avg_volume_30d, earnings_gap_events.avg_volume_30d),
       avg_dollar_volume_30d = COALESCE(excluded.avg_dollar_volume_30d, earnings_gap_events.avg_dollar_volume_30d),
       season = COALESCE(excluded.season, earnings_gap_events.season),
       report_timestamp = COALESCE(excluded.report_timestamp, earnings_gap_events.report_timestamp),
       report_time = COALESCE(excluded.report_time, earnings_gap_events.report_time),
       reaction_date = COALESCE(excluded.reaction_date, earnings_gap_events.reaction_date),
       previous_close = COALESCE(excluded.previous_close, earnings_gap_events.previous_close),
       reaction_open = COALESCE(excluded.reaction_open, earnings_gap_events.reaction_open),
       regular_open_gap_pct = COALESCE(excluded.regular_open_gap_pct, earnings_gap_events.regular_open_gap_pct),
       postmarket_price = COALESCE(excluded.postmarket_price, earnings_gap_events.postmarket_price),
       postmarket_gap_pct = COALESCE(excluded.postmarket_gap_pct, earnings_gap_events.postmarket_gap_pct),
       postmarket_volume = COALESCE(excluded.postmarket_volume, earnings_gap_events.postmarket_volume),
       qualifying_gap_pct = excluded.qualifying_gap_pct,
       gap_source = excluded.gap_source,
       raw_json = COALESCE(excluded.raw_json, earnings_gap_events.raw_json),
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
    row.price,
    row.avgVolume30d,
    row.avgDollarVolume30d,
    row.reportDate,
    row.season,
    row.reportTimestamp,
    row.reportTime,
    row.reactionDate,
    row.previousClose,
    row.reactionOpen,
    row.regularOpenGapPct,
    row.postmarketPrice,
    row.postmarketGapPct,
    row.postmarketVolume,
    row.qualifyingGapPct,
    row.gapSource,
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

export async function cleanupOldEarningsGapEvents(env: Env, retentionDays = RETENTION_DAYS, now = new Date()): Promise<number> {
  if (!(await hasEarningsGapSchema(env))) return 0;
  const cutoff = isoDateDaysAgo(retentionDays, now);
  const result = await env.DB.prepare(
    "DELETE FROM earnings_gap_events WHERE report_date < ?",
  ).bind(cutoff).run();
  return Number(result.meta?.changes ?? 0);
}

export async function syncEarningsGaps(
  env: Env,
  options: {
    mode?: EarningsGapSyncMode;
    now?: Date;
    scheduledLocalDate?: string | null;
    cursor?: string | null;
    windowStart?: string | null;
    windowEnd?: string | null;
  } = {},
): Promise<EarningsGapSyncResult> {
  await requireEarningsGapSchema(env);
  const mode = options.mode ?? "incremental";
  const now = options.now ?? new Date();
  const nyWindowEnd = zonedParts(now, "America/New_York").localDate;
  const incrementalWindowStart = isoDateDaysAgo(INCREMENTAL_LOOKBACK_DAYS, now);
  const requestedWindowEnd = normalizeDate(options.windowEnd) ?? nyWindowEnd;
  const totalWindowEnd = minDateIso(requestedWindowEnd, nyWindowEnd);
  const earliestAllowedBackfillStart = addDaysIso(totalWindowEnd, -(BACKFILL_DAYS - 1));
  const requestedWindowStart = normalizeDate(options.windowStart) ?? earliestAllowedBackfillStart;
  if (mode === "backfill" && requestedWindowStart > totalWindowEnd) {
    throw new Error("Earnings gap backfill start date cannot be after the end date.");
  }
  const totalWindowStart = mode === "backfill"
    ? maxDateIso(requestedWindowStart, earliestAllowedBackfillStart)
    : incrementalWindowStart;
  const totalWindowEndResolved = mode === "backfill" ? totalWindowEnd : nyWindowEnd;
  const cursorDate = normalizeDate(options.cursor);
  const backfillCursorStart = minDateIso(maxDateIso(cursorDate ?? totalWindowStart, totalWindowStart), totalWindowEndResolved);
  const batchWindowStart = mode === "backfill"
    ? backfillCursorStart
    : totalWindowStart;
  const batchWindowEnd = mode === "backfill"
    ? minDateIso(addDaysIso(batchWindowStart, BACKFILL_BATCH_DAYS - 1), totalWindowEndResolved)
    : totalWindowEndResolved;
  const nextCursor = mode === "backfill" && batchWindowEnd < totalWindowEndResolved
    ? addDaysIso(batchWindowEnd, 1)
    : null;
  const done = nextCursor == null;
  const windowStart = batchWindowStart;
  const windowEnd = batchWindowEnd;
  const syncId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await recordSyncStart(env, syncId, {
    mode,
    scheduledLocalDate: options.scheduledLocalDate ?? null,
    windowStart,
    windowEnd,
    startedAt,
  });
  try {
    const releases = await filterRowsByEarningsSymbolCatalog(env, await fetchTradingViewEarningsReleases(windowStart, windowEnd));
    const rows = await computeEarningsGapEvents(env, releases, now);
    const rowsUpserted = rows.length > 0 ? await upsertEvents(env, rows) : 0;
    if (mode !== "backfill" || done) {
      await cleanupOldEarningsGapEvents(env, RETENTION_DAYS, now);
    }
    await recordSyncDone(env, syncId, {
      status: "ok",
      successAt: new Date().toISOString(),
      rowsSeen: releases.length,
      rowsUpserted,
    });
    return {
      ok: true,
      mode,
      windowStart,
      windowEnd,
      batchWindowStart: windowStart,
      batchWindowEnd: windowEnd,
      totalWindowStart,
      totalWindowEnd: totalWindowEndResolved,
      nextCursor,
      done,
      provider: PRIMARY_PROVIDER,
      rowsSeen: releases.length,
      rowsUpserted,
      scheduledLocalDate: options.scheduledLocalDate ?? null,
      warning: rows.length === 0 ? "No earnings release rows had a positive postmarket or regular-open gap." : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Earnings gap sync failed.";
    await recordSyncDone(env, syncId, { status: "error", error: message });
    throw error;
  }
}

function normalizeArrayFilter(value: string | string[] | null | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildWhereClause(query: EarningsGapsQuery, options: { includeCatalog?: boolean } = {}): { sql: string; args: unknown[] } {
  const clauses = ["report_date >= ?", earningsEligibleSecuritySql("earnings_gap_events", { includeCatalog: options.includeCatalog })];
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
  if (query.minMarketCap != null && Number.isFinite(query.minMarketCap)) {
    clauses.push("market_cap >= ?");
    args.push(query.minMarketCap);
  }
  if (query.maxMarketCap != null && Number.isFinite(query.maxMarketCap)) {
    clauses.push("market_cap <= ?");
    args.push(query.maxMarketCap);
  }
  if (query.minAvgDollarVolume != null && Number.isFinite(query.minAvgDollarVolume)) {
    clauses.push("avg_dollar_volume_30d >= ?");
    args.push(query.minAvgDollarVolume);
  }
  if (query.minGapPct != null && Number.isFinite(query.minGapPct)) {
    clauses.push("qualifying_gap_pct >= ?");
    args.push(query.minGapPct);
  }
  const seasons = normalizeArrayFilter(query.season);
  if (seasons.length > 0) {
    clauses.push(`season IN (${seasons.map(() => "?").join(",")})`);
    args.push(...seasons);
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
  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    args,
  };
}

function mapRow(row: Record<string, unknown>): EarningsGapRow {
  const gapSource = String(row.gapSource ?? row.gap_source ?? "regular_open") as EarningsGapSource;
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
    price: parseMaybeNumber(row.price),
    avgVolume30d: parseMaybeNumber(row.avgVolume30d),
    avgDollarVolume30d: parseMaybeNumber(row.avgDollarVolume30d),
    reportDate: String(row.reportDate ?? ""),
    season: String(row.season ?? ""),
    reportTimestamp: parseMaybeNumber(row.reportTimestamp),
    reportTime: row.reportTime == null ? null : String(row.reportTime),
    reactionDate: row.reactionDate == null ? null : String(row.reactionDate),
    previousClose: parseMaybeNumber(row.previousClose),
    reactionOpen: parseMaybeNumber(row.reactionOpen),
    regularOpenGapPct: parseMaybeNumber(row.regularOpenGapPct),
    postmarketPrice: parseMaybeNumber(row.postmarketPrice),
    postmarketGapPct: parseMaybeNumber(row.postmarketGapPct),
    postmarketVolume: parseMaybeNumber(row.postmarketVolume),
    qualifyingGapPct: parseMaybeNumber(row.qualifyingGapPct) ?? 0,
    gapSource,
    firstSeenAt: row.firstSeenAt == null ? null : String(row.firstSeenAt),
    lastSeenAt: row.lastSeenAt == null ? null : String(row.lastSeenAt),
  };
}

async function loadFacet(env: Env, field: "season" | "sector" | "industry" | "exchange" | "gap_source", whereSql: string, args: unknown[]): Promise<Array<{ value: string; count: number }>> {
  const rows = await env.DB.prepare(
    `SELECT ${field} as value, COUNT(*) as count
     FROM earnings_gap_events
     ${whereSql}
       ${whereSql ? "AND" : "WHERE"} ${field} IS NOT NULL AND ${field} <> ''
     GROUP BY ${field}
     ORDER BY count DESC, value ASC
     LIMIT 80`,
  ).bind(...args).all<{ value: string; count: number }>();
  return (rows.results ?? []).map((row) => ({ value: row.value, count: Number(row.count ?? 0) }));
}

export async function queryEarningsGaps(env: Env, query: EarningsGapsQuery = {}): Promise<EarningsGapsResponse> {
  const schemaWarning = await earningsGapSchemaWarning(env);
  if (schemaWarning) {
    return {
      schemaReady: false,
      warning: schemaWarning,
      generatedAt: new Date().toISOString(),
      total: 0,
      limit: DEFAULT_QUERY_LIMIT,
      offset: 0,
      rows: [],
      facets: { seasons: [], sectors: [], industries: [], exchanges: [], gapSources: [] },
    };
  }
  const limit = normalizeEarningsQueryLimit(query.limit, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
  const offset = normalizeEarningsQueryOffset(query.offset, query.limit);
  const sortColumn = SORT_COLUMNS[String(query.sort ?? "qualifyingGapPct")] ?? SORT_COLUMNS.qualifyingGapPct;
  const sortDir = query.sortDir === "asc" ? "asc" : "desc";
  const { sql: whereSql, args } = buildWhereClause(query, { includeCatalog: await canUseEarningsSymbolCatalog(env) });
  const count = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM earnings_gap_events ${whereSql}`,
  ).bind(...args).first<{ count: number }>();
  const rows = await env.DB.prepare(
    `SELECT
       id, provider, source_symbol as sourceSymbol, ticker, exchange, company_name as companyName,
       sector, industry, market_cap as marketCap, price, avg_volume_30d as avgVolume30d,
       avg_dollar_volume_30d as avgDollarVolume30d, report_date as reportDate,
       season, report_timestamp as reportTimestamp, report_time as reportTime, reaction_date as reactionDate,
       previous_close as previousClose, reaction_open as reactionOpen,
       regular_open_gap_pct as regularOpenGapPct, postmarket_price as postmarketPrice,
       postmarket_gap_pct as postmarketGapPct, postmarket_volume as postmarketVolume,
       qualifying_gap_pct as qualifyingGapPct, gap_source as gapSource,
       first_seen_at as firstSeenAt, last_seen_at as lastSeenAt
     FROM earnings_gap_events
     ${whereSql}
     ORDER BY ${sortColumn} ${sortDir.toUpperCase()}, ticker ASC
     LIMIT ? OFFSET ?`,
  ).bind(...args, limit, offset).all<Record<string, unknown>>();
  const [seasons, sectors, industries, exchanges, gapSources] = await Promise.all([
    loadFacet(env, "season", whereSql, args),
    loadFacet(env, "sector", whereSql, args),
    loadFacet(env, "industry", whereSql, args),
    loadFacet(env, "exchange", whereSql, args),
    loadFacet(env, "gap_source", whereSql, args),
  ]);
  return {
    schemaReady: true,
    warning: null,
    generatedAt: new Date().toISOString(),
    total: Number(count?.count ?? 0),
    limit,
    offset,
    rows: (rows.results ?? []).map(mapRow),
    facets: { seasons, sectors, industries, exchanges, gapSources },
  };
}

export async function exportEarningsGapTickers(env: Env, query: EarningsGapsQuery = {}): Promise<string[]> {
  if (await earningsGapSchemaWarning(env)) return [];
  const limit = normalizeEarningsQueryLimit(query.limit, DEFAULT_QUERY_LIMIT, EXPORT_MAX_LIMIT);
  const sortColumn = SORT_COLUMNS[String(query.sort ?? "qualifyingGapPct")] ?? SORT_COLUMNS.qualifyingGapPct;
  const sortDir = query.sortDir === "asc" ? "asc" : "desc";
  const { sql: whereSql, args } = buildWhereClause(query, { includeCatalog: await canUseEarningsSymbolCatalog(env) });
  const rows = await env.DB.prepare(
    `SELECT ticker
     FROM earnings_gap_events
     ${whereSql}
     ORDER BY ${sortColumn} ${sortDir.toUpperCase()}, ticker ASC
     LIMIT ?`,
  ).bind(...args, limit).all<{ ticker: string }>();
  return (rows.results ?? []).map((row) => String(row.ticker ?? "").trim()).filter(Boolean);
}

export async function loadEarningsGapsStatus(env: Env): Promise<EarningsGapsStatus> {
  const schemaWarning = await earningsGapSchemaWarning(env);
  if (schemaWarning) {
    return {
      schemaReady: false,
      warning: schemaWarning,
      counts: { total: 0, postmarket: 0, regularOpen: 0, both: 0, latestReportDate: null, earliestReportDate: null },
      syncs: [],
      latestRows: [],
    };
  }
  const includeCatalog = await canUseEarningsSymbolCatalog(env);
  const defaultEligibilitySql = earningsDefaultEligibleListedEquitySql("earnings_gap_events", { includeCatalog });
  const [counts, syncs, latest] = await Promise.all([
    env.DB.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN gap_source = 'postmarket' THEN 1 ELSE 0 END) as postmarket,
         SUM(CASE WHEN gap_source = 'regular_open' THEN 1 ELSE 0 END) as regularOpen,
         SUM(CASE WHEN gap_source = 'both' THEN 1 ELSE 0 END) as both,
         MAX(report_date) as latestReportDate,
         MIN(report_date) as earliestReportDate
       FROM earnings_gap_events
       WHERE ${defaultEligibilitySql}`,
    ).first<{ total: number; postmarket: number | null; regularOpen: number | null; both: number | null; latestReportDate: string | null; earliestReportDate: string | null }>(),
    env.DB.prepare(
      `SELECT id, provider, status, mode, scheduled_local_date as scheduledLocalDate,
        window_start as windowStart, window_end as windowEnd,
        last_started_at as lastStartedAt, last_success_at as lastSuccessAt,
        last_error as lastError, rows_seen as rowsSeen, rows_upserted as rowsUpserted,
        updated_at as updatedAt
       FROM earnings_gap_syncs
       ORDER BY datetime(updated_at) DESC
       LIMIT 12`,
    ).all<EarningsGapsStatus["syncs"][number]>(),
    queryEarningsGaps(env, { limit: 12, offset: 0, includeOtc: false, sort: "reportDate", sortDir: "desc" }),
  ]);
  return {
    schemaReady: true,
    warning: null,
    counts: {
      total: Number(counts?.total ?? 0),
      postmarket: Number(counts?.postmarket ?? 0),
      regularOpen: Number(counts?.regularOpen ?? 0),
      both: Number(counts?.both ?? 0),
      latestReportDate: counts?.latestReportDate ?? null,
      earliestReportDate: counts?.earliestReportDate ?? null,
    },
    syncs: syncs.results ?? [],
    latestRows: latest.rows,
  };
}

function isWeekday(value: string): boolean {
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(value);
}

export async function maybeRunScheduledEarningsGapSync(env: Env, now = new Date()): Promise<EarningsGapSyncResult | null> {
  if (!(await hasEarningsGapSchema(env))) return null;
  const ny = zonedParts(now, "America/New_York");
  if (!isWeekday(ny.weekday)) return null;
  if (ny.minutesOfDay < DAILY_SCAN_MINUTES_ET) return null;
  const existing = await env.DB.prepare(
    "SELECT id FROM earnings_gap_syncs WHERE scheduled_local_date = ? AND status = 'ok' LIMIT 1",
  ).bind(ny.localDate).first<{ id: string }>();
  if (existing?.id) return null;
  return syncEarningsGaps(env, { mode: "incremental", now, scheduledLocalDate: ny.localDate });
}
