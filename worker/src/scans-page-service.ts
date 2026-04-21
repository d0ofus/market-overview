import { getProvider } from "./provider";
import { refreshDailyBarsIncremental } from "./daily-bars";
import { latestUsSessionAsOfDate, previousWeekdayIso } from "./refresh-timing";
import {
  buildRelativeStrengthCacheRows,
  type RelativeStrengthConfig,
  type RelativeStrengthDailyBar,
  type RelativeStrengthMaType,
  type RelativeStrengthOutputMode,
} from "./relative-strength";
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
  scanType: "tradingview" | "relative-strength";
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
  jobType: "relative-strength";
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
  expectedTradingDate: string | null;
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
  expectedTradingDate: string | null;
  benchmarkTicker: string | null;
  rsMaType: RelativeStrengthMaType;
  rsMaLength: number;
  newHighLookback: number;
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
};

type DailyBarCoverageRow = {
  ticker: string;
  lastDate: string | null;
  barCount: number | null;
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
const RS_JOB_BATCH_SIZE = 20;
const RS_JOB_PROVIDER_CHUNK_SIZE = 10;
const RS_STORED_BAR_QUERY_CHUNK_SIZE = 80;
const RS_JOB_INSERT_CHUNK_SIZE = 250;
const RS_JOB_TIME_BUDGET_MS = 15000;
const RS_LIVE_TOP_UP_LIMIT = 25;
const RS_DEEP_HISTORY_TOP_UP_LIMIT = 40;
const RS_STALE_TOP_UP_LOOKBACK_DAYS = 30;
const RS_STALE_TOP_UP_LIMIT = 120;
const MAX_FETCH_RANGE = 1000;
const MAX_PAGINATED_FETCH_TOTAL = 50000;
const TV_SCAN_URL = "https://scanner.tradingview.com/america/scan";
const TV_PROVIDER_LABEL = "TradingView Screener (america/stocks)";
const RS_PROVIDER_LABEL = "Relative Strength Scan (Alpaca/Provider)";
const RS_RAW_RATIO_VERTICAL_OFFSET = 0.01;

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

function normalizeScanType(value: string | null | undefined): "tradingview" | "relative-strength" {
  return value === "relative-strength" ? "relative-strength" : "tradingview";
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
    requiredBarCount: Math.max(newHighLookback, RS_REQUIRED_BAR_FLOOR),
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
    requiredBarCount: Math.max(1, Math.trunc(job.requiredBarCount || Math.max(newHighLookback, RS_REQUIRED_BAR_FLOOR))),
    expectedTradingDate: job.expectedTradingDate ?? latestUsSessionAsOfDate(new Date()),
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

function snapshotRowToJobCandidate(row: ScanSnapshotRow, cursorOffset: number): RelativeStrengthJobCandidateRow {
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
    expectedTradingDate: record.expectedTradingDate ?? null,
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
  sortField: string;
  sortDirection: "asc" | "desc";
  rowLimit: number;
  createdAt: string;
  updatedAt: string;
}): ScanPreset {
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
    "SELECT id, name, scan_type as scanType, is_default as isDefault, is_active as isActive, rules_json as rulesJson, prefilter_rules_json as prefilterRulesJson, benchmark_ticker as benchmarkTicker, vertical_offset as verticalOffset, rs_ma_length as rsMaLength, rs_ma_type as rsMaType, new_high_lookback as newHighLookback, output_mode as outputMode, sort_field as sortField, sort_direction as sortDirection, row_limit as rowLimit, created_at as createdAt, updated_at as updatedAt FROM scan_presets ORDER BY is_default DESC, updated_at DESC, created_at DESC",
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
    "SELECT id, name, scan_type as scanType, is_default as isDefault, is_active as isActive, rules_json as rulesJson, prefilter_rules_json as prefilterRulesJson, benchmark_ticker as benchmarkTicker, vertical_offset as verticalOffset, rs_ma_length as rsMaLength, rs_ma_type as rsMaType, new_high_lookback as newHighLookback, output_mode as outputMode, sort_field as sortField, sort_direction as sortDirection, row_limit as rowLimit, created_at as createdAt, updated_at as updatedAt FROM scan_presets WHERE id = ? LIMIT 1",
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
    "SELECT id, name, scan_type as scanType, is_default as isDefault, is_active as isActive, rules_json as rulesJson, prefilter_rules_json as prefilterRulesJson, benchmark_ticker as benchmarkTicker, vertical_offset as verticalOffset, rs_ma_length as rsMaLength, rs_ma_type as rsMaType, new_high_lookback as newHighLookback, output_mode as outputMode, sort_field as sortField, sort_direction as sortDirection, row_limit as rowLimit, created_at as createdAt, updated_at as updatedAt FROM scan_presets WHERE is_default = 1 LIMIT 1",
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
  scanType?: "tradingview" | "relative-strength";
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
  sortField?: string;
  sortDirection?: "asc" | "desc";
  rowLimit?: number;
}): Promise<ScanPreset> {
  const id = input.id?.trim() || crypto.randomUUID();
  const scanType = normalizeScanType(input.scanType);
  const isDefault = input.isDefault === true;
  const rules = input.rules ?? [];
  const prefilterRules = input.prefilterRules ?? rules;
  if (isDefault) {
    await env.DB.prepare("UPDATE scan_presets SET is_default = 0 WHERE is_default = 1").run();
  }
  await env.DB.prepare(
    `INSERT INTO scan_presets (id, name, scan_type, is_default, is_active, rules_json, prefilter_rules_json, benchmark_ticker, vertical_offset, rs_ma_length, rs_ma_type, new_high_lookback, output_mode, sort_field, sort_direction, row_limit, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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

type RelativeStrengthLatestRow = ScanSnapshotRow & {
  tradingDate: string;
};

async function upsertRelativeStrengthCache(
  _env: Env,
  preset: ScanPreset,
  rowsByTicker: Map<string, RelativeStrengthDailyBar[]>,
  benchmarkBars: RelativeStrengthDailyBar[],
): Promise<RelativeStrengthLatestRow[]> {
  const config: RelativeStrengthConfig = {
    benchmarkTicker: benchmarkTickerForPreset(preset),
    verticalOffset: preset.verticalOffset,
    rsMaLength: preset.rsMaLength,
    rsMaType: preset.rsMaType,
    newHighLookback: preset.newHighLookback,
  };
  const latestRows = new Map<string, RelativeStrengthLatestRow>();
  const resolvedBenchmarkTicker = resolveBenchmarkTickerForData(config.benchmarkTicker);

  for (const [ticker, bars] of rowsByTicker) {
    if (ticker === config.benchmarkTicker || ticker === resolvedBenchmarkTicker) continue;
    const computedRows = buildRelativeStrengthCacheRows(bars, benchmarkBars, config);
    const latest = computedRows[computedRows.length - 1];
    if (latest) {
      latestRows.set(ticker, {
        ticker,
        name: null,
        sector: null,
        industry: null,
        change1d: latest.change1d,
        marketCap: null,
        relativeVolume: null,
        price: latest.priceClose,
        avgVolume: null,
        priceAvgVolume: null,
        rsClose: latest.rsClose,
        rsMa: latest.rsMa,
        rsAboveMa: latest.rsAboveMa,
        rsNewHigh: latest.rsNewHigh,
        rsNewHighBeforePrice: latest.rsNewHighBeforePrice,
        bullCross: latest.bullCross,
        approxRsRating: latest.approxRsRating,
        rawJson: null,
        tradingDate: latest.tradingDate,
      });
    }
  }

  return Array.from(latestRows.values());
}

function buildRelativeStrengthLatestCacheRows(
  rowsByTicker: Map<string, RelativeStrengthDailyBar[]>,
  benchmarkBars: RelativeStrengthDailyBar[],
  identity: RelativeStrengthConfigIdentity,
): RelativeStrengthLatestCacheRecord[] {
  const latestRows = new Map<string, RelativeStrengthLatestCacheRecord>();
  const config = rawRelativeStrengthConfig(identity);
  const resolvedBenchmarkTicker = resolveBenchmarkTickerForData(identity.benchmarkTicker);

  for (const [ticker, bars] of rowsByTicker) {
    if (ticker === identity.benchmarkTicker || ticker === resolvedBenchmarkTicker) continue;
    const computedRows = buildRelativeStrengthCacheRows(bars, benchmarkBars, config);
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

function rowMatchesOutputMode(row: RelativeStrengthLatestRow, outputMode: RelativeStrengthOutputMode): boolean {
  if (outputMode === "rs_new_high_only") return row.rsNewHigh;
  if (outputMode === "rs_new_high_before_price_only") return row.rsNewHighBeforePrice;
  if (outputMode === "both") return row.rsNewHigh || row.rsNewHighBeforePrice;
  return true;
}

function cachedRowMatchesOutputMode(row: RelativeStrengthLatestCacheRecord, outputMode: RelativeStrengthOutputMode): boolean {
  if (outputMode === "rs_new_high_only") return asBooleanFlag(row.rsNewHigh);
  if (outputMode === "rs_new_high_before_price_only") return asBooleanFlag(row.rsNewHighBeforePrice);
  if (outputMode === "both") return asBooleanFlag(row.rsNewHigh) || asBooleanFlag(row.rsNewHighBeforePrice);
  return true;
}

async function loadRelativeStrengthLatestCacheRows(
  env: Env,
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
    const rows = await env.DB.prepare(
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

async function countRelativeStrengthLatestCacheRows(
  env: Env,
  configKey: string,
  tradingDate: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count
     FROM relative_strength_latest_cache
     WHERE config_key = ?
       AND trading_date = ?`,
  )
    .bind(configKey, tradingDate)
    .first<{ count: number | string | null }>();
  return Math.max(0, Number(row?.count ?? 0) || 0);
}

async function upsertRelativeStrengthLatestCacheRows(
  env: Env,
  configKey: string,
  rows: RelativeStrengthLatestCacheRecord[],
): Promise<void> {
  if (rows.length === 0) return;
  for (let index = 0; index < rows.length; index += RS_JOB_INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(index, index + RS_JOB_INSERT_CHUNK_SIZE);
    await env.DB.batch(chunk.map((row) =>
      env.DB.prepare(
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

async function loadRelativeStrengthUniverseCount(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count
     FROM symbols s
     WHERE COALESCE(s.is_active, 1) = 1
       AND lower(COALESCE(s.asset_class, '')) IN ('equity', 'stock')
       AND EXISTS (SELECT 1 FROM daily_bars d WHERE d.ticker = s.ticker)`,
  )
    .first<{ count: number | string | null }>();
  return Math.max(0, Number(row?.count ?? 0) || 0);
}

async function loadRelativeStrengthUniverseBatch(
  env: Env,
  cursorOffset: number,
  limit: number,
): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT s.ticker as ticker
     FROM symbols s
     WHERE COALESCE(s.is_active, 1) = 1
       AND lower(COALESCE(s.asset_class, '')) IN ('equity', 'stock')
       AND EXISTS (SELECT 1 FROM daily_bars d WHERE d.ticker = s.ticker)
     ORDER BY s.ticker ASC
     LIMIT ?
     OFFSET ?`,
  )
    .bind(limit, cursorOffset)
    .all<{ ticker: string }>();
  return (rows.results ?? [])
    .map((row) => row.ticker.toUpperCase())
    .filter(Boolean);
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
       expected_trading_date as expectedTradingDate,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback
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
       expected_trading_date as expectedTradingDate,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback
     FROM scan_refresh_jobs
     WHERE ${clauses.join(" AND ")}
     ORDER BY datetime(started_at) DESC
     LIMIT 1`,
  )
    .bind(presetId)
    .first<ScanRefreshJobRecord>();
}

async function loadLatestScanRefreshJobRecordForConfigKey(
  env: Env,
  configKey: string,
  options?: { activeOnly?: boolean; expectedTradingDate?: string | null },
): Promise<ScanRefreshJobRecord | null> {
  const clauses = ["config_key = ?"];
  const values: unknown[] = [configKey];
  if (options?.expectedTradingDate) {
    clauses.push("expected_trading_date = ?");
    values.push(options.expectedTradingDate);
  }
  if (options?.activeOnly) {
    clauses.push("status IN ('queued', 'running')");
  }
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
       expected_trading_date as expectedTradingDate,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback
     FROM scan_refresh_jobs
     WHERE ${clauses.join(" AND ")}
     ORDER BY datetime(started_at) DESC
     LIMIT 1`,
  )
    .bind(...values)
    .first<ScanRefreshJobRecord>();
}

async function loadLatestCompletedScanRefreshJobRecordForConfigKey(
  env: Env,
  configKey: string,
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
       expected_trading_date as expectedTradingDate,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback
     FROM scan_refresh_jobs
     WHERE config_key = ?
       AND expected_trading_date = ?
       AND status = 'completed'
     ORDER BY datetime(completed_at) DESC, datetime(updated_at) DESC
     LIMIT 1`,
  )
    .bind(configKey, expectedTradingDate)
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
       expected_trading_date as expectedTradingDate,
       benchmark_ticker as benchmarkTicker,
       rs_ma_type as rsMaType,
       rs_ma_length as rsMaLength,
       new_high_lookback as newHighLookback
     FROM scan_refresh_jobs
     WHERE status IN ('queued', 'running')
     ORDER BY datetime(updated_at) ASC, datetime(started_at) ASC`,
  )
    .all<ScanRefreshJobRecord>();
  return rows.results ?? [];
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
          (job_id, cursor_offset, ticker, name, sector, industry, market_cap, relative_volume, avg_volume, price_avg_volume)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
       price_avg_volume as priceAvgVolume
     FROM scan_refresh_job_candidates
     WHERE job_id = ?
       AND cursor_offset >= ?
     ORDER BY cursor_offset ASC
     LIMIT ?`,
  )
    .bind(jobId, cursorOffset, limit)
    .all<RelativeStrengthJobCandidateRow>();
  return (rows.results ?? []).map((row) => ({
    ...row,
    ticker: row.ticker.toUpperCase(),
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
  updates: Partial<Pick<ScanRefreshJobRecord, "status" | "error" | "processedCandidates" | "matchedCandidates" | "cursorOffset" | "latestSnapshotId" | "benchmarkBarsJson" | "requiredBarCount">> & { completedAt?: string | null },
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

async function refreshRelativeStrengthSnapshot(env: Env, preset: ScanPreset): Promise<{
  providerLabel: string;
  matchedRowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
  rows: ScanSnapshotRow[];
}> {
  const identity = buildRelativeStrengthConfigIdentity(preset);
  const completedJob = await loadLatestCompletedScanRefreshJobRecordForConfigKey(env, identity.configKey, identity.expectedTradingDate);
  if (!completedJob) {
    throw new Error(`Relative strength cache is not ready for ${identity.expectedTradingDate}.`);
  }

  const prefilterRows = await fetchRelativeStrengthPrefilterRows(preset);
  if (prefilterRows.length === 0) {
    return {
      providerLabel: RS_PROVIDER_LABEL,
      matchedRowCount: 0,
      status: "empty",
      error: null,
      rows: [],
    };
  }

  const metadataByTicker = new Map(
    prefilterRows
      .map((row) => [row.ticker.toUpperCase(), row] as const),
  );
  const cacheRowsByTicker = await loadRelativeStrengthLatestCacheRows(
    env,
    identity.configKey,
    Array.from(metadataByTicker.keys()),
    identity.expectedTradingDate,
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
        name: metadata.name,
        sector: metadata.sector,
        industry: metadata.industry,
        change1d: row.change1d,
        marketCap: metadata.marketCap,
        relativeVolume: metadata.relativeVolume,
        price: row.priceClose,
        avgVolume: metadata.avgVolume,
        priceAvgVolume: metadata.priceAvgVolume,
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

async function createRelativeStrengthRefreshJob(
  env: Env,
  preset: ScanPreset,
  requestedBy?: string | null,
): Promise<ScanRefreshJobRecord> {
  const identity = buildRelativeStrengthConfigIdentity(preset);
  const existing = await loadLatestScanRefreshJobRecordForConfigKey(env, identity.configKey, {
    activeOnly: true,
    expectedTradingDate: identity.expectedTradingDate,
  });
  if (existing) return existing;

  const jobId = crypto.randomUUID();
  const totalTickers = await loadRelativeStrengthUniverseCount(env);
  await env.DB.prepare(
    `INSERT INTO scan_refresh_jobs
      (id, preset_id, job_type, status, started_at, updated_at, error, total_candidates, processed_candidates, matched_candidates, cursor_offset, latest_snapshot_id, requested_by, benchmark_bars_json, required_bar_count, config_key, expected_trading_date, benchmark_ticker, rs_ma_type, rs_ma_length, new_high_lookback)
     VALUES (?, ?, 'relative-strength', 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, ?, 0, 0, 0, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      jobId,
      preset.id,
      totalTickers,
      requestedBy ?? null,
      identity.requiredBarCount,
      identity.configKey,
      identity.expectedTradingDate,
      identity.benchmarkTicker,
      identity.rsMaType,
      identity.rsMaLength,
      identity.newHighLookback,
    )
    .run();
  const created = await loadScanRefreshJobRecord(env, jobId);
  if (!created) throw new Error("Failed to create scan refresh job.");
  return created;
}

async function ensureRelativeStrengthJobBenchmarkBars(
  env: Env,
  job: ScanRefreshJobRecord,
): Promise<RelativeStrengthDailyBar[]> {
  const identity = buildRelativeStrengthConfigIdentityFromJobRecord(job);
  const cached = deserializeBenchmarkBars(job.benchmarkBarsJson);
  if (cached.length > 0 && latestBarDate(cached) === identity.expectedTradingDate) return cached;

  const startDate = isoDateDaysAgo(calendarLookbackDaysForBars(identity.requiredBarCount));
  await refreshDailyBarsIncremental(env, {
    tickers: [identity.benchmarkDataTicker],
    startDate,
    endDate: identity.expectedTradingDate,
    maxTickers: 1,
    provider: getProvider(env),
  });

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

async function materializeRelativeStrengthBatch(
  env: Env,
  job: ScanRefreshJobRecord,
  tickers: string[],
  benchmarkBars: RelativeStrengthDailyBar[],
): Promise<number> {
  const identity = buildRelativeStrengthConfigIdentityFromJobRecord(job);
  const benchmarkTicker = identity.benchmarkDataTicker;
  const candidateTickers = Array.from(new Set(
    tickers
      .map((ticker) => ticker.trim().toUpperCase())
      .filter((ticker) => ticker && ticker !== benchmarkTicker && ticker !== identity.benchmarkTicker),
  ));
  if (candidateTickers.length === 0) return 0;
  await ensureStoredDailyBarsCurrent(env, candidateTickers, identity.expectedTradingDate, identity.requiredBarCount);
  const storedBars = await loadStoredDailyBarsByCount(env, candidateTickers, identity.expectedTradingDate, identity.requiredBarCount);
  const cacheRows = buildRelativeStrengthLatestCacheRows(groupBarsByTicker(storedBars), benchmarkBars, identity);
  await upsertRelativeStrengthLatestCacheRows(env, identity.configKey, cacheRows);
  return cacheRows.length;
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
  const result = await refreshRelativeStrengthSnapshot(env, preset);
  await upsertSymbolsFromRows(env, result.rows);
  await storeScanSnapshotResult(env, preset, result);
  const snapshot = await loadLatestScansSnapshot(env, preset.id);
  if (!snapshot) throw new Error("Failed to load refreshed scan snapshot.");
  return snapshot;
}

export async function processRelativeStrengthRefreshJob(
  env: Env,
  jobId: string,
  options?: { timeBudgetMs?: number; maxBatches?: number },
): Promise<ScanRefreshJob | null> {
  const job = await loadScanRefreshJobRecord(env, jobId);
  if (!job) return null;
  const preset = await loadScanPreset(env, job.presetId);
  if (!preset || preset.scanType !== "relative-strength") return null;
  if (job.status === "completed" || job.status === "failed") {
    return mapJobRecordToJob(job, preset);
  }

  try {
    await updateScanRefreshJobRecord(env, job.id, { status: "running" });
    const benchmarkBars = await ensureRelativeStrengthJobBenchmarkBars(env, job);
    let cursorOffset = job.cursorOffset;
    let matchedCandidates = job.matchedCandidates;
    const startedAt = Date.now();
    const timeBudgetMs = options?.timeBudgetMs ?? RS_JOB_TIME_BUDGET_MS;
    const maxBatches = Math.max(1, options?.maxBatches ?? Number.POSITIVE_INFINITY);
    let processedBatchCount = 0;

    while (cursorOffset < job.totalCandidates && Date.now() - startedAt < timeBudgetMs && processedBatchCount < maxBatches) {
      const batchTickers = await loadRelativeStrengthUniverseBatch(env, cursorOffset, RS_JOB_BATCH_SIZE);
      if (batchTickers.length === 0) break;
      matchedCandidates += await materializeRelativeStrengthBatch(env, job, batchTickers, benchmarkBars);
      cursorOffset += batchTickers.length;
      processedBatchCount += 1;
      await updateScanRefreshJobRecord(env, job.id, {
        status: "running",
        processedCandidates: cursorOffset,
        matchedCandidates,
        cursorOffset,
      });
    }

    if (cursorOffset >= job.totalCandidates) {
      await updateScanRefreshJobRecord(env, job.id, {
        status: "completed",
        processedCandidates: cursorOffset,
        matchedCandidates,
        cursorOffset,
        completedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    await updateScanRefreshJobRecord(env, job.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Relative strength refresh failed.",
      completedAt: new Date().toISOString(),
    });
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
  if (preset.scanType !== "relative-strength") {
    return {
      async: false,
      snapshot: await refreshScansSnapshot(env, preset.id),
      job: null,
    };
  }
  const identity = buildRelativeStrengthConfigIdentity(preset);
  const activeJob = await loadLatestScanRefreshJobRecordForConfigKey(env, identity.configKey, {
    activeOnly: true,
    expectedTradingDate: identity.expectedTradingDate,
  });
  if (activeJob) {
    return {
      async: true,
      snapshot: await loadLatestUsableScansSnapshot(env, preset.id),
      job: mapJobRecordToJob(activeJob, preset),
    };
  }
  const completedJob = await loadLatestCompletedScanRefreshJobRecordForConfigKey(env, identity.configKey, identity.expectedTradingDate);
  if (completedJob) {
    return {
      async: false,
      snapshot: await ensureRelativeStrengthSnapshotCurrent(env, preset, completedJob),
      job: null,
    };
  }
  const jobRecord = await createRelativeStrengthRefreshJob(env, preset, requestedBy);
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
  if (!preset || preset.scanType !== "relative-strength") return null;
  const identity = buildRelativeStrengthConfigIdentity(preset);
  const record = await loadLatestScanRefreshJobRecordForConfigKey(env, identity.configKey, {
    activeOnly: true,
    expectedTradingDate: identity.expectedTradingDate,
  });
  if (!record) return null;
  return {
    job: mapJobRecordToJob(record, preset),
    snapshot: await loadLatestUsableScansSnapshot(env, preset.id),
  };
}

export async function processQueuedRelativeStrengthRefreshJobs(
  env: Env,
  options?: { timeBudgetMs?: number; maxBatches?: number },
): Promise<ScanRefreshJob[]> {
  const startedAt = Date.now();
  const totalTimeBudgetMs = Math.max(1_000, options?.timeBudgetMs ?? RS_JOB_TIME_BUDGET_MS);
  let remainingBatches = options?.maxBatches == null
    ? Number.POSITIVE_INFINITY
    : Math.max(1, options.maxBatches);
  const processedByJobId = new Map<string, ScanRefreshJob>();

  while (remainingBatches > 0 && Date.now() - startedAt < totalTimeBudgetMs) {
    const activeJobs = await listActiveScanRefreshJobRecords(env);
    if (activeJobs.length === 0) break;

    let advancedAny = false;
    for (const activeJob of activeJobs) {
      if (remainingBatches <= 0 || Date.now() - startedAt >= totalTimeBudgetMs) break;
      const remainingTimeBudgetMs = Math.max(1_000, totalTimeBudgetMs - (Date.now() - startedAt));
      const processed = await processRelativeStrengthRefreshJob(env, activeJob.id, {
        maxBatches: 1,
        timeBudgetMs: remainingTimeBudgetMs,
      });
      if (!processed) continue;
      processedByJobId.set(processed.id, processed);

      const advanced = processed.status === "completed"
        || processed.status === "failed"
        || processed.processedCandidates > activeJob.processedCandidates
        || processed.cursorOffset > activeJob.cursorOffset;
      if (advanced) {
        remainingBatches -= 1;
        advancedAny = true;
      }

      if (processed.status === "completed") {
        try {
          await requestScansRefresh(env, processed.presetId, "background-completed");
        } catch (error) {
          console.error("background RS snapshot rebuild failed", {
            jobId: processed.id,
            presetId: processed.presetId,
            error,
          });
        }
      }
    }

    if (!advancedAny) break;
  }

  return Array.from(processedByJobId.values());
}

export async function refreshActiveRelativeStrengthPresets(
  env: Env,
  options?: { timeBudgetMs?: number; maxBatches?: number },
): Promise<ScanRefreshJob[]> {
  const presets = (await listScanPresets(env))
    .filter((preset) => preset.isActive && preset.scanType === "relative-strength");
  const completedJobsByConfigKey = new Map<string, ScanRefreshJobRecord>();
  const seenConfigKeys = new Set<string>();
  for (const preset of presets) {
    const identity = buildRelativeStrengthConfigIdentity(preset);
    if (seenConfigKeys.has(identity.configKey)) continue;
    seenConfigKeys.add(identity.configKey);
    const completed = await loadLatestCompletedScanRefreshJobRecordForConfigKey(
      env,
      identity.configKey,
      identity.expectedTradingDate,
    );
    if (completed) {
      completedJobsByConfigKey.set(identity.configKey, completed);
      continue;
    }
    const active = await loadLatestScanRefreshJobRecordForConfigKey(env, identity.configKey, {
      activeOnly: true,
      expectedTradingDate: identity.expectedTradingDate,
    });
    if (!active) {
      await createRelativeStrengthRefreshJob(env, preset, "scheduled");
    }
  }
  const jobs = await processQueuedRelativeStrengthRefreshJobs(env, options);
  for (const preset of presets) {
    const identity = buildRelativeStrengthConfigIdentity(preset);
    const completed = completedJobsByConfigKey.get(identity.configKey)
      ?? await loadLatestCompletedScanRefreshJobRecordForConfigKey(
        env,
        identity.configKey,
        identity.expectedTradingDate,
      );
    if (completed) {
      completedJobsByConfigKey.set(identity.configKey, completed);
    }
  }
  for (const preset of presets) {
    const identity = buildRelativeStrengthConfigIdentity(preset);
    const completed = completedJobsByConfigKey.get(identity.configKey);
    if (!completed) continue;
    await ensureRelativeStrengthSnapshotCurrent(env, preset, completed);
  }
  return jobs.filter((job) => seenConfigKeys.has(job.configKey ?? ""));
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
