import { buildRelativeStrengthSeries, computeBreadthStats, computeMetrics, isPriceAboveSma, rankValue, sanitizeBarSeries } from "./metrics";
import { loadConfig } from "./db";
import { refreshDailyBarsIncremental } from "./daily-bars";
import { getProvider } from "./provider";
import { SP500_TICKERS } from "./sp500-tickers";
import { isUsMarketTradingDay, latestUsMarketSessionAsOfDate, previousUsMarketTradingDay } from "./market-calendar";
import { getMarketDataDb, marketDataFeed } from "./market-data-db";
import { loadNasdaqTraderUniverses, loadRussell2000Constituents, loadSp500Constituents } from "./universe-constituents";
import {
  isOverviewQuoteEligibleTicker,
} from "./overview-quote-snapshot";
import {
  doesOverviewCurrentRowNeedRepair,
  isOverviewCurrentRowComplete,
  loadOverviewCurrentData,
  isOverviewCurrentV2Enabled,
  refreshOverviewCurrentDataIfDue,
  type OverviewCurrentData,
} from "./overview-current-data";
import type { BarFreshnessStatus, Env, QuoteFreshnessStatus, RankingWindow, SnapshotEmptyResponse, SnapshotReadyResponse, SnapshotResponse } from "./types";

const uid = () => crypto.randomUUID();

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function previousWeekday(date: Date): Date {
  const d = new Date(date);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d;
}

function resolveAsOfDate(asOfDateInput?: string): string {
  if (!asOfDateInput) return latestUsMarketSessionAsOfDate(new Date());
  const isoDate = toISODate(previousWeekday(new Date(`${asOfDateInput}T00:00:00Z`)));
  return isUsMarketTradingDay(isoDate) ? isoDate : previousUsMarketTradingDay(isoDate);
}

const OVERALL_BREADTH_UNIVERSE_ID = "overall-market-proxy";
const NYSE_BREADTH_UNIVERSE_ID = "nyse-core";
const DB_BATCH_CHUNK_SIZE = 200;
const BAR_QUERY_TICKER_CHUNK_SIZE = 80;
const DEFAULT_CONFIG_ID = "default";
const MIN_NON_CORE_BREADTH_COVERAGE_PCT = 1;
const SP500_CORE_BREADTH_MIN_COVERAGE_PCT = 95;
const CORE_BREADTH_MIN_COVERAGE_PCT = 80;
const DEFAULT_BREADTH_CATCHUP_MAX_TICKERS = 1600;
const DEFAULT_BREADTH_CATCHUP_MAX_PASSES = 2;
export const CORE_BREADTH_UNIVERSE_IDS = [
  "sp500-core",
  "nasdaq-core",
  NYSE_BREADTH_UNIVERSE_ID,
  "russell2000-core",
  OVERALL_BREADTH_UNIVERSE_ID,
] as const;
const OVERVIEW_RS_ENABLED_GROUPS = new Set([
  "g-crypto",
  "g-metals-energy",
  "g-global",
  "g-country",
  "g-market-leaders",
  "g-thematic",
  "g-sector-etf",
  "g-sector-etf-eqwt",
]);
const OVERVIEW_RS_BENCHMARK_TICKER = "SPY";
const OVERVIEW_SNAPSHOT_RETENTION_DAYS = 14;
const SNAPSHOT_RETENTION_DELETE_CHUNK_SIZE = 25;
const OVERVIEW_SNAPSHOT_BAR_LOOKBACK_DAYS = 420;
export const OVERVIEW_FRESHNESS_MIN_COVERAGE_PCT = 90;
const OVERVIEW_FRESHNESS_CRITICAL_GROUP_TITLES = new Set([
  "US Index Futures",
  "US Index Futures (Equal Weight)",
  "Sector ETFs",
  "Sector ETFs (Equal Weight)",
]);
const OVERVIEW_FRESHNESS_UNSUPPORTED_TICKERS = new Set([
  "BKX",
  "INSR",
  "OSX",
  "XAU",
  "XNG",
]);
const UNKNOWN_OVERVIEW_SNAPSHOT_FRESHNESS_WARNING =
  "Snapshot freshness diagnostics are unavailable for the displayed data; refresh this page to rebuild row-level bar dates.";
const MISSING_OVERVIEW_DERIVED_METRICS_WARNING =
  "Snapshot derived metrics are unavailable for this stored snapshot; use Refresh Overview Data to rebuild it.";
let overviewFreshnessSchemaReady = false;

const SP500_SOURCE_LABEL = "S&P 500 constituents (datasets/s-and-p-500-companies CSV) + provider daily bars";
const NASDAQ_SOURCE_LABEL = "NasdaqTrader nasdaqtraded.txt (common-stock filter, listing exchange Q) + provider daily bars";
const NYSE_SOURCE_LABEL = "NasdaqTrader nasdaqtraded.txt (common-stock filter, listing exchange N) + provider daily bars";
const RUSSELL2000_SOURCE_LABEL =
  "Russell 2000 constituents (LSEG constituents table, filtered to NasdaqTrader common stocks) + provider daily bars";
const OVERALL_SOURCE_LABEL = "NasdaqTrader all US common stocks (same filter set) + provider daily bars";

type BreadthUniverseState = {
  universeTickers: Map<string, string[]>;
  sourceByUniverse: Map<string, string>;
  unavailable: Array<{ id: string; name: string; reason: string }>;
};

export type OverviewFreshnessStatus = "fresh" | "partial" | "stale";

export type OverviewFreshnessDiagnostics = {
  expectedAsOfDate: string;
  status: OverviewFreshnessStatus;
  eligibleCount: number;
  currentCount: number;
  staleCount: number;
  coveragePct: number;
  criticalMissingTickers: string[];
  minBarDate: string | null;
  maxBarDate: string | null;
  warning: string | null;
};

export function isOverviewFreshnessSufficientForScheduledSnapshot(
  status: string | null | undefined,
  _coveragePct: number | null | undefined,
): boolean {
  return status === "fresh";
}

type OverviewFreshnessTicker = {
  ticker: string;
  groupTitle: string;
  sectionTitle: string;
  critical: boolean;
  eligible: boolean;
};

type SnapshotMetaRow = {
  id: string;
  asOfDate: string;
  generatedAt: string;
  providerLabel: string;
  expectedAsOfDate?: string | null;
  freshnessStatus?: OverviewFreshnessStatus | string | null;
  freshnessCoveragePct?: number | null;
  freshnessCurrentCount?: number | null;
  freshnessEligibleCount?: number | null;
  freshnessCriticalMissingJson?: string | null;
  freshnessMinBarDate?: string | null;
  freshnessMaxBarDate?: string | null;
  freshnessWarning?: string | null;
  quoteOverlayRequestedCount?: number | null;
  quoteOverlayReturnedCount?: number | null;
  quoteOverlayError?: string | null;
  quoteOverlayMissingSampleJson?: string | null;
};

export class OverviewFreshnessError extends Error {
  diagnostics: OverviewFreshnessDiagnostics;

  constructor(diagnostics: OverviewFreshnessDiagnostics) {
    super(diagnostics.warning ?? "Overview market data freshness validation failed.");
    this.name = "OverviewFreshnessError";
    this.diagnostics = diagnostics;
  }
}

type UniverseSourceStatus = {
  lastSyncedAt: string | null;
  status: string | null;
  error: string | null;
  recordsCount: number | null;
};

type BreadthStoreResult = {
  universeId: string;
  asOfDate: string;
  stored: boolean;
  coveragePct: number;
  minCoveragePct: number;
  memberCount: number;
  totalUniverseMembers: number;
  reason?: string;
};

type BreadthCoverageDiagnostic = {
  universeId: string;
  memberCount: number;
  currentDateTickers: number;
  missingCurrentDateTickers: number;
  coveragePct: number;
  minCoveragePct: number;
  ok: boolean;
};

export type BreadthCoverageRefreshResult = {
  asOfDate: string;
  attemptedTickers: number;
  fetchedRows: number;
  writtenRows: number;
  diagnostics: BreadthCoverageDiagnostic[];
  unavailable: Array<{ id: string; name: string; reason: string }>;
};

function isStatusStale(lastSyncedAt: string | null | undefined, maxAgeDays = 14): boolean {
  if (!lastSyncedAt) return true;
  const t = new Date(lastSyncedAt).getTime();
  if (Number.isNaN(t)) return true;
  return Date.now() - t > maxAgeDays * 86400_000;
}

async function runStatementsInChunks(env: Env, statements: D1PreparedStatement[], chunkSize = DB_BATCH_CHUNK_SIZE): Promise<void> {
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    await env.DB.batch(chunk);
  }
}

function minBreadthCoveragePct(universeId: string): number {
  if (universeId === "sp500-core") return SP500_CORE_BREADTH_MIN_COVERAGE_PCT;
  if (CORE_BREADTH_UNIVERSE_IDS.includes(universeId as (typeof CORE_BREADTH_UNIVERSE_IDS)[number])) {
    return CORE_BREADTH_MIN_COVERAGE_PCT;
  }
  return MIN_NON_CORE_BREADTH_COVERAGE_PCT;
}

function buildPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.toLowerCase().includes("duplicate column name");
}

async function addColumnIfMissing(env: Env, sql: string): Promise<void> {
  try {
    await env.DB.prepare(sql).run();
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
  }
}

export async function ensureOverviewFreshnessSchema(env: Env): Promise<void> {
  if (overviewFreshnessSchemaReady) return;
  await addColumnIfMissing(env, "ALTER TABLE snapshots_meta ADD COLUMN expected_as_of_date TEXT");
  await addColumnIfMissing(env, "ALTER TABLE snapshots_meta ADD COLUMN freshness_status TEXT NOT NULL DEFAULT 'stale'");
  await addColumnIfMissing(env, "ALTER TABLE snapshots_meta ADD COLUMN freshness_current_count INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(env, "ALTER TABLE snapshots_meta ADD COLUMN freshness_eligible_count INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(env, "ALTER TABLE snapshots_meta ADD COLUMN freshness_coverage_pct REAL NOT NULL DEFAULT 0");
  await addColumnIfMissing(env, "ALTER TABLE snapshots_meta ADD COLUMN freshness_critical_missing_json TEXT NOT NULL DEFAULT '[]'");
  await addColumnIfMissing(env, "ALTER TABLE snapshots_meta ADD COLUMN freshness_min_bar_date TEXT");
  await addColumnIfMissing(env, "ALTER TABLE snapshots_meta ADD COLUMN freshness_max_bar_date TEXT");
  await addColumnIfMissing(env, "ALTER TABLE snapshots_meta ADD COLUMN freshness_warning TEXT");
  await addColumnIfMissing(env, "ALTER TABLE snapshots_meta ADD COLUMN quote_overlay_requested_count INTEGER");
  await addColumnIfMissing(env, "ALTER TABLE snapshots_meta ADD COLUMN quote_overlay_returned_count INTEGER");
  await addColumnIfMissing(env, "ALTER TABLE snapshots_meta ADD COLUMN quote_overlay_error TEXT");
  await addColumnIfMissing(env, "ALTER TABLE snapshots_meta ADD COLUMN quote_overlay_missing_sample_json TEXT");
  await addColumnIfMissing(env, "ALTER TABLE snapshot_rows ADD COLUMN bar_date TEXT");
  await addColumnIfMissing(env, "ALTER TABLE snapshot_rows ADD COLUMN quote_price REAL");
  await addColumnIfMissing(env, "ALTER TABLE snapshot_rows ADD COLUMN quote_prev_close REAL");
  await addColumnIfMissing(env, "ALTER TABLE snapshot_rows ADD COLUMN quote_change_1d REAL");
  await addColumnIfMissing(env, "ALTER TABLE snapshot_rows ADD COLUMN quote_source TEXT");
  await addColumnIfMissing(env, "ALTER TABLE snapshot_rows ADD COLUMN quote_fetched_at TEXT");
  await addColumnIfMissing(env, "ALTER TABLE snapshot_rows ADD COLUMN quote_freshness_status TEXT");
  await addColumnIfMissing(env, "ALTER TABLE snapshot_rows ADD COLUMN quote_freshness_reason TEXT");
  await addColumnIfMissing(env, "ALTER TABLE snapshot_rows ADD COLUMN bar_freshness_status TEXT");
  await addColumnIfMissing(env, "ALTER TABLE snapshot_rows ADD COLUMN bar_freshness_reason TEXT");
  overviewFreshnessSchemaReady = true;
}

function isOverviewFreshnessEligibleTicker(ticker: string, groupTitle: string): boolean {
  const normalized = ticker.trim().toUpperCase();
  const title = groupTitle.trim().toLowerCase();
  if (!normalized) return false;
  if (title.includes("crypto")) return false;
  if (normalized.includes("!") || normalized.includes("=")) return false;
  if (normalized.startsWith("^")) return false;
  if (OVERVIEW_FRESHNESS_UNSUPPORTED_TICKERS.has(normalized)) return false;
  return true;
}

function isBarFreshnessStatus(value: unknown): value is BarFreshnessStatus {
  return value === "fresh" || value === "stale" || value === "unavailable" || value === "unsupported";
}

function overviewFreshnessTickersFromConfig(config: Awaited<ReturnType<typeof loadConfig>>): OverviewFreshnessTicker[] {
  const byTicker = new Map<string, OverviewFreshnessTicker>();
  for (const section of config.sections) {
    if (!section.title.includes("Macro") && !section.title.includes("Equities")) continue;
    for (const group of section.groups) {
      const criticalGroup = OVERVIEW_FRESHNESS_CRITICAL_GROUP_TITLES.has(group.title);
      for (const item of group.items) {
        if (!item.enabled) continue;
        const ticker = item.ticker.trim().toUpperCase();
        const eligible = isOverviewFreshnessEligibleTicker(ticker, group.title);
        const existing = byTicker.get(ticker);
        byTicker.set(ticker, {
          ticker,
          groupTitle: existing?.groupTitle ?? group.title,
          sectionTitle: existing?.sectionTitle ?? section.title,
          eligible: existing?.eligible ?? eligible,
          critical: Boolean(existing?.critical || (criticalGroup && eligible)),
        });
      }
    }
  }
  return Array.from(byTicker.values()).sort((left, right) => left.ticker.localeCompare(right.ticker));
}

function parseCriticalMissingTickers(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((value) => String(value)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function buildFreshnessWarning(diagnostics: Omit<OverviewFreshnessDiagnostics, "warning">, staleExamples: Array<{ ticker: string; groupTitle: string; lastDate: string | null }>): string | null {
  if (diagnostics.status === "fresh") return null;
  const expected = diagnostics.expectedAsOfDate;
  const missing = diagnostics.criticalMissingTickers.slice(0, 8);
  if (missing.length > 0) {
    const details = staleExamples
      .filter((row) => missing.includes(row.ticker))
      .map((row) => `${row.ticker} (${row.groupTitle}) last updated ${row.lastDate ?? "N/A"}`)
      .join(", ");
    return `Stale: critical overview tickers are not current for ${expected}${details ? ` (${details})` : ""}.`;
  }
  const examples = staleExamples
    .slice(0, 8)
    .map((row) => `${row.ticker} (${row.groupTitle}) last updated ${row.lastDate ?? "N/A"}`)
    .join(", ");
  return `Partial: overview market data coverage is ${diagnostics.coveragePct.toFixed(1)}% (${diagnostics.currentCount}/${diagnostics.eligibleCount}) for ${expected}${examples ? ` (${examples})` : ""}.`;
}

function appendFreshnessWarning(base: string | null, extra: string): string {
  return base ? `${base} ${extra}` : extra;
}

function criticalTickersWithoutLiveQuotes(
  rows: Array<{ ticker: string; groupTitle: string }>,
  currentRows: Map<string, OverviewCurrentData>,
): string[] {
  const missing = new Set<string>();
  for (const row of rows) {
    const ticker = row.ticker.trim().toUpperCase();
    if (!OVERVIEW_FRESHNESS_CRITICAL_GROUP_TITLES.has(row.groupTitle)) continue;
    if (!isOverviewQuoteEligibleTicker(ticker, row.groupTitle)) continue;
    if (currentRows.get(ticker)?.status === "fresh") continue;
    missing.add(ticker);
  }
  return Array.from(missing).sort();
}

function currentRankValue(current: OverviewCurrentData | null | undefined, window: RankingWindow): number | null {
  if (!current) return null;
  if (window === "1D") return current.fieldSources.change1d ? current.change1d : null;
  if (window === "5D") return current.fieldSources.change5d ? current.change5d : null;
  if (window === "1W") return current.fieldSources.change1w ? current.change1w : null;
  if (window === "YTD") return current.fieldSources.ytd ? current.ytd : null;
  if (window === "52W") return current.fieldSources.pctFrom52wHigh ? current.pctFrom52wHigh : null;
  return current.fieldSources.change1w ? current.change1w : null;
}

function resolvedCurrentValue<T>(
  current: OverviewCurrentData | null | undefined,
  field: string,
  value: T | null | undefined,
): T | null {
  return current?.fieldSources[field] && value != null ? value : null;
}

function currentQuoteFreshnessStatus(current: OverviewCurrentData | null | undefined): QuoteFreshnessStatus {
  const price = resolvedCurrentValue(current, "price", current?.price);
  const change1d = resolvedCurrentValue(current, "change1d", current?.change1d);
  if (price != null && change1d != null) return "fresh";
  const tradingViewStatus = current?.providerStatuses.tradingview?.status;
  const alpacaAssetStatus = current?.providerStatuses.alpacaAsset?.status;
  if (tradingViewStatus === "unsupported" && alpacaAssetStatus === "unsupported") return "unsupported";
  if (Object.values(current?.providerStatuses ?? {}).some((diagnostic) => diagnostic.status === "stale")) return "stale";
  return "unavailable";
}

function normalizeFreshnessDiagnostics(input: Partial<OverviewFreshnessDiagnostics> & { expectedAsOfDate: string }): OverviewFreshnessDiagnostics {
  const eligibleCount = Math.max(0, Number(input.eligibleCount ?? 0));
  const currentCount = Math.max(0, Number(input.currentCount ?? 0));
  const coveragePct = eligibleCount > 0 ? (currentCount / eligibleCount) * 100 : 0;
  const criticalMissingTickers = Array.from(new Set((input.criticalMissingTickers ?? []).map((ticker) => ticker.toUpperCase()))).sort();
  const base = {
    expectedAsOfDate: input.expectedAsOfDate,
    status: input.status ?? "stale",
    eligibleCount,
    currentCount,
    staleCount: Math.max(0, Number(input.staleCount ?? eligibleCount - currentCount)),
    coveragePct: Number.isFinite(Number(input.coveragePct)) ? Number(input.coveragePct) : coveragePct,
    criticalMissingTickers,
    minBarDate: input.minBarDate ?? null,
    maxBarDate: input.maxBarDate ?? null,
    warning: input.warning ?? null,
  };
  return base;
}

export async function computeOverviewFreshnessDiagnostics(
  env: Env,
  expectedAsOfDate: string,
  configId = DEFAULT_CONFIG_ID,
): Promise<OverviewFreshnessDiagnostics> {
  const config = await loadConfig(env, configId);
  return await computeOverviewFreshnessDiagnosticsForConfig(env, config, expectedAsOfDate);
}

async function computeOverviewFreshnessDiagnosticsForConfig(
  env: Env,
  config: Awaited<ReturnType<typeof loadConfig>>,
  expectedAsOfDate: string,
): Promise<OverviewFreshnessDiagnostics> {
  const candidates = overviewFreshnessTickersFromConfig(config).filter((row) => row.eligible);
  if (candidates.length === 0) {
    return {
      expectedAsOfDate,
      status: "stale",
      eligibleCount: 0,
      currentCount: 0,
      staleCount: 0,
      coveragePct: 0,
      criticalMissingTickers: [],
      minBarDate: null,
      maxBarDate: null,
      warning: `Stale: no eligible overview tickers were available to validate for ${expectedAsOfDate}.`,
    };
  }

  const latestByTicker = new Map<string, string | null>();
  const tickers = candidates.map((row) => row.ticker);
  for (let index = 0; index < tickers.length; index += BAR_QUERY_TICKER_CHUNK_SIZE) {
    const chunk = tickers.slice(index, index + BAR_QUERY_TICKER_CHUNK_SIZE);
    const placeholders = buildPlaceholders(chunk.length);
    const rows = await getMarketDataDb(env).prepare(
      `SELECT ticker, MAX(date) as lastDate
       FROM alpaca_daily_bars
       WHERE feed = ?
         AND ticker IN (${placeholders})
         AND date <= ?
       GROUP BY ticker`,
    )
      .bind(marketDataFeed(env), ...chunk, expectedAsOfDate)
      .all<{ ticker: string; lastDate: string | null }>();
    for (const row of rows.results ?? []) {
      latestByTicker.set(row.ticker.toUpperCase(), row.lastDate ?? null);
    }
  }

  let currentCount = 0;
  let minBarDate: string | null = null;
  let maxBarDate: string | null = null;
  const criticalMissingTickers: string[] = [];
  const staleExamples: Array<{ ticker: string; groupTitle: string; lastDate: string | null }> = [];

  for (const candidate of candidates) {
    const lastDate = latestByTicker.get(candidate.ticker) ?? null;
    if (lastDate) {
      if (!minBarDate || lastDate < minBarDate) minBarDate = lastDate;
      if (!maxBarDate || lastDate > maxBarDate) maxBarDate = lastDate;
    }
    if (lastDate === expectedAsOfDate) {
      currentCount += 1;
      continue;
    }
    staleExamples.push({ ticker: candidate.ticker, groupTitle: candidate.groupTitle, lastDate });
    if (candidate.critical) criticalMissingTickers.push(candidate.ticker);
  }

  const eligibleCount = candidates.length;
  const coveragePct = eligibleCount > 0 ? (currentCount / eligibleCount) * 100 : 0;
  const staleCount = Math.max(0, eligibleCount - currentCount);
  const status: OverviewFreshnessStatus = criticalMissingTickers.length > 0
    ? "stale"
    : staleCount > 0
      ? "partial"
      : "fresh";
  const base = {
    expectedAsOfDate,
    status,
    eligibleCount,
    currentCount,
    staleCount,
    coveragePct,
    criticalMissingTickers: Array.from(new Set(criticalMissingTickers)).sort(),
    minBarDate,
    maxBarDate,
  };

  return {
    ...base,
    warning: buildFreshnessWarning(base, staleExamples),
  };
}

async function loadOverviewFreshnessMissingTickers(
  env: Env,
  config: Awaited<ReturnType<typeof loadConfig>>,
  expectedAsOfDate: string,
  options: { criticalOnly?: boolean } = {},
): Promise<string[]> {
  const candidates = overviewFreshnessTickersFromConfig(config)
    .filter((row) => row.eligible && (!options.criticalOnly || row.critical));
  const tickers = candidates.map((row) => row.ticker);
  if (tickers.length === 0) return [];
  const current = new Set<string>();
  for (let index = 0; index < tickers.length; index += BAR_QUERY_TICKER_CHUNK_SIZE) {
    const chunk = tickers.slice(index, index + BAR_QUERY_TICKER_CHUNK_SIZE);
    const placeholders = buildPlaceholders(chunk.length);
    const rows = await getMarketDataDb(env).prepare(
      `SELECT DISTINCT ticker
       FROM alpaca_daily_bars
       WHERE feed = ?
         AND ticker IN (${placeholders})
         AND date = ?`,
    )
      .bind(marketDataFeed(env), ...chunk, expectedAsOfDate)
      .all<{ ticker: string }>();
    for (const row of rows.results ?? []) current.add(row.ticker.toUpperCase());
  }
  return tickers.filter((ticker) => !current.has(ticker.toUpperCase()));
}

function overviewConfigTickers(config: Awaited<ReturnType<typeof loadConfig>>): string[] {
  return Array.from(new Set(
    config.sections
      .filter((section) => section.title.includes("Macro") || section.title.includes("Equities"))
      .flatMap((section) => section.groups)
      .flatMap((group) => group.items)
      .filter((item) => item.enabled)
      .map((item) => item.ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
}

function overviewCriticalFreshnessTickers(config: Awaited<ReturnType<typeof loadConfig>>): string[] {
  return overviewFreshnessTickersFromConfig(config)
    .filter((row) => row.eligible && row.critical)
    .map((row) => row.ticker);
}

export async function refreshAndStoreOverviewSnapshot(
  env: Env,
  asOfDateInput?: string,
  configId = DEFAULT_CONFIG_ID,
  _options: { requireFreshness?: boolean } = {},
): Promise<{ snapshotId: string; asOfDate: string; freshness: OverviewFreshnessDiagnostics; fetchedRows: number; writtenRows: number }> {
  const asOfDate = resolveAsOfDate(asOfDateInput);
  const config = await loadConfig(env, configId);
  const criticalTickers = Array.from(new Set(overviewCriticalFreshnessTickers(config).map((ticker) => ticker.toUpperCase())));
  const criticalTickerSet = new Set(criticalTickers);
  const startDate = toISODate(new Date(new Date(`${asOfDate}T00:00:00Z`).getTime() - 21 * 86400_000));
  let fetchedRows = 0;
  let writtenRows = 0;
  let freshness = await computeOverviewFreshnessDiagnosticsForConfig(env, config, asOfDate);
  const missingTickers = await loadOverviewFreshnessMissingTickers(env, config, asOfDate);
  const boundedRefreshTickers = Array.from(new Set([
    ...missingTickers.filter((ticker) => criticalTickerSet.has(ticker.toUpperCase())),
    ...missingTickers,
  ])).slice(0, 80);
  if (boundedRefreshTickers.length > 0) {
    try {
      const provider = getProvider(env, { fallbackEnabled: false });
      const refresh = await refreshDailyBarsIncremental(env, {
        provider,
        tickers: boundedRefreshTickers,
        startDate,
        endDate: asOfDate,
        replaceExisting: true,
        providerBatchSize: 80,
        target: "market",
        mirrorLatestToLegacy: true,
      });
      fetchedRows += refresh.fetchedRows;
      writtenRows += refresh.writtenRows;
      freshness = await computeOverviewFreshnessDiagnosticsForConfig(env, config, asOfDate);
    } catch (error) {
      console.error("overview bounded daily-bar refresh failed", { tickers: boundedRefreshTickers.length, error });
    }
  }

  const currentDataEnabled = isOverviewCurrentV2Enabled(env);
  if (currentDataEnabled) {
    try {
      const storedCurrentRows = await loadOverviewCurrentData(env, configId, asOfDate);
      await refreshOverviewCurrentDataIfDue(env, configId, asOfDate, new Date(), {
        forceCompleted: storedCurrentRows.size === 0,
      });
    } catch (error) {
      console.error("overview current-data refresh failed; snapshot will fail closed", error);
    }
  }

  const result = await computeAndStoreSnapshot(env, asOfDate, configId, {
    includeBreadth: false,
    freshnessDiagnostics: freshness,
  });
  return { ...result, fetchedRows, writtenRows };
}

export function freshnessDiagnosticsFromSnapshotMeta(meta: SnapshotMetaRow | null | undefined, fallbackExpectedAsOfDate: string): OverviewFreshnessDiagnostics | null {
  if (!meta) return null;
  const expectedAsOfDate = meta.expectedAsOfDate ?? meta.asOfDate ?? fallbackExpectedAsOfDate;
  const eligibleCount = Number(meta.freshnessEligibleCount ?? 0);
  const currentCount = Number(meta.freshnessCurrentCount ?? 0);
  const coveragePct = Number(meta.freshnessCoveragePct ?? (eligibleCount > 0 ? (currentCount / eligibleCount) * 100 : 0));
  if (eligibleCount <= 0) {
    return normalizeFreshnessDiagnostics({
      expectedAsOfDate,
      status: "stale",
      eligibleCount: 0,
      currentCount: 0,
      staleCount: 0,
      coveragePct: 0,
      criticalMissingTickers: [],
      minBarDate: null,
      maxBarDate: null,
      warning: meta.freshnessWarning ?? UNKNOWN_OVERVIEW_SNAPSHOT_FRESHNESS_WARNING,
    });
  }
  return normalizeFreshnessDiagnostics({
    expectedAsOfDate,
    status: meta.freshnessStatus === "fresh" || meta.freshnessStatus === "partial" || meta.freshnessStatus === "stale" ? meta.freshnessStatus : "stale",
    eligibleCount,
    currentCount,
    staleCount: Math.max(0, eligibleCount - currentCount),
    coveragePct,
    criticalMissingTickers: parseCriticalMissingTickers(meta.freshnessCriticalMissingJson),
    minBarDate: meta.freshnessMinBarDate ?? null,
    maxBarDate: meta.freshnessMaxBarDate ?? null,
    warning: meta.freshnessWarning ?? null,
  });
}

export async function cleanupOldOverviewSnapshots(
  env: Env,
  retentionDays = OVERVIEW_SNAPSHOT_RETENTION_DAYS,
): Promise<{ cutoffDate: string; deletedSnapshots: number; deletedRows: number; deletedOrphanRows: number }> {
  const cutoffDate = toISODate(new Date(Date.now() - retentionDays * 86400_000));
  const orphanRowCount = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM snapshot_rows WHERE snapshot_id NOT IN (SELECT id FROM snapshots_meta)",
  ).first<{ count: number | null }>();
  const deletedOrphanRows = orphanRowCount?.count ?? 0;
  if (deletedOrphanRows > 0) {
    await env.DB.prepare(
      "DELETE FROM snapshot_rows WHERE snapshot_id NOT IN (SELECT id FROM snapshots_meta)",
    ).run();
  }
  const staleSnapshots = await env.DB.prepare(
    `SELECT sm.id as id
       FROM snapshots_meta sm
       LEFT JOIN (
         SELECT config_id, MAX(as_of_date) as latest_as_of_date
         FROM snapshots_meta
         GROUP BY config_id
       ) latest
         ON latest.config_id = sm.config_id
        AND latest.latest_as_of_date = sm.as_of_date
      WHERE sm.as_of_date < ?
        AND latest.latest_as_of_date IS NULL
      ORDER BY sm.generated_at ASC`,
  )
    .bind(cutoffDate)
    .all<{ id: string }>();
  const staleSnapshotIds = (staleSnapshots.results ?? []).map((row) => row.id).filter(Boolean);
  if (staleSnapshotIds.length === 0) {
    return {
      cutoffDate,
      deletedSnapshots: 0,
      deletedRows: deletedOrphanRows,
      deletedOrphanRows,
    };
  }

  let deletedRows = deletedOrphanRows;
  for (let i = 0; i < staleSnapshotIds.length; i += SNAPSHOT_RETENTION_DELETE_CHUNK_SIZE) {
    const chunk = staleSnapshotIds.slice(i, i + SNAPSHOT_RETENTION_DELETE_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = buildPlaceholders(chunk.length);
    const rowCount = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM snapshot_rows WHERE snapshot_id IN (${placeholders})`,
    )
      .bind(...chunk)
      .first<{ count: number | null }>();
    deletedRows += rowCount?.count ?? 0;
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM snapshot_rows WHERE snapshot_id IN (${placeholders})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM snapshots_meta WHERE id IN (${placeholders})`).bind(...chunk),
    ]);
  }

  return {
    cutoffDate,
    deletedSnapshots: staleSnapshotIds.length,
    deletedRows,
    deletedOrphanRows,
  };
}

async function ensureSymbolsExist(env: Env, tickers: string[]): Promise<void> {
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean)));
  if (unique.length === 0) return;
  const statements = unique.map((ticker) =>
    env.DB.prepare("INSERT OR IGNORE INTO symbols (ticker, name, asset_class) VALUES (?, ?, ?)")
      .bind(ticker, ticker, "equity"),
  );
  await runStatementsInChunks(env, statements);
}

async function loadBarsForTickers(
  env: Env,
  tickers: string[],
  asOfDate: string,
): Promise<Array<{ ticker: string; date: string; c: number; volume: number | null }>> {
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean)));
  const rows: Array<{ ticker: string; date: string; c: number; volume: number | null }> = [];
  for (let i = 0; i < unique.length; i += BAR_QUERY_TICKER_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + BAR_QUERY_TICKER_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const sql = `SELECT ticker, date, c, volume
      FROM alpaca_daily_bars
      WHERE feed = ?
        AND ticker IN (${placeholders})
        AND date <= ?
      ORDER BY ticker, date`;
    const result = await getMarketDataDb(env).prepare(sql)
      .bind(marketDataFeed(env), ...chunk, asOfDate)
      .all<{ ticker: string; date: string; c: number; volume: number | null }>();
    rows.push(...(result.results ?? []));
  }
  return rows;
}

async function loadOverviewSnapshotBarsForTickers(
  env: Env,
  tickers: string[],
  asOfDate: string,
): Promise<Array<{ ticker: string; date: string; c: number }>> {
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean)));
  const rows: Array<{ ticker: string; date: string; c: number }> = [];
  const startDate = toISODate(new Date(new Date(`${asOfDate}T00:00:00Z`).getTime() - OVERVIEW_SNAPSHOT_BAR_LOOKBACK_DAYS * 86400_000));
  for (let i = 0; i < unique.length; i += BAR_QUERY_TICKER_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + BAR_QUERY_TICKER_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await getMarketDataDb(env).prepare(
      `SELECT ticker, date, c
         FROM alpaca_daily_bars
        WHERE feed = ?
          AND ticker IN (${placeholders})
          AND date >= ?
          AND date <= ?
        ORDER BY ticker, date`,
    )
      .bind(marketDataFeed(env), ...chunk, startDate, asOfDate)
      .all<{ ticker: string; date: string; c: number }>();
    rows.push(...(result.results ?? []));
  }
  return rows;
}

async function loadTickersWithBarOnDate(env: Env, tickers: string[], date: string): Promise<Set<string>> {
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean)));
  const out = new Set<string>();
  for (let i = 0; i < unique.length; i += BAR_QUERY_TICKER_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + BAR_QUERY_TICKER_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await getMarketDataDb(env).prepare(
      `SELECT DISTINCT ticker
       FROM alpaca_daily_bars
       WHERE feed = ?
         AND ticker IN (${placeholders})
         AND date = ?`,
    )
      .bind(marketDataFeed(env), ...chunk, date)
      .all<{ ticker: string }>();
    for (const row of result.results ?? []) {
      out.add(row.ticker.toUpperCase());
    }
  }
  return out;
}

async function buildBreadthCoverageDiagnostics(
  env: Env,
  breadthState: BreadthUniverseState,
  asOfDate: string,
  universeIds?: Set<string>,
): Promise<BreadthCoverageDiagnostic[]> {
  const diagnostics: BreadthCoverageDiagnostic[] = [];
  for (const [universeId, tickers] of breadthState.universeTickers.entries()) {
    if (universeIds && !universeIds.has(universeId)) continue;
    const currentTickers = await loadTickersWithBarOnDate(env, tickers, asOfDate);
    const memberCount = tickers.length;
    const currentDateTickers = currentTickers.size;
    const missingCurrentDateTickers = Math.max(0, memberCount - currentDateTickers);
    const coveragePct = memberCount > 0 ? (currentDateTickers / memberCount) * 100 : 0;
    const minCoveragePct = minBreadthCoveragePct(universeId);
    diagnostics.push({
      universeId,
      memberCount,
      currentDateTickers,
      missingCurrentDateTickers,
      coveragePct,
      minCoveragePct,
      ok: memberCount > 0 && coveragePct >= minCoveragePct,
    });
  }
  return diagnostics;
}

async function loadUniverseTickers(env: Env, universeId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT ticker FROM universe_symbols WHERE universe_id = ? ORDER BY ticker ASC",
  )
    .bind(universeId)
    .all<{ ticker: string }>();
  return Array.from(new Set((rows.results ?? []).map((r) => r.ticker.toUpperCase()).filter(Boolean)));
}

async function loadUniverseSourceStatus(env: Env, sourceKey: string): Promise<UniverseSourceStatus | null> {
  return await env.DB.prepare(
    "SELECT last_synced_at as lastSyncedAt, status, error, records_count as recordsCount FROM etf_constituent_sync_status WHERE etf_ticker = ? LIMIT 1",
  )
    .bind(sourceKey)
    .first<UniverseSourceStatus>();
}

async function saveUniverseSourceStatus(
  env: Env,
  sourceKey: string,
  status: "ok" | "error",
  source: string,
  recordsCount: number,
  errorMessage: string | null,
): Promise<void> {
  const errorText = errorMessage ? errorMessage.slice(0, 700) : null;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO etf_constituent_sync_status (etf_ticker, last_synced_at, status, error, source, records_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
  )
    .bind(sourceKey, new Date().toISOString(), status, errorText, source.slice(0, 120), recordsCount)
    .run();
}

async function ensureUniverseMembership(env: Env, universeId: string, universeName: string, tickers: string[]): Promise<void> {
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean)));
  if (unique.length === 0) return;
  await ensureSymbolsExist(env, unique);
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO universes (id, name) VALUES (?, ?)").bind(universeId, universeName),
    env.DB.prepare("DELETE FROM universe_symbols WHERE universe_id = ?").bind(universeId),
  ]);

  const chunkSize = 20;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const statements = chunk.map((ticker) =>
      env.DB.prepare("INSERT OR IGNORE INTO universe_symbols (universe_id, ticker) VALUES (?, ?)").bind(universeId, ticker),
    );
    await env.DB.batch(statements);
  }
}

type UniverseSyncDef = {
  id: string;
  name: string;
  sourceLabel: string;
  sourceKey: string;
  staleAfterDays: number;
  unavailableReason: string;
  fetchTickers: () => Promise<string[]>;
};

function dedupeTickers(tickers: string[]): string[] {
  return Array.from(new Set(tickers.map((ticker) => ticker.toUpperCase()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

async function syncUniverseFromSource(
  env: Env,
  def: UniverseSyncDef,
  universeTickers: Map<string, string[]>,
  sourceByUniverse: Map<string, string>,
  unavailable: Array<{ id: string; name: string; reason: string }>,
): Promise<void> {
  const existing = await loadUniverseTickers(env, def.id);
  const status = await loadUniverseSourceStatus(env, def.sourceKey);
  const shouldRefresh = existing.length === 0 || status?.status !== "ok" || isStatusStale(status?.lastSyncedAt, def.staleAfterDays);

  let tickers = existing;
  let sourceLabel = def.sourceLabel;

  if (shouldRefresh) {
    try {
      const fetched = dedupeTickers(await def.fetchTickers());
      if (fetched.length === 0) {
        throw new Error(`No tickers returned for ${def.id}`);
      }
      await ensureUniverseMembership(env, def.id, def.name, fetched);
      tickers = fetched;
      await saveUniverseSourceStatus(env, def.sourceKey, "ok", def.sourceLabel, fetched.length, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "constituent sync failed";
      console.error("breadth universe source sync failed", { universeId: def.id, error: message });
      await saveUniverseSourceStatus(env, def.sourceKey, "error", def.sourceLabel, existing.length, message);
      if (existing.length === 0) {
        unavailable.push({
          id: def.id,
          name: def.name,
          reason: def.unavailableReason,
        });
        return;
      }
      sourceLabel = `${def.sourceLabel} (cached universe reused; latest sync attempt failed)`;
    }
  }

  if (tickers.length === 0) {
    unavailable.push({
      id: def.id,
      name: def.name,
      reason: def.unavailableReason,
    });
    return;
  }

  universeTickers.set(def.id, tickers);
  sourceByUniverse.set(def.id, sourceLabel);
}

async function ensureBreadthUniverseMemberships(env: Env): Promise<BreadthUniverseState> {
  const universeTickers = new Map<string, string[]>();
  const sourceByUniverse = new Map<string, string>();
  const unavailable: Array<{ id: string; name: string; reason: string }> = [];
  let nasdaqUniverseCache:
    | {
        nasdaqTickers: string[];
        nyseTickers: string[];
        allCommonTickers: string[];
      }
    | null = null;
  const loadNasdaqUniverseCache = async () => {
    if (!nasdaqUniverseCache) {
      nasdaqUniverseCache = await loadNasdaqTraderUniverses();
    }
    return nasdaqUniverseCache;
  };

  await syncUniverseFromSource(
    env,
    {
      id: "nasdaq-core",
      name: "NASDAQ",
      sourceLabel: NASDAQ_SOURCE_LABEL,
      sourceKey: "universe:nasdaq-core",
      staleAfterDays: 1,
      unavailableReason: "NASDAQ constituent source fetch failed and no cached NASDAQ membership is available",
      fetchTickers: async () => (await loadNasdaqUniverseCache()).nasdaqTickers,
    },
    universeTickers,
    sourceByUniverse,
    unavailable,
  );

  await syncUniverseFromSource(
    env,
    {
      id: NYSE_BREADTH_UNIVERSE_ID,
      name: "NYSE",
      sourceLabel: NYSE_SOURCE_LABEL,
      sourceKey: "universe:nyse-core",
      staleAfterDays: 1,
      unavailableReason: "NYSE constituent source fetch failed and no cached NYSE membership is available",
      fetchTickers: async () => (await loadNasdaqUniverseCache()).nyseTickers,
    },
    universeTickers,
    sourceByUniverse,
    unavailable,
  );

  await syncUniverseFromSource(
    env,
    {
      id: "sp500-core",
      name: "S&P 500",
      sourceLabel: SP500_SOURCE_LABEL,
      sourceKey: "universe:sp500-core",
      staleAfterDays: 7,
      unavailableReason: "S&P 500 constituent source fetch failed and no cached S&P 500 membership is available",
      fetchTickers: async () => {
        try {
          const allCommon = new Set((await loadNasdaqUniverseCache()).allCommonTickers);
          return await loadSp500Constituents(allCommon);
        } catch {
          return await loadSp500Constituents(undefined);
        }
      },
    },
    universeTickers,
    sourceByUniverse,
    unavailable,
  );

  await syncUniverseFromSource(
    env,
    {
      id: "russell2000-core",
      name: "Russell 2000",
      sourceLabel: RUSSELL2000_SOURCE_LABEL,
      sourceKey: "universe:russell2000-core",
      staleAfterDays: 14,
      unavailableReason: "Russell 2000 constituent source fetch failed and no cached Russell 2000 membership is available",
      fetchTickers: async () => {
        const allCommon = new Set((await loadNasdaqUniverseCache()).allCommonTickers);
        return await loadRussell2000Constituents(allCommon);
      },
    },
    universeTickers,
    sourceByUniverse,
    unavailable,
  );

  await syncUniverseFromSource(
    env,
    {
      id: OVERALL_BREADTH_UNIVERSE_ID,
      name: "Overall Market",
      sourceLabel: OVERALL_SOURCE_LABEL,
      sourceKey: "universe:overall-market-core",
      staleAfterDays: 1,
      unavailableReason: "Overall-market constituent source fetch failed and no cached overall-market membership is available",
      fetchTickers: async () => (await loadNasdaqUniverseCache()).allCommonTickers,
    },
    universeTickers,
    sourceByUniverse,
    unavailable,
  );

  if (!universeTickers.has(OVERALL_BREADTH_UNIVERSE_ID)) {
    const unionTickers = dedupeTickers([...universeTickers.values()].flat());
    if (unionTickers.length > 0) {
      await ensureUniverseMembership(env, OVERALL_BREADTH_UNIVERSE_ID, "Overall Market", unionTickers);
      universeTickers.set(OVERALL_BREADTH_UNIVERSE_ID, unionTickers);
      sourceByUniverse.set(OVERALL_BREADTH_UNIVERSE_ID, "Union of available non-proxy universes + provider daily bars");
    }
  }

  unavailable.push({
    id: "worden-common-stock-universe",
    name: "Overall Market (Worden Common Stock Universe)",
    reason: "Proprietary universe; no free direct feed is available",
  });

  return { universeTickers, sourceByUniverse, unavailable };
}

type SnapshotComputeOptions = {
  includeBreadth?: boolean;
  freshnessDiagnostics?: OverviewFreshnessDiagnostics | null;
};

export async function computeAndStoreSnapshot(
  env: Env,
  asOfDateInput?: string,
  configId = "default",
  options: SnapshotComputeOptions = {},
): Promise<{ snapshotId: string; asOfDate: string; freshness: OverviewFreshnessDiagnostics }> {
  const includeBreadth = options.includeBreadth ?? true;
  const asOfDate = resolveAsOfDate(asOfDateInput);
  const generatedAt = new Date().toISOString();
  await ensureOverviewFreshnessSchema(env);
  const config = await loadConfig(env, configId);
  const providerLabel = `TradingView scanner + Alpaca ${(env.ALPACA_FEED ?? "iex").toLowerCase()} bars`;

  const dashboardTickers = Array.from(
    new Set(
      config.sections
        .flatMap((s) => s.groups)
        .flatMap((g) => g.items)
        .filter((it) => it.enabled)
        .map((it) => it.ticker),
    ),
  );
  const breadthState = includeBreadth
    ? await (async (): Promise<BreadthUniverseState> => {
      try {
        return await ensureBreadthUniverseMemberships(env);
      } catch (error) {
        console.error("breadth universe setup failed; continuing with existing memberships", error);
        return {
          universeTickers: new Map<string, string[]>(),
          sourceByUniverse: new Map<string, string>(),
          unavailable: [],
        };
      }
    })()
    : {
      universeTickers: new Map<string, string[]>(),
      sourceByUniverse: new Map<string, string>(),
      unavailable: [],
    };
  const freshness = options.freshnessDiagnostics ?? await computeOverviewFreshnessDiagnosticsForConfig(env, config, asOfDate);

  const needsBenchmarkBars = config.sections.some((section) =>
    section.groups.some((group) =>
      OVERVIEW_RS_ENABLED_GROUPS.has(group.id) && group.items.some((item) => item.enabled),
    ),
  );
  const snapshotBarTickers = needsBenchmarkBars
    ? Array.from(new Set([...dashboardTickers, OVERVIEW_RS_BENCHMARK_TICKER]))
    : dashboardTickers;
  const barRows = await loadOverviewSnapshotBarsForTickers(env, snapshotBarTickers, asOfDate);

  const symbols = await env.DB.prepare("SELECT ticker, name FROM symbols").all<{ ticker: string; name: string }>();
  const symbolNameMap = new Map((symbols.results ?? []).map((s) => [s.ticker, s.name]));

  const barsByTicker = new Map<string, { dates: string[]; closes: number[] }>();
  for (const row of barRows) {
    const existing = barsByTicker.get(row.ticker) ?? { dates: [], closes: [] };
    existing.dates.push(row.date);
    existing.closes.push(row.c);
    barsByTicker.set(row.ticker, existing);
  }
  const benchmarkBars = barsByTicker.get(OVERVIEW_RS_BENCHMARK_TICKER) ?? { dates: [], closes: [] };

  const preCleanup = await cleanupOldOverviewSnapshots(env);
  if (preCleanup.deletedSnapshots > 0 || preCleanup.deletedRows > 0) {
    console.log("overview snapshot cleanup removed old rows before refresh", preCleanup);
  }
  const snapshotId = uid();
  const previousSnapshot = await env.DB.prepare(
    "SELECT id FROM snapshots_meta WHERE config_id = ? AND as_of_date = ? LIMIT 1",
  )
    .bind(configId, asOfDate)
    .first<{ id: string }>();

  const snapshotRows: Array<{
    sectionId: string;
    groupId: string;
    groupTitle: string;
    ticker: string;
    displayName: string;
    holdings: string[] | null;
    barDate: string | null;
    rankingWindowDefault: RankingWindow;
    price: number;
    change1d: number;
    change1w: number;
    change5d: number;
    change3m: number;
    change6m: number;
    change21d: number;
    ytd: number;
    pctFrom52wHigh: number;
    sparkline: number[];
    relativeStrength30dVsSpy: number[] | null;
    above20Sma: boolean | null;
    above50Sma: boolean | null;
    above200Sma: boolean | null;
    rankKey: number;
  }> = [];
  for (const section of config.sections) {
    for (const group of section.groups) {
      const rows = group.items
        .filter((item) => item.enabled)
        .map((item) => {
          const bars = barsByTicker.get(item.ticker);
          const metrics = computeMetrics(bars?.dates ?? [], bars?.closes ?? []);
          const cleaned = sanitizeBarSeries(bars?.dates ?? [], bars?.closes ?? []);
          const relativeStrength30dVsSpy = OVERVIEW_RS_ENABLED_GROUPS.has(group.id)
            ? buildRelativeStrengthSeries(
              bars?.dates ?? [],
              bars?.closes ?? [],
              benchmarkBars.dates,
              benchmarkBars.closes,
            )
            : null;
          return {
            sectionId: section.id,
            groupId: group.id,
            groupTitle: group.title,
            ticker: item.ticker,
            displayName: String(item.displayName ?? symbolNameMap.get(item.ticker) ?? item.ticker),
            holdings: item.holdings ?? null,
            barDate: cleaned.dates.at(-1) ?? null,
            rankingWindowDefault: group.rankingWindowDefault,
            ...metrics,
            relativeStrength30dVsSpy,
            above20Sma: isPriceAboveSma(cleaned.closes, 20),
            above50Sma: isPriceAboveSma(cleaned.closes, 50),
            above200Sma: isPriceAboveSma(cleaned.closes, 200),
            rankKey: rankValue(metrics, group.rankingWindowDefault),
          };
        })
        .sort((a, b) => b.rankKey - a.rankKey);
      snapshotRows.push(...rows);
    }
  }

  let currentRows = new Map<string, OverviewCurrentData>();
  let currentDataError: string | null = null;
  if (isOverviewCurrentV2Enabled(env)) {
    try {
      currentRows = await loadOverviewCurrentData(env, configId, asOfDate);
    } catch (error) {
      currentDataError = error instanceof Error ? error.message : "Current overview data could not be loaded.";
      console.error("overview current-data load failed; snapshot will contain unavailable scalars", error);
    }
  }
  const uniqueSnapshotTickers = Array.from(new Set(snapshotRows.map((row) => row.ticker.toUpperCase())));
  const currentDataEnabled = isOverviewCurrentV2Enabled(env);
  const freshCurrentTickers = uniqueSnapshotTickers.filter((ticker) => {
    const row = currentRows.get(ticker);
    return row?.status === "fresh" && isOverviewCurrentRowComplete(row);
  });
  const missingCurrentTickers = currentDataEnabled
    ? uniqueSnapshotTickers.filter((ticker) => {
      const row = currentRows.get(ticker);
      return row?.status !== "fresh" || !isOverviewCurrentRowComplete(row);
    })
    : [];
  const repairableCurrentTickers = currentDataEnabled
    ? uniqueSnapshotTickers.filter((ticker) => {
      const row = currentRows.get(ticker);
      return !row || doesOverviewCurrentRowNeedRepair(row);
    })
    : [];
  const currentProviderErrors = Array.from(currentRows.values())
    .flatMap((row) => Object.values(row.providerStatuses))
    .filter((diagnostic) => diagnostic.status === "provider-error" || diagnostic.status === "rate-limited" || diagnostic.status === "auth-blocked")
    .map((diagnostic) => diagnostic.reason);
  const quoteOverlayDiagnostics = {
    eligibleTickers: uniqueSnapshotTickers.length,
    returnedSnapshots: freshCurrentTickers.length,
    providerError: currentDataError ?? currentProviderErrors[0] ?? null,
    sampleMissingTickers: missingCurrentTickers.slice(0, 20),
  };
  let finalFreshnessWarning = freshness.warning;
  if (missingCurrentTickers.length > 0) {
    finalFreshnessWarning = appendFreshnessWarning(
      finalFreshnessWarning,
      `${missingCurrentTickers.length} overview tickers have unavailable current-session fields; stale values were suppressed.`,
    );
  }
  const missingLiveCriticalQuotes = criticalTickersWithoutLiveQuotes(snapshotRows, currentRows);
  if (missingLiveCriticalQuotes.length > 0) {
    finalFreshnessWarning = appendFreshnessWarning(
      finalFreshnessWarning,
      `Current-session values are unavailable for critical symbols: ${missingLiveCriticalQuotes.slice(0, 8).join(", ")}.`,
    );
  }
  const finalFreshness = {
    ...freshness,
    status: repairableCurrentTickers.length > 0 && freshness.status === "fresh"
      ? "partial" as const
      : freshness.status,
    warning: finalFreshnessWarning,
  };

  const rowInserts = [];
  for (const row of snapshotRows) {
    const current = currentRows.get(row.ticker.toUpperCase()) ?? null;
    const barIsFresh = row.barDate === asOfDate;
    const quotePrice = resolvedCurrentValue(current, "price", current?.price);
    const quoteChange1d = resolvedCurrentValue(current, "change1d", current?.change1d);
    const quotePrevClose = quotePrice != null && quoteChange1d != null && quoteChange1d !== -100
      ? quotePrice / (1 + quoteChange1d / 100)
      : null;
    const currentRankKey = currentRankValue(current, row.rankingWindowDefault);
    const quoteFreshnessStatus = currentQuoteFreshnessStatus(current);
    const barFreshnessStatus: BarFreshnessStatus = barIsFresh ? "fresh" : row.barDate ? "stale" : "unavailable";
    const barFreshnessReason = barIsFresh
      ? `Stored Alpaca daily bar is current for ${asOfDate}.`
      : row.barDate
        ? `Last stored daily bar is ${row.barDate}; expected ${asOfDate}.`
        : `No stored daily bar is available for ${row.ticker}.`;
    rowInserts.push(
      env.DB.prepare(
        "INSERT OR REPLACE INTO snapshot_rows (snapshot_id, section_id, group_id, ticker, display_name, price, change_1d, change_1w, change_5d, change_3m, change_6m, change_21d, ytd, pct_from_52w_high, sparkline_json, rank_key, holdings_json, bar_date, quote_price, quote_prev_close, quote_change_1d, quote_source, quote_fetched_at, quote_freshness_status, quote_freshness_reason, bar_freshness_status, bar_freshness_reason, above_20_sma, above_50_sma, above_200_sma, relative_strength_30d_vs_spy_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        snapshotId,
        row.sectionId,
        row.groupId,
        row.ticker,
        row.displayName,
        resolvedCurrentValue(current, "price", current?.price),
        resolvedCurrentValue(current, "change1d", current?.change1d),
        resolvedCurrentValue(current, "change1w", current?.change1w),
        resolvedCurrentValue(current, "change5d", current?.change5d),
        resolvedCurrentValue(current, "change3m", current?.change3m),
        resolvedCurrentValue(current, "change6m", current?.change6m),
        barIsFresh ? row.change21d : null,
        resolvedCurrentValue(current, "ytd", current?.ytd),
        resolvedCurrentValue(current, "pctFrom52wHigh", current?.pctFrom52wHigh),
        barIsFresh ? JSON.stringify(row.sparkline) : null,
        currentRankKey,
        row.holdings ? JSON.stringify(row.holdings) : null,
        row.barDate,
        quotePrice,
        quotePrevClose,
        quoteChange1d,
        current?.quoteSource ?? null,
        current?.fetchedAt ?? null,
        quoteFreshnessStatus,
        current?.reason ?? `No exact-session current data is stored for ${row.ticker}.`,
        barFreshnessStatus,
        barFreshnessReason,
        booleanToDb(resolvedCurrentValue(current, "above20Sma", current?.above20Sma)),
        booleanToDb(resolvedCurrentValue(current, "above50Sma", current?.above50Sma)),
        booleanToDb(resolvedCurrentValue(current, "above200Sma", current?.above200Sma)),
        barIsFresh && row.relativeStrength30dVsSpy ? JSON.stringify(row.relativeStrength30dVsSpy) : null,
      ),
    );
  }
  if (rowInserts.length > 0) await runStatementsInChunks(env, rowInserts);
  await env.DB.prepare(
    `INSERT INTO snapshots_meta (
       id,
       config_id,
       as_of_date,
       generated_at,
       provider_label,
       expected_as_of_date,
       freshness_status,
       freshness_current_count,
       freshness_eligible_count,
       freshness_coverage_pct,
       freshness_critical_missing_json,
       freshness_min_bar_date,
       freshness_max_bar_date,
       freshness_warning,
       quote_overlay_requested_count,
       quote_overlay_returned_count,
       quote_overlay_error,
       quote_overlay_missing_sample_json
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(config_id, as_of_date) DO UPDATE SET
       id = excluded.id,
       generated_at = excluded.generated_at,
       provider_label = excluded.provider_label,
       expected_as_of_date = excluded.expected_as_of_date,
       freshness_status = excluded.freshness_status,
       freshness_current_count = excluded.freshness_current_count,
       freshness_eligible_count = excluded.freshness_eligible_count,
       freshness_coverage_pct = excluded.freshness_coverage_pct,
       freshness_critical_missing_json = excluded.freshness_critical_missing_json,
       freshness_min_bar_date = excluded.freshness_min_bar_date,
       freshness_max_bar_date = excluded.freshness_max_bar_date,
       freshness_warning = excluded.freshness_warning,
       quote_overlay_requested_count = excluded.quote_overlay_requested_count,
       quote_overlay_returned_count = excluded.quote_overlay_returned_count,
       quote_overlay_error = excluded.quote_overlay_error,
       quote_overlay_missing_sample_json = excluded.quote_overlay_missing_sample_json`,
  )
    .bind(
      snapshotId,
      configId,
      asOfDate,
      generatedAt,
      providerLabel,
      finalFreshness.expectedAsOfDate,
      finalFreshness.status,
      finalFreshness.currentCount,
      finalFreshness.eligibleCount,
      finalFreshness.coveragePct,
      JSON.stringify(finalFreshness.criticalMissingTickers),
      finalFreshness.minBarDate,
      finalFreshness.maxBarDate,
      finalFreshness.warning,
      quoteOverlayDiagnostics.eligibleTickers,
      quoteOverlayDiagnostics.returnedSnapshots,
      quoteOverlayDiagnostics.providerError,
      JSON.stringify(quoteOverlayDiagnostics.sampleMissingTickers),
    )
    .run();
  if (previousSnapshot?.id && previousSnapshot.id !== snapshotId) {
    await env.DB.prepare("DELETE FROM snapshot_rows WHERE snapshot_id = ?")
      .bind(previousSnapshot.id)
      .run();
  }
  if (includeBreadth) {
    const breadthUniverseIds = Array.from(new Set<string>(breadthState.universeTickers.keys()));
    for (const universeId of breadthUniverseIds) {
      await computeAndStoreBreadth(
        env,
        asOfDate,
        universeId,
        breadthState.sourceByUniverse.get(universeId) ?? null,
        generatedAt,
      );
    }
  }
  const postCleanup = await cleanupOldOverviewSnapshots(env);
  if (postCleanup.deletedSnapshots > 0 || postCleanup.deletedRows > 0) {
    console.log("overview snapshot cleanup removed old rows after refresh", postCleanup);
  }
  return { snapshotId, asOfDate, freshness: finalFreshness };
}

export async function recomputeDashboardFromStoredBars(
  env: Env,
  asOfDateInput?: string,
  configId = "default",
): Promise<{ snapshotId: string; asOfDate: string; freshness: OverviewFreshnessDiagnostics }> {
  return computeAndStoreSnapshot(env, asOfDateInput, configId, {
    includeBreadth: false,
  });
}

export async function recomputeBreadthFromStoredBars(
  env: Env,
  asOfDateInput?: string,
): Promise<{
  asOfDate: string;
  universeCount: number;
  attemptedUniverseCount: number;
  skipped: BreadthStoreResult[];
  unavailable: Array<{ id: string; name: string; reason: string }>;
}> {
  const asOfDate = resolveAsOfDate(asOfDateInput);
  const generatedAt = new Date().toISOString();
  const breadthState = await ensureBreadthUniverseMemberships(env);
  const universeIds = Array.from(new Set<string>(breadthState.universeTickers.keys()));
  const results: BreadthStoreResult[] = [];
  for (const universeId of universeIds) {
    results.push(await computeAndStoreBreadth(env, asOfDate, universeId, breadthState.sourceByUniverse.get(universeId) ?? null, generatedAt));
  }
  return {
    asOfDate,
    universeCount: results.filter((result) => result.stored).length,
    attemptedUniverseCount: universeIds.length,
    skipped: results.filter((result) => !result.stored),
    unavailable: breadthState.unavailable,
  };
}

export async function refreshMissingBreadthBarsForCoverage(
  env: Env,
  asOfDateInput?: string,
  options: {
    universeIds?: string[];
    maxTickers?: number;
    maxPasses?: number;
  } = {},
): Promise<BreadthCoverageRefreshResult> {
  const asOfDate = resolveAsOfDate(asOfDateInput);
  const breadthState = await ensureBreadthUniverseMemberships(env);
  const universeFilter = options.universeIds ? new Set(options.universeIds) : undefined;
  const maxTickers = Math.max(1, Math.trunc(options.maxTickers ?? DEFAULT_BREADTH_CATCHUP_MAX_TICKERS));
  const maxPasses = Math.max(1, Math.trunc(options.maxPasses ?? DEFAULT_BREADTH_CATCHUP_MAX_PASSES));
  let diagnostics = await buildBreadthCoverageDiagnostics(env, breadthState, asOfDate, universeFilter);
  let provider: ReturnType<typeof getProvider> | null = null;
  try {
    provider = getProvider(env, { fallbackEnabled: false });
  } catch (error) {
    console.error("breadth missing-bar catch-up provider unavailable", error);
    return {
      asOfDate,
      attemptedTickers: 0,
      fetchedRows: 0,
      writtenRows: 0,
      diagnostics,
      unavailable: breadthState.unavailable,
    };
  }

  const attempted = new Set<string>();
  let fetchedRows = 0;
  let writtenRows = 0;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const lowCoverageUniverseIds = new Set(
      diagnostics
        .filter((diagnostic) => !diagnostic.ok)
        .map((diagnostic) => diagnostic.universeId),
    );
    if (lowCoverageUniverseIds.size === 0) break;

    const candidates: string[] = [];
    const orderedUniverses = Array.from(breadthState.universeTickers.entries())
      .sort(([left], [right]) => {
        const leftIndex = CORE_BREADTH_UNIVERSE_IDS.indexOf(left as (typeof CORE_BREADTH_UNIVERSE_IDS)[number]);
        const rightIndex = CORE_BREADTH_UNIVERSE_IDS.indexOf(right as (typeof CORE_BREADTH_UNIVERSE_IDS)[number]);
        return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
      });
    for (const [universeId, tickers] of orderedUniverses) {
      if (!lowCoverageUniverseIds.has(universeId)) continue;
      const currentTickers = await loadTickersWithBarOnDate(env, tickers, asOfDate);
      for (const ticker of tickers) {
        const normalized = ticker.toUpperCase();
        if (currentTickers.has(normalized) || attempted.has(normalized)) continue;
        attempted.add(normalized);
        candidates.push(normalized);
        if (candidates.length >= maxTickers) break;
      }
      if (candidates.length >= maxTickers) break;
    }
    if (candidates.length === 0) break;

    const refresh = await refreshDailyBarsIncremental(env, {
      provider,
      tickers: candidates,
      startDate: asOfDate,
      endDate: asOfDate,
      replaceExisting: true,
      continueOnError: true,
      target: "market",
      mirrorLatestToLegacy: true,
    });
    fetchedRows += refresh.fetchedRows;
    writtenRows += refresh.writtenRows;
    diagnostics = await buildBreadthCoverageDiagnostics(env, breadthState, asOfDate, universeFilter);
  }

  return {
    asOfDate,
    attemptedTickers: attempted.size,
    fetchedRows,
    writtenRows,
    diagnostics,
    unavailable: breadthState.unavailable,
  };
}

export async function refreshSp500CoreBreadth(env: Env, asOfDateInput?: string): Promise<{ asOfDate: string; barCount: number }> {
  const asOfDate = resolveAsOfDate(asOfDateInput);
  let tickers: string[] = [];
  try {
    const nasdaqUniverse = await loadNasdaqTraderUniverses();
    tickers = await loadSp500Constituents(new Set(nasdaqUniverse.allCommonTickers));
    await saveUniverseSourceStatus(env, "universe:sp500-core", "ok", SP500_SOURCE_LABEL, tickers.length, null);
  } catch (error) {
    console.error("sp500 constituent refresh failed; using cached membership fallback", error);
    await saveUniverseSourceStatus(
      env,
      "universe:sp500-core",
      "error",
      SP500_SOURCE_LABEL,
      0,
      error instanceof Error ? error.message : "sp500 constituent refresh failed",
    );
    tickers = await loadUniverseTickers(env, "sp500-core");
  }
  if (tickers.length === 0) {
    tickers = [...SP500_TICKERS];
  }
  await ensureUniverseMembership(env, "sp500-core", "S&P 500", tickers);
  await ensureSymbolsExist(env, tickers);

  let barCount = 0;
  try {
    const provider = getProvider(env, { fallbackEnabled: false });
    const endDate = asOfDate;
    const startDate = toISODate(new Date(new Date(`${asOfDate}T00:00:00Z`).getTime() - 320 * 86400_000));
    const refresh = await refreshDailyBarsIncremental(env, {
      provider,
      tickers,
      startDate,
      endDate,
      target: "market",
      mirrorLatestToLegacy: true,
    });
    barCount = refresh.writtenRows;
  } catch (error) {
    console.error("sp500 core breadth refresh provider pull failed; using stored bars", error);
  }

  await computeAndStoreBreadth(env, asOfDate, "sp500-core", SP500_SOURCE_LABEL, new Date().toISOString());
  return { asOfDate, barCount };
}

export async function computeAndStoreBreadth(
  env: Env,
  asOfDate: string,
  universeId: string,
  dataSource: string | null = null,
  generatedAt = new Date().toISOString(),
): Promise<BreadthStoreResult> {
  const members = await env.DB.prepare("SELECT ticker FROM universe_symbols WHERE universe_id = ?")
    .bind(universeId)
    .all<{ ticker: string }>();
  const tickers = Array.from(new Set((members.results ?? []).map((r) => r.ticker.toUpperCase()).filter(Boolean)));
  const minCoveragePct = minBreadthCoveragePct(universeId);
  if (tickers.length === 0) {
    return {
      universeId,
      asOfDate,
      stored: false,
      coveragePct: 0,
      minCoveragePct,
      memberCount: 0,
      totalUniverseMembers: 0,
      reason: "empty-universe",
    };
  }
  const allRows = await loadBarsForTickers(env, tickers, asOfDate);
  const currentTickers = new Set(
    allRows
      .filter((row) => row.date === asOfDate)
      .map((row) => row.ticker.toUpperCase()),
  );
  const currentCoveragePct = tickers.length > 0 ? (currentTickers.size / tickers.length) * 100 : 0;
  const id = `${asOfDate}:${universeId}`;
  if (currentCoveragePct < minCoveragePct) {
    await env.DB.prepare("DELETE FROM breadth_snapshots WHERE id = ?").bind(id).run();
    console.warn("skipping low-current-coverage breadth snapshot", {
      universeId,
      asOfDate,
      coveragePct: Number(currentCoveragePct.toFixed(2)),
      minCoveragePct,
      currentDateTickers: currentTickers.size,
      totalUniverseMembers: tickers.length,
    });
    return {
      universeId,
      asOfDate,
      stored: false,
      coveragePct: currentCoveragePct,
      minCoveragePct,
      memberCount: currentTickers.size,
      totalUniverseMembers: tickers.length,
      reason: "low-current-date-coverage",
    };
  }

  const barsByTicker = new Map<string, { closes: number[]; volumes: number[] }>();
  for (const r of allRows) {
    if (!currentTickers.has(r.ticker.toUpperCase())) continue;
    const v = barsByTicker.get(r.ticker) ?? { closes: [], volumes: [] };
    v.closes.push(r.c);
    v.volumes.push(r.volume ?? 0);
    barsByTicker.set(r.ticker, v);
  }

  const stats = computeBreadthStats(
    Object.fromEntries(
      tickers.map((t) => [
        t,
        barsByTicker.get(t) ?? {
          closes: [],
          volumes: [],
        },
      ]),
    ),
  );
  if (stats.totalUniverseMembers > 0 && stats.dataCoveragePct < minCoveragePct) {
    await env.DB.prepare("DELETE FROM breadth_snapshots WHERE id = ?").bind(id).run();
    console.warn("skipping low-coverage breadth snapshot", {
      universeId,
      asOfDate,
      coveragePct: Number(stats.dataCoveragePct.toFixed(2)),
      minCoveragePct,
      memberCount: stats.memberCount,
      totalUniverseMembers: stats.totalUniverseMembers,
    });
    return {
      universeId,
      asOfDate,
      stored: false,
      coveragePct: stats.dataCoveragePct,
      minCoveragePct,
      memberCount: stats.memberCount,
      totalUniverseMembers: stats.totalUniverseMembers,
      reason: "low-computable-coverage",
    };
  }

  await env.DB.prepare(
    "INSERT OR REPLACE INTO breadth_snapshots (id, as_of_date, universe_id, advancers, decliners, unchanged, pct_above_20ma, pct_above_50ma, pct_above_200ma, new_20d_highs, new_20d_lows, median_return_1d, median_return_5d, sentiment_json, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      asOfDate,
      universeId,
      stats.advancers,
      stats.decliners,
      stats.unchanged,
      stats.pctAbove20MA,
      stats.pctAbove50MA,
      stats.pctAbove200MA,
      stats.new20DHighs,
      stats.new20DLows,
      stats.medianReturn1D,
      stats.medianReturn5D,
      JSON.stringify({
        fearGreed: null,
        putCall: null,
        metrics: stats,
        dataSource,
      }),
      generatedAt,
    )
    .run();
  return {
    universeId,
    asOfDate,
    stored: true,
    coveragePct: stats.dataCoveragePct,
    minCoveragePct,
    memberCount: stats.memberCount,
    totalUniverseMembers: stats.totalUniverseMembers,
  };
}

type LoadSnapshotOptions = {
  allowComputeOnMissing?: boolean;
};

export function emptySnapshotResponse(warning = "No stored overview snapshot is available. Use Refresh Overview Data to generate one."): SnapshotEmptyResponse {
  return {
    status: "empty",
    warning,
    asOfDate: null,
    generatedAt: null,
    providerLabel: null,
    expectedAsOfDate: latestUsMarketSessionAsOfDate(new Date()),
    freshnessStatus: "stale",
    freshnessCoveragePct: 0,
    freshnessCurrentCount: 0,
    freshnessEligibleCount: 0,
    freshnessCriticalMissingTickers: [],
    freshnessMinBarDate: null,
    freshnessMaxBarDate: null,
    freshnessWarning: warning,
    quoteOverlayRequestedCount: null,
    quoteOverlayReturnedCount: null,
    quoteOverlayError: null,
    quoteOverlayMissingSample: [],
    config: null,
    sections: [],
  };
}

async function loadSnapshotMeta(
  env: Env,
  configId: string,
  latestAllowedAsOfDate: string,
  requestedDate?: string,
): Promise<SnapshotMetaRow | null> {
  const selectWithFreshness =
    "SELECT id, as_of_date as asOfDate, generated_at as generatedAt, provider_label as providerLabel, expected_as_of_date as expectedAsOfDate, freshness_status as freshnessStatus, freshness_current_count as freshnessCurrentCount, freshness_eligible_count as freshnessEligibleCount, freshness_coverage_pct as freshnessCoveragePct, freshness_critical_missing_json as freshnessCriticalMissingJson, freshness_min_bar_date as freshnessMinBarDate, freshness_max_bar_date as freshnessMaxBarDate, freshness_warning as freshnessWarning, quote_overlay_requested_count as quoteOverlayRequestedCount, quote_overlay_returned_count as quoteOverlayReturnedCount, quote_overlay_error as quoteOverlayError, quote_overlay_missing_sample_json as quoteOverlayMissingSampleJson FROM snapshots_meta";
  const selectLegacy =
    "SELECT id, as_of_date as asOfDate, generated_at as generatedAt, provider_label as providerLabel FROM snapshots_meta";
  const where = requestedDate
    ? " WHERE config_id = ? AND as_of_date = ?"
    : " WHERE config_id = ? AND as_of_date <= ? ORDER BY as_of_date DESC, generated_at DESC LIMIT 1";

  try {
    return await env.DB.prepare(`${selectWithFreshness}${where}`)
      .bind(configId, requestedDate ?? latestAllowedAsOfDate)
      .first<SnapshotMetaRow>();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (
      !message.toLowerCase().includes("freshness_")
      && !message.toLowerCase().includes("expected_as_of_date")
      && !message.toLowerCase().includes("quote_overlay_")
    ) throw error;
    return await env.DB.prepare(`${selectLegacy}${where}`)
      .bind(configId, requestedDate ?? latestAllowedAsOfDate)
      .first<SnapshotMetaRow>();
  }
}

function parseStoredNumberArray(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
  } catch {
    return [];
  }
}

function parseStoredNumberArrayOrNull(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const values = parsed
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    return values.length > 0 ? values : null;
  } catch {
    return null;
  }
}

function parseStoredStringArray(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const values = parsed
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    return values.length > 0 ? values : null;
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function dbBooleanOrNull(value: unknown): boolean | null {
  if (value == null) return null;
  const normalized = Number(value);
  if (normalized === 1) return true;
  if (normalized === 0) return false;
  return null;
}

function booleanToDb(value: boolean | null): number | null {
  if (value == null) return null;
  return value ? 1 : 0;
}

type LoadedOverviewSnapshotRow = {
  sectionId: string;
  groupId: string;
  ticker: string;
  displayName: string | null;
  price: number | null;
  change1d: number | null;
  change1w: number | null;
  change5d: number | null;
  change3m?: number | null;
  change6m?: number | null;
  change21d: number | null;
  ytd: number | null;
  pctFrom52wHigh: number | null;
  sparklineJson: string | null;
  rankKey: number | null;
  holdingsJson: string | null;
  barDate?: string | null;
  quotePrice?: number | null;
  quotePrevClose?: number | null;
  quoteChange1d?: number | null;
  quoteSource?: string | null;
  quoteFetchedAt?: string | null;
  quoteFreshnessStatus?: QuoteFreshnessStatus | null;
  quoteFreshnessReason?: string | null;
  barFreshnessStatus?: BarFreshnessStatus | null;
  barFreshnessReason?: string | null;
  above20Sma?: number | null;
  above50Sma?: number | null;
  above200Sma?: number | null;
  relativeStrength30dVsSpyJson?: string | null;
};

export async function loadSnapshot(
  env: Env,
  configId?: string,
  requestedDate?: string,
  options?: { allowComputeOnMissing?: true },
): Promise<SnapshotReadyResponse>;
export async function loadSnapshot(
  env: Env,
  configId: string | undefined,
  requestedDate: string | undefined,
  options: { allowComputeOnMissing: false },
): Promise<SnapshotResponse>;
export async function loadSnapshot(
  env: Env,
  configId = "default",
  requestedDate?: string,
  options: LoadSnapshotOptions = {},
): Promise<SnapshotResponse> {
  const config = await loadConfig(env, configId);
  const allowComputeOnMissing = options.allowComputeOnMissing ?? true;
  const latestAllowedAsOfDate = latestUsMarketSessionAsOfDate(new Date());
  const meta = await loadSnapshotMeta(env, configId, latestAllowedAsOfDate, requestedDate);

  if (!meta && !allowComputeOnMissing) {
    return emptySnapshotResponse();
  }

  if (!meta) {
    const computed = await computeAndStoreSnapshot(env, requestedDate, configId);
    return loadSnapshot(env, configId, computed.asOfDate);
  }

  let rows;
  let derivedMetricsUnavailable = false;
  try {
    rows = await env.DB.prepare(
      "SELECT section_id as sectionId, group_id as groupId, ticker, display_name as displayName, price, change_1d as change1d, change_1w as change1w, change_5d as change5d, change_3m as change3m, change_6m as change6m, change_21d as change21d, ytd, pct_from_52w_high as pctFrom52wHigh, sparkline_json as sparklineJson, rank_key as rankKey, holdings_json as holdingsJson, bar_date as barDate, quote_price as quotePrice, quote_prev_close as quotePrevClose, quote_change_1d as quoteChange1d, quote_source as quoteSource, quote_fetched_at as quoteFetchedAt, quote_freshness_status as quoteFreshnessStatus, quote_freshness_reason as quoteFreshnessReason, bar_freshness_status as barFreshnessStatus, bar_freshness_reason as barFreshnessReason, above_20_sma as above20Sma, above_50_sma as above50Sma, above_200_sma as above200Sma, relative_strength_30d_vs_spy_json as relativeStrength30dVsSpyJson FROM snapshot_rows WHERE snapshot_id = ? ORDER BY rank_key DESC",
    )
      .bind(meta.id)
      .all<{
      sectionId: string;
      groupId: string;
      ticker: string;
      displayName: string | null;
      price: number;
      change1d: number;
      change1w: number;
      change5d: number;
      change3m?: number | null;
      change6m?: number | null;
      change21d: number;
      ytd: number;
      pctFrom52wHigh: number;
      sparklineJson: string;
      rankKey: number;
      holdingsJson: string | null;
      barDate: string | null;
      quotePrice?: number | null;
      quotePrevClose?: number | null;
      quoteChange1d?: number | null;
      quoteSource?: string | null;
      quoteFetchedAt?: string | null;
      quoteFreshnessStatus?: QuoteFreshnessStatus | null;
      quoteFreshnessReason?: string | null;
      barFreshnessStatus?: BarFreshnessStatus | null;
      barFreshnessReason?: string | null;
      above20Sma?: number | null;
      above50Sma?: number | null;
      above200Sma?: number | null;
      relativeStrength30dVsSpyJson?: string | null;
    }>();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    const lowerMessage = message.toLowerCase();
    if (
      !lowerMessage.includes("bar_date")
      && !lowerMessage.includes("bar_freshness")
      && !lowerMessage.includes("quote_")
      && !lowerMessage.includes("change_3m")
      && !lowerMessage.includes("change_6m")
      && !lowerMessage.includes("above_")
      && !lowerMessage.includes("relative_strength_")
    ) throw error;
    derivedMetricsUnavailable = true;
    rows = await env.DB.prepare(
      "SELECT section_id as sectionId, group_id as groupId, ticker, display_name as displayName, price, change_1d as change1d, change_1w as change1w, change_5d as change5d, change_21d as change21d, ytd, pct_from_52w_high as pctFrom52wHigh, sparkline_json as sparklineJson, rank_key as rankKey, holdings_json as holdingsJson FROM snapshot_rows WHERE snapshot_id = ? ORDER BY rank_key DESC",
    )
      .bind(meta.id)
      .all<{
        sectionId: string;
        groupId: string;
        ticker: string;
        displayName: string | null;
        price: number;
        change1d: number;
        change1w: number;
        change5d: number;
        change21d: number;
        ytd: number;
        pctFrom52wHigh: number;
        sparklineJson: string;
        rankKey: number;
        holdingsJson: string | null;
        barDate?: string | null;
      }>();
  }

  const tableRows = (rows.results ?? []) as LoadedOverviewSnapshotRow[];
  if (!derivedMetricsUnavailable && tableRows.length > 0) {
    derivedMetricsUnavailable = tableRows.every((row) =>
      row.change3m == null
      && row.change6m == null
      && row.above20Sma == null
      && row.above50Sma == null
      && row.above200Sma == null
      && row.relativeStrength30dVsSpyJson == null);
  }
  const freshness = freshnessDiagnosticsFromSnapshotMeta(meta, latestAllowedAsOfDate);
  const expectedAsOfDate = requestedDate ?? latestAllowedAsOfDate;
  let exactSessionCurrentRows = new Map<string, OverviewCurrentData>();
  if (isOverviewCurrentV2Enabled(env)) {
    try {
      exactSessionCurrentRows = await loadOverviewCurrentData(env, configId, expectedAsOfDate);
    } catch (error) {
      console.error("overview exact-session current data could not be loaded", error);
    }
  }
  let freshnessWarning = derivedMetricsUnavailable
    ? appendFreshnessWarning(freshness?.warning ?? null, MISSING_OVERVIEW_DERIVED_METRICS_WARNING)
    : freshness?.warning ?? null;
  const snapshotMatchesExpectedSession = meta.asOfDate === expectedAsOfDate;
  if (!snapshotMatchesExpectedSession) {
    freshnessWarning = appendFreshnessWarning(
      freshnessWarning,
      `Stored overview snapshot is ${meta.asOfDate}; expected ${expectedAsOfDate}. Historical values were suppressed.`,
    );
  }
  return {
    asOfDate: meta.asOfDate,
    generatedAt: meta.generatedAt,
    providerLabel: meta.providerLabel,
    expectedAsOfDate,
    freshnessStatus: snapshotMatchesExpectedSession ? freshness?.status ?? "stale" : "stale",
    freshnessCoveragePct: snapshotMatchesExpectedSession ? freshness?.coveragePct ?? 0 : 0,
    freshnessCurrentCount: snapshotMatchesExpectedSession ? freshness?.currentCount ?? 0 : 0,
    freshnessEligibleCount: freshness?.eligibleCount ?? 0,
    freshnessCriticalMissingTickers: freshness?.criticalMissingTickers ?? [],
    freshnessMinBarDate: freshness?.minBarDate ?? null,
    freshnessMaxBarDate: freshness?.maxBarDate ?? null,
    freshnessWarning,
    quoteOverlayRequestedCount: meta.quoteOverlayRequestedCount ?? null,
    quoteOverlayReturnedCount: meta.quoteOverlayReturnedCount ?? null,
    quoteOverlayError: meta.quoteOverlayError ?? null,
    quoteOverlayMissingSample: parseCriticalMissingTickers(meta.quoteOverlayMissingSampleJson),
    config,
    sections: config.sections.map((sec) => ({
      id: sec.id,
      title: sec.title,
      description: sec.description,
      groups: sec.groups.map((g) => ({
        id: g.id,
        title: g.title,
        dataType: g.dataType,
        rankingWindowDefault: g.rankingWindowDefault,
        showSparkline: g.showSparkline,
        pinTop10: g.pinTop10,
        columns: g.columns,
        rows: tableRows
          .filter((r) => r.sectionId === sec.id && r.groupId === g.id)
          .map((r) => {
            const barDate = r.barDate ?? null;
            const storedBarFreshnessStatus = isBarFreshnessStatus(r.barFreshnessStatus)
              ? r.barFreshnessStatus
              : null;
            const current = exactSessionCurrentRows.get(r.ticker.toUpperCase()) ?? null;
            const exactSessionHistory = meta.providerLabel.startsWith("TradingView scanner + Alpaca")
              && barDate === expectedAsOfDate
              && storedBarFreshnessStatus !== "stale";
            const barFreshnessStatus: BarFreshnessStatus = exactSessionHistory
              ? "fresh"
              : barDate
                ? "stale"
                : "unavailable";
            const barFreshnessReason = exactSessionHistory
              ? `Stored Alpaca daily bar is current for ${expectedAsOfDate}.`
              : barDate
                ? `Last stored daily bar is ${barDate}; expected ${expectedAsOfDate}.`
                : `No stored daily bar is available for ${r.ticker}.`;
            const quoteFreshnessStatus = currentQuoteFreshnessStatus(current);
            const quotePrice = resolvedCurrentValue(current, "price", current?.price);
            const quoteChange1d = resolvedCurrentValue(current, "change1d", current?.change1d);
            const quotePrevClose = quotePrice != null
              && quoteChange1d != null
              && quoteChange1d !== -100
              ? quotePrice / (1 + quoteChange1d / 100)
              : null;
            return {
              ticker: r.ticker,
              displayName: r.displayName,
              price: quotePrice,
              change1d: quoteChange1d,
              change1w: resolvedCurrentValue(current, "change1w", current?.change1w),
              change5d: resolvedCurrentValue(current, "change5d", current?.change5d),
              change3m: resolvedCurrentValue(current, "change3m", current?.change3m),
              change6m: resolvedCurrentValue(current, "change6m", current?.change6m),
              change21d: exactSessionHistory ? r.change21d : null,
              ytd: resolvedCurrentValue(current, "ytd", current?.ytd),
              pctFrom52wHigh: resolvedCurrentValue(current, "pctFrom52wHigh", current?.pctFrom52wHigh),
              sparkline: exactSessionHistory ? parseStoredNumberArray(r.sparklineJson) : null,
              relativeStrength30dVsSpy: exactSessionHistory ? parseStoredNumberArrayOrNull(r.relativeStrength30dVsSpyJson) : null,
              above20Sma: resolvedCurrentValue(current, "above20Sma", current?.above20Sma),
              above50Sma: resolvedCurrentValue(current, "above50Sma", current?.above50Sma),
              above200Sma: resolvedCurrentValue(current, "above200Sma", current?.above200Sma),
              barDate,
              barFreshnessStatus,
              barFreshnessReason,
              quotePrice,
              quotePrevClose,
              quoteChange1d,
              quoteFreshnessStatus,
              quoteFreshnessReason: current?.reason ?? `No exact-session current data is stored for ${r.ticker}.`,
              quoteSource: current?.quoteSource ?? null,
              quoteFetchedAt: current?.fetchedAt ?? null,
              currentData: current ? {
                sessionDate: current.sessionDate,
                status: current.status,
                reason: current.reason,
                quoteSource: current.quoteSource,
                performanceSource: current.performanceSource,
                smaSource: current.smaSource,
                fieldSources: current.fieldSources,
                providerStatuses: current.providerStatuses,
                fetchedAt: current.fetchedAt,
                tradingViewSymbol: current.tradingViewSymbol,
                tradingViewTime: current.tradingViewTime,
                tradingViewLastBarUpdateTime: current.tradingViewLastBarUpdateTime,
                tradingViewLastPriceUpdateTime: current.tradingViewLastPriceUpdateTime,
                tradingViewUpdateTime: current.tradingViewUpdateTime,
                tradingViewUpdateMode: current.tradingViewUpdateMode,
                tradingViewCurrentSession: current.tradingViewCurrentSession,
              } : {
                sessionDate: expectedAsOfDate,
                status: "unavailable" as const,
                reason: `No exact-session current data is stored for ${r.ticker}.`,
                quoteSource: null,
                performanceSource: null,
                smaSource: null,
                fieldSources: {},
                providerStatuses: {},
                fetchedAt: meta.generatedAt,
                tradingViewSymbol: null,
                tradingViewTime: null,
                tradingViewLastBarUpdateTime: null,
                tradingViewLastPriceUpdateTime: null,
                tradingViewUpdateTime: null,
                tradingViewUpdateMode: null,
                tradingViewCurrentSession: null,
              },
              historyData: {
                sessionDate: expectedAsOfDate,
                status: barFreshnessStatus,
                reason: barFreshnessReason,
                barDate,
                source: exactSessionHistory ? `alpaca:${(env.ALPACA_FEED ?? "iex").toLowerCase()}-bars` : null,
              },
              rankKey: currentRankValue(current, g.rankingWindowDefault),
              holdings: parseStoredStringArray(r.holdingsJson),
            };
          })
          .sort((left, right) => (right.rankKey ?? Number.NEGATIVE_INFINITY) - (left.rankKey ?? Number.NEGATIVE_INFINITY)),
      })),
    })),
  };
}
