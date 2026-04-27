import { latestUsSessionAsOfDate, zonedParts } from "./refresh-timing";
import type { Env, WorkerScheduleSettings } from "./types";

export const PATTERN_FEATURE_VERSION = "v2";
export const PATTERN_MODEL_TYPE = "similarity_v1";
export const DEFAULT_PATTERN_PROFILE_ID = "default";

const DEFAULT_CONTEXT_WINDOW_BARS = 260;
const DEFAULT_PATTERN_WINDOW_BARS = 40;
const DEFAULT_SELECTED_RESAMPLE_POINTS = 64;
const DEFAULT_CANDIDATE_PATTERN_LENGTHS = [20, 40, 60, 80, 120];
const DEFAULT_BENCHMARK_TICKER = "SPY";
const MIN_EXTRACT_BARS = 60;
const MIN_SELECTED_PATTERN_BARS = 10;
const MAX_SELECTED_PATTERN_BARS = 160;
const MIN_MODEL_CLASS_COUNT = 3;
const MATCH_SCORE_THRESHOLD = 0.6;
const PATTERN_UNIVERSE_QUERY_CHUNK_SIZE = 50;

export class PatternDbUnavailableError extends Error {
  constructor() {
    super("PATTERN_DB binding is required. Create and bind the market_patterns D1 database before using Pattern Scanner.");
  }
}

export type PatternDailyBar = {
  ticker: string;
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  volume?: number | null;
};

export type PatternFeatureJson = Record<string, number | null>;
export type PatternShapeJson = Record<string, Array<number | null>>;

export type PatternFeatureSnapshot = {
  featureVersion: string;
  ticker: string;
  setupDate: string;
  patternStartDate: string | null;
  patternEndDate: string;
  selectedBarCount: number;
  selectionMode: PatternSelectionMode;
  benchmarkTicker: string;
  contextWindowBars: number;
  patternWindowBars: number;
  featureJson: PatternFeatureJson;
  shapeJson: PatternShapeJson;
  windowHash: string;
  sourceMetadata: {
    ticker: string;
    setupDate: string;
    patternStartDate: string | null;
    patternEndDate: string;
    selectedBarCount: number;
    selectionMode: PatternSelectionMode;
    latestBarDate: string | null;
    firstBarDate: string | null;
    benchmarkTicker: string;
    benchmarkLatestBarDate: string | null;
    barCount: number;
    benchmarkBarCount: number;
    price: number | null;
    avgDollarVolume20d: number | null;
    warning: string | null;
  };
};

export type PatternProfile = {
  id: string;
  name: string;
  description: string | null;
  benchmarkTickers: string[];
  prefilterConfig: PatternPrefilterConfig;
  activeModelId: string | null;
  settings: PatternProfileSettings;
  createdAt: string;
  updatedAt: string;
};

export type PatternProfileSettings = {
  contextWindowBars: number;
  patternWindowBars: number;
  candidateLimit: number;
  selectedResamplePoints: number;
  candidatePatternLengths: number[];
};

export type PatternPrefilterConfig = {
  minPrice: number;
  minDollarVolume20d: number;
  minBars: number;
};

export type PatternLabelValue = "approved" | "rejected" | "skipped";
export type PatternLabelStatus = "active" | "archived" | "deleted";
export type PatternSelectionMode = "chart_range" | "fixed_window";

export type PatternLabel = {
  id: string;
  profileId: string;
  ticker: string;
  setupDate: string;
  label: PatternLabelValue;
  status: PatternLabelStatus;
  source: string;
  contextWindowBars: number;
  patternWindowBars: number;
  patternStartDate: string | null;
  patternEndDate: string | null;
  selectedBarCount: number | null;
  selectionMode: PatternSelectionMode;
  tags: string[];
  notes: string | null;
  featureVersion: string;
  featureJson: PatternFeatureJson;
  shapeJson: PatternShapeJson;
  windowHash: string;
  createdAt: string;
  updatedAt: string;
};

export type PatternFeatureRegistryRow = {
  featureKey: string;
  displayName: string;
  family: "scalar" | "shape";
  valueType: string;
  enabled: boolean;
  version: string;
  description: string | null;
};

export type PatternModelVersion = {
  id: string;
  profileId: string;
  modelType: string;
  featureVersion: string;
  model: PatternModelJson;
  metrics: PatternValidationMetrics;
  featureSummary: PatternFeatureSummary;
  approvedCount: number;
  rejectedCount: number;
  active: boolean;
  createdAt: string;
};

export type PatternModelJson = {
  modelType: typeof PATTERN_MODEL_TYPE;
  featureVersion: string;
  enoughLabels: boolean;
  scalarKeys: string[];
  shapeKeys: string[];
  scalarNormalization: Record<string, { mean: number; std: number }>;
  approvedScalarCentroid: Record<string, number | null>;
  rejectedScalarCentroid: Record<string, number | null>;
  approvedShapeCentroid: PatternShapeJson;
  rejectedShapeCentroid: PatternShapeJson;
  featureWeights: Record<string, number>;
  tagWeights: Record<string, number>;
  nearestReferences: {
    approved: PatternExampleReference[];
    rejected: PatternExampleReference[];
  };
};

export type PatternValidationMetrics = {
  enoughLabels: boolean;
  approvedCount: number;
  rejectedCount: number;
  totalActiveLabels: number;
  chronologicalAccuracy: number | null;
  precisionAt25: number | null;
  precisionAt50: number | null;
  validationWindowSize: number;
};

export type PatternFeatureSummary = {
  scalarStats: Record<string, {
    approvedAvg: number | null;
    rejectedAvg: number | null;
    approvedMedian: number | null;
    rejectedMedian: number | null;
    delta: number | null;
  }>;
  topWeightedFeatures: Array<{ featureKey: string; weight: number; direction: "approved" | "rejected" | "neutral" }>;
};

export type PatternRun = {
  id: string;
  profileId: string;
  tradingDate: string;
  status: "queued" | "running" | "completed" | "failed";
  phase: string;
  totalCount: number;
  processedCount: number;
  matchedCount: number;
  cursorOffset: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  warning: string | null;
};

export type PatternCandidate = {
  id: string;
  runId: string;
  profileId: string;
  ticker: string;
  rank: number;
  score: number;
  reasons: PatternScoreReasons;
  nearestApproved: PatternExampleReference[];
  nearestRejected: PatternExampleReference[];
  featureJson: PatternFeatureJson;
  shapeJson: PatternShapeJson;
  sourceMetadata: Record<string, unknown>;
  createdAt?: string;
  tradingDate?: string;
  updatedAt?: string;
};

export type PatternScoreReasons = {
  score: number;
  mode: "heuristic" | "model";
  approvedSimilarity: number | null;
  rejectedSimilarity: number | null;
  scalarSimilarity: number | null;
  shapeSimilarity: number | null;
  activeLearningPriority: number;
  heuristicScore: number;
  positiveContributions: PatternContribution[];
  negativeContributions: PatternContribution[];
  summary: string[];
};

export type PatternContribution = {
  featureKey: string;
  label: string;
  value: number | null;
  contribution: number;
};

export type PatternExampleReference = {
  labelId: string;
  ticker: string;
  setupDate: string;
  label: "approved" | "rejected";
  distance: number;
  similarity: number;
  tags: string[];
};

export type PatternRunCreateInput = {
  profileId?: string;
  tradingDate?: string;
  force?: boolean;
};

export type PatternLabelCreateInput = {
  profileId?: string;
  ticker: string;
  setupDate: string;
  label: PatternLabelValue;
  status?: PatternLabelStatus;
  source?: string;
  contextWindowBars?: number;
  patternWindowBars?: number;
  patternStartDate?: string | null;
  patternEndDate?: string | null;
  selectedBarCount?: number | null;
  selectionMode?: PatternSelectionMode;
  tags?: string[];
  notes?: string | null;
  runId?: string | null;
  candidateId?: string | null;
};

export type PatternLabelPatchInput = Partial<Omit<PatternLabelCreateInput, "profileId" | "source" | "runId" | "candidateId">>;

type PatternProfileRow = {
  id: string;
  name: string;
  description: string | null;
  benchmarkTickersJson: string | null;
  prefilterConfigJson: string | null;
  activeModelId: string | null;
  settingsJson: string | null;
  createdAt: string;
  updatedAt: string;
};

type PatternLabelRow = {
  id: string;
  profileId: string;
  ticker: string;
  setupDate: string;
  label: PatternLabelValue;
  status: PatternLabelStatus;
  source: string;
  contextWindowBars: number;
  patternWindowBars: number;
  patternStartDate: string | null;
  patternEndDate: string | null;
  selectedBarCount: number | null;
  selectionMode: PatternSelectionMode | null;
  tagsJson: string | null;
  notes: string | null;
  featureVersion: string;
  featureJson: string | null;
  shapeJson: string | null;
  windowHash: string;
  createdAt: string;
  updatedAt: string;
};

type PatternModelRow = {
  id: string;
  profileId: string;
  modelType: string;
  featureVersion: string;
  modelJson: string | null;
  metricsJson: string | null;
  featureSummaryJson: string | null;
  approvedCount: number;
  rejectedCount: number;
  active: number;
  createdAt: string;
};

type PatternRunRow = {
  id: string;
  profileId: string;
  tradingDate: string;
  status: PatternRun["status"];
  phase: string;
  totalCount: number;
  processedCount: number;
  matchedCount: number;
  cursorOffset: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  warning: string | null;
};

type PatternCandidateRow = {
  id: string;
  runId: string;
  profileId: string;
  ticker: string;
  rank: number;
  score: number;
  reasonsJson: string | null;
  nearestApprovedJson: string | null;
  nearestRejectedJson: string | null;
  featureJson: string | null;
  shapeJson: string | null;
  sourceMetadataJson: string | null;
  createdAt?: string;
  tradingDate?: string;
  updatedAt?: string;
};

export type PatternChartBar = {
  ticker: string;
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
  rs: number | null;
};

export type PatternChartData = {
  ticker: string;
  endDate: string;
  benchmarkTicker: string;
  contextWindowBars: number;
  availableStartDate: string | null;
  availableEndDate: string | null;
  bars: PatternChartBar[];
  warnings: string[];
};

type UniverseCandidate = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  assetClass: string | null;
  sector: string | null;
  industry: string | null;
  price: number | null;
  avgDollarVolume20d: number | null;
  barCount: number;
  latestBarDate: string | null;
};

const SCALAR_FEATURE_KEYS = [
  "range_10d_pct",
  "range_20d_pct",
  "atr_10",
  "atr_50",
  "atr_contraction_ratio",
  "volume_dryup_ratio",
  "close_vs_20sma_pct",
  "close_vs_50sma_pct",
  "close_vs_200sma_pct",
  "distance_from_52w_high_pct",
  "higher_lows_count",
  "rs_line_near_high",
  "prior_runup_60d_pct",
  "base_depth_pct",
  "base_length_bars",
  "price_tightness_10d",
  "up_down_volume_ratio_20d",
  "dollar_volume_20d",
  "relative_volume_20d",
] as const;

const SHAPE_FEATURE_KEYS = [
  "price_path_20d",
  "price_path_40d",
  "price_path_60d",
  "high_low_range_path_40d",
  "volume_path_40d",
  "rolling_atr_path_40d",
  "relative_strength_path_60d",
  "distance_from_20sma_path_40d",
  "distance_from_50sma_path_40d",
  "selected_price_path_64",
  "selected_volume_path_64",
  "selected_range_path_64",
  "selected_atr_path_64",
  "selected_rs_path_64",
  "selected_distance_from_20sma_path_64",
  "selected_distance_from_50sma_path_64",
] as const;

const FEATURE_LABELS: Record<string, string> = {
  range_10d_pct: "10D range",
  range_20d_pct: "20D range",
  atr_10: "ATR 10",
  atr_50: "ATR 50",
  atr_contraction_ratio: "ATR contraction",
  volume_dryup_ratio: "Volume dry-up",
  close_vs_20sma_pct: "Close vs 20SMA",
  close_vs_50sma_pct: "Close vs 50SMA",
  close_vs_200sma_pct: "Close vs 200SMA",
  distance_from_52w_high_pct: "Distance from 52W high",
  higher_lows_count: "Higher lows",
  rs_line_near_high: "RS near high",
  prior_runup_60d_pct: "60D run-up",
  base_depth_pct: "Base depth",
  base_length_bars: "Base length",
  price_tightness_10d: "10D tightness",
  up_down_volume_ratio_20d: "Up/down volume",
  dollar_volume_20d: "20D dollar volume",
  relative_volume_20d: "Relative volume",
  price_path_20d: "20D price path",
  price_path_40d: "40D price path",
  price_path_60d: "60D price path",
  high_low_range_path_40d: "40D range path",
  volume_path_40d: "40D volume path",
  rolling_atr_path_40d: "40D ATR path",
  relative_strength_path_60d: "60D RS path",
  distance_from_20sma_path_40d: "Distance from 20SMA path",
  distance_from_50sma_path_40d: "Distance from 50SMA path",
  selected_price_path_64: "Selected price path",
  selected_volume_path_64: "Selected volume path",
  selected_range_path_64: "Selected range path",
  selected_atr_path_64: "Selected ATR path",
  selected_rs_path_64: "Selected RS path",
  selected_distance_from_20sma_path_64: "Selected 20SMA distance",
  selected_distance_from_50sma_path_64: "Selected 50SMA distance",
};

function requirePatternDb(env: Env): D1Database {
  if (!env.PATTERN_DB) throw new PatternDbUnavailableError();
  return env.PATTERN_DB;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function mean(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (filtered.length === 0) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function median(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (filtered.length === 0) return null;
  const middle = Math.floor(filtered.length / 2);
  return filtered.length % 2 === 0 ? (filtered[middle - 1] + filtered[middle]) / 2 : filtered[middle];
}

function std(values: Array<number | null | undefined>, fallback = 1): number {
  const filtered = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (filtered.length < 2) return fallback;
  const avg = mean(filtered) ?? 0;
  const variance = filtered.reduce((sum, value) => sum + (value - avg) ** 2, 0) / filtered.length;
  const result = Math.sqrt(variance);
  return Number.isFinite(result) && result > 0 ? result : fallback;
}

function sma(values: number[], length: number, index: number): number | null {
  if (length <= 0 || index < length - 1) return null;
  let sum = 0;
  for (let current = index - length + 1; current <= index; current += 1) {
    const value = values[current];
    if (!Number.isFinite(value)) return null;
    sum += value;
  }
  return sum / length;
}

function highest(values: number[], length: number, index: number): number | null {
  if (length <= 0 || index < 0) return null;
  const start = Math.max(0, index - length + 1);
  let out: number | null = null;
  for (let current = start; current <= index; current += 1) {
    const value = values[current];
    if (!Number.isFinite(value)) continue;
    out = out == null ? value : Math.max(out, value);
  }
  return out;
}

function lowest(values: number[], length: number, index: number): number | null {
  if (length <= 0 || index < 0) return null;
  const start = Math.max(0, index - length + 1);
  let out: number | null = null;
  for (let current = start; current <= index; current += 1) {
    const value = values[current];
    if (!Number.isFinite(value)) continue;
    out = out == null ? value : Math.min(out, value);
  }
  return out;
}

function pctChange(now: number | null | undefined, previous: number | null | undefined): number | null {
  if (now == null || previous == null || !Number.isFinite(now) || !Number.isFinite(previous) || previous === 0) return null;
  return ((now - previous) / previous) * 100;
}

function trueRange(bars: PatternDailyBar[], index: number): number | null {
  const bar = bars[index];
  if (!bar || !Number.isFinite(bar.h) || !Number.isFinite(bar.l)) return null;
  const previousClose = index > 0 ? bars[index - 1]?.c : null;
  const ranges = [bar.h - bar.l];
  if (previousClose != null && Number.isFinite(previousClose)) {
    ranges.push(Math.abs(bar.h - previousClose), Math.abs(bar.l - previousClose));
  }
  return Math.max(...ranges.filter(Number.isFinite));
}

function atrAt(bars: PatternDailyBar[], length: number, index: number): number | null {
  if (index < length - 1) return null;
  const ranges: number[] = [];
  for (let current = index - length + 1; current <= index; current += 1) {
    const value = trueRange(bars, current);
    if (value == null) return null;
    ranges.push(value);
  }
  return mean(ranges);
}

function averageDollarVolume(bars: PatternDailyBar[], length: number): number | null {
  const slice = bars.slice(-length);
  if (slice.length === 0) return null;
  return mean(slice.map((bar) => Number(bar.c) * Number(bar.volume ?? 0)));
}

function normalizeToStart(values: Array<number | null>, length: number): Array<number | null> {
  const fixed = padLeft(values, length);
  const first = fixed.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value !== 0);
  if (first == null) return fixed.map(() => null);
  return fixed.map((value) => value == null || !Number.isFinite(value) ? null : value / first);
}

function normalizeByMedian(values: Array<number | null>, length: number): Array<number | null> {
  const fixed = padLeft(values, length);
  const divisor = median(fixed);
  if (!divisor || !Number.isFinite(divisor) || divisor === 0) return fixed.map((value) => finiteOrNull(value));
  return fixed.map((value) => value == null || !Number.isFinite(value) ? null : value / divisor);
}

function padLeft(values: Array<number | null>, length: number): Array<number | null> {
  const trimmed = values.slice(-length);
  if (trimmed.length >= length) return trimmed;
  return [...Array.from({ length: length - trimmed.length }, () => null), ...trimmed];
}

function resampleSeries(values: Array<number | null>, length: number): Array<number | null> {
  const fixedLength = Math.max(2, Math.trunc(length));
  const source = values.map((value) => finiteOrNull(value));
  if (source.length === 0) return Array.from({ length: fixedLength }, () => null);
  if (source.length === 1) return Array.from({ length: fixedLength }, () => source[0]);
  const out: Array<number | null> = [];
  for (let index = 0; index < fixedLength; index += 1) {
    const position = (index / (fixedLength - 1)) * (source.length - 1);
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(source.length - 1, Math.ceil(position));
    const left = source[leftIndex];
    const right = source[rightIndex];
    if (left == null && right == null) {
      out.push(null);
      continue;
    }
    if (left == null) {
      out.push(right);
      continue;
    }
    if (right == null) {
      out.push(left);
      continue;
    }
    const weight = position - leftIndex;
    out.push(left + (right - left) * weight);
  }
  return out;
}

function normalizeSelectionToStart(values: Array<number | null>, length: number): Array<number | null> {
  const sampled = resampleSeries(values, length);
  const first = sampled.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value !== 0);
  if (first == null) return sampled.map(() => null);
  return sampled.map((value) => value == null || !Number.isFinite(value) ? null : value / first);
}

function normalizeSelectionByMedian(values: Array<number | null>, length: number): Array<number | null> {
  const sampled = resampleSeries(values, length);
  const divisor = median(sampled);
  if (!divisor || !Number.isFinite(divisor) || divisor === 0) return sampled.map((value) => finiteOrNull(value));
  return sampled.map((value) => value == null || !Number.isFinite(value) ? null : value / divisor);
}

function sanitizeCandidatePatternLengths(values: unknown): number[] {
  const input = Array.isArray(values) ? values : DEFAULT_CANDIDATE_PATTERN_LENGTHS;
  const unique = new Set<number>();
  for (const value of input) {
    const parsed = Math.trunc(Number(value));
    if (Number.isFinite(parsed) && parsed >= MIN_SELECTED_PATTERN_BARS && parsed <= MAX_SELECTED_PATTERN_BARS) {
      unique.add(parsed);
    }
  }
  return unique.size > 0 ? Array.from(unique).sort((left, right) => left - right) : [...DEFAULT_CANDIDATE_PATTERN_LENGTHS];
}

function sanitizeSelectedResamplePoints(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(16, Math.min(256, parsed)) : DEFAULT_SELECTED_RESAMPLE_POINTS;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function mapProfileRow(row: PatternProfileRow): PatternProfile {
  const parsedSettings = parseJson<Partial<PatternProfileSettings>>(row.settingsJson, {});
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    benchmarkTickers: parseJson<string[]>(row.benchmarkTickersJson, [DEFAULT_BENCHMARK_TICKER])
      .map((ticker) => String(ticker).trim().toUpperCase())
      .filter(Boolean),
    prefilterConfig: {
      minPrice: 3,
      minDollarVolume20d: 5_000_000,
      minBars: DEFAULT_CONTEXT_WINDOW_BARS,
      ...parseJson<Partial<PatternPrefilterConfig>>(row.prefilterConfigJson, {}),
    },
    activeModelId: row.activeModelId,
    settings: {
      contextWindowBars: DEFAULT_CONTEXT_WINDOW_BARS,
      patternWindowBars: DEFAULT_PATTERN_WINDOW_BARS,
      candidateLimit: 100,
      ...parsedSettings,
      selectedResamplePoints: sanitizeSelectedResamplePoints(parsedSettings.selectedResamplePoints ?? DEFAULT_SELECTED_RESAMPLE_POINTS),
      candidatePatternLengths: sanitizeCandidatePatternLengths(parsedSettings.candidatePatternLengths ?? DEFAULT_CANDIDATE_PATTERN_LENGTHS),
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapLabelRow(row: PatternLabelRow): PatternLabel {
  return {
    id: row.id,
    profileId: row.profileId,
    ticker: row.ticker.toUpperCase(),
    setupDate: row.setupDate,
    label: row.label,
    status: row.status,
    source: row.source,
    contextWindowBars: Number(row.contextWindowBars),
    patternWindowBars: Number(row.patternWindowBars),
    patternStartDate: row.patternStartDate ?? null,
    patternEndDate: row.patternEndDate ?? row.setupDate ?? null,
    selectedBarCount: row.selectedBarCount == null ? null : Number(row.selectedBarCount),
    selectionMode: row.selectionMode === "chart_range" ? "chart_range" : "fixed_window",
    tags: parseJson<string[]>(row.tagsJson, []),
    notes: row.notes,
    featureVersion: row.featureVersion,
    featureJson: parseJson<PatternFeatureJson>(row.featureJson, {}),
    shapeJson: parseJson<PatternShapeJson>(row.shapeJson, {}),
    windowHash: row.windowHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapModelRow(row: PatternModelRow): PatternModelVersion {
  return {
    id: row.id,
    profileId: row.profileId,
    modelType: row.modelType,
    featureVersion: row.featureVersion,
    model: parseJson<PatternModelJson>(row.modelJson, emptyModelJson()),
    metrics: parseJson<PatternValidationMetrics>(row.metricsJson, emptyMetrics()),
    featureSummary: parseJson<PatternFeatureSummary>(row.featureSummaryJson, emptyFeatureSummary()),
    approvedCount: Number(row.approvedCount ?? 0),
    rejectedCount: Number(row.rejectedCount ?? 0),
    active: Number(row.active) === 1,
    createdAt: row.createdAt,
  };
}

function mapRunRow(row: PatternRunRow): PatternRun {
  return {
    id: row.id,
    profileId: row.profileId,
    tradingDate: row.tradingDate,
    status: row.status,
    phase: row.phase,
    totalCount: Number(row.totalCount ?? 0),
    processedCount: Number(row.processedCount ?? 0),
    matchedCount: Number(row.matchedCount ?? 0),
    cursorOffset: Number(row.cursorOffset ?? 0),
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    error: row.error,
    warning: row.warning,
  };
}

function mapCandidateRow(row: PatternCandidateRow): PatternCandidate {
  return {
    id: row.id,
    runId: row.runId,
    profileId: row.profileId,
    ticker: row.ticker.toUpperCase(),
    rank: Number(row.rank ?? 0),
    score: Number(row.score ?? 0),
    reasons: parseJson<PatternScoreReasons>(row.reasonsJson, emptyScoreReasons(0, "heuristic", 0)),
    nearestApproved: parseJson<PatternExampleReference[]>(row.nearestApprovedJson, []),
    nearestRejected: parseJson<PatternExampleReference[]>(row.nearestRejectedJson, []),
    featureJson: parseJson<PatternFeatureJson>(row.featureJson, {}),
    shapeJson: parseJson<PatternShapeJson>(row.shapeJson, {}),
    sourceMetadata: parseJson<Record<string, unknown>>(row.sourceMetadataJson, {}),
    createdAt: row.createdAt,
    tradingDate: row.tradingDate,
    updatedAt: row.updatedAt,
  };
}

function emptyModelJson(): PatternModelJson {
  return {
    modelType: PATTERN_MODEL_TYPE,
    featureVersion: PATTERN_FEATURE_VERSION,
    enoughLabels: false,
    scalarKeys: [...SCALAR_FEATURE_KEYS],
    shapeKeys: [...SHAPE_FEATURE_KEYS],
    scalarNormalization: {},
    approvedScalarCentroid: {},
    rejectedScalarCentroid: {},
    approvedShapeCentroid: {},
    rejectedShapeCentroid: {},
    featureWeights: Object.fromEntries([...SCALAR_FEATURE_KEYS, ...SHAPE_FEATURE_KEYS].map((key) => [key, 1])),
    tagWeights: {},
    nearestReferences: { approved: [], rejected: [] },
  };
}

function emptyMetrics(): PatternValidationMetrics {
  return {
    enoughLabels: false,
    approvedCount: 0,
    rejectedCount: 0,
    totalActiveLabels: 0,
    chronologicalAccuracy: null,
    precisionAt25: null,
    precisionAt50: null,
    validationWindowSize: 0,
  };
}

function emptyFeatureSummary(): PatternFeatureSummary {
  return { scalarStats: {}, topWeightedFeatures: [] };
}

function emptyScoreReasons(score: number, mode: "heuristic" | "model", heuristicScore: number): PatternScoreReasons {
  return {
    score,
    mode,
    approvedSimilarity: null,
    rejectedSimilarity: null,
    scalarSimilarity: null,
    shapeSimilarity: null,
    activeLearningPriority: 0,
    heuristicScore,
    positiveContributions: [],
    negativeContributions: [],
    summary: [],
  };
}

async function loadBarsByCount(
  env: Env,
  tickers: string[],
  endDate: string,
  barLimit: number,
): Promise<Map<string, PatternDailyBar[]>> {
  const uniqueTickers = Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  const out = new Map<string, PatternDailyBar[]>();
  if (uniqueTickers.length === 0 || barLimit <= 0) return out;
  for (let index = 0; index < uniqueTickers.length; index += PATTERN_UNIVERSE_QUERY_CHUNK_SIZE) {
    const chunk = uniqueTickers.slice(index, index + PATTERN_UNIVERSE_QUERY_CHUNK_SIZE);
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
      .all<PatternDailyBar>();
    for (const row of rows.results ?? []) {
      const ticker = row.ticker.toUpperCase();
      const list = out.get(ticker) ?? [];
      list.push({
        ticker,
        date: row.date,
        o: Number(row.o),
        h: Number(row.h),
        l: Number(row.l),
        c: Number(row.c),
        volume: row.volume == null ? 0 : Number(row.volume),
      });
      out.set(ticker, list);
    }
  }
  return out;
}

export function buildPatternFeatureSnapshot(input: {
  ticker: string;
  setupDate: string;
  patternStartDate?: string | null;
  patternEndDate?: string | null;
  selectionMode?: PatternSelectionMode;
  tickerBars: PatternDailyBar[];
  benchmarkBars: PatternDailyBar[];
  benchmarkTicker?: string;
  contextWindowBars?: number;
  patternWindowBars?: number;
  selectedResamplePoints?: number;
}): PatternFeatureSnapshot | null {
  const ticker = input.ticker.trim().toUpperCase();
  const setupDate = input.patternEndDate ?? input.setupDate;
  const patternEndDate = setupDate;
  const explicitPatternStartDate = input.patternStartDate ?? null;
  const selectionMode: PatternSelectionMode = explicitPatternStartDate ? (input.selectionMode ?? "chart_range") : (input.selectionMode ?? "fixed_window");
  const benchmarkTicker = (input.benchmarkTicker ?? DEFAULT_BENCHMARK_TICKER).trim().toUpperCase();
  const contextWindowBars = Math.max(MIN_EXTRACT_BARS, Math.trunc(input.contextWindowBars ?? DEFAULT_CONTEXT_WINDOW_BARS));
  const patternWindowBars = Math.max(20, Math.trunc(input.patternWindowBars ?? DEFAULT_PATTERN_WINDOW_BARS));
  const selectedResamplePoints = sanitizeSelectedResamplePoints(input.selectedResamplePoints ?? DEFAULT_SELECTED_RESAMPLE_POINTS);
  if (explicitPatternStartDate && explicitPatternStartDate > patternEndDate) {
    throw new Error("Pattern start date must be on or before the setup/end date.");
  }
  const bars = [...input.tickerBars]
    .filter((bar) => bar.ticker.toUpperCase() === ticker && bar.date <= setupDate && Number.isFinite(bar.c))
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-contextWindowBars);
  const benchmarkBars = [...input.benchmarkBars]
    .filter((bar) => bar.ticker.toUpperCase() === benchmarkTicker && bar.date <= setupDate && Number.isFinite(bar.c))
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-contextWindowBars);
  if (bars.length < MIN_EXTRACT_BARS) return null;

  const latest = bars[bars.length - 1];
  const index = bars.length - 1;
  const patternBars = explicitPatternStartDate
    ? bars.filter((bar) => bar.date >= explicitPatternStartDate && bar.date <= patternEndDate)
    : bars.slice(-Math.min(patternWindowBars, bars.length));
  if (patternBars.length < MIN_SELECTED_PATTERN_BARS) return null;
  if (patternBars.length > MAX_SELECTED_PATTERN_BARS) {
    throw new Error(`Pattern window cannot exceed ${MAX_SELECTED_PATTERN_BARS} trading bars.`);
  }
  const selectedBarCount = patternBars.length;
  const patternStartDate = patternBars[0]?.date ?? null;
  const closes = bars.map((bar) => bar.c);
  const highs = bars.map((bar) => bar.h);
  const lows = bars.map((bar) => bar.l);
  const volumes = bars.map((bar) => Number(bar.volume ?? 0));
  const selectedCloses = patternBars.map((bar) => bar.c);
  const selectedHighs = patternBars.map((bar) => bar.h);
  const selectedLows = patternBars.map((bar) => bar.l);
  const selectedVolumes = patternBars.map((bar) => Number(bar.volume ?? 0));
  const close = latest.c;
  const atr10 = atrAt(bars, 10, index);
  const atr50 = atrAt(bars, 50, index);
  const high10 = highest(highs, 10, index);
  const low10 = lowest(lows, 10, index);
  const high20 = highest(highs, 20, index);
  const low20 = lowest(lows, 20, index);
  const high252 = highest(highs, 252, index);
  const finiteSelectedHighs = selectedHighs.filter(Number.isFinite);
  const finiteSelectedLows = selectedLows.filter(Number.isFinite);
  const patternHigh = finiteSelectedHighs.length > 0 ? Math.max(...finiteSelectedHighs) : null;
  const patternLow = finiteSelectedLows.length > 0 ? Math.min(...finiteSelectedLows) : null;
  const sma20 = sma(closes, 20, index);
  const sma50 = sma(closes, 50, index);
  const sma200 = sma(closes, 200, index);
  const avgVol10 = mean(volumes.slice(-10));
  const avgVol20 = mean(volumes.slice(-20));
  const avgVol50 = mean(volumes.slice(-50));
  const latestVolume = volumes[volumes.length - 1] ?? null;
  const upVolume = bars.slice(-20).reduce((sum, bar, sliceIndex, slice) => {
    const previous = sliceIndex > 0 ? slice[sliceIndex - 1] : bars[bars.length - 20 - 1];
    return previous && bar.c > previous.c ? sum + Number(bar.volume ?? 0) : sum;
  }, 0);
  const downVolume = bars.slice(-20).reduce((sum, bar, sliceIndex, slice) => {
    const previous = sliceIndex > 0 ? slice[sliceIndex - 1] : bars[bars.length - 20 - 1];
    return previous && bar.c < previous.c ? sum + Number(bar.volume ?? 0) : sum;
  }, 0);
  const tightnessValues = patternBars.slice(-10).map((bar, sliceIndex, slice) => (
    sliceIndex === 0 ? null : pctChange(bar.c, slice[sliceIndex - 1].c)
  )).filter((value): value is number => value != null).map((value) => Math.abs(value));
  const segmentLength = Math.max(2, Math.floor(patternBars.length / 4));
  const segmentLows = [4, 3, 2, 1].map((segment) => {
    const end = patternBars.length - (segment - 1) * segmentLength;
    const start = Math.max(0, end - segmentLength);
    return lowest(patternBars.slice(start, end).map((bar) => bar.l), segmentLength, Math.min(segmentLength - 1, end - start - 1));
  });
  let higherLowsCount = 0;
  for (let current = 1; current < segmentLows.length; current += 1) {
    const previous = segmentLows[current - 1];
    const next = segmentLows[current];
    if (previous != null && next != null && next > previous) higherLowsCount += 1;
  }

  const benchmarkByDate = new Map(benchmarkBars.map((bar) => [bar.date, bar]));
  const rsRows = bars.map((bar) => {
    const benchmark = benchmarkByDate.get(bar.date);
    return benchmark && benchmark.c !== 0 ? bar.c / benchmark.c : null;
  });
  const rsLatest = rsRows[rsRows.length - 1] ?? null;
  const rsHigh60 = Math.max(...rsRows.slice(-60).filter((value): value is number => value != null && Number.isFinite(value)));
  const rsLineNearHigh = rsLatest != null && Number.isFinite(rsHigh60) && rsHigh60 > 0 && rsLatest >= rsHigh60 * 0.95 ? 1 : 0;
  const rollingAtrValues = bars.map((_, rowIndex) => atrAt(bars, 10, rowIndex));
  const distance20Path = closes.map((value, rowIndex) => {
    const ma = sma(closes, 20, rowIndex);
    return ma && ma !== 0 ? ((value / ma) - 1) * 100 : null;
  });
  const distance50Path = closes.map((value, rowIndex) => {
    const ma = sma(closes, 50, rowIndex);
    return ma && ma !== 0 ? ((value / ma) - 1) * 100 : null;
  });
  const contextIndexByDate = new Map(bars.map((bar, rowIndex) => [bar.date, rowIndex]));
  const selectedIndexes = patternBars.map((bar) => contextIndexByDate.get(bar.date)).filter((value): value is number => typeof value === "number");
  const selectedRsRows = selectedIndexes.map((rowIndex) => rsRows[rowIndex] ?? null);
  const selectedAtrRows = selectedIndexes.map((rowIndex) => rollingAtrValues[rowIndex] ?? null);
  const selectedDistance20Rows = selectedIndexes.map((rowIndex) => distance20Path[rowIndex] ?? null);
  const selectedDistance50Rows = selectedIndexes.map((rowIndex) => distance50Path[rowIndex] ?? null);
  const selectedRangeRows = patternBars.map((bar) => bar.c !== 0 ? ((bar.h - bar.l) / bar.c) * 100 : null);
  const selectedUpVolume = patternBars.reduce((sum, bar, sliceIndex, slice) => {
    const previous = sliceIndex > 0 ? slice[sliceIndex - 1] : null;
    return previous && bar.c > previous.c ? sum + Number(bar.volume ?? 0) : sum;
  }, 0);
  const selectedDownVolume = patternBars.reduce((sum, bar, sliceIndex, slice) => {
    const previous = sliceIndex > 0 ? slice[sliceIndex - 1] : null;
    return previous && bar.c < previous.c ? sum + Number(bar.volume ?? 0) : sum;
  }, 0);
  const firstSelectedIndex = selectedIndexes[0] ?? 0;
  const priorVolumeWindow = bars.slice(Math.max(0, firstSelectedIndex - 50), firstSelectedIndex).map((bar) => Number(bar.volume ?? 0));
  const selectedAvgVolume = mean(selectedVolumes);
  const priorAvgVolume = mean(priorVolumeWindow);

  const featureJson: PatternFeatureJson = {
    range_10d_pct: high10 != null && low10 != null && close !== 0 ? ((high10 - low10) / close) * 100 : null,
    range_20d_pct: high20 != null && low20 != null && close !== 0 ? ((high20 - low20) / close) * 100 : null,
    atr_10: finiteOrNull(atr10),
    atr_50: finiteOrNull(atr50),
    atr_contraction_ratio: atr10 != null && atr50 != null && atr50 !== 0 ? atr10 / atr50 : null,
    volume_dryup_ratio: selectedAvgVolume != null && priorAvgVolume != null && priorAvgVolume !== 0
      ? selectedAvgVolume / priorAvgVolume
      : avgVol10 != null && avgVol50 != null && avgVol50 !== 0 ? avgVol10 / avgVol50 : null,
    close_vs_20sma_pct: sma20 && sma20 !== 0 ? ((close / sma20) - 1) * 100 : null,
    close_vs_50sma_pct: sma50 && sma50 !== 0 ? ((close / sma50) - 1) * 100 : null,
    close_vs_200sma_pct: sma200 && sma200 !== 0 ? ((close / sma200) - 1) * 100 : null,
    distance_from_52w_high_pct: high252 && high252 !== 0 ? ((close / high252) - 1) * 100 : null,
    higher_lows_count: higherLowsCount,
    rs_line_near_high: rsLineNearHigh,
    prior_runup_60d_pct: bars.length > 60 ? pctChange(close, bars[bars.length - 61].c) : null,
    base_depth_pct: patternHigh != null && patternLow != null && patternHigh !== 0 ? ((patternHigh - patternLow) / patternHigh) * 100 : null,
    base_length_bars: selectedBarCount,
    price_tightness_10d: mean(tightnessValues),
    up_down_volume_ratio_20d: selectedDownVolume > 0 ? selectedUpVolume / selectedDownVolume : (
      selectedUpVolume > 0 ? 99 : downVolume > 0 ? upVolume / downVolume : (upVolume > 0 ? 99 : null)
    ),
    dollar_volume_20d: averageDollarVolume(bars, 20),
    relative_volume_20d: latestVolume != null && avgVol20 != null && avgVol20 !== 0 ? latestVolume / avgVol20 : null,
  };

  const shapeJson: PatternShapeJson = {
    price_path_20d: normalizeToStart(closes.slice(-20), 20),
    price_path_40d: normalizeToStart(closes.slice(-40), 40),
    price_path_60d: normalizeToStart(closes.slice(-60), 60),
    high_low_range_path_40d: normalizeByMedian(bars.slice(-40).map((bar) => bar.c !== 0 ? ((bar.h - bar.l) / bar.c) * 100 : null), 40),
    volume_path_40d: normalizeByMedian(volumes.slice(-40), 40),
    rolling_atr_path_40d: normalizeByMedian(rollingAtrValues.slice(-40), 40),
    relative_strength_path_60d: normalizeToStart(rsRows.slice(-60), 60),
    distance_from_20sma_path_40d: padLeft(distance20Path.slice(-40), 40),
    distance_from_50sma_path_40d: padLeft(distance50Path.slice(-40), 40),
    selected_price_path_64: normalizeSelectionToStart(selectedCloses, selectedResamplePoints),
    selected_volume_path_64: normalizeSelectionByMedian(selectedVolumes, selectedResamplePoints),
    selected_range_path_64: normalizeSelectionByMedian(selectedRangeRows, selectedResamplePoints),
    selected_atr_path_64: normalizeSelectionByMedian(selectedAtrRows, selectedResamplePoints),
    selected_rs_path_64: normalizeSelectionToStart(selectedRsRows, selectedResamplePoints),
    selected_distance_from_20sma_path_64: resampleSeries(selectedDistance20Rows, selectedResamplePoints),
    selected_distance_from_50sma_path_64: resampleSeries(selectedDistance50Rows, selectedResamplePoints),
  };

  const firstBarDate = bars[0]?.date ?? null;
  const latestBarDate = latest.date;
  const benchmarkLatestBarDate = benchmarkBars.at(-1)?.date ?? null;
  const windowHash = hashString(JSON.stringify({
    ticker,
    setupDate,
    firstBarDate,
    latestBarDate,
    benchmarkTicker,
    benchmarkLatestBarDate,
    contextWindowBars,
    patternWindowBars,
    patternStartDate,
    patternEndDate,
    selectedBarCount,
    selectionMode,
    selectedResamplePoints,
    close,
  }));

  return {
    featureVersion: PATTERN_FEATURE_VERSION,
    ticker,
    setupDate,
    patternStartDate,
    patternEndDate,
    selectedBarCount,
    selectionMode,
    benchmarkTicker,
    contextWindowBars,
    patternWindowBars,
    featureJson,
    shapeJson,
    windowHash,
    sourceMetadata: {
      ticker,
      setupDate,
      patternStartDate,
      patternEndDate,
      selectedBarCount,
      selectionMode,
      latestBarDate,
      firstBarDate,
      benchmarkTicker,
      benchmarkLatestBarDate,
      barCount: bars.length,
      benchmarkBarCount: benchmarkBars.length,
      price: close,
      avgDollarVolume20d: featureJson.dollar_volume_20d,
      warning: benchmarkBars.length < MIN_EXTRACT_BARS ? "Benchmark history is sparse; RS features may be partially null." : null,
    },
  };
}

export async function extractPatternFeatures(
  env: Env,
  input: {
    profileId?: string;
    ticker: string;
    setupDate: string;
    patternStartDate?: string | null;
    patternEndDate?: string | null;
    selectionMode?: PatternSelectionMode;
    contextWindowBars?: number;
    patternWindowBars?: number;
  },
): Promise<PatternFeatureSnapshot | null> {
  const profile = await loadPatternProfile(env, input.profileId ?? DEFAULT_PATTERN_PROFILE_ID);
  const contextWindowBars = input.contextWindowBars ?? profile?.settings.contextWindowBars ?? DEFAULT_CONTEXT_WINDOW_BARS;
  const patternWindowBars = input.patternWindowBars ?? profile?.settings.patternWindowBars ?? DEFAULT_PATTERN_WINDOW_BARS;
  const benchmarkTicker = profile?.benchmarkTickers[0] ?? DEFAULT_BENCHMARK_TICKER;
  const ticker = input.ticker.trim().toUpperCase();
  const setupDate = input.patternEndDate ?? input.setupDate;
  const bars = await loadBarsByCount(env, [ticker, benchmarkTicker], setupDate, contextWindowBars);
  return buildPatternFeatureSnapshot({
    ticker,
    setupDate,
    patternStartDate: input.patternStartDate,
    patternEndDate: input.patternEndDate,
    selectionMode: input.selectionMode,
    benchmarkTicker,
    tickerBars: bars.get(ticker) ?? [],
    benchmarkBars: bars.get(benchmarkTicker) ?? [],
    contextWindowBars,
    patternWindowBars,
    selectedResamplePoints: profile?.settings.selectedResamplePoints ?? DEFAULT_SELECTED_RESAMPLE_POINTS,
  });
}

export async function loadPatternChartData(
  env: Env,
  input: {
    profileId?: string;
    ticker: string;
    endDate: string;
    contextBars?: number;
  },
): Promise<PatternChartData> {
  const profile = await loadPatternProfile(env, input.profileId ?? DEFAULT_PATTERN_PROFILE_ID);
  const benchmarkTicker = profile?.benchmarkTickers[0] ?? DEFAULT_BENCHMARK_TICKER;
  const ticker = input.ticker.trim().toUpperCase();
  const contextWindowBars = Math.max(MIN_EXTRACT_BARS, Math.min(520, Math.trunc(input.contextBars ?? profile?.settings.contextWindowBars ?? DEFAULT_CONTEXT_WINDOW_BARS)));
  const barsByTicker = await loadBarsByCount(env, [ticker, benchmarkTicker], input.endDate, contextWindowBars);
  const tickerBars = barsByTicker.get(ticker) ?? [];
  const benchmarkBars = barsByTicker.get(benchmarkTicker) ?? [];
  const benchmarkByDate = new Map(benchmarkBars.map((bar) => [bar.date, bar]));
  const bars: PatternChartBar[] = tickerBars.map((bar) => {
    const benchmark = benchmarkByDate.get(bar.date);
    return {
      ticker,
      date: bar.date,
      o: Number(bar.o),
      h: Number(bar.h),
      l: Number(bar.l),
      c: Number(bar.c),
      volume: Number(bar.volume ?? 0),
      rs: benchmark && benchmark.c !== 0 ? bar.c / benchmark.c : null,
    };
  });
  const warnings: string[] = [];
  if (bars.length < MIN_EXTRACT_BARS) warnings.push(`Only ${bars.length} stored bars were found through ${input.endDate}.`);
  if (benchmarkBars.length < MIN_EXTRACT_BARS) warnings.push(`${benchmarkTicker} benchmark history is sparse; RS values may be partial.`);
  if (bars.at(-1)?.date !== input.endDate) warnings.push(`Latest stored bar is ${bars.at(-1)?.date ?? "unavailable"}, not ${input.endDate}.`);
  return {
    ticker,
    endDate: input.endDate,
    benchmarkTicker,
    contextWindowBars,
    availableStartDate: bars[0]?.date ?? null,
    availableEndDate: bars.at(-1)?.date ?? null,
    bars,
    warnings,
  };
}

export async function loadPatternProfile(env: Env, profileId = DEFAULT_PATTERN_PROFILE_ID): Promise<PatternProfile | null> {
  const db = requirePatternDb(env);
  const row = await db.prepare(
    `SELECT
       id,
       name,
       description,
       benchmark_tickers_json as benchmarkTickersJson,
       prefilter_config_json as prefilterConfigJson,
       active_model_id as activeModelId,
       settings_json as settingsJson,
       created_at as createdAt,
       updated_at as updatedAt
     FROM pattern_profiles
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(profileId)
    .first<PatternProfileRow>();
  return row ? mapProfileRow(row) : null;
}

async function ensurePatternProfile(env: Env, profileId = DEFAULT_PATTERN_PROFILE_ID): Promise<PatternProfile> {
  const profile = await loadPatternProfile(env, profileId);
  if (profile) return profile;
  if (profileId !== DEFAULT_PATTERN_PROFILE_ID) throw new Error("Pattern profile not found.");
  const db = requirePatternDb(env);
  await db.prepare(
    `INSERT OR IGNORE INTO pattern_profiles
      (id, name, description, benchmark_tickers_json, prefilter_config_json, settings_json)
     VALUES (?, 'Default', 'Default pattern-learning profile.', '["SPY"]', ?, ?)`,
  )
    .bind(
      DEFAULT_PATTERN_PROFILE_ID,
      JSON.stringify({ minPrice: 3, minDollarVolume20d: 5_000_000, minBars: DEFAULT_CONTEXT_WINDOW_BARS }),
      JSON.stringify({
        contextWindowBars: DEFAULT_CONTEXT_WINDOW_BARS,
        patternWindowBars: DEFAULT_PATTERN_WINDOW_BARS,
        candidateLimit: 100,
        selectedResamplePoints: DEFAULT_SELECTED_RESAMPLE_POINTS,
        candidatePatternLengths: DEFAULT_CANDIDATE_PATTERN_LENGTHS,
      }),
    )
    .run();
  const created = await loadPatternProfile(env, profileId);
  if (!created) throw new Error("Failed to create default pattern profile.");
  return created;
}

export async function listPatternLabels(env: Env, profileId = DEFAULT_PATTERN_PROFILE_ID): Promise<PatternLabel[]> {
  const db = requirePatternDb(env);
  const rows = await db.prepare(
    `SELECT
       id,
       profile_id as profileId,
       ticker,
       setup_date as setupDate,
       label,
       status,
       source,
       context_window_bars as contextWindowBars,
       pattern_window_bars as patternWindowBars,
       pattern_start_date as patternStartDate,
       pattern_end_date as patternEndDate,
       selected_bar_count as selectedBarCount,
       selection_mode as selectionMode,
       tags_json as tagsJson,
       notes,
       feature_version as featureVersion,
       feature_json as featureJson,
       shape_json as shapeJson,
       window_hash as windowHash,
       created_at as createdAt,
       updated_at as updatedAt
     FROM pattern_labels
     WHERE profile_id = ?
     ORDER BY datetime(updated_at) DESC, ticker ASC`,
  )
    .bind(profileId)
    .all<PatternLabelRow>();
  return (rows.results ?? []).map(mapLabelRow);
}

async function listActiveTrainingLabels(env: Env, profileId: string): Promise<PatternLabel[]> {
  return (await listPatternLabels(env, profileId))
    .filter((label) => label.status === "active" && (label.label === "approved" || label.label === "rejected"));
}

export async function createPatternLabel(env: Env, input: PatternLabelCreateInput): Promise<PatternLabel | null> {
  const db = requirePatternDb(env);
  const profile = await ensurePatternProfile(env, input.profileId ?? DEFAULT_PATTERN_PROFILE_ID);
  const labelValue = input.label;
  const status = input.status ?? (labelValue === "skipped" ? "archived" : "active");
  const setupDate = input.patternEndDate ?? input.setupDate;
  const extraction = await extractPatternFeatures(env, {
    profileId: profile.id,
    ticker: input.ticker,
    setupDate,
    patternStartDate: input.patternStartDate ?? null,
    patternEndDate: input.patternEndDate ?? setupDate,
    selectionMode: input.selectionMode ?? (input.patternStartDate ? "chart_range" : "fixed_window"),
    contextWindowBars: input.contextWindowBars ?? profile.settings.contextWindowBars,
    patternWindowBars: input.patternWindowBars ?? profile.settings.patternWindowBars,
  });
  if (!extraction) {
    throw new Error(`Insufficient stored bars or invalid selected window for ${input.ticker.toUpperCase()} through ${setupDate}.`);
  }
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO pattern_labels
      (id, profile_id, ticker, setup_date, label, status, source, context_window_bars, pattern_window_bars, pattern_start_date, pattern_end_date, selected_bar_count, selection_mode, tags_json, notes, feature_version, feature_json, shape_json, window_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  )
    .bind(
      id,
      profile.id,
      extraction.ticker,
      extraction.setupDate,
      labelValue,
      status,
      input.source ?? "manual",
      extraction.contextWindowBars,
      extraction.patternWindowBars,
      extraction.patternStartDate,
      extraction.patternEndDate,
      extraction.selectedBarCount,
      extraction.selectionMode,
      JSON.stringify(input.tags ?? []),
      input.notes ?? null,
      extraction.featureVersion,
      JSON.stringify(extraction.featureJson),
      JSON.stringify(extraction.shapeJson),
      extraction.windowHash,
    )
    .run();
  await insertReviewEvent(env, {
    profileId: profile.id,
    runId: input.runId ?? null,
    candidateId: input.candidateId ?? null,
    labelId: id,
    ticker: extraction.ticker,
    setupDate: extraction.setupDate,
    eventType: labelValue === "skipped" ? "skip" : `label_${labelValue}`,
    payload: {
      source: input.source ?? "manual",
      status,
      tags: input.tags ?? [],
      patternStartDate: extraction.patternStartDate,
      patternEndDate: extraction.patternEndDate,
      selectedBarCount: extraction.selectedBarCount,
      selectionMode: extraction.selectionMode,
    },
  });
  if (labelValue !== "skipped") await rebuildPatternModel(env, profile.id);
  return await loadPatternLabel(env, id);
}

export async function createPatternLabelsBulk(
  env: Env,
  input: {
    profileId?: string;
    csvText?: string;
    labels?: Array<Omit<PatternLabelCreateInput, "profileId">>;
    contextWindowBars?: number;
    patternWindowBars?: number;
  },
): Promise<{ created: PatternLabel[]; errors: Array<{ row: number; error: string }> }> {
  const labels = input.labels?.length
    ? input.labels
    : parseBulkCsv(input.csvText ?? "").map((row) => ({
      ticker: row.ticker,
      setupDate: row.setupDate,
      label: row.label,
      tags: row.tags,
      notes: row.notes,
      source: "bulk_csv",
    }));
  const created: PatternLabel[] = [];
  const errors: Array<{ row: number; error: string }> = [];
  for (let index = 0; index < labels.length; index += 1) {
    try {
      const row = labels[index] as Omit<PatternLabelCreateInput, "profileId">;
      const label = await createPatternLabel(env, {
        ...row,
        profileId: input.profileId ?? DEFAULT_PATTERN_PROFILE_ID,
        contextWindowBars: row.contextWindowBars ?? input.contextWindowBars,
        patternWindowBars: row.patternWindowBars ?? input.patternWindowBars,
      });
      if (label) created.push(label);
    } catch (error) {
      errors.push({ row: index + 1, error: error instanceof Error ? error.message : "Failed to create label." });
    }
  }
  if (created.some((label) => label.label !== "skipped")) {
    await rebuildPatternModel(env, input.profileId ?? DEFAULT_PATTERN_PROFILE_ID);
  }
  return { created, errors };
}

function parseBulkCsv(csvText: string): Array<{ ticker: string; setupDate: string; label: PatternLabelValue; tags: string[]; notes: string | null }> {
  return csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(",").map((part) => part.trim()))
    .filter((parts) => parts.length >= 3 && parts[0].toLowerCase() !== "ticker")
    .map((parts) => ({
      ticker: parts[0].toUpperCase(),
      setupDate: parts[1],
      label: (parts[2].toLowerCase() === "reject" ? "rejected" : parts[2].toLowerCase() === "skip" ? "skipped" : parts[2].toLowerCase()) as PatternLabelValue,
      tags: parts[3] ? parts[3].split(/[|;]/).map((tag) => tag.trim()).filter(Boolean) : [],
      notes: parts.slice(4).join(", ").trim() || null,
    }));
}

async function loadPatternLabel(env: Env, labelId: string): Promise<PatternLabel | null> {
  const db = requirePatternDb(env);
  const row = await db.prepare(
    `SELECT
       id,
       profile_id as profileId,
       ticker,
       setup_date as setupDate,
       label,
       status,
       source,
       context_window_bars as contextWindowBars,
       pattern_window_bars as patternWindowBars,
       pattern_start_date as patternStartDate,
       pattern_end_date as patternEndDate,
       selected_bar_count as selectedBarCount,
       selection_mode as selectionMode,
       tags_json as tagsJson,
       notes,
       feature_version as featureVersion,
       feature_json as featureJson,
       shape_json as shapeJson,
       window_hash as windowHash,
       created_at as createdAt,
       updated_at as updatedAt
     FROM pattern_labels
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(labelId)
    .first<PatternLabelRow>();
  return row ? mapLabelRow(row) : null;
}

export async function updatePatternLabel(env: Env, labelId: string, patch: PatternLabelPatchInput): Promise<PatternLabel | null> {
  const existing = await loadPatternLabel(env, labelId);
  if (!existing) return null;
  const db = requirePatternDb(env);
  const ticker = patch.ticker ?? existing.ticker;
  const setupDate = patch.patternEndDate ?? patch.setupDate ?? existing.patternEndDate ?? existing.setupDate;
  const contextWindowBars = patch.contextWindowBars ?? existing.contextWindowBars;
  const patternWindowBars = patch.patternWindowBars ?? existing.patternWindowBars;
  const patternStartDate = patch.patternStartDate !== undefined ? patch.patternStartDate : existing.patternStartDate;
  const patternEndDate = patch.patternEndDate ?? patch.setupDate ?? existing.patternEndDate ?? setupDate;
  const selectionMode = patch.selectionMode ?? existing.selectionMode;
  let nextPatternStartDate = existing.patternStartDate;
  let nextPatternEndDate = existing.patternEndDate ?? setupDate;
  let nextSelectedBarCount = existing.selectedBarCount;
  let nextSelectionMode = existing.selectionMode;
  let featureJson = existing.featureJson;
  let shapeJson = existing.shapeJson;
  let windowHash = existing.windowHash;
  let featureVersion = existing.featureVersion;
  if (
    ticker !== existing.ticker
    || setupDate !== existing.setupDate
    || contextWindowBars !== existing.contextWindowBars
    || patternWindowBars !== existing.patternWindowBars
    || patternStartDate !== existing.patternStartDate
    || patternEndDate !== (existing.patternEndDate ?? existing.setupDate)
    || selectionMode !== existing.selectionMode
  ) {
    const extraction = await extractPatternFeatures(env, {
      profileId: existing.profileId,
      ticker,
      setupDate,
      patternStartDate,
      patternEndDate,
      selectionMode,
      contextWindowBars,
      patternWindowBars,
    });
    if (!extraction) throw new Error(`Insufficient stored bars for ${ticker} through ${setupDate}.`);
    featureJson = extraction.featureJson;
    shapeJson = extraction.shapeJson;
    windowHash = extraction.windowHash;
    featureVersion = extraction.featureVersion;
    nextPatternStartDate = extraction.patternStartDate;
    nextPatternEndDate = extraction.patternEndDate;
    nextSelectedBarCount = extraction.selectedBarCount;
    nextSelectionMode = extraction.selectionMode;
  }
  await db.prepare(
    `UPDATE pattern_labels
     SET ticker = ?,
         setup_date = ?,
         label = ?,
         status = ?,
         context_window_bars = ?,
         pattern_window_bars = ?,
         pattern_start_date = ?,
         pattern_end_date = ?,
         selected_bar_count = ?,
         selection_mode = ?,
         tags_json = ?,
         notes = ?,
         feature_version = ?,
         feature_json = ?,
         shape_json = ?,
         window_hash = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(
      ticker,
      setupDate,
      patch.label ?? existing.label,
      patch.status ?? existing.status,
      contextWindowBars,
      patternWindowBars,
      nextPatternStartDate,
      nextPatternEndDate,
      nextSelectedBarCount,
      nextSelectionMode,
      JSON.stringify(patch.tags ?? existing.tags),
      patch.notes !== undefined ? patch.notes : existing.notes,
      featureVersion,
      JSON.stringify(featureJson),
      JSON.stringify(shapeJson),
      windowHash,
      labelId,
    )
    .run();
  await insertReviewEvent(env, {
    profileId: existing.profileId,
    labelId,
    ticker,
    setupDate,
    eventType: "label_update",
    payload: patch,
  });
  await rebuildPatternModel(env, existing.profileId);
  return await loadPatternLabel(env, labelId);
}

export async function deletePatternLabel(env: Env, labelId: string, options?: { hard?: boolean }): Promise<{ deleted: boolean; hard: boolean; profileId: string | null }> {
  const existing = await loadPatternLabel(env, labelId);
  if (!existing) return { deleted: false, hard: Boolean(options?.hard), profileId: null };
  const db = requirePatternDb(env);
  if (options?.hard) {
    await db.prepare("DELETE FROM pattern_labels WHERE id = ?").bind(labelId).run();
  } else {
    await db.prepare("UPDATE pattern_labels SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(labelId).run();
  }
  await insertReviewEvent(env, {
    profileId: existing.profileId,
    labelId,
    ticker: existing.ticker,
    setupDate: existing.setupDate,
    eventType: options?.hard ? "label_hard_delete" : "label_soft_delete",
    payload: {},
  });
  await rebuildPatternModel(env, existing.profileId);
  return { deleted: true, hard: Boolean(options?.hard), profileId: existing.profileId };
}

async function insertReviewEvent(env: Env, input: {
  profileId: string;
  runId?: string | null;
  candidateId?: string | null;
  labelId?: string | null;
  ticker?: string | null;
  setupDate?: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const db = requirePatternDb(env);
  await db.prepare(
    `INSERT INTO pattern_review_events
      (id, profile_id, run_id, candidate_id, label_id, ticker, setup_date, event_type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  )
    .bind(
      crypto.randomUUID(),
      input.profileId,
      input.runId ?? null,
      input.candidateId ?? null,
      input.labelId ?? null,
      input.ticker ?? null,
      input.setupDate ?? null,
      input.eventType,
      JSON.stringify(input.payload),
    )
    .run();
}

export async function listPatternFeatureRegistry(env: Env): Promise<PatternFeatureRegistryRow[]> {
  const db = requirePatternDb(env);
  const rows = await db.prepare(
    `SELECT
       feature_key as featureKey,
       display_name as displayName,
       family,
       value_type as valueType,
       enabled,
       version,
       description
     FROM pattern_feature_registry
     ORDER BY family ASC, feature_key ASC`,
  )
    .all<{
      featureKey: string;
      displayName: string;
      family: "scalar" | "shape";
      valueType: string;
      enabled: number;
      version: string;
      description: string | null;
    }>();
  return (rows.results ?? []).map((row) => ({
    ...row,
    enabled: Number(row.enabled) === 1,
  }));
}

export async function updatePatternFeatureRegistry(
  env: Env,
  featureKey: string,
  patch: { displayName?: string; enabled?: boolean; description?: string | null },
): Promise<PatternFeatureRegistryRow | null> {
  const db = requirePatternDb(env);
  const existing = (await listPatternFeatureRegistry(env)).find((row) => row.featureKey === featureKey);
  if (!existing) return null;
  await db.prepare(
    `UPDATE pattern_feature_registry
     SET display_name = ?,
         enabled = ?,
         description = ?
     WHERE feature_key = ?`,
  )
    .bind(
      patch.displayName ?? existing.displayName,
      patch.enabled ?? existing.enabled ? 1 : 0,
      patch.description !== undefined ? patch.description : existing.description,
      featureKey,
    )
    .run();
  const updated = (await listPatternFeatureRegistry(env)).find((row) => row.featureKey === featureKey) ?? null;
  return updated;
}

function enabledScalarKeys(registry: PatternFeatureRegistryRow[]): string[] {
  const enabled = registry.filter((row) => row.enabled && row.family === "scalar").map((row) => row.featureKey);
  return enabled.length > 0 ? enabled : [...SCALAR_FEATURE_KEYS];
}

function enabledShapeKeys(registry: PatternFeatureRegistryRow[]): string[] {
  const enabled = registry.filter((row) => row.enabled && row.family === "shape").map((row) => row.featureKey);
  return enabled.length > 0 ? enabled : [...SHAPE_FEATURE_KEYS];
}

function centroidScalar(labels: PatternLabel[], keys: string[], normalization: PatternModelJson["scalarNormalization"]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const key of keys) {
    out[key] = mean(labels.map((label) => {
      const value = label.featureJson[key];
      const norm = normalization[key];
      return value == null || !norm ? null : (value - norm.mean) / norm.std;
    }));
  }
  return out;
}

function centroidShape(labels: PatternLabel[], keys: string[]): PatternShapeJson {
  const out: PatternShapeJson = {};
  for (const key of keys) {
    const maxLength = Math.max(0, ...labels.map((label) => label.shapeJson[key]?.length ?? 0));
    out[key] = Array.from({ length: maxLength }, (_, index) => mean(labels.map((label) => label.shapeJson[key]?.[index] ?? null)));
  }
  return out;
}

function scalarDistanceToCentroid(
  featureJson: PatternFeatureJson,
  centroid: Record<string, number | null>,
  keys: string[],
  normalization: PatternModelJson["scalarNormalization"],
): number | null {
  const distances: number[] = [];
  for (const key of keys) {
    const value = featureJson[key];
    const target = centroid[key];
    const norm = normalization[key];
    if (value == null || target == null || !norm) continue;
    distances.push(Math.abs(((value - norm.mean) / norm.std) - target));
  }
  return distances.length > 0 ? mean(distances) : null;
}

function shapeDistanceToCentroid(shapeJson: PatternShapeJson, centroid: PatternShapeJson, keys: string[]): number | null {
  const distances: number[] = [];
  for (const key of keys) {
    const values = shapeJson[key] ?? [];
    const targets = centroid[key] ?? [];
    for (let index = 0; index < Math.min(values.length, targets.length); index += 1) {
      const value = values[index];
      const target = targets[index];
      if (value == null || target == null || !Number.isFinite(value) || !Number.isFinite(target)) continue;
      distances.push(Math.abs(value - target));
    }
  }
  return distances.length > 0 ? mean(distances) : null;
}

function distanceToLabel(
  featureJson: PatternFeatureJson,
  shapeJson: PatternShapeJson,
  label: PatternLabel,
  model: PatternModelJson,
): number {
  const scalar = scalarDistanceBetween(featureJson, label.featureJson, model.scalarKeys, model.scalarNormalization);
  const shape = shapeDistanceBetween(shapeJson, label.shapeJson, model.shapeKeys);
  if (scalar == null && shape == null) return 99;
  if (scalar == null) return shape ?? 99;
  if (shape == null) return scalar;
  return scalar * 0.55 + shape * 0.45;
}

function scalarDistanceBetween(
  left: PatternFeatureJson,
  right: PatternFeatureJson,
  keys: string[],
  normalization: PatternModelJson["scalarNormalization"],
): number | null {
  const distances: number[] = [];
  for (const key of keys) {
    const leftValue = left[key];
    const rightValue = right[key];
    const norm = normalization[key];
    if (leftValue == null || rightValue == null || !norm) continue;
    distances.push(Math.abs(((leftValue - norm.mean) / norm.std) - ((rightValue - norm.mean) / norm.std)));
  }
  return distances.length > 0 ? mean(distances) : null;
}

function shapeDistanceBetween(left: PatternShapeJson, right: PatternShapeJson, keys: string[]): number | null {
  const distances: number[] = [];
  for (const key of keys) {
    const leftValues = left[key] ?? [];
    const rightValues = right[key] ?? [];
    for (let index = 0; index < Math.min(leftValues.length, rightValues.length); index += 1) {
      const leftValue = leftValues[index];
      const rightValue = rightValues[index];
      if (leftValue == null || rightValue == null || !Number.isFinite(leftValue) || !Number.isFinite(rightValue)) continue;
      distances.push(Math.abs(leftValue - rightValue));
    }
  }
  return distances.length > 0 ? mean(distances) : null;
}

function similarity(distance: number | null): number | null {
  if (distance == null) return null;
  return 1 / (1 + Math.max(0, distance));
}

function nearestExamples(
  featureJson: PatternFeatureJson,
  shapeJson: PatternShapeJson,
  labels: PatternLabel[],
  model: PatternModelJson,
  labelValue: "approved" | "rejected",
  limit = 3,
): PatternExampleReference[] {
  return labels
    .filter((label) => label.label === labelValue)
    .map((label) => {
      const distance = distanceToLabel(featureJson, shapeJson, label, model);
      return {
        labelId: label.id,
        ticker: label.ticker,
        setupDate: label.setupDate,
        label: labelValue,
        distance,
        similarity: similarity(distance) ?? 0,
        tags: label.tags,
      };
    })
    .sort((left, right) => left.distance - right.distance)
    .slice(0, limit);
}

function heuristicPatternScore(featureJson: PatternFeatureJson): number {
  const baseDepth = featureJson.base_depth_pct;
  const dryup = featureJson.volume_dryup_ratio;
  const closeVs50 = featureJson.close_vs_50sma_pct;
  const closeVs200 = featureJson.close_vs_200sma_pct;
  const distanceHigh = featureJson.distance_from_52w_high_pct;
  const tightness = featureJson.price_tightness_10d;
  const rsNearHigh = featureJson.rs_line_near_high;
  const runup = featureJson.prior_runup_60d_pct;
  let score = 0.5;
  if (rsNearHigh === 1) score += 0.11;
  if (closeVs50 != null) score += clamp(closeVs50 / 20, -0.1, 0.12);
  if (closeVs200 != null) score += clamp(closeVs200 / 60, -0.08, 0.08);
  if (distanceHigh != null) score += clamp((25 + distanceHigh) / 100, -0.12, 0.08);
  if (baseDepth != null) score += baseDepth >= 5 && baseDepth <= 35 ? 0.08 : -0.06;
  if (dryup != null) score += dryup <= 0.85 ? 0.08 : dryup > 1.4 ? -0.07 : 0;
  if (tightness != null) score += tightness <= 2 ? 0.05 : tightness > 6 ? -0.06 : 0;
  if (runup != null) score += runup >= 20 ? 0.05 : runup < -10 ? -0.05 : 0;
  return clamp(score);
}

function buildContributions(
  featureJson: PatternFeatureJson,
  model: PatternModelJson,
): { positive: PatternContribution[]; negative: PatternContribution[] } {
  const rows: PatternContribution[] = [];
  for (const key of model.scalarKeys) {
    const value = featureJson[key] ?? null;
    const norm = model.scalarNormalization[key];
    const approved = model.approvedScalarCentroid[key];
    const rejected = model.rejectedScalarCentroid[key];
    if (value == null || !norm || approved == null || rejected == null) continue;
    const normalized = (value - norm.mean) / norm.std;
    const contribution = Math.abs(normalized - rejected) - Math.abs(normalized - approved);
    rows.push({
      featureKey: key,
      label: FEATURE_LABELS[key] ?? key,
      value,
      contribution: Number(contribution.toFixed(4)),
    });
  }
  return {
    positive: rows.filter((row) => row.contribution > 0).sort((a, b) => b.contribution - a.contribution).slice(0, 5),
    negative: rows.filter((row) => row.contribution < 0).sort((a, b) => a.contribution - b.contribution).slice(0, 5),
  };
}

export function scorePatternSnapshot(
  snapshot: PatternFeatureSnapshot,
  labels: PatternLabel[],
  modelVersion: PatternModelVersion | null,
): PatternScoreReasons {
  const heuristicScore = heuristicPatternScore(snapshot.featureJson);
  const model = modelVersion?.model;
  if (!modelVersion || !model || !model.enoughLabels) {
    const reasons = emptyScoreReasons(heuristicScore, "heuristic", heuristicScore);
    reasons.summary = [
      "Heuristic fallback is active until the profile has enough approved and rejected labels.",
      `Heuristic score ${Math.round(heuristicScore * 100)} balances trend, tightness, dry-up, depth, and RS clues.`,
    ];
    reasons.positiveContributions = [
      { featureKey: "rs_line_near_high", label: "RS near high", value: snapshot.featureJson.rs_line_near_high ?? null, contribution: snapshot.featureJson.rs_line_near_high === 1 ? 0.11 : 0 },
      { featureKey: "volume_dryup_ratio", label: "Volume dry-up", value: snapshot.featureJson.volume_dryup_ratio ?? null, contribution: 0 },
      { featureKey: "base_depth_pct", label: "Base depth", value: snapshot.featureJson.base_depth_pct ?? null, contribution: 0 },
    ];
    return reasons;
  }
  const approvedScalarDistance = scalarDistanceToCentroid(snapshot.featureJson, model.approvedScalarCentroid, model.scalarKeys, model.scalarNormalization);
  const rejectedScalarDistance = scalarDistanceToCentroid(snapshot.featureJson, model.rejectedScalarCentroid, model.scalarKeys, model.scalarNormalization);
  const approvedShapeDistance = shapeDistanceToCentroid(snapshot.shapeJson, model.approvedShapeCentroid, model.shapeKeys);
  const rejectedShapeDistance = shapeDistanceToCentroid(snapshot.shapeJson, model.rejectedShapeCentroid, model.shapeKeys);
  const approvedScalarSimilarity = similarity(approvedScalarDistance);
  const rejectedScalarSimilarity = similarity(rejectedScalarDistance);
  const approvedShapeSimilarity = similarity(approvedShapeDistance);
  const rejectedShapeSimilarity = similarity(rejectedShapeDistance);
  const approvedSimilarity = mean([approvedScalarSimilarity, approvedShapeSimilarity]);
  const rejectedSimilarity = mean([rejectedScalarSimilarity, rejectedShapeSimilarity]);
  const activeLearningPriority = clamp(1 - Math.abs(heuristicScore - 0.5) * 2);
  const base = 0.5
    + ((approvedSimilarity ?? 0.5) - (rejectedSimilarity ?? 0.5)) * 0.46
    + (heuristicScore - 0.5) * 0.24
    + activeLearningPriority * 0.06;
  const score = clamp(base);
  const contributions = buildContributions(snapshot.featureJson, model);
  return {
    score,
    mode: "model",
    approvedSimilarity,
    rejectedSimilarity,
    scalarSimilarity: approvedScalarSimilarity,
    shapeSimilarity: approvedShapeSimilarity,
    activeLearningPriority,
    heuristicScore,
    positiveContributions: contributions.positive,
    negativeContributions: contributions.negative,
    summary: [
      `Approved similarity ${Math.round((approvedSimilarity ?? 0) * 100)} vs rejected similarity ${Math.round((rejectedSimilarity ?? 0) * 100)}.`,
      `Heuristic support is ${Math.round(heuristicScore * 100)} and active-learning priority is ${Math.round(activeLearningPriority * 100)}.`,
    ],
  };
}

export async function rebuildPatternModel(env: Env, profileId = DEFAULT_PATTERN_PROFILE_ID): Promise<PatternModelVersion> {
  const db = requirePatternDb(env);
  await ensurePatternProfile(env, profileId);
  const registry = await listPatternFeatureRegistry(env).catch(() => []);
  const scalarKeys = enabledScalarKeys(registry);
  const shapeKeys = enabledShapeKeys(registry);
  const labels = await listActiveTrainingLabels(env, profileId);
  const approved = labels.filter((label) => label.label === "approved");
  const rejected = labels.filter((label) => label.label === "rejected");
  const normalization: PatternModelJson["scalarNormalization"] = {};
  for (const key of scalarKeys) {
    const values = labels.map((label) => label.featureJson[key]);
    normalization[key] = {
      mean: mean(values) ?? 0,
      std: std(values, 1),
    };
  }
  const model: PatternModelJson = {
    modelType: PATTERN_MODEL_TYPE,
    featureVersion: PATTERN_FEATURE_VERSION,
    enoughLabels: approved.length >= MIN_MODEL_CLASS_COUNT && rejected.length >= MIN_MODEL_CLASS_COUNT,
    scalarKeys,
    shapeKeys,
    scalarNormalization: normalization,
    approvedScalarCentroid: centroidScalar(approved, scalarKeys, normalization),
    rejectedScalarCentroid: centroidScalar(rejected, scalarKeys, normalization),
    approvedShapeCentroid: centroidShape(approved, shapeKeys),
    rejectedShapeCentroid: centroidShape(rejected, shapeKeys),
    featureWeights: Object.fromEntries([...scalarKeys, ...shapeKeys].map((key) => [key, 1])),
    tagWeights: buildTagWeights(approved, rejected),
    nearestReferences: {
      approved: approved.slice(-12).map((label) => labelToReference(label)),
      rejected: rejected.slice(-12).map((label) => labelToReference(label)),
    },
  };
  const featureSummary = buildFeatureSummary(approved, rejected, scalarKeys, model);
  const metrics = validateModelChronologically(labels, model);
  const modelId = crypto.randomUUID();
  await db.batch([
    db.prepare("UPDATE pattern_model_versions SET active = 0 WHERE profile_id = ?").bind(profileId),
    db.prepare(
      `INSERT INTO pattern_model_versions
        (id, profile_id, model_type, feature_version, model_json, metrics_json, feature_summary_json, approved_count, rejected_count, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
    )
      .bind(
        modelId,
        profileId,
        PATTERN_MODEL_TYPE,
        PATTERN_FEATURE_VERSION,
        JSON.stringify(model),
        JSON.stringify(metrics),
        JSON.stringify(featureSummary),
        approved.length,
        rejected.length,
      ),
    db.prepare("UPDATE pattern_profiles SET active_model_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(modelId, profileId),
  ]);
  const active = await loadPatternModel(env, profileId);
  if (!active) throw new Error("Failed to rebuild pattern model.");
  return active;
}

function buildTagWeights(approved: PatternLabel[], rejected: PatternLabel[]): Record<string, number> {
  const tags = new Set([...approved.flatMap((label) => label.tags), ...rejected.flatMap((label) => label.tags)]);
  const out: Record<string, number> = {};
  for (const tag of tags) {
    const approvedCount = approved.filter((label) => label.tags.includes(tag)).length;
    const rejectedCount = rejected.filter((label) => label.tags.includes(tag)).length;
    out[tag] = approvedCount - rejectedCount;
  }
  return out;
}

function labelToReference(label: PatternLabel): PatternExampleReference {
  return {
    labelId: label.id,
    ticker: label.ticker,
    setupDate: label.setupDate,
    label: label.label === "rejected" ? "rejected" : "approved",
    distance: 0,
    similarity: 1,
    tags: label.tags,
  };
}

function buildFeatureSummary(approved: PatternLabel[], rejected: PatternLabel[], scalarKeys: string[], model: PatternModelJson): PatternFeatureSummary {
  const scalarStats: PatternFeatureSummary["scalarStats"] = {};
  const weighted: PatternFeatureSummary["topWeightedFeatures"] = [];
  for (const key of scalarKeys) {
    const approvedValues = approved.map((label) => label.featureJson[key]);
    const rejectedValues = rejected.map((label) => label.featureJson[key]);
    const approvedAvg = mean(approvedValues);
    const rejectedAvg = mean(rejectedValues);
    const delta = approvedAvg != null && rejectedAvg != null ? approvedAvg - rejectedAvg : null;
    scalarStats[key] = {
      approvedAvg,
      rejectedAvg,
      approvedMedian: median(approvedValues),
      rejectedMedian: median(rejectedValues),
      delta,
    };
    weighted.push({
      featureKey: key,
      weight: Math.abs(delta ?? 0) / (model.scalarNormalization[key]?.std ?? 1),
      direction: delta == null ? "neutral" : delta >= 0 ? "approved" : "rejected",
    });
  }
  return {
    scalarStats,
    topWeightedFeatures: weighted.sort((left, right) => right.weight - left.weight).slice(0, 12),
  };
}

function validateModelChronologically(labels: PatternLabel[], model: PatternModelJson): PatternValidationMetrics {
  const approvedCount = labels.filter((label) => label.label === "approved").length;
  const rejectedCount = labels.filter((label) => label.label === "rejected").length;
  const validationWindowSize = Math.min(Math.ceil(labels.length * 0.2), labels.length);
  if (!model.enoughLabels || validationWindowSize < 2) {
    return {
      ...emptyMetrics(),
      enoughLabels: model.enoughLabels,
      approvedCount,
      rejectedCount,
      totalActiveLabels: labels.length,
      validationWindowSize,
    };
  }
  const ordered = [...labels].sort((left, right) => left.setupDate.localeCompare(right.setupDate));
  const validation = ordered.slice(-validationWindowSize);
  let correct = 0;
  for (const label of validation) {
    const approvedDistance = scalarDistanceToCentroid(label.featureJson, model.approvedScalarCentroid, model.scalarKeys, model.scalarNormalization);
    const rejectedDistance = scalarDistanceToCentroid(label.featureJson, model.rejectedScalarCentroid, model.scalarKeys, model.scalarNormalization);
    const predicted = (approvedDistance ?? 99) <= (rejectedDistance ?? 99) ? "approved" : "rejected";
    if (predicted === label.label) correct += 1;
  }
  return {
    enoughLabels: model.enoughLabels,
    approvedCount,
    rejectedCount,
    totalActiveLabels: labels.length,
    chronologicalAccuracy: validation.length > 0 ? correct / validation.length : null,
    precisionAt25: null,
    precisionAt50: null,
    validationWindowSize: validation.length,
  };
}

export async function loadPatternModel(env: Env, profileId = DEFAULT_PATTERN_PROFILE_ID): Promise<PatternModelVersion | null> {
  const db = requirePatternDb(env);
  const row = await db.prepare(
    `SELECT
       id,
       profile_id as profileId,
       model_type as modelType,
       feature_version as featureVersion,
       model_json as modelJson,
       metrics_json as metricsJson,
       feature_summary_json as featureSummaryJson,
       approved_count as approvedCount,
       rejected_count as rejectedCount,
       active,
       created_at as createdAt
     FROM pattern_model_versions
     WHERE profile_id = ?
       AND active = 1
     ORDER BY datetime(created_at) DESC
     LIMIT 1`,
  )
    .bind(profileId)
    .first<PatternModelRow>();
  return row ? mapModelRow(row) : null;
}

export async function loadPatternModelHistory(env: Env, profileId = DEFAULT_PATTERN_PROFILE_ID, limit = 10): Promise<PatternModelVersion[]> {
  const db = requirePatternDb(env);
  const rows = await db.prepare(
    `SELECT
       id,
       profile_id as profileId,
       model_type as modelType,
       feature_version as featureVersion,
       model_json as modelJson,
       metrics_json as metricsJson,
       feature_summary_json as featureSummaryJson,
       approved_count as approvedCount,
       rejected_count as rejectedCount,
       active,
       created_at as createdAt
     FROM pattern_model_versions
     WHERE profile_id = ?
     ORDER BY datetime(created_at) DESC
     LIMIT ?`,
  )
    .bind(profileId, Math.max(1, Math.min(50, limit)))
    .all<PatternModelRow>();
  return (rows.results ?? []).map(mapModelRow);
}

async function countEligibleUniverse(env: Env, profile: PatternProfile, tradingDate: string): Promise<number> {
  const row = await env.DB.prepare(
    `WITH latest AS (
       SELECT ticker, c as price
       FROM (
         SELECT ticker, c, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) as rn
         FROM daily_bars
         WHERE date <= ?
       )
       WHERE rn = 1
     ),
     avg20 AS (
       SELECT ticker, AVG(c * COALESCE(volume, 0)) as avgDollarVolume20d
       FROM (
         SELECT ticker, c, volume, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) as rn
         FROM daily_bars
         WHERE date <= ?
       )
       WHERE rn <= 20
       GROUP BY ticker
     ),
     coverage AS (
       SELECT ticker, COUNT(*) as barCount
       FROM daily_bars
       WHERE date <= ?
       GROUP BY ticker
     )
     SELECT COUNT(*) as count
     FROM symbols s
     JOIN latest l ON l.ticker = s.ticker
     JOIN avg20 a ON a.ticker = s.ticker
     JOIN coverage c ON c.ticker = s.ticker
     WHERE COALESCE(s.is_active, 1) = 1
       AND COALESCE(s.catalog_managed, 0) = 1
       AND lower(COALESCE(s.asset_class, '')) IN ('equity', 'stock')
       AND l.price >= ?
       AND a.avgDollarVolume20d >= ?
       AND c.barCount >= ?`,
  )
    .bind(tradingDate, tradingDate, tradingDate, profile.prefilterConfig.minPrice, profile.prefilterConfig.minDollarVolume20d, profile.prefilterConfig.minBars)
    .first<{ count: number | string | null }>();
  return Math.max(0, Number(row?.count ?? 0) || 0);
}

async function loadEligibleUniverseBatch(
  env: Env,
  profile: PatternProfile,
  tradingDate: string,
  offset: number,
  limit: number,
): Promise<UniverseCandidate[]> {
  const rows = await env.DB.prepare(
    `WITH latest AS (
       SELECT ticker, date as latestBarDate, c as price
       FROM (
         SELECT ticker, date, c, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) as rn
         FROM daily_bars
         WHERE date <= ?
       )
       WHERE rn = 1
     ),
     avg20 AS (
       SELECT ticker, AVG(c * COALESCE(volume, 0)) as avgDollarVolume20d
       FROM (
         SELECT ticker, c, volume, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) as rn
         FROM daily_bars
         WHERE date <= ?
       )
       WHERE rn <= 20
       GROUP BY ticker
     ),
     coverage AS (
       SELECT ticker, COUNT(*) as barCount
       FROM daily_bars
       WHERE date <= ?
       GROUP BY ticker
     )
     SELECT
       s.ticker,
       s.name,
       s.exchange,
       s.asset_class as assetClass,
       s.sector,
       s.industry,
       l.price,
       l.latestBarDate,
       a.avgDollarVolume20d,
       c.barCount
     FROM symbols s
     JOIN latest l ON l.ticker = s.ticker
     JOIN avg20 a ON a.ticker = s.ticker
     JOIN coverage c ON c.ticker = s.ticker
     WHERE COALESCE(s.is_active, 1) = 1
       AND COALESCE(s.catalog_managed, 0) = 1
       AND lower(COALESCE(s.asset_class, '')) IN ('equity', 'stock')
       AND l.price >= ?
       AND a.avgDollarVolume20d >= ?
       AND c.barCount >= ?
     ORDER BY s.ticker ASC
     LIMIT ?
     OFFSET ?`,
  )
    .bind(
      tradingDate,
      tradingDate,
      tradingDate,
      profile.prefilterConfig.minPrice,
      profile.prefilterConfig.minDollarVolume20d,
      profile.prefilterConfig.minBars,
      limit,
      offset,
    )
    .all<UniverseCandidate>();
  return (rows.results ?? []).map((row) => ({
    ticker: row.ticker.toUpperCase(),
    name: row.name,
    exchange: row.exchange,
    assetClass: row.assetClass,
    sector: row.sector,
    industry: row.industry,
    price: asNumber(row.price),
    avgDollarVolume20d: asNumber(row.avgDollarVolume20d),
    barCount: Number(row.barCount ?? 0),
    latestBarDate: row.latestBarDate,
  }));
}

export async function createPatternRun(env: Env, input: PatternRunCreateInput = {}): Promise<PatternRun> {
  const db = requirePatternDb(env);
  const profile = await ensurePatternProfile(env, input.profileId ?? DEFAULT_PATTERN_PROFILE_ID);
  const tradingDate = input.tradingDate ?? latestUsSessionAsOfDate(new Date());
  const existing = await loadPatternRunByProfileDate(env, profile.id, tradingDate);
  if (existing && !input.force && existing.status !== "failed") return existing;
  if (existing && input.force) {
    await db.batch([
      db.prepare("DELETE FROM pattern_run_candidates WHERE run_id = ?").bind(existing.id),
      db.prepare("DELETE FROM pattern_runs WHERE id = ?").bind(existing.id),
    ]);
  }
  const totalCount = await countEligibleUniverse(env, profile, tradingDate);
  const runId = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO pattern_runs
      (id, profile_id, trading_date, status, phase, total_count, processed_count, matched_count, cursor_offset, started_at, updated_at, completed_at, error, warning)
     VALUES (?, ?, ?, 'queued', 'queued', ?, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, NULL)`,
  )
    .bind(runId, profile.id, tradingDate, totalCount)
    .run();
  const run = await loadPatternRun(env, runId);
  if (!run) throw new Error("Failed to create pattern scan run.");
  return run;
}

async function loadPatternRunByProfileDate(env: Env, profileId: string, tradingDate: string): Promise<PatternRun | null> {
  const db = requirePatternDb(env);
  const row = await db.prepare(
    `SELECT
       id,
       profile_id as profileId,
       trading_date as tradingDate,
       status,
       phase,
       total_count as totalCount,
       processed_count as processedCount,
       matched_count as matchedCount,
       cursor_offset as cursorOffset,
       started_at as startedAt,
       updated_at as updatedAt,
       completed_at as completedAt,
       error,
       warning
     FROM pattern_runs
     WHERE profile_id = ?
       AND trading_date = ?
     LIMIT 1`,
  )
    .bind(profileId, tradingDate)
    .first<PatternRunRow>();
  return row ? mapRunRow(row) : null;
}

export async function loadPatternRun(env: Env, runId: string): Promise<PatternRun | null> {
  const db = requirePatternDb(env);
  const row = await db.prepare(
    `SELECT
       id,
       profile_id as profileId,
       trading_date as tradingDate,
       status,
       phase,
       total_count as totalCount,
       processed_count as processedCount,
       matched_count as matchedCount,
       cursor_offset as cursorOffset,
       started_at as startedAt,
       updated_at as updatedAt,
       completed_at as completedAt,
       error,
       warning
     FROM pattern_runs
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(runId)
    .first<PatternRunRow>();
  return row ? mapRunRow(row) : null;
}

export async function listPatternRuns(env: Env, profileId = DEFAULT_PATTERN_PROFILE_ID, limit = 25): Promise<PatternRun[]> {
  const db = requirePatternDb(env);
  const rows = await db.prepare(
    `SELECT
       id,
       profile_id as profileId,
       trading_date as tradingDate,
       status,
       phase,
       total_count as totalCount,
       processed_count as processedCount,
       matched_count as matchedCount,
       cursor_offset as cursorOffset,
       started_at as startedAt,
       updated_at as updatedAt,
       completed_at as completedAt,
       error,
       warning
     FROM pattern_runs
     WHERE profile_id = ?
     ORDER BY datetime(started_at) DESC
     LIMIT ?`,
  )
    .bind(profileId, Math.max(1, Math.min(100, limit)))
    .all<PatternRunRow>();
  return (rows.results ?? []).map(mapRunRow);
}

async function updatePatternRun(env: Env, runId: string, patch: Partial<{
  status: PatternRun["status"];
  phase: string;
  processedCount: number;
  matchedCount: number;
  cursorOffset: number;
  completedAt: string | null;
  error: string | null;
  warning: string | null;
}>): Promise<void> {
  const db = requirePatternDb(env);
  const assignments = ["updated_at = CURRENT_TIMESTAMP"];
  const values: unknown[] = [];
  if (patch.status) {
    assignments.push("status = ?");
    values.push(patch.status);
  }
  if (patch.phase !== undefined) {
    assignments.push("phase = ?");
    values.push(patch.phase);
  }
  if (typeof patch.processedCount === "number") {
    assignments.push("processed_count = ?");
    values.push(patch.processedCount);
  }
  if (typeof patch.matchedCount === "number") {
    assignments.push("matched_count = ?");
    values.push(patch.matchedCount);
  }
  if (typeof patch.cursorOffset === "number") {
    assignments.push("cursor_offset = ?");
    values.push(patch.cursorOffset);
  }
  if (patch.completedAt !== undefined) {
    assignments.push("completed_at = ?");
    values.push(patch.completedAt);
  }
  if (patch.error !== undefined) {
    assignments.push("error = ?");
    values.push(patch.error);
  }
  if (patch.warning !== undefined) {
    assignments.push("warning = ?");
    values.push(patch.warning);
  }
  await db.prepare(`UPDATE pattern_runs SET ${assignments.join(", ")} WHERE id = ?`).bind(...values, runId).run();
}

export async function processPatternScanRun(
  env: Env,
  runId: string,
  options?: { batchSize?: number; maxBatches?: number },
): Promise<PatternRun | null> {
  const db = requirePatternDb(env);
  let run = await loadPatternRun(env, runId);
  if (!run) return null;
  if (run.status === "completed" || run.status === "failed") return run;
  const profile = await ensurePatternProfile(env, run.profileId);
  let model = await loadPatternModel(env, profile.id);
  if (!model) model = await rebuildPatternModel(env, profile.id);
  const labels = await listActiveTrainingLabels(env, profile.id);
  const batchSize = Math.max(1, Math.trunc(options?.batchSize ?? 40));
  const maxBatches = Math.max(1, Math.trunc(options?.maxBatches ?? 4));
  let cursorOffset = run.cursorOffset;
  let processedCount = run.processedCount;
  let matchedCount = run.matchedCount;
  let batchCount = 0;
  try {
    await updatePatternRun(env, run.id, { status: "running", phase: "scanning", error: null });
    while (cursorOffset < run.totalCount && batchCount < maxBatches) {
      const universe = await loadEligibleUniverseBatch(env, profile, run.tradingDate, cursorOffset, batchSize);
      if (universe.length === 0) break;
      const benchmarkTicker = profile.benchmarkTickers[0] ?? DEFAULT_BENCHMARK_TICKER;
      const tickers = universe.map((candidate) => candidate.ticker);
      const barsByTicker = await loadBarsByCount(env, [...tickers, benchmarkTicker], run.tradingDate, profile.settings.contextWindowBars);
      const benchmarkBars = barsByTicker.get(benchmarkTicker) ?? [];
      const candidatePatternLengths = sanitizeCandidatePatternLengths(profile.settings.candidatePatternLengths);
      const statements: D1PreparedStatement[] = [];
      for (let index = 0; index < universe.length; index += 1) {
        const row = universe[index];
        const tickerBars = barsByTicker.get(row.ticker) ?? [];
        let bestSnapshot: PatternFeatureSnapshot | null = null;
        let bestReasons: PatternScoreReasons | null = null;
        for (const length of candidatePatternLengths) {
          const snapshot = buildPatternFeatureSnapshot({
            ticker: row.ticker,
            setupDate: run.tradingDate,
            benchmarkTicker,
            tickerBars,
            benchmarkBars,
            contextWindowBars: profile.settings.contextWindowBars,
            patternWindowBars: length,
            selectionMode: "fixed_window",
            selectedResamplePoints: profile.settings.selectedResamplePoints,
          });
          if (!snapshot) continue;
          const reasons = scorePatternSnapshot(snapshot, labels, model);
          if (!bestReasons || reasons.score > bestReasons.score) {
            bestSnapshot = snapshot;
            bestReasons = reasons;
          }
        }
        if (!bestSnapshot || !bestReasons) {
          processedCount += 1;
          continue;
        }
        const snapshot = bestSnapshot;
        const reasons = bestReasons;
        const nearestApproved = model?.model ? nearestExamples(snapshot.featureJson, snapshot.shapeJson, labels, model.model, "approved") : [];
        const nearestRejected = model?.model ? nearestExamples(snapshot.featureJson, snapshot.shapeJson, labels, model.model, "rejected") : [];
        const candidateId = crypto.randomUUID();
        const rank = cursorOffset + index + 1;
        const sourceMetadata = {
          ...snapshot.sourceMetadata,
          matchedPatternStartDate: snapshot.patternStartDate,
          matchedPatternEndDate: snapshot.patternEndDate,
          matchedPatternBars: snapshot.selectedBarCount,
          name: row.name,
          exchange: row.exchange,
          assetClass: row.assetClass,
          sector: row.sector,
          industry: row.industry,
          universePrice: row.price,
          universeAvgDollarVolume20d: row.avgDollarVolume20d,
          universeBarCount: row.barCount,
        };
        if (reasons.score >= MATCH_SCORE_THRESHOLD) matchedCount += 1;
        processedCount += 1;
        statements.push(
          db.prepare(
            `INSERT INTO pattern_run_candidates
              (id, run_id, profile_id, ticker, rank, score, reasons_json, nearest_approved_json, nearest_rejected_json, feature_json, shape_json, source_metadata_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(run_id, ticker) DO UPDATE SET
               rank = excluded.rank,
               score = excluded.score,
               reasons_json = excluded.reasons_json,
               nearest_approved_json = excluded.nearest_approved_json,
               nearest_rejected_json = excluded.nearest_rejected_json,
               feature_json = excluded.feature_json,
               shape_json = excluded.shape_json,
               source_metadata_json = excluded.source_metadata_json`,
          )
            .bind(
              candidateId,
              run.id,
              profile.id,
              row.ticker,
              rank,
              reasons.score,
              JSON.stringify(reasons),
              JSON.stringify(nearestApproved),
              JSON.stringify(nearestRejected),
              JSON.stringify(snapshot.featureJson),
              JSON.stringify(snapshot.shapeJson),
              JSON.stringify(sourceMetadata),
            ),
          db.prepare(
            `INSERT INTO pattern_scores_latest
              (profile_id, ticker, run_id, candidate_id, trading_date, rank, score, reasons_json, nearest_approved_json, nearest_rejected_json, feature_json, shape_json, source_metadata_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(profile_id, ticker) DO UPDATE SET
               run_id = excluded.run_id,
               candidate_id = excluded.candidate_id,
               trading_date = excluded.trading_date,
               rank = excluded.rank,
               score = excluded.score,
               reasons_json = excluded.reasons_json,
               nearest_approved_json = excluded.nearest_approved_json,
               nearest_rejected_json = excluded.nearest_rejected_json,
               feature_json = excluded.feature_json,
               shape_json = excluded.shape_json,
               source_metadata_json = excluded.source_metadata_json,
               updated_at = CURRENT_TIMESTAMP`,
          )
            .bind(
              profile.id,
              row.ticker,
              run.id,
              candidateId,
              run.tradingDate,
              rank,
              reasons.score,
              JSON.stringify(reasons),
              JSON.stringify(nearestApproved),
              JSON.stringify(nearestRejected),
              JSON.stringify(snapshot.featureJson),
              JSON.stringify(snapshot.shapeJson),
              JSON.stringify(sourceMetadata),
            ),
        );
      }
      if (statements.length > 0) await db.batch(statements);
      cursorOffset += universe.length;
      batchCount += 1;
      await updatePatternRun(env, run.id, {
        status: "running",
        phase: "scanning",
        processedCount,
        matchedCount,
        cursorOffset,
      });
    }
    if (cursorOffset >= run.totalCount) {
      await rerankRunCandidates(env, run.id);
      await updatePatternRun(env, run.id, {
        status: "completed",
        phase: "completed",
        processedCount,
        matchedCount,
        cursorOffset,
        completedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    await updatePatternRun(env, run.id, {
      status: "failed",
      phase: "failed",
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Pattern scan failed.",
    });
  }
  run = await loadPatternRun(env, runId);
  return run;
}

async function rerankRunCandidates(env: Env, runId: string): Promise<void> {
  const db = requirePatternDb(env);
  const rows = await db.prepare(
    "SELECT id, profile_id as profileId, ticker FROM pattern_run_candidates WHERE run_id = ? ORDER BY score DESC, ticker ASC",
  )
    .bind(runId)
    .all<{ id: string; profileId: string; ticker: string }>();
  const statements = (rows.results ?? []).map((row, index) => [
    db.prepare("UPDATE pattern_run_candidates SET rank = ? WHERE id = ?").bind(index + 1, row.id),
    db.prepare("UPDATE pattern_scores_latest SET rank = ? WHERE profile_id = ? AND ticker = ? AND run_id = ?").bind(index + 1, row.profileId, row.ticker, runId),
  ]).flat();
  for (let index = 0; index < statements.length; index += 100) {
    const chunk = statements.slice(index, index + 100);
    if (chunk.length > 0) await db.batch(chunk);
  }
}

export async function maybeRunScheduledPatternScan(
  env: Env,
  now: Date,
  settings: WorkerScheduleSettings,
): Promise<PatternRun | null> {
  if (!env.PATTERN_DB || !settings.patternScanEnabled) return null;
  const tradingDate = latestUsSessionAsOfDate(now);
  if (!isPatternScanWindowOpen(now, tradingDate, settings.patternScanOffsetMinutes)) return null;
  const run = await createPatternRun(env, { profileId: DEFAULT_PATTERN_PROFILE_ID, tradingDate, force: false });
  if (run.status === "completed") return run;
  return await processPatternScanRun(env, run.id, {
    batchSize: settings.patternScanBatchSize,
    maxBatches: settings.patternScanMaxBatchesPerTick,
  });
}

export function isPatternScanWindowOpen(now: Date, expectedTradingDate: string, offsetMinutes: number): boolean {
  const ny = zonedParts(now, "America/New_York");
  const closeMinutesWithOffset = 16 * 60 + Math.max(0, offsetMinutes);
  if (ny.localDate > expectedTradingDate) return true;
  return ny.localDate === expectedTradingDate && ny.minutesOfDay >= closeMinutesWithOffset;
}

export async function listLatestPatternCandidates(env: Env, profileId = DEFAULT_PATTERN_PROFILE_ID, limit = 100): Promise<PatternCandidate[]> {
  const db = requirePatternDb(env);
  const rows = await db.prepare(
    `SELECT
       candidate_id as id,
       run_id as runId,
       profile_id as profileId,
       ticker,
       rank,
       score,
       reasons_json as reasonsJson,
       nearest_approved_json as nearestApprovedJson,
       nearest_rejected_json as nearestRejectedJson,
       feature_json as featureJson,
       shape_json as shapeJson,
       source_metadata_json as sourceMetadataJson,
       trading_date as tradingDate,
       updated_at as updatedAt
     FROM pattern_scores_latest
     WHERE profile_id = ?
     ORDER BY score DESC, ticker ASC
     LIMIT ?`,
  )
    .bind(profileId, Math.max(1, Math.min(500, limit)))
    .all<PatternCandidateRow>();
  return (rows.results ?? []).map(mapCandidateRow);
}

export async function loadPatternRunDetail(env: Env, runId: string): Promise<{ run: PatternRun; candidates: PatternCandidate[] } | null> {
  const run = await loadPatternRun(env, runId);
  if (!run) return null;
  const db = requirePatternDb(env);
  const rows = await db.prepare(
    `SELECT
       id,
       run_id as runId,
       profile_id as profileId,
       ticker,
       rank,
       score,
       reasons_json as reasonsJson,
       nearest_approved_json as nearestApprovedJson,
       nearest_rejected_json as nearestRejectedJson,
       feature_json as featureJson,
       shape_json as shapeJson,
       source_metadata_json as sourceMetadataJson,
       created_at as createdAt
     FROM pattern_run_candidates
     WHERE run_id = ?
     ORDER BY score DESC, ticker ASC
     LIMIT 250`,
  )
    .bind(runId)
    .all<PatternCandidateRow>();
  return { run, candidates: (rows.results ?? []).map(mapCandidateRow) };
}

export async function loadPatternAnalysis(env: Env, profileId = DEFAULT_PATTERN_PROFILE_ID): Promise<{
  profile: PatternProfile;
  activeModel: PatternModelVersion | null;
  featureRegistry: PatternFeatureRegistryRow[];
  approvalCount: number;
  rejectionCount: number;
  featureSummary: PatternFeatureSummary;
  validationMetrics: PatternValidationMetrics;
  modelHistory: PatternModelVersion[];
  mlReadiness: {
    balancedLabels: number;
    logisticReady: boolean;
    neuralReady: boolean;
    guidance: string[];
  };
}> {
  const profile = await ensurePatternProfile(env, profileId);
  const [labels, registry, activeModel, modelHistory] = await Promise.all([
    listActiveTrainingLabels(env, profile.id),
    listPatternFeatureRegistry(env),
    loadPatternModel(env, profile.id),
    loadPatternModelHistory(env, profile.id, 10),
  ]);
  const approvalCount = labels.filter((label) => label.label === "approved").length;
  const rejectionCount = labels.filter((label) => label.label === "rejected").length;
  const balancedLabels = Math.min(approvalCount, rejectionCount) * 2;
  return {
    profile,
    activeModel,
    featureRegistry: registry,
    approvalCount,
    rejectionCount,
    featureSummary: activeModel?.featureSummary ?? emptyFeatureSummary(),
    validationMetrics: activeModel?.metrics ?? {
      ...emptyMetrics(),
      approvedCount: approvalCount,
      rejectedCount: rejectionCount,
      totalActiveLabels: labels.length,
    },
    modelHistory,
    mlReadiness: {
      balancedLabels,
      logisticReady: balancedLabels >= 300,
      neuralReady: balancedLabels >= 1500,
      guidance: [
        "Test logistic and boosted models around 300 balanced labels.",
        "Consider neural or image models around 1,500 labels.",
        "Promote only if chronological validation improves Precision@25/50 by at least 15%.",
      ],
    },
  };
}

export async function patternExportText(env: Env, profileId = DEFAULT_PATTERN_PROFILE_ID): Promise<string> {
  const candidates = await listLatestPatternCandidates(env, profileId, 500);
  return candidates.map((candidate) => candidate.ticker).join("\n");
}
