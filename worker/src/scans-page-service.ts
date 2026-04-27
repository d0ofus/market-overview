import { getProvider } from "./provider";
import { refreshDailyBarsIncremental } from "./daily-bars";
import { latestUsSessionAsOfDate, previousWeekdayIso } from "./refresh-timing";
import { loadWorkerScheduleSettings } from "./worker-schedule-service";
import {
  advanceRelativeStrengthState,
  bootstrapRelativeStrengthStateFromRatioRows,
  buildRelativeStrengthCacheRows,
  buildRelativeStrengthCacheRowsFromRatioRows,
  buildRelativeStrengthRatioRows,
  RS_STATE_VERSION,
  type RelativeStrengthConfig,
  type RelativeStrengthConfigState,
  type RelativeStrengthDailyBar,
  type RelativeStrengthMaType,
  type RelativeStrengthOutputMode,
  type RelativeStrengthRatioRow,
} from "./relative-strength";
import {
  buildVcpFeatureRow,
  normalizeVcpConfig,
  requiredVcpBarCount,
  vcpConfigKey,
  type VcpConfig,
  type VcpFeatureRow,
} from "./vcp";
import type { Env } from "./types";

export type ScanRuleOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "in" | "not_in";

export type ScanRuleScalar = string | number | boolean;

export type ScanRuleFieldReference = {
  type: "field";
  field: string;
  multiplier?: number;
};

export type ScanRuleValue = ScanRuleScalar | Array<ScanRuleScalar> | ScanRuleFieldReference;

export type ScanPresetRule = {
  id: string;
  field: string;
  operator: ScanRuleOperator;
  value: ScanRuleValue;
};

export type ScanPreset = {
  id: string;
  name: string;
  scanType: "tradingview" | "relative-strength" | "vcp";
  isDefault: boolean;
  isActive: boolean;
  rules: ScanPresetRule[];
  prefilterRules: ScanPresetRule[];
  benchmarkTicker: string | null;
  verticalOffset: number;
  rsMaLength: number;
  rsMaType: RelativeStrengthMaType;
  newHighLookback: number;
  outputMode: RelativeStrengthOutputMode;
  vcpDailyPivotLookback: number;
  vcpWeeklyHighLookback: number;
  vcpPivotAgeBars: number;
  vcpDailyNearPct: number;
  vcpWeeklyNearPct: number;
  sortField: string;
  sortDirection: "asc" | "desc";
  rowLimit: number;
  createdAt: string;
  updatedAt: string;
};

export type ScanCompilePresetMember = {
  scanPresetId: string;
  scanPresetName: string;
  sortOrder: number;
};

export type ScanCompilePresetRow = {
  id: string;
  name: string;
  memberCount: number;
  presetIds: string[];
  presetNames: string[];
  createdAt: string;
  updatedAt: string;
};

export type ScanCompilePresetDetail = ScanCompilePresetRow & {
  members: ScanCompilePresetMember[];
};

export type ScanSnapshotRow = {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  change1d: number | null;
  marketCap: number | null;
  relativeVolume: number | null;
  price: number | null;
  avgVolume: number | null;
  priceAvgVolume: number | null;
  rsClose: number | null;
  rsMa: number | null;
  rsAboveMa: boolean;
  rsNewHigh: boolean;
  rsNewHighBeforePrice: boolean;
  bullCross: boolean;
  approxRsRating: number | null;
  rawJson: string | null;
};

export type ScanSnapshot = {
  id: string;
  presetId: string;
  presetName: string;
  providerLabel: string;
  generatedAt: string;
  rowCount: number;
  matchedRowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
  rows: ScanSnapshotRow[];
};

export type CompiledScanUniqueTickerRow = {
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  occurrences: number;
  presetIds: string[];
  presetNames: string[];
  latestPrice: number | null;
  latestChange1d: number | null;
  latestMarketCap: number | null;
  latestRelativeVolume: number | null;
};

export type CompiledScansSnapshot = {
  compilePresetId: string | null;
  compilePresetName: string | null;
  presetIds: string[];
  presetNames: string[];
  generatedAt: string;
  rows: CompiledScanUniqueTickerRow[];
};

export type ScanCompilePresetRefreshMemberResult = {
  presetId: string;
  presetName: string;
  status: "ok" | "warning" | "error" | "empty" | "queued" | "running" | "completed" | "failed";
  rowCount: number;
  error: string | null;
  snapshot: ScanSnapshot | null;
  usableSnapshot: ScanSnapshot | null;
  usedFallback: boolean;
  includedInCompiled: boolean;
};

export type ScanCompilePresetRefreshResult = {
  compilePresetId: string;
  compilePresetName: string;
  refreshedCount: number;
  failedCount: number;
  snapshot: CompiledScansSnapshot;
  memberResults: ScanCompilePresetRefreshMemberResult[];
};

export type ScanRefreshJobStatus = "queued" | "running" | "completed" | "failed";

export type ScanRefreshJob = {
  id: string;
  presetId: string;
  presetName: string;
  jobType: "relative-strength" | "vcp";
  status: ScanRefreshJobStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  totalCandidates: number;
  processedCandidates: number;
  matchedCandidates: number;
  cursorOffset: number;
  latestSnapshotId: string | null;
  requestedBy: string | null;
  configKey: string | null;
  sharedRunId: string | null;
  expectedTradingDate: string | null;
  fullCandidateCount: number;
  materializationCandidateCount: number;
  alreadyCurrentCandidateCount: number;
  lastAdvancedAt: string | null;
  deferredTickerCount: number;
  warning: string | null;
  phase: string | null;
  elapsedMs?: number | null;
  durationMs?: number | null;
  cacheHitCount?: number;
  computedCount?: number;
  missingBarsCount?: number;
  insufficientHistoryCount?: number;
  errorCount?: number;
  staleBenchmarkCount?: number;
  appliesToPreset?: boolean;
};

export type ScanRefreshResponse = {
  async: boolean;
  snapshot: ScanSnapshot | null;
  job: ScanRefreshJob | null;
};

type ScanRefreshJobRecord = {
  id: string;
  presetId: string;
  jobType: string;
  status: ScanRefreshJobStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  totalCandidates: number;
  processedCandidates: number;
  matchedCandidates: number;
  cursorOffset: number;
  latestSnapshotId: string | null;
  requestedBy: string | null;
  benchmarkBarsJson: string | null;
  requiredBarCount: number;
  configKey: string | null;
  sharedRunId: string | null;
  expectedTradingDate: string | null;
  benchmarkTicker: string | null;
  rsMaType: RelativeStrengthMaType;
  rsMaLength: number;
  newHighLookback: number;
  fullCandidateCount: number;
  materializationCandidateCount: number;
  alreadyCurrentCandidateCount: number;
  lastAdvancedAt: string | null;
  deferredTickerCount: number;
  warning: string | null;
  phase: string | null;
};

type RelativeStrengthMaterializationRunRecord = {
  id: string;
  configKey: string;
  expectedTradingDate: string;
  benchmarkTicker: string;
  rsMaType: RelativeStrengthMaType;
  rsMaLength: number;
  newHighLookback: number;
  status: ScanRefreshJobStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  benchmarkBarsJson: string | null;
  requiredBarCount: number;
  fullCandidateCount: number;
  materializationCandidateCount: number;
  alreadyCurrentCandidateCount: number;
  processedCandidates: number;
  matchedCandidates: number;
  cursorOffset: number;
  lastAdvancedAt: string | null;
  deferredTickerCount: number;
  warning: string | null;
  phase: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
};

type RelativeStrengthDeferredTickerRow = {
  runId: string;
  ticker: string;
  attemptCount: number;
  lastError: string | null;
  deferredAt: string | null;
};

type RelativeStrengthLatestCacheRecord = {
  ticker: string;
  benchmarkTicker: string;
  rsMaType: RelativeStrengthMaType;
  rsMaLength: number;
  newHighLookback: number;
  tradingDate: string;
  priceClose: number | null;
  change1d: number | null;
  rsRatioClose: number | null;
  rsRatioMa: number | null;
  rsAboveMa: number | boolean;
  rsNewHigh: number | boolean;
  rsNewHighBeforePrice: number | boolean;
  bullCross: number | boolean;
  approxRsRating: number | null;
};

type RelativeStrengthConfigIdentity = {
  benchmarkTicker: string;
  benchmarkDataTicker: string;
  rsMaType: RelativeStrengthMaType;
  rsMaLength: number;
  newHighLookback: number;
  configKey: string;
  requiredBarCount: number;
  expectedTradingDate: string;
};

type RelativeStrengthJobCandidateRow = {
  cursorOffset: number;
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  relativeVolume: number | null;
  avgVolume: number | null;
  priceAvgVolume: number | null;
  materializationRequired: boolean;
};

type RelativeStrengthConfigStateRecord = {
  configKey: string;
  ticker: string;
  benchmarkTicker: string;
  rsMaType: RelativeStrengthMaType;
  rsMaLength: number;
  newHighLookback: number;
  stateVersion: number;
  latestTradingDate: string;
  updatedAt: string | null;
  priceClose: number | null;
  change1d: number | null;
  rsRatioClose: number | null;
  rsRatioMa: number | null;
  rsAboveMa: number | boolean;
  rsNewHigh: number | boolean;
  rsNewHighBeforePrice: number | boolean;
  bullCross: number | boolean;
  approxRsRating: number | null;
  priceCloseHistoryJson: string | null;
  benchmarkCloseHistoryJson: string | null;
  weightedScoreHistoryJson: string | null;
  rsNewHighWindowJson: string | null;
  priceNewHighWindowJson: string | null;
  smaWindowJson: string | null;
  smaSum: number | null;
  emaValue: number | null;
  previousRsClose: number | null;
  previousRsMa: number | null;
};

type RelativeStrengthConfigStateSummaryRow = {
  ticker: string;
  stateVersion: number;
  latestTradingDate: string;
};

type RelativeStrengthRefreshQueueRow = {
  jobId?: string;
  runId?: string;
  priority?: number;
  source: string | null;
  enqueuedAt: string;
  lastAttemptedAt: string | null;
  attempts: number;
};

type DailyBarCoverageRow = {
  ticker: string;
  lastDate: string | null;
  barCount: number | null;
};

type RelativeStrengthRatioCoverageRow = {
  ticker: string;
  lastDate: string | null;
  rowCount: number | null;
};

type ManualRelativeStrengthRunRecord = {
  id: string;
  presetId: string;
  presetName: string;
  configKey: string;
  benchmarkTicker: string;
  rsMaType: RelativeStrengthMaType;
  rsMaLength: number;
  newHighLookback: number;
  expectedTradingDate: string;
  status: ScanRefreshJobStatus;
  requestedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  heartbeatAt: string | null;
  completedAt: string | null;
  error: string | null;
  warning: string | null;
  totalTickers: number;
  processedTickers: number;
  matchedTickers: number;
  cursorOffset: number;
  latestSnapshotId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  cacheHitTickers: number;
  computedTickers: number;
  missingBarsTickers: number;
  insufficientHistoryTickers: number;
  errorTickers: number;
  staleBenchmarkTickers: number;
  durationMs: number | null;
};

type ManualRelativeStrengthCandidateRow = {
  cursorOffset: number;
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  exchange: string | null;
  assetClass: string | null;
  marketCap: number | null;
  relativeVolume: number | null;
  avgVolume: number | null;
  priceAvgVolume: number | null;
  price: number | null;
  change1d: number | null;
  status: string;
  reason: string | null;
  latestTradingDate: string | null;
  source: string | null;
};

type ManualRelativeStrengthFeatureRow = RelativeStrengthLatestCacheRecord & {
  configKey: string;
  expectedTradingDate: string | null;
  status: string;
  reason: string | null;
  computedAt: string;
};

type ManualRelativeStrengthTickerStatus = "computed" | "missing_bars" | "insufficient_history" | "stale_benchmark" | "error";

type VcpRunRecord = {
  id: string;
  presetId: string;
  presetName: string;
  configKey: string;
  expectedTradingDate: string;
  status: ScanRefreshJobStatus;
  requestedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  heartbeatAt: string | null;
  completedAt: string | null;
  error: string | null;
  warning: string | null;
  totalTickers: number;
  processedTickers: number;
  matchedTickers: number;
  cursorOffset: number;
  latestSnapshotId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  cacheHitTickers: number;
  computedTickers: number;
  missingBarsTickers: number;
  insufficientHistoryTickers: number;
  errorTickers: number;
  durationMs: number | null;
};

type VcpCandidateRow = ManualRelativeStrengthCandidateRow;

type VcpFeatureCacheRow = VcpFeatureRow & {
  configKey: string;
  expectedTradingDate: string | null;
  status: string;
  reason: string | null;
  computedAt: string;
};

type VcpTickerStatus = "computed" | "missing_bars" | "insufficient_history" | "error";

type VcpConfigIdentity = {
  config: VcpConfig;
  configKey: string;
  requiredBarCount: number;
  expectedTradingDate: string;
};

type TradingViewFilter = {
  left: string;
  operation: string;
  right: number | string | boolean | Array<number | string | boolean>;
};

type TradingViewScanPayload = {
  markets: string[];
  symbols: { query: { types: string[] }; tickers: string[] };
  options: { lang: string };
  columns: string[];
  sort: { sortBy: string; sortOrder: "asc" | "desc"; nullsFirst?: boolean };
  range: [number, number];
  filter: TradingViewFilter[];
};

type TradingViewScanRow = {
  ticker?: string | null;
  name?: string | null;
  sector?: string | null;
  industry?: string | null;
  change1d?: number | string | null;
  marketCap?: number | string | null;
  relativeVolume?: number | string | null;
  price?: number | string | null;
  avgVolume?: number | string | null;
  priceAvgVolume?: number | string | null;
  volume?: number | string | null;
  exchange?: string | null;
  type?: string | null;
  raw?: unknown;
};

const DEFAULT_LIMIT = 100;
const DEFAULT_RS_BENCHMARK = "SPY";
const RETENTION_DAYS = 7;
const RS_REQUIRED_BAR_FLOOR = 504;
const RS_DEFAULT_COMPUTE_BATCH_SIZE = 50;
const RS_PREPARED_SLICE_SIZE = 50;
const RS_RUN_LEASE_DURATION_MS = 60_000;
const RS_DEFERRED_TICKER_MAX_ATTEMPTS = 3;
const RS_JOB_PROVIDER_CHUNK_SIZE = 10;
const RS_STORED_BAR_QUERY_CHUNK_SIZE = 80;
const RS_JOB_INSERT_CHUNK_SIZE = 250;
const RS_JOB_TIME_BUDGET_MS = 15000;
const RS_RATIO_RETENTION_BARS = 520;
const RS_LIVE_TOP_UP_LIMIT = 25;
const RS_DEEP_HISTORY_TOP_UP_LIMIT = 40;
const RS_STALE_TOP_UP_LOOKBACK_DAYS = 30;
const RS_JOB_CONTINUATION_STALE_MS = 8000;
const RS_JOB_RECOVERY_STALE_MS = 30000;
const RS_INCREMENTAL_ADVANCE_MAX_BARS = 20;
const RS_STALE_TOP_UP_LIMIT = 120;
const MANUAL_RS_SCAN_BATCH_SIZE = 40;
const MANUAL_RS_SCAN_TIME_BUDGET_MS = 20_000;
const MANUAL_RS_SCAN_LEASE_DURATION_MS = 60_000;
const MANUAL_RS_SCAN_STALE_RUN_MS = 30 * 60_000;
const MANUAL_RS_SCAN_MAX_UNIVERSE_SIZE = 10_000;
const VCP_SCAN_BATCH_SIZE = 40;
const VCP_SCAN_TIME_BUDGET_MS = 20_000;
const VCP_SCAN_LEASE_DURATION_MS = 60_000;
const VCP_SCAN_STALE_RUN_MS = 30 * 60_000;
const VCP_SCAN_MAX_UNIVERSE_SIZE = 10_000;
const POST_CLOSE_DAILY_BARS_SCOPE = "active-us-common-stocks";
const MAX_FETCH_RANGE = 1000;
const MAX_PAGINATED_FETCH_TOTAL = 50000;
const RS_DERIVED_CACHE_BACKFILL_DEFAULT_LIMIT = 250;
const RS_DERIVED_CACHE_BACKFILL_MAX_LIMIT = 1000;
const TV_SCAN_URL = "https://scanner.tradingview.com/america/scan";
const TV_PROVIDER_LABEL = "TradingView Screener (america/stocks)";
const RS_PROVIDER_LABEL = "Relative Strength Scan (Alpaca/Provider)";
const VCP_PROVIDER_LABEL = "VCP Scan (shared daily bars)";
const RS_RAW_RATIO_VERTICAL_OFFSET = 0.01;

export type RsDerivedCacheTable =
  | "rs_ratio_cache"
  | "relative_strength_latest_cache"
  | "relative_strength_config_state";

export type RsDerivedCacheBackfillTarget = RsDerivedCacheTable | "all";

export type RsDerivedCacheBackfillTableResult = {
  table: RsDerivedCacheTable;
  copied: number;
  done: boolean;
  nextCursor: string | null;
};

export type RsDerivedCacheBackfillResult = {
  table: RsDerivedCacheBackfillTarget;
  copied: number;
  done: boolean;
  nextCursor: string | null;
  tables: RsDerivedCacheBackfillTableResult[];
};

export type RsDerivedCacheStatus = {
  scannerCacheDbAvailable: boolean;
  tables: Array<{
    table: RsDerivedCacheTable;
    legacyRowCount: number;
    scannerCacheRowCount: number | null;
  }>;
};

const RS_DERIVED_CACHE_TABLES: RsDerivedCacheTable[] = [
  "rs_ratio_cache",
  "relative_strength_latest_cache",
  "relative_strength_config_state",
];

const FIELD_ALIASES: Record<string, string> = {
  ticker: "ticker",
  symbol: "ticker",
  name: "name",
  company: "name",
  sector: "sector",
  industry: "industry",
  change: "change",
  change1d: "change",
  marketCap: "market_cap_basic",
  market_cap: "market_cap_basic",
  relative_volume: "relative_volume_10d_calc",
  relativeVolume: "relative_volume_10d_calc",
  price: "close",
  close: "close",
  avgVolume: "average_volume_30d_calc",
  averageVolume: "average_volume_30d_calc",
  volume: "volume",
  "Value.Traded": "Value.Traded",
  valueTraded: "Value.Traded",
  type: "type",
  exchange: "exchange",
  Exchange: "exchange",
  average_day_range_14: "ADR",
  averageDayRange14: "ADR",
  relativeStrengthScore: "rs_close",
  rsClose: "rs_close",
  relativeStrengthMa: "rs_ma",
  rsMa: "rs_ma",
  approxRsRating: "approx_rs_rating",
  vcpSignal: "vcp_signal",
  trendScore: "trend_score",
  dailyPivot: "daily_pivot",
  dailyPivotGapPct: "daily_pivot_gap_pct",
  weeklyHigh: "weekly_high",
  weeklyHighGapPct: "weekly_high_gap_pct",
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseRules(raw: unknown): ScanPresetRule[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as ScanPresetRule[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeScanType(value: string | null | undefined): "tradingview" | "relative-strength" | "vcp" {
  if (value === "relative-strength" || value === "vcp") return value;
  return "tradingview";
}

function normalizeOutputMode(value: string | null | undefined): RelativeStrengthOutputMode {
  if (value === "rs_new_high_only" || value === "rs_new_high_before_price_only" || value === "both") return value;
  return "all";
}

function normalizeRsMaType(value: string | null | undefined): RelativeStrengthMaType {
  return value === "SMA" ? "SMA" : "EMA";
}

function normalizeBenchmarkTicker(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  return normalized || null;
}

function benchmarkTickerForPreset(preset: Pick<ScanPreset, "benchmarkTicker"> | { benchmarkTicker?: string | null }): string {
  return normalizeBenchmarkTicker(preset.benchmarkTicker) ?? DEFAULT_RS_BENCHMARK;
}

function resolveBenchmarkTickerForData(benchmarkTicker: string): string {
  if (benchmarkTicker === "SP:SPX" || benchmarkTicker === "SPX" || benchmarkTicker === "GSPC" || benchmarkTicker === "^GSPC") {
    return "^GSPC";
  }
  return benchmarkTicker;
}

function relativeStrengthConfigKey(input: {
  benchmarkTicker: string;
  rsMaType: RelativeStrengthMaType;
  rsMaLength: number;
  newHighLookback: number;
}): string {
  return [
    normalizeBenchmarkTicker(input.benchmarkTicker) ?? DEFAULT_RS_BENCHMARK,
    normalizeRsMaType(input.rsMaType),
    Math.max(1, Math.trunc(input.rsMaLength)),
    Math.max(1, Math.trunc(input.newHighLookback)),
  ].join("|");
}

function buildRelativeStrengthConfigIdentity(
  preset: Pick<ScanPreset, "benchmarkTicker" | "rsMaType" | "rsMaLength" | "newHighLookback">,
  expectedTradingDate = latestUsSessionAsOfDate(new Date()),
): RelativeStrengthConfigIdentity {
  const benchmarkTicker = benchmarkTickerForPreset(preset);
  const rsMaType = normalizeRsMaType(preset.rsMaType);
  const rsMaLength = Math.max(1, Math.trunc(preset.rsMaLength));
  const newHighLookback = Math.max(1, Math.trunc(preset.newHighLookback));
  return {
    benchmarkTicker,
    benchmarkDataTicker: resolveBenchmarkTickerForData(benchmarkTicker),
    rsMaType,
    rsMaLength,
    newHighLookback,
    configKey: relativeStrengthConfigKey({ benchmarkTicker, rsMaType, rsMaLength, newHighLookback }),
    requiredBarCount: Math.max(newHighLookback, RS_REQUIRED_BAR_FLOOR, RS_RATIO_RETENTION_BARS),
    expectedTradingDate,
  };
}

function rawRelativeStrengthConfig(identity: RelativeStrengthConfigIdentity): RelativeStrengthConfig {
  return {
    benchmarkTicker: identity.benchmarkTicker,
    verticalOffset: RS_RAW_RATIO_VERTICAL_OFFSET,
    rsMaLength: identity.rsMaLength,
    rsMaType: identity.rsMaType,
    newHighLookback: identity.newHighLookback,
  };
}

function vcpConfigForPreset(preset: Pick<
  ScanPreset,
  "vcpDailyPivotLookback" | "vcpWeeklyHighLookback" | "vcpPivotAgeBars" | "vcpDailyNearPct" | "vcpWeeklyNearPct"
>): VcpConfig {
  return normalizeVcpConfig({
    dailyPivotLookback: preset.vcpDailyPivotLookback,
    weeklyHighLookback: preset.vcpWeeklyHighLookback,
    pivotAgeBars: preset.vcpPivotAgeBars,
    dailyNearPct: preset.vcpDailyNearPct,
    weeklyNearPct: preset.vcpWeeklyNearPct,
  });
}

function buildVcpConfigIdentity(
  preset: Pick<
    ScanPreset,
    "vcpDailyPivotLookback" | "vcpWeeklyHighLookback" | "vcpPivotAgeBars" | "vcpDailyNearPct" | "vcpWeeklyNearPct"
  >,
  expectedTradingDate = latestUsSessionAsOfDate(new Date()),
): VcpConfigIdentity {
  const config = vcpConfigForPreset(preset);
  return {
    config,
    configKey: vcpConfigKey(config),
    requiredBarCount: requiredVcpBarCount(config),
    expectedTradingDate,
  };
}

function buildRelativeStrengthConfigIdentityFromJobRecord(job: ScanRefreshJobRecord): RelativeStrengthConfigIdentity {
  const benchmarkTicker = normalizeBenchmarkTicker(job.benchmarkTicker) ?? DEFAULT_RS_BENCHMARK;
  const rsMaType = normalizeRsMaType(job.rsMaType);
  const rsMaLength = Math.max(1, Math.trunc(job.rsMaLength || 21));
  const newHighLookback = Math.max(1, Math.trunc(job.newHighLookback || 252));
  return {
    benchmarkTicker,
    benchmarkDataTicker: resolveBenchmarkTickerForData(benchmarkTicker),
    rsMaType,
    rsMaLength,
    newHighLookback,
    configKey: job.configKey ?? relativeStrengthConfigKey({ benchmarkTicker, rsMaType, rsMaLength, newHighLookback }),
    requiredBarCount: Math.max(1, Math.trunc(job.requiredBarCount || Math.max(newHighLookback, RS_REQUIRED_BAR_FLOOR, RS_RATIO_RETENTION_BARS))),
    expectedTradingDate: job.expectedTradingDate ?? latestUsSessionAsOfDate(new Date()),
  };
}

function buildRelativeStrengthConfigIdentityFromRunRecord(
  run: RelativeStrengthMaterializationRunRecord,
): RelativeStrengthConfigIdentity {
  const benchmarkTicker = normalizeBenchmarkTicker(run.benchmarkTicker) ?? DEFAULT_RS_BENCHMARK;
  const rsMaType = normalizeRsMaType(run.rsMaType);
  const rsMaLength = Math.max(1, Math.trunc(run.rsMaLength || 21));
  const newHighLookback = Math.max(1, Math.trunc(run.newHighLookback || 252));
  return {
    benchmarkTicker,
    benchmarkDataTicker: resolveBenchmarkTickerForData(benchmarkTicker),
    rsMaType,
    rsMaLength,
    newHighLookback,
    configKey: run.configKey,
    requiredBarCount: Math.max(1, Math.trunc(run.requiredBarCount || Math.max(newHighLookback, RS_REQUIRED_BAR_FLOOR, RS_RATIO_RETENTION_BARS))),
    expectedTradingDate: run.expectedTradingDate ?? latestUsSessionAsOfDate(new Date()),
  };
}

function toJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBooleanFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
  return false;
}

function parseNumericArray(value: string | null | undefined): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown[];
    return Array.isArray(parsed)
      ? parsed
        .map((entry) => asFiniteNumber(entry))
        .filter((entry): entry is number => entry != null)
      : [];
  } catch {
    return [];
  }
}

function parseRelativeStrengthConfigStateRecord(record: RelativeStrengthConfigStateRecord): RelativeStrengthConfigState {
  return {
    configKey: record.configKey,
    ticker: record.ticker.toUpperCase(),
    benchmarkTicker: record.benchmarkTicker.toUpperCase(),
    rsMaType: normalizeRsMaType(record.rsMaType),
    rsMaLength: Math.max(1, Math.trunc(record.rsMaLength || 21)),
    newHighLookback: Math.max(1, Math.trunc(record.newHighLookback || 252)),
    stateVersion: Math.max(0, Math.trunc(record.stateVersion || 0)),
    latestTradingDate: record.latestTradingDate,
    updatedAt: record.updatedAt,
    priceClose: record.priceClose,
    change1d: record.change1d,
    rsRatioClose: record.rsRatioClose,
    rsRatioMa: record.rsRatioMa,
    rsAboveMa: asBooleanFlag(record.rsAboveMa),
    rsNewHigh: asBooleanFlag(record.rsNewHigh),
    rsNewHighBeforePrice: asBooleanFlag(record.rsNewHighBeforePrice),
    bullCross: asBooleanFlag(record.bullCross),
    approxRsRating: record.approxRsRating,
    priceCloseHistory: parseNumericArray(record.priceCloseHistoryJson),
    benchmarkCloseHistory: parseNumericArray(record.benchmarkCloseHistoryJson),
    weightedScoreHistory: parseNumericArray(record.weightedScoreHistoryJson),
    rsNewHighWindow: parseNumericArray(record.rsNewHighWindowJson),
    priceNewHighWindow: parseNumericArray(record.priceNewHighWindowJson),
    smaWindow: parseNumericArray(record.smaWindowJson),
    smaSum: record.smaSum,
    emaValue: record.emaValue,
    previousRsClose: record.previousRsClose,
    previousRsMa: record.previousRsMa,
  };
}

function stateRowToLatestCacheRecord(state: RelativeStrengthConfigState): RelativeStrengthLatestCacheRecord {
  return {
    ticker: state.ticker.toUpperCase(),
    benchmarkTicker: state.benchmarkTicker.toUpperCase(),
    rsMaType: state.rsMaType,
    rsMaLength: state.rsMaLength,
    newHighLookback: state.newHighLookback,
    tradingDate: state.latestTradingDate,
    priceClose: state.priceClose,
    change1d: state.change1d,
    rsRatioClose: state.rsRatioClose,
    rsRatioMa: state.rsRatioMa,
    rsAboveMa: state.rsAboveMa,
    rsNewHigh: state.rsNewHigh,
    rsNewHighBeforePrice: state.rsNewHighBeforePrice,
    bullCross: state.bullCross,
    approxRsRating: state.approxRsRating,
  };
}

function asComparableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text.toLowerCase() : null;
}

function normalizeTicker(value: unknown): string | null {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) return null;
  const candidate = text.includes(":") ? text.split(":").pop() ?? text : text;
  return /^[A-Z0-9.\-^]{1,20}$/.test(candidate) ? candidate : null;
}

function normalizeFieldName(field: string): string {
  return FIELD_ALIASES[field.trim()] ?? field.trim();
}

function requiredRelativeStrengthBarCount(preset: Pick<ScanPreset, "newHighLookback">): number {
  return Math.max(preset.newHighLookback, RS_REQUIRED_BAR_FLOOR);
}

function calendarLookbackDaysForBars(barCount: number): number {
  return Math.ceil(barCount * 7 / 5) + 35;
}

function deserializeBenchmarkBars(raw: string | null | undefined): RelativeStrengthDailyBar[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as RelativeStrengthDailyBar[];
    return Array.isArray(parsed)
      ? parsed.filter((row) => typeof row?.ticker === "string" && typeof row?.date === "string")
      : [];
  } catch {
    return [];
  }
}

function snapshotRowToJobCandidate(
  row: ScanSnapshotRow,
  cursorOffset: number,
  materializationRequired = true,
): RelativeStrengthJobCandidateRow {
  return {
    cursorOffset,
    ticker: row.ticker.toUpperCase(),
    name: row.name ?? null,
    sector: row.sector ?? null,
    industry: row.industry ?? null,
    marketCap: row.marketCap ?? null,
    relativeVolume: row.relativeVolume ?? null,
    avgVolume: row.avgVolume ?? null,
    priceAvgVolume: row.priceAvgVolume ?? null,
    materializationRequired,
  };
}

function mapJobRecordToJob(record: ScanRefreshJobRecord, preset: ScanPreset): ScanRefreshJob {
  return {
    id: record.id,
    presetId: preset.id,
    presetName: preset.name,
    jobType: "relative-strength",
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    error: record.error,
    totalCandidates: record.totalCandidates,
    processedCandidates: record.processedCandidates,
    matchedCandidates: record.matchedCandidates,
    cursorOffset: record.cursorOffset,
    latestSnapshotId: record.latestSnapshotId,
    requestedBy: record.requestedBy,
    configKey: record.configKey ?? null,
    sharedRunId: record.sharedRunId ?? null,
    expectedTradingDate: record.expectedTradingDate ?? null,
    fullCandidateCount: record.fullCandidateCount,
    materializationCandidateCount: record.materializationCandidateCount,
    alreadyCurrentCandidateCount: record.alreadyCurrentCandidateCount,
    lastAdvancedAt: record.lastAdvancedAt,
    deferredTickerCount: record.deferredTickerCount,
    warning: record.warning,
    phase: record.phase,
    elapsedMs: elapsedMs(record.startedAt, record.completedAt),
    durationMs: elapsedMs(record.startedAt, record.completedAt),
    cacheHitCount: record.alreadyCurrentCandidateCount,
    computedCount: record.matchedCandidates,
    missingBarsCount: 0,
    insufficientHistoryCount: 0,
    errorCount: record.status === "failed" ? 1 : 0,
    staleBenchmarkCount: 0,
    appliesToPreset: true,
  };
}

function elapsedMs(startedAt: string | null | undefined, completedAt?: string | null): number | null {
  const start = toTimestampMs(startedAt);
  if (start == null) return null;
  const end = completedAt ? toTimestampMs(completedAt) : Date.now();
  if (end == null || end < start) return null;
  return Math.max(0, Math.trunc(end - start));
}

function mapManualRunRecordToJob(
  record: ManualRelativeStrengthRunRecord,
  options?: { appliesToPreset?: boolean },
): ScanRefreshJob {
  const computedElapsedMs = elapsedMs(record.startedAt ?? record.createdAt, record.completedAt);
  return {
    id: record.id,
    presetId: record.presetId,
    presetName: record.presetName,
    jobType: "relative-strength",
    status: record.status,
    startedAt: record.startedAt ?? record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    error: record.error,
    totalCandidates: record.totalTickers,
    processedCandidates: record.processedTickers,
    matchedCandidates: record.matchedTickers,
    cursorOffset: record.cursorOffset,
    latestSnapshotId: record.latestSnapshotId,
    requestedBy: record.requestedBy,
    configKey: record.configKey,
    sharedRunId: record.id,
    expectedTradingDate: record.expectedTradingDate,
    fullCandidateCount: record.totalTickers,
    materializationCandidateCount: record.totalTickers,
    alreadyCurrentCandidateCount: 0,
    lastAdvancedAt: record.heartbeatAt ?? record.updatedAt,
    deferredTickerCount: 0,
    warning: record.warning,
    phase: record.status === "completed" || record.status === "failed" ? record.status : "manual",
    elapsedMs: record.status === "completed" || record.status === "failed" ? record.durationMs ?? computedElapsedMs : computedElapsedMs,
    durationMs: record.durationMs ?? (record.status === "completed" || record.status === "failed" ? computedElapsedMs : null),
    cacheHitCount: record.cacheHitTickers,
    computedCount: record.computedTickers,
    missingBarsCount: record.missingBarsTickers,
    insufficientHistoryCount: record.insufficientHistoryTickers,
    errorCount: record.errorTickers,
    staleBenchmarkCount: record.staleBenchmarkTickers,
    appliesToPreset: options?.appliesToPreset ?? true,
  };
}

function normalizeScalarValue(value: string | number | boolean): string | number | boolean {
  if (typeof value === "string") return value.trim();
  return value;
}

function isFieldReferenceValue(value: ScanRuleValue): value is ScanRuleFieldReference {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.type === "field";
}

function normalizeRuleValues(value: ScanRuleValue): Array<string | number | boolean> {
  if (isFieldReferenceValue(value)) return [];
  if (Array.isArray(value)) return value.map((item) => normalizeScalarValue(item));
  return [normalizeScalarValue(value)];
}

function isNumericRule(rule: ScanPresetRule): boolean {
  if (isFieldReferenceValue(rule.value)) return false;
  return normalizeRuleValues(rule.value).every((value) => typeof value === "number");
}

function shouldPushRuleUpstream(rule: ScanPresetRule): boolean {
  if (isFieldReferenceValue(rule.value)) {
    const multiplier = typeof rule.value.multiplier === "number" && Number.isFinite(rule.value.multiplier)
      ? rule.value.multiplier
      : 1;
    return multiplier === 1 && ["gt", "gte", "lt", "lte", "eq", "neq"].includes(rule.operator);
  }
  if (!isNumericRule(rule)) return false;
  return ["gt", "gte", "lt", "lte", "eq", "neq"].includes(rule.operator);
}

function mapRuleToTradingViewFilter(rule: ScanPresetRule): TradingViewFilter | null {
  const field = normalizeFieldName(rule.field);
  if (isFieldReferenceValue(rule.value)) {
    if (!shouldPushRuleUpstream(rule)) return null;
    if (rule.operator === "gt") return { left: field, operation: "greater", right: normalizeFieldName(rule.value.field) };
    if (rule.operator === "gte") return { left: field, operation: "egreater", right: normalizeFieldName(rule.value.field) };
    if (rule.operator === "lt") return { left: field, operation: "less", right: normalizeFieldName(rule.value.field) };
    if (rule.operator === "lte") return { left: field, operation: "eless", right: normalizeFieldName(rule.value.field) };
    if (rule.operator === "eq") return { left: field, operation: "equal", right: normalizeFieldName(rule.value.field) };
    if (rule.operator === "neq") return { left: field, operation: "nequal", right: normalizeFieldName(rule.value.field) };
    return null;
  }
  if (!shouldPushRuleUpstream(rule)) return null;
  const [value] = normalizeRuleValues(rule.value);
  if (typeof value !== "number") return null;
  if (rule.operator === "gt") return { left: field, operation: "greater", right: value };
  if (rule.operator === "gte") return { left: field, operation: "egreater", right: value };
  if (rule.operator === "lt") return { left: field, operation: "less", right: value };
  if (rule.operator === "lte") return { left: field, operation: "eless", right: value };
  if (rule.operator === "eq") return { left: field, operation: "equal", right: value };
  if (rule.operator === "neq") return { left: field, operation: "nequal", right: value };
  return null;
}

function resolveRuleTargetValue(row: TradingViewScanRow, rule: ScanPresetRule): unknown {
  if (!isFieldReferenceValue(rule.value)) {
    return normalizeRuleValues(rule.value)[0];
  }
  const compareField = rule.value.field.trim();
  if (!compareField) return null;
  const baseValue = rowValueForField(row, compareField);
  const baseNumber = asFiniteNumber(baseValue);
  const multiplier = typeof rule.value.multiplier === "number" && Number.isFinite(rule.value.multiplier)
    ? rule.value.multiplier
    : 1;
  if (baseNumber != null) return baseNumber * multiplier;
  const baseText = asComparableString(baseValue);
  return multiplier === 1 ? baseText : null;
}

function valueMatchesRule(candidate: unknown, rule: ScanPresetRule, row: TradingViewScanRow): boolean {
  if (isFieldReferenceValue(rule.value) && (rule.operator === "in" || rule.operator === "not_in")) {
    return false;
  }
  const values = normalizeRuleValues(rule.value);
  if (rule.operator === "in" || rule.operator === "not_in") {
    const candidateText = asComparableString(candidate);
    const set = new Set(values.map((value) => asComparableString(value)).filter((value): value is string => Boolean(value)));
    const hit = candidateText != null && set.has(candidateText);
    return rule.operator === "in" ? hit : !hit;
  }

  const candidateNumber = asFiniteNumber(candidate);
  const comparisonTarget = resolveRuleTargetValue(row, rule);
  const ruleNumber = typeof comparisonTarget === "number" ? comparisonTarget : asFiniteNumber(comparisonTarget);
  if (candidateNumber != null && ruleNumber != null) {
    if (rule.operator === "gt") return candidateNumber > ruleNumber;
    if (rule.operator === "gte") return candidateNumber >= ruleNumber;
    if (rule.operator === "lt") return candidateNumber < ruleNumber;
    if (rule.operator === "lte") return candidateNumber <= ruleNumber;
    if (rule.operator === "eq") return candidateNumber === ruleNumber;
    if (rule.operator === "neq") return candidateNumber !== ruleNumber;
  }

  const candidateText = asComparableString(candidate);
  const ruleText = asComparableString(comparisonTarget);
  if (candidateText == null || ruleText == null) return false;
  if (rule.operator === "eq") return candidateText === ruleText;
  if (rule.operator === "neq") return candidateText !== ruleText;
  if (rule.operator === "gt") return candidateText > ruleText;
  if (rule.operator === "gte") return candidateText >= ruleText;
  if (rule.operator === "lt") return candidateText < ruleText;
  if (rule.operator === "lte") return candidateText <= ruleText;
  return false;
}

function rowValueForField(row: TradingViewScanRow, field: string): unknown {
  const normalized = normalizeFieldName(field);
  if (normalized === "ticker") return row.ticker;
  if (normalized === "name") return row.name;
  if (normalized === "sector") return row.sector;
  if (normalized === "industry") return row.industry;
  if (normalized === "change") return row.change1d;
  if (normalized === "market_cap_basic") return row.marketCap;
  if (normalized === "relative_volume_10d_calc") return row.relativeVolume;
  if (normalized === "close") return row.price;
  if (normalized === "average_volume_30d_calc") return row.avgVolume;
  if (normalized === "Value.Traded") return row.priceAvgVolume;
  if (normalized === "volume") return row.volume;
  if (normalized === "exchange") return row.exchange;
  if (normalized === "type") return row.type;
  return (row.raw as Record<string, unknown> | null)?.[normalized];
}

function rowMatchesRules(row: TradingViewScanRow, rules: ScanPresetRule[]): boolean {
  return rules.every((rule) => valueMatchesRule(rowValueForField(row, rule.field), rule, row));
}

function normalizeScanRow(row: TradingViewScanRow): ScanSnapshotRow | null {
  const ticker = normalizeTicker(row.ticker);
  if (!ticker) return null;
  const price = asFiniteNumber(row.price);
  const avgVolume = asFiniteNumber(row.avgVolume);
  const priceAvgVolume = asFiniteNumber(row.priceAvgVolume) ?? (
    price != null && avgVolume != null ? price * avgVolume : null
  );
  const raw = (row.raw as Record<string, unknown> | null) ?? null;
  return {
    ticker,
    name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : null,
    sector: typeof row.sector === "string" && row.sector.trim() ? row.sector.trim() : null,
    industry: typeof row.industry === "string" && row.industry.trim() ? row.industry.trim() : null,
    change1d: asFiniteNumber(row.change1d),
    marketCap: asFiniteNumber(row.marketCap),
    relativeVolume: asFiniteNumber(row.relativeVolume),
    price,
    avgVolume,
    priceAvgVolume,
    rsClose: asFiniteNumber(raw?.rsClose ?? raw?.rs_close),
    rsMa: asFiniteNumber(raw?.rsMa ?? raw?.rs_ma),
    rsAboveMa: Boolean(raw?.rsAboveMa ?? raw?.rs_above_ma),
    rsNewHigh: Boolean(raw?.rsNewHigh ?? raw?.rs_new_high),
    rsNewHighBeforePrice: Boolean(raw?.rsNewHighBeforePrice ?? raw?.rs_new_high_before_price),
    bullCross: Boolean(raw?.bullCross ?? raw?.bull_cross),
    approxRsRating: asFiniteNumber(raw?.approxRsRating ?? raw?.approx_rs_rating),
    rawJson: toJson(row.raw ?? row),
  };
}

export function normalizeScanRows(rows: TradingViewScanRow[] | null | undefined): ScanSnapshotRow[] {
  return (rows ?? [])
    .map(normalizeScanRow)
    .filter((row): row is ScanSnapshotRow => Boolean(row));
}

function sortSnapshotRows(rows: ScanSnapshotRow[], sortField: string, sortDirection: "asc" | "desc"): ScanSnapshotRow[] {
  const direction = sortDirection === "asc" ? 1 : -1;
  const normalized = normalizeFieldName(sortField);
  const valueFor = (row: ScanSnapshotRow): string | number => {
    if (normalized === "ticker") return row.ticker;
    if (normalized === "name") return row.name ?? row.ticker;
    if (normalized === "sector") return row.sector ?? "";
    if (normalized === "industry") return row.industry ?? "";
    if (normalized === "market_cap_basic") return row.marketCap ?? Number.NEGATIVE_INFINITY;
    if (normalized === "relative_volume_10d_calc") return row.relativeVolume ?? Number.NEGATIVE_INFINITY;
    if (normalized === "close") return row.price ?? Number.NEGATIVE_INFINITY;
    if (normalized === "Value.Traded") return row.priceAvgVolume ?? Number.NEGATIVE_INFINITY;
    if (normalized === "rs_close") return row.rsClose ?? Number.NEGATIVE_INFINITY;
    if (normalized === "rs_ma") return row.rsMa ?? Number.NEGATIVE_INFINITY;
    if (normalized === "approx_rs_rating") return row.approxRsRating ?? Number.NEGATIVE_INFINITY;
    if (normalized === "trend_score" || normalized === "daily_pivot" || normalized === "daily_pivot_gap_pct" || normalized === "weekly_high" || normalized === "weekly_high_gap_pct") {
      try {
        const raw = row.rawJson ? JSON.parse(row.rawJson) as Record<string, unknown> : null;
        const camelField = normalized.replace(/_([a-z])/g, (_match: string, char: string) => char.toUpperCase());
        return asFiniteNumber(raw?.[normalized]) ?? asFiniteNumber(raw?.[camelField]) ?? Number.NEGATIVE_INFINITY;
      } catch {
        return Number.NEGATIVE_INFINITY;
      }
    }
    return row.change1d ?? Number.NEGATIVE_INFINITY;
  };
  return [...rows].sort((a, b) => {
    const left = valueFor(a);
    const right = valueFor(b);
    if (typeof left === "string" || typeof right === "string") {
      const comparison = String(left).localeCompare(String(right));
      if (comparison !== 0) return comparison * direction;
      return a.ticker.localeCompare(b.ticker);
    }
    const comparison = left - right;
    if (comparison !== 0) return comparison * direction;
    return a.ticker.localeCompare(b.ticker);
  });
}

function mapPresetRow(row: {
  id: string;
  name: string;
  scanType?: string | null;
  isDefault: number;
  isActive: number;
  rulesJson: string;
  prefilterRulesJson?: string | null;
  benchmarkTicker?: string | null;
  verticalOffset?: number | null;
  rsMaLength?: number | null;
  rsMaType?: string | null;
  newHighLookback?: number | null;
  outputMode?: string | null;
  vcpDailyPivotLookback?: number | null;
  vcpWeeklyHighLookback?: number | null;
  vcpPivotAgeBars?: number | null;
  vcpDailyNearPct?: number | null;
  vcpWeeklyNearPct?: number | null;
  sortField: string;
  sortDirection: "asc" | "desc";
  rowLimit: number;
  createdAt: string;
  updatedAt: string;
}): ScanPreset {
  const vcpConfig = normalizeVcpConfig({
    dailyPivotLookback: row.vcpDailyPivotLookback ?? undefined,
    weeklyHighLookback: row.vcpWeeklyHighLookback ?? undefined,
    pivotAgeBars: row.vcpPivotAgeBars ?? undefined,
    dailyNearPct: row.vcpDailyNearPct ?? undefined,
    weeklyNearPct: row.vcpWeeklyNearPct ?? undefined,
  });
  return {
    id: row.id,
    name: row.name,
    scanType: normalizeScanType(row.scanType),
    isDefault: Boolean(row.isDefault),
    isActive: Boolean(row.isActive),
    rules: parseRules(row.rulesJson),
    prefilterRules: parseRules(row.prefilterRulesJson ?? row.rulesJson),
    benchmarkTicker: normalizeBenchmarkTicker(row.benchmarkTicker),
    verticalOffset: Number.isFinite(Number(row.verticalOffset)) ? Number(row.verticalOffset) : 30,
    rsMaLength: clamp(Number(row.rsMaLength ?? 21), 1, 250),
    rsMaType: normalizeRsMaType(row.rsMaType),
    newHighLookback: clamp(Number(row.newHighLookback ?? 252), 1, 520),
    outputMode: normalizeOutputMode(row.outputMode),
    vcpDailyPivotLookback: vcpConfig.dailyPivotLookback,
    vcpWeeklyHighLookback: vcpConfig.weeklyHighLookback,
    vcpPivotAgeBars: vcpConfig.pivotAgeBars,
    vcpDailyNearPct: vcpConfig.dailyNearPct,
    vcpWeeklyNearPct: vcpConfig.weeklyNearPct,
    sortField: row.sortField,
    sortDirection: row.sortDirection === "asc" ? "asc" : "desc",
    rowLimit: clamp(Number(row.rowLimit ?? DEFAULT_LIMIT), 1, 250),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type ScanCompilePresetQueryRow = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  scanPresetId: string | null;
  scanPresetName: string | null;
  sortOrder: number | null;
};

function aggregateCompilePresets(rows: ScanCompilePresetQueryRow[]): ScanCompilePresetDetail[] {
  const map = new Map<string, ScanCompilePresetDetail>();
  for (const row of rows) {
    let current = map.get(row.id);
    if (!current) {
      current = {
        id: row.id,
        name: row.name,
        memberCount: 0,
        presetIds: [],
        presetNames: [],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        members: [],
      };
      map.set(row.id, current);
    }
    if (!row.scanPresetId || !row.scanPresetName) continue;
    current.members.push({
      scanPresetId: row.scanPresetId,
      scanPresetName: row.scanPresetName,
      sortOrder: Number(row.sortOrder ?? current.members.length + 1),
    });
    current.presetIds.push(row.scanPresetId);
    current.presetNames.push(row.scanPresetName);
  }
  return Array.from(map.values()).map((preset) => ({
    ...preset,
    memberCount: preset.members.length,
    members: [...preset.members].sort((left, right) => left.sortOrder - right.sortOrder),
  }));
}

async function queryScanCompilePresets(env: Env, compilePresetId?: string): Promise<ScanCompilePresetDetail[]> {
  const baseQuery = `
    SELECT
      cp.id,
      cp.name,
      cp.created_at as createdAt,
      cp.updated_at as updatedAt,
      m.scan_preset_id as scanPresetId,
      sp.name as scanPresetName,
      m.sort_order as sortOrder
    FROM scan_compile_presets cp
    LEFT JOIN scan_compile_preset_members m
      ON m.compile_preset_id = cp.id
    LEFT JOIN scan_presets sp
      ON sp.id = m.scan_preset_id
    ${compilePresetId ? "WHERE cp.id = ?" : ""}
    ORDER BY datetime(cp.updated_at) DESC, datetime(cp.created_at) DESC, m.sort_order ASC, sp.name ASC
  `;
  const request = env.DB.prepare(baseQuery);
  const rows = compilePresetId
    ? await request.bind(compilePresetId).all<ScanCompilePresetQueryRow>()
    : await request.all<ScanCompilePresetQueryRow>();
  return aggregateCompilePresets(rows.results ?? []);
}

export async function listScanCompilePresets(env: Env): Promise<ScanCompilePresetRow[]> {
  return (await queryScanCompilePresets(env)).map(({ members, ...preset }) => preset);
}

export async function loadScanCompilePreset(env: Env, compilePresetId: string): Promise<ScanCompilePresetDetail | null> {
  return (await queryScanCompilePresets(env, compilePresetId))[0] ?? null;
}

async function resolveCompilePresetMemberIds(env: Env, scanPresetIds: string[]): Promise<string[]> {
  const normalized = Array.from(new Set(
    scanPresetIds
      .map((value) => value.trim())
      .filter(Boolean),
  ));
  if (normalized.length === 0) throw new Error("Choose at least one scan preset.");
  const existingPresets = await Promise.all(normalized.map((presetId) => loadScanPreset(env, presetId)));
  const missingIds = normalized.filter((_, index) => !existingPresets[index]);
  if (missingIds.length > 0) {
    throw new Error(`Unknown scan preset: ${missingIds[0]}`);
  }
  return normalized;
}

export async function upsertScanCompilePreset(env: Env, input: {
  id?: string | null;
  name: string;
  scanPresetIds: string[];
}): Promise<ScanCompilePresetDetail> {
  const id = input.id?.trim() || crypto.randomUUID();
  const scanPresetIds = await resolveCompilePresetMemberIds(env, input.scanPresetIds);
  const name = input.name.trim();
  if (!name) throw new Error("Compile preset name is required.");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO scan_compile_presets (id, name, created_at, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(id, name),
    env.DB.prepare("DELETE FROM scan_compile_preset_members WHERE compile_preset_id = ?").bind(id),
    ...scanPresetIds.map((presetId, index) =>
      env.DB.prepare(
        "INSERT INTO scan_compile_preset_members (compile_preset_id, scan_preset_id, sort_order) VALUES (?, ?, ?)",
      ).bind(id, presetId, index + 1),
    ),
  ]);
  const saved = await loadScanCompilePreset(env, id);
  if (!saved) throw new Error("Failed to persist scan compile preset.");
  return saved;
}

export async function deleteScanCompilePreset(env: Env, compilePresetId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM scan_compile_preset_members WHERE compile_preset_id = ?").bind(compilePresetId),
    env.DB.prepare("DELETE FROM scan_compile_presets WHERE id = ?").bind(compilePresetId),
  ]);
}

async function listReferencingCompilePresetNames(env: Env, scanPresetId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT cp.name as name
     FROM scan_compile_presets cp
     JOIN scan_compile_preset_members m
       ON m.compile_preset_id = cp.id
     WHERE m.scan_preset_id = ?
     ORDER BY datetime(cp.updated_at) DESC, datetime(cp.created_at) DESC, cp.name ASC`,
  ).bind(scanPresetId).all<{ name: string }>();
  return (rows.results ?? []).map((row) => row.name).filter(Boolean);
}

function nextDuplicatePresetName(sourceName: string, existingNames: string[]): string {
  const trimmedSourceName = sourceName.trim();
  const occupied = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  const firstCandidate = `${trimmedSourceName} Copy`;
  if (!occupied.has(firstCandidate.toLowerCase())) return firstCandidate;
  let counter = 2;
  while (occupied.has(`${trimmedSourceName} Copy ${counter}`.toLowerCase())) {
    counter += 1;
  }
  return `${trimmedSourceName} Copy ${counter}`;
}

export async function listScanPresets(env: Env): Promise<ScanPreset[]> {
  const rows = await env.DB.prepare(
    "SELECT id, name, scan_type as scanType, is_default as isDefault, is_active as isActive, rules_json as rulesJson, prefilter_rules_json as prefilterRulesJson, benchmark_ticker as benchmarkTicker, vertical_offset as verticalOffset, rs_ma_length as rsMaLength, rs_ma_type as rsMaType, new_high_lookback as newHighLookback, output_mode as outputMode, vcp_daily_pivot_lookback as vcpDailyPivotLookback, vcp_weekly_high_lookback as vcpWeeklyHighLookback, vcp_pivot_age_bars as vcpPivotAgeBars, vcp_daily_near_pct as vcpDailyNearPct, vcp_weekly_near_pct as vcpWeeklyNearPct, sort_field as sortField, sort_direction as sortDirection, row_limit as rowLimit, created_at as createdAt, updated_at as updatedAt FROM scan_presets ORDER BY is_default DESC, updated_at DESC, created_at DESC",
  ).all<{
    id: string;
    name: string;
    scanType: string | null;
    isDefault: number;
    isActive: number;
    rulesJson: string;
    prefilterRulesJson: string | null;
    benchmarkTicker: string | null;
    verticalOffset: number | null;
    rsMaLength: number | null;
    rsMaType: string | null;
    newHighLookback: number | null;
    outputMode: string | null;
    sortField: string;
    sortDirection: "asc" | "desc";
    rowLimit: number;
    createdAt: string;
    updatedAt: string;
  }>();
  return (rows.results ?? []).map(mapPresetRow);
}

export async function loadScanPreset(env: Env, presetId: string): Promise<ScanPreset | null> {
  const row = await env.DB.prepare(
    "SELECT id, name, scan_type as scanType, is_default as isDefault, is_active as isActive, rules_json as rulesJson, prefilter_rules_json as prefilterRulesJson, benchmark_ticker as benchmarkTicker, vertical_offset as verticalOffset, rs_ma_length as rsMaLength, rs_ma_type as rsMaType, new_high_lookback as newHighLookback, output_mode as outputMode, vcp_daily_pivot_lookback as vcpDailyPivotLookback, vcp_weekly_high_lookback as vcpWeeklyHighLookback, vcp_pivot_age_bars as vcpPivotAgeBars, vcp_daily_near_pct as vcpDailyNearPct, vcp_weekly_near_pct as vcpWeeklyNearPct, sort_field as sortField, sort_direction as sortDirection, row_limit as rowLimit, created_at as createdAt, updated_at as updatedAt FROM scan_presets WHERE id = ? LIMIT 1",
  )
    .bind(presetId)
    .first<{
      id: string;
      name: string;
      scanType: string | null;
      isDefault: number;
      isActive: number;
      rulesJson: string;
      prefilterRulesJson: string | null;
      benchmarkTicker: string | null;
      verticalOffset: number | null;
      rsMaLength: number | null;
      rsMaType: string | null;
      newHighLookback: number | null;
      outputMode: string | null;
      sortField: string;
      sortDirection: "asc" | "desc";
      rowLimit: number;
      createdAt: string;
      updatedAt: string;
    }>();
  return row ? mapPresetRow(row) : null;
}

export async function loadDefaultScanPreset(env: Env): Promise<ScanPreset | null> {
  const row = await env.DB.prepare(
    "SELECT id, name, scan_type as scanType, is_default as isDefault, is_active as isActive, rules_json as rulesJson, prefilter_rules_json as prefilterRulesJson, benchmark_ticker as benchmarkTicker, vertical_offset as verticalOffset, rs_ma_length as rsMaLength, rs_ma_type as rsMaType, new_high_lookback as newHighLookback, output_mode as outputMode, vcp_daily_pivot_lookback as vcpDailyPivotLookback, vcp_weekly_high_lookback as vcpWeeklyHighLookback, vcp_pivot_age_bars as vcpPivotAgeBars, vcp_daily_near_pct as vcpDailyNearPct, vcp_weekly_near_pct as vcpWeeklyNearPct, sort_field as sortField, sort_direction as sortDirection, row_limit as rowLimit, created_at as createdAt, updated_at as updatedAt FROM scan_presets WHERE is_default = 1 LIMIT 1",
  ).first<{
    id: string;
    name: string;
    scanType: string | null;
    isDefault: number;
    isActive: number;
    rulesJson: string;
    prefilterRulesJson: string | null;
    benchmarkTicker: string | null;
    verticalOffset: number | null;
    rsMaLength: number | null;
    rsMaType: string | null;
    newHighLookback: number | null;
    outputMode: string | null;
    sortField: string;
    sortDirection: "asc" | "desc";
    rowLimit: number;
    createdAt: string;
    updatedAt: string;
  }>();
  if (row) return mapPresetRow(row);
  const presets = await listScanPresets(env);
  return presets[0] ?? null;
}

export async function upsertScanPreset(env: Env, input: {
  id?: string | null;
  name: string;
  scanType?: "tradingview" | "relative-strength" | "vcp";
  isDefault?: boolean;
  isActive?: boolean;
  rules?: ScanPresetRule[];
  prefilterRules?: ScanPresetRule[];
  benchmarkTicker?: string | null;
  verticalOffset?: number;
  rsMaLength?: number;
  rsMaType?: RelativeStrengthMaType;
  newHighLookback?: number;
  outputMode?: RelativeStrengthOutputMode;
  vcpDailyPivotLookback?: number;
  vcpWeeklyHighLookback?: number;
  vcpPivotAgeBars?: number;
  vcpDailyNearPct?: number;
  vcpWeeklyNearPct?: number;
  sortField?: string;
  sortDirection?: "asc" | "desc";
  rowLimit?: number;
}): Promise<ScanPreset> {
  const id = input.id?.trim() || crypto.randomUUID();
  const scanType = normalizeScanType(input.scanType);
  const isDefault = input.isDefault === true;
  const rules = input.rules ?? [];
  const prefilterRules = input.prefilterRules ?? rules;
  const vcpConfig = normalizeVcpConfig({
    dailyPivotLookback: input.vcpDailyPivotLookback,
    weeklyHighLookback: input.vcpWeeklyHighLookback,
    pivotAgeBars: input.vcpPivotAgeBars,
    dailyNearPct: input.vcpDailyNearPct,
    weeklyNearPct: input.vcpWeeklyNearPct,
  });
  if (isDefault) {
    await env.DB.prepare("UPDATE scan_presets SET is_default = 0 WHERE is_default = 1").run();
  }
  await env.DB.prepare(
    `INSERT INTO scan_presets (id, name, scan_type, is_default, is_active, rules_json, prefilter_rules_json, benchmark_ticker, vertical_offset, rs_ma_length, rs_ma_type, new_high_lookback, output_mode, vcp_daily_pivot_lookback, vcp_weekly_high_lookback, vcp_pivot_age_bars, vcp_daily_near_pct, vcp_weekly_near_pct, sort_field, sort_direction, row_limit, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       scan_type = excluded.scan_type,
       is_default = excluded.is_default,
       is_active = excluded.is_active,
       rules_json = excluded.rules_json,
       prefilter_rules_json = excluded.prefilter_rules_json,
       benchmark_ticker = excluded.benchmark_ticker,
       vertical_offset = excluded.vertical_offset,
       rs_ma_length = excluded.rs_ma_length,
       rs_ma_type = excluded.rs_ma_type,
       new_high_lookback = excluded.new_high_lookback,
       output_mode = excluded.output_mode,
       vcp_daily_pivot_lookback = excluded.vcp_daily_pivot_lookback,
       vcp_weekly_high_lookback = excluded.vcp_weekly_high_lookback,
       vcp_pivot_age_bars = excluded.vcp_pivot_age_bars,
       vcp_daily_near_pct = excluded.vcp_daily_near_pct,
       vcp_weekly_near_pct = excluded.vcp_weekly_near_pct,
       sort_field = excluded.sort_field,
       sort_direction = excluded.sort_direction,
       row_limit = excluded.row_limit,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      id,
      input.name.trim(),
      scanType,
      isDefault ? 1 : 0,
      input.isActive === false ? 0 : 1,
      JSON.stringify(rules),
      JSON.stringify(prefilterRules),
      scanType === "relative-strength" ? (normalizeBenchmarkTicker(input.benchmarkTicker) ?? DEFAULT_RS_BENCHMARK) : null,
      Number.isFinite(Number(input.verticalOffset)) ? Number(input.verticalOffset) : 30,
      clamp(Number(input.rsMaLength ?? 21), 1, 250),
      normalizeRsMaType(input.rsMaType),
      clamp(Number(input.newHighLookback ?? 252), 1, 520),
      normalizeOutputMode(input.outputMode),
      vcpConfig.dailyPivotLookback,
      vcpConfig.weeklyHighLookback,
      vcpConfig.pivotAgeBars,
      vcpConfig.dailyNearPct,
      vcpConfig.weeklyNearPct,
      input.sortField?.trim() || "change",
      input.sortDirection === "asc" ? "asc" : "desc",
      clamp(Number(input.rowLimit ?? DEFAULT_LIMIT), 1, 250),
    )
    .run();

  const saved = await loadScanPreset(env, id);
  if (!saved) throw new Error("Failed to persist scan preset.");
  return saved;
}

export async function duplicateScanPreset(env: Env, presetId: string): Promise<ScanPreset> {
  const existing = await loadScanPreset(env, presetId);
  if (!existing) throw new Error("Scan preset not found.");
  const name = nextDuplicatePresetName(existing.name, (await listScanPresets(env)).map((preset) => preset.name));
  return upsertScanPreset(env, {
    name,
    scanType: existing.scanType,
    isDefault: false,
    isActive: existing.isActive,
    rules: JSON.parse(JSON.stringify(existing.rules)) as ScanPresetRule[],
    prefilterRules: JSON.parse(JSON.stringify(existing.prefilterRules)) as ScanPresetRule[],
    benchmarkTicker: existing.benchmarkTicker,
    verticalOffset: existing.verticalOffset,
    rsMaLength: existing.rsMaLength,
    rsMaType: existing.rsMaType,
    newHighLookback: existing.newHighLookback,
    outputMode: existing.outputMode,
    vcpDailyPivotLookback: existing.vcpDailyPivotLookback,
    vcpWeeklyHighLookback: existing.vcpWeeklyHighLookback,
    vcpPivotAgeBars: existing.vcpPivotAgeBars,
    vcpDailyNearPct: existing.vcpDailyNearPct,
    vcpWeeklyNearPct: existing.vcpWeeklyNearPct,
    sortField: existing.sortField,
    sortDirection: existing.sortDirection,
    rowLimit: existing.rowLimit,
  });
}

export async function deleteScanPreset(env: Env, presetId: string): Promise<void> {
  const preset = await loadScanPreset(env, presetId);
  if (!preset) return;
  if (preset.isDefault) throw new Error("Default preset cannot be deleted.");
  const compilePresetNames = await listReferencingCompilePresetNames(env, presetId);
  if (compilePresetNames.length > 0) {
    throw new Error(`Cannot delete scan preset because it is used by compile presets: ${compilePresetNames.join(", ")}`);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM scan_refresh_jobs WHERE preset_id = ?").bind(presetId),
    env.DB.prepare("DELETE FROM scan_rows WHERE snapshot_id IN (SELECT id FROM scan_snapshots WHERE preset_id = ?)").bind(presetId),
    env.DB.prepare("DELETE FROM scan_snapshots WHERE preset_id = ?").bind(presetId),
    env.DB.prepare("DELETE FROM scan_presets WHERE id = ?").bind(presetId),
  ]);
}

function hasPostFilters(preset: ScanPreset): boolean {
  return preset.rules.some((rule) => !shouldPushRuleUpstream(rule));
}

function paginatedFetchTarget(preset: ScanPreset): number {
  return clamp(Math.max(preset.rowLimit * 20, MAX_FETCH_RANGE * 2), MAX_FETCH_RANGE * 2, MAX_PAGINATED_FETCH_TOTAL);
}

function buildTradingViewScanPayload(
  preset: ScanPreset,
  options?: { rangeOffset?: number; rangeLimit?: number; rules?: ScanPresetRule[]; sortField?: string; sortDirection?: "asc" | "desc" },
): TradingViewScanPayload {
  const activeRules = options?.rules ?? preset.rules;
  const activeSortField = options?.sortField ?? preset.sortField;
  const activeSortDirection = options?.sortDirection ?? preset.sortDirection;
  const baseColumns = [
    "name",
    "sector",
    "industry",
    "change",
    "market_cap_basic",
    "relative_volume_10d_calc",
    "close",
    "average_volume_30d_calc",
    "Value.Traded",
    "volume",
    "exchange",
    "type",
  ];
  const extraColumns = Array.from(new Set(
    activeRules
      .flatMap((rule) => {
        const fields = [normalizeFieldName(rule.field)];
        if (isFieldReferenceValue(rule.value)) fields.push(normalizeFieldName(rule.value.field));
        return fields;
      })
      .concat([normalizeFieldName(activeSortField)])
      .filter((field) => field && field !== "ticker" && !baseColumns.includes(field)),
  ));
  const rangeOffset = Math.max(0, options?.rangeOffset ?? 0);
  const rangeLimit = Math.max(1, options?.rangeLimit ?? (
    hasPostFilters({ ...preset, rules: activeRules })
      ? Math.min(paginatedFetchTarget(preset), MAX_FETCH_RANGE)
      : clamp(preset.rowLimit, 1, MAX_FETCH_RANGE)
  ));
  return {
    markets: ["america"],
    symbols: { query: { types: [] }, tickers: [] },
    options: { lang: "en" },
    columns: [...baseColumns, ...extraColumns],
    sort: {
      sortBy: normalizeFieldName(activeSortField) || "change",
      sortOrder: activeSortDirection === "asc" ? "asc" : "desc",
    },
    range: [rangeOffset, rangeOffset + rangeLimit],
    filter: activeRules
      .map(mapRuleToTradingViewFilter)
      .filter((filter): filter is TradingViewFilter => Boolean(filter)),
  };
}

function mapTradingViewResponse(payload: TradingViewScanPayload, body: {
  data?: Array<{ s?: string; d?: unknown[] }>;
}): TradingViewScanRow[] {
  const columns = payload.columns;
  return (body.data ?? []).map((entry) => {
    const data = Array.isArray(entry.d) ? entry.d : [];
    const raw = Object.fromEntries(columns.map((column, index) => [column, data[index] ?? null])) as Record<string, unknown>;
    return {
      ticker: entry.s ?? null,
      name: typeof raw.name === "string" ? raw.name : null,
      sector: typeof raw.sector === "string" ? raw.sector : null,
      industry: typeof raw.industry === "string" ? raw.industry : null,
      change1d: typeof raw.change === "string" || typeof raw.change === "number" ? raw.change : null,
      marketCap: typeof raw.market_cap_basic === "string" || typeof raw.market_cap_basic === "number" ? raw.market_cap_basic : null,
      relativeVolume: typeof raw.relative_volume_10d_calc === "string" || typeof raw.relative_volume_10d_calc === "number" ? raw.relative_volume_10d_calc : null,
      price: typeof raw.close === "string" || typeof raw.close === "number" ? raw.close : null,
      avgVolume: typeof raw.average_volume_30d_calc === "string" || typeof raw.average_volume_30d_calc === "number" ? raw.average_volume_30d_calc : null,
      priceAvgVolume: typeof raw["Value.Traded"] === "string" || typeof raw["Value.Traded"] === "number" ? raw["Value.Traded"] : null,
      volume: typeof raw.volume === "string" || typeof raw.volume === "number" ? raw.volume : null,
      exchange: typeof raw.exchange === "string" ? raw.exchange : null,
      type: typeof raw.type === "string" ? raw.type : null,
      raw,
    };
  });
}

async function fetchTradingViewScanRowsInternal(
  preset: ScanPreset,
  options?: {
    rules?: ScanPresetRule[];
    sortField?: string;
    sortDirection?: "asc" | "desc";
    rowLimit?: number;
    maxRowLimit?: number;
    alwaysPaginate?: boolean;
  },
): Promise<{
  providerLabel: string;
  matchedRowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
  rows: ScanSnapshotRow[];
}> {
  const candidates: TradingViewScanRow[] = [];
  const activeRules = options?.rules ?? preset.rules;
  const activeSortField = options?.sortField ?? preset.sortField;
  const activeSortDirection = options?.sortDirection ?? preset.sortDirection;
  const activeRowLimit = clamp(options?.rowLimit ?? preset.rowLimit, 1, options?.maxRowLimit ?? MAX_FETCH_RANGE);
  const usePagination = options?.alwaysPaginate || hasPostFilters({ ...preset, rules: activeRules });
  let targetFetchCount = usePagination ? clamp(Math.max(activeRowLimit * 20, MAX_FETCH_RANGE * 2), MAX_FETCH_RANGE * 2, MAX_PAGINATED_FETCH_TOTAL) : activeRowLimit;
  let hasKnownTotalCount = false;

  for (let rangeOffset = 0; rangeOffset < targetFetchCount; rangeOffset += MAX_FETCH_RANGE) {
    const rangeLimit = Math.min(MAX_FETCH_RANGE, targetFetchCount - rangeOffset);
    const payload = buildTradingViewScanPayload(preset, {
      rangeOffset,
      rangeLimit,
      rules: activeRules,
      sortField: activeSortField,
      sortDirection: activeSortDirection,
    });
    const response = await fetch(TV_SCAN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "market-command-centre/1.0",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`TradingView scans request failed (${response.status}): ${body.slice(0, 180)}`);
    }
    const body = await response.json() as { totalCount?: number; data?: Array<{ s?: string; d?: unknown[] }> };
    if (typeof body.totalCount === "number" && Number.isFinite(body.totalCount) && body.totalCount > targetFetchCount) {
      hasKnownTotalCount = true;
      targetFetchCount = Math.min(body.totalCount, MAX_PAGINATED_FETCH_TOTAL);
    } else if (typeof body.totalCount === "number" && Number.isFinite(body.totalCount)) {
      hasKnownTotalCount = true;
    }
    const pageRows = mapTradingViewResponse(payload, body);
    const pageMatches = pageRows.filter((row) => rowMatchesRules(row, activeRules));
    candidates.push(...pageMatches);

    if (!usePagination || pageRows.length === 0 || (!hasKnownTotalCount && pageRows.length < rangeLimit)) {
      break;
    }
  }

  const rows = sortSnapshotRows(normalizeScanRows(candidates), activeSortField, activeSortDirection)
    .slice(0, activeRowLimit);
  return {
    providerLabel: TV_PROVIDER_LABEL,
    matchedRowCount: candidates.length,
    status: rows.length > 0 ? "ok" : "empty",
    error: null,
    rows,
  };
}

async function fetchTradingViewScanRows(
  preset: ScanPreset,
  options?: { rules?: ScanPresetRule[]; sortField?: string; sortDirection?: "asc" | "desc"; rowLimit?: number },
): Promise<{
  providerLabel: string;
  matchedRowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
  rows: ScanSnapshotRow[];
}> {
  return fetchTradingViewScanRowsInternal(preset, options);
}

async function upsertSymbolsFromRows(env: Env, rows: ScanSnapshotRow[]): Promise<void> {
  const statements = rows.map((row) =>
    env.DB.prepare(
      `INSERT INTO symbols (ticker, name, exchange, asset_class, sector, industry, updated_at)
       VALUES (?, ?, NULL, 'equity', ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(ticker) DO UPDATE SET
         name = COALESCE(excluded.name, symbols.name),
         sector = COALESCE(excluded.sector, symbols.sector),
         industry = COALESCE(excluded.industry, symbols.industry),
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(row.ticker, row.name ?? row.ticker, row.sector ?? null, row.industry ?? null),
  );
  if (statements.length > 0) await env.DB.batch(statements);
}

function isoDateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function isoDateDaysBefore(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function toTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchRelativeStrengthPrefilterRows(
  preset: ScanPreset,
): Promise<ScanSnapshotRow[]> {
  const prefilterRules = preset.prefilterRules.length > 0 ? preset.prefilterRules : preset.rules;
  const result = await fetchTradingViewScanRowsInternal(preset, {
    rules: prefilterRules,
    sortField: "Value.Traded",
    sortDirection: "desc",
    rowLimit: MAX_PAGINATED_FETCH_TOTAL,
    maxRowLimit: MAX_PAGINATED_FETCH_TOTAL,
    alwaysPaginate: true,
  });
  const rowsByTicker = new Map<string, ScanSnapshotRow>();
  for (const row of result.rows) {
    const ticker = normalizeTicker(row.ticker);
    if (!ticker) continue;
    if (!rowsByTicker.has(ticker)) rowsByTicker.set(ticker, { ...row, ticker });
  }
  return Array.from(rowsByTicker.values());
}

function groupBarsByTicker(bars: RelativeStrengthDailyBar[]): Map<string, RelativeStrengthDailyBar[]> {
  const map = new Map<string, Map<string, RelativeStrengthDailyBar>>();
  for (const bar of bars) {
    const key = bar.ticker.toUpperCase();
    const current = map.get(key) ?? new Map<string, RelativeStrengthDailyBar>();
    current.set(bar.date, { ...bar, ticker: key });
    map.set(key, current);
  }
  const out = new Map<string, RelativeStrengthDailyBar[]>();
  for (const [ticker, value] of map.entries()) {
    out.set(
      ticker,
      Array.from(value.values()).sort((left, right) => left.date.localeCompare(right.date)),
    );
  }
  return out;
}

function buildRelativeStrengthLatestCacheRows(
  rowsByTicker: Map<string, RelativeStrengthRatioRow[]>,
  identity: RelativeStrengthConfigIdentity,
): RelativeStrengthLatestCacheRecord[] {
  const latestRows = new Map<string, RelativeStrengthLatestCacheRecord>();
  const config = rawRelativeStrengthConfig(identity);
  const resolvedBenchmarkTicker = resolveBenchmarkTickerForData(identity.benchmarkTicker);

  for (const [ticker, bars] of rowsByTicker) {
    if (ticker === identity.benchmarkTicker || ticker === resolvedBenchmarkTicker) continue;
    const computedRows = buildRelativeStrengthCacheRowsFromRatioRows(bars, config);
    const latest = computedRows[computedRows.length - 1];
    if (!latest || latest.tradingDate !== identity.expectedTradingDate) continue;
    latestRows.set(ticker, {
      ticker,
      benchmarkTicker: identity.benchmarkTicker,
      rsMaType: identity.rsMaType,
      rsMaLength: identity.rsMaLength,
      newHighLookback: identity.newHighLookback,
      tradingDate: latest.tradingDate,
      priceClose: latest.priceClose,
      change1d: latest.change1d,
      rsRatioClose: latest.rsClose,
      rsRatioMa: latest.rsMa,
      rsAboveMa: latest.rsAboveMa,
      rsNewHigh: latest.rsNewHigh,
      rsNewHighBeforePrice: latest.rsNewHighBeforePrice,
      bullCross: latest.bullCross,
      approxRsRating: latest.approxRsRating,
    });
  }

  return Array.from(latestRows.values());
}

function cachedRowMatchesOutputMode(row: RelativeStrengthLatestCacheRecord, outputMode: RelativeStrengthOutputMode): boolean {
  if (outputMode === "rs_new_high_only") return asBooleanFlag(row.rsNewHigh);
  if (outputMode === "rs_new_high_before_price_only") return asBooleanFlag(row.rsNewHighBeforePrice);
  if (outputMode === "both") return asBooleanFlag(row.rsNewHigh) || asBooleanFlag(row.rsNewHighBeforePrice);
  return true;
}

async function loadRelativeStrengthLatestCacheRowsFromDb(
  db: D1Database,
  configKey: string,
  tickers: string[],
  tradingDate: string,
): Promise<Map<string, RelativeStrengthLatestCacheRecord>> {
  const uniqueTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
  const rowsByTicker = new Map<string, RelativeStrengthLatestCacheRecord>();
  if (uniqueTickers.length === 0) return rowsByTicker;
  for (let index = 0; index < uniqueTickers.length; index += RS_STORED_BAR_QUERY_CHUNK_SIZE) {
    const chunk = uniqueTickers.slice(index, index + RS_STORED_BAR_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.prepare(
      `SELECT
         ticker,
         benchmark_ticker as benchmarkTicker,
         rs_ma_type as rsMaType,
         rs_ma_length as rsMaLength,
         new_high_lookback as newHighLookback,
         trading_date as tradingDate,
         price_close as priceClose,
         change_1d as change1d,
         rs_ratio_close as rsRatioClose,
         rs_ratio_ma as rsRatioMa,
         rs_above_ma as rsAboveMa,
         rs_new_high as rsNewHigh,
         rs_new_high_before_price as rsNewHighBeforePrice,
         bull_cross as bullCross,
         approx_rs_rating as approxRsRating
       FROM relative_strength_latest_cache
       WHERE config_key = ?
         AND trading_date = ?
         AND ticker IN (${placeholders})`,
    )
      .bind(configKey, tradingDate, ...chunk)
      .all<RelativeStrengthLatestCacheRecord>();
    for (const row of rows.results ?? []) {
      rowsByTicker.set(row.ticker.toUpperCase(), {
        ...row,
        ticker: row.ticker.toUpperCase(),
      });
    }
  }
  return rowsByTicker;
}

async function loadRelativeStrengthLatestCacheRows(
  env: Env,
  configKey: string,
  tickers: string[],
  tradingDate: string,
): Promise<Map<string, RelativeStrengthLatestCacheRecord>> {
  const rowsByTicker = await loadRelativeStrengthLatestCacheRowsFromDb(
    getRsDerivedCacheDb(env),
    configKey,
    tickers,
    tradingDate,
  );
  if (!shouldReadLegacyRsDerivedCache(env)) return rowsByTicker;
  const missingTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter((ticker) => ticker && !rowsByTicker.has(ticker)),
  ));
  if (missingTickers.length === 0) return rowsByTicker;
  const legacyRows = await loadRelativeStrengthLatestCacheRowsFromDb(env.DB, configKey, missingTickers, tradingDate);
  for (const [ticker, row] of legacyRows.entries()) {
    if (!rowsByTicker.has(ticker)) rowsByTicker.set(ticker, row);
  }
  return rowsByTicker;
}

async function loadRelativeStrengthEffectiveLatestCacheRows(
  env: Env,
  configKey: string,
  tickers: string[],
  tradingDate: string,
): Promise<Map<string, RelativeStrengthLatestCacheRecord>> {
  const rowsByTicker = await loadRelativeStrengthLatestCacheRows(env, configKey, tickers, tradingDate);
  const missingTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter((ticker) => ticker && !rowsByTicker.has(ticker)),
  ));
  if (missingTickers.length === 0) return rowsByTicker;

  const stateRowsByTicker = await loadRelativeStrengthConfigStateRows(env, configKey, missingTickers);
  for (const [ticker, state] of stateRowsByTicker.entries()) {
    if (state.stateVersion !== RS_STATE_VERSION || state.latestTradingDate !== tradingDate) continue;
    rowsByTicker.set(ticker, stateRowToLatestCacheRecord(state));
  }
  return rowsByTicker;
}

async function loadRelativeStrengthConfigStateRowsFromDb(
  db: D1Database,
  configKey: string,
  tickers: string[],
): Promise<Map<string, RelativeStrengthConfigState>> {
  const uniqueTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
  const rowsByTicker = new Map<string, RelativeStrengthConfigState>();
  if (uniqueTickers.length === 0) return rowsByTicker;
  for (let index = 0; index < uniqueTickers.length; index += RS_STORED_BAR_QUERY_CHUNK_SIZE) {
    const chunk = uniqueTickers.slice(index, index + RS_STORED_BAR_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.prepare(
      `SELECT
         config_key as configKey,
         ticker,
         benchmark_ticker as benchmarkTicker,
         rs_ma_type as rsMaType,
         rs_ma_length as rsMaLength,
         new_high_lookback as newHighLookback,
         state_version as stateVersion,
         latest_trading_date as latestTradingDate,
         updated_at as updatedAt,
         price_close as priceClose,
         change_1d as change1d,
         rs_ratio_close as rsRatioClose,
         rs_ratio_ma as rsRatioMa,
         rs_above_ma as rsAboveMa,
         rs_new_high as rsNewHigh,
         rs_new_high_before_price as rsNewHighBeforePrice,
         bull_cross as bullCross,
         approx_rs_rating as approxRsRating,
         price_close_history_json as priceCloseHistoryJson,
         benchmark_close_history_json as benchmarkCloseHistoryJson,
         weighted_score_history_json as weightedScoreHistoryJson,
         rs_new_high_window_json as rsNewHighWindowJson,
         price_new_high_window_json as priceNewHighWindowJson,
         sma_window_json as smaWindowJson,
         sma_sum as smaSum,
         ema_value as emaValue,
         previous_rs_close as previousRsClose,
         previous_rs_ma as previousRsMa
       FROM relative_strength_config_state
       WHERE config_key = ?
         AND ticker IN (${placeholders})`,
    )
      .bind(configKey, ...chunk)
      .all<RelativeStrengthConfigStateRecord>();
    for (const row of rows.results ?? []) {
      rowsByTicker.set(row.ticker.toUpperCase(), parseRelativeStrengthConfigStateRecord(row));
    }
  }
  return rowsByTicker;
}

async function loadRelativeStrengthConfigStateRows(
  env: Env,
  configKey: string,
  tickers: string[],
): Promise<Map<string, RelativeStrengthConfigState>> {
  const rowsByTicker = await loadRelativeStrengthConfigStateRowsFromDb(getRsDerivedCacheDb(env), configKey, tickers);
  if (!shouldReadLegacyRsDerivedCache(env)) return rowsByTicker;
  const fallbackTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
  if (fallbackTickers.length === 0) return rowsByTicker;
  const legacyRows = await loadRelativeStrengthConfigStateRowsFromDb(env.DB, configKey, fallbackTickers);
  for (const [ticker, row] of legacyRows.entries()) {
    const current = rowsByTicker.get(ticker);
    if (!current || row.latestTradingDate > current.latestTradingDate) rowsByTicker.set(ticker, row);
  }
  return rowsByTicker;
}

async function loadRelativeStrengthConfigStateSummariesFromDb(
  db: D1Database,
  configKey: string,
  tickers: string[],
): Promise<Map<string, RelativeStrengthConfigStateSummaryRow>> {
  const uniqueTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
  const rowsByTicker = new Map<string, RelativeStrengthConfigStateSummaryRow>();
  if (uniqueTickers.length === 0) return rowsByTicker;
  for (let index = 0; index < uniqueTickers.length; index += RS_STORED_BAR_QUERY_CHUNK_SIZE) {
    const chunk = uniqueTickers.slice(index, index + RS_STORED_BAR_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.prepare(
      `SELECT
         ticker,
         state_version as stateVersion,
         latest_trading_date as latestTradingDate
       FROM relative_strength_config_state
       WHERE config_key = ?
         AND ticker IN (${placeholders})`,
    )
      .bind(configKey, ...chunk)
      .all<RelativeStrengthConfigStateSummaryRow>();
    for (const row of rows.results ?? []) {
      rowsByTicker.set(row.ticker.toUpperCase(), {
        ticker: row.ticker.toUpperCase(),
        stateVersion: Math.max(0, Math.trunc(row.stateVersion || 0)),
        latestTradingDate: row.latestTradingDate,
      });
    }
  }
  return rowsByTicker;
}

async function loadRelativeStrengthConfigStateSummaries(
  env: Env,
  configKey: string,
  tickers: string[],
): Promise<Map<string, RelativeStrengthConfigStateSummaryRow>> {
  const rowsByTicker = await loadRelativeStrengthConfigStateSummariesFromDb(getRsDerivedCacheDb(env), configKey, tickers);
  if (!shouldReadLegacyRsDerivedCache(env)) return rowsByTicker;
  const fallbackTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
  if (fallbackTickers.length === 0) return rowsByTicker;
  const legacyRows = await loadRelativeStrengthConfigStateSummariesFromDb(env.DB, configKey, fallbackTickers);
  for (const [ticker, row] of legacyRows.entries()) {
    const current = rowsByTicker.get(ticker);
    if (!current || row.latestTradingDate > current.latestTradingDate) rowsByTicker.set(ticker, row);
  }
  return rowsByTicker;
}

async function upsertRelativeStrengthConfigStates(
  env: Env,
  rows: RelativeStrengthConfigState[],
): Promise<void> {
  if (rows.length === 0) return;
  const cacheDb = getRsDerivedCacheDb(env);
  for (let index = 0; index < rows.length; index += RS_JOB_INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(index, index + RS_JOB_INSERT_CHUNK_SIZE);
    await cacheDb.batch(chunk.map((row) =>
      cacheDb.prepare(
        `INSERT INTO relative_strength_config_state
          (config_key, ticker, benchmark_ticker, rs_ma_type, rs_ma_length, new_high_lookback, state_version, latest_trading_date, updated_at, price_close, change_1d, rs_ratio_close, rs_ratio_ma, rs_above_ma, rs_new_high, rs_new_high_before_price, bull_cross, approx_rs_rating, price_close_history_json, benchmark_close_history_json, weighted_score_history_json, rs_new_high_window_json, price_new_high_window_json, sma_window_json, sma_sum, ema_value, previous_rs_close, previous_rs_ma, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(config_key, ticker) DO UPDATE SET
           benchmark_ticker = excluded.benchmark_ticker,
           rs_ma_type = excluded.rs_ma_type,
           rs_ma_length = excluded.rs_ma_length,
           new_high_lookback = excluded.new_high_lookback,
           state_version = excluded.state_version,
           latest_trading_date = excluded.latest_trading_date,
           updated_at = CURRENT_TIMESTAMP,
           price_close = excluded.price_close,
           change_1d = excluded.change_1d,
           rs_ratio_close = excluded.rs_ratio_close,
           rs_ratio_ma = excluded.rs_ratio_ma,
           rs_above_ma = excluded.rs_above_ma,
           rs_new_high = excluded.rs_new_high,
           rs_new_high_before_price = excluded.rs_new_high_before_price,
           bull_cross = excluded.bull_cross,
           approx_rs_rating = excluded.approx_rs_rating,
           price_close_history_json = excluded.price_close_history_json,
           benchmark_close_history_json = excluded.benchmark_close_history_json,
           weighted_score_history_json = excluded.weighted_score_history_json,
           rs_new_high_window_json = excluded.rs_new_high_window_json,
           price_new_high_window_json = excluded.price_new_high_window_json,
           sma_window_json = excluded.sma_window_json,
           sma_sum = excluded.sma_sum,
           ema_value = excluded.ema_value,
           previous_rs_close = excluded.previous_rs_close,
           previous_rs_ma = excluded.previous_rs_ma`,
      ).bind(
        row.configKey,
        row.ticker.toUpperCase(),
        row.benchmarkTicker.toUpperCase(),
        row.rsMaType,
        row.rsMaLength,
        row.newHighLookback,
        row.stateVersion,
        row.latestTradingDate,
        row.priceClose,
        row.change1d,
        row.rsRatioClose,
        row.rsRatioMa,
        row.rsAboveMa ? 1 : 0,
        row.rsNewHigh ? 1 : 0,
        row.rsNewHighBeforePrice ? 1 : 0,
        row.bullCross ? 1 : 0,
        row.approxRsRating,
        toJson(row.priceCloseHistory),
        toJson(row.benchmarkCloseHistory),
        toJson(row.weightedScoreHistory),
        toJson(row.rsNewHighWindow),
        toJson(row.priceNewHighWindow),
        toJson(row.smaWindow),
        row.smaSum,
        row.emaValue,
        row.previousRsClose,
        row.previousRsMa,
      )));
  }
}


async function upsertRelativeStrengthLatestCacheRows(
  env: Env,
  configKey: string,
  rows: RelativeStrengthLatestCacheRecord[],
): Promise<void> {
  if (rows.length === 0) return;
  const cacheDb = getRsDerivedCacheDb(env);
  for (let index = 0; index < rows.length; index += RS_JOB_INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(index, index + RS_JOB_INSERT_CHUNK_SIZE);
    await cacheDb.batch(chunk.map((row) =>
      cacheDb.prepare(
        `INSERT INTO relative_strength_latest_cache
          (config_key, ticker, benchmark_ticker, rs_ma_type, rs_ma_length, new_high_lookback, trading_date, price_close, change_1d, rs_ratio_close, rs_ratio_ma, rs_above_ma, rs_new_high, rs_new_high_before_price, bull_cross, approx_rs_rating, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(config_key, ticker) DO UPDATE SET
           benchmark_ticker = excluded.benchmark_ticker,
           rs_ma_type = excluded.rs_ma_type,
           rs_ma_length = excluded.rs_ma_length,
           new_high_lookback = excluded.new_high_lookback,
           trading_date = excluded.trading_date,
           price_close = excluded.price_close,
           change_1d = excluded.change_1d,
           rs_ratio_close = excluded.rs_ratio_close,
           rs_ratio_ma = excluded.rs_ratio_ma,
           rs_above_ma = excluded.rs_above_ma,
           rs_new_high = excluded.rs_new_high,
           rs_new_high_before_price = excluded.rs_new_high_before_price,
           bull_cross = excluded.bull_cross,
           approx_rs_rating = excluded.approx_rs_rating,
           updated_at = CURRENT_TIMESTAMP`,
      ).bind(
        configKey,
        row.ticker,
        row.benchmarkTicker,
        row.rsMaType,
        row.rsMaLength,
        row.newHighLookback,
        row.tradingDate,
        row.priceClose,
        row.change1d,
        row.rsRatioClose,
        row.rsRatioMa,
        asBooleanFlag(row.rsAboveMa) ? 1 : 0,
        asBooleanFlag(row.rsNewHigh) ? 1 : 0,
        asBooleanFlag(row.rsNewHighBeforePrice) ? 1 : 0,
        asBooleanFlag(row.bullCross) ? 1 : 0,
        row.approxRsRating,
      )));
  }
}

async function loadRelativeStrengthRatioCoverageFromDb(
  db: D1Database,
  benchmarkTicker: string,
  tickers: string[],
  endDate: string,
): Promise<Map<string, RelativeStrengthRatioCoverageRow>> {
  const uniqueTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
  const rowsByTicker = new Map<string, RelativeStrengthRatioCoverageRow>();
  if (uniqueTickers.length === 0) return rowsByTicker;
  for (let index = 0; index < uniqueTickers.length; index += RS_STORED_BAR_QUERY_CHUNK_SIZE) {
    const chunk = uniqueTickers.slice(index, index + RS_STORED_BAR_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.prepare(
      `SELECT ticker, MAX(trading_date) as lastDate, COUNT(*) as rowCount
       FROM rs_ratio_cache
       WHERE benchmark_ticker = ?
         AND ticker IN (${placeholders})
         AND trading_date <= ?
       GROUP BY ticker`,
    )
      .bind(benchmarkTicker, ...chunk, endDate)
      .all<RelativeStrengthRatioCoverageRow>();
    for (const row of rows.results ?? []) {
      rowsByTicker.set(row.ticker.toUpperCase(), {
        ticker: row.ticker.toUpperCase(),
        lastDate: row.lastDate,
        rowCount: Number.isFinite(Number(row.rowCount)) ? Number(row.rowCount) : 0,
      });
    }
  }
  return rowsByTicker;
}

async function loadRelativeStrengthRatioCoverage(
  env: Env,
  benchmarkTicker: string,
  tickers: string[],
  endDate: string,
): Promise<Map<string, RelativeStrengthRatioCoverageRow>> {
  const rowsByTicker = await loadRelativeStrengthRatioCoverageFromDb(
    getRsDerivedCacheDb(env),
    benchmarkTicker,
    tickers,
    endDate,
  );
  if (!shouldReadLegacyRsDerivedCache(env)) return rowsByTicker;
  const fallbackTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
  if (fallbackTickers.length === 0) return rowsByTicker;
  const legacyRows = await loadRelativeStrengthRatioCoverageFromDb(env.DB, benchmarkTicker, fallbackTickers, endDate);
  for (const [ticker, row] of legacyRows.entries()) {
    const current = rowsByTicker.get(ticker);
    if (
      !current
      || (row.lastDate ?? "") > (current.lastDate ?? "")
      || (row.lastDate === current.lastDate && row.rowCount > current.rowCount)
    ) {
      rowsByTicker.set(ticker, row);
    }
  }
  return rowsByTicker;
}

async function loadRelativeStrengthRatioRowsByCountFromDb(
  db: D1Database,
  benchmarkTicker: string,
  tickers: string[],
  endDate: string,
  barLimit: number,
): Promise<RelativeStrengthRatioRow[]> {
  const uniqueTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
  if (uniqueTickers.length === 0 || barLimit <= 0) return [];
  const out: RelativeStrengthRatioRow[] = [];
  for (let index = 0; index < uniqueTickers.length; index += RS_STORED_BAR_QUERY_CHUNK_SIZE) {
    const chunk = uniqueTickers.slice(index, index + RS_STORED_BAR_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.prepare(
      `SELECT benchmark_ticker as benchmarkTicker, ticker, trading_date as tradingDate, price_close as priceClose, benchmark_close as benchmarkClose, rs_ratio_close as rsRatioClose
       FROM (
         SELECT
           benchmark_ticker,
           ticker,
           trading_date,
           price_close,
           benchmark_close,
           rs_ratio_close,
           ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY trading_date DESC) as row_num
         FROM rs_ratio_cache
         WHERE benchmark_ticker = ?
           AND ticker IN (${placeholders})
           AND trading_date <= ?
       )
       WHERE row_num <= ?
       ORDER BY ticker ASC, trading_date ASC`,
    )
      .bind(benchmarkTicker, ...chunk, endDate, barLimit)
      .all<RelativeStrengthRatioRow>();
    out.push(
      ...(rows.results ?? []).map((row) => ({
        ...row,
        ticker: row.ticker.toUpperCase(),
        benchmarkTicker: row.benchmarkTicker.toUpperCase(),
      })),
    );
  }
  return out;
}

async function loadRelativeStrengthRatioRowsByCount(
  env: Env,
  benchmarkTicker: string,
  tickers: string[],
  endDate: string,
  barLimit: number,
): Promise<RelativeStrengthRatioRow[]> {
  const scannerRows = await loadRelativeStrengthRatioRowsByCountFromDb(
    getRsDerivedCacheDb(env),
    benchmarkTicker,
    tickers,
    endDate,
    barLimit,
  );
  if (!shouldReadLegacyRsDerivedCache(env)) return scannerRows;
  const scannerRowsByTicker = groupRatioRowsByTicker(scannerRows);
  const fallbackTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter((ticker) => ticker && (scannerRowsByTicker.get(ticker)?.length ?? 0) < barLimit),
  ));
  if (fallbackTickers.length === 0) return scannerRows;
  const legacyRows = await loadRelativeStrengthRatioRowsByCountFromDb(
    env.DB,
    benchmarkTicker,
    fallbackTickers,
    endDate,
    barLimit,
  );
  return mergeRelativeStrengthRatioRows(legacyRows, scannerRows);
}

async function loadRelativeStrengthRatioRowsInRangeFromDb(
  db: D1Database,
  benchmarkTicker: string,
  tickers: string[],
  startDateExclusive: string,
  endDate: string,
): Promise<RelativeStrengthRatioRow[]> {
  const uniqueTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
  if (uniqueTickers.length === 0) return [];
  const out: RelativeStrengthRatioRow[] = [];
  for (let index = 0; index < uniqueTickers.length; index += RS_STORED_BAR_QUERY_CHUNK_SIZE) {
    const chunk = uniqueTickers.slice(index, index + RS_STORED_BAR_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.prepare(
      `SELECT
         benchmark_ticker as benchmarkTicker,
         ticker,
         trading_date as tradingDate,
         price_close as priceClose,
         benchmark_close as benchmarkClose,
         rs_ratio_close as rsRatioClose
       FROM rs_ratio_cache
       WHERE benchmark_ticker = ?
         AND ticker IN (${placeholders})
         AND trading_date > ?
         AND trading_date <= ?
       ORDER BY ticker ASC, trading_date ASC`,
    )
      .bind(benchmarkTicker, ...chunk, startDateExclusive, endDate)
      .all<RelativeStrengthRatioRow>();
    out.push(
      ...(rows.results ?? []).map((row) => ({
        ...row,
        ticker: row.ticker.toUpperCase(),
        benchmarkTicker: row.benchmarkTicker.toUpperCase(),
      })),
    );
  }
  return out;
}

async function loadRelativeStrengthRatioRowsInRange(
  env: Env,
  benchmarkTicker: string,
  tickers: string[],
  startDateExclusive: string,
  endDate: string,
): Promise<RelativeStrengthRatioRow[]> {
  const scannerRows = await loadRelativeStrengthRatioRowsInRangeFromDb(
    getRsDerivedCacheDb(env),
    benchmarkTicker,
    tickers,
    startDateExclusive,
    endDate,
  );
  if (!shouldReadLegacyRsDerivedCache(env)) return scannerRows;
  const fallbackTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
  if (fallbackTickers.length === 0) return scannerRows;
  const legacyRows = await loadRelativeStrengthRatioRowsInRangeFromDb(
    env.DB,
    benchmarkTicker,
    fallbackTickers,
    startDateExclusive,
    endDate,
  );
  return mergeRelativeStrengthRatioRows(legacyRows, scannerRows);
}

function mergeRelativeStrengthRatioRows(
  fallbackRows: RelativeStrengthRatioRow[],
  preferredRows: RelativeStrengthRatioRow[],
): RelativeStrengthRatioRow[] {
  return Array.from(groupRatioRowsByTicker([...fallbackRows, ...preferredRows]).values()).flat();
}

function groupRatioRowsByTicker(rows: RelativeStrengthRatioRow[]): Map<string, RelativeStrengthRatioRow[]> {
  const map = new Map<string, Map<string, RelativeStrengthRatioRow>>();
  for (const row of rows) {
    const key = row.ticker.toUpperCase();
    const current = map.get(key) ?? new Map<string, RelativeStrengthRatioRow>();
    current.set(row.tradingDate, { ...row, ticker: key, benchmarkTicker: row.benchmarkTicker.toUpperCase() });
    map.set(key, current);
  }
  const out = new Map<string, RelativeStrengthRatioRow[]>();
  for (const [ticker, value] of map.entries()) {
    out.set(
      ticker,
      Array.from(value.values()).sort((left, right) => left.tradingDate.localeCompare(right.tradingDate)),
    );
  }
  return out;
}

async function upsertRelativeStrengthRatioRows(
  env: Env,
  rows: RelativeStrengthRatioRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const cacheDb = getRsDerivedCacheDb(env);
  for (let index = 0; index < rows.length; index += RS_JOB_INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(index, index + RS_JOB_INSERT_CHUNK_SIZE);
    await cacheDb.batch(chunk.map((row) =>
      cacheDb.prepare(
        `INSERT INTO rs_ratio_cache
          (benchmark_ticker, ticker, trading_date, price_close, benchmark_close, rs_ratio_close, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(benchmark_ticker, ticker, trading_date) DO UPDATE SET
           price_close = excluded.price_close,
           benchmark_close = excluded.benchmark_close,
           rs_ratio_close = excluded.rs_ratio_close,
           updated_at = CURRENT_TIMESTAMP`,
      ).bind(
        row.benchmarkTicker.toUpperCase(),
        row.ticker.toUpperCase(),
        row.tradingDate,
        row.priceClose,
        row.benchmarkClose,
        row.rsRatioClose,
      )));
  }
}

async function pruneRelativeStrengthRatioCache(
  env: Env,
  benchmarkTicker: string,
  tickers: string[],
  keepBars = RS_RATIO_RETENTION_BARS,
): Promise<void> {
  const uniqueTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
  if (uniqueTickers.length === 0 || keepBars <= 0) return;
  const cacheDb = getRsDerivedCacheDb(env);
  for (let index = 0; index < uniqueTickers.length; index += RS_STORED_BAR_QUERY_CHUNK_SIZE) {
    const chunk = uniqueTickers.slice(index, index + RS_STORED_BAR_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    await cacheDb.prepare(
      `DELETE FROM rs_ratio_cache
       WHERE (benchmark_ticker, ticker, trading_date) IN (
         SELECT benchmark_ticker, ticker, trading_date
         FROM (
           SELECT
             benchmark_ticker,
             ticker,
             trading_date,
             ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY trading_date DESC) as row_num
           FROM rs_ratio_cache
           WHERE benchmark_ticker = ?
             AND ticker IN (${placeholders})
         )
         WHERE row_num > ?
       )`,
    )
      .bind(benchmarkTicker, ...chunk, keepBars)
      .run();
  }
}

function latestBarDate(bars: RelativeStrengthDailyBar[]): string | null {
  let latest: string | null = null;
  for (const bar of bars) {
    if (!latest || bar.date > latest) latest = bar.date;
  }
  return latest;
}

function chooseFresherBars(
  current: RelativeStrengthDailyBar[],
  candidate: RelativeStrengthDailyBar[],
): RelativeStrengthDailyBar[] {
  const currentLatest = latestBarDate(current);
  const candidateLatest = latestBarDate(candidate);
  if (!candidateLatest) return current;
  if (!currentLatest || candidateLatest > currentLatest) return candidate;
  if (candidateLatest === currentLatest && candidate.length > current.length) return candidate;
  return current;
}

async function loadStoredDailyBarsInRange(
  env: Env,
  tickers: string[],
  startDate: string,
  endDate: string,
): Promise<RelativeStrengthDailyBar[]> {
  const uniqueTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
  if (uniqueTickers.length === 0) return [];
  const out: RelativeStrengthDailyBar[] = [];
  for (let index = 0; index < uniqueTickers.length; index += RS_STORED_BAR_QUERY_CHUNK_SIZE) {
    const chunk = uniqueTickers.slice(index, index + RS_STORED_BAR_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT ticker, date, o, h, l, c, volume
       FROM daily_bars
       WHERE ticker IN (${placeholders})
         AND date >= ?
         AND date <= ?
       ORDER BY ticker ASC, date ASC`,
    )
      .bind(...chunk, startDate, endDate)
      .all<RelativeStrengthDailyBar>();
    out.push(
      ...(rows.results ?? []).map((row) => ({
        ticker: row.ticker.toUpperCase(),
        date: row.date,
        o: row.o,
        h: row.h,
        l: row.l,
        c: row.c,
        volume: row.volume ?? 0,
      })),
    );
  }
  return out;
}

async function loadDailyBarCoverage(
  env: Env,
  tickers: string[],
  endDate: string,
): Promise<Map<string, DailyBarCoverageRow>> {
  const uniqueTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
  const out = new Map<string, DailyBarCoverageRow>();
  if (uniqueTickers.length === 0) return out;
  for (let index = 0; index < uniqueTickers.length; index += RS_STORED_BAR_QUERY_CHUNK_SIZE) {
    const chunk = uniqueTickers.slice(index, index + RS_STORED_BAR_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT ticker, MAX(date) as lastDate, COUNT(*) as barCount
       FROM daily_bars
       WHERE ticker IN (${placeholders})
         AND date <= ?
       GROUP BY ticker`,
    )
      .bind(...chunk, endDate)
      .all<DailyBarCoverageRow>();
    for (const row of rows.results ?? []) {
      out.set(row.ticker.toUpperCase(), {
        ticker: row.ticker.toUpperCase(),
        lastDate: row.lastDate,
        barCount: Number.isFinite(Number(row.barCount)) ? Number(row.barCount) : 0,
      });
    }
  }
  return out;
}

async function loadStoredDailyBarsByCount(
  env: Env,
  tickers: string[],
  endDate: string,
  barLimit: number,
): Promise<RelativeStrengthDailyBar[]> {
  const uniqueTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
  if (uniqueTickers.length === 0 || barLimit <= 0) return [];
  const out: RelativeStrengthDailyBar[] = [];
  for (let index = 0; index < uniqueTickers.length; index += RS_STORED_BAR_QUERY_CHUNK_SIZE) {
    const chunk = uniqueTickers.slice(index, index + RS_STORED_BAR_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT ticker, date, o, h, l, c, volume
       FROM (
         SELECT
           ticker,
           date,
           o,
           h,
           l,
           c,
           volume,
           ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) as row_num
         FROM daily_bars
         WHERE ticker IN (${placeholders})
           AND date <= ?
       )
       WHERE row_num <= ?
       ORDER BY ticker ASC, date ASC`,
    )
      .bind(...chunk, endDate, barLimit)
      .all<RelativeStrengthDailyBar>();
    out.push(
      ...(rows.results ?? []).map((row) => ({
        ticker: row.ticker.toUpperCase(),
        date: row.date,
        o: row.o,
        h: row.h,
        l: row.l,
        c: row.c,
        volume: row.volume ?? 0,
      })),
    );
  }
  return out;
}

function hasScannerCacheStorage(env: Env): env is Env & { SCANNER_CACHE_DB: D1Database } {
  return Boolean(env.SCANNER_CACHE_DB);
}

function getRsDerivedCacheDb(env: Env): D1Database {
  return env.SCANNER_CACHE_DB ?? env.DB;
}

function shouldReadLegacyRsDerivedCache(env: Env): boolean {
  return Boolean(env.SCANNER_CACHE_DB && env.SCANNER_CACHE_DB !== env.DB);
}

type RsBackfillCursor = {
  version: 1;
  table: RsDerivedCacheTable;
  key: string[];
};

type RsAllBackfillCursor = {
  version: 1;
  table: "all";
  cursors: Partial<Record<RsDerivedCacheTable, string | null>>;
};

function assertRsDerivedCacheTable(value: string): asserts value is RsDerivedCacheTable {
  if (!RS_DERIVED_CACHE_TABLES.includes(value as RsDerivedCacheTable)) {
    throw new Error("Invalid RS derived cache table.");
  }
}

function normalizeRsDerivedBackfillLimit(limit?: number | null): number {
  const parsed = Math.trunc(Number(limit ?? RS_DERIVED_CACHE_BACKFILL_DEFAULT_LIMIT));
  if (!Number.isFinite(parsed)) return RS_DERIVED_CACHE_BACKFILL_DEFAULT_LIMIT;
  return Math.min(RS_DERIVED_CACHE_BACKFILL_MAX_LIMIT, Math.max(1, parsed));
}

function encodeRsBackfillCursor(cursor: RsBackfillCursor | RsAllBackfillCursor): string {
  return btoa(JSON.stringify(cursor));
}

function decodeRsBackfillCursor(cursor: string | null | undefined): RsBackfillCursor | RsAllBackfillCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(atob(cursor)) as Record<string, unknown>;
    if (parsed.version !== 1) throw new Error("Unsupported cursor version.");
    if (parsed.table === "all") {
      return {
        version: 1,
        table: "all",
        cursors: typeof parsed.cursors === "object" && parsed.cursors
          ? parsed.cursors as Partial<Record<RsDerivedCacheTable, string | null>>
          : {},
      };
    }
    if (typeof parsed.table !== "string" || !Array.isArray(parsed.key)) throw new Error("Malformed cursor.");
    assertRsDerivedCacheTable(parsed.table);
    return { version: 1, table: parsed.table, key: parsed.key.map(String) };
  } catch {
    throw new Error("Invalid scanner cache backfill cursor.");
  }
}

async function countRows(db: D1Database, table: RsDerivedCacheTable): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) as count FROM ${table}`).first<{ count: number }>();
  return Math.max(0, Math.trunc(Number(row?.count ?? 0)));
}

export async function loadScannerCacheRsCacheStatus(env: Env): Promise<RsDerivedCacheStatus> {
  const scannerDb = env.SCANNER_CACHE_DB ?? null;
  const tables = [];
  for (const table of RS_DERIVED_CACHE_TABLES) {
    tables.push({
      table,
      legacyRowCount: await countRows(env.DB, table),
      scannerCacheRowCount: scannerDb ? await countRows(scannerDb, table) : null,
    });
  }
  return {
    scannerCacheDbAvailable: Boolean(scannerDb),
    tables,
  };
}

function rsBackfillKeyForRow(table: RsDerivedCacheTable, row: Record<string, unknown>): string[] {
  if (table === "rs_ratio_cache") {
    return [String(row.benchmarkTicker ?? ""), String(row.ticker ?? ""), String(row.tradingDate ?? "")];
  }
  return [String(row.configKey ?? ""), String(row.ticker ?? "")];
}

async function loadLegacyRsBackfillRows(
  db: D1Database,
  table: RsDerivedCacheTable,
  cursor: string | null | undefined,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const decoded = decodeRsBackfillCursor(cursor);
  const key = decoded && decoded.table !== "all" && decoded.table === table ? decoded.key : null;
  if (table === "rs_ratio_cache") {
    const where = key
      ? `WHERE benchmark_ticker > ?
          OR (benchmark_ticker = ? AND ticker > ?)
          OR (benchmark_ticker = ? AND ticker = ? AND trading_date > ?)`
      : "";
    const bindArgs = key ? [key[0], key[0], key[1], key[0], key[1], key[2], limit] : [limit];
    const rows = await db.prepare(
      `SELECT
         benchmark_ticker as benchmarkTicker,
         ticker,
         trading_date as tradingDate,
         price_close as priceClose,
         benchmark_close as benchmarkClose,
         rs_ratio_close as rsRatioClose,
         created_at as createdAt,
         updated_at as updatedAt
       FROM rs_ratio_cache
       ${where}
       ORDER BY benchmark_ticker ASC, ticker ASC, trading_date ASC
       LIMIT ?`,
    )
      .bind(...bindArgs)
      .all<Record<string, unknown>>();
    return rows.results ?? [];
  }

  const where = key ? "WHERE config_key > ? OR (config_key = ? AND ticker > ?)" : "";
  const bindArgs = key ? [key[0], key[0], key[1], limit] : [limit];
  if (table === "relative_strength_latest_cache") {
    const rows = await db.prepare(
      `SELECT
         config_key as configKey,
         ticker,
         benchmark_ticker as benchmarkTicker,
         rs_ma_type as rsMaType,
         rs_ma_length as rsMaLength,
         new_high_lookback as newHighLookback,
         trading_date as tradingDate,
         price_close as priceClose,
         change_1d as change1d,
         rs_ratio_close as rsRatioClose,
         rs_ratio_ma as rsRatioMa,
         rs_above_ma as rsAboveMa,
         rs_new_high as rsNewHigh,
         rs_new_high_before_price as rsNewHighBeforePrice,
         bull_cross as bullCross,
         approx_rs_rating as approxRsRating,
         created_at as createdAt,
         updated_at as updatedAt
       FROM relative_strength_latest_cache
       ${where}
       ORDER BY config_key ASC, ticker ASC
       LIMIT ?`,
    )
      .bind(...bindArgs)
      .all<Record<string, unknown>>();
    return rows.results ?? [];
  }

  const rows = await db.prepare(
    `SELECT
       config_key as configKey,
       ticker,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback,
       state_version as stateVersion,
       latest_trading_date as latestTradingDate,
       updated_at as updatedAt,
       price_close as priceClose,
       change_1d as change1d,
       rs_ratio_close as rsRatioClose,
       rs_ratio_ma as rsRatioMa,
       rs_above_ma as rsAboveMa,
       rs_new_high as rsNewHigh,
       rs_new_high_before_price as rsNewHighBeforePrice,
       bull_cross as bullCross,
       approx_rs_rating as approxRsRating,
       price_close_history_json as priceCloseHistoryJson,
       benchmark_close_history_json as benchmarkCloseHistoryJson,
       weighted_score_history_json as weightedScoreHistoryJson,
       rs_new_high_window_json as rsNewHighWindowJson,
       price_new_high_window_json as priceNewHighWindowJson,
       sma_window_json as smaWindowJson,
       sma_sum as smaSum,
       ema_value as emaValue,
       previous_rs_close as previousRsClose,
       previous_rs_ma as previousRsMa,
       created_at as createdAt
     FROM relative_strength_config_state
     ${where}
     ORDER BY config_key ASC, ticker ASC
     LIMIT ?`,
  )
    .bind(...bindArgs)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

function prepareRsBackfillUpsert(db: D1Database, table: RsDerivedCacheTable, row: Record<string, unknown>): D1PreparedStatement {
  if (table === "rs_ratio_cache") {
    return db.prepare(
      `INSERT INTO rs_ratio_cache
        (benchmark_ticker, ticker, trading_date, price_close, benchmark_close, rs_ratio_close, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
       ON CONFLICT(benchmark_ticker, ticker, trading_date) DO UPDATE SET
         price_close = excluded.price_close,
         benchmark_close = excluded.benchmark_close,
         rs_ratio_close = excluded.rs_ratio_close,
         updated_at = excluded.updated_at`,
    ).bind(
      String(row.benchmarkTicker ?? "").toUpperCase(),
      String(row.ticker ?? "").toUpperCase(),
      row.tradingDate,
      row.priceClose ?? null,
      row.benchmarkClose ?? null,
      row.rsRatioClose ?? null,
      row.createdAt ?? null,
      row.updatedAt ?? null,
    );
  }
  if (table === "relative_strength_latest_cache") {
    return db.prepare(
      `INSERT INTO relative_strength_latest_cache
        (config_key, ticker, benchmark_ticker, rs_ma_type, rs_ma_length, new_high_lookback, trading_date, price_close, change_1d, rs_ratio_close, rs_ratio_ma, rs_above_ma, rs_new_high, rs_new_high_before_price, bull_cross, approx_rs_rating, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
       ON CONFLICT(config_key, ticker) DO UPDATE SET
         benchmark_ticker = excluded.benchmark_ticker,
         rs_ma_type = excluded.rs_ma_type,
         rs_ma_length = excluded.rs_ma_length,
         new_high_lookback = excluded.new_high_lookback,
         trading_date = excluded.trading_date,
         price_close = excluded.price_close,
         change_1d = excluded.change_1d,
         rs_ratio_close = excluded.rs_ratio_close,
         rs_ratio_ma = excluded.rs_ratio_ma,
         rs_above_ma = excluded.rs_above_ma,
         rs_new_high = excluded.rs_new_high,
         rs_new_high_before_price = excluded.rs_new_high_before_price,
         bull_cross = excluded.bull_cross,
         approx_rs_rating = excluded.approx_rs_rating,
         updated_at = excluded.updated_at
       WHERE excluded.trading_date >= relative_strength_latest_cache.trading_date`,
    ).bind(
      row.configKey,
      String(row.ticker ?? "").toUpperCase(),
      String(row.benchmarkTicker ?? "").toUpperCase(),
      row.rsMaType,
      row.rsMaLength,
      row.newHighLookback,
      row.tradingDate,
      row.priceClose ?? null,
      row.change1d ?? null,
      row.rsRatioClose ?? null,
      row.rsRatioMa ?? null,
      row.rsAboveMa ?? 0,
      row.rsNewHigh ?? 0,
      row.rsNewHighBeforePrice ?? 0,
      row.bullCross ?? 0,
      row.approxRsRating ?? null,
      row.createdAt ?? null,
      row.updatedAt ?? null,
    );
  }

  return db.prepare(
    `INSERT INTO relative_strength_config_state
      (config_key, ticker, benchmark_ticker, rs_ma_type, rs_ma_length, new_high_lookback, state_version, latest_trading_date, updated_at, price_close, change_1d, rs_ratio_close, rs_ratio_ma, rs_above_ma, rs_new_high, rs_new_high_before_price, bull_cross, approx_rs_rating, price_close_history_json, benchmark_close_history_json, weighted_score_history_json, rs_new_high_window_json, price_new_high_window_json, sma_window_json, sma_sum, ema_value, previous_rs_close, previous_rs_ma, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
     ON CONFLICT(config_key, ticker) DO UPDATE SET
       benchmark_ticker = excluded.benchmark_ticker,
       rs_ma_type = excluded.rs_ma_type,
       rs_ma_length = excluded.rs_ma_length,
       new_high_lookback = excluded.new_high_lookback,
       state_version = excluded.state_version,
       latest_trading_date = excluded.latest_trading_date,
       updated_at = excluded.updated_at,
       price_close = excluded.price_close,
       change_1d = excluded.change_1d,
       rs_ratio_close = excluded.rs_ratio_close,
       rs_ratio_ma = excluded.rs_ratio_ma,
       rs_above_ma = excluded.rs_above_ma,
       rs_new_high = excluded.rs_new_high,
       rs_new_high_before_price = excluded.rs_new_high_before_price,
       bull_cross = excluded.bull_cross,
       approx_rs_rating = excluded.approx_rs_rating,
       price_close_history_json = excluded.price_close_history_json,
       benchmark_close_history_json = excluded.benchmark_close_history_json,
       weighted_score_history_json = excluded.weighted_score_history_json,
       rs_new_high_window_json = excluded.rs_new_high_window_json,
       price_new_high_window_json = excluded.price_new_high_window_json,
       sma_window_json = excluded.sma_window_json,
       sma_sum = excluded.sma_sum,
       ema_value = excluded.ema_value,
       previous_rs_close = excluded.previous_rs_close,
       previous_rs_ma = excluded.previous_rs_ma
     WHERE excluded.latest_trading_date >= relative_strength_config_state.latest_trading_date`,
  ).bind(
    row.configKey,
    String(row.ticker ?? "").toUpperCase(),
    String(row.benchmarkTicker ?? "").toUpperCase(),
    row.rsMaType,
    row.rsMaLength,
    row.newHighLookback,
    row.stateVersion,
    row.latestTradingDate,
    row.updatedAt ?? null,
    row.priceClose ?? null,
    row.change1d ?? null,
    row.rsRatioClose ?? null,
    row.rsRatioMa ?? null,
    row.rsAboveMa ?? 0,
    row.rsNewHigh ?? 0,
    row.rsNewHighBeforePrice ?? 0,
    row.bullCross ?? 0,
    row.approxRsRating ?? null,
    row.priceCloseHistoryJson ?? null,
    row.benchmarkCloseHistoryJson ?? null,
    row.weightedScoreHistoryJson ?? null,
    row.rsNewHighWindowJson ?? null,
    row.priceNewHighWindowJson ?? null,
    row.smaWindowJson ?? null,
    row.smaSum ?? null,
    row.emaValue ?? null,
    row.previousRsClose ?? null,
    row.previousRsMa ?? null,
    row.createdAt ?? null,
  );
}

async function backfillScannerCacheRsCacheTable(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  table: RsDerivedCacheTable,
  cursor: string | null | undefined,
  limit: number,
): Promise<RsDerivedCacheBackfillTableResult> {
  const rows = await loadLegacyRsBackfillRows(env.DB, table, cursor, limit);
  if (rows.length > 0) {
    for (let index = 0; index < rows.length; index += RS_JOB_INSERT_CHUNK_SIZE) {
      const chunk = rows.slice(index, index + RS_JOB_INSERT_CHUNK_SIZE);
      await env.SCANNER_CACHE_DB.batch(chunk.map((row) => prepareRsBackfillUpsert(env.SCANNER_CACHE_DB, table, row)));
    }
  }
  const done = rows.length < limit;
  const lastRow = rows[rows.length - 1];
  const nextCursor = done || !lastRow
    ? null
    : encodeRsBackfillCursor({ version: 1, table, key: rsBackfillKeyForRow(table, lastRow) });
  return {
    table,
    copied: rows.length,
    done,
    nextCursor,
  };
}

export async function backfillScannerCacheRsCache(
  env: Env,
  input: {
    table?: RsDerivedCacheBackfillTarget | null;
    cursor?: string | null;
    limit?: number | null;
  },
): Promise<RsDerivedCacheBackfillResult> {
  if (!hasScannerCacheStorage(env)) {
    throw new Error("SCANNER_CACHE_DB binding is required for RS cache backfill.");
  }
  const target = input.table ?? "all";
  const limit = normalizeRsDerivedBackfillLimit(input.limit);
  if (target !== "all") {
    assertRsDerivedCacheTable(target);
    const result = await backfillScannerCacheRsCacheTable(env, target, input.cursor, limit);
    return {
      table: target,
      copied: result.copied,
      done: result.done,
      nextCursor: result.nextCursor,
      tables: [result],
    };
  }

  const decoded = decodeRsBackfillCursor(input.cursor);
  const cursorMap = decoded?.table === "all" ? decoded.cursors : {};
  const results: RsDerivedCacheBackfillTableResult[] = [];
  const nextCursors: Partial<Record<RsDerivedCacheTable, string | null>> = {};
  for (const table of RS_DERIVED_CACHE_TABLES) {
    const result = await backfillScannerCacheRsCacheTable(env, table, cursorMap[table], limit);
    results.push(result);
    nextCursors[table] = result.nextCursor;
  }
  const done = results.every((result) => result.done);
  return {
    table: "all",
    copied: results.reduce((sum, result) => sum + result.copied, 0),
    done,
    nextCursor: done ? null : encodeRsBackfillCursor({ version: 1, table: "all", cursors: nextCursors }),
    tables: results,
  };
}

function isActiveScanStatus(status: string | null | undefined): boolean {
  return status === "queued" || status === "running";
}

function isManualRelativeStrengthRunLeaseActive(run: Pick<ManualRelativeStrengthRunRecord, "leaseOwner" | "leaseExpiresAt">): boolean {
  if (!run.leaseOwner || !run.leaseExpiresAt) return false;
  const expiresAt = toTimestampMs(run.leaseExpiresAt);
  return expiresAt != null && expiresAt > Date.now();
}

function isManualRelativeStrengthRunAbandoned(run: ManualRelativeStrengthRunRecord): boolean {
  if (!isActiveScanStatus(run.status)) return false;
  if (isManualRelativeStrengthRunLeaseActive(run)) return false;
  const updatedAt = toTimestampMs(run.heartbeatAt ?? run.updatedAt);
  return updatedAt != null && Date.now() - updatedAt > MANUAL_RS_SCAN_STALE_RUN_MS;
}

function normalizeManualRunRecord(row: ManualRelativeStrengthRunRecord): ManualRelativeStrengthRunRecord {
  return {
    ...row,
    presetId: row.presetId,
    presetName: row.presetName,
    benchmarkTicker: row.benchmarkTicker.toUpperCase(),
    rsMaType: normalizeRsMaType(row.rsMaType),
    rsMaLength: Math.max(1, Math.trunc(row.rsMaLength || 21)),
    newHighLookback: Math.max(1, Math.trunc(row.newHighLookback || 252)),
    totalTickers: Math.max(0, Math.trunc(Number(row.totalTickers ?? 0))),
    processedTickers: Math.max(0, Math.trunc(Number(row.processedTickers ?? 0))),
    matchedTickers: Math.max(0, Math.trunc(Number(row.matchedTickers ?? 0))),
    cursorOffset: Math.max(0, Math.trunc(Number(row.cursorOffset ?? 0))),
    cacheHitTickers: Math.max(0, Math.trunc(Number(row.cacheHitTickers ?? 0))),
    computedTickers: Math.max(0, Math.trunc(Number(row.computedTickers ?? 0))),
    missingBarsTickers: Math.max(0, Math.trunc(Number(row.missingBarsTickers ?? 0))),
    insufficientHistoryTickers: Math.max(0, Math.trunc(Number(row.insufficientHistoryTickers ?? 0))),
    errorTickers: Math.max(0, Math.trunc(Number(row.errorTickers ?? 0))),
    staleBenchmarkTickers: Math.max(0, Math.trunc(Number(row.staleBenchmarkTickers ?? 0))),
    durationMs: row.durationMs == null ? null : Math.max(0, Math.trunc(Number(row.durationMs) || 0)),
  };
}

async function loadManualRelativeStrengthRun(env: Env, runId: string): Promise<ManualRelativeStrengthRunRecord | null> {
  if (!hasScannerCacheStorage(env)) return null;
  const row = await env.SCANNER_CACHE_DB.prepare(
    `SELECT
       id,
       preset_id as presetId,
       preset_name as presetName,
       config_key as configKey,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback,
       expected_trading_date as expectedTradingDate,
       status,
       requested_by as requestedBy,
       created_at as createdAt,
       started_at as startedAt,
       updated_at as updatedAt,
       heartbeat_at as heartbeatAt,
       completed_at as completedAt,
       error,
       warning,
       total_tickers as totalTickers,
       processed_tickers as processedTickers,
       matched_tickers as matchedTickers,
       cursor_offset as cursorOffset,
       latest_snapshot_id as latestSnapshotId,
       lease_owner as leaseOwner,
       lease_expires_at as leaseExpiresAt,
       cache_hit_tickers as cacheHitTickers,
       computed_tickers as computedTickers,
       missing_bars_tickers as missingBarsTickers,
       insufficient_history_tickers as insufficientHistoryTickers,
       error_tickers as errorTickers,
       stale_benchmark_tickers as staleBenchmarkTickers,
       duration_ms as durationMs
     FROM rs_scan_runs
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(runId)
    .first<ManualRelativeStrengthRunRecord>();
  return row ? normalizeManualRunRecord(row) : null;
}

async function loadActiveManualRelativeStrengthRun(env: Env): Promise<ManualRelativeStrengthRunRecord | null> {
  if (!hasScannerCacheStorage(env)) return null;
  const row = await env.SCANNER_CACHE_DB.prepare(
    `SELECT
       id,
       preset_id as presetId,
       preset_name as presetName,
       config_key as configKey,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback,
       expected_trading_date as expectedTradingDate,
       status,
       requested_by as requestedBy,
       created_at as createdAt,
       started_at as startedAt,
       updated_at as updatedAt,
       heartbeat_at as heartbeatAt,
       completed_at as completedAt,
       error,
       warning,
       total_tickers as totalTickers,
       processed_tickers as processedTickers,
       matched_tickers as matchedTickers,
       cursor_offset as cursorOffset,
       latest_snapshot_id as latestSnapshotId,
       lease_owner as leaseOwner,
       lease_expires_at as leaseExpiresAt,
       cache_hit_tickers as cacheHitTickers,
       computed_tickers as computedTickers,
       missing_bars_tickers as missingBarsTickers,
       insufficient_history_tickers as insufficientHistoryTickers,
       error_tickers as errorTickers,
       stale_benchmark_tickers as staleBenchmarkTickers,
       duration_ms as durationMs
     FROM rs_scan_runs
     WHERE status IN ('queued', 'running')
     ORDER BY datetime(created_at) ASC
     LIMIT 1`,
  ).first<ManualRelativeStrengthRunRecord>();
  return row ? normalizeManualRunRecord(row) : null;
}

async function loadLatestCompletedManualRelativeStrengthRunForConfig(
  env: Env,
  configKey: string,
): Promise<ManualRelativeStrengthRunRecord | null> {
  if (!hasScannerCacheStorage(env)) return null;
  const row = await env.SCANNER_CACHE_DB.prepare(
    `SELECT
       id,
       preset_id as presetId,
       preset_name as presetName,
       config_key as configKey,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback,
       expected_trading_date as expectedTradingDate,
       status,
       requested_by as requestedBy,
       created_at as createdAt,
       started_at as startedAt,
       updated_at as updatedAt,
       heartbeat_at as heartbeatAt,
       completed_at as completedAt,
       error,
       warning,
       total_tickers as totalTickers,
       processed_tickers as processedTickers,
       matched_tickers as matchedTickers,
       cursor_offset as cursorOffset,
       latest_snapshot_id as latestSnapshotId,
       lease_owner as leaseOwner,
       lease_expires_at as leaseExpiresAt,
       cache_hit_tickers as cacheHitTickers,
       computed_tickers as computedTickers,
       missing_bars_tickers as missingBarsTickers,
       insufficient_history_tickers as insufficientHistoryTickers,
       error_tickers as errorTickers,
       stale_benchmark_tickers as staleBenchmarkTickers,
       duration_ms as durationMs
     FROM rs_scan_runs
     WHERE config_key = ?
       AND status = 'completed'
     ORDER BY datetime(completed_at) DESC, datetime(created_at) DESC
     LIMIT 1`,
  )
    .bind(configKey)
    .first<ManualRelativeStrengthRunRecord>();
  return row ? normalizeManualRunRecord(row) : null;
}

async function failManualRelativeStrengthRun(env: Env, runId: string, error: string): Promise<void> {
  if (!hasScannerCacheStorage(env)) return;
  await env.SCANNER_CACHE_DB.prepare(
    `UPDATE rs_scan_runs
     SET status = 'failed',
         error = ?,
         completed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP,
         heartbeat_at = CURRENT_TIMESTAMP,
         duration_ms = CAST((julianday('now') - julianday(COALESCE(started_at, created_at))) * 86400000 AS INTEGER),
         lease_owner = NULL,
         lease_expires_at = NULL
     WHERE id = ?`,
  )
    .bind(error, runId)
    .run();
}

async function loadManualRelativeStrengthUniverseCandidates(
  env: Env,
  expectedTradingDate: string,
): Promise<ManualRelativeStrengthCandidateRow[]> {
  const rows = await env.DB.prepare(
    `SELECT
       s.ticker,
       s.name,
       s.sector,
       s.industry,
       s.exchange,
       s.asset_class as assetClass
     FROM symbols s
     WHERE COALESCE(s.is_active, 1) = 1
       AND LOWER(COALESCE(s.asset_class, 'equity')) IN ('equity', 'stock', 'stocks', 'common_stock', 'common stock')
       AND EXISTS (
         SELECT 1
         FROM daily_bars d
         WHERE d.ticker = s.ticker
           AND d.date <= ?
         LIMIT 1
       )
     ORDER BY s.ticker ASC
     LIMIT ?`,
  )
    .bind(expectedTradingDate, MANUAL_RS_SCAN_MAX_UNIVERSE_SIZE)
    .all<{
      ticker: string;
      name: string | null;
      sector: string | null;
      industry: string | null;
      exchange: string | null;
      assetClass: string | null;
    }>();

  return (rows.results ?? [])
    .map((row, index) => ({
      cursorOffset: index,
      ticker: row.ticker.toUpperCase(),
      name: row.name ?? row.ticker.toUpperCase(),
      sector: row.sector ?? null,
      industry: row.industry ?? null,
      exchange: row.exchange ?? null,
      assetClass: row.assetClass ?? null,
      marketCap: null,
      relativeVolume: null,
      avgVolume: null,
      priceAvgVolume: null,
      price: null,
      change1d: null,
      status: "queued",
      reason: null,
      latestTradingDate: null,
      source: "computed",
    }))
    .filter((row) => normalizeTicker(row.ticker) != null);
}

async function insertManualRelativeStrengthRunCandidates(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  runId: string,
  candidates: ManualRelativeStrengthCandidateRow[],
): Promise<void> {
  for (let index = 0; index < candidates.length; index += RS_JOB_INSERT_CHUNK_SIZE) {
    const chunk = candidates.slice(index, index + RS_JOB_INSERT_CHUNK_SIZE);
    await env.SCANNER_CACHE_DB.batch(chunk.map((row) =>
      env.SCANNER_CACHE_DB.prepare(
        `INSERT INTO rs_scan_run_tickers
          (run_id, cursor_offset, ticker, name, sector, industry, exchange, asset_class, market_cap, relative_volume, avg_volume, price_avg_volume, price, change_1d, status, reason, latest_trading_date, computed_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, 'computed')`,
      ).bind(
        runId,
        row.cursorOffset,
        row.ticker,
        row.name,
        row.sector,
        row.industry,
        row.exchange,
        row.assetClass,
        row.marketCap,
        row.relativeVolume,
        row.avgVolume,
        row.priceAvgVolume,
        row.price,
        row.change1d,
      )));
  }
}

async function createManualRelativeStrengthRun(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  preset: ScanPreset,
  requestedBy?: string | null,
): Promise<ManualRelativeStrengthRunRecord> {
  const active = await loadActiveManualRelativeStrengthRun(env);
  if (active && !isManualRelativeStrengthRunAbandoned(active)) return active;
  if (active) {
    await failManualRelativeStrengthRun(env, active.id, "Manual relative strength run was abandoned and replaced by a new request.");
  }

  const identity = buildRelativeStrengthConfigIdentity(preset);
  const candidates = await loadManualRelativeStrengthUniverseCandidates(env, identity.expectedTradingDate);
  const runId = crypto.randomUUID();
  try {
    await env.SCANNER_CACHE_DB.prepare(
      `INSERT INTO rs_scan_runs
        (id, preset_id, preset_name, config_key, benchmark_ticker, rs_ma_type, rs_ma_length, new_high_lookback, expected_trading_date, status, requested_by, total_tickers, processed_tickers, matched_tickers, cursor_offset, created_at, updated_at, warning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)`,
    )
      .bind(
        runId,
        preset.id,
        preset.name,
        identity.configKey,
        identity.benchmarkTicker,
        identity.rsMaType,
        identity.rsMaLength,
        identity.newHighLookback,
        identity.expectedTradingDate,
        requestedBy ?? null,
        candidates.length,
      )
      .run();
    await insertManualRelativeStrengthRunCandidates(env, runId, candidates);
  } catch (error) {
    const existing = await loadActiveManualRelativeStrengthRun(env);
    if (existing) return existing;
    await env.SCANNER_CACHE_DB.prepare("DELETE FROM rs_scan_runs WHERE id = ?").bind(runId).run();
    throw error;
  }

  const created = await loadManualRelativeStrengthRun(env, runId);
  if (!created) throw new Error("Failed to create manual relative strength scan run.");
  return created;
}

async function loadManualRelativeStrengthRunCandidateSlice(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  runId: string,
  cursorOffset: number,
  limit: number,
): Promise<ManualRelativeStrengthCandidateRow[]> {
  const rows = await env.SCANNER_CACHE_DB.prepare(
    `SELECT
       cursor_offset as cursorOffset,
       ticker,
       name,
       sector,
       industry,
       exchange,
       asset_class as assetClass,
       market_cap as marketCap,
       relative_volume as relativeVolume,
       avg_volume as avgVolume,
       price_avg_volume as priceAvgVolume,
       price,
       change_1d as change1d,
       status,
       reason,
       latest_trading_date as latestTradingDate,
       source
     FROM rs_scan_run_tickers
     WHERE run_id = ?
     ORDER BY cursor_offset ASC
     LIMIT ? OFFSET ?`,
  )
    .bind(runId, limit, cursorOffset)
    .all<ManualRelativeStrengthCandidateRow>();
  return (rows.results ?? []).map((row) => ({
    ...row,
    ticker: row.ticker.toUpperCase(),
    marketCap: row.marketCap == null ? null : Number(row.marketCap),
    relativeVolume: row.relativeVolume == null ? null : Number(row.relativeVolume),
    avgVolume: row.avgVolume == null ? null : Number(row.avgVolume),
    priceAvgVolume: row.priceAvgVolume == null ? null : Number(row.priceAvgVolume),
    price: row.price == null ? null : Number(row.price),
    change1d: row.change1d == null ? null : Number(row.change1d),
  }));
}

function percentChange(now: number | null | undefined, previous: number | null | undefined): number | null {
  if (now == null || previous == null || !Number.isFinite(now) || !Number.isFinite(previous) || previous === 0) return null;
  return ((now - previous) / previous) * 100;
}

function averageVolume(bars: RelativeStrengthDailyBar[], length: number): number | null {
  const values = bars
    .slice(-length)
    .map((bar) => Number((bar as { volume?: number }).volume ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function manualCandidateType(assetClass: string | null): string | null {
  const normalized = String(assetClass ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "equity" || normalized === "stock" || normalized === "stocks") return "stock";
  return normalized;
}

function manualRuleFieldSupported(rule: ScanPresetRule): boolean {
  const supported = new Set([
    "ticker",
    "name",
    "sector",
    "industry",
    "change",
    "relative_volume_10d_calc",
    "close",
    "average_volume_30d_calc",
    "Value.Traded",
    "volume",
    "exchange",
    "type",
    "rs_close",
    "rs_ma",
    "approx_rs_rating",
    "trend_score",
    "daily_pivot",
    "daily_pivot_gap_pct",
    "weekly_high",
    "weekly_high_gap_pct",
    "vcp_signal",
  ]);
  const field = normalizeFieldName(rule.field);
  if (!supported.has(field)) return false;
  if (isFieldReferenceValue(rule.value)) return supported.has(normalizeFieldName(rule.value.field));
  return true;
}

function manualRulesWarning(preset: ScanPreset): string | null {
  const unsupported = preset.rules
    .filter((rule) => !manualRuleFieldSupported(rule))
    .map((rule) => rule.field);
  if (unsupported.length === 0) return null;
  return `Skipped unsupported local scanner rule fields: ${Array.from(new Set(unsupported)).join(", ")}.`;
}

function manualRowToTradingViewRow(
  row: ScanSnapshotRow,
  candidate: ManualRelativeStrengthCandidateRow,
  latestVolume: number | null,
): TradingViewScanRow {
  return {
    ticker: row.ticker,
    name: row.name,
    sector: row.sector,
    industry: row.industry,
    change1d: row.change1d,
    marketCap: row.marketCap,
    relativeVolume: row.relativeVolume,
    price: row.price,
    avgVolume: row.avgVolume,
    priceAvgVolume: row.priceAvgVolume,
    volume: latestVolume,
    exchange: candidate.exchange,
    type: manualCandidateType(candidate.assetClass),
    raw: {
      rsClose: row.rsClose,
      rs_close: row.rsClose,
      rsMa: row.rsMa,
      rs_ma: row.rsMa,
      rsAboveMa: row.rsAboveMa,
      rs_above_ma: row.rsAboveMa,
      rsNewHigh: row.rsNewHigh,
      rs_new_high: row.rsNewHigh,
      rsNewHighBeforePrice: row.rsNewHighBeforePrice,
      rs_new_high_before_price: row.rsNewHighBeforePrice,
      bullCross: row.bullCross,
      bull_cross: row.bullCross,
      approxRsRating: row.approxRsRating,
      approx_rs_rating: row.approxRsRating,
    },
  };
}

async function upsertManualRelativeStrengthBatchResults(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  run: ManualRelativeStrengthRunRecord,
  results: Array<{
    candidate: ManualRelativeStrengthCandidateRow;
    status: "computed" | "missing_bars" | "insufficient_history" | "stale_benchmark" | "error";
    reason: string | null;
    latestTradingDate: string | null;
    price: number | null;
    change1d: number | null;
    avgVolume: number | null;
    relativeVolume: number | null;
    priceAvgVolume: number | null;
    feature: RelativeStrengthLatestCacheRecord | null;
    source: "cache" | "computed";
  }>,
): Promise<number> {
  let computedCount = 0;
  for (let index = 0; index < results.length; index += RS_JOB_INSERT_CHUNK_SIZE) {
    const chunk = results.slice(index, index + RS_JOB_INSERT_CHUNK_SIZE);
    const batchStatements = chunk.flatMap((result) => {
      if (result.status === "computed") computedCount += 1;
      const feature = result.feature;
      const rowStatements = [
        env.SCANNER_CACHE_DB.prepare(
          `UPDATE rs_scan_run_tickers
           SET status = ?,
               reason = ?,
               latest_trading_date = ?,
               price = ?,
               change_1d = ?,
               avg_volume = ?,
               relative_volume = ?,
               price_avg_volume = ?,
               computed_at = CURRENT_TIMESTAMP,
               source = ?
           WHERE run_id = ?
             AND ticker = ?`,
        ).bind(
          result.status,
          result.reason,
          result.latestTradingDate,
          result.price,
          result.change1d,
          result.avgVolume,
          result.relativeVolume,
          result.priceAvgVolume,
          result.source,
          run.id,
          result.candidate.ticker,
        ),
      ];
      if (result.source === "cache") return rowStatements;
      rowStatements.push(
        env.SCANNER_CACHE_DB.prepare(
          `INSERT INTO rs_features_latest
            (config_key, ticker, expected_trading_date, trading_date, benchmark_ticker, rs_ma_type, rs_ma_length, new_high_lookback, price_close, change_1d, rs_ratio_close, rs_ratio_ma, rs_above_ma, rs_new_high, rs_new_high_before_price, bull_cross, approx_rs_rating, status, reason, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(config_key, ticker) DO UPDATE SET
             expected_trading_date = excluded.expected_trading_date,
             trading_date = excluded.trading_date,
             benchmark_ticker = excluded.benchmark_ticker,
             rs_ma_type = excluded.rs_ma_type,
             rs_ma_length = excluded.rs_ma_length,
             new_high_lookback = excluded.new_high_lookback,
             price_close = excluded.price_close,
             change_1d = excluded.change_1d,
             rs_ratio_close = excluded.rs_ratio_close,
             rs_ratio_ma = excluded.rs_ratio_ma,
             rs_above_ma = excluded.rs_above_ma,
             rs_new_high = excluded.rs_new_high,
             rs_new_high_before_price = excluded.rs_new_high_before_price,
             bull_cross = excluded.bull_cross,
             approx_rs_rating = excluded.approx_rs_rating,
             status = excluded.status,
             reason = excluded.reason,
             computed_at = CURRENT_TIMESTAMP`,
        ).bind(
          run.configKey,
          result.candidate.ticker,
          run.expectedTradingDate,
          feature?.tradingDate ?? result.latestTradingDate,
          run.benchmarkTicker,
          run.rsMaType,
          run.rsMaLength,
          run.newHighLookback,
          feature?.priceClose ?? result.price,
          feature?.change1d ?? result.change1d,
          feature?.rsRatioClose ?? null,
          feature?.rsRatioMa ?? null,
          feature ? (asBooleanFlag(feature.rsAboveMa) ? 1 : 0) : 0,
          feature ? (asBooleanFlag(feature.rsNewHigh) ? 1 : 0) : 0,
          feature ? (asBooleanFlag(feature.rsNewHighBeforePrice) ? 1 : 0) : 0,
          feature ? (asBooleanFlag(feature.bullCross) ? 1 : 0) : 0,
          feature?.approxRsRating ?? null,
          result.status,
          result.reason,
        ),
      );
      return rowStatements;
    });
    await env.SCANNER_CACHE_DB.batch(batchStatements);
  }
  return computedCount;
}

async function heartbeatManualRelativeStrengthRun(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  runId: string,
  updates: Partial<Pick<ManualRelativeStrengthRunRecord, "status" | "processedTickers" | "matchedTickers" | "cursorOffset" | "warning" | "latestSnapshotId" | "cacheHitTickers" | "computedTickers" | "missingBarsTickers" | "insufficientHistoryTickers" | "errorTickers" | "staleBenchmarkTickers" | "durationMs">> & { completedAt?: string | null; error?: string | null; releaseLease?: boolean },
): Promise<void> {
  const fields = ["updated_at = CURRENT_TIMESTAMP", "heartbeat_at = CURRENT_TIMESTAMP"];
  const values: unknown[] = [];
  if (updates.status != null) {
    fields.push("status = ?");
    values.push(updates.status);
  }
  if (updates.processedTickers != null) {
    fields.push("processed_tickers = ?");
    values.push(updates.processedTickers);
  }
  if (updates.matchedTickers != null) {
    fields.push("matched_tickers = ?");
    values.push(updates.matchedTickers);
  }
  if (updates.cursorOffset != null) {
    fields.push("cursor_offset = ?");
    values.push(updates.cursorOffset);
  }
  if (updates.cacheHitTickers != null) {
    fields.push("cache_hit_tickers = ?");
    values.push(updates.cacheHitTickers);
  }
  if (updates.computedTickers != null) {
    fields.push("computed_tickers = ?");
    values.push(updates.computedTickers);
  }
  if (updates.missingBarsTickers != null) {
    fields.push("missing_bars_tickers = ?");
    values.push(updates.missingBarsTickers);
  }
  if (updates.insufficientHistoryTickers != null) {
    fields.push("insufficient_history_tickers = ?");
    values.push(updates.insufficientHistoryTickers);
  }
  if (updates.errorTickers != null) {
    fields.push("error_tickers = ?");
    values.push(updates.errorTickers);
  }
  if (updates.staleBenchmarkTickers != null) {
    fields.push("stale_benchmark_tickers = ?");
    values.push(updates.staleBenchmarkTickers);
  }
  if (updates.durationMs != null) {
    fields.push("duration_ms = ?");
    values.push(updates.durationMs);
  }
  if (updates.warning !== undefined) {
    fields.push("warning = ?");
    values.push(updates.warning);
  }
  if (updates.error !== undefined) {
    fields.push("error = ?");
    values.push(updates.error);
  }
  if (updates.latestSnapshotId !== undefined) {
    fields.push("latest_snapshot_id = ?");
    values.push(updates.latestSnapshotId);
  }
  if (updates.completedAt !== undefined) {
    fields.push("completed_at = ?");
    values.push(updates.completedAt);
  }
  if (updates.releaseLease) {
    fields.push("lease_owner = NULL", "lease_expires_at = NULL");
  }
  await env.SCANNER_CACHE_DB.prepare(`UPDATE rs_scan_runs SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values, runId)
    .run();
}

async function acquireManualRelativeStrengthRunLease(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  run: ManualRelativeStrengthRunRecord,
): Promise<ManualRelativeStrengthRunRecord | null> {
  if (isManualRelativeStrengthRunLeaseActive(run)) return null;
  const leaseOwner = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + MANUAL_RS_SCAN_LEASE_DURATION_MS).toISOString();
  await env.SCANNER_CACHE_DB.prepare(
    `UPDATE rs_scan_runs
     SET status = 'running',
         started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP,
         heartbeat_at = CURRENT_TIMESTAMP,
         lease_owner = ?,
         lease_expires_at = ?
     WHERE id = ?
       AND status IN ('queued', 'running')`,
  )
    .bind(leaseOwner, leaseExpiresAt, run.id)
    .run();
  const leased = await loadManualRelativeStrengthRun(env, run.id);
  return leased?.leaseOwner === leaseOwner ? leased : null;
}

async function loadLatestCompletedPostCloseDailyBarRefreshAt(
  env: Env,
  tradingDate: string,
): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT completed_at as completedAt
     FROM post_close_daily_bar_refresh_jobs
     WHERE scope = ?
       AND trading_date = ?
       AND status = 'completed'
       AND completed_at IS NOT NULL
     ORDER BY datetime(completed_at) DESC
     LIMIT 1`,
  )
    .bind(POST_CLOSE_DAILY_BARS_SCOPE, tradingDate)
    .first<{ completedAt: string | null }>();
  return toTimestampMs(row?.completedAt);
}

async function loadManualRelativeStrengthFeatureCacheRows(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  configKey: string,
  tickers: string[],
): Promise<Map<string, ManualRelativeStrengthFeatureRow>> {
  const uniqueTickers = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  const rowsByTicker = new Map<string, ManualRelativeStrengthFeatureRow>();
  for (let index = 0; index < uniqueTickers.length; index += RS_STORED_BAR_QUERY_CHUNK_SIZE) {
    const chunk = uniqueTickers.slice(index, index + RS_STORED_BAR_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.SCANNER_CACHE_DB.prepare(
      `SELECT
         config_key as configKey,
         ticker,
         expected_trading_date as expectedTradingDate,
         trading_date as tradingDate,
         benchmark_ticker as benchmarkTicker,
         rs_ma_type as rsMaType,
         rs_ma_length as rsMaLength,
         new_high_lookback as newHighLookback,
         price_close as priceClose,
         change_1d as change1d,
         rs_ratio_close as rsRatioClose,
         rs_ratio_ma as rsRatioMa,
         rs_above_ma as rsAboveMa,
         rs_new_high as rsNewHigh,
         rs_new_high_before_price as rsNewHighBeforePrice,
         bull_cross as bullCross,
         approx_rs_rating as approxRsRating,
         status,
         reason,
         computed_at as computedAt
       FROM rs_features_latest
       WHERE config_key = ?
         AND ticker IN (${placeholders})`,
    )
      .bind(configKey, ...chunk)
      .all<ManualRelativeStrengthFeatureRow>();
    for (const row of rows.results ?? []) {
      rowsByTicker.set(row.ticker.toUpperCase(), {
        ...row,
        ticker: row.ticker.toUpperCase(),
        benchmarkTicker: row.benchmarkTicker.toUpperCase(),
        rsMaType: normalizeRsMaType(row.rsMaType),
        rsMaLength: Math.max(1, Math.trunc(Number(row.rsMaLength || 21))),
        newHighLookback: Math.max(1, Math.trunc(Number(row.newHighLookback || 252))),
      });
    }
  }
  return rowsByTicker;
}

function isReusableManualRelativeStrengthFeature(
  row: ManualRelativeStrengthFeatureRow | undefined,
  identity: RelativeStrengthConfigIdentity,
  invalidatedAfterMs: number | null,
): row is ManualRelativeStrengthFeatureRow {
  if (!row) return false;
  const expectedTradingDate = row.expectedTradingDate ?? row.tradingDate;
  if (expectedTradingDate !== identity.expectedTradingDate) return false;
  const computedAtMs = toTimestampMs(row.computedAt);
  if (invalidatedAfterMs != null && computedAtMs != null && computedAtMs < invalidatedAfterMs) return false;
  if (row.status === "computed") return row.tradingDate === identity.expectedTradingDate;
  return row.status === "missing_bars" || row.status === "insufficient_history" || row.status === "stale_benchmark";
}

function cachedManualRelativeStrengthResult(
  candidate: ManualRelativeStrengthCandidateRow,
  feature: ManualRelativeStrengthFeatureRow,
): {
  candidate: ManualRelativeStrengthCandidateRow;
  status: ManualRelativeStrengthTickerStatus;
  reason: string | null;
  latestTradingDate: string | null;
  price: number | null;
  change1d: number | null;
  avgVolume: number | null;
  relativeVolume: number | null;
  priceAvgVolume: number | null;
  feature: RelativeStrengthLatestCacheRecord | null;
  source: "cache";
} {
  const price = feature.priceClose ?? candidate.price ?? null;
  const avgVolume = candidate.avgVolume ?? null;
  return {
    candidate,
    status: feature.status as ManualRelativeStrengthTickerStatus,
    reason: feature.reason ?? null,
    latestTradingDate: feature.tradingDate ?? candidate.latestTradingDate ?? null,
    price,
    change1d: feature.change1d ?? candidate.change1d ?? null,
    avgVolume,
    relativeVolume: candidate.relativeVolume ?? null,
    priceAvgVolume: price != null && avgVolume != null ? price * avgVolume : candidate.priceAvgVolume ?? null,
    feature,
    source: "cache",
  };
}

function countManualRelativeStrengthBatchStatus(
  results: Array<{ status: ManualRelativeStrengthTickerStatus; source: "cache" | "computed" }>,
): Pick<ManualRelativeStrengthRunRecord, "cacheHitTickers" | "computedTickers" | "missingBarsTickers" | "insufficientHistoryTickers" | "errorTickers" | "staleBenchmarkTickers"> {
  return {
    cacheHitTickers: results.filter((result) => result.source === "cache").length,
    computedTickers: results.filter((result) => result.source === "computed" && result.status === "computed").length,
    missingBarsTickers: results.filter((result) => result.status === "missing_bars").length,
    insufficientHistoryTickers: results.filter((result) => result.status === "insufficient_history").length,
    errorTickers: results.filter((result) => result.status === "error").length,
    staleBenchmarkTickers: results.filter((result) => result.status === "stale_benchmark").length,
  };
}

async function buildManualRelativeStrengthSnapshotResult(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  preset: ScanPreset,
  run: ManualRelativeStrengthRunRecord,
): Promise<{
  providerLabel: string;
  matchedRowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
  rows: ScanSnapshotRow[];
}> {
  const rows = await env.SCANNER_CACHE_DB.prepare(
    `SELECT
       t.cursor_offset as cursorOffset,
       t.ticker,
       t.name,
       t.sector,
       t.industry,
       t.exchange,
       t.asset_class as assetClass,
       t.market_cap as marketCap,
       t.relative_volume as relativeVolume,
       t.avg_volume as avgVolume,
       t.price_avg_volume as priceAvgVolume,
       t.price,
       t.change_1d as change1d,
       t.status,
       t.reason,
       t.latest_trading_date as latestTradingDate,
       t.source,
       f.benchmark_ticker as benchmarkTicker,
       f.rs_ma_type as rsMaType,
       f.rs_ma_length as rsMaLength,
       f.new_high_lookback as newHighLookback,
       f.expected_trading_date as expectedTradingDate,
       f.trading_date as tradingDate,
       f.price_close as priceClose,
       f.change_1d as featureChange1d,
       f.rs_ratio_close as rsRatioClose,
       f.rs_ratio_ma as rsRatioMa,
       f.rs_above_ma as rsAboveMa,
       f.rs_new_high as rsNewHigh,
       f.rs_new_high_before_price as rsNewHighBeforePrice,
       f.bull_cross as bullCross,
       f.approx_rs_rating as approxRsRating,
       f.computed_at as computedAt
     FROM rs_scan_run_tickers t
     JOIN rs_features_latest f
       ON f.config_key = ?
      AND f.ticker = t.ticker
     WHERE t.run_id = ?
       AND f.status = 'computed'
     ORDER BY t.cursor_offset ASC`,
  )
    .bind(run.configKey, run.id)
    .all<ManualRelativeStrengthCandidateRow & ManualRelativeStrengthFeatureRow & { featureChange1d: number | null }>();

  const scaleFactor = preset.verticalOffset * 100;
  const supportedRules = preset.rules.filter(manualRuleFieldSupported);
  const skippedRuleWarning = manualRulesWarning(preset);
  const identity = buildRelativeStrengthConfigIdentity(preset, run.expectedTradingDate);
  const mergedRows = (rows.results ?? [])
    .map((row) => {
      const cacheRow: RelativeStrengthLatestCacheRecord = {
        ticker: row.ticker.toUpperCase(),
        benchmarkTicker: row.benchmarkTicker.toUpperCase(),
        rsMaType: normalizeRsMaType(row.rsMaType),
        rsMaLength: Math.max(1, Math.trunc(row.rsMaLength || 21)),
        newHighLookback: Math.max(1, Math.trunc(row.newHighLookback || 252)),
        tradingDate: row.tradingDate,
        priceClose: row.priceClose,
        change1d: row.featureChange1d ?? row.change1d,
        rsRatioClose: row.rsRatioClose,
        rsRatioMa: row.rsRatioMa,
        rsAboveMa: row.rsAboveMa,
        rsNewHigh: row.rsNewHigh,
        rsNewHighBeforePrice: row.rsNewHighBeforePrice,
        bullCross: row.bullCross,
        approxRsRating: row.approxRsRating,
      };
      if (!cachedRowMatchesOutputMode(cacheRow, preset.outputMode)) return null;
      const rsClose = cacheRow.rsRatioClose == null ? null : cacheRow.rsRatioClose * scaleFactor;
      const rsMa = cacheRow.rsRatioMa == null ? null : cacheRow.rsRatioMa * scaleFactor;
      const latestVolume = row.avgVolume != null && row.relativeVolume != null ? row.avgVolume * row.relativeVolume : null;
      const snapshotRow: ScanSnapshotRow = {
        ticker: row.ticker.toUpperCase(),
        name: row.name ?? row.ticker.toUpperCase(),
        sector: row.sector ?? null,
        industry: row.industry ?? null,
        change1d: cacheRow.change1d,
        marketCap: row.marketCap ?? null,
        relativeVolume: row.relativeVolume ?? null,
        price: cacheRow.priceClose,
        avgVolume: row.avgVolume ?? null,
        priceAvgVolume: row.priceAvgVolume ?? null,
        rsClose,
        rsMa,
        rsAboveMa: asBooleanFlag(cacheRow.rsAboveMa),
        rsNewHigh: asBooleanFlag(cacheRow.rsNewHigh),
        rsNewHighBeforePrice: asBooleanFlag(cacheRow.rsNewHighBeforePrice),
        bullCross: asBooleanFlag(cacheRow.bullCross),
        approxRsRating: cacheRow.approxRsRating,
        rawJson: JSON.stringify({
          benchmarkTicker: identity.benchmarkTicker,
          tradingDate: cacheRow.tradingDate,
          rsClose,
          rsMa,
          rsAboveMa: asBooleanFlag(cacheRow.rsAboveMa),
          rsNewHigh: asBooleanFlag(cacheRow.rsNewHigh),
          rsNewHighBeforePrice: asBooleanFlag(cacheRow.rsNewHighBeforePrice),
          bullCross: asBooleanFlag(cacheRow.bullCross),
          approxRsRating: cacheRow.approxRsRating,
          relative_volume_10d_calc: row.relativeVolume ?? null,
          latest_volume: latestVolume,
          exchange: row.exchange ?? null,
          type: manualCandidateType(row.assetClass),
        }),
      };
      const filterRow = manualRowToTradingViewRow(snapshotRow, row, latestVolume);
      return rowMatchesRules(filterRow, supportedRules) ? snapshotRow : null;
    })
    .filter((row): row is ScanSnapshotRow => Boolean(row));

  const sortedRows = sortSnapshotRows(mergedRows, preset.sortField, preset.sortDirection).slice(0, preset.rowLimit);
  await env.SCANNER_CACHE_DB.prepare("DELETE FROM rs_scan_rows_latest WHERE preset_id = ?").bind(preset.id).run();
  if (sortedRows.length > 0) {
    await env.SCANNER_CACHE_DB.batch(sortedRows.map((row, index) =>
      env.SCANNER_CACHE_DB.prepare(
        `INSERT INTO rs_scan_rows_latest
          (preset_id, config_key, ticker, rank, name, sector, industry, change_1d, market_cap, relative_volume, price, avg_volume, price_avg_volume, rs_close, rs_ma, rs_above_ma, rs_new_high, rs_new_high_before_price, bull_cross, approx_rs_rating, raw_json, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      ).bind(
        preset.id,
        run.configKey,
        row.ticker,
        index + 1,
        row.name,
        row.sector,
        row.industry,
        row.change1d,
        row.marketCap,
        row.relativeVolume,
        row.price,
        row.avgVolume,
        row.priceAvgVolume,
        row.rsClose,
        row.rsMa,
        row.rsAboveMa ? 1 : 0,
        row.rsNewHigh ? 1 : 0,
        row.rsNewHighBeforePrice ? 1 : 0,
        row.bullCross ? 1 : 0,
        row.approxRsRating,
        row.rawJson,
      )));
  }

  return {
    providerLabel: RS_PROVIDER_LABEL,
    matchedRowCount: mergedRows.length,
    status: sortedRows.length > 0 ? (skippedRuleWarning ? "warning" : "ok") : "empty",
    error: skippedRuleWarning,
    rows: sortedRows,
  };
}

async function listActiveRelativeStrengthPresetsForManualRunConfig(
  env: Env,
  run: ManualRelativeStrengthRunRecord,
  requestedPreset: ScanPreset,
): Promise<ScanPreset[]> {
  const presets = (await listScanPresets(env))
    .filter((preset) => preset.isActive && preset.scanType === "relative-strength")
    .filter((preset) => buildRelativeStrengthConfigIdentity(preset, run.expectedTradingDate).configKey === run.configKey);
  const byId = new Map<string, ScanPreset>();
  byId.set(requestedPreset.id, requestedPreset);
  for (const preset of presets) byId.set(preset.id, preset);
  return Array.from(byId.values());
}

async function completeManualRelativeStrengthRun(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  preset: ScanPreset,
  run: ManualRelativeStrengthRunRecord,
  matchedTickers: number,
): Promise<ScanSnapshot | null> {
  const settings = await loadWorkerScheduleSettings(env);
  const targetPresets = settings.rsSharedConfigSnapshotFanoutEnabled
    ? await listActiveRelativeStrengthPresetsForManualRunConfig(env, run, preset)
    : [preset];
  let selectedSnapshot: ScanSnapshot | null = null;
  let selectedSnapshotId: string | null = null;
  let selectedWarning: string | null = null;
  for (const targetPreset of targetPresets) {
    const result = await buildManualRelativeStrengthSnapshotResult(env, targetPreset, run);
    await upsertSymbolsFromRows(env, result.rows);
    const snapshotId = await storeScanSnapshotResult(env, targetPreset, result);
    if (targetPreset.id === preset.id) {
      selectedSnapshotId = snapshotId;
      selectedWarning = result.error;
      selectedSnapshot = await loadLatestScansSnapshot(env, targetPreset.id);
    }
  }
  await heartbeatManualRelativeStrengthRun(env, run.id, {
    status: "completed",
    processedTickers: run.totalTickers,
    matchedTickers,
    cursorOffset: run.totalTickers,
    warning: selectedWarning,
    latestSnapshotId: selectedSnapshotId,
    durationMs: elapsedMs(run.startedAt ?? run.createdAt) ?? undefined,
    completedAt: new Date().toISOString(),
    releaseLease: true,
  });
  return selectedSnapshot ?? loadLatestScansSnapshot(env, preset.id);
}

function normalizeVcpRunRecord(row: VcpRunRecord): VcpRunRecord {
  return {
    ...row,
    totalTickers: Math.max(0, Math.trunc(Number(row.totalTickers ?? 0))),
    processedTickers: Math.max(0, Math.trunc(Number(row.processedTickers ?? 0))),
    matchedTickers: Math.max(0, Math.trunc(Number(row.matchedTickers ?? 0))),
    cursorOffset: Math.max(0, Math.trunc(Number(row.cursorOffset ?? 0))),
    cacheHitTickers: Math.max(0, Math.trunc(Number(row.cacheHitTickers ?? 0))),
    computedTickers: Math.max(0, Math.trunc(Number(row.computedTickers ?? 0))),
    missingBarsTickers: Math.max(0, Math.trunc(Number(row.missingBarsTickers ?? 0))),
    insufficientHistoryTickers: Math.max(0, Math.trunc(Number(row.insufficientHistoryTickers ?? 0))),
    errorTickers: Math.max(0, Math.trunc(Number(row.errorTickers ?? 0))),
    durationMs: row.durationMs == null ? null : Math.max(0, Math.trunc(Number(row.durationMs))),
  };
}

function mapVcpRunRecordToJob(record: VcpRunRecord): ScanRefreshJob {
  const computedElapsedMs = elapsedMs(record.startedAt ?? record.createdAt);
  return {
    id: record.id,
    presetId: record.presetId,
    presetName: record.presetName,
    jobType: "vcp",
    status: record.status,
    startedAt: record.startedAt ?? record.createdAt,
    updatedAt: record.heartbeatAt ?? record.updatedAt,
    completedAt: record.completedAt,
    error: record.error,
    totalCandidates: record.totalTickers,
    processedCandidates: record.processedTickers,
    matchedCandidates: record.matchedTickers,
    cursorOffset: record.cursorOffset,
    latestSnapshotId: record.latestSnapshotId,
    requestedBy: record.requestedBy,
    configKey: record.configKey,
    sharedRunId: null,
    expectedTradingDate: record.expectedTradingDate,
    fullCandidateCount: record.totalTickers,
    materializationCandidateCount: record.totalTickers,
    alreadyCurrentCandidateCount: 0,
    lastAdvancedAt: record.heartbeatAt ?? record.updatedAt,
    deferredTickerCount: 0,
    warning: record.warning,
    phase: record.status === "completed" || record.status === "failed" ? record.status : "vcp",
    elapsedMs: record.status === "completed" || record.status === "failed" ? record.durationMs ?? computedElapsedMs : computedElapsedMs,
    durationMs: record.durationMs ?? (record.status === "completed" || record.status === "failed" ? computedElapsedMs : null),
    cacheHitCount: record.cacheHitTickers,
    computedCount: record.computedTickers,
    missingBarsCount: record.missingBarsTickers,
    insufficientHistoryCount: record.insufficientHistoryTickers,
    errorCount: record.errorTickers,
    staleBenchmarkCount: 0,
    appliesToPreset: true,
  };
}

async function loadVcpRun(env: Env, runId: string): Promise<VcpRunRecord | null> {
  if (!hasScannerCacheStorage(env)) return null;
  const row = await env.SCANNER_CACHE_DB.prepare(
    `SELECT
       id,
       preset_id as presetId,
       preset_name as presetName,
       config_key as configKey,
       expected_trading_date as expectedTradingDate,
       status,
       requested_by as requestedBy,
       created_at as createdAt,
       started_at as startedAt,
       updated_at as updatedAt,
       heartbeat_at as heartbeatAt,
       completed_at as completedAt,
       error,
       warning,
       total_tickers as totalTickers,
       processed_tickers as processedTickers,
       matched_tickers as matchedTickers,
       cursor_offset as cursorOffset,
       latest_snapshot_id as latestSnapshotId,
       lease_owner as leaseOwner,
       lease_expires_at as leaseExpiresAt,
       cache_hit_tickers as cacheHitTickers,
       computed_tickers as computedTickers,
       missing_bars_tickers as missingBarsTickers,
       insufficient_history_tickers as insufficientHistoryTickers,
       error_tickers as errorTickers,
       duration_ms as durationMs
     FROM vcp_scan_runs
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(runId)
    .first<VcpRunRecord>();
  return row ? normalizeVcpRunRecord(row) : null;
}

async function loadActiveVcpRun(env: Env): Promise<VcpRunRecord | null> {
  if (!hasScannerCacheStorage(env)) return null;
  const row = await env.SCANNER_CACHE_DB.prepare(
    `SELECT
       id,
       preset_id as presetId,
       preset_name as presetName,
       config_key as configKey,
       expected_trading_date as expectedTradingDate,
       status,
       requested_by as requestedBy,
       created_at as createdAt,
       started_at as startedAt,
       updated_at as updatedAt,
       heartbeat_at as heartbeatAt,
       completed_at as completedAt,
       error,
       warning,
       total_tickers as totalTickers,
       processed_tickers as processedTickers,
       matched_tickers as matchedTickers,
       cursor_offset as cursorOffset,
       latest_snapshot_id as latestSnapshotId,
       lease_owner as leaseOwner,
       lease_expires_at as leaseExpiresAt,
       cache_hit_tickers as cacheHitTickers,
       computed_tickers as computedTickers,
       missing_bars_tickers as missingBarsTickers,
       insufficient_history_tickers as insufficientHistoryTickers,
       error_tickers as errorTickers,
       duration_ms as durationMs
     FROM vcp_scan_runs
     WHERE status IN ('queued', 'running')
     ORDER BY datetime(updated_at) DESC
     LIMIT 1`,
  ).first<VcpRunRecord>();
  return row ? normalizeVcpRunRecord(row) : null;
}

async function loadLatestCompletedVcpRunForPreset(
  env: Env,
  presetId: string,
  configKey: string,
  expectedTradingDate: string,
): Promise<VcpRunRecord | null> {
  if (!hasScannerCacheStorage(env)) return null;
  const row = await env.SCANNER_CACHE_DB.prepare(
    `SELECT
       id,
       preset_id as presetId,
       preset_name as presetName,
       config_key as configKey,
       expected_trading_date as expectedTradingDate,
       status,
       requested_by as requestedBy,
       created_at as createdAt,
       started_at as startedAt,
       updated_at as updatedAt,
       heartbeat_at as heartbeatAt,
       completed_at as completedAt,
       error,
       warning,
       total_tickers as totalTickers,
       processed_tickers as processedTickers,
       matched_tickers as matchedTickers,
       cursor_offset as cursorOffset,
       latest_snapshot_id as latestSnapshotId,
       lease_owner as leaseOwner,
       lease_expires_at as leaseExpiresAt,
       cache_hit_tickers as cacheHitTickers,
       computed_tickers as computedTickers,
       missing_bars_tickers as missingBarsTickers,
       insufficient_history_tickers as insufficientHistoryTickers,
       error_tickers as errorTickers,
       duration_ms as durationMs
     FROM vcp_scan_runs
     WHERE preset_id = ?
       AND config_key = ?
       AND expected_trading_date = ?
       AND status = 'completed'
     ORDER BY datetime(completed_at) DESC, datetime(updated_at) DESC
     LIMIT 1`,
  )
    .bind(presetId, configKey, expectedTradingDate)
    .first<VcpRunRecord>();
  return row ? normalizeVcpRunRecord(row) : null;
}

function isVcpRunLeaseActive(run: Pick<VcpRunRecord, "leaseOwner" | "leaseExpiresAt">): boolean {
  if (!run.leaseOwner || !run.leaseExpiresAt) return false;
  const expiresAt = toTimestampMs(run.leaseExpiresAt);
  return expiresAt != null && expiresAt > Date.now();
}

function isVcpRunAbandoned(run: VcpRunRecord): boolean {
  if (!isActiveScanStatus(run.status)) return false;
  if (isVcpRunLeaseActive(run)) return false;
  const updatedAt = toTimestampMs(run.heartbeatAt ?? run.updatedAt);
  return updatedAt != null && Date.now() - updatedAt > VCP_SCAN_STALE_RUN_MS;
}

async function insertVcpRunCandidates(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  runId: string,
  candidates: VcpCandidateRow[],
): Promise<void> {
  for (let index = 0; index < candidates.length; index += RS_JOB_INSERT_CHUNK_SIZE) {
    const chunk = candidates.slice(index, index + RS_JOB_INSERT_CHUNK_SIZE);
    await env.SCANNER_CACHE_DB.batch(chunk.map((row) =>
      env.SCANNER_CACHE_DB.prepare(
        `INSERT INTO vcp_scan_run_tickers
          (run_id, cursor_offset, ticker, name, sector, industry, exchange, asset_class, market_cap, relative_volume, avg_volume, price_avg_volume, price, change_1d, status, reason, latest_trading_date, computed_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, 'computed')`,
      ).bind(
        runId,
        row.cursorOffset,
        row.ticker,
        row.name,
        row.sector,
        row.industry,
        row.exchange,
        row.assetClass,
        row.marketCap,
        row.relativeVolume,
        row.avgVolume,
        row.priceAvgVolume,
        row.price,
        row.change1d,
      )));
  }
}

function snapshotRowToVcpCandidate(row: ScanSnapshotRow, index: number): VcpCandidateRow {
  let exchange: string | null = null;
  let assetClass: string | null = null;
  try {
    const raw = row.rawJson ? JSON.parse(row.rawJson) as Record<string, unknown> : null;
    exchange = typeof raw?.exchange === "string" ? raw.exchange : null;
    assetClass = typeof raw?.type === "string" ? raw.type : null;
  } catch {
    exchange = null;
  }
  return {
    cursorOffset: index,
    ticker: row.ticker.toUpperCase(),
    name: row.name ?? row.ticker.toUpperCase(),
    sector: row.sector ?? null,
    industry: row.industry ?? null,
    exchange,
    assetClass,
    marketCap: row.marketCap ?? null,
    relativeVolume: row.relativeVolume ?? null,
    avgVolume: row.avgVolume ?? null,
    priceAvgVolume: row.priceAvgVolume ?? null,
    price: row.price ?? null,
    change1d: row.change1d ?? null,
    status: "queued",
    reason: null,
    latestTradingDate: null,
    source: "computed",
  };
}

async function createVcpScanRun(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  preset: ScanPreset,
  requestedBy?: string | null,
): Promise<VcpRunRecord> {
  const active = await loadActiveVcpRun(env);
  if (active && !isVcpRunAbandoned(active)) return active;
  if (active) {
    await failVcpRun(env, active.id, "VCP scan run was abandoned and replaced by a new request.");
  }

  const identity = buildVcpConfigIdentity(preset);
  const prefilterRows = await fetchRelativeStrengthPrefilterRows(preset);
  const candidates = prefilterRows
    .slice(0, VCP_SCAN_MAX_UNIVERSE_SIZE)
    .map(snapshotRowToVcpCandidate);
  const runId = crypto.randomUUID();
  try {
    await env.SCANNER_CACHE_DB.prepare(
      `INSERT INTO vcp_scan_runs
        (id, preset_id, preset_name, config_key, expected_trading_date, status, requested_by, total_tickers, processed_tickers, matched_tickers, cursor_offset, created_at, updated_at, warning)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)`,
    )
      .bind(
        runId,
        preset.id,
        preset.name,
        identity.configKey,
        identity.expectedTradingDate,
        requestedBy ?? null,
        candidates.length,
      )
      .run();
    await insertVcpRunCandidates(env, runId, candidates);
  } catch (error) {
    const existing = await loadActiveVcpRun(env);
    if (existing) return existing;
    await env.SCANNER_CACHE_DB.prepare("DELETE FROM vcp_scan_runs WHERE id = ?").bind(runId).run();
    throw error;
  }

  const created = await loadVcpRun(env, runId);
  if (!created) throw new Error("Failed to create VCP scan run.");
  return created;
}

async function loadVcpRunCandidateSlice(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  runId: string,
  cursorOffset: number,
  limit: number,
): Promise<VcpCandidateRow[]> {
  const rows = await env.SCANNER_CACHE_DB.prepare(
    `SELECT
       cursor_offset as cursorOffset,
       ticker,
       name,
       sector,
       industry,
       exchange,
       asset_class as assetClass,
       market_cap as marketCap,
       relative_volume as relativeVolume,
       avg_volume as avgVolume,
       price_avg_volume as priceAvgVolume,
       price,
       change_1d as change1d,
       status,
       reason,
       latest_trading_date as latestTradingDate,
       source
     FROM vcp_scan_run_tickers
     WHERE run_id = ?
     ORDER BY cursor_offset ASC
     LIMIT ? OFFSET ?`,
  )
    .bind(runId, limit, cursorOffset)
    .all<VcpCandidateRow>();
  return (rows.results ?? []).map((row) => ({
    ...row,
    ticker: row.ticker.toUpperCase(),
    marketCap: row.marketCap == null ? null : Number(row.marketCap),
    relativeVolume: row.relativeVolume == null ? null : Number(row.relativeVolume),
    avgVolume: row.avgVolume == null ? null : Number(row.avgVolume),
    priceAvgVolume: row.priceAvgVolume == null ? null : Number(row.priceAvgVolume),
    price: row.price == null ? null : Number(row.price),
    change1d: row.change1d == null ? null : Number(row.change1d),
  }));
}

async function loadVcpFeatureCacheRows(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  configKey: string,
  tickers: string[],
): Promise<Map<string, VcpFeatureCacheRow>> {
  const uniqueTickers = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  const rowsByTicker = new Map<string, VcpFeatureCacheRow>();
  for (let index = 0; index < uniqueTickers.length; index += RS_STORED_BAR_QUERY_CHUNK_SIZE) {
    const chunk = uniqueTickers.slice(index, index + RS_STORED_BAR_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.SCANNER_CACHE_DB.prepare(
      `SELECT
         config_key as configKey,
         ticker,
         expected_trading_date as expectedTradingDate,
         trading_date as tradingDate,
         price_close as priceClose,
         change_1d as change1d,
         sma50,
         sma150,
         sma200,
         daily_pivot as dailyPivot,
         daily_pivot_gap_pct as dailyPivotGapPct,
         weekly_high as weeklyHigh,
         weekly_high_gap_pct as weeklyHighGapPct,
         vol_sma20 as volSma20,
         trend_score as trendScore,
         trend_template as trendTemplate,
         pivot_stable as pivotStable,
         daily_near as dailyNear,
         weekly_near as weeklyNear,
         higher_lows as higherLows,
         volume_contracting as volumeContracting,
         vcp_signal as vcpSignal,
         status,
         reason,
         computed_at as computedAt
       FROM vcp_features_latest
       WHERE config_key = ?
         AND ticker IN (${placeholders})`,
    )
      .bind(configKey, ...chunk)
      .all<VcpFeatureCacheRow>();
    for (const row of rows.results ?? []) {
      rowsByTicker.set(row.ticker.toUpperCase(), {
        ...row,
        ticker: row.ticker.toUpperCase(),
        trendScore: Math.max(0, Math.trunc(Number(row.trendScore ?? 0))),
        trendTemplate: asBooleanFlag(row.trendTemplate),
        pivotStable: asBooleanFlag(row.pivotStable),
        dailyNear: asBooleanFlag(row.dailyNear),
        weeklyNear: asBooleanFlag(row.weeklyNear),
        higherLows: asBooleanFlag(row.higherLows),
        volumeContracting: asBooleanFlag(row.volumeContracting),
        vcpSignal: asBooleanFlag(row.vcpSignal),
      });
    }
  }
  return rowsByTicker;
}

function isReusableVcpFeature(
  row: VcpFeatureCacheRow | undefined,
  identity: VcpConfigIdentity,
  invalidatedAfterMs: number | null,
): row is VcpFeatureCacheRow {
  if (!row) return false;
  const expectedTradingDate = row.expectedTradingDate ?? row.tradingDate;
  if (expectedTradingDate !== identity.expectedTradingDate) return false;
  const computedAtMs = toTimestampMs(row.computedAt);
  if (invalidatedAfterMs != null && computedAtMs != null && computedAtMs < invalidatedAfterMs) return false;
  if (row.status === "computed") return row.tradingDate === identity.expectedTradingDate;
  return row.status === "missing_bars" || row.status === "insufficient_history";
}

function cachedVcpResult(
  candidate: VcpCandidateRow,
  feature: VcpFeatureCacheRow,
): {
  candidate: VcpCandidateRow;
  status: VcpTickerStatus;
  reason: string | null;
  latestTradingDate: string | null;
  price: number | null;
  change1d: number | null;
  avgVolume: number | null;
  relativeVolume: number | null;
  priceAvgVolume: number | null;
  feature: VcpFeatureRow | null;
  source: "cache";
} {
  const price = feature.priceClose ?? candidate.price ?? null;
  const avgVolume = candidate.avgVolume ?? null;
  return {
    candidate,
    status: feature.status as VcpTickerStatus,
    reason: feature.reason ?? null,
    latestTradingDate: feature.tradingDate ?? candidate.latestTradingDate ?? null,
    price,
    change1d: feature.change1d ?? candidate.change1d ?? null,
    avgVolume,
    relativeVolume: candidate.relativeVolume ?? null,
    priceAvgVolume: price != null && avgVolume != null ? price * avgVolume : candidate.priceAvgVolume ?? null,
    feature,
    source: "cache",
  };
}

function countVcpBatchStatus(
  results: Array<{ status: VcpTickerStatus; source: "cache" | "computed" }>,
): Pick<VcpRunRecord, "cacheHitTickers" | "computedTickers" | "missingBarsTickers" | "insufficientHistoryTickers" | "errorTickers"> {
  return {
    cacheHitTickers: results.filter((result) => result.source === "cache").length,
    computedTickers: results.filter((result) => result.source === "computed" && result.status === "computed").length,
    missingBarsTickers: results.filter((result) => result.status === "missing_bars").length,
    insufficientHistoryTickers: results.filter((result) => result.status === "insufficient_history").length,
    errorTickers: results.filter((result) => result.status === "error").length,
  };
}

async function upsertVcpBatchResults(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  run: VcpRunRecord,
  results: Array<{
    candidate: VcpCandidateRow;
    status: VcpTickerStatus;
    reason: string | null;
    latestTradingDate: string | null;
    price: number | null;
    change1d: number | null;
    avgVolume: number | null;
    relativeVolume: number | null;
    priceAvgVolume: number | null;
    feature: VcpFeatureRow | null;
    source: "cache" | "computed";
  }>,
): Promise<number> {
  let matchedSignalCount = 0;
  for (let index = 0; index < results.length; index += RS_JOB_INSERT_CHUNK_SIZE) {
    const chunk = results.slice(index, index + RS_JOB_INSERT_CHUNK_SIZE);
    const batchStatements = chunk.flatMap((result) => {
      if (result.status === "computed" && result.feature?.vcpSignal) matchedSignalCount += 1;
      const feature = result.feature;
      const rowStatements = [
        env.SCANNER_CACHE_DB.prepare(
          `UPDATE vcp_scan_run_tickers
           SET status = ?,
               reason = ?,
               latest_trading_date = ?,
               price = ?,
               change_1d = ?,
               avg_volume = ?,
               relative_volume = ?,
               price_avg_volume = ?,
               computed_at = CURRENT_TIMESTAMP,
               source = ?
           WHERE run_id = ?
             AND ticker = ?`,
        ).bind(
          result.status,
          result.reason,
          result.latestTradingDate,
          result.price,
          result.change1d,
          result.avgVolume,
          result.relativeVolume,
          result.priceAvgVolume,
          result.source,
          run.id,
          result.candidate.ticker,
        ),
      ];
      if (result.source === "cache") return rowStatements;
      rowStatements.push(
        env.SCANNER_CACHE_DB.prepare(
          `INSERT INTO vcp_features_latest
            (config_key, ticker, expected_trading_date, trading_date, price_close, change_1d, sma50, sma150, sma200, daily_pivot, daily_pivot_gap_pct, weekly_high, weekly_high_gap_pct, vol_sma20, trend_score, trend_template, pivot_stable, daily_near, weekly_near, higher_lows, volume_contracting, vcp_signal, status, reason, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(config_key, ticker) DO UPDATE SET
             expected_trading_date = excluded.expected_trading_date,
             trading_date = excluded.trading_date,
             price_close = excluded.price_close,
             change_1d = excluded.change_1d,
             sma50 = excluded.sma50,
             sma150 = excluded.sma150,
             sma200 = excluded.sma200,
             daily_pivot = excluded.daily_pivot,
             daily_pivot_gap_pct = excluded.daily_pivot_gap_pct,
             weekly_high = excluded.weekly_high,
             weekly_high_gap_pct = excluded.weekly_high_gap_pct,
             vol_sma20 = excluded.vol_sma20,
             trend_score = excluded.trend_score,
             trend_template = excluded.trend_template,
             pivot_stable = excluded.pivot_stable,
             daily_near = excluded.daily_near,
             weekly_near = excluded.weekly_near,
             higher_lows = excluded.higher_lows,
             volume_contracting = excluded.volume_contracting,
             vcp_signal = excluded.vcp_signal,
             status = excluded.status,
             reason = excluded.reason,
             computed_at = CURRENT_TIMESTAMP`,
        ).bind(
          run.configKey,
          result.candidate.ticker,
          run.expectedTradingDate,
          feature?.tradingDate ?? result.latestTradingDate,
          feature?.priceClose ?? result.price,
          feature?.change1d ?? result.change1d,
          feature?.sma50 ?? null,
          feature?.sma150 ?? null,
          feature?.sma200 ?? null,
          feature?.dailyPivot ?? null,
          feature?.dailyPivotGapPct ?? null,
          feature?.weeklyHigh ?? null,
          feature?.weeklyHighGapPct ?? null,
          feature?.volSma20 ?? null,
          feature?.trendScore ?? 0,
          feature?.trendTemplate ? 1 : 0,
          feature?.pivotStable ? 1 : 0,
          feature?.dailyNear ? 1 : 0,
          feature?.weeklyNear ? 1 : 0,
          feature?.higherLows ? 1 : 0,
          feature?.volumeContracting ? 1 : 0,
          feature?.vcpSignal ? 1 : 0,
          result.status,
          result.reason,
        ),
      );
      return rowStatements;
    });
    await env.SCANNER_CACHE_DB.batch(batchStatements);
  }
  return matchedSignalCount;
}

async function heartbeatVcpRun(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  runId: string,
  updates: Partial<Pick<VcpRunRecord, "status" | "processedTickers" | "matchedTickers" | "cursorOffset" | "warning" | "latestSnapshotId" | "cacheHitTickers" | "computedTickers" | "missingBarsTickers" | "insufficientHistoryTickers" | "errorTickers" | "durationMs">> & { completedAt?: string | null; error?: string | null; releaseLease?: boolean },
): Promise<void> {
  const fields = ["updated_at = CURRENT_TIMESTAMP", "heartbeat_at = CURRENT_TIMESTAMP"];
  const values: unknown[] = [];
  if (updates.status != null) {
    fields.push("status = ?");
    values.push(updates.status);
  }
  if (updates.processedTickers != null) {
    fields.push("processed_tickers = ?");
    values.push(updates.processedTickers);
  }
  if (updates.matchedTickers != null) {
    fields.push("matched_tickers = ?");
    values.push(updates.matchedTickers);
  }
  if (updates.cursorOffset != null) {
    fields.push("cursor_offset = ?");
    values.push(updates.cursorOffset);
  }
  if (updates.cacheHitTickers != null) {
    fields.push("cache_hit_tickers = ?");
    values.push(updates.cacheHitTickers);
  }
  if (updates.computedTickers != null) {
    fields.push("computed_tickers = ?");
    values.push(updates.computedTickers);
  }
  if (updates.missingBarsTickers != null) {
    fields.push("missing_bars_tickers = ?");
    values.push(updates.missingBarsTickers);
  }
  if (updates.insufficientHistoryTickers != null) {
    fields.push("insufficient_history_tickers = ?");
    values.push(updates.insufficientHistoryTickers);
  }
  if (updates.errorTickers != null) {
    fields.push("error_tickers = ?");
    values.push(updates.errorTickers);
  }
  if (updates.durationMs != null) {
    fields.push("duration_ms = ?");
    values.push(updates.durationMs);
  }
  if (updates.warning !== undefined) {
    fields.push("warning = ?");
    values.push(updates.warning);
  }
  if (updates.error !== undefined) {
    fields.push("error = ?");
    values.push(updates.error);
  }
  if (updates.latestSnapshotId !== undefined) {
    fields.push("latest_snapshot_id = ?");
    values.push(updates.latestSnapshotId);
  }
  if (updates.completedAt !== undefined) {
    fields.push("completed_at = ?");
    values.push(updates.completedAt);
  }
  if (updates.releaseLease) {
    fields.push("lease_owner = NULL", "lease_expires_at = NULL");
  }
  await env.SCANNER_CACHE_DB.prepare(`UPDATE vcp_scan_runs SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values, runId)
    .run();
}

async function failVcpRun(env: Env & { SCANNER_CACHE_DB: D1Database }, runId: string, message: string): Promise<void> {
  await heartbeatVcpRun(env, runId, {
    status: "failed",
    error: message,
    completedAt: new Date().toISOString(),
    releaseLease: true,
  });
}

async function acquireVcpRunLease(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  run: VcpRunRecord,
): Promise<VcpRunRecord | null> {
  if (isVcpRunLeaseActive(run)) return null;
  const leaseOwner = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + VCP_SCAN_LEASE_DURATION_MS).toISOString();
  await env.SCANNER_CACHE_DB.prepare(
    `UPDATE vcp_scan_runs
     SET status = 'running',
         started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP,
         heartbeat_at = CURRENT_TIMESTAMP,
         lease_owner = ?,
         lease_expires_at = ?
     WHERE id = ?
       AND status IN ('queued', 'running')`,
  )
    .bind(leaseOwner, leaseExpiresAt, run.id)
    .run();
  const leased = await loadVcpRun(env, run.id);
  return leased?.leaseOwner === leaseOwner ? leased : null;
}

function vcpRowToTradingViewRow(
  row: ScanSnapshotRow,
  candidate: VcpCandidateRow,
  latestVolume: number | null,
): TradingViewScanRow {
  const raw = row.rawJson ? JSON.parse(row.rawJson) as Record<string, unknown> : {};
  return {
    ticker: row.ticker,
    name: row.name,
    sector: row.sector,
    industry: row.industry,
    change1d: row.change1d,
    marketCap: row.marketCap,
    relativeVolume: row.relativeVolume,
    price: row.price,
    avgVolume: row.avgVolume,
    priceAvgVolume: row.priceAvgVolume,
    volume: latestVolume,
    exchange: candidate.exchange,
    type: manualCandidateType(candidate.assetClass),
    raw,
  };
}

async function buildVcpSnapshotResult(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  preset: ScanPreset,
  run: VcpRunRecord,
): Promise<{
  providerLabel: string;
  matchedRowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
  rows: ScanSnapshotRow[];
}> {
  const rows = await env.SCANNER_CACHE_DB.prepare(
    `SELECT
       t.cursor_offset as cursorOffset,
       t.ticker,
       t.name,
       t.sector,
       t.industry,
       t.exchange,
       t.asset_class as assetClass,
       t.market_cap as marketCap,
       t.relative_volume as relativeVolume,
       t.avg_volume as avgVolume,
       t.price_avg_volume as priceAvgVolume,
       t.price,
       t.change_1d as change1d,
       t.status,
       t.reason,
       t.latest_trading_date as latestTradingDate,
       t.source,
       f.expected_trading_date as expectedTradingDate,
       f.trading_date as tradingDate,
       f.price_close as priceClose,
       f.change_1d as featureChange1d,
       f.sma50,
       f.sma150,
       f.sma200,
       f.daily_pivot as dailyPivot,
       f.daily_pivot_gap_pct as dailyPivotGapPct,
       f.weekly_high as weeklyHigh,
       f.weekly_high_gap_pct as weeklyHighGapPct,
       f.vol_sma20 as volSma20,
       f.trend_score as trendScore,
       f.trend_template as trendTemplate,
       f.pivot_stable as pivotStable,
       f.daily_near as dailyNear,
       f.weekly_near as weeklyNear,
       f.higher_lows as higherLows,
       f.volume_contracting as volumeContracting,
       f.vcp_signal as vcpSignal,
       f.computed_at as computedAt
     FROM vcp_scan_run_tickers t
     JOIN vcp_features_latest f
       ON f.config_key = ?
      AND f.ticker = t.ticker
     WHERE t.run_id = ?
       AND f.status = 'computed'
     ORDER BY t.cursor_offset ASC`,
  )
    .bind(run.configKey, run.id)
    .all<VcpCandidateRow & VcpFeatureCacheRow & { featureChange1d: number | null }>();

  const supportedRules = preset.rules.filter(manualRuleFieldSupported);
  const skippedRuleWarning = manualRulesWarning(preset);
  const mergedRows = (rows.results ?? [])
    .map((row) => {
      const vcpSignal = asBooleanFlag(row.vcpSignal);
      if (!vcpSignal) return null;
      const latestVolume = row.avgVolume != null && row.relativeVolume != null ? row.avgVolume * row.relativeVolume : null;
      const snapshotRow: ScanSnapshotRow = {
        ticker: row.ticker.toUpperCase(),
        name: row.name ?? row.ticker.toUpperCase(),
        sector: row.sector ?? null,
        industry: row.industry ?? null,
        change1d: row.featureChange1d ?? row.change1d,
        marketCap: row.marketCap ?? null,
        relativeVolume: row.relativeVolume ?? null,
        price: row.priceClose ?? row.price,
        avgVolume: row.avgVolume ?? null,
        priceAvgVolume: row.priceAvgVolume ?? null,
        rsClose: null,
        rsMa: null,
        rsAboveMa: false,
        rsNewHigh: false,
        rsNewHighBeforePrice: false,
        bullCross: false,
        approxRsRating: null,
        rawJson: JSON.stringify({
          scannerType: "vcp",
          tradingDate: row.tradingDate,
          trading_date: row.tradingDate,
          vcpSignal,
          vcp_signal: vcpSignal,
          trendScore: row.trendScore,
          trend_score: row.trendScore,
          trendTemplate: asBooleanFlag(row.trendTemplate),
          trend_template: asBooleanFlag(row.trendTemplate),
          pivotStable: asBooleanFlag(row.pivotStable),
          pivot_stable: asBooleanFlag(row.pivotStable),
          dailyNear: asBooleanFlag(row.dailyNear),
          daily_near: asBooleanFlag(row.dailyNear),
          weeklyNear: asBooleanFlag(row.weeklyNear),
          weekly_near: asBooleanFlag(row.weeklyNear),
          higherLows: asBooleanFlag(row.higherLows),
          higher_lows: asBooleanFlag(row.higherLows),
          volumeContracting: asBooleanFlag(row.volumeContracting),
          volume_contracting: asBooleanFlag(row.volumeContracting),
          sma50: row.sma50,
          sma150: row.sma150,
          sma200: row.sma200,
          dailyPivot: row.dailyPivot,
          daily_pivot: row.dailyPivot,
          dailyPivotGapPct: row.dailyPivotGapPct,
          daily_pivot_gap_pct: row.dailyPivotGapPct,
          weeklyHigh: row.weeklyHigh,
          weekly_high: row.weeklyHigh,
          weeklyHighGapPct: row.weeklyHighGapPct,
          weekly_high_gap_pct: row.weeklyHighGapPct,
          volSma20: row.volSma20,
          vol_sma20: row.volSma20,
          relative_volume_10d_calc: row.relativeVolume ?? null,
          latest_volume: latestVolume,
          exchange: row.exchange ?? null,
          type: manualCandidateType(row.assetClass),
        }),
      };
      const filterRow = vcpRowToTradingViewRow(snapshotRow, row, latestVolume);
      return rowMatchesRules(filterRow, supportedRules) ? snapshotRow : null;
    })
    .filter((row): row is ScanSnapshotRow => Boolean(row));

  const sortedRows = sortSnapshotRows(mergedRows, preset.sortField, preset.sortDirection).slice(0, preset.rowLimit);
  return {
    providerLabel: VCP_PROVIDER_LABEL,
    matchedRowCount: mergedRows.length,
    status: sortedRows.length > 0 ? (skippedRuleWarning ? "warning" : "ok") : "empty",
    error: skippedRuleWarning,
    rows: sortedRows,
  };
}

async function completeVcpRun(
  env: Env & { SCANNER_CACHE_DB: D1Database },
  preset: ScanPreset,
  run: VcpRunRecord,
  matchedTickers: number,
): Promise<ScanSnapshot | null> {
  const result = await buildVcpSnapshotResult(env, preset, run);
  await upsertSymbolsFromRows(env, result.rows);
  const snapshotId = await storeScanSnapshotResult(env, preset, result);
  const snapshot = await loadLatestScansSnapshot(env, preset.id);
  await heartbeatVcpRun(env, run.id, {
    status: "completed",
    processedTickers: run.totalTickers,
    matchedTickers,
    cursorOffset: run.totalTickers,
    warning: result.error,
    latestSnapshotId: snapshotId,
    durationMs: elapsedMs(run.startedAt ?? run.createdAt) ?? undefined,
    completedAt: new Date().toISOString(),
    releaseLease: true,
  });
  return snapshot;
}

export async function processVcpScanRun(
  env: Env,
  runId?: string | null,
  options?: { timeBudgetMs?: number; batchSize?: number },
): Promise<ScanRefreshJob | null> {
  if (!hasScannerCacheStorage(env)) return null;
  const initialRun = runId ? await loadVcpRun(env, runId) : await loadActiveVcpRun(env);
  if (!initialRun || !isActiveScanStatus(initialRun.status)) return initialRun ? mapVcpRunRecordToJob(initialRun) : null;
  const leasedRun = await acquireVcpRunLease(env, initialRun);
  if (!leasedRun) return mapVcpRunRecordToJob(initialRun);

  const preset = await loadScanPreset(env, leasedRun.presetId);
  if (!preset || preset.scanType !== "vcp") {
    await failVcpRun(env, leasedRun.id, "VCP scan preset no longer exists.");
    const failed = await loadVcpRun(env, leasedRun.id);
    return failed ? mapVcpRunRecordToJob(failed) : null;
  }

  const startedAt = Date.now();
  const timeBudgetMs = Math.max(1_000, options?.timeBudgetMs ?? VCP_SCAN_TIME_BUDGET_MS);
  const batchSize = Math.max(1, Math.trunc(options?.batchSize ?? VCP_SCAN_BATCH_SIZE));
  const identity = buildVcpConfigIdentity(preset, leasedRun.expectedTradingDate);
  const cacheInvalidatedAfterMs = await loadLatestCompletedPostCloseDailyBarRefreshAt(env, identity.expectedTradingDate);

  let cursorOffset = leasedRun.cursorOffset;
  let processedTickers = leasedRun.processedTickers;
  let matchedTickers = leasedRun.matchedTickers;
  let cacheHitTickers = leasedRun.cacheHitTickers;
  let computedTickers = leasedRun.computedTickers;
  let missingBarsTickers = leasedRun.missingBarsTickers;
  let insufficientHistoryTickers = leasedRun.insufficientHistoryTickers;
  let errorTickers = leasedRun.errorTickers;

  while (cursorOffset < leasedRun.totalTickers && Date.now() - startedAt < timeBudgetMs) {
    const candidates = await loadVcpRunCandidateSlice(env, leasedRun.id, cursorOffset, batchSize);
    if (candidates.length === 0) break;
    const tickers = candidates.map((candidate) => candidate.ticker);
    const cachedResults: Array<ReturnType<typeof cachedVcpResult>> = [];
    const cacheRowsByTicker = await loadVcpFeatureCacheRows(env, identity.configKey, tickers);
    const computeCandidates: VcpCandidateRow[] = [];
    for (const candidate of candidates) {
      const cached = cacheRowsByTicker.get(candidate.ticker);
      if (isReusableVcpFeature(cached, identity, cacheInvalidatedAfterMs)) {
        cachedResults.push(cachedVcpResult(candidate, cached));
      } else {
        computeCandidates.push(candidate);
      }
    }

    if (computeCandidates.length > 0) {
      await ensureStoredDailyBarsCurrent(
        env,
        computeCandidates.map((candidate) => candidate.ticker),
        identity.expectedTradingDate,
        identity.requiredBarCount,
      );
    }

    const barsByTicker = groupBarsByTicker(
      computeCandidates.length > 0
        ? await loadStoredDailyBarsByCount(
          env,
          computeCandidates.map((candidate) => candidate.ticker),
          identity.expectedTradingDate,
          identity.requiredBarCount,
        )
        : [],
    );

    const computedResults = computeCandidates.map((candidate) => {
      try {
        const tickerBars = barsByTicker.get(candidate.ticker) ?? [];
        const latestTickerDate = latestBarDate(tickerBars);
        const latest = tickerBars[tickerBars.length - 1] ?? null;
        const previous = tickerBars.length > 1 ? tickerBars[tickerBars.length - 2] : null;
        const avgVolume = averageVolume(tickerBars, 30);
        const latestVolume = latest == null ? null : Number((latest as { volume?: number }).volume ?? 0);
        const relativeVolume = avgVolume != null && latestVolume != null && avgVolume > 0 ? latestVolume / avgVolume : null;
        const priceAvgVolume = latest?.c != null && avgVolume != null ? latest.c * avgVolume : null;
        const change1d = latest && previous ? percentChange(latest.c, previous.c) : null;
        if (tickerBars.length === 0) {
          return {
            candidate,
            status: "missing_bars" as const,
            reason: "No stored daily bars are available for this ticker.",
            latestTradingDate: null,
            price: null,
            change1d: null,
            avgVolume,
            relativeVolume,
            priceAvgVolume,
            feature: null,
            source: "computed" as const,
          };
        }
        if (latestTickerDate !== identity.expectedTradingDate) {
          return {
            candidate,
            status: "missing_bars" as const,
            reason: `Latest stored bar is ${latestTickerDate ?? "none"}; expected ${identity.expectedTradingDate}.`,
            latestTradingDate: latestTickerDate,
            price: latest?.c ?? null,
            change1d,
            avgVolume,
            relativeVolume,
            priceAvgVolume,
            feature: null,
            source: "computed" as const,
          };
        }
        if (tickerBars.length < identity.requiredBarCount) {
          return {
            candidate,
            status: "insufficient_history" as const,
            reason: `Only ${tickerBars.length} stored bars are available; ${identity.requiredBarCount} are required for this VCP config.`,
            latestTradingDate: latestTickerDate,
            price: latest?.c ?? null,
            change1d,
            avgVolume,
            relativeVolume,
            priceAvgVolume,
            feature: null,
            source: "computed" as const,
          };
        }
        const computed = buildVcpFeatureRow(tickerBars, identity.config);
        if (!computed || computed.tradingDate !== identity.expectedTradingDate) {
          return {
            candidate,
            status: "missing_bars" as const,
            reason: "VCP features could not be computed through the expected session.",
            latestTradingDate: computed?.tradingDate ?? latestTickerDate,
            price: latest?.c ?? null,
            change1d,
            avgVolume,
            relativeVolume,
            priceAvgVolume,
            feature: null,
            source: "computed" as const,
          };
        }
        return {
          candidate,
          status: "computed" as const,
          reason: null,
          latestTradingDate: computed.tradingDate,
          price: computed.priceClose,
          change1d: computed.change1d,
          avgVolume,
          relativeVolume,
          priceAvgVolume,
          feature: computed,
          source: "computed" as const,
        };
      } catch (error) {
        return {
          candidate,
          status: "error" as const,
          reason: error instanceof Error ? error.message : "Failed to compute VCP features for this ticker.",
          latestTradingDate: null,
          price: null,
          change1d: null,
          avgVolume: null,
          relativeVolume: null,
          priceAvgVolume: null,
          feature: null,
          source: "computed" as const,
        };
      }
    });

    const batchResults = [...cachedResults, ...computedResults];
    matchedTickers += await upsertVcpBatchResults(env, leasedRun, batchResults);
    const batchCounts = countVcpBatchStatus(batchResults);
    cacheHitTickers += batchCounts.cacheHitTickers;
    computedTickers += batchCounts.computedTickers;
    missingBarsTickers += batchCounts.missingBarsTickers;
    insufficientHistoryTickers += batchCounts.insufficientHistoryTickers;
    errorTickers += batchCounts.errorTickers;
    cursorOffset += candidates.length;
    processedTickers = cursorOffset;
    await heartbeatVcpRun(env, leasedRun.id, {
      status: "running",
      processedTickers,
      matchedTickers,
      cursorOffset,
      cacheHitTickers,
      computedTickers,
      missingBarsTickers,
      insufficientHistoryTickers,
      errorTickers,
    });
  }

  const refreshedRun = await loadVcpRun(env, leasedRun.id);
  if (!refreshedRun) return null;
  if (refreshedRun.cursorOffset >= refreshedRun.totalTickers) {
    const snapshot = await completeVcpRun(env, preset, refreshedRun, matchedTickers);
    const completed = await loadVcpRun(env, leasedRun.id);
    return completed ? mapVcpRunRecordToJob(completed) : (snapshot ? null : mapVcpRunRecordToJob(refreshedRun));
  }

  await heartbeatVcpRun(env, leasedRun.id, { releaseLease: true });
  const latest = await loadVcpRun(env, leasedRun.id);
  return latest ? mapVcpRunRecordToJob(latest) : null;
}

export async function processScannerCacheScanRun(
  env: Env,
  runId?: string | null,
  options?: { timeBudgetMs?: number; batchSize?: number },
): Promise<ScanRefreshJob | null> {
  if (!hasScannerCacheStorage(env)) return null;
  if (runId) {
    const vcpRun = await loadVcpRun(env, runId);
    if (vcpRun) return processVcpScanRun(env, runId, options);
    return processManualRelativeStrengthScanRun(env, runId, options);
  }
  const vcpRun = await loadActiveVcpRun(env);
  if (vcpRun) return processVcpScanRun(env, vcpRun.id, options);
  return processManualRelativeStrengthScanRun(env, null, options);
}

export async function processManualRelativeStrengthScanRun(
  env: Env,
  runId?: string | null,
  options?: { timeBudgetMs?: number; batchSize?: number },
): Promise<ScanRefreshJob | null> {
  if (!hasScannerCacheStorage(env)) return null;
  const initialRun = runId ? await loadManualRelativeStrengthRun(env, runId) : await loadActiveManualRelativeStrengthRun(env);
  if (!initialRun || !isActiveScanStatus(initialRun.status)) return initialRun ? mapManualRunRecordToJob(initialRun) : null;
  const leasedRun = await acquireManualRelativeStrengthRunLease(env, initialRun);
  if (!leasedRun) return mapManualRunRecordToJob(initialRun);

  const preset = await loadScanPreset(env, leasedRun.presetId);
  if (!preset) {
    await failManualRelativeStrengthRun(env, leasedRun.id, "Scan preset no longer exists.");
    const failed = await loadManualRelativeStrengthRun(env, leasedRun.id);
    return failed ? mapManualRunRecordToJob(failed) : null;
  }

  const startedAt = Date.now();
  const timeBudgetMs = Math.max(1_000, options?.timeBudgetMs ?? MANUAL_RS_SCAN_TIME_BUDGET_MS);
  const batchSize = Math.max(1, Math.trunc(options?.batchSize ?? MANUAL_RS_SCAN_BATCH_SIZE));
  const identity = buildRelativeStrengthConfigIdentity(preset, leasedRun.expectedTradingDate);
  const benchmarkBars = await loadStoredDailyBarsByCount(env, [identity.benchmarkDataTicker], identity.expectedTradingDate, identity.requiredBarCount);
  const benchmarkLatestDate = latestBarDate(benchmarkBars);
  if (benchmarkLatestDate !== identity.expectedTradingDate) {
    const message = `Benchmark ${identity.benchmarkTicker} is missing bars for ${identity.expectedTradingDate}. Latest stored bar is ${benchmarkLatestDate ?? "none"}.`;
    await heartbeatManualRelativeStrengthRun(env, leasedRun.id, {
      staleBenchmarkTickers: leasedRun.totalTickers,
      durationMs: elapsedMs(leasedRun.startedAt ?? leasedRun.createdAt) ?? undefined,
    });
    await failManualRelativeStrengthRun(env, leasedRun.id, message);
    const failed = await loadManualRelativeStrengthRun(env, leasedRun.id);
    return failed ? mapManualRunRecordToJob(failed) : null;
  }

  let cursorOffset = leasedRun.cursorOffset;
  let processedTickers = leasedRun.processedTickers;
  let matchedTickers = leasedRun.matchedTickers;
  let cacheHitTickers = leasedRun.cacheHitTickers;
  let computedTickers = leasedRun.computedTickers;
  let missingBarsTickers = leasedRun.missingBarsTickers;
  let insufficientHistoryTickers = leasedRun.insufficientHistoryTickers;
  let errorTickers = leasedRun.errorTickers;
  let staleBenchmarkTickers = leasedRun.staleBenchmarkTickers;
  const config = rawRelativeStrengthConfig(identity);
  const settings = await loadWorkerScheduleSettings(env);
  const cacheReuseEnabled = settings.rsManualCacheReuseEnabled;
  const cacheInvalidatedAfterMs = cacheReuseEnabled
    ? await loadLatestCompletedPostCloseDailyBarRefreshAt(env, identity.expectedTradingDate)
    : null;

  while (cursorOffset < leasedRun.totalTickers && Date.now() - startedAt < timeBudgetMs) {
    const candidates = await loadManualRelativeStrengthRunCandidateSlice(env, leasedRun.id, cursorOffset, batchSize);
    if (candidates.length === 0) break;
    const tickers = candidates.map((candidate) => candidate.ticker);
    const cachedResults: Array<ReturnType<typeof cachedManualRelativeStrengthResult>> = [];
    let computeCandidates = candidates;
    if (cacheReuseEnabled) {
      const cacheRowsByTicker = await loadManualRelativeStrengthFeatureCacheRows(env, identity.configKey, tickers);
      computeCandidates = [];
      for (const candidate of candidates) {
        const cached = cacheRowsByTicker.get(candidate.ticker);
        if (isReusableManualRelativeStrengthFeature(cached, identity, cacheInvalidatedAfterMs)) {
          cachedResults.push(cachedManualRelativeStrengthResult(candidate, cached));
        } else {
          computeCandidates.push(candidate);
        }
      }
    }
    const barsByTicker = groupBarsByTicker(
      computeCandidates.length > 0
        ? await loadStoredDailyBarsByCount(env, computeCandidates.map((candidate) => candidate.ticker), identity.expectedTradingDate, identity.requiredBarCount)
        : [],
    );
    const computedResults = computeCandidates.map((candidate) => {
      try {
        const tickerBars = barsByTicker.get(candidate.ticker) ?? [];
        const latestTickerDate = latestBarDate(tickerBars);
        const latest = tickerBars[tickerBars.length - 1] ?? null;
        const previous = tickerBars.length > 1 ? tickerBars[tickerBars.length - 2] : null;
        const avgVolume = averageVolume(tickerBars, 30);
        const latestVolume = latest == null ? null : Number((latest as { volume?: number }).volume ?? 0);
        const relativeVolume = avgVolume != null && latestVolume != null && avgVolume > 0 ? latestVolume / avgVolume : null;
        const priceAvgVolume = latest?.c != null && avgVolume != null ? latest.c * avgVolume : null;
        const change1d = latest && previous ? percentChange(latest.c, previous.c) : null;
        if (tickerBars.length === 0) {
          return {
            candidate,
            status: "missing_bars" as const,
            reason: "No stored daily bars are available for this ticker.",
            latestTradingDate: null,
            price: null,
            change1d: null,
            avgVolume,
            relativeVolume,
            priceAvgVolume,
            feature: null,
            source: "computed" as const,
          };
        }
        if (latestTickerDate !== identity.expectedTradingDate) {
          return {
            candidate,
            status: "missing_bars" as const,
            reason: `Latest stored bar is ${latestTickerDate ?? "none"}; expected ${identity.expectedTradingDate}.`,
            latestTradingDate: latestTickerDate,
            price: latest?.c ?? null,
            change1d,
            avgVolume,
            relativeVolume,
            priceAvgVolume,
            feature: null,
            source: "computed" as const,
          };
        }
        if (tickerBars.length < Math.max(identity.rsMaLength, Math.min(identity.newHighLookback, identity.requiredBarCount))) {
          return {
            candidate,
            status: "insufficient_history" as const,
            reason: `Only ${tickerBars.length} stored bars are available; ${identity.requiredBarCount} are preferred for this RS config.`,
            latestTradingDate: latestTickerDate,
            price: latest?.c ?? null,
            change1d,
            avgVolume,
            relativeVolume,
            priceAvgVolume,
            feature: null,
            source: "computed" as const,
          };
        }
        const computedRows = buildRelativeStrengthCacheRows(tickerBars, benchmarkBars, config);
        const computed = computedRows[computedRows.length - 1] ?? null;
        if (!computed || computed.tradingDate !== identity.expectedTradingDate) {
          return {
            candidate,
            status: "missing_bars" as const,
            reason: "Ticker and benchmark bars could not be aligned through the expected session.",
            latestTradingDate: computed?.tradingDate ?? latestTickerDate,
            price: latest?.c ?? null,
            change1d,
            avgVolume,
            relativeVolume,
            priceAvgVolume,
            feature: null,
            source: "computed" as const,
          };
        }
        return {
          candidate,
          status: "computed" as const,
          reason: null,
          latestTradingDate: computed.tradingDate,
          price: computed.priceClose,
          change1d: computed.change1d,
          avgVolume,
          relativeVolume,
          priceAvgVolume,
          feature: {
            ticker: computed.ticker,
            benchmarkTicker: computed.benchmarkTicker,
            rsMaType: identity.rsMaType,
            rsMaLength: identity.rsMaLength,
            newHighLookback: identity.newHighLookback,
            tradingDate: computed.tradingDate,
            priceClose: computed.priceClose,
            change1d: computed.change1d,
            rsRatioClose: computed.rsClose,
            rsRatioMa: computed.rsMa,
            rsAboveMa: computed.rsAboveMa,
            rsNewHigh: computed.rsNewHigh,
            rsNewHighBeforePrice: computed.rsNewHighBeforePrice,
            bullCross: computed.bullCross,
            approxRsRating: computed.approxRsRating,
          },
          source: "computed" as const,
        };
      } catch (error) {
        return {
          candidate,
          status: "error" as const,
          reason: error instanceof Error ? error.message : "Failed to compute relative strength for this ticker.",
          latestTradingDate: null,
          price: null,
          change1d: null,
          avgVolume: null,
          relativeVolume: null,
          priceAvgVolume: null,
          feature: null,
          source: "computed" as const,
        };
      }
    });
    const batchResults = [...cachedResults, ...computedResults];
    matchedTickers += await upsertManualRelativeStrengthBatchResults(env, leasedRun, batchResults);
    const batchCounts = countManualRelativeStrengthBatchStatus(batchResults);
    cacheHitTickers += batchCounts.cacheHitTickers;
    computedTickers += batchCounts.computedTickers;
    missingBarsTickers += batchCounts.missingBarsTickers;
    insufficientHistoryTickers += batchCounts.insufficientHistoryTickers;
    errorTickers += batchCounts.errorTickers;
    staleBenchmarkTickers += batchCounts.staleBenchmarkTickers;
    cursorOffset += candidates.length;
    processedTickers = cursorOffset;
    await heartbeatManualRelativeStrengthRun(env, leasedRun.id, {
      status: "running",
      processedTickers,
      matchedTickers,
      cursorOffset,
      cacheHitTickers,
      computedTickers,
      missingBarsTickers,
      insufficientHistoryTickers,
      errorTickers,
      staleBenchmarkTickers,
    });
  }

  const refreshedRun = await loadManualRelativeStrengthRun(env, leasedRun.id);
  if (!refreshedRun) return null;
  if (refreshedRun.cursorOffset >= refreshedRun.totalTickers) {
    const snapshot = await completeManualRelativeStrengthRun(env, preset, refreshedRun, matchedTickers);
    const completed = await loadManualRelativeStrengthRun(env, leasedRun.id);
    return completed ? mapManualRunRecordToJob(completed) : (snapshot ? null : mapManualRunRecordToJob(refreshedRun));
  }

  await heartbeatManualRelativeStrengthRun(env, leasedRun.id, { releaseLease: true });
  const latest = await loadManualRelativeStrengthRun(env, leasedRun.id);
  return latest ? mapManualRunRecordToJob(latest) : null;
}

async function storeDailyBars(env: Env, bars: RelativeStrengthDailyBar[]): Promise<void> {
  if (bars.length === 0) return;
  const statements = bars.map((bar) =>
    env.DB.prepare(
      "INSERT OR REPLACE INTO daily_bars (ticker, date, o, h, l, c, volume) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(bar.ticker.toUpperCase(), bar.date, bar.o, bar.h, bar.l, bar.c, (bar as { volume?: number }).volume ?? 0),
  );
  for (let index = 0; index < statements.length; index += RS_JOB_INSERT_CHUNK_SIZE) {
    const chunk = statements.slice(index, index + RS_JOB_INSERT_CHUNK_SIZE);
    await env.DB.batch(chunk);
  }
}

async function ensureStoredDailyBarsCurrent(
  env: Env,
  tickers: string[],
  expectedTradingDate: string,
  requiredBarCount: number,
): Promise<void> {
  const uniqueTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean),
  ));
  if (uniqueTickers.length === 0) return;
  const coverageByTicker = await loadDailyBarCoverage(env, uniqueTickers, expectedTradingDate);
  const staleOrMissingTickers = uniqueTickers.filter((ticker) => {
    const coverage = coverageByTicker.get(ticker);
    if (!coverage) return true;
    return coverage.lastDate !== expectedTradingDate;
  });
  const startDate = isoDateDaysAgo(calendarLookbackDaysForBars(requiredBarCount));
  if (staleOrMissingTickers.length > 0) {
    await refreshDailyBarsIncremental(env, {
      tickers: staleOrMissingTickers,
      startDate,
      endDate: expectedTradingDate,
      provider: getProvider(env),
    });
  }
  const sparseTickers = uniqueTickers.filter((ticker) => {
    const coverage = coverageByTicker.get(ticker);
    return Boolean(coverage) && coverage.lastDate === expectedTradingDate && (coverage.barCount ?? 0) < requiredBarCount;
  });
  if (sparseTickers.length > 0) {
    await refreshDailyBarsIncremental(env, {
      tickers: sparseTickers,
      startDate,
      endDate: expectedTradingDate,
      provider: getProvider(env),
      replaceExisting: true,
    });
  }
}

async function ensureRelativeStrengthBenchmarkBarsCurrent(
  env: Env,
  benchmarkTicker: string,
  expectedTradingDate: string,
  requiredBarCount: number,
): Promise<void> {
  const startDate = isoDateDaysAgo(calendarLookbackDaysForBars(requiredBarCount));
  const loadCoverage = async () => {
    const coverageByTicker = await loadDailyBarCoverage(env, [benchmarkTicker], expectedTradingDate);
    return coverageByTicker.get(benchmarkTicker);
  };

  await ensureStoredDailyBarsCurrent(env, [benchmarkTicker], expectedTradingDate, requiredBarCount);
  let coverage = await loadCoverage();
  if ((!coverage || coverage.lastDate !== expectedTradingDate) || (coverage.barCount ?? 0) < requiredBarCount) {
    const fallbackProvider = getProvider({ ...env, DATA_PROVIDER: "stooq" } as Env);
    if (!coverage || coverage.lastDate !== expectedTradingDate) {
      await refreshDailyBarsIncremental(env, {
        tickers: [benchmarkTicker],
        startDate,
        endDate: expectedTradingDate,
        maxTickers: 1,
        provider: fallbackProvider,
      });
      coverage = await loadCoverage();
    }
    if (coverage && coverage.lastDate === expectedTradingDate && (coverage.barCount ?? 0) < requiredBarCount) {
      await refreshDailyBarsIncremental(env, {
        tickers: [benchmarkTicker],
        startDate,
        endDate: expectedTradingDate,
        maxTickers: 1,
        provider: fallbackProvider,
        replaceExisting: true,
      });
    }
  }
}

async function ensureRelativeStrengthRatioCacheCurrent(
  env: Env,
  tickers: string[],
  benchmarkBars: RelativeStrengthDailyBar[],
  identity: RelativeStrengthConfigIdentity,
): Promise<void> {
  const uniqueTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter((ticker) => ticker && ticker !== identity.benchmarkTicker && ticker !== identity.benchmarkDataTicker),
  ));
  if (uniqueTickers.length === 0) return;

  const coverageByTicker = await loadRelativeStrengthRatioCoverage(
    env,
    identity.benchmarkTicker,
    uniqueTickers,
    identity.expectedTradingDate,
  );
  const keepBars = Math.max(identity.requiredBarCount, RS_RATIO_RETENTION_BARS);
  const incrementalTickers: string[] = [];
  const rebuildTickers: string[] = [];

  for (const ticker of uniqueTickers) {
    const coverage = coverageByTicker.get(ticker);
    if (!coverage) {
      rebuildTickers.push(ticker);
      continue;
    }
    if ((coverage.rowCount ?? 0) < identity.requiredBarCount) {
      rebuildTickers.push(ticker);
      continue;
    }
    if (coverage.lastDate !== identity.expectedTradingDate) {
      incrementalTickers.push(ticker);
    }
  }

  if (incrementalTickers.length > 0) {
    let earliestStartDate = identity.expectedTradingDate;
    for (const ticker of incrementalTickers) {
      const lastDate = coverageByTicker.get(ticker)?.lastDate;
      if (lastDate && lastDate < earliestStartDate) earliestStartDate = lastDate;
    }
    const recentBars = await loadStoredDailyBarsInRange(
      env,
      incrementalTickers,
      isoDateDaysBefore(earliestStartDate, 1),
      identity.expectedTradingDate,
    );
    const barsByTicker = groupBarsByTicker(recentBars);
    const ratioRows: RelativeStrengthRatioRow[] = [];
    for (const ticker of incrementalTickers) {
      const bars = barsByTicker.get(ticker) ?? [];
      if (bars.length === 0) continue;
      const lastDate = coverageByTicker.get(ticker)?.lastDate;
      ratioRows.push(
        ...buildRelativeStrengthRatioRows(bars, benchmarkBars, identity.benchmarkTicker)
          .filter((row) => !lastDate || row.tradingDate > lastDate),
      );
    }
    await upsertRelativeStrengthRatioRows(env, ratioRows);
  }

  if (rebuildTickers.length > 0) {
    const bars = await loadStoredDailyBarsByCount(
      env,
      rebuildTickers,
      identity.expectedTradingDate,
      keepBars,
    );
    const barsByTicker = groupBarsByTicker(bars);
    const ratioRows: RelativeStrengthRatioRow[] = [];
    for (const ticker of rebuildTickers) {
      const tickerBars = barsByTicker.get(ticker) ?? [];
      if (tickerBars.length === 0) continue;
      const builtRows = buildRelativeStrengthRatioRows(tickerBars, benchmarkBars, identity.benchmarkTicker);
      ratioRows.push(...builtRows.slice(-keepBars));
    }
    await upsertRelativeStrengthRatioRows(env, ratioRows);
  }

  await pruneRelativeStrengthRatioCache(env, identity.benchmarkTicker, uniqueTickers, keepBars);
}

async function fetchBenchmarkBarsWithFallback(
  env: Env,
  benchmarkTicker: string,
  startDate: string,
  endDate: string,
): Promise<RelativeStrengthDailyBar[]> {
  const primaryProvider = getProvider(env);
  const fallbackProvider = getProvider({ ...env, DATA_PROVIDER: "stooq" } as Env);
  const storedBars = await loadStoredDailyBarsInRange(env, [benchmarkTicker], startDate, endDate);
  let candidateEndDate = endDate;
  let bestBars: RelativeStrengthDailyBar[] = [];

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const primaryBars = await primaryProvider.getDailyBars([benchmarkTicker], startDate, candidateEndDate);
    bestBars = chooseFresherBars(bestBars, primaryBars);
    if (latestBarDate(primaryBars) === candidateEndDate) return primaryBars;

    const fallbackBars = await fallbackProvider.getDailyBars([benchmarkTicker], startDate, candidateEndDate);
    bestBars = chooseFresherBars(bestBars, fallbackBars);
    if (latestBarDate(fallbackBars) === candidateEndDate) return fallbackBars;

    if (storedBars.length > 0) {
      return chooseFresherBars(bestBars, storedBars);
    }

    candidateEndDate = previousWeekdayIso(candidateEndDate);
  }

  return chooseFresherBars(bestBars, storedBars);
}

async function loadScanRefreshJobRecord(env: Env, jobId: string): Promise<ScanRefreshJobRecord | null> {
  return env.DB.prepare(
    `SELECT
       id,
       preset_id as presetId,
       job_type as jobType,
       status,
       started_at as startedAt,
       updated_at as updatedAt,
       completed_at as completedAt,
       error,
       total_candidates as totalCandidates,
       processed_candidates as processedCandidates,
       matched_candidates as matchedCandidates,
       cursor_offset as cursorOffset,
       latest_snapshot_id as latestSnapshotId,
       requested_by as requestedBy,
       benchmark_bars_json as benchmarkBarsJson,
       required_bar_count as requiredBarCount,
       config_key as configKey,
       shared_run_id as sharedRunId,
       expected_trading_date as expectedTradingDate,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback,
       full_candidate_count as fullCandidateCount,
       materialization_candidate_count as materializationCandidateCount,
       already_current_candidate_count as alreadyCurrentCandidateCount,
       last_advanced_at as lastAdvancedAt,
       deferred_ticker_count as deferredTickerCount,
       warning,
       phase
     FROM scan_refresh_jobs
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(jobId)
    .first<ScanRefreshJobRecord>();
}

async function loadLatestScanRefreshJobRecordForPreset(
  env: Env,
  presetId: string,
  options?: { activeOnly?: boolean },
): Promise<ScanRefreshJobRecord | null> {
  const clauses = ["preset_id = ?"];
  if (options?.activeOnly) clauses.push("status IN ('queued', 'running')");
  return env.DB.prepare(
    `SELECT
       id,
       preset_id as presetId,
       job_type as jobType,
       status,
       started_at as startedAt,
       updated_at as updatedAt,
       completed_at as completedAt,
       error,
       total_candidates as totalCandidates,
       processed_candidates as processedCandidates,
       matched_candidates as matchedCandidates,
       cursor_offset as cursorOffset,
       latest_snapshot_id as latestSnapshotId,
       requested_by as requestedBy,
       benchmark_bars_json as benchmarkBarsJson,
       required_bar_count as requiredBarCount,
       config_key as configKey,
       shared_run_id as sharedRunId,
       expected_trading_date as expectedTradingDate,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback,
       full_candidate_count as fullCandidateCount,
       materialization_candidate_count as materializationCandidateCount,
       already_current_candidate_count as alreadyCurrentCandidateCount,
       last_advanced_at as lastAdvancedAt,
       deferred_ticker_count as deferredTickerCount,
       warning,
       phase
     FROM scan_refresh_jobs
     WHERE ${clauses.join(" AND ")}
     ORDER BY datetime(started_at) DESC
     LIMIT 1`,
  )
    .bind(presetId)
    .first<ScanRefreshJobRecord>();
}

async function loadLatestCompletedScanRefreshJobRecordForPreset(
  env: Env,
  presetId: string,
  expectedTradingDate: string,
): Promise<ScanRefreshJobRecord | null> {
  return env.DB.prepare(
    `SELECT
       id,
       preset_id as presetId,
       job_type as jobType,
       status,
       started_at as startedAt,
       updated_at as updatedAt,
       completed_at as completedAt,
       error,
       total_candidates as totalCandidates,
       processed_candidates as processedCandidates,
       matched_candidates as matchedCandidates,
       cursor_offset as cursorOffset,
       latest_snapshot_id as latestSnapshotId,
       requested_by as requestedBy,
       benchmark_bars_json as benchmarkBarsJson,
       required_bar_count as requiredBarCount,
       config_key as configKey,
       shared_run_id as sharedRunId,
       expected_trading_date as expectedTradingDate,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback,
       full_candidate_count as fullCandidateCount,
       materialization_candidate_count as materializationCandidateCount,
       already_current_candidate_count as alreadyCurrentCandidateCount,
       last_advanced_at as lastAdvancedAt,
       deferred_ticker_count as deferredTickerCount,
       warning,
       phase
     FROM scan_refresh_jobs
     WHERE preset_id = ?
       AND expected_trading_date = ?
       AND status = 'completed'
     ORDER BY datetime(completed_at) DESC, datetime(updated_at) DESC
     LIMIT 1`,
  )
    .bind(presetId, expectedTradingDate)
    .first<ScanRefreshJobRecord>();
}

async function listActiveScanRefreshJobRecords(env: Env): Promise<ScanRefreshJobRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT
       id,
       preset_id as presetId,
       job_type as jobType,
       status,
       started_at as startedAt,
       updated_at as updatedAt,
       completed_at as completedAt,
       error,
       total_candidates as totalCandidates,
       processed_candidates as processedCandidates,
       matched_candidates as matchedCandidates,
       cursor_offset as cursorOffset,
       latest_snapshot_id as latestSnapshotId,
       requested_by as requestedBy,
       benchmark_bars_json as benchmarkBarsJson,
       required_bar_count as requiredBarCount,
       config_key as configKey,
       shared_run_id as sharedRunId,
       expected_trading_date as expectedTradingDate,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback,
       full_candidate_count as fullCandidateCount,
       materialization_candidate_count as materializationCandidateCount,
       already_current_candidate_count as alreadyCurrentCandidateCount,
       last_advanced_at as lastAdvancedAt,
       deferred_ticker_count as deferredTickerCount,
       warning,
       phase
     FROM scan_refresh_jobs
     WHERE status IN ('queued', 'running')
     ORDER BY datetime(updated_at) ASC, datetime(started_at) ASC`,
  )
    .all<ScanRefreshJobRecord>();
  return rows.results ?? [];
}

async function loadRelativeStrengthMaterializationRun(
  env: Env,
  runId: string,
): Promise<RelativeStrengthMaterializationRunRecord | null> {
  return env.DB.prepare(
    `SELECT
       id,
       config_key as configKey,
       expected_trading_date as expectedTradingDate,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback,
       status,
       started_at as startedAt,
       updated_at as updatedAt,
       completed_at as completedAt,
       error,
       benchmark_bars_json as benchmarkBarsJson,
       required_bar_count as requiredBarCount,
       full_candidate_count as fullCandidateCount,
       materialization_candidate_count as materializationCandidateCount,
       already_current_candidate_count as alreadyCurrentCandidateCount,
       processed_candidates as processedCandidates,
       matched_candidates as matchedCandidates,
       cursor_offset as cursorOffset,
       last_advanced_at as lastAdvancedAt,
       deferred_ticker_count as deferredTickerCount,
       warning,
       phase,
       lease_owner as leaseOwner,
       lease_expires_at as leaseExpiresAt,
       heartbeat_at as heartbeatAt
     FROM relative_strength_materialization_runs
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(runId)
    .first<RelativeStrengthMaterializationRunRecord>();
}

async function loadActiveRelativeStrengthMaterializationRunForConfig(
  env: Env,
  configKey: string,
  expectedTradingDate: string,
): Promise<RelativeStrengthMaterializationRunRecord | null> {
  return env.DB.prepare(
    `SELECT
       id,
       config_key as configKey,
       expected_trading_date as expectedTradingDate,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback,
       status,
       started_at as startedAt,
       updated_at as updatedAt,
       completed_at as completedAt,
       error,
       benchmark_bars_json as benchmarkBarsJson,
       required_bar_count as requiredBarCount,
       full_candidate_count as fullCandidateCount,
       materialization_candidate_count as materializationCandidateCount,
       already_current_candidate_count as alreadyCurrentCandidateCount,
       processed_candidates as processedCandidates,
       matched_candidates as matchedCandidates,
       cursor_offset as cursorOffset,
       last_advanced_at as lastAdvancedAt,
       deferred_ticker_count as deferredTickerCount,
       warning,
       phase,
       lease_owner as leaseOwner,
       lease_expires_at as leaseExpiresAt,
       heartbeat_at as heartbeatAt
     FROM relative_strength_materialization_runs
     WHERE config_key = ?
       AND expected_trading_date = ?
       AND status IN ('queued', 'running')
     ORDER BY datetime(started_at) DESC
     LIMIT 1`,
  )
    .bind(configKey, expectedTradingDate)
    .first<RelativeStrengthMaterializationRunRecord>();
}

async function loadLatestRelativeStrengthMaterializationRunForConfig(
  env: Env,
  configKey: string,
  expectedTradingDate: string,
): Promise<RelativeStrengthMaterializationRunRecord | null> {
  return env.DB.prepare(
    `SELECT
       id,
       config_key as configKey,
       expected_trading_date as expectedTradingDate,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback,
       status,
       started_at as startedAt,
       updated_at as updatedAt,
       completed_at as completedAt,
       error,
       benchmark_bars_json as benchmarkBarsJson,
       required_bar_count as requiredBarCount,
       full_candidate_count as fullCandidateCount,
       materialization_candidate_count as materializationCandidateCount,
       already_current_candidate_count as alreadyCurrentCandidateCount,
       processed_candidates as processedCandidates,
       matched_candidates as matchedCandidates,
       cursor_offset as cursorOffset,
       last_advanced_at as lastAdvancedAt,
       deferred_ticker_count as deferredTickerCount,
       warning,
       phase,
       lease_owner as leaseOwner,
       lease_expires_at as leaseExpiresAt,
       heartbeat_at as heartbeatAt
     FROM relative_strength_materialization_runs
     WHERE config_key = ?
       AND expected_trading_date = ?
     ORDER BY datetime(started_at) DESC
     LIMIT 1`,
  )
    .bind(configKey, expectedTradingDate)
    .first<RelativeStrengthMaterializationRunRecord>();
}

async function listActiveRelativeStrengthMaterializationRuns(
  env: Env,
): Promise<RelativeStrengthMaterializationRunRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT
       id,
       config_key as configKey,
       expected_trading_date as expectedTradingDate,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback,
       status,
       started_at as startedAt,
       updated_at as updatedAt,
       completed_at as completedAt,
       error,
       benchmark_bars_json as benchmarkBarsJson,
       required_bar_count as requiredBarCount,
       full_candidate_count as fullCandidateCount,
       materialization_candidate_count as materializationCandidateCount,
       already_current_candidate_count as alreadyCurrentCandidateCount,
       processed_candidates as processedCandidates,
       matched_candidates as matchedCandidates,
       cursor_offset as cursorOffset,
       last_advanced_at as lastAdvancedAt,
       deferred_ticker_count as deferredTickerCount,
       warning,
       phase,
       lease_owner as leaseOwner,
       lease_expires_at as leaseExpiresAt,
       heartbeat_at as heartbeatAt
     FROM relative_strength_materialization_runs
     WHERE status IN ('queued', 'running')
     ORDER BY datetime(updated_at) ASC, datetime(started_at) ASC`,
  ).all<RelativeStrengthMaterializationRunRecord>();
  return rows.results ?? [];
}

async function updateRelativeStrengthMaterializationRun(
  env: Env,
  runId: string,
  updates: Partial<RelativeStrengthMaterializationRunRecord>,
): Promise<void> {
  const fields: string[] = ["updated_at = CURRENT_TIMESTAMP"];
  const values: unknown[] = [];
  if (updates.status != null) {
    fields.push("status = ?");
    values.push(updates.status);
  }
  if (updates.error !== undefined) {
    fields.push("error = ?");
    values.push(updates.error);
  }
  if (updates.benchmarkBarsJson !== undefined) {
    fields.push("benchmark_bars_json = ?");
    values.push(updates.benchmarkBarsJson);
  }
  if (updates.requiredBarCount != null) {
    fields.push("required_bar_count = ?");
    values.push(updates.requiredBarCount);
  }
  if (updates.fullCandidateCount != null) {
    fields.push("full_candidate_count = ?");
    values.push(updates.fullCandidateCount);
  }
  if (updates.materializationCandidateCount != null) {
    fields.push("materialization_candidate_count = ?");
    values.push(updates.materializationCandidateCount);
  }
  if (updates.alreadyCurrentCandidateCount != null) {
    fields.push("already_current_candidate_count = ?");
    values.push(updates.alreadyCurrentCandidateCount);
  }
  if (updates.processedCandidates != null) {
    fields.push("processed_candidates = ?");
    values.push(updates.processedCandidates);
  }
  if (updates.matchedCandidates != null) {
    fields.push("matched_candidates = ?");
    values.push(updates.matchedCandidates);
  }
  if (updates.cursorOffset != null) {
    fields.push("cursor_offset = ?");
    values.push(updates.cursorOffset);
  }
  if (updates.lastAdvancedAt !== undefined) {
    fields.push("last_advanced_at = ?");
    values.push(updates.lastAdvancedAt);
  }
  if (updates.deferredTickerCount != null) {
    fields.push("deferred_ticker_count = ?");
    values.push(updates.deferredTickerCount);
  }
  if (updates.warning !== undefined) {
    fields.push("warning = ?");
    values.push(updates.warning);
  }
  if (updates.phase !== undefined) {
    fields.push("phase = ?");
    values.push(updates.phase);
  }
  if (updates.leaseOwner !== undefined) {
    fields.push("lease_owner = ?");
    values.push(updates.leaseOwner);
  }
  if (updates.leaseExpiresAt !== undefined) {
    fields.push("lease_expires_at = ?");
    values.push(updates.leaseExpiresAt);
  }
  if (updates.heartbeatAt !== undefined) {
    fields.push("heartbeat_at = ?");
    values.push(updates.heartbeatAt);
  }
  if (updates.completedAt !== undefined) {
    fields.push("completed_at = ?");
    values.push(updates.completedAt);
  }
  await env.DB.prepare(`UPDATE relative_strength_materialization_runs SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values, runId)
    .run();
}

function isoDateAfterMs(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function isRelativeStrengthRunLeaseActive(run: Pick<RelativeStrengthMaterializationRunRecord, "leaseOwner" | "leaseExpiresAt">): boolean {
  if (!run.leaseOwner || !run.leaseExpiresAt) return false;
  const leaseExpiresAtMs = toTimestampMs(run.leaseExpiresAt);
  if (leaseExpiresAtMs == null) return false;
  return leaseExpiresAtMs > Date.now();
}

async function tryAcquireRelativeStrengthMaterializationRunLease(
  env: Env,
  runId: string,
  leaseOwner: string,
  phase: string | null,
): Promise<RelativeStrengthMaterializationRunRecord | null> {
  const leaseExpiresAt = isoDateAfterMs(RS_RUN_LEASE_DURATION_MS);
  const heartbeatAt = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE relative_strength_materialization_runs
     SET lease_owner = ?,
         lease_expires_at = ?,
         heartbeat_at = ?,
         phase = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND (
         lease_owner IS NULL
         OR lease_expires_at IS NULL
         OR datetime(lease_expires_at) <= CURRENT_TIMESTAMP
         OR lease_owner = ?
       )`,
  )
    .bind(leaseOwner, leaseExpiresAt, heartbeatAt, phase, runId, leaseOwner)
    .run();
  const run = await loadRelativeStrengthMaterializationRun(env, runId);
  return run?.leaseOwner === leaseOwner ? run : null;
}

async function heartbeatRelativeStrengthMaterializationRunLease(
  env: Env,
  runId: string,
  leaseOwner: string,
  phase: string | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE relative_strength_materialization_runs
     SET lease_expires_at = ?,
         heartbeat_at = ?,
         phase = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND lease_owner = ?`,
  )
    .bind(isoDateAfterMs(RS_RUN_LEASE_DURATION_MS), new Date().toISOString(), phase, runId, leaseOwner)
    .run();
}

async function releaseRelativeStrengthMaterializationRunLease(
  env: Env,
  runId: string,
  leaseOwner: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE relative_strength_materialization_runs
     SET lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND lease_owner = ?`,
  )
    .bind(runId, leaseOwner)
    .run();
}

function relativeStrengthRunQueuePriority(source: string | null | undefined): number {
  if (source === "manual") return 100;
  if (source === "background-completed") return 90;
  if (source === "scheduled") return 50;
  if (source === "recovery") return 25;
  return 10;
}

async function enqueueRelativeStrengthMaterializationRun(
  env: Env,
  runId: string,
  source: string,
): Promise<void> {
  const priority = relativeStrengthRunQueuePriority(source);
  await env.DB.prepare(
    `INSERT INTO relative_strength_materialization_queue
      (run_id, priority, source, enqueued_at, last_attempted_at, attempts)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP, NULL, 0)
     ON CONFLICT(run_id) DO UPDATE SET
       priority = MAX(relative_strength_materialization_queue.priority, excluded.priority),
       source = excluded.source,
       enqueued_at = CURRENT_TIMESTAMP`,
  )
    .bind(runId, priority, source)
    .run();
}

async function removeRelativeStrengthMaterializationRunFromQueue(env: Env, runId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM relative_strength_materialization_queue WHERE run_id = ?").bind(runId).run();
}

async function markRelativeStrengthMaterializationRunQueueAttempt(env: Env, runId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE relative_strength_materialization_queue
     SET last_attempted_at = CURRENT_TIMESTAMP,
         attempts = attempts + 1
     WHERE run_id = ?`,
  )
    .bind(runId)
    .run();
}

async function listQueuedRelativeStrengthMaterializationRuns(env: Env): Promise<RelativeStrengthRefreshQueueRow[]> {
  const rows = await env.DB.prepare(
    `SELECT
       run_id as runId,
       priority,
       source,
       enqueued_at as enqueuedAt,
       last_attempted_at as lastAttemptedAt,
       attempts
     FROM relative_strength_materialization_queue
     ORDER BY priority DESC, datetime(enqueued_at) ASC`,
  ).all<RelativeStrengthRefreshQueueRow>();
  return rows.results ?? [];
}

async function hasRelativeStrengthRunCandidates(env: Env, runId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 as present
     FROM relative_strength_materialization_run_candidates
     WHERE run_id = ?
     LIMIT 1`,
  )
    .bind(runId)
    .first<{ present: number }>();
  return Boolean(row);
}

async function loadRelativeStrengthRunCandidateTickers(
  env: Env,
  runId: string,
  cursorOffset: number,
  limit: number,
): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT ticker
     FROM relative_strength_materialization_run_candidates
     WHERE run_id = ?
     ORDER BY cursor_offset ASC
     LIMIT ? OFFSET ?`,
  )
    .bind(runId, limit, cursorOffset)
    .all<{ ticker: string }>();
  return (rows.results ?? []).map((row) => row.ticker.toUpperCase());
}

async function loadRelativeStrengthRunCandidateTickerSet(
  env: Env,
  runId: string,
  tickers: string[],
): Promise<Set<string>> {
  const uniqueTickers = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  const present = new Set<string>();
  for (let index = 0; index < uniqueTickers.length; index += RS_STORED_BAR_QUERY_CHUNK_SIZE) {
    const chunk = uniqueTickers.slice(index, index + RS_STORED_BAR_QUERY_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT ticker
       FROM relative_strength_materialization_run_candidates
       WHERE run_id = ?
         AND ticker IN (${placeholders})`,
    )
      .bind(runId, ...chunk)
      .all<{ ticker: string }>();
    for (const row of rows.results ?? []) present.add(row.ticker.toUpperCase());
  }
  return present;
}

async function appendRelativeStrengthRunCandidateTickers(
  env: Env,
  runId: string,
  tickers: string[],
): Promise<number> {
  const uniqueTickers = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  if (uniqueTickers.length === 0) return 0;
  const existing = await loadRelativeStrengthRunCandidateTickerSet(env, runId, uniqueTickers);
  const missing = uniqueTickers.filter((ticker) => !existing.has(ticker));
  if (missing.length === 0) return 0;
  const maxRow = await env.DB.prepare(
    "SELECT MAX(cursor_offset) as maxCursorOffset FROM relative_strength_materialization_run_candidates WHERE run_id = ?",
  )
    .bind(runId)
    .first<{ maxCursorOffset: number | null }>();
  let nextCursorOffset = (maxRow?.maxCursorOffset ?? -1) + 1;
  for (let index = 0; index < missing.length; index += RS_JOB_INSERT_CHUNK_SIZE) {
    const chunk = missing.slice(index, index + RS_JOB_INSERT_CHUNK_SIZE);
    await env.DB.batch(chunk.map((ticker) =>
      env.DB.prepare(
        `INSERT INTO relative_strength_materialization_run_candidates (run_id, cursor_offset, ticker)
         VALUES (?, ?, ?)`,
      ).bind(runId, nextCursorOffset++, ticker),
    ));
  }
  return missing.length;
}

async function enqueueRelativeStrengthRefreshJob(
  env: Env,
  jobId: string,
  source: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO relative_strength_refresh_queue (job_id, source, enqueued_at, last_attempted_at, attempts)
     VALUES (?, ?, CURRENT_TIMESTAMP, NULL, 0)
     ON CONFLICT(job_id) DO UPDATE SET
       source = excluded.source,
       enqueued_at = CURRENT_TIMESTAMP`,
  )
    .bind(jobId, source)
    .run();
}

async function removeRelativeStrengthRefreshJobFromQueue(env: Env, jobId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM relative_strength_refresh_queue WHERE job_id = ?").bind(jobId).run();
}

async function removeRelativeStrengthRefreshJobArtifacts(env: Env, jobId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM relative_strength_refresh_queue WHERE job_id = ?").bind(jobId),
    env.DB.prepare("DELETE FROM scan_refresh_job_top_rows WHERE job_id = ?").bind(jobId),
    env.DB.prepare("DELETE FROM scan_refresh_job_candidates WHERE job_id = ?").bind(jobId),
    env.DB.prepare("DELETE FROM scan_refresh_jobs WHERE id = ?").bind(jobId),
  ]);
}

async function removeRelativeStrengthMaterializationRunArtifacts(env: Env, runId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM relative_strength_materialization_queue WHERE run_id = ?").bind(runId),
    env.DB.prepare("DELETE FROM relative_strength_materialization_run_deferred_tickers WHERE run_id = ?").bind(runId),
    env.DB.prepare("DELETE FROM relative_strength_materialization_run_candidates WHERE run_id = ?").bind(runId),
    env.DB.prepare("DELETE FROM relative_strength_materialization_runs WHERE id = ?").bind(runId),
  ]);
}

async function markRelativeStrengthRefreshJobQueueAttempt(env: Env, jobId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE relative_strength_refresh_queue
     SET last_attempted_at = CURRENT_TIMESTAMP,
         attempts = attempts + 1
     WHERE job_id = ?`,
  )
    .bind(jobId)
    .run();
}

async function listQueuedRelativeStrengthRefreshJobs(env: Env): Promise<RelativeStrengthRefreshQueueRow[]> {
  const rows = await env.DB.prepare(
    `SELECT
       job_id as jobId,
       source,
       enqueued_at as enqueuedAt,
       last_attempted_at as lastAttemptedAt,
       attempts
     FROM relative_strength_refresh_queue
     ORDER BY datetime(enqueued_at) ASC`,
  ).all<RelativeStrengthRefreshQueueRow>();
  return rows.results ?? [];
}

async function hasRelativeStrengthJobCandidates(env: Env, jobId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 as present
     FROM scan_refresh_job_candidates
     WHERE job_id = ?
     LIMIT 1`,
  )
    .bind(jobId)
    .first<{ present: number }>();
  return Boolean(row);
}

function lastRefreshAdvanceTimestamp(
  record: Pick<ScanRefreshJobRecord, "lastAdvancedAt" | "updatedAt" | "startedAt">
    | Pick<RelativeStrengthMaterializationRunRecord, "lastAdvancedAt" | "updatedAt" | "startedAt">,
): number | null {
  return toTimestampMs(record.lastAdvancedAt ?? record.updatedAt ?? record.startedAt);
}

function jobNeedsRelativeStrengthContinuation(
  job: Pick<ScanRefreshJobRecord, "status" | "lastAdvancedAt" | "updatedAt" | "startedAt">,
  staleMs = RS_JOB_CONTINUATION_STALE_MS,
): boolean {
  if (job.status !== "queued" && job.status !== "running") return false;
  const lastAdvancedMs = lastRefreshAdvanceTimestamp(job);
  if (lastAdvancedMs == null) return true;
  return Date.now() - lastAdvancedMs >= staleMs;
}

function runNeedsRelativeStrengthContinuation(
  run: Pick<RelativeStrengthMaterializationRunRecord, "status" | "lastAdvancedAt" | "updatedAt" | "startedAt">,
  staleMs = RS_JOB_CONTINUATION_STALE_MS,
): boolean {
  if (run.status !== "queued" && run.status !== "running") return false;
  const lastAdvancedMs = lastRefreshAdvanceTimestamp(run);
  if (lastAdvancedMs == null) return true;
  return Date.now() - lastAdvancedMs >= staleMs;
}

function formatRelativeStrengthDeferredWarning(deferredTickerCount: number): string | null {
  if (deferredTickerCount <= 0) return null;
  return deferredTickerCount === 1
    ? "Deferred 1 ticker after repeated RS materialization failures."
    : `Deferred ${deferredTickerCount} tickers after repeated RS materialization failures.`;
}

async function loadRelativeStrengthDeferredTickerRow(
  env: Env,
  runId: string,
  ticker: string,
): Promise<RelativeStrengthDeferredTickerRow | null> {
  return env.DB.prepare(
    `SELECT
       run_id as runId,
       ticker,
       attempt_count as attemptCount,
       last_error as lastError,
       deferred_at as deferredAt
     FROM relative_strength_materialization_run_deferred_tickers
     WHERE run_id = ?
       AND ticker = ?
     LIMIT 1`,
  )
    .bind(runId, ticker.toUpperCase())
    .first<RelativeStrengthDeferredTickerRow>();
}

async function upsertRelativeStrengthDeferredTickerRow(
  env: Env,
  row: RelativeStrengthDeferredTickerRow,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO relative_strength_materialization_run_deferred_tickers
      (run_id, ticker, attempt_count, last_error, deferred_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(run_id, ticker) DO UPDATE SET
       attempt_count = excluded.attempt_count,
       last_error = excluded.last_error,
       deferred_at = excluded.deferred_at`,
  )
    .bind(row.runId, row.ticker.toUpperCase(), row.attemptCount, row.lastError, row.deferredAt)
    .run();
}

async function countRelativeStrengthDeferredTickers(env: Env, runId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count
     FROM relative_strength_materialization_run_deferred_tickers
     WHERE run_id = ?
       AND deferred_at IS NOT NULL`,
  )
    .bind(runId)
    .first<{ count: number }>();
  return Math.max(0, Number(row?.count ?? 0));
}

async function refreshRelativeStrengthRunDeferredSummary(env: Env, runId: string): Promise<number> {
  const deferredTickerCount = await countRelativeStrengthDeferredTickers(env, runId);
  await updateRelativeStrengthMaterializationRun(env, runId, {
    deferredTickerCount,
    warning: formatRelativeStrengthDeferredWarning(deferredTickerCount),
  });
  return deferredTickerCount;
}

async function invalidateRelativeStrengthRefreshJob(
  env: Env,
  jobId: string,
  error: string,
): Promise<void> {
  await updateScanRefreshJobRecord(env, jobId, {
    status: "failed",
    error,
    completedAt: new Date().toISOString(),
  });
  await removeRelativeStrengthRefreshJobFromQueue(env, jobId);
}

async function insertRelativeStrengthJobCandidates(
  env: Env,
  jobId: string,
  rows: RelativeStrengthJobCandidateRow[],
): Promise<void> {
  for (let index = 0; index < rows.length; index += RS_JOB_INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(index, index + RS_JOB_INSERT_CHUNK_SIZE);
    await env.DB.batch(chunk.map((row) =>
      env.DB.prepare(
        `INSERT INTO scan_refresh_job_candidates
          (job_id, cursor_offset, ticker, name, sector, industry, market_cap, relative_volume, avg_volume, price_avg_volume, materialization_required)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        jobId,
        row.cursorOffset,
        row.ticker,
        row.name,
        row.sector,
        row.industry,
        row.marketCap,
        row.relativeVolume,
        row.avgVolume,
        row.priceAvgVolume,
        row.materializationRequired ? 1 : 0,
      )));
  }
}

async function loadRelativeStrengthJobCandidates(
  env: Env,
  jobId: string,
  cursorOffset: number,
  limit: number,
): Promise<RelativeStrengthJobCandidateRow[]> {
  const rows = await env.DB.prepare(
    `SELECT
       cursor_offset as cursorOffset,
       ticker,
       name,
       sector,
       industry,
       market_cap as marketCap,
       relative_volume as relativeVolume,
       avg_volume as avgVolume,
       price_avg_volume as priceAvgVolume,
       materialization_required as materializationRequired
     FROM scan_refresh_job_candidates
     WHERE job_id = ?
       AND materialization_required = 1
     ORDER BY cursor_offset ASC
     LIMIT ? OFFSET ?`,
  )
    .bind(jobId, limit, cursorOffset)
    .all<RelativeStrengthJobCandidateRow>();
  return (rows.results ?? []).map((row) => ({
    ...row,
    ticker: row.ticker.toUpperCase(),
    materializationRequired: asBooleanFlag(row.materializationRequired),
  }));
}

async function loadAllRelativeStrengthJobCandidates(
  env: Env,
  jobId: string,
): Promise<RelativeStrengthJobCandidateRow[]> {
  const rows = await env.DB.prepare(
    `SELECT
       cursor_offset as cursorOffset,
       ticker,
       name,
       sector,
       industry,
       market_cap as marketCap,
       relative_volume as relativeVolume,
       avg_volume as avgVolume,
       price_avg_volume as priceAvgVolume,
       materialization_required as materializationRequired
     FROM scan_refresh_job_candidates
     WHERE job_id = ?
     ORDER BY cursor_offset ASC`,
  )
    .bind(jobId)
    .all<RelativeStrengthJobCandidateRow>();
  return (rows.results ?? []).map((row) => ({
    ...row,
    ticker: row.ticker.toUpperCase(),
    materializationRequired: asBooleanFlag(row.materializationRequired),
  }));
}

function deserializeStoredScanRows(rows: Array<{
  ticker: string;
  name?: string | null;
  sector?: string | null;
  industry?: string | null;
  change1d?: number | null;
  marketCap?: number | null;
  price?: number | null;
  avgVolume?: number | null;
  priceAvgVolume?: number | null;
  rawJson?: string | null;
}>): ScanSnapshotRow[] {
  return rows.map((row) => {
    let relativeVolume: number | null = null;
    let rsClose: number | null = null;
    let rsMa: number | null = null;
    let approxRsRating: number | null = null;
    let rsAboveMa = false;
    let rsNewHigh = false;
    let rsNewHighBeforePrice = false;
    let bullCross = false;
    try {
      const raw = row.rawJson ? JSON.parse(row.rawJson) as Record<string, unknown> : null;
      relativeVolume = asFiniteNumber(raw?.relative_volume_10d_calc ?? raw?.relative_volume);
      rsClose = asFiniteNumber(raw?.rsClose ?? raw?.rs_close);
      rsMa = asFiniteNumber(raw?.rsMa ?? raw?.rs_ma);
      approxRsRating = asFiniteNumber(raw?.approxRsRating ?? raw?.approx_rs_rating);
      rsAboveMa = Boolean(raw?.rsAboveMa ?? raw?.rs_above_ma);
      rsNewHigh = Boolean(raw?.rsNewHigh ?? raw?.rs_new_high);
      rsNewHighBeforePrice = Boolean(raw?.rsNewHighBeforePrice ?? raw?.rs_new_high_before_price);
      bullCross = Boolean(raw?.bullCross ?? raw?.bull_cross);
    } catch {
      relativeVolume = null;
    }
    return {
      ticker: row.ticker,
      name: row.name ?? null,
      sector: row.sector ?? null,
      industry: row.industry ?? null,
      change1d: row.change1d ?? null,
      marketCap: row.marketCap ?? null,
      relativeVolume,
      price: row.price ?? null,
      avgVolume: row.avgVolume ?? null,
      priceAvgVolume: row.priceAvgVolume ?? null,
      rsClose,
      rsMa,
      rsAboveMa,
      rsNewHigh,
      rsNewHighBeforePrice,
      bullCross,
      approxRsRating,
      rawJson: row.rawJson ?? null,
    };
  });
}

async function loadRelativeStrengthJobTopRows(env: Env, jobId: string): Promise<ScanSnapshotRow[]> {
  const rows = await env.DB.prepare(
    `SELECT
       ticker,
       name,
       sector,
       industry,
       change_1d as change1d,
       market_cap as marketCap,
       price,
       avg_volume as avgVolume,
       price_avg_volume as priceAvgVolume,
       raw_json as rawJson
     FROM scan_refresh_job_top_rows
     WHERE job_id = ?
     ORDER BY ticker ASC`,
  )
    .bind(jobId)
    .all<{
      ticker: string;
      name: string | null;
      sector: string | null;
      industry: string | null;
      change1d: number | null;
      marketCap: number | null;
      price: number | null;
      avgVolume: number | null;
      priceAvgVolume: number | null;
      rawJson: string | null;
    }>();
  return deserializeStoredScanRows(rows.results ?? []);
}

async function replaceRelativeStrengthJobTopRows(
  env: Env,
  jobId: string,
  rows: ScanSnapshotRow[],
): Promise<void> {
  await env.DB.prepare("DELETE FROM scan_refresh_job_top_rows WHERE job_id = ?").bind(jobId).run();
  if (rows.length === 0) return;
  await env.DB.batch(rows.map((row) =>
    env.DB.prepare(
      `INSERT INTO scan_refresh_job_top_rows
        (job_id, ticker, name, sector, industry, change_1d, market_cap, price, avg_volume, price_avg_volume, raw_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(
      jobId,
      row.ticker,
      row.name ?? null,
      row.sector ?? null,
      row.industry ?? null,
      row.change1d,
      row.marketCap,
      row.price,
      row.avgVolume,
      row.priceAvgVolume,
      row.rawJson,
    )));
}

async function updateScanRefreshJobRecord(
  env: Env,
  jobId: string,
  updates: Partial<
    Pick<
      ScanRefreshJobRecord,
      | "status"
      | "error"
      | "processedCandidates"
      | "matchedCandidates"
      | "cursorOffset"
      | "latestSnapshotId"
      | "benchmarkBarsJson"
      | "requiredBarCount"
      | "sharedRunId"
      | "fullCandidateCount"
      | "materializationCandidateCount"
      | "alreadyCurrentCandidateCount"
      | "lastAdvancedAt"
      | "deferredTickerCount"
      | "warning"
      | "phase"
    >
  > & { completedAt?: string | null },
): Promise<void> {
  const fields: string[] = ["updated_at = CURRENT_TIMESTAMP"];
  const values: unknown[] = [];
  if (updates.status != null) {
    fields.push("status = ?");
    values.push(updates.status);
  }
  if (updates.error !== undefined) {
    fields.push("error = ?");
    values.push(updates.error);
  }
  if (updates.processedCandidates != null) {
    fields.push("processed_candidates = ?");
    values.push(updates.processedCandidates);
  }
  if (updates.matchedCandidates != null) {
    fields.push("matched_candidates = ?");
    values.push(updates.matchedCandidates);
  }
  if (updates.cursorOffset != null) {
    fields.push("cursor_offset = ?");
    values.push(updates.cursorOffset);
  }
  if (updates.latestSnapshotId !== undefined) {
    fields.push("latest_snapshot_id = ?");
    values.push(updates.latestSnapshotId);
  }
  if (updates.benchmarkBarsJson !== undefined) {
    fields.push("benchmark_bars_json = ?");
    values.push(updates.benchmarkBarsJson);
  }
  if (updates.requiredBarCount != null) {
    fields.push("required_bar_count = ?");
    values.push(updates.requiredBarCount);
  }
  if (updates.sharedRunId !== undefined) {
    fields.push("shared_run_id = ?");
    values.push(updates.sharedRunId);
  }
  if (updates.fullCandidateCount != null) {
    fields.push("full_candidate_count = ?");
    values.push(updates.fullCandidateCount);
  }
  if (updates.materializationCandidateCount != null) {
    fields.push("materialization_candidate_count = ?");
    values.push(updates.materializationCandidateCount);
  }
  if (updates.alreadyCurrentCandidateCount != null) {
    fields.push("already_current_candidate_count = ?");
    values.push(updates.alreadyCurrentCandidateCount);
  }
  if (updates.lastAdvancedAt !== undefined) {
    fields.push("last_advanced_at = ?");
    values.push(updates.lastAdvancedAt);
  }
  if (updates.deferredTickerCount != null) {
    fields.push("deferred_ticker_count = ?");
    values.push(updates.deferredTickerCount);
  }
  if (updates.warning !== undefined) {
    fields.push("warning = ?");
    values.push(updates.warning);
  }
  if (updates.phase !== undefined) {
    fields.push("phase = ?");
    values.push(updates.phase);
  }
  if (updates.leaseOwner !== undefined) {
    fields.push("lease_owner = ?");
    values.push(updates.leaseOwner);
  }
  if (updates.leaseExpiresAt !== undefined) {
    fields.push("lease_expires_at = ?");
    values.push(updates.leaseExpiresAt);
  }
  if (updates.heartbeatAt !== undefined) {
    fields.push("heartbeat_at = ?");
    values.push(updates.heartbeatAt);
  }
  if (updates.completedAt !== undefined) {
    fields.push("completed_at = ?");
    values.push(updates.completedAt);
  }
  await env.DB.prepare(`UPDATE scan_refresh_jobs SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values, jobId)
    .run();
}

function snapshotIsFreshForCompletedJob(
  snapshot: Pick<ScanSnapshot, "generatedAt"> | null,
  job: Pick<ScanRefreshJobRecord, "completedAt" | "updatedAt" | "expectedTradingDate"> | null,
): boolean {
  if (!snapshot || !job) return false;
  const snapshotMs = toTimestampMs(snapshot.generatedAt);
  const jobMs = toTimestampMs(job.completedAt ?? job.updatedAt);
  if (snapshotMs == null || jobMs == null) return false;
  return snapshotMs >= jobMs;
}

async function refreshRelativeStrengthSnapshot(
  env: Env,
  preset: ScanPreset,
  completedJob: Pick<ScanRefreshJobRecord, "id" | "configKey" | "expectedTradingDate" | "warning">,
): Promise<{
  providerLabel: string;
  matchedRowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
  rows: ScanSnapshotRow[];
}> {
  const identity = buildRelativeStrengthConfigIdentity(preset);
  const candidates = await loadAllRelativeStrengthJobCandidates(env, completedJob.id);
  const result = await buildRelativeStrengthSnapshotResult(
    env,
    preset,
    candidates,
    completedJob.configKey ?? identity.configKey,
    completedJob.expectedTradingDate ?? identity.expectedTradingDate,
  );
  if (completedJob.warning && result.status !== "error") {
    return {
      ...result,
      status: result.rows.length > 0 ? "warning" : result.status,
      error: completedJob.warning,
    };
  }
  return result;
}

async function buildRelativeStrengthSnapshotResult(
  env: Env,
  preset: ScanPreset,
  candidates: RelativeStrengthJobCandidateRow[],
  configKey: string,
  tradingDate: string,
): Promise<{
  providerLabel: string;
  matchedRowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
  rows: ScanSnapshotRow[];
}> {
  const identity = buildRelativeStrengthConfigIdentity(preset, tradingDate);
  if (candidates.length === 0) {
    return {
      providerLabel: RS_PROVIDER_LABEL,
      matchedRowCount: 0,
      status: "empty",
      error: null,
      rows: [],
    };
  }

  const metadataByTicker = new Map(
    candidates.map((row) => [row.ticker.toUpperCase(), row] as const),
  );
  const cacheRowsByTicker = await loadRelativeStrengthEffectiveLatestCacheRows(
    env,
    configKey,
    Array.from(metadataByTicker.keys()),
    tradingDate,
  );
  const scaleFactor = preset.verticalOffset * 100;
  const mergedRows = Array.from(cacheRowsByTicker.values())
    .filter((row) => cachedRowMatchesOutputMode(row, preset.outputMode))
    .map((row) => {
      const metadata = metadataByTicker.get(row.ticker);
      if (!metadata) return null;
      const rsClose = row.rsRatioClose == null ? null : row.rsRatioClose * scaleFactor;
      const rsMa = row.rsRatioMa == null ? null : row.rsRatioMa * scaleFactor;
      return {
        ticker: row.ticker,
        name: metadata.name ?? null,
        sector: metadata.sector ?? null,
        industry: metadata.industry ?? null,
        change1d: row.change1d,
        marketCap: metadata.marketCap ?? null,
        relativeVolume: metadata.relativeVolume ?? null,
        price: row.priceClose,
        avgVolume: metadata.avgVolume ?? null,
        priceAvgVolume: metadata.priceAvgVolume ?? null,
        rsClose,
        rsMa,
        rsAboveMa: asBooleanFlag(row.rsAboveMa),
        rsNewHigh: asBooleanFlag(row.rsNewHigh),
        rsNewHighBeforePrice: asBooleanFlag(row.rsNewHighBeforePrice),
        bullCross: asBooleanFlag(row.bullCross),
        approxRsRating: row.approxRsRating,
        rawJson: JSON.stringify({
          benchmarkTicker: identity.benchmarkTicker,
          tradingDate: row.tradingDate,
          rsClose,
          rsMa,
          rsAboveMa: asBooleanFlag(row.rsAboveMa),
          rsNewHigh: asBooleanFlag(row.rsNewHigh),
          rsNewHighBeforePrice: asBooleanFlag(row.rsNewHighBeforePrice),
          bullCross: asBooleanFlag(row.bullCross),
          approxRsRating: row.approxRsRating,
          relative_volume_10d_calc: metadata.relativeVolume,
        }),
      } satisfies ScanSnapshotRow;
    })
    .filter((row): row is ScanSnapshotRow => Boolean(row));

  const rows = sortSnapshotRows(mergedRows, preset.sortField, preset.sortDirection).slice(0, preset.rowLimit);
  return {
    providerLabel: RS_PROVIDER_LABEL,
    matchedRowCount: mergedRows.length,
    status: rows.length > 0 ? "ok" : "empty",
    error: null,
    rows,
  };
}

async function loadOutputCurrentRelativeStrengthTickerSet(
  env: Env,
  identity: RelativeStrengthConfigIdentity,
  tickers: string[],
): Promise<Set<string>> {
  const latestCacheByTicker = await loadRelativeStrengthEffectiveLatestCacheRows(
    env,
    identity.configKey,
    tickers,
    identity.expectedTradingDate,
  );
  const current = new Set<string>();
  for (const ticker of Array.from(new Set(tickers.map((value) => value.toUpperCase())))) {
    const latest = latestCacheByTicker.get(ticker);
    if (latest && latest.tradingDate === identity.expectedTradingDate) {
      current.add(ticker);
    }
  }
  return current;
}

async function loadStateCurrentRelativeStrengthTickerSet(
  env: Env,
  identity: RelativeStrengthConfigIdentity,
  tickers: string[],
): Promise<Set<string>> {
  const statesByTicker = await loadRelativeStrengthConfigStateSummaries(env, identity.configKey, tickers);
  const current = new Set<string>();
  for (const ticker of Array.from(new Set(tickers.map((value) => value.toUpperCase())))) {
    const state = statesByTicker.get(ticker);
    if (state && state.stateVersion === RS_STATE_VERSION && state.latestTradingDate === identity.expectedTradingDate) {
      current.add(ticker);
    }
  }
  return current;
}

async function createRelativeStrengthRefreshJob(
  env: Env,
  preset: ScanPreset,
  requestedBy?: string | null,
  preparedCandidates?: ScanSnapshotRow[],
  currentTickerSet?: Set<string>,
  options?: { sharedRunId?: string | null; enqueue?: boolean },
): Promise<ScanRefreshJobRecord> {
  const identity = buildRelativeStrengthConfigIdentity(preset);
  const existing = await loadLatestScanRefreshJobRecordForPreset(env, preset.id, {
    activeOnly: true,
  });
  if (existing) return existing;

  const candidates = preparedCandidates ?? await fetchRelativeStrengthPrefilterRows(preset);
  const jobId = crypto.randomUUID();
  const fullCandidateCount = candidates.length;
  const currentTickers = currentTickerSet ?? new Set<string>();
  const alreadyCurrentCandidateCount = candidates.reduce((count, row) => (
    currentTickers.has(row.ticker.toUpperCase()) ? count + 1 : count
  ), 0);
  const materializationCandidateCount = Math.max(0, fullCandidateCount - alreadyCurrentCandidateCount);
  try {
    await env.DB.prepare(
      `INSERT INTO scan_refresh_jobs
        (id, preset_id, job_type, status, started_at, updated_at, error, total_candidates, processed_candidates, matched_candidates, cursor_offset, latest_snapshot_id, requested_by, benchmark_bars_json, required_bar_count, config_key, shared_run_id, expected_trading_date, benchmark_ticker, rs_ma_type, rs_ma_length, new_high_lookback, full_candidate_count, materialization_candidate_count, already_current_candidate_count, last_advanced_at, deferred_ticker_count, warning, phase)
       VALUES (?, ?, 'relative-strength', 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, ?, 0, ?, 0, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, 'queued')`,
    )
      .bind(
        jobId,
        preset.id,
        materializationCandidateCount,
        alreadyCurrentCandidateCount,
        requestedBy ?? null,
        identity.requiredBarCount,
        identity.configKey,
        options?.sharedRunId ?? null,
        identity.expectedTradingDate,
        identity.benchmarkTicker,
        identity.rsMaType,
        identity.rsMaLength,
        identity.newHighLookback,
        fullCandidateCount,
        materializationCandidateCount,
        alreadyCurrentCandidateCount,
      )
      .run();
    if (candidates.length > 0) {
      await insertRelativeStrengthJobCandidates(
        env,
        jobId,
        candidates.map((row, index) => snapshotRowToJobCandidate(row, index, !currentTickers.has(row.ticker.toUpperCase()))),
      );
    }
    if (options?.enqueue ?? false) {
      await enqueueRelativeStrengthRefreshJob(env, jobId, requestedBy ?? "created");
    }
  } catch (error) {
    await removeRelativeStrengthRefreshJobArtifacts(env, jobId);
    throw error;
  }
  const created = await loadScanRefreshJobRecord(env, jobId);
  if (!created) throw new Error("Failed to create scan refresh job.");
  return created;
}

async function listScanRefreshJobRecordsForSharedRun(
  env: Env,
  sharedRunId: string,
  options?: { activeOnly?: boolean },
): Promise<ScanRefreshJobRecord[]> {
  const clauses = ["shared_run_id = ?"];
  if (options?.activeOnly) clauses.push("status IN ('queued', 'running')");
  const rows = await env.DB.prepare(
    `SELECT
       id,
       preset_id as presetId,
       job_type as jobType,
       status,
       started_at as startedAt,
       updated_at as updatedAt,
       completed_at as completedAt,
       error,
       total_candidates as totalCandidates,
       processed_candidates as processedCandidates,
       matched_candidates as matchedCandidates,
       cursor_offset as cursorOffset,
       latest_snapshot_id as latestSnapshotId,
       requested_by as requestedBy,
       benchmark_bars_json as benchmarkBarsJson,
       required_bar_count as requiredBarCount,
       config_key as configKey,
       shared_run_id as sharedRunId,
       expected_trading_date as expectedTradingDate,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback,
       full_candidate_count as fullCandidateCount,
       materialization_candidate_count as materializationCandidateCount,
       already_current_candidate_count as alreadyCurrentCandidateCount,
       last_advanced_at as lastAdvancedAt,
       deferred_ticker_count as deferredTickerCount,
       warning,
       phase
     FROM scan_refresh_jobs
     WHERE ${clauses.join(" AND ")}
     ORDER BY datetime(started_at) ASC`,
  )
    .bind(sharedRunId)
    .all<ScanRefreshJobRecord>();
  return rows.results ?? [];
}

async function createRelativeStrengthMaterializationRun(
  env: Env,
  identity: RelativeStrengthConfigIdentity,
  source: string,
  initialStaleTickers: string[],
): Promise<RelativeStrengthMaterializationRunRecord> {
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO relative_strength_materialization_runs
      (id, config_key, expected_trading_date, benchmark_ticker, rs_ma_type, rs_ma_length, new_high_lookback, status, started_at, updated_at, error, benchmark_bars_json, required_bar_count, full_candidate_count, materialization_candidate_count, already_current_candidate_count, processed_candidates, matched_candidates, cursor_offset, last_advanced_at, deferred_ticker_count, warning, phase, lease_owner, lease_expires_at, heartbeat_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, ?, 0, 0, 0, 0, 0, 0, NULL, 0, NULL, 'queued', NULL, NULL, NULL)`,
  )
    .bind(
      runId,
      identity.configKey,
      identity.expectedTradingDate,
      identity.benchmarkTicker,
      identity.rsMaType,
      identity.rsMaLength,
      identity.newHighLookback,
      identity.requiredBarCount,
    )
    .run();
  const candidateCount = initialStaleTickers.length > 0
    ? await appendRelativeStrengthRunCandidateTickers(env, runId, initialStaleTickers)
    : 0;
  await updateRelativeStrengthMaterializationRun(env, runId, {
    materializationCandidateCount: candidateCount,
    fullCandidateCount: candidateCount,
    alreadyCurrentCandidateCount: 0,
  });
  await enqueueRelativeStrengthMaterializationRun(env, runId, source);
  const created = await loadRelativeStrengthMaterializationRun(env, runId);
  if (!created) throw new Error("Failed to create relative strength materialization run.");
  return created;
}

async function resetRelativeStrengthMaterializationRunForReuse(
  env: Env,
  run: RelativeStrengthMaterializationRunRecord,
  source: string,
  staleTickers: string[],
): Promise<RelativeStrengthMaterializationRunRecord> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM relative_strength_materialization_run_candidates WHERE run_id = ?").bind(run.id),
    env.DB.prepare("DELETE FROM relative_strength_materialization_run_deferred_tickers WHERE run_id = ?").bind(run.id),
    env.DB.prepare("DELETE FROM relative_strength_materialization_queue WHERE run_id = ?").bind(run.id),
  ]);
  await updateRelativeStrengthMaterializationRun(env, run.id, {
    status: "queued",
    completedAt: null,
    error: null,
    benchmarkBarsJson: null,
    processedCandidates: 0,
    matchedCandidates: 0,
    cursorOffset: 0,
    lastAdvancedAt: null,
    deferredTickerCount: 0,
    warning: null,
    phase: "queued",
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
  });
  const candidateCount = staleTickers.length > 0
    ? await appendRelativeStrengthRunCandidateTickers(env, run.id, staleTickers)
    : 0;
  await updateRelativeStrengthMaterializationRun(env, run.id, {
    fullCandidateCount: candidateCount,
    materializationCandidateCount: candidateCount,
    alreadyCurrentCandidateCount: 0,
  });
  await enqueueRelativeStrengthMaterializationRun(env, run.id, source);
  const reset = await loadRelativeStrengthMaterializationRun(env, run.id);
  if (!reset) throw new Error("Failed to reset relative strength materialization run.");
  return reset;
}

async function attachRelativeStrengthJobToSharedRun(
  env: Env,
  run: RelativeStrengthMaterializationRunRecord,
  job: ScanRefreshJobRecord,
  source: string,
  staleTickers?: string[],
): Promise<RelativeStrengthMaterializationRunRecord> {
  const staleCandidates = staleTickers
    ? Array.from(new Set(staleTickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)))
    : (await loadAllRelativeStrengthJobCandidates(env, job.id))
      .filter((candidate) => candidate.materializationRequired)
      .map((candidate) => candidate.ticker);
  const addedCount = await appendRelativeStrengthRunCandidateTickers(
    env,
    run.id,
    staleCandidates,
  );
  if (job.sharedRunId !== run.id) {
    await updateScanRefreshJobRecord(env, job.id, { sharedRunId: run.id });
  }
  if (addedCount > 0 || run.status === "queued") {
    const candidateCount = Math.max(
      run.materializationCandidateCount,
      run.fullCandidateCount,
      run.processedCandidates,
      run.cursorOffset,
    ) + addedCount;
    await updateRelativeStrengthMaterializationRun(env, run.id, {
      fullCandidateCount: candidateCount,
      materializationCandidateCount: candidateCount,
      alreadyCurrentCandidateCount: 0,
    });
    await enqueueRelativeStrengthMaterializationRun(env, run.id, source);
  }
  const updated = await loadRelativeStrengthMaterializationRun(env, run.id);
  if (!updated) throw new Error("Failed to load updated relative strength materialization run.");
  await synchronizeAttachedRelativeStrengthJobsForRun(env, updated);
  return updated;
}

async function ensureRelativeStrengthJobBenchmarkBars(
  env: Env,
  job: ScanRefreshJobRecord,
): Promise<RelativeStrengthDailyBar[]> {
  const identity = buildRelativeStrengthConfigIdentityFromJobRecord(job);
  const cached = deserializeBenchmarkBars(job.benchmarkBarsJson);
  if (cached.length > 0 && latestBarDate(cached) === identity.expectedTradingDate) return cached;

  const startDate = isoDateDaysAgo(calendarLookbackDaysForBars(identity.requiredBarCount));
  await ensureRelativeStrengthBenchmarkBarsCurrent(
    env,
    identity.benchmarkDataTicker,
    identity.expectedTradingDate,
    identity.requiredBarCount,
  );

  let benchmarkBars = await loadStoredDailyBarsByCount(
    env,
    [identity.benchmarkDataTicker],
    identity.expectedTradingDate,
    identity.requiredBarCount,
  );

  if (latestBarDate(benchmarkBars) !== identity.expectedTradingDate || benchmarkBars.length < identity.requiredBarCount) {
    const fallbackProvider = getProvider({ ...env, DATA_PROVIDER: "stooq" } as Env);
    await refreshDailyBarsIncremental(env, {
      tickers: [identity.benchmarkDataTicker],
      startDate,
      endDate: identity.expectedTradingDate,
      maxTickers: 1,
      provider: fallbackProvider,
    });
    benchmarkBars = await loadStoredDailyBarsByCount(
      env,
      [identity.benchmarkDataTicker],
      identity.expectedTradingDate,
      identity.requiredBarCount,
    );
  }

  if (latestBarDate(benchmarkBars) !== identity.expectedTradingDate || benchmarkBars.length === 0) {
    const fallbackBars = await fetchBenchmarkBarsWithFallback(
      env,
      identity.benchmarkDataTicker,
      startDate,
      identity.expectedTradingDate,
    );
    if (fallbackBars.length > 0) {
      await storeDailyBars(env, fallbackBars);
      benchmarkBars = chooseFresherBars(benchmarkBars, fallbackBars);
    }
  }

  if (latestBarDate(benchmarkBars) !== identity.expectedTradingDate || benchmarkBars.length === 0) {
    throw new Error(`No benchmark bars were available for ${identity.benchmarkTicker}.`);
  }
  await updateScanRefreshJobRecord(env, job.id, {
    benchmarkBarsJson: JSON.stringify(benchmarkBars),
    requiredBarCount: identity.requiredBarCount,
  });
  return benchmarkBars;
}

async function ensureRelativeStrengthRunBenchmarkBars(
  env: Env,
  run: RelativeStrengthMaterializationRunRecord,
): Promise<RelativeStrengthDailyBar[]> {
  const identity = buildRelativeStrengthConfigIdentityFromRunRecord(run);
  const cached = deserializeBenchmarkBars(run.benchmarkBarsJson);
  if (cached.length > 0 && latestBarDate(cached) === identity.expectedTradingDate) return cached;

  const startDate = isoDateDaysAgo(calendarLookbackDaysForBars(identity.requiredBarCount));
  await ensureRelativeStrengthBenchmarkBarsCurrent(
    env,
    identity.benchmarkDataTicker,
    identity.expectedTradingDate,
    identity.requiredBarCount,
  );

  let benchmarkBars = await loadStoredDailyBarsByCount(
    env,
    [identity.benchmarkDataTicker],
    identity.expectedTradingDate,
    identity.requiredBarCount,
  );

  if (latestBarDate(benchmarkBars) !== identity.expectedTradingDate || benchmarkBars.length < identity.requiredBarCount) {
    const fallbackProvider = getProvider({ ...env, DATA_PROVIDER: "stooq" } as Env);
    await refreshDailyBarsIncremental(env, {
      tickers: [identity.benchmarkDataTicker],
      startDate,
      endDate: identity.expectedTradingDate,
      maxTickers: 1,
      provider: fallbackProvider,
    });
    benchmarkBars = await loadStoredDailyBarsByCount(
      env,
      [identity.benchmarkDataTicker],
      identity.expectedTradingDate,
      identity.requiredBarCount,
    );
  }

  if (latestBarDate(benchmarkBars) !== identity.expectedTradingDate || benchmarkBars.length === 0) {
    const fallbackBars = await fetchBenchmarkBarsWithFallback(
      env,
      identity.benchmarkDataTicker,
      startDate,
      identity.expectedTradingDate,
    );
    if (fallbackBars.length > 0) {
      await storeDailyBars(env, fallbackBars);
      benchmarkBars = chooseFresherBars(benchmarkBars, fallbackBars);
    }
  }

  if (latestBarDate(benchmarkBars) !== identity.expectedTradingDate || benchmarkBars.length === 0) {
    throw new Error(`No benchmark bars were available for ${identity.benchmarkTicker}.`);
  }
  await updateRelativeStrengthMaterializationRun(env, run.id, {
    benchmarkBarsJson: JSON.stringify(benchmarkBars),
    requiredBarCount: identity.requiredBarCount,
  });
  return benchmarkBars;
}

async function materializeRelativeStrengthBatch(
  env: Env,
  job: ScanRefreshJobRecord,
  tickers: string[],
  benchmarkBars: RelativeStrengthDailyBar[],
): Promise<number> {
  const identity = buildRelativeStrengthConfigIdentityFromJobRecord(job);
  await prepareRelativeStrengthTickersForMaterialization(env, identity, tickers, benchmarkBars);
  return materializeRelativeStrengthTickers(
    env,
    identity,
    tickers,
  );
}

async function materializeRelativeStrengthRunBatch(
  env: Env,
  run: RelativeStrengthMaterializationRunRecord,
  tickers: string[],
): Promise<number> {
  return materializeRelativeStrengthTickers(
    env,
    buildRelativeStrengthConfigIdentityFromRunRecord(run),
    tickers,
  );
}

async function prepareRelativeStrengthTickersForMaterialization(
  env: Env,
  identity: RelativeStrengthConfigIdentity,
  tickers: string[],
  benchmarkBars: RelativeStrengthDailyBar[],
): Promise<void> {
  const benchmarkTicker = identity.benchmarkDataTicker;
  const candidateTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter((ticker) => ticker && ticker !== benchmarkTicker && ticker !== identity.benchmarkTicker),
  ));
  if (candidateTickers.length === 0) return;
  await ensureStoredDailyBarsCurrent(env, candidateTickers, identity.expectedTradingDate, identity.requiredBarCount);
  await ensureRelativeStrengthRatioCacheCurrent(env, candidateTickers, benchmarkBars, identity);
}

async function materializeRelativeStrengthTickers(
  env: Env,
  identity: RelativeStrengthConfigIdentity,
  tickers: string[],
): Promise<number> {
  const config = rawRelativeStrengthConfig(identity);
  const benchmarkTicker = identity.benchmarkDataTicker;
  const candidateTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter((ticker) => ticker && ticker !== benchmarkTicker && ticker !== identity.benchmarkTicker),
  ));
  if (candidateTickers.length === 0) return 0;
  const currentStatesByTicker = await loadRelativeStrengthConfigStateRows(env, identity.configKey, candidateTickers);
  const nextStateRows: RelativeStrengthConfigState[] = [];
  const nextLatestCacheRows: RelativeStrengthLatestCacheRecord[] = [];
  const bootstrapTickers: string[] = [];
  const incrementalTickers: string[] = [];
  const updatedAt = new Date().toISOString();
  let earliestIncrementalDate: string | null = null;

  for (const ticker of candidateTickers) {
    const currentState = currentStatesByTicker.get(ticker);
    if (currentState && currentState.stateVersion === RS_STATE_VERSION && currentState.latestTradingDate === identity.expectedTradingDate) {
      nextStateRows.push(currentState);
      nextLatestCacheRows.push(stateRowToLatestCacheRecord(currentState));
      continue;
    }

    if (currentState && currentState.stateVersion === RS_STATE_VERSION && currentState.latestTradingDate < identity.expectedTradingDate) {
      incrementalTickers.push(ticker);
      if (!earliestIncrementalDate || currentState.latestTradingDate < earliestIncrementalDate) {
        earliestIncrementalDate = currentState.latestTradingDate;
      }
      continue;
    }

    bootstrapTickers.push(ticker);
  }

  const incrementalRatioRowsByTicker = earliestIncrementalDate
    ? groupRatioRowsByTicker(await loadRelativeStrengthRatioRowsInRange(
      env,
      identity.benchmarkTicker,
      incrementalTickers,
      earliestIncrementalDate,
      identity.expectedTradingDate,
    ))
    : new Map<string, RelativeStrengthRatioRow[]>();

  for (const ticker of incrementalTickers) {
    const currentState = currentStatesByTicker.get(ticker);
    if (!currentState || currentState.stateVersion !== RS_STATE_VERSION) {
      bootstrapTickers.push(ticker);
      continue;
    }

    const nextRows = (incrementalRatioRowsByTicker.get(ticker) ?? [])
      .filter((row) => row.tradingDate > currentState.latestTradingDate);
    const latestRow = nextRows[nextRows.length - 1];
    if (!latestRow || latestRow.tradingDate !== identity.expectedTradingDate || nextRows.length > RS_INCREMENTAL_ADVANCE_MAX_BARS) {
      bootstrapTickers.push(ticker);
      continue;
    }

    let advancedState = currentState;
    for (const row of nextRows) {
      advancedState = advanceRelativeStrengthState(advancedState, row, config, { updatedAt }).state;
    }
    if (advancedState.latestTradingDate !== identity.expectedTradingDate) {
      bootstrapTickers.push(ticker);
      continue;
    }

    nextStateRows.push({
      ...advancedState,
      configKey: identity.configKey,
    });
    nextLatestCacheRows.push({
      ...stateRowToLatestCacheRecord(advancedState),
      ticker,
    });
  }

  if (bootstrapTickers.length > 0) {
    const bootstrapRatioRows = await loadRelativeStrengthRatioRowsByCount(
      env,
      identity.benchmarkTicker,
      bootstrapTickers,
      identity.expectedTradingDate,
      identity.requiredBarCount,
    );
    const bootstrapRatioRowsByTicker = groupRatioRowsByTicker(bootstrapRatioRows);
    for (const ticker of bootstrapTickers) {
      const bootstrapped = bootstrapRelativeStrengthStateFromRatioRows(
        bootstrapRatioRowsByTicker.get(ticker) ?? [],
        config,
        { configKey: identity.configKey, updatedAt },
      );
      if (!bootstrapped || bootstrapped.latestCacheRow.tradingDate !== identity.expectedTradingDate) continue;
      nextStateRows.push({
        ...bootstrapped.state,
        configKey: identity.configKey,
      });
      nextLatestCacheRows.push({
        ...stateRowToLatestCacheRecord(bootstrapped.state),
        ticker,
      });
    }
  }

  await upsertRelativeStrengthConfigStates(env, nextStateRows);
  await upsertRelativeStrengthLatestCacheRows(env, identity.configKey, nextLatestCacheRows);
  return nextLatestCacheRows.length;
}

async function materializeSingleRelativeStrengthTickerWithDeferral(
  env: Env,
  runId: string,
  identity: RelativeStrengthConfigIdentity,
  ticker: string,
  initialError: unknown,
): Promise<number> {
  const current = await loadRelativeStrengthDeferredTickerRow(env, runId, ticker);
  if (current?.deferredAt) return 0;
  let attemptCount = current?.attemptCount ?? 0;
  let lastErrorMessage = initialError instanceof Error ? initialError.message : "Relative strength materialization failed.";

  while (attemptCount < RS_DEFERRED_TICKER_MAX_ATTEMPTS) {
    attemptCount += 1;
    try {
      const materialized = await materializeRelativeStrengthTickers(env, identity, [ticker]);
      await upsertRelativeStrengthDeferredTickerRow(env, {
        runId,
        ticker,
        attemptCount,
        lastError: null,
        deferredAt: null,
      });
      return materialized;
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : lastErrorMessage;
    }
  }

  await upsertRelativeStrengthDeferredTickerRow(env, {
    runId,
    ticker,
    attemptCount,
    lastError: lastErrorMessage,
    deferredAt: new Date().toISOString(),
  });
  await refreshRelativeStrengthRunDeferredSummary(env, runId);
  return 0;
}

async function prepareSingleRelativeStrengthTickerWithDeferral(
  env: Env,
  runId: string,
  identity: RelativeStrengthConfigIdentity,
  ticker: string,
  benchmarkBars: RelativeStrengthDailyBar[],
  initialError: unknown,
): Promise<boolean> {
  const current = await loadRelativeStrengthDeferredTickerRow(env, runId, ticker);
  if (current?.deferredAt) return false;
  let attemptCount = current?.attemptCount ?? 0;
  let lastErrorMessage = initialError instanceof Error ? initialError.message : "Relative strength preparation failed.";

  while (attemptCount < RS_DEFERRED_TICKER_MAX_ATTEMPTS) {
    attemptCount += 1;
    try {
      await prepareRelativeStrengthTickersForMaterialization(env, identity, [ticker], benchmarkBars);
      await upsertRelativeStrengthDeferredTickerRow(env, {
        runId,
        ticker,
        attemptCount,
        lastError: null,
        deferredAt: null,
      });
      return true;
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : lastErrorMessage;
    }
  }

  await upsertRelativeStrengthDeferredTickerRow(env, {
    runId,
    ticker,
    attemptCount,
    lastError: lastErrorMessage,
    deferredAt: new Date().toISOString(),
  });
  await refreshRelativeStrengthRunDeferredSummary(env, runId);
  return false;
}

async function prepareRelativeStrengthRunTickersWithDeferral(
  env: Env,
  run: RelativeStrengthMaterializationRunRecord,
  tickers: string[],
  benchmarkBars: RelativeStrengthDailyBar[],
): Promise<{ preparedTickers: string[]; deferredTickers: string[] }> {
  const identity = buildRelativeStrengthConfigIdentityFromRunRecord(run);
  const uniqueTickers = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  if (uniqueTickers.length === 0) return { preparedTickers: [], deferredTickers: [] };
  try {
    await prepareRelativeStrengthTickersForMaterialization(env, identity, uniqueTickers, benchmarkBars);
    return { preparedTickers: uniqueTickers, deferredTickers: [] };
  } catch (error) {
    if (uniqueTickers.length === 1) {
      const prepared = await prepareSingleRelativeStrengthTickerWithDeferral(
        env,
        run.id,
        identity,
        uniqueTickers[0],
        benchmarkBars,
        error,
      );
      return {
        preparedTickers: prepared ? uniqueTickers : [],
        deferredTickers: prepared ? [] : uniqueTickers,
      };
    }
    const midpoint = Math.max(1, Math.floor(uniqueTickers.length / 2));
    const left = await prepareRelativeStrengthRunTickersWithDeferral(
      env,
      run,
      uniqueTickers.slice(0, midpoint),
      benchmarkBars,
    );
    const right = await prepareRelativeStrengthRunTickersWithDeferral(
      env,
      run,
      uniqueTickers.slice(midpoint),
      benchmarkBars,
    );
    return {
      preparedTickers: [...left.preparedTickers, ...right.preparedTickers],
      deferredTickers: [...left.deferredTickers, ...right.deferredTickers],
    };
  }
}

async function materializeRelativeStrengthRunTickersWithDeferral(
  env: Env,
  run: RelativeStrengthMaterializationRunRecord,
  tickers: string[],
): Promise<number> {
  const identity = buildRelativeStrengthConfigIdentityFromRunRecord(run);
  const uniqueTickers = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  if (uniqueTickers.length === 0) return 0;
  try {
    return await materializeRelativeStrengthRunBatch(env, run, uniqueTickers);
  } catch (error) {
    if (uniqueTickers.length === 1) {
      return materializeSingleRelativeStrengthTickerWithDeferral(env, run.id, identity, uniqueTickers[0], error);
    }
    const midpoint = Math.max(1, Math.floor(uniqueTickers.length / 2));
    const left = uniqueTickers.slice(0, midpoint);
    const right = uniqueTickers.slice(midpoint);
    const leftCount = await materializeRelativeStrengthRunTickersWithDeferral(env, run, left);
    const rightCount = await materializeRelativeStrengthRunTickersWithDeferral(env, run, right);
    return leftCount + rightCount;
  }
}

async function storeScanSnapshotResult(
  env: Env,
  preset: ScanPreset,
  result: {
    providerLabel: string;
    matchedRowCount: number;
    status: "ok" | "warning" | "error" | "empty";
    error: string | null;
    rows: ScanSnapshotRow[];
  },
): Promise<string> {
  const snapshotId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO scan_snapshots (id, preset_id, provider_label, generated_at, row_count, matched_row_count, status, error) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?)",
    ).bind(snapshotId, preset.id, result.providerLabel, result.rows.length, result.matchedRowCount, result.status, result.error),
    ...result.rows.map((row) =>
      env.DB.prepare(
        "INSERT INTO scan_rows (id, snapshot_id, ticker, name, sector, industry, change_1d, market_cap, price, avg_volume, price_avg_volume, raw_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
      ).bind(
        crypto.randomUUID(),
        snapshotId,
        row.ticker,
        row.name ?? null,
        row.sector ?? null,
        row.industry ?? null,
        row.change1d,
        row.marketCap,
        row.price,
        row.avgVolume,
        row.priceAvgVolume,
        row.rawJson,
      ),
    ),
  ]);
  return snapshotId;
}

async function ensureRelativeStrengthSnapshotCurrent(
  env: Env,
  preset: ScanPreset,
  completedJob: ScanRefreshJobRecord,
): Promise<ScanSnapshot> {
  const usableSnapshot = await loadLatestUsableScansSnapshot(env, preset.id);
  if (snapshotIsFreshForCompletedJob(usableSnapshot, completedJob)) {
    return usableSnapshot;
  }
  const result = await refreshRelativeStrengthSnapshot(env, preset, completedJob);
  await upsertSymbolsFromRows(env, result.rows);
  await storeScanSnapshotResult(env, preset, result);
  const snapshot = await loadLatestScansSnapshot(env, preset.id);
  if (!snapshot) throw new Error("Failed to load refreshed scan snapshot.");
  return snapshot;
}

async function synchronizeAttachedRelativeStrengthJobsForRun(
  env: Env,
  run: RelativeStrengthMaterializationRunRecord,
): Promise<void> {
  const attachedJobs = await listScanRefreshJobRecordsForSharedRun(env, run.id, {
    activeOnly: run.status !== "completed" && run.status !== "failed",
  });
  const nowIso = new Date().toISOString();
  for (const job of attachedJobs) {
    if (run.status === "failed") {
      await updateScanRefreshJobRecord(env, job.id, {
        status: "failed",
        error: run.error ?? "Relative strength refresh failed.",
        completedAt: nowIso,
        lastAdvancedAt: run.lastAdvancedAt ?? nowIso,
        deferredTickerCount: run.deferredTickerCount,
        warning: run.warning,
        phase: run.phase,
      });
      continue;
    }
    if (run.status === "completed") {
      await updateScanRefreshJobRecord(env, job.id, {
        status: "completed",
        processedCandidates: job.materializationCandidateCount,
        matchedCandidates: Math.max(job.matchedCandidates, job.alreadyCurrentCandidateCount + Math.min(job.materializationCandidateCount, run.matchedCandidates)),
        cursorOffset: job.materializationCandidateCount,
        completedAt: nowIso,
        lastAdvancedAt: run.lastAdvancedAt ?? nowIso,
        deferredTickerCount: run.deferredTickerCount,
        warning: run.warning,
        phase: run.phase,
      });
      const completedJob = await loadScanRefreshJobRecord(env, job.id);
      const preset = await loadScanPreset(env, job.presetId);
      if (!completedJob || !preset) continue;
      const snapshot = await ensureRelativeStrengthSnapshotCurrent(env, preset, completedJob);
      await updateScanRefreshJobRecord(env, job.id, {
        latestSnapshotId: snapshot.id,
        matchedCandidates: snapshot.matchedRowCount,
      });
      continue;
    }
    const processedCandidates = Math.min(job.materializationCandidateCount, run.processedCandidates);
    await updateScanRefreshJobRecord(env, job.id, {
      status: run.status,
      processedCandidates,
      matchedCandidates: Math.max(job.matchedCandidates, job.alreadyCurrentCandidateCount + processedCandidates),
      cursorOffset: processedCandidates,
      lastAdvancedAt: run.lastAdvancedAt,
      deferredTickerCount: run.deferredTickerCount,
      warning: run.warning,
      phase: run.phase,
    });
  }
}

async function processRelativeStrengthMaterializationRun(
  env: Env,
  runId: string,
  options?: { timeBudgetMs?: number; maxBatches?: number; batchSize?: number; leaseOwner?: string },
): Promise<RelativeStrengthMaterializationRunRecord | null> {
  const run = await loadRelativeStrengthMaterializationRun(env, runId);
  if (!run) return null;
  if (run.status === "completed" || run.status === "failed") return run;
  const leaseOwner = options?.leaseOwner ?? crypto.randomUUID();
  const leasedRun = await tryAcquireRelativeStrengthMaterializationRunLease(env, run.id, leaseOwner, "queued");
  if (!leasedRun) {
    return loadRelativeStrengthMaterializationRun(env, run.id);
  }
  const identity = buildRelativeStrengthConfigIdentityFromRunRecord(leasedRun);

  try {
    const effectiveMaterializationTotal = Math.max(
      leasedRun.materializationCandidateCount,
      leasedRun.fullCandidateCount,
      leasedRun.processedCandidates,
      leasedRun.cursorOffset,
    );
    if (effectiveMaterializationTotal > 0 && !(await hasRelativeStrengthRunCandidates(env, leasedRun.id))) {
      throw new Error("Relative strength materialization run is missing candidate rows.");
    }
    if (effectiveMaterializationTotal === 0 || leasedRun.cursorOffset >= effectiveMaterializationTotal) {
      await updateRelativeStrengthMaterializationRun(env, leasedRun.id, {
        status: "completed",
        processedCandidates: effectiveMaterializationTotal,
        matchedCandidates: effectiveMaterializationTotal,
        cursorOffset: effectiveMaterializationTotal,
        materializationCandidateCount: effectiveMaterializationTotal,
        fullCandidateCount: Math.max(leasedRun.fullCandidateCount, effectiveMaterializationTotal),
        completedAt: new Date().toISOString(),
        lastAdvancedAt: new Date().toISOString(),
        phase: "completed",
      });
      await removeRelativeStrengthMaterializationRunFromQueue(env, leasedRun.id);
      const completed = await loadRelativeStrengthMaterializationRun(env, leasedRun.id);
      if (completed) await synchronizeAttachedRelativeStrengthJobsForRun(env, completed);
      return completed;
    }

    await updateRelativeStrengthMaterializationRun(env, leasedRun.id, {
      status: "running",
      materializationCandidateCount: effectiveMaterializationTotal,
      fullCandidateCount: Math.max(leasedRun.fullCandidateCount, effectiveMaterializationTotal),
      phase: "running",
    });
    const currentRun = (await loadRelativeStrengthMaterializationRun(env, leasedRun.id)) ?? leasedRun;
    const benchmarkBars = await ensureRelativeStrengthRunBenchmarkBars(env, currentRun);
    let cursorOffset = currentRun.cursorOffset;
    let matchedCandidates = currentRun.matchedCandidates;
    const startedAt = Date.now();
    const timeBudgetMs = options?.timeBudgetMs ?? RS_JOB_TIME_BUDGET_MS;
    const maxBatches = Math.max(1, options?.maxBatches ?? Number.POSITIVE_INFINITY);
    const batchSize = Math.max(1, options?.batchSize ?? RS_DEFAULT_COMPUTE_BATCH_SIZE);
    const preparedSliceSize = Math.max(batchSize, RS_PREPARED_SLICE_SIZE);
    let processedBatchCount = 0;

    while (cursorOffset < effectiveMaterializationTotal && Date.now() - startedAt < timeBudgetMs && processedBatchCount < maxBatches) {
      const preparedSliceTickers = await loadRelativeStrengthRunCandidateTickers(env, currentRun.id, cursorOffset, preparedSliceSize);
      if (preparedSliceTickers.length === 0) {
        throw new Error("Relative strength materialization run has no remaining candidate rows to process.");
      }
      await heartbeatRelativeStrengthMaterializationRunLease(env, currentRun.id, leaseOwner, "preparing");
      const { preparedTickers, deferredTickers } = await prepareRelativeStrengthRunTickersWithDeferral(
        env,
        currentRun,
        preparedSliceTickers,
        benchmarkBars,
      );
      const preparedTickerSet = new Set(preparedTickers);
      const deferredTickerSet = new Set(deferredTickers);

      for (
        let preparedSliceOffset = 0;
        preparedSliceOffset < preparedSliceTickers.length && cursorOffset < effectiveMaterializationTotal && Date.now() - startedAt < timeBudgetMs && processedBatchCount < maxBatches;
        preparedSliceOffset += batchSize
      ) {
        const batchTickers = preparedSliceTickers.slice(preparedSliceOffset, preparedSliceOffset + batchSize);
        const materializableBatchTickers = batchTickers.filter((ticker) => preparedTickerSet.has(ticker));
        const deferredInBatch = batchTickers.filter((ticker) => deferredTickerSet.has(ticker)).length;
        await heartbeatRelativeStrengthMaterializationRunLease(
          env,
          currentRun.id,
          leaseOwner,
          materializableBatchTickers.length > 0 ? "materializing" : "deferring",
        );
        const materializedCount = materializableBatchTickers.length > 0
          ? await materializeRelativeStrengthRunTickersWithDeferral(env, currentRun, materializableBatchTickers)
          : 0;
        matchedCandidates += materializedCount;
        cursorOffset += batchTickers.length;
        processedBatchCount += 1;
        const refreshedRun = await loadRelativeStrengthMaterializationRun(env, currentRun.id);
        const lastAdvancedAt = new Date().toISOString();
        await updateRelativeStrengthMaterializationRun(env, currentRun.id, {
          status: "running",
          processedCandidates: cursorOffset,
          matchedCandidates,
          cursorOffset,
          materializationCandidateCount: effectiveMaterializationTotal,
          fullCandidateCount: Math.max(currentRun.fullCandidateCount, effectiveMaterializationTotal),
          lastAdvancedAt,
          deferredTickerCount: refreshedRun?.deferredTickerCount ?? currentRun.deferredTickerCount,
          warning: refreshedRun?.warning ?? currentRun.warning,
          phase: materializableBatchTickers.length > 0 ? "materializing" : (deferredInBatch > 0 ? "deferring" : "materializing"),
        });
      }
    }

    const latestRun = await loadRelativeStrengthMaterializationRun(env, currentRun.id);
    const finalMaterializationTotal = Math.max(
      latestRun?.materializationCandidateCount ?? effectiveMaterializationTotal,
      latestRun?.fullCandidateCount ?? effectiveMaterializationTotal,
      latestRun?.processedCandidates ?? cursorOffset,
      latestRun?.cursorOffset ?? cursorOffset,
    );

    if (cursorOffset >= finalMaterializationTotal) {
      await updateRelativeStrengthMaterializationRun(env, currentRun.id, {
        status: "completed",
        processedCandidates: cursorOffset,
        matchedCandidates,
        cursorOffset,
        materializationCandidateCount: finalMaterializationTotal,
        fullCandidateCount: Math.max(currentRun.fullCandidateCount, finalMaterializationTotal),
        completedAt: new Date().toISOString(),
        lastAdvancedAt: new Date().toISOString(),
        phase: "completed",
      });
      await removeRelativeStrengthMaterializationRunFromQueue(env, currentRun.id);
    } else if (finalMaterializationTotal > 0) {
      await updateRelativeStrengthMaterializationRun(env, currentRun.id, {
        status: "running",
        materializationCandidateCount: finalMaterializationTotal,
        fullCandidateCount: Math.max(currentRun.fullCandidateCount, finalMaterializationTotal),
        phase: "queued",
      });
      await enqueueRelativeStrengthMaterializationRun(env, currentRun.id, "continuation");
    }
  } catch (error) {
    await updateRelativeStrengthMaterializationRun(env, leasedRun.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Relative strength refresh failed.",
      completedAt: new Date().toISOString(),
      lastAdvancedAt: new Date().toISOString(),
      phase: "failed",
    });
    await removeRelativeStrengthMaterializationRunFromQueue(env, leasedRun.id);
  } finally {
    await releaseRelativeStrengthMaterializationRunLease(env, leasedRun.id, leaseOwner);
  }

  const updated = await loadRelativeStrengthMaterializationRun(env, leasedRun.id);
  if (updated) await synchronizeAttachedRelativeStrengthJobsForRun(env, updated);
  return updated;
}

export async function processRelativeStrengthRefreshJob(
  env: Env,
  jobId: string,
  options?: { timeBudgetMs?: number; maxBatches?: number; batchSize?: number },
): Promise<ScanRefreshJob | null> {
  const job = await loadScanRefreshJobRecord(env, jobId);
  if (!job) return null;
  const preset = await loadScanPreset(env, job.presetId);
  if (!preset || preset.scanType !== "relative-strength") return null;
  if (job.status === "completed" || job.status === "failed") {
    return mapJobRecordToJob(job, preset);
  }
  if (job.sharedRunId) {
    const processedRun = await processRelativeStrengthMaterializationRun(env, job.sharedRunId, options);
    if (!processedRun) {
      await invalidateRelativeStrengthRefreshJob(env, job.id, "Relative strength shared materialization run could not be loaded.");
    }
    const updatedJob = await loadScanRefreshJobRecord(env, jobId);
    return updatedJob ? mapJobRecordToJob(updatedJob, preset) : null;
  }

  try {
    const effectiveMaterializationTotal = Math.max(0, job.materializationCandidateCount);
    const effectiveFullCandidateTotal = Math.max(
      job.fullCandidateCount,
      job.alreadyCurrentCandidateCount + effectiveMaterializationTotal,
      job.totalCandidates,
    );
    const hasStoredCandidates = effectiveFullCandidateTotal === 0 || await hasRelativeStrengthJobCandidates(env, job.id);
    if (!hasStoredCandidates && (job.totalCandidates > 0 || job.fullCandidateCount > 0 || job.materializationCandidateCount > 0)) {
      throw new Error("Relative strength refresh job is missing candidate rows.");
    }
    if (effectiveMaterializationTotal === 0 || job.cursorOffset >= effectiveMaterializationTotal) {
      await updateScanRefreshJobRecord(env, job.id, {
        status: "completed",
        processedCandidates: effectiveMaterializationTotal,
        matchedCandidates: Math.max(job.matchedCandidates, job.alreadyCurrentCandidateCount),
        cursorOffset: effectiveMaterializationTotal,
        fullCandidateCount: effectiveFullCandidateTotal,
        materializationCandidateCount: effectiveMaterializationTotal,
        completedAt: new Date().toISOString(),
        lastAdvancedAt: new Date().toISOString(),
      });
      await removeRelativeStrengthRefreshJobFromQueue(env, job.id);
      const completed = await loadScanRefreshJobRecord(env, job.id);
      return completed ? mapJobRecordToJob(completed, preset) : null;
    }
    await updateScanRefreshJobRecord(env, job.id, { status: "running" });
    const benchmarkBars = await ensureRelativeStrengthJobBenchmarkBars(env, job);
    let cursorOffset = job.cursorOffset;
    let matchedCandidates = job.matchedCandidates;
    const startedAt = Date.now();
    const timeBudgetMs = options?.timeBudgetMs ?? RS_JOB_TIME_BUDGET_MS;
    const maxBatches = Math.max(1, options?.maxBatches ?? Number.POSITIVE_INFINITY);
    const batchSize = Math.max(1, options?.batchSize ?? RS_DEFAULT_COMPUTE_BATCH_SIZE);
    let processedBatchCount = 0;

    while (cursorOffset < effectiveMaterializationTotal && Date.now() - startedAt < timeBudgetMs && processedBatchCount < maxBatches) {
      const batchCandidates = await loadRelativeStrengthJobCandidates(env, job.id, cursorOffset, batchSize);
      if (batchCandidates.length === 0) {
        throw new Error("Relative strength refresh job has no remaining candidate rows to process.");
      }
      const materializedCount = await materializeRelativeStrengthBatch(
        env,
        job,
        batchCandidates.map((candidate) => candidate.ticker),
        benchmarkBars,
      );
      matchedCandidates += materializedCount;
      cursorOffset += batchCandidates.length;
      processedBatchCount += 1;
      const lastAdvancedAt = new Date().toISOString();
      await updateScanRefreshJobRecord(env, job.id, {
        status: "running",
        processedCandidates: cursorOffset,
        matchedCandidates,
        cursorOffset,
        lastAdvancedAt,
      });
    }

    if (cursorOffset >= effectiveMaterializationTotal) {
      await updateScanRefreshJobRecord(env, job.id, {
        status: "completed",
        processedCandidates: cursorOffset,
        matchedCandidates,
        cursorOffset,
        fullCandidateCount: effectiveFullCandidateTotal,
        materializationCandidateCount: effectiveMaterializationTotal,
        completedAt: new Date().toISOString(),
        lastAdvancedAt: new Date().toISOString(),
      });
      await removeRelativeStrengthRefreshJobFromQueue(env, job.id);
    } else if (effectiveMaterializationTotal > 0) {
      await enqueueRelativeStrengthRefreshJob(env, job.id, "continuation");
    }
  } catch (error) {
    await invalidateRelativeStrengthRefreshJob(
      env,
      job.id,
      error instanceof Error ? error.message : "Relative strength refresh failed.",
    );
  }

  const updated = await loadScanRefreshJobRecord(env, job.id);
  return updated ? mapJobRecordToJob(updated, preset) : null;
}

export async function requestScansRefresh(
  env: Env,
  presetId?: string | null,
  requestedBy?: string | null,
): Promise<ScanRefreshResponse> {
  const preset = presetId ? await loadScanPreset(env, presetId) : await loadDefaultScanPreset(env);
  if (!preset) throw new Error("No scan preset is configured.");
  if (preset.scanType === "vcp") {
    if (!hasScannerCacheStorage(env)) {
      throw new Error("VCP scans require the SCANNER_CACHE_DB binding.");
    }
    if (requestedBy !== "manual") {
      return {
        async: false,
        snapshot: await loadLatestUsableScansSnapshot(env, preset.id),
        job: null,
      };
    }
    const identity = buildVcpConfigIdentity(preset);
    const completed = await loadLatestCompletedVcpRunForPreset(env, preset.id, identity.configKey, identity.expectedTradingDate);
    if (completed) {
      return {
        async: false,
        snapshot: await loadLatestUsableScansSnapshot(env, preset.id),
        job: null,
      };
    }
    const run = await createVcpScanRun(env, preset, requestedBy);
    return {
      async: isActiveScanStatus(run.status),
      snapshot: await loadLatestUsableScansSnapshot(env, preset.id),
      job: mapVcpRunRecordToJob(run),
    };
  }
  if (preset.scanType !== "relative-strength") {
    return {
      async: false,
      snapshot: await refreshScansSnapshot(env, preset.id),
      job: null,
    };
  }
  if (hasScannerCacheStorage(env)) {
    if (requestedBy !== "manual") {
      return {
        async: false,
        snapshot: await loadLatestUsableScansSnapshot(env, preset.id),
        job: null,
      };
    }
    const identity = buildRelativeStrengthConfigIdentity(preset);
    const run = await createManualRelativeStrengthRun(env, preset, requestedBy);
    return {
      async: isActiveScanStatus(run.status),
      snapshot: await loadLatestUsableScansSnapshot(env, preset.id),
      job: mapManualRunRecordToJob(run, { appliesToPreset: run.configKey === identity.configKey }),
    };
  }
  const identity = buildRelativeStrengthConfigIdentity(preset);
  let activeJob = await loadLatestScanRefreshJobRecordForPreset(env, preset.id, { activeOnly: true });
  if (activeJob) {
    const effectiveMaterializationTotal = Math.max(0, activeJob.materializationCandidateCount);
    const effectiveFullCandidateTotal = Math.max(
      activeJob.fullCandidateCount,
      activeJob.alreadyCurrentCandidateCount + effectiveMaterializationTotal,
      activeJob.totalCandidates,
    );
    const hasStoredCandidates = effectiveFullCandidateTotal === 0 || await hasRelativeStrengthJobCandidates(env, activeJob.id);
    if (!hasStoredCandidates && (activeJob.totalCandidates > 0 || activeJob.fullCandidateCount > 0 || activeJob.materializationCandidateCount > 0)) {
      await invalidateRelativeStrengthRefreshJob(
        env,
        activeJob.id,
        "Relative strength refresh job is missing candidate rows and was reset.",
      );
      activeJob = null;
    } else if (effectiveMaterializationTotal === 0) {
      await updateScanRefreshJobRecord(env, activeJob.id, {
        status: "completed",
        processedCandidates: 0,
        matchedCandidates: Math.max(activeJob.matchedCandidates, activeJob.alreadyCurrentCandidateCount),
        cursorOffset: 0,
        fullCandidateCount: effectiveFullCandidateTotal,
        materializationCandidateCount: 0,
        completedAt: new Date().toISOString(),
        lastAdvancedAt: new Date().toISOString(),
      });
      await removeRelativeStrengthRefreshJobFromQueue(env, activeJob.id);
      const completed = await loadScanRefreshJobRecord(env, activeJob.id);
      if (completed) {
        return {
          async: false,
          snapshot: await ensureRelativeStrengthSnapshotCurrent(env, preset, completed),
          job: null,
        };
      }
      activeJob = null;
    }
  }
  if (activeJob) {
    return {
      async: true,
      snapshot: await loadLatestUsableScansSnapshot(env, preset.id),
      job: mapJobRecordToJob(activeJob, preset),
    };
  }
  const completedJob = await loadLatestCompletedScanRefreshJobRecordForPreset(env, preset.id, identity.expectedTradingDate);
  if (completedJob) {
    return {
      async: false,
      snapshot: await ensureRelativeStrengthSnapshotCurrent(env, preset, completedJob),
      job: null,
    };
  }
  const candidates = await fetchRelativeStrengthPrefilterRows(preset);
  const currentTickerSet = await loadOutputCurrentRelativeStrengthTickerSet(
    env,
    identity,
    candidates.map((row) => row.ticker),
  );
  if (currentTickerSet.size === candidates.length) {
    const result = await buildRelativeStrengthSnapshotResult(
      env,
      preset,
      candidates.map((row, index) => snapshotRowToJobCandidate(row, index, false)),
      identity.configKey,
      identity.expectedTradingDate,
    );
    await upsertSymbolsFromRows(env, result.rows);
    await storeScanSnapshotResult(env, preset, result);
    return {
      async: false,
      snapshot: await loadLatestScansSnapshot(env, preset.id),
      job: null,
    };
  }
  const staleTickers = candidates
    .map((row) => row.ticker.toUpperCase())
    .filter((ticker) => !currentTickerSet.has(ticker));
  const activeRun = await loadActiveRelativeStrengthMaterializationRunForConfig(
    env,
    identity.configKey,
    identity.expectedTradingDate,
  );
  const existingRun = activeRun ?? await loadLatestRelativeStrengthMaterializationRunForConfig(
    env,
    identity.configKey,
    identity.expectedTradingDate,
  );

  let jobRecord: ScanRefreshJobRecord;
  if (activeRun) {
    jobRecord = await createRelativeStrengthRefreshJob(
      env,
      preset,
      requestedBy,
      candidates,
      currentTickerSet,
      { sharedRunId: activeRun.id, enqueue: false },
    );
    await attachRelativeStrengthJobToSharedRun(env, activeRun, jobRecord, requestedBy ?? "manual", staleTickers);
  } else {
    jobRecord = await createRelativeStrengthRefreshJob(
      env,
      preset,
      requestedBy,
      candidates,
      currentTickerSet,
      { enqueue: false },
    );
    let createdRunId: string | null = null;
    try {
      const run = existingRun
        ? await resetRelativeStrengthMaterializationRunForReuse(
          env,
          existingRun,
          requestedBy ?? "manual",
          staleTickers,
        )
        : await createRelativeStrengthMaterializationRun(
          env,
          identity,
          requestedBy ?? "manual",
          staleTickers,
        );
      createdRunId = run.id;
      await updateScanRefreshJobRecord(env, jobRecord.id, { sharedRunId: run.id });
      const updatedJob = await loadScanRefreshJobRecord(env, jobRecord.id);
      if (updatedJob) jobRecord = updatedJob;
    } catch (error) {
      if (createdRunId) {
        await removeRelativeStrengthMaterializationRunArtifacts(env, createdRunId);
      }
      await removeRelativeStrengthRefreshJobArtifacts(env, jobRecord.id);
      throw error;
    }
  }
  return {
    async: true,
    snapshot: await loadLatestUsableScansSnapshot(env, preset.id),
    job: mapJobRecordToJob(jobRecord, preset),
  };
}

export async function loadScanRefreshJob(
  env: Env,
  jobId: string,
): Promise<{ job: ScanRefreshJob; snapshot: ScanSnapshot | null } | null> {
  const manualRun = await loadManualRelativeStrengthRun(env, jobId);
  if (manualRun) {
    return {
      job: mapManualRunRecordToJob(manualRun),
      snapshot: manualRun.status === "completed"
        ? await loadLatestScansSnapshot(env, manualRun.presetId)
        : await loadLatestUsableScansSnapshot(env, manualRun.presetId),
    };
  }
  const vcpRun = await loadVcpRun(env, jobId);
  if (vcpRun) {
    return {
      job: mapVcpRunRecordToJob(vcpRun),
      snapshot: vcpRun.status === "completed"
        ? await loadLatestScansSnapshot(env, vcpRun.presetId)
        : await loadLatestUsableScansSnapshot(env, vcpRun.presetId),
    };
  }
  const record = await loadScanRefreshJobRecord(env, jobId);
  if (!record) return null;
  const preset = await loadScanPreset(env, record.presetId);
  if (!preset) return null;
  const snapshot = record.status === "completed"
    ? await ensureRelativeStrengthSnapshotCurrent(env, preset, record)
    : await loadLatestUsableScansSnapshot(env, preset.id);
  return {
    job: mapJobRecordToJob(record, preset),
    snapshot,
  };
}

export async function loadLatestActiveScanRefreshJob(
  env: Env,
  presetId: string,
): Promise<{ job: ScanRefreshJob; snapshot: ScanSnapshot | null } | null> {
  const preset = await loadScanPreset(env, presetId);
  if (!preset) return null;
  if (preset.scanType === "vcp") {
    const identity = buildVcpConfigIdentity(preset);
    const activeRun = await loadActiveVcpRun(env);
    if (activeRun) {
      return {
        job: mapVcpRunRecordToJob(activeRun),
        snapshot: await loadLatestUsableScansSnapshot(env, preset.id),
      };
    }
    const completed = await loadLatestCompletedVcpRunForPreset(env, preset.id, identity.configKey, identity.expectedTradingDate);
    if (!completed) return null;
    return {
      job: mapVcpRunRecordToJob(completed),
      snapshot: await loadLatestUsableScansSnapshot(env, preset.id),
    };
  }
  if (preset.scanType !== "relative-strength") return null;
  const identity = buildRelativeStrengthConfigIdentity(preset);
  const manualRun = await loadActiveManualRelativeStrengthRun(env);
  if (manualRun) {
    const appliesToPreset = manualRun.configKey === identity.configKey;
    return {
      job: mapManualRunRecordToJob(manualRun, { appliesToPreset }),
      snapshot: await loadLatestUsableScansSnapshot(env, preset.id),
    };
  }
  if (hasScannerCacheStorage(env)) {
    const completed = await loadLatestCompletedManualRelativeStrengthRunForConfig(env, identity.configKey);
    if (!completed) return null;
    return {
      job: mapManualRunRecordToJob(completed, { appliesToPreset: true }),
      snapshot: await loadLatestUsableScansSnapshot(env, preset.id),
    };
  }
  const record = await loadLatestScanRefreshJobRecordForPreset(env, presetId, { activeOnly: true });
  if (!record) return null;
  return {
    job: mapJobRecordToJob(record, preset),
    snapshot: await loadLatestUsableScansSnapshot(env, preset.id),
  };
}

export async function processQueuedRelativeStrengthRefreshJobs(
  env: Env,
  options?: { timeBudgetMs?: number; maxBatches?: number; batchSize?: number },
): Promise<ScanRefreshJob[]> {
  const startedAt = Date.now();
  const totalTimeBudgetMs = Math.max(1_000, options?.timeBudgetMs ?? RS_JOB_TIME_BUDGET_MS);
  let remainingBatches = options?.maxBatches == null
    ? Number.POSITIVE_INFINITY
    : Math.max(1, options.maxBatches);
  const processedByJobId = new Map<string, ScanRefreshJob>();
  const runBatchBurst = Math.max(1, Math.min(remainingBatches === Number.POSITIVE_INFINITY ? 3 : remainingBatches, 3));

  while (remainingBatches > 0 && Date.now() - startedAt < totalTimeBudgetMs) {
    const activeRuns = await listActiveRelativeStrengthMaterializationRuns(env);
    if (activeRuns.length === 0) break;
    const activeRunsById = new Map(activeRuns.map((run) => [run.id, run] as const));
    const queuedRows = await listQueuedRelativeStrengthMaterializationRuns(env);
    const queuedRunIds = new Set(queuedRows.map((row) => row.runId));
    for (const activeRun of activeRuns) {
      const staleThreshold = activeRun.status === "running" ? RS_JOB_RECOVERY_STALE_MS : RS_JOB_CONTINUATION_STALE_MS;
      if (!queuedRunIds.has(activeRun.id) && !isRelativeStrengthRunLeaseActive(activeRun) && runNeedsRelativeStrengthContinuation(activeRun, staleThreshold)) {
        await enqueueRelativeStrengthMaterializationRun(env, activeRun.id, "recovery");
      }
    }
    const refreshedQueue = await listQueuedRelativeStrengthMaterializationRuns(env);
    const runsToProcess = refreshedQueue
      .map((row) => activeRunsById.get(row.runId))
      .filter((run): run is RelativeStrengthMaterializationRunRecord => Boolean(run) && !isRelativeStrengthRunLeaseActive(run));
    if (runsToProcess.length === 0) break;

    let advancedAny = false;
    for (const activeRun of runsToProcess) {
      if (remainingBatches <= 0 || Date.now() - startedAt >= totalTimeBudgetMs) break;
      const remainingTimeBudgetMs = Math.max(1_000, totalTimeBudgetMs - (Date.now() - startedAt));
      await markRelativeStrengthMaterializationRunQueueAttempt(env, activeRun.id);
      const batchBurst = remainingBatches === Number.POSITIVE_INFINITY
        ? runBatchBurst
        : Math.max(1, Math.min(runBatchBurst, remainingBatches));
      const processedRun = await processRelativeStrengthMaterializationRun(env, activeRun.id, {
        maxBatches: batchBurst,
        timeBudgetMs: remainingTimeBudgetMs,
        batchSize: options?.batchSize,
      });
      if (!processedRun) continue;

      const advanced = processedRun.status === "completed"
        || processedRun.status === "failed"
        || processedRun.processedCandidates > activeRun.processedCandidates
        || processedRun.cursorOffset > activeRun.cursorOffset;
      if (advanced) {
        remainingBatches -= batchBurst;
        advancedAny = true;
      }
      const attachedJobs = await listScanRefreshJobRecordsForSharedRun(env, processedRun.id);
      for (const job of attachedJobs) {
        const preset = await loadScanPreset(env, job.presetId);
        if (!preset) continue;
        const refreshedJob = await loadScanRefreshJobRecord(env, job.id);
        if (!refreshedJob) continue;
        processedByJobId.set(job.id, mapJobRecordToJob(refreshedJob, preset));
      }
    }

    if (!advancedAny) break;
  }

  return Array.from(processedByJobId.values());
}

export async function refreshActiveRelativeStrengthPresets(
  env: Env,
  options?: { timeBudgetMs?: number; maxBatches?: number; batchSize?: number },
): Promise<ScanRefreshJob[]> {
  const presets = (await listScanPresets(env))
    .filter((preset) => preset.isActive && preset.scanType === "relative-strength");
  const presetIds = new Set(presets.map((preset) => preset.id));
  const completedJobsByPresetId = new Map<string, ScanRefreshJobRecord>();
  for (const preset of presets) {
    const identity = buildRelativeStrengthConfigIdentity(preset);
    const completed = await loadLatestCompletedScanRefreshJobRecordForPreset(env, preset.id, identity.expectedTradingDate);
    if (completed) {
      completedJobsByPresetId.set(preset.id, completed);
      continue;
    }
    const active = await loadLatestScanRefreshJobRecordForPreset(env, preset.id, { activeOnly: true });
    if (!active) {
      await requestScansRefresh(env, preset.id, "scheduled");
    }
  }
  const jobs = await processQueuedRelativeStrengthRefreshJobs(env, options);
  for (const preset of presets) {
    const identity = buildRelativeStrengthConfigIdentity(preset);
    const completed = completedJobsByPresetId.get(preset.id)
      ?? await loadLatestCompletedScanRefreshJobRecordForPreset(env, preset.id, identity.expectedTradingDate);
    if (completed) {
      completedJobsByPresetId.set(preset.id, completed);
    }
  }
  for (const preset of presets) {
    const completed = completedJobsByPresetId.get(preset.id);
    if (!completed) continue;
    await ensureRelativeStrengthSnapshotCurrent(env, preset, completed);
  }
  return jobs.filter((job) => presetIds.has(job.presetId));
}

type ScanSnapshotHeader = {
  id: string;
  presetId: string;
  providerLabel: string;
  generatedAt: string;
  rowCount: number;
  matchedRowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
};

async function loadLatestScanSnapshotHeader(
  env: Env,
  presetId: string,
  options?: { usableOnly?: boolean },
): Promise<ScanSnapshotHeader | null> {
  const clauses = ["preset_id = ?"];
  if (options?.usableOnly) clauses.push("status != 'error'");
  return env.DB.prepare(
    `SELECT
       id,
       preset_id as presetId,
       provider_label as providerLabel,
       generated_at as generatedAt,
       row_count as rowCount,
       COALESCE(matched_row_count, row_count) as matchedRowCount,
       status,
       error
     FROM scan_snapshots
     WHERE ${clauses.join(" AND ")}
     ORDER BY datetime(generated_at) DESC
     LIMIT 1`,
  )
    .bind(presetId)
    .first<ScanSnapshotHeader>();
}

async function loadScanSnapshotRows(env: Env, snapshotId: string): Promise<ScanSnapshotRow[]> {
  const rows = await env.DB.prepare(
    "SELECT ticker, name, sector, industry, change_1d as change1d, market_cap as marketCap, price, avg_volume as avgVolume, price_avg_volume as priceAvgVolume, raw_json as rawJson FROM scan_rows WHERE snapshot_id = ? ORDER BY change_1d DESC, ticker ASC",
  )
    .bind(snapshotId)
    .all<{
      ticker: string;
      name: string | null;
      sector: string | null;
      industry: string | null;
      change1d: number | null;
      marketCap: number | null;
      price: number | null;
      avgVolume: number | null;
      priceAvgVolume: number | null;
      rawJson: string | null;
    }>();
  return deserializeStoredScanRows(rows.results ?? []);
}

async function hydrateScanSnapshot(
  env: Env,
  preset: ScanPreset,
  snapshot: ScanSnapshotHeader,
): Promise<ScanSnapshot> {
  return {
    id: snapshot.id,
    presetId: preset.id,
    presetName: preset.name,
    providerLabel: snapshot.providerLabel,
    generatedAt: snapshot.generatedAt,
    rowCount: snapshot.rowCount,
    matchedRowCount: snapshot.matchedRowCount,
    status: snapshot.status,
    error: snapshot.error,
    rows: await loadScanSnapshotRows(env, snapshot.id),
  };
}

export async function refreshScansSnapshot(env: Env, presetId?: string | null): Promise<ScanSnapshot> {
  const preset = presetId ? await loadScanPreset(env, presetId) : await loadDefaultScanPreset(env);
  if (!preset) throw new Error("No scan preset is configured.");

  if (preset.scanType === "relative-strength") {
    const response = await requestScansRefresh(env, preset.id, "sync-refresh");
    if (response.snapshot) return response.snapshot;
    if (response.job) {
      throw new Error(`Relative strength cache materialization is ${response.job.status} for ${response.job.expectedTradingDate ?? "the latest session"}.`);
    }
    throw new Error("Relative strength refresh could not load a snapshot.");
  }

  if (preset.scanType === "vcp") {
    const response = await requestScansRefresh(env, preset.id, "sync-refresh");
    if (response.snapshot) return response.snapshot;
    if (response.job) {
      throw new Error(`VCP scan is ${response.job.status} for ${response.job.expectedTradingDate ?? "the latest session"}.`);
    }
    throw new Error("VCP refresh could not load a snapshot.");
  }

  try {
    const result = await fetchTradingViewScanRows(preset);
    await upsertSymbolsFromRows(env, result.rows);
    await storeScanSnapshotResult(env, preset, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scan refresh failed.";
    await env.DB.prepare(
      "INSERT INTO scan_snapshots (id, preset_id, provider_label, generated_at, row_count, matched_row_count, status, error) VALUES (?, ?, ?, CURRENT_TIMESTAMP, 0, 0, 'error', ?)",
    )
      .bind(crypto.randomUUID(), preset.id, TV_PROVIDER_LABEL, message)
      .run();
  }

  const snapshot = await loadLatestScansSnapshot(env, preset.id);
  if (!snapshot) throw new Error("Failed to load refreshed scan snapshot.");
  return snapshot;
}

export async function loadLatestScansSnapshot(env: Env, presetId?: string | null): Promise<ScanSnapshot | null> {
  const preset = presetId ? await loadScanPreset(env, presetId) : await loadDefaultScanPreset(env);
  if (!preset) return null;
  const snapshot = await loadLatestScanSnapshotHeader(env, preset.id);
  if (!snapshot) return null;
  return hydrateScanSnapshot(env, preset, snapshot);
}

export async function loadLatestUsableScansSnapshot(env: Env, presetId?: string | null): Promise<ScanSnapshot | null> {
  const preset = presetId ? await loadScanPreset(env, presetId) : await loadDefaultScanPreset(env);
  if (!preset) return null;
  const snapshot = await loadLatestScanSnapshotHeader(env, preset.id, { usableOnly: true });
  if (!snapshot) return null;
  return hydrateScanSnapshot(env, preset, snapshot);
}

export async function loadCompiledScansSnapshot(
  env: Env,
  presetIds: string[],
  options?: { compilePresetId?: string | null; compilePresetName?: string | null },
): Promise<CompiledScansSnapshot> {
  const uniquePresetIds = Array.from(new Set(
    presetIds
      .map((value) => value.trim())
      .filter(Boolean),
  ));
  const presets = (await Promise.all(uniquePresetIds.map((presetId) => loadScanPreset(env, presetId))))
    .filter((preset): preset is ScanPreset => Boolean(preset));
  const snapshots = await Promise.all(presets.map((preset) => loadLatestUsableScansSnapshot(env, preset.id)));
  const rowMap = new Map<string, CompiledScanUniqueTickerRow>();
  const rowTimestampMap = new Map<string, string>();
  let latestGeneratedAt = "";

  snapshots.forEach((snapshot, index) => {
    if (!snapshot) return;
    const preset = presets[index];
    if (!preset) return;
    if (snapshot.generatedAt > latestGeneratedAt) latestGeneratedAt = snapshot.generatedAt;
    for (const row of snapshot.rows) {
      const existing = rowMap.get(row.ticker);
      if (!existing) {
        rowMap.set(row.ticker, {
          ticker: row.ticker,
          name: row.name,
          sector: row.sector,
          industry: row.industry,
          occurrences: 1,
          presetIds: [preset.id],
          presetNames: [preset.name],
          latestPrice: row.price,
          latestChange1d: row.change1d,
          latestMarketCap: row.marketCap,
          latestRelativeVolume: row.relativeVolume,
        });
        rowTimestampMap.set(row.ticker, snapshot.generatedAt);
        continue;
      }
      existing.occurrences += 1;
      if (!existing.name && row.name) existing.name = row.name;
      if (!existing.sector && row.sector) existing.sector = row.sector;
      if (!existing.industry && row.industry) existing.industry = row.industry;
      if (!existing.presetIds.includes(preset.id)) existing.presetIds.push(preset.id);
      if (!existing.presetNames.includes(preset.name)) existing.presetNames.push(preset.name);
      const currentTimestamp = rowTimestampMap.get(row.ticker) ?? "";
      if (snapshot.generatedAt >= currentTimestamp) {
        existing.latestPrice = row.price;
        existing.latestChange1d = row.change1d;
        existing.latestMarketCap = row.marketCap;
        existing.latestRelativeVolume = row.relativeVolume;
        rowTimestampMap.set(row.ticker, snapshot.generatedAt);
      }
    }
  });

  return {
    compilePresetId: options?.compilePresetId ?? null,
    compilePresetName: options?.compilePresetName ?? null,
    presetIds: presets.map((preset) => preset.id),
    presetNames: presets.map((preset) => preset.name),
    generatedAt: latestGeneratedAt || new Date().toISOString(),
    rows: Array.from(rowMap.values()).sort((a, b) => {
      if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
      const left = a.latestChange1d ?? Number.NEGATIVE_INFINITY;
      const right = b.latestChange1d ?? Number.NEGATIVE_INFINITY;
      if (right !== left) return right - left;
      return a.ticker.localeCompare(b.ticker);
    }),
  };
}

export async function loadCompiledScansSnapshotForCompilePreset(env: Env, compilePresetId: string): Promise<CompiledScansSnapshot> {
  const compilePreset = await loadScanCompilePreset(env, compilePresetId);
  if (!compilePreset) throw new Error("Scan compile preset not found.");
  return loadCompiledScansSnapshot(env, compilePreset.presetIds, {
    compilePresetId: compilePreset.id,
    compilePresetName: compilePreset.name,
  });
}

export async function refreshScanCompilePreset(env: Env, compilePresetId: string): Promise<ScanCompilePresetRefreshResult> {
  const compilePreset = await loadScanCompilePreset(env, compilePresetId);
  if (!compilePreset) throw new Error("Scan compile preset not found.");

  const memberResults: ScanCompilePresetRefreshMemberResult[] = [];
  for (const member of compilePreset.members) {
    const refreshResult = await requestScansRefresh(env, member.scanPresetId, "compile-refresh");
    const refreshedSnapshot = refreshResult.snapshot;
    const usableSnapshot = refreshResult.job?.status === "failed" || refreshedSnapshot?.status === "error"
      ? await loadLatestUsableScansSnapshot(env, member.scanPresetId)
      : (refreshedSnapshot ?? await loadLatestUsableScansSnapshot(env, member.scanPresetId));
    const memberStatus = refreshResult.job?.status === "failed"
      ? "error"
      : (refreshResult.job?.status ?? refreshedSnapshot?.status ?? "empty");
    memberResults.push({
      presetId: member.scanPresetId,
      presetName: member.scanPresetName,
      status: memberStatus as ScanCompilePresetRefreshMemberResult["status"],
      rowCount: usableSnapshot?.rowCount ?? 0,
      error: refreshResult.job?.error ?? refreshedSnapshot?.error ?? null,
      snapshot: refreshedSnapshot,
      usableSnapshot,
      usedFallback: memberStatus === "error" && Boolean(usableSnapshot),
      includedInCompiled: Boolean(usableSnapshot),
    });
  }

  const snapshot = await loadCompiledScansSnapshot(env, compilePreset.presetIds, {
    compilePresetId: compilePreset.id,
    compilePresetName: compilePreset.name,
  });

  return {
    compilePresetId: compilePreset.id,
    compilePresetName: compilePreset.name,
    refreshedCount: memberResults.filter((result) => result.status !== "error").length,
    failedCount: memberResults.filter((result) => result.status === "error").length,
    snapshot,
    memberResults,
  };
}

export async function cleanupOldScansPageData(env: Env, retentionDays = RETENTION_DAYS): Promise<void> {
  const window = `-${Math.max(1, retentionDays)} day`;
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM relative_strength_materialization_queue WHERE run_id IN (SELECT id FROM relative_strength_materialization_runs WHERE datetime(updated_at) < datetime('now', ?))",
    ).bind(window),
    env.DB.prepare(
      "DELETE FROM relative_strength_materialization_run_candidates WHERE run_id IN (SELECT id FROM relative_strength_materialization_runs WHERE datetime(updated_at) < datetime('now', ?))",
    ).bind(window),
    env.DB.prepare("DELETE FROM relative_strength_materialization_runs WHERE datetime(updated_at) < datetime('now', ?)").bind(window),
    env.DB.prepare(
      "DELETE FROM relative_strength_refresh_queue WHERE job_id IN (SELECT id FROM scan_refresh_jobs WHERE datetime(updated_at) < datetime('now', ?))",
    ).bind(window),
    env.DB.prepare(
      "DELETE FROM scan_refresh_job_top_rows WHERE job_id IN (SELECT id FROM scan_refresh_jobs WHERE datetime(updated_at) < datetime('now', ?))",
    ).bind(window),
    env.DB.prepare(
      "DELETE FROM scan_refresh_job_candidates WHERE job_id IN (SELECT id FROM scan_refresh_jobs WHERE datetime(updated_at) < datetime('now', ?))",
    ).bind(window),
    env.DB.prepare("DELETE FROM scan_refresh_jobs WHERE datetime(updated_at) < datetime('now', ?)").bind(window),
    env.DB.prepare(
      "DELETE FROM scan_rows WHERE snapshot_id IN (SELECT id FROM scan_snapshots WHERE datetime(generated_at) < datetime('now', ?))",
    ).bind(window),
    env.DB.prepare("DELETE FROM scan_snapshots WHERE datetime(generated_at) < datetime('now', ?)").bind(window),
  ]);
}

export { buildTradingViewScanPayload, fetchTradingViewScanRows };
