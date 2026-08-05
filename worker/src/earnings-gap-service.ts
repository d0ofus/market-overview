import { zonedParts } from "./refresh-timing";
import { meteredFetch } from "./provider-usage";
import type { Env } from "./types";
import { refreshDailyBarsIncremental } from "./daily-bars";
import { getMarketDataDb, marketDataFeed } from "./market-data-db";
import {
  latestUsMarketSessionAsOfDate,
  nextUsMarketTradingDay,
  onOrAfterUsMarketTradingDay,
  previousUsMarketTradingDay,
} from "./market-calendar";
import { getProvider, type MarketDataProvider } from "./provider";
import { shouldRunCentralCronLocalTime, type CronJobValues } from "./cron-jobs-service";
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
export type EarningsGapCalculationStatus = "complete" | "provisional" | "deferred";

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
  epsProvider: string | null;
  epsActual: number | null;
  epsEstimate: number | null;
  epsSurprise: number | null;
  epsSurprisePct: number | null;
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
  calculationStatus: Exclude<EarningsGapCalculationStatus, "deferred">;
  barProvider: string | null;
  calculatedAt: string;
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
  epsProvider: string | null;
  epsActual: number | null;
  epsEstimate: number | null;
  epsSurprise: number | null;
  epsSurprisePct: number | null;
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

export type EarningsGapsSnapshotResponse = Omit<EarningsGapsResponse, "limit" | "offset">;

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
  barsRequested: number;
  barsReady: number;
  barsFetched: number;
  rowsDeferred: number;
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
    barsRequested: number | null;
    barsReady: number | null;
    barsFetched: number | null;
    rowsDeferred: number | null;
    warning: string | null;
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

type ExistingGapSnapshot = {
  ticker: string;
  reportDate: string;
  reportTime: string | null;
  postmarketPrice: number | null;
  postmarketGapPct: number | null;
  postmarketVolume: number | null;
};

type GapCalculationBatch = {
  qualifiedRows: EarningsGapEventInput[];
  completeNonQualifiers: Array<{ ticker: string; reportDate: string }>;
  deferredRows: Array<{ ticker: string; reportDate: string }>;
  barsRequested: number;
  barsReady: number;
  barsFetched: number;
  warning: string | null;
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
  "earnings_per_share_fq",
  "earnings_per_share_forecast_fq",
  "eps_surprise_fq",
  "eps_surprise_percent_fq",
];

const SORT_COLUMNS: Record<string, string> = {
  reportDate: "report_date",
  ticker: "ticker",
  companyName: "company_name",
  season: "season",
  epsSurprise: "eps_surprise",
  epsSurprisePct: "eps_surprise_pct",
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
  const epsColumns = ["eps_provider", "eps_actual", "eps_estimate", "eps_surprise", "eps_surprise_pct"];
  const epsColumnsReady = await Promise.all(epsColumns.map((column) => columnExists(env, "earnings_gap_events", column)));
  if (epsColumnsReady.some((ready) => !ready)) {
    return "Earnings gap EPS schema is missing. Apply worker/migrations/0088_earnings_gap_eps.sql.";
  }
  const reliabilityEventColumns = ["calculation_status", "bar_provider", "calculated_at"];
  const reliabilitySyncColumns = ["bars_requested", "bars_ready", "bars_fetched", "rows_deferred", "warning"];
  const [eventColumnsReady, syncColumnsReady] = await Promise.all([
    Promise.all(reliabilityEventColumns.map((column) => columnExists(env, "earnings_gap_events", column))),
    Promise.all(reliabilitySyncColumns.map((column) => columnExists(env, "earnings_gap_syncs", column))),
  ]);
  if (eventColumnsReady.some((ready) => !ready) || syncColumnsReady.some((ready) => !ready)) {
    return "Earnings gap reliability schema is missing. Apply worker/migrations/0091_earnings_gap_reliability.sql.";
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
        epsProvider: [data[17], data[18], data[19], data[20]].some((value) => parseMaybeNumber(value) != null)
          ? PRIMARY_PROVIDER
          : null,
        epsActual: parseMaybeNumber(data[17]),
        epsEstimate: parseMaybeNumber(data[18]),
        epsSurprise: parseMaybeNumber(data[19]),
        epsSurprisePct: parseMaybeNumber(data[20]),
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
      epsProvider: existing.epsProvider ?? row.epsProvider,
      epsActual: existing.epsActual ?? row.epsActual,
      epsEstimate: existing.epsEstimate ?? row.epsEstimate,
      epsSurprise: existing.epsSurprise ?? row.epsSurprise,
      epsSurprisePct: existing.epsSurprisePct ?? row.epsSurprisePct,
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

async function fetchTradingViewPage(env: Env, payload: TradingViewEarningsGapPayload): Promise<TradingViewScanResponse> {
  const response = await meteredFetch(env, TV_SCAN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "market-command-centre/1.0",
    },
    body: JSON.stringify(payload),
  }, {
    providerKey: "tradingview",
    endpointKey: "earnings-gap",
    caller: "earnings-gap",
    symbolCount: payload.range?.[1] ?? TV_PAGE_SIZE,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`TradingView earnings gap request failed (${response.status}): ${body.slice(0, 180)}`);
  }
  return response.json() as Promise<TradingViewScanResponse>;
}

async function fetchTradingViewEarningsReleases(env: Env, startDate: string, endDate: string): Promise<EarningsGapReleaseInput[]> {
  const allRows: EarningsGapReleaseInput[] = [];
  let offset = 0;
  let totalCount = Number.POSITIVE_INFINITY;
  while (offset < totalCount && offset < TV_MAX_PROVIDER_ROWS) {
    const payload = buildTradingViewEarningsGapPayload({ startDate, endDate, offset, limit: TV_PAGE_SIZE });
    const page = await fetchTradingViewPage(env, payload);
    totalCount = Math.min(Number(page.totalCount ?? 0), TV_MAX_PROVIDER_ROWS);
    allRows.push(...parseTradingViewEarningsGapRows(page));
    const pageCount = page.data?.length ?? 0;
    if (pageCount <= 0) break;
    offset += pageCount;
    if (pageCount < TV_PAGE_SIZE) break;
  }
  return dedupeReleases(allRows);
}

type StoredEpsSnapshot = Pick<
  EarningsGapReleaseInput,
  "ticker" | "reportDate" | "epsProvider" | "epsActual" | "epsEstimate" | "epsSurprise" | "epsSurprisePct"
>;

function hasEpsSnapshot(row: Pick<EarningsGapReleaseInput, "epsActual" | "epsEstimate" | "epsSurprise" | "epsSurprisePct">): boolean {
  return row.epsActual != null || row.epsEstimate != null || row.epsSurprise != null || row.epsSurprisePct != null;
}

async function enrichReleasesWithStoredEps(env: Env, releases: EarningsGapReleaseInput[]): Promise<EarningsGapReleaseInput[]> {
  const missing = releases.filter((row) => !hasEpsSnapshot(row));
  if (missing.length === 0 || !(await tableExists(env, "earnings_surprise_events"))) return releases;

  const minDate = missing.map((row) => row.reportDate).sort()[0];
  const maxDate = missing.map((row) => row.reportDate).sort().at(-1);
  if (!minDate || !maxDate) return releases;

  const snapshots = new Map<string, StoredEpsSnapshot>();
  const tickers = Array.from(new Set(missing.map((row) => row.ticker)));
  for (let index = 0; index < tickers.length; index += 80) {
    const chunk = tickers.slice(index, index + 80);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT
         provider as epsProvider, ticker, report_date as reportDate,
         eps_actual as epsActual, eps_estimate as epsEstimate,
         eps_surprise as epsSurprise, eps_surprise_pct as epsSurprisePct
       FROM earnings_surprise_events
       WHERE ticker IN (${placeholders}) AND report_date >= ? AND report_date <= ?
       ORDER BY
         ticker ASC,
         report_date ASC,
         CASE provider
           WHEN 'tradingview' THEN 0
           WHEN 'fmp' THEN 1
           WHEN 'finnhub' THEN 2
           ELSE 3
         END ASC,
         COALESCE(last_seen_at, '') DESC,
         COALESCE(fiscal_period_end, '') DESC`,
    ).bind(...chunk, minDate, maxDate).all<Record<string, unknown>>();
    for (const row of rows.results ?? []) {
      const snapshot: StoredEpsSnapshot = {
        ticker: normalizeTicker(row.ticker),
        reportDate: String(row.reportDate ?? ""),
        epsProvider: row.epsProvider == null ? null : String(row.epsProvider),
        epsActual: parseMaybeNumber(row.epsActual),
        epsEstimate: parseMaybeNumber(row.epsEstimate),
        epsSurprise: parseMaybeNumber(row.epsSurprise),
        epsSurprisePct: parseMaybeNumber(row.epsSurprisePct),
      };
      const key = `${snapshot.ticker}|${snapshot.reportDate}`;
      if (!snapshots.has(key)) snapshots.set(key, snapshot);
    }
  }

  return releases.map((release) => {
    if (hasEpsSnapshot(release)) return release;
    const snapshot = snapshots.get(`${release.ticker}|${release.reportDate}`);
    return snapshot ? { ...release, ...snapshot } : release;
  });
}

async function loadDailyBarsByTicker(
  env: Env,
  tickers: string[],
  startDate: string,
  endDate: string,
): Promise<Map<string, DailyBar[]>> {
  const uniqueTickers = Array.from(new Set(tickers.map(normalizeTicker).filter(Boolean)));
  const byTicker = new Map<string, DailyBar[]>();
  const db = getMarketDataDb(env);
  const feed = marketDataFeed(env);
  for (let index = 0; index < uniqueTickers.length; index += 80) {
    const chunk = uniqueTickers.slice(index, index + 80);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.prepare(
      `SELECT ticker, date, o, c
       FROM alpaca_daily_bars
       WHERE feed = ? AND ticker IN (${placeholders}) AND date >= ? AND date <= ?
       ORDER BY ticker ASC, date ASC`,
    ).bind(feed, ...chunk, startDate, endDate).all<DailyBar>();
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

async function loadExistingGapSnapshots(
  env: Env,
  releases: EarningsGapReleaseInput[],
): Promise<Map<string, ExistingGapSnapshot>> {
  const snapshots = new Map<string, ExistingGapSnapshot>();
  if (releases.length === 0) return snapshots;
  const minDate = releases.map((row) => row.reportDate).sort()[0];
  const maxDate = releases.map((row) => row.reportDate).sort().at(-1);
  if (!minDate || !maxDate) return snapshots;
  const tickers = Array.from(new Set(releases.map((row) => row.ticker)));
  for (let index = 0; index < tickers.length; index += 80) {
    const chunk = tickers.slice(index, index + 80);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT ticker, report_date as reportDate, report_time as reportTime,
        postmarket_price as postmarketPrice, postmarket_gap_pct as postmarketGapPct,
        postmarket_volume as postmarketVolume
       FROM earnings_gap_events
       WHERE ticker IN (${placeholders}) AND report_date >= ? AND report_date <= ?`,
    ).bind(...chunk, minDate, maxDate).all<Record<string, unknown>>();
    for (const row of rows.results ?? []) {
      const snapshot: ExistingGapSnapshot = {
        ticker: normalizeTicker(row.ticker),
        reportDate: String(row.reportDate ?? ""),
        reportTime: row.reportTime == null ? null : String(row.reportTime),
        postmarketPrice: parseMaybeNumber(row.postmarketPrice),
        postmarketGapPct: parseMaybeNumber(row.postmarketGapPct),
        postmarketVolume: parseMaybeNumber(row.postmarketVolume),
      };
      snapshots.set(`${snapshot.ticker}|${snapshot.reportDate}`, snapshot);
    }
  }
  return snapshots;
}

type ReleaseTiming = "before-market" | "after-market" | "intraday" | "unknown";

function classifyReleaseTiming(release: EarningsGapReleaseInput): ReleaseTiming {
  const explicit = String(release.reportTime ?? "").trim().toLowerCase();
  if (/before|pre.?market|\bbmo\b/.test(explicit)) return "before-market";
  if (/after|post.?market|\bamc\b/.test(explicit)) return "after-market";
  if (/intra|during/.test(explicit)) return "intraday";
  if (release.reportTimestamp == null || !Number.isFinite(release.reportTimestamp)) return "unknown";
  const parts = zonedParts(new Date(release.reportTimestamp * 1000), "America/New_York");
  if (parts.minutesOfDay < 9 * 60 + 30) return "before-market";
  if (parts.minutesOfDay >= 16 * 60) return "after-market";
  return "intraday";
}

function requiredRegularSessions(release: EarningsGapReleaseInput, timing: ReleaseTiming): {
  previousDate: string;
  reactionDate: string;
} {
  const reactionDate = timing === "before-market"
    ? onOrAfterUsMarketTradingDay(release.reportDate)
    : nextUsMarketTradingDay(release.reportDate);
  return {
    previousDate: previousUsMarketTradingDay(reactionDate),
    reactionDate,
  };
}

function barMap(barsByTicker: Map<string, DailyBar[]>): Map<string, DailyBar> {
  const rows = new Map<string, DailyBar>();
  for (const bars of barsByTicker.values()) {
    for (const bar of bars) rows.set(`${bar.ticker}|${bar.date}`, bar);
  }
  return rows;
}

async function calculateEarningsGapBatch(
  env: Env,
  releases: EarningsGapReleaseInput[],
  now = new Date(),
  provider?: MarketDataProvider,
): Promise<GapCalculationBatch> {
  const ny = zonedParts(now, "America/New_York");
  const normalized = dedupeReleases(releases);
  if (normalized.length === 0) {
    return {
      qualifiedRows: [],
      completeNonQualifiers: [],
      deferredRows: [],
      barsRequested: 0,
      barsReady: 0,
      barsFetched: 0,
      warning: null,
    };
  }

  const latestCompletedSession = latestUsMarketSessionAsOfDate(now);
  const requirements = normalized.map((release) => {
    const timing = classifyReleaseTiming(release);
    return { release, timing, ...requiredRegularSessions(release, timing) };
  });
  const readyRequirements = requirements.filter((row) => row.reactionDate <= latestCompletedSession);
  const requiredPairs = new Set<string>();
  for (const row of readyRequirements) {
    requiredPairs.add(`${row.release.ticker}|${row.previousDate}`);
    requiredPairs.add(`${row.release.ticker}|${row.reactionDate}`);
  }
  const requiredDates = Array.from(requiredPairs, (key) => key.split("|")[1] ?? "").filter(Boolean).sort();
  const minDate = requiredDates[0] ?? latestCompletedSession;
  const maxDate = requiredDates.at(-1) ?? latestCompletedSession;
  let barsByTicker = await loadDailyBarsByTicker(
    env,
    readyRequirements.map((row) => row.release.ticker),
    minDate,
    maxDate,
  );
  let bars = barMap(barsByTicker);
  const missingPairs = Array.from(requiredPairs).filter((key) => !bars.has(key));
  const missingTickers = Array.from(new Set(missingPairs.map((key) => key.split("|")[0] ?? "").filter(Boolean)));
  let barsFetched = 0;
  let warning: string | null = null;
  if (missingTickers.length > 0) {
    try {
      const configuredProvider = provider ?? (
        (env.DATA_PROVIDER ?? "alpaca").toLowerCase() === "alpaca"
          && (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET)
          ? null
          : getProvider(env, { fallbackEnabled: false })
      );
      if (!configuredProvider) {
        throw new Error("Alpaca credentials are unavailable for earnings-priority daily-bar recovery.");
      }
      const refresh = await refreshDailyBarsIncremental(env, {
        provider: configuredProvider,
        tickers: missingTickers,
        startDate: minDate,
        endDate: maxDate,
        replaceExisting: true,
        providerBatchSize: SYNC_BATCH_SIZE,
        continueOnError: true,
        target: "market",
        mirrorLatestToLegacy: true,
        repairMissingMarketDates: true,
      });
      barsFetched = refresh.fetchedRows;
      barsByTicker = await loadDailyBarsByTicker(env, missingTickers, minDate, maxDate);
      for (const [ticker, tickerBars] of barsByTicker) {
        for (const bar of tickerBars) bars.set(`${ticker}|${bar.date}`, bar);
      }
    } catch (error) {
      warning = error instanceof Error ? error.message : "Earnings-priority daily-bar recovery failed.";
    }
  }

  const existing = await loadExistingGapSnapshots(env, normalized);
  const calculatedAt = now.toISOString();
  const qualifiedRows: EarningsGapEventInput[] = [];
  const completeNonQualifiers: Array<{ ticker: string; reportDate: string }> = [];
  const deferredRows: Array<{ ticker: string; reportDate: string }> = [];

  for (const requirement of requirements) {
    const { release, timing, previousDate, reactionDate } = requirement;
    const existingSnapshot = existing.get(`${release.ticker}|${release.reportDate}`);
    const currentPostmarketIsValid = timing === "after-market"
      && release.reportDate === ny.localDate
      && ny.minutesOfDay >= 16 * 60
      && release.postmarketPrice != null
      && release.price != null;
    const postmarketPrice = timing === "after-market"
      ? currentPostmarketIsValid
        ? release.postmarketPrice
        : existingSnapshot?.postmarketPrice ?? null
      : null;
    const postmarketGapPct = timing === "after-market"
      ? currentPostmarketIsValid
        ? pctChange(release.postmarketPrice, release.price)
        : existingSnapshot?.postmarketGapPct ?? null
      : null;
    const postmarketVolume = timing === "after-market"
      ? currentPostmarketIsValid
        ? release.postmarketVolume
        : existingSnapshot?.postmarketVolume ?? null
      : null;
    const postmarketQualifies = postmarketGapPct != null && postmarketGapPct > 0;
    const sessionCompleted = reactionDate <= latestCompletedSession;
    const previousBar = sessionCompleted ? bars.get(`${release.ticker}|${previousDate}`) ?? null : null;
    const reactionBar = sessionCompleted ? bars.get(`${release.ticker}|${reactionDate}`) ?? null : null;
    const regularReady = Boolean(previousBar && reactionBar);
    const previousClose = regularReady && Number.isFinite(previousBar?.c) ? previousBar?.c ?? null : null;
    const reactionOpen = regularReady && Number.isFinite(reactionBar?.o) ? reactionBar?.o ?? null : null;
    const regularOpenGapPct = regularReady ? pctChange(reactionOpen, previousClose) : null;
    const regularQualifies = regularOpenGapPct != null && regularOpenGapPct > 0;
    const calculationStatus: EarningsGapCalculationStatus = regularReady
      ? "complete"
      : !sessionCompleted && timing === "after-market" && postmarketQualifies
        ? "provisional"
        : "deferred";

    if (calculationStatus === "deferred") {
      deferredRows.push({ ticker: release.ticker, reportDate: release.reportDate });
      continue;
    }
    if (!postmarketQualifies && !regularQualifies) {
      completeNonQualifiers.push({ ticker: release.ticker, reportDate: release.reportDate });
      continue;
    }
    const qualifyingGapPct = Math.max(
      postmarketQualifies ? postmarketGapPct : Number.NEGATIVE_INFINITY,
      regularQualifies ? regularOpenGapPct ?? Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY,
    );
    const gapSource: EarningsGapSource = postmarketQualifies && regularQualifies
      ? "both"
      : postmarketQualifies
        ? "postmarket"
        : "regular_open";
    qualifiedRows.push({
      ...release,
      reportTime: timing === "unknown" ? release.reportTime : timing,
      reactionDate: regularReady ? reactionDate : null,
      previousClose,
      reactionOpen,
      regularOpenGapPct,
      postmarketPrice,
      postmarketGapPct,
      postmarketVolume,
      qualifyingGapPct,
      gapSource,
      calculationStatus,
      barProvider: regularReady
        ? postmarketGapPct != null ? "alpaca+tradingview" : "alpaca"
        : "tradingview",
      calculatedAt,
    });
  }

  const barsReady = Array.from(requiredPairs).filter((key) => bars.has(key)).length;
  const unresolvedPairs = Math.max(0, requiredPairs.size - barsReady);
  if (unresolvedPairs > 0) {
    const missingWarning = `${unresolvedPairs} required Alpaca daily bar${unresolvedPairs === 1 ? "" : "s"} remain unavailable.`;
    warning = warning ? `${warning} ${missingWarning}` : missingWarning;
  }
  return {
    qualifiedRows,
    completeNonQualifiers,
    deferredRows,
    barsRequested: requiredPairs.size,
    barsReady,
    barsFetched,
    warning,
  };
}

export async function computeEarningsGapEvents(
  env: Env,
  releases: EarningsGapReleaseInput[],
  now = new Date(),
  provider?: MarketDataProvider,
): Promise<EarningsGapEventInput[]> {
  return (await calculateEarningsGapBatch(env, releases, now, provider)).qualifiedRows;
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
    barsRequested?: number;
    barsReady?: number;
    barsFetched?: number;
    rowsDeferred?: number;
    warning?: string | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE earnings_gap_syncs
     SET status = ?,
         last_success_at = CASE WHEN ? = 'ok' THEN ? ELSE last_success_at END,
         last_error = ?,
         rows_seen = ?,
         rows_upserted = ?,
         bars_requested = ?,
         bars_ready = ?,
         bars_fetched = ?,
         rows_deferred = ?,
         warning = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(
    input.status,
    input.status,
    input.successAt ?? null,
    input.error ?? null,
    input.rowsSeen ?? 0,
    input.rowsUpserted ?? 0,
    input.barsRequested ?? 0,
    input.barsReady ?? 0,
    input.barsFetched ?? 0,
    input.rowsDeferred ?? 0,
    input.warning ?? null,
    id,
  ).run();
}

async function upsertEvents(env: Env, rows: EarningsGapEventInput[]): Promise<number> {
  const now = new Date().toISOString();
  const statements = rows.map((row) => env.DB.prepare(
    `INSERT INTO earnings_gap_events (
       id, provider, source_symbol, ticker, exchange, company_name, sector, industry,
       market_cap, price, avg_volume_30d, avg_dollar_volume_30d,
       report_date, season, eps_provider, eps_actual, eps_estimate, eps_surprise, eps_surprise_pct,
       report_timestamp, report_time, reaction_date, previous_close,
       reaction_open, regular_open_gap_pct, postmarket_price, postmarket_gap_pct,
       postmarket_volume, qualifying_gap_pct, gap_source,
       calculation_status, bar_provider, calculated_at, raw_json,
       first_seen_at, last_seen_at, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
       eps_provider = COALESCE(excluded.eps_provider, earnings_gap_events.eps_provider),
       eps_actual = COALESCE(excluded.eps_actual, earnings_gap_events.eps_actual),
       eps_estimate = COALESCE(excluded.eps_estimate, earnings_gap_events.eps_estimate),
       eps_surprise = COALESCE(excluded.eps_surprise, earnings_gap_events.eps_surprise),
       eps_surprise_pct = COALESCE(excluded.eps_surprise_pct, earnings_gap_events.eps_surprise_pct),
       report_timestamp = COALESCE(excluded.report_timestamp, earnings_gap_events.report_timestamp),
       report_time = excluded.report_time,
       reaction_date = excluded.reaction_date,
       previous_close = excluded.previous_close,
       reaction_open = excluded.reaction_open,
       regular_open_gap_pct = excluded.regular_open_gap_pct,
       postmarket_price = excluded.postmarket_price,
       postmarket_gap_pct = excluded.postmarket_gap_pct,
       postmarket_volume = excluded.postmarket_volume,
       qualifying_gap_pct = excluded.qualifying_gap_pct,
       gap_source = excluded.gap_source,
       calculation_status = excluded.calculation_status,
       bar_provider = excluded.bar_provider,
       calculated_at = excluded.calculated_at,
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
    row.epsProvider,
    row.epsActual,
    row.epsEstimate,
    row.epsSurprise,
    row.epsSurprisePct,
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
    row.calculationStatus,
    row.barProvider,
    row.calculatedAt,
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

async function markDeferredEvents(
  env: Env,
  rows: Array<{ ticker: string; reportDate: string }>,
  calculatedAt: string,
): Promise<void> {
  const statements = rows.map((row) => env.DB.prepare(
    `UPDATE earnings_gap_events
     SET calculation_status = 'deferred',
         bar_provider = NULL,
         calculated_at = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE ticker = ? AND report_date = ?`,
  ).bind(calculatedAt, row.ticker, row.reportDate));
  for (let index = 0; index < statements.length; index += SYNC_BATCH_SIZE) {
    const chunk = statements.slice(index, index + SYNC_BATCH_SIZE);
    if (chunk.length > 0) await env.DB.batch(chunk);
  }
}

async function deleteCompleteNonQualifiers(
  env: Env,
  rows: Array<{ ticker: string; reportDate: string }>,
): Promise<void> {
  const statements = rows.map((row) => env.DB.prepare(
    "DELETE FROM earnings_gap_events WHERE ticker = ? AND report_date = ?",
  ).bind(row.ticker, row.reportDate));
  for (let index = 0; index < statements.length; index += SYNC_BATCH_SIZE) {
    const chunk = statements.slice(index, index + SYNC_BATCH_SIZE);
    if (chunk.length > 0) await env.DB.batch(chunk);
  }
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
    const releases = await filterRowsByEarningsSymbolCatalog(env, await fetchTradingViewEarningsReleases(env, windowStart, windowEnd));
    const enrichedReleases = await enrichReleasesWithStoredEps(env, releases);
    const calculation = await calculateEarningsGapBatch(env, enrichedReleases, now);
    const rowsUpserted = calculation.qualifiedRows.length > 0
      ? await upsertEvents(env, calculation.qualifiedRows)
      : 0;
    await Promise.all([
      markDeferredEvents(env, calculation.deferredRows, now.toISOString()),
      deleteCompleteNonQualifiers(env, calculation.completeNonQualifiers),
    ]);
    if (mode !== "backfill" || done) {
      await cleanupOldEarningsGapEvents(env, RETENTION_DAYS, now);
    }
    const deferredWarning = calculation.deferredRows.length > 0
      ? `${calculation.deferredRows.length} release row${calculation.deferredRows.length === 1 ? "" : "s"} deferred until required Alpaca bars are available or the reaction session completes.`
      : null;
    const noQualifiersWarning = calculation.qualifiedRows.length === 0 && calculation.deferredRows.length === 0
      ? "No earnings release rows had a positive timing-valid postmarket or regular-open gap."
      : null;
    const warning = [calculation.warning, deferredWarning, noQualifiersWarning].filter(Boolean).join(" ") || null;
    await recordSyncDone(env, syncId, {
      status: "ok",
      successAt: new Date().toISOString(),
      rowsSeen: releases.length,
      rowsUpserted,
      barsRequested: calculation.barsRequested,
      barsReady: calculation.barsReady,
      barsFetched: calculation.barsFetched,
      rowsDeferred: calculation.deferredRows.length,
      warning,
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
      barsRequested: calculation.barsRequested,
      barsReady: calculation.barsReady,
      barsFetched: calculation.barsFetched,
      rowsDeferred: calculation.deferredRows.length,
      scheduledLocalDate: options.scheduledLocalDate ?? null,
      warning,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Earnings gap sync failed.";
    await recordSyncDone(env, syncId, { status: "error", error: message, warning: message });
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
  const clauses = [
    "calculation_status IN ('complete', 'provisional')",
    "report_date >= ?",
    earningsEligibleSecuritySql("earnings_gap_events", { includeCatalog: options.includeCatalog }),
  ];
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
    epsProvider: row.epsProvider == null ? null : String(row.epsProvider),
    epsActual: parseMaybeNumber(row.epsActual),
    epsEstimate: parseMaybeNumber(row.epsEstimate),
    epsSurprise: parseMaybeNumber(row.epsSurprise),
    epsSurprisePct: parseMaybeNumber(row.epsSurprisePct),
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

const EARNINGS_GAP_SELECT_COLUMNS = `
  id, provider, source_symbol as sourceSymbol, ticker, exchange, company_name as companyName,
  sector, industry, market_cap as marketCap, price, avg_volume_30d as avgVolume30d,
  avg_dollar_volume_30d as avgDollarVolume30d, report_date as reportDate,
  season, eps_provider as epsProvider, eps_actual as epsActual, eps_estimate as epsEstimate,
  eps_surprise as epsSurprise, eps_surprise_pct as epsSurprisePct,
  report_timestamp as reportTimestamp, report_time as reportTime, reaction_date as reactionDate,
  previous_close as previousClose, reaction_open as reactionOpen,
  regular_open_gap_pct as regularOpenGapPct, postmarket_price as postmarketPrice,
  postmarket_gap_pct as postmarketGapPct, postmarket_volume as postmarketVolume,
  qualifying_gap_pct as qualifyingGapPct, gap_source as gapSource,
  first_seen_at as firstSeenAt, last_seen_at as lastSeenAt`;

function compareFacetValues(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function deriveFacet(
  rows: EarningsGapRow[],
  field: "season" | "sector" | "industry" | "exchange" | "gapSource",
): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = String(row[field] ?? "");
    if (value !== "") counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts, ([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || compareFacetValues(left.value, right.value))
    .slice(0, 80);
}

function deriveSnapshotFacets(rows: EarningsGapRow[]): EarningsGapsResponse["facets"] {
  return {
    seasons: deriveFacet(rows, "season"),
    sectors: deriveFacet(rows, "sector"),
    industries: deriveFacet(rows, "industry"),
    exchanges: deriveFacet(rows, "exchange"),
    gapSources: deriveFacet(rows, "gapSource"),
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
  const sortColumn = SORT_COLUMNS[String(query.sort ?? "reportDate")] ?? SORT_COLUMNS.reportDate;
  const sortDir = query.sortDir === "asc" ? "asc" : "desc";
  const { sql: whereSql, args } = buildWhereClause(query, { includeCatalog: await canUseEarningsSymbolCatalog(env) });
  const count = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM earnings_gap_events ${whereSql}`,
  ).bind(...args).first<{ count: number }>();
  const rows = await env.DB.prepare(
    `SELECT ${EARNINGS_GAP_SELECT_COLUMNS}
     FROM earnings_gap_events
     ${whereSql}
     ORDER BY ${sortColumn} ${sortDir.toUpperCase()}, ticker ASC, report_date DESC, id ASC
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

export async function loadEarningsGapsSnapshot(
  env: Env,
  query: EarningsGapsQuery = {},
): Promise<EarningsGapsSnapshotResponse> {
  const schemaWarning = await earningsGapSchemaWarning(env);
  if (schemaWarning) {
    return {
      schemaReady: false,
      warning: schemaWarning,
      generatedAt: new Date().toISOString(),
      total: 0,
      rows: [],
      facets: { seasons: [], sectors: [], industries: [], exchanges: [], gapSources: [] },
    };
  }
  const { sql: whereSql, args } = buildWhereClause(query, { includeCatalog: await canUseEarningsSymbolCatalog(env) });
  const result = await env.DB.prepare(
    `SELECT ${EARNINGS_GAP_SELECT_COLUMNS}
     FROM earnings_gap_events
     ${whereSql}
     ORDER BY report_date DESC, ticker ASC, id ASC`,
  ).bind(...args).all<Record<string, unknown>>();
  const rows = (result.results ?? []).map(mapRow);
  return {
    schemaReady: true,
    warning: null,
    generatedAt: new Date().toISOString(),
    total: rows.length,
    rows,
    facets: deriveSnapshotFacets(rows),
  };
}

export async function exportEarningsGapTickers(env: Env, query: EarningsGapsQuery = {}): Promise<string[]> {
  if (await earningsGapSchemaWarning(env)) return [];
  const limit = normalizeEarningsQueryLimit(query.limit, DEFAULT_QUERY_LIMIT, EXPORT_MAX_LIMIT);
  const sortColumn = SORT_COLUMNS[String(query.sort ?? "reportDate")] ?? SORT_COLUMNS.reportDate;
  const sortDir = query.sortDir === "asc" ? "asc" : "desc";
  const { sql: whereSql, args } = buildWhereClause(query, { includeCatalog: await canUseEarningsSymbolCatalog(env) });
  const rows = await env.DB.prepare(
    `SELECT ticker
     FROM earnings_gap_events
     ${whereSql}
     ORDER BY ${sortColumn} ${sortDir.toUpperCase()}, ticker ASC, report_date DESC, id ASC
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
  const defaultEligibilitySql = [
    "calculation_status IN ('complete', 'provisional')",
    earningsDefaultEligibleListedEquitySql("earnings_gap_events", { includeCatalog }),
  ].join(" AND ");
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
        bars_requested as barsRequested, bars_ready as barsReady,
        bars_fetched as barsFetched, rows_deferred as rowsDeferred, warning,
        updated_at as updatedAt
       FROM earnings_gap_syncs
       ORDER BY datetime(updated_at) DESC
       LIMIT 12`,
    ).all<EarningsGapsStatus["syncs"][number]>(),
    env.DB.prepare(
      `SELECT ${EARNINGS_GAP_SELECT_COLUMNS}
       FROM earnings_gap_events
       WHERE ${defaultEligibilitySql}
       ORDER BY report_date DESC, ticker ASC, id ASC
       LIMIT 12`,
    ).all<Record<string, unknown>>(),
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
    latestRows: (latest.results ?? []).map(mapRow),
  };
}

function isWeekday(value: string): boolean {
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(value);
}

export async function maybeRunScheduledEarningsGapSync(env: Env, now = new Date(), settings?: CronJobValues): Promise<EarningsGapSyncResult | null> {
  const ny = zonedParts(now, "America/New_York");
  const due = settings
    ? shouldRunCentralCronLocalTime(now, settings, {
      timezone: "America/New_York",
      localTime: "20:00",
      days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    })
    : isWeekday(ny.weekday) && ny.minutesOfDay >= DAILY_SCAN_MINUTES_ET;
  if (!due) return null;
  if (!(await hasEarningsGapSchema(env))) return null;
  const existing = await env.DB.prepare(
    "SELECT id FROM earnings_gap_syncs WHERE scheduled_local_date = ? AND status = 'ok' LIMIT 1",
  ).bind(ny.localDate).first<{ id: string }>();
  if (existing?.id) return null;
  return syncEarningsGaps(env, { mode: "incremental", now, scheduledLocalDate: ny.localDate });
}
