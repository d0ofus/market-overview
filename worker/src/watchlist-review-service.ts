import type { Env } from "./types";

export type WatchlistReviewFlag = "red" | "blue" | "yellow" | "orange" | "unflagged" | "unknown";
export type WatchlistReviewProposedFlag = "red" | "blue" | "yellow" | "orange" | "keep" | "unflag" | "remove" | "manual_review";
export type WatchlistReviewRecommendationType =
  | "RED_TO_BLUE"
  | "RED_TO_YELLOW"
  | "BLUE_TO_RED"
  | "BLUE_TO_YELLOW"
  | "YELLOW_TO_BLUE"
  | "YELLOW_TO_RED"
  | "ANY_TO_UNFLAG"
  | "KEEP_CURRENT"
  | "MANUAL_REVIEW";
export type WatchlistReviewRunStatus = "draft" | "ready" | "partially_approved" | "applied" | "archived";
export type WatchlistReviewGeneratedBy = "hermes" | "manual" | "import";
export type WatchlistReviewAnalysisSource = "data_only" | "mini_chart" | "full_chart_vision" | "manual";
export type WatchlistReviewCandidateStatus = "pending" | "approved" | "skipped" | "overridden" | "applied";

export type WatchlistReviewSummaryCounts = {
  red_to_blue: number;
  red_to_yellow: number;
  blue_to_red: number;
  blue_to_yellow: number;
  yellow_to_blue: number;
  yellow_to_red: number;
  unflag: number;
  keep_current: number;
  manual_review: number;
};

export type WatchlistReviewRun = {
  id: string;
  sourceWatchlistName: string | null;
  sourceWatchlistId: string | null;
  watchlistSetId: string | null;
  watchlistRunId: string | null;
  totalTickersScanned: number;
  status: WatchlistReviewRunStatus;
  notes: string | null;
  summaryCounts: WatchlistReviewSummaryCounts;
  generatedBy: WatchlistReviewGeneratedBy;
  analysisVersion: string | null;
  exportPath: string | null;
  createdAt: string;
  updatedAt: string;
  candidateCount?: number;
  pendingCount?: number;
  approvedCount?: number;
  skippedCount?: number;
  destructiveCount?: number;
};

export type WatchlistReviewCandidate = {
  id: string;
  runId: string;
  ticker: string;
  companyName: string | null;
  currentFlag: WatchlistReviewFlag;
  proposedFlag: WatchlistReviewProposedFlag;
  recommendationType: WatchlistReviewRecommendationType;
  confidence: number;
  reasons: string[];
  metrics: Record<string, unknown>;
  sectorContext: Record<string, unknown> | null;
  chartImageUrl: string | null;
  chartSnapshotPath: string | null;
  dataFreshness: Record<string, unknown>;
  analysisSource: WatchlistReviewAnalysisSource;
  destructiveAction: boolean;
  destructiveConfirmed: boolean;
  removalReason: string | null;
  status: WatchlistReviewCandidateStatus;
  userOverrideFlag: WatchlistReviewProposedFlag | null;
  userNote: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WatchlistReviewEvent = {
  id: string;
  runId: string;
  candidateId: string | null;
  ticker: string | null;
  eventType: string;
  previousStatus: string | null;
  nextStatus: string | null;
  previousFlag: string | null;
  nextFlag: string | null;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type WatchlistReviewRunDetail = {
  run: WatchlistReviewRun;
  candidates: WatchlistReviewCandidate[];
  events: WatchlistReviewEvent[];
};

export type WatchlistReviewCandidateAction =
  | "approve"
  | "skip"
  | "keep_current"
  | "move_red"
  | "move_blue"
  | "move_yellow_orange"
  | "unflag_remove"
  | "note";

export type WatchlistReviewCandidatePatchInput = {
  action: WatchlistReviewCandidateAction;
  userNote?: string | null;
  removalReason?: string | null;
  destructiveConfirmed?: boolean;
  approvedBy?: string | null;
};

export type WatchlistReviewBatchInput = {
  candidateIds?: string[];
  destructiveConfirmed?: boolean;
  approvedBy?: string | null;
};

export type WatchlistReviewExportInput = {
  destructiveConfirmed?: boolean;
  approvedBy?: string | null;
};

export type WatchlistReviewExportRow = {
  run_id: string;
  ticker: string;
  current_flag: WatchlistReviewFlag;
  proposed_flag: WatchlistReviewProposedFlag;
  recommendation_type: WatchlistReviewRecommendationType;
  approved_by: string;
  approved_at: string | null;
  reason: string;
  destructive_action: boolean;
  rollback_hint: string;
};

export type WatchlistReviewExportPayload = {
  ok: true;
  runId: string;
  generatedAt: string;
  approvedCount: number;
  destructiveCount: number;
  rows: WatchlistReviewExportRow[];
  json: WatchlistReviewExportRow[];
  csv: string;
  exportPath: string;
  message?: string;
};

type WatchlistReviewRunRow = {
  id: string;
  sourceWatchlistName: string | null;
  sourceWatchlistId: string | null;
  watchlistSetId?: string | null;
  watchlistRunId?: string | null;
  totalTickersScanned: number | string | null;
  status: WatchlistReviewRunStatus;
  notes: string | null;
  summaryCountsJson: string | null;
  generatedBy: WatchlistReviewGeneratedBy;
  analysisVersion: string | null;
  exportPath: string | null;
  createdAt: string;
  updatedAt: string;
  candidateCount?: number | string | null;
  pendingCount?: number | string | null;
  approvedCount?: number | string | null;
  skippedCount?: number | string | null;
  destructiveCount?: number | string | null;
};

type WatchlistReviewCandidateRow = {
  id: string;
  runId: string;
  ticker: string;
  companyName: string | null;
  currentFlag: WatchlistReviewFlag;
  proposedFlag: WatchlistReviewProposedFlag;
  recommendationType: WatchlistReviewRecommendationType;
  confidence: number | string | null;
  reasonsJson: string | null;
  metricsJson: string | null;
  sectorContextJson: string | null;
  chartImageUrl: string | null;
  chartSnapshotPath: string | null;
  dataFreshnessJson: string | null;
  analysisSource: WatchlistReviewAnalysisSource;
  destructiveAction: number | null;
  destructiveConfirmed: number | null;
  removalReason: string | null;
  status: WatchlistReviewCandidateStatus;
  userOverrideFlag: WatchlistReviewProposedFlag | null;
  userNote: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type WatchlistReviewEventRow = {
  id: string;
  runId: string;
  candidateId: string | null;
  ticker: string | null;
  eventType: string;
  previousStatus: string | null;
  nextStatus: string | null;
  previousFlag: string | null;
  nextFlag: string | null;
  actor: string;
  payloadJson: string | null;
  createdAt: string;
};

export class WatchlistReviewSchemaMissingError extends Error {
  constructor() {
    super("Watchlist review schema is missing. Apply worker/migrations/0067_watchlist_review.sql.");
  }
}

const EMPTY_SUMMARY_COUNTS: WatchlistReviewSummaryCounts = {
  red_to_blue: 0,
  red_to_yellow: 0,
  blue_to_red: 0,
  blue_to_yellow: 0,
  yellow_to_blue: 0,
  yellow_to_red: 0,
  unflag: 0,
  keep_current: 0,
  manual_review: 0,
};

const APPROVED_EXPORT_STATUSES = new Set<WatchlistReviewCandidateStatus>(["approved", "overridden", "applied"]);

function isSchemaMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /no such table|watchlist_review_/i.test(message) && /no such table|not found|missing/i.test(message);
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function safeJson(value: unknown, fallback: string): string {
  try {
    return JSON.stringify(value ?? JSON.parse(fallback));
  } catch {
    return fallback;
  }
}

function cleanText(value: unknown, max = 1000): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function cleanTicker(value: unknown): string {
  const ticker = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9.\-^]/g, "");
  if (!/^[A-Z0-9.\-^]{1,20}$/.test(ticker)) throw new Error("Valid ticker is required for every watchlist review candidate.");
  return ticker;
}

function numberOr(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampConfidence(value: unknown): number {
  const parsed = numberOr(value, 0);
  const normalized = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  return Math.max(0, Math.min(1, normalized));
}

function boolInt(value: boolean): number {
  return value ? 1 : 0;
}

function candidateId(runId: string, ticker: string, explicit: unknown): string {
  const value = cleanText(explicit, 160);
  if (value) return value;
  return `${runId}-${ticker}`.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 180);
}

function normalizeRunStatus(value: unknown): WatchlistReviewRunStatus {
  if (value === "draft" || value === "ready" || value === "partially_approved" || value === "applied" || value === "archived") return value;
  return "ready";
}

function normalizeGeneratedBy(value: unknown): WatchlistReviewGeneratedBy {
  if (value === "manual" || value === "import" || value === "hermes") return value;
  return "hermes";
}

function normalizeCurrentFlag(value: unknown): WatchlistReviewFlag {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s/-]+/g, "_");
  if (normalized === "red" || normalized === "actionable") return "red";
  if (normalized === "blue" || normalized === "near_cp" || normalized === "near_critical_point") return "blue";
  if (normalized === "yellow") return "yellow";
  if (normalized === "orange" || normalized === "yellow_orange" || normalized === "monitor") return "orange";
  if (normalized === "unflagged" || normalized === "none" || normalized === "unflag") return "unflagged";
  return "unknown";
}

function normalizeProposedFlag(value: unknown): WatchlistReviewProposedFlag {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s/-]+/g, "_");
  if (normalized === "red" || normalized === "actionable") return "red";
  if (normalized === "blue" || normalized === "near_cp" || normalized === "near_critical_point") return "blue";
  if (normalized === "yellow") return "yellow";
  if (normalized === "orange" || normalized === "yellow_orange" || normalized === "monitor") return "orange";
  if (normalized === "keep" || normalized === "keep_current") return "keep";
  if (normalized === "unflag") return "unflag";
  if (normalized === "remove" || normalized === "unflag_remove") return "remove";
  return "manual_review";
}

function normalizeAnalysisSource(value: unknown): WatchlistReviewAnalysisSource {
  if (value === "mini_chart" || value === "full_chart_vision" || value === "manual" || value === "data_only") return value;
  return "data_only";
}

function normalizeCandidateStatus(value: unknown): WatchlistReviewCandidateStatus {
  if (value === "approved" || value === "skipped" || value === "overridden" || value === "applied" || value === "pending") return value;
  return "pending";
}

function flagGroup(flag: WatchlistReviewFlag | WatchlistReviewProposedFlag): "red" | "blue" | "yellow" | "unflag" | "keep" | "manual" | "unknown" {
  if (flag === "red") return "red";
  if (flag === "blue") return "blue";
  if (flag === "yellow" || flag === "orange") return "yellow";
  if (flag === "unflag" || flag === "remove" || flag === "unflagged") return "unflag";
  if (flag === "keep") return "keep";
  if (flag === "manual_review") return "manual";
  return "unknown";
}

export function deriveWatchlistRecommendationType(
  currentFlag: WatchlistReviewFlag,
  proposedFlag: WatchlistReviewProposedFlag,
): WatchlistReviewRecommendationType {
  const current = flagGroup(currentFlag);
  const proposed = flagGroup(proposedFlag);
  if (proposed === "unflag") return "ANY_TO_UNFLAG";
  if (proposed === "keep") return "KEEP_CURRENT";
  if (proposed === "manual") return "MANUAL_REVIEW";
  if (current === "red" && proposed === "blue") return "RED_TO_BLUE";
  if (current === "red" && proposed === "yellow") return "RED_TO_YELLOW";
  if (current === "blue" && proposed === "red") return "BLUE_TO_RED";
  if (current === "blue" && proposed === "yellow") return "BLUE_TO_YELLOW";
  if (current === "yellow" && proposed === "blue") return "YELLOW_TO_BLUE";
  if (current === "yellow" && proposed === "red") return "YELLOW_TO_RED";
  return "MANUAL_REVIEW";
}

function normalizeRecommendationType(
  value: unknown,
  currentFlag: WatchlistReviewFlag,
  proposedFlag: WatchlistReviewProposedFlag,
): WatchlistReviewRecommendationType {
  if (
    value === "RED_TO_BLUE"
    || value === "RED_TO_YELLOW"
    || value === "BLUE_TO_RED"
    || value === "BLUE_TO_YELLOW"
    || value === "YELLOW_TO_BLUE"
    || value === "YELLOW_TO_RED"
    || value === "ANY_TO_UNFLAG"
    || value === "KEEP_CURRENT"
    || value === "MANUAL_REVIEW"
  ) {
    return value;
  }
  return deriveWatchlistRecommendationType(currentFlag, proposedFlag);
}

function summaryKey(type: WatchlistReviewRecommendationType): keyof WatchlistReviewSummaryCounts {
  if (type === "RED_TO_BLUE") return "red_to_blue";
  if (type === "RED_TO_YELLOW") return "red_to_yellow";
  if (type === "BLUE_TO_RED") return "blue_to_red";
  if (type === "BLUE_TO_YELLOW") return "blue_to_yellow";
  if (type === "YELLOW_TO_BLUE") return "yellow_to_blue";
  if (type === "YELLOW_TO_RED") return "yellow_to_red";
  if (type === "ANY_TO_UNFLAG") return "unflag";
  if (type === "KEEP_CURRENT") return "keep_current";
  return "manual_review";
}

export function computeWatchlistReviewSummaryCounts(candidates: Array<{ recommendationType: WatchlistReviewRecommendationType }>): WatchlistReviewSummaryCounts {
  const counts = { ...EMPTY_SUMMARY_COUNTS };
  for (const candidate of candidates) counts[summaryKey(candidate.recommendationType)] += 1;
  return counts;
}

function normalizeReasons(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => cleanText(item, 400)).filter((item): item is string => Boolean(item)).slice(0, 12);
  }
  const text = cleanText(value, 1000);
  return text ? [text] : [];
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeOptionalRecord(value: unknown): Record<string, unknown> | null {
  const record = normalizeRecord(value);
  return Object.keys(record).length ? record : null;
}

function isDestructive(proposedFlag: WatchlistReviewProposedFlag, explicit: unknown): boolean {
  return proposedFlag === "unflag" || proposedFlag === "remove" || explicit === true || explicit === 1;
}

export function normalizeWatchlistReviewImport(input: {
  run?: Record<string, unknown>;
  candidates?: unknown[];
  watchlistSetId?: string | null;
  watchlistRunId?: string | null;
}, now = new Date().toISOString()): {
  run: WatchlistReviewRun;
  candidates: WatchlistReviewCandidate[];
} {
  const runInput = normalizeRecord(input.run);
  const runId = cleanText(runInput.id, 160) ?? `watchlist-review-${now.slice(0, 10)}`;
  const rawCandidates = Array.isArray(input.candidates) ? input.candidates : [];
  const candidates = rawCandidates.map((raw) => {
    const row = normalizeRecord(raw);
    const ticker = cleanTicker(row.ticker);
    const currentFlag = normalizeCurrentFlag(row.current_flag ?? row.currentFlag);
    const proposedFlag = normalizeProposedFlag(row.proposed_flag ?? row.proposedFlag);
    const recommendationType = normalizeRecommendationType(row.recommendation_type ?? row.recommendationType, currentFlag, proposedFlag);
    const destructiveAction = isDestructive(proposedFlag, row.destructive_action ?? row.destructiveAction);
    const status = normalizeCandidateStatus(row.status);
    return {
      id: candidateId(runId, ticker, row.id),
      runId,
      ticker,
      companyName: cleanText(row.company_name ?? row.companyName, 240),
      currentFlag,
      proposedFlag,
      recommendationType,
      confidence: clampConfidence(row.confidence),
      reasons: normalizeReasons(row.reasons),
      metrics: normalizeRecord(row.metrics),
      sectorContext: normalizeOptionalRecord(row.sector_context ?? row.sectorContext),
      chartImageUrl: cleanText(row.chart_image_url ?? row.chartImageUrl, 1000),
      chartSnapshotPath: cleanText(row.chart_snapshot_path ?? row.chartSnapshotPath, 1000),
      dataFreshness: normalizeRecord(row.data_freshness ?? row.dataFreshness),
      analysisSource: normalizeAnalysisSource(row.analysis_source ?? row.analysisSource),
      destructiveAction,
      destructiveConfirmed: false,
      removalReason: cleanText(row.removal_reason ?? row.removalReason, 1000),
      status,
      userOverrideFlag: null,
      userNote: cleanText(row.user_note ?? row.userNote, 2000),
      approvedBy: null,
      approvedAt: status === "approved" || status === "overridden" ? now : null,
      appliedAt: status === "applied" ? now : null,
      createdAt: now,
      updatedAt: now,
    } satisfies WatchlistReviewCandidate;
  });
  const summaryCounts = computeWatchlistReviewSummaryCounts(candidates);
  return {
    run: {
      id: runId,
      sourceWatchlistName: cleanText(runInput.source_watchlist_name ?? runInput.sourceWatchlistName, 240),
      sourceWatchlistId: cleanText(runInput.source_watchlist_id ?? runInput.sourceWatchlistId, 160),
      watchlistSetId: cleanText(runInput.watchlist_set_id ?? runInput.watchlistSetId ?? input.watchlistSetId, 160),
      watchlistRunId: cleanText(runInput.watchlist_run_id ?? runInput.watchlistRunId ?? input.watchlistRunId, 160),
      totalTickersScanned: Math.max(0, Math.trunc(numberOr(runInput.total_tickers_scanned ?? runInput.totalTickersScanned, candidates.length))),
      status: normalizeRunStatus(runInput.status),
      notes: cleanText(runInput.notes, 2000),
      summaryCounts,
      generatedBy: normalizeGeneratedBy(runInput.generated_by ?? runInput.generatedBy),
      analysisVersion: cleanText(runInput.analysis_version ?? runInput.analysisVersion, 80),
      exportPath: null,
      createdAt: now,
      updatedAt: now,
    },
    candidates,
  };
}

function mapRunRow(row: WatchlistReviewRunRow): WatchlistReviewRun {
  return {
    id: row.id,
    sourceWatchlistName: row.sourceWatchlistName ?? null,
    sourceWatchlistId: row.sourceWatchlistId ?? null,
    watchlistSetId: row.watchlistSetId ?? null,
    watchlistRunId: row.watchlistRunId ?? null,
    totalTickersScanned: Math.max(0, Math.trunc(numberOr(row.totalTickersScanned, 0))),
    status: row.status,
    notes: row.notes ?? null,
    summaryCounts: { ...EMPTY_SUMMARY_COUNTS, ...parseJson<Partial<WatchlistReviewSummaryCounts>>(row.summaryCountsJson, {}) },
    generatedBy: row.generatedBy,
    analysisVersion: row.analysisVersion ?? null,
    exportPath: row.exportPath ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    candidateCount: row.candidateCount == null ? undefined : Math.max(0, Math.trunc(numberOr(row.candidateCount, 0))),
    pendingCount: row.pendingCount == null ? undefined : Math.max(0, Math.trunc(numberOr(row.pendingCount, 0))),
    approvedCount: row.approvedCount == null ? undefined : Math.max(0, Math.trunc(numberOr(row.approvedCount, 0))),
    skippedCount: row.skippedCount == null ? undefined : Math.max(0, Math.trunc(numberOr(row.skippedCount, 0))),
    destructiveCount: row.destructiveCount == null ? undefined : Math.max(0, Math.trunc(numberOr(row.destructiveCount, 0))),
  };
}

function mapCandidateRow(row: WatchlistReviewCandidateRow): WatchlistReviewCandidate {
  return {
    id: row.id,
    runId: row.runId,
    ticker: row.ticker,
    companyName: row.companyName ?? null,
    currentFlag: row.currentFlag,
    proposedFlag: row.proposedFlag,
    recommendationType: row.recommendationType,
    confidence: clampConfidence(row.confidence),
    reasons: parseJson<string[]>(row.reasonsJson, []),
    metrics: parseJson<Record<string, unknown>>(row.metricsJson, {}),
    sectorContext: parseJson<Record<string, unknown> | null>(row.sectorContextJson, null),
    chartImageUrl: row.chartImageUrl ?? null,
    chartSnapshotPath: row.chartSnapshotPath ?? null,
    dataFreshness: parseJson<Record<string, unknown>>(row.dataFreshnessJson, {}),
    analysisSource: row.analysisSource,
    destructiveAction: Boolean(row.destructiveAction),
    destructiveConfirmed: Boolean(row.destructiveConfirmed),
    removalReason: row.removalReason ?? null,
    status: row.status,
    userOverrideFlag: row.userOverrideFlag ?? null,
    userNote: row.userNote ?? null,
    approvedBy: row.approvedBy ?? null,
    approvedAt: row.approvedAt ?? null,
    appliedAt: row.appliedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapEventRow(row: WatchlistReviewEventRow): WatchlistReviewEvent {
  return {
    id: row.id,
    runId: row.runId,
    candidateId: row.candidateId ?? null,
    ticker: row.ticker ?? null,
    eventType: row.eventType,
    previousStatus: row.previousStatus ?? null,
    nextStatus: row.nextStatus ?? null,
    previousFlag: row.previousFlag ?? null,
    nextFlag: row.nextFlag ?? null,
    actor: row.actor,
    payload: parseJson<Record<string, unknown>>(row.payloadJson, {}),
    createdAt: row.createdAt,
  };
}

function actor(input?: string | null): string {
  return cleanText(input, 120) ?? "authorized-user";
}

async function insertEvent(
  env: Env,
  input: {
    runId: string;
    candidateId?: string | null;
    ticker?: string | null;
    eventType: string;
    previousStatus?: string | null;
    nextStatus?: string | null;
    previousFlag?: string | null;
    nextFlag?: string | null;
    actor?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO watchlist_review_events
       (id, run_id, candidate_id, ticker, event_type, previous_status, next_status, previous_flag, next_flag, actor, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    input.runId,
    input.candidateId ?? null,
    input.ticker ?? null,
    input.eventType,
    input.previousStatus ?? null,
    input.nextStatus ?? null,
    input.previousFlag ?? null,
    input.nextFlag ?? null,
    actor(input.actor),
    safeJson(input.payload ?? {}, "{}"),
    new Date().toISOString(),
  ).run();
}

export async function createWatchlistReviewRun(env: Env, input: {
  run?: Record<string, unknown>;
  candidates?: unknown[];
  watchlistSetId?: string | null;
  watchlistRunId?: string | null;
}): Promise<WatchlistReviewRunDetail> {
  const now = new Date().toISOString();
  const normalized = normalizeWatchlistReviewImport(input, now);
  try {
    await env.DB.prepare(
      `INSERT INTO watchlist_review_runs
        (id, source_watchlist_name, source_watchlist_id, watchlist_set_id, watchlist_run_id, total_tickers_scanned, status, notes, summary_counts_json, generated_by, analysis_version, export_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source_watchlist_name = excluded.source_watchlist_name,
         source_watchlist_id = excluded.source_watchlist_id,
         watchlist_set_id = excluded.watchlist_set_id,
         watchlist_run_id = excluded.watchlist_run_id,
         total_tickers_scanned = excluded.total_tickers_scanned,
         status = CASE WHEN watchlist_review_runs.status = 'archived' THEN watchlist_review_runs.status ELSE excluded.status END,
         notes = excluded.notes,
         summary_counts_json = excluded.summary_counts_json,
         generated_by = excluded.generated_by,
         analysis_version = excluded.analysis_version,
         updated_at = excluded.updated_at`,
    ).bind(
      normalized.run.id,
      normalized.run.sourceWatchlistName,
      normalized.run.sourceWatchlistId,
      normalized.run.watchlistSetId,
      normalized.run.watchlistRunId,
      normalized.run.totalTickersScanned,
      normalized.run.status,
      normalized.run.notes,
      JSON.stringify(normalized.run.summaryCounts),
      normalized.run.generatedBy,
      normalized.run.analysisVersion,
      now,
      now,
    ).run();

    const statements = normalized.candidates.map((candidate) =>
      env.DB.prepare(
        `INSERT INTO watchlist_review_candidates
          (id, run_id, ticker, company_name, current_flag, proposed_flag, recommendation_type, confidence, reasons_json, metrics_json,
           sector_context_json, chart_image_url, chart_snapshot_path, data_freshness_json, analysis_source, destructive_action, destructive_confirmed,
           removal_reason, status, user_override_flag, user_note, approved_by, approved_at, applied_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, ticker) DO UPDATE SET
           company_name = excluded.company_name,
           current_flag = excluded.current_flag,
           proposed_flag = excluded.proposed_flag,
           recommendation_type = excluded.recommendation_type,
           confidence = excluded.confidence,
           reasons_json = excluded.reasons_json,
           metrics_json = excluded.metrics_json,
           sector_context_json = excluded.sector_context_json,
           chart_image_url = excluded.chart_image_url,
           chart_snapshot_path = excluded.chart_snapshot_path,
           data_freshness_json = excluded.data_freshness_json,
           analysis_source = excluded.analysis_source,
           destructive_action = excluded.destructive_action,
           removal_reason = excluded.removal_reason,
           status = CASE WHEN watchlist_review_candidates.status = 'pending' THEN excluded.status ELSE watchlist_review_candidates.status END,
           user_note = COALESCE(watchlist_review_candidates.user_note, excluded.user_note),
           updated_at = excluded.updated_at`,
      ).bind(
        candidate.id,
        candidate.runId,
        candidate.ticker,
        candidate.companyName,
        candidate.currentFlag,
        candidate.proposedFlag,
        candidate.recommendationType,
        candidate.confidence,
        JSON.stringify(candidate.reasons),
        JSON.stringify(candidate.metrics),
        candidate.sectorContext ? JSON.stringify(candidate.sectorContext) : null,
        candidate.chartImageUrl,
        candidate.chartSnapshotPath,
        JSON.stringify(candidate.dataFreshness),
        candidate.analysisSource,
        boolInt(candidate.destructiveAction),
        boolInt(candidate.destructiveConfirmed),
        candidate.removalReason,
        candidate.status,
        candidate.userOverrideFlag,
        candidate.userNote,
        candidate.approvedBy,
        candidate.approvedAt,
        candidate.appliedAt,
        now,
        now,
      ),
    );
    for (let index = 0; index < statements.length; index += 50) {
      await env.DB.batch(statements.slice(index, index + 50));
    }
    await insertEvent(env, {
      runId: normalized.run.id,
      eventType: "run_imported",
      actor: "authorized-user",
      payload: {
        candidateCount: normalized.candidates.length,
        sourceWatchlistName: normalized.run.sourceWatchlistName,
        watchlistSetId: normalized.run.watchlistSetId,
        watchlistRunId: normalized.run.watchlistRunId,
      },
    });
    await updateRunSummaryAndStatus(env, normalized.run.id);
    const detail = await loadWatchlistReviewRunDetail(env, normalized.run.id);
    if (!detail) throw new Error("Watchlist review run was not created.");
    return detail;
  } catch (error) {
    if (isSchemaMissingError(error)) throw new WatchlistReviewSchemaMissingError();
    throw error;
  }
}

export async function listWatchlistReviewRuns(env: Env, limit = 25): Promise<WatchlistReviewRun[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT
         id,
         source_watchlist_name as sourceWatchlistName,
         source_watchlist_id as sourceWatchlistId,
         watchlist_set_id as watchlistSetId,
         watchlist_run_id as watchlistRunId,
         total_tickers_scanned as totalTickersScanned,
         status,
         notes,
         summary_counts_json as summaryCountsJson,
         generated_by as generatedBy,
         analysis_version as analysisVersion,
         export_path as exportPath,
         created_at as createdAt,
         updated_at as updatedAt,
         (SELECT COUNT(*) FROM watchlist_review_candidates c WHERE c.run_id = watchlist_review_runs.id) as candidateCount,
         (SELECT COUNT(*) FROM watchlist_review_candidates c WHERE c.run_id = watchlist_review_runs.id AND c.status = 'pending') as pendingCount,
         (SELECT COUNT(*) FROM watchlist_review_candidates c WHERE c.run_id = watchlist_review_runs.id AND c.status IN ('approved', 'overridden', 'applied')) as approvedCount,
         (SELECT COUNT(*) FROM watchlist_review_candidates c WHERE c.run_id = watchlist_review_runs.id AND c.status = 'skipped') as skippedCount,
         (SELECT COUNT(*) FROM watchlist_review_candidates c WHERE c.run_id = watchlist_review_runs.id AND c.destructive_action = 1) as destructiveCount
       FROM watchlist_review_runs
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`,
    ).bind(Math.max(1, Math.min(100, Math.trunc(limit)))).all<WatchlistReviewRunRow>();
    return (rows.results ?? []).map(mapRunRow);
  } catch (error) {
    if (isSchemaMissingError(error)) throw new WatchlistReviewSchemaMissingError();
    throw error;
  }
}

async function loadRun(env: Env, runId: string): Promise<WatchlistReviewRun | null> {
  const row = await env.DB.prepare(
    `SELECT
       id,
       source_watchlist_name as sourceWatchlistName,
       source_watchlist_id as sourceWatchlistId,
       watchlist_set_id as watchlistSetId,
       watchlist_run_id as watchlistRunId,
       total_tickers_scanned as totalTickersScanned,
       status,
       notes,
       summary_counts_json as summaryCountsJson,
       generated_by as generatedBy,
       analysis_version as analysisVersion,
       export_path as exportPath,
       created_at as createdAt,
       updated_at as updatedAt
     FROM watchlist_review_runs
     WHERE id = ?
     LIMIT 1`,
  ).bind(runId).first<WatchlistReviewRunRow>();
  return row ? mapRunRow(row) : null;
}

async function loadRunCandidates(env: Env, runId: string): Promise<WatchlistReviewCandidate[]> {
  const rows = await env.DB.prepare(
    `SELECT
       id,
       run_id as runId,
       ticker,
       company_name as companyName,
       current_flag as currentFlag,
       proposed_flag as proposedFlag,
       recommendation_type as recommendationType,
       confidence,
       reasons_json as reasonsJson,
       metrics_json as metricsJson,
       sector_context_json as sectorContextJson,
       chart_image_url as chartImageUrl,
       chart_snapshot_path as chartSnapshotPath,
       data_freshness_json as dataFreshnessJson,
       analysis_source as analysisSource,
       destructive_action as destructiveAction,
       destructive_confirmed as destructiveConfirmed,
       removal_reason as removalReason,
       status,
       user_override_flag as userOverrideFlag,
       user_note as userNote,
       approved_by as approvedBy,
       approved_at as approvedAt,
       applied_at as appliedAt,
       created_at as createdAt,
       updated_at as updatedAt
     FROM watchlist_review_candidates
     WHERE run_id = ?
     ORDER BY
       CASE status WHEN 'pending' THEN 0 WHEN 'overridden' THEN 1 WHEN 'approved' THEN 2 WHEN 'skipped' THEN 3 ELSE 4 END,
       destructive_action DESC,
       confidence DESC,
       ticker ASC`,
  ).bind(runId).all<WatchlistReviewCandidateRow>();
  return (rows.results ?? []).map(mapCandidateRow);
}

async function loadRunEvents(env: Env, runId: string): Promise<WatchlistReviewEvent[]> {
  const rows = await env.DB.prepare(
    `SELECT
       id,
       run_id as runId,
       candidate_id as candidateId,
       ticker,
       event_type as eventType,
       previous_status as previousStatus,
       next_status as nextStatus,
       previous_flag as previousFlag,
       next_flag as nextFlag,
       actor,
       payload_json as payloadJson,
       created_at as createdAt
     FROM watchlist_review_events
     WHERE run_id = ?
     ORDER BY datetime(created_at) DESC
     LIMIT 200`,
  ).bind(runId).all<WatchlistReviewEventRow>();
  return (rows.results ?? []).map(mapEventRow);
}

export async function loadWatchlistReviewRunDetail(env: Env, runId: string): Promise<WatchlistReviewRunDetail | null> {
  try {
    const run = await loadRun(env, runId);
    if (!run) return null;
    const [candidates, events] = await Promise.all([
      loadRunCandidates(env, runId),
      loadRunEvents(env, runId),
    ]);
    return { run, candidates, events };
  } catch (error) {
    if (isSchemaMissingError(error)) throw new WatchlistReviewSchemaMissingError();
    throw error;
  }
}

async function loadCandidate(env: Env, candidateId: string): Promise<WatchlistReviewCandidate | null> {
  const row = await env.DB.prepare(
    `SELECT
       id,
       run_id as runId,
       ticker,
       company_name as companyName,
       current_flag as currentFlag,
       proposed_flag as proposedFlag,
       recommendation_type as recommendationType,
       confidence,
       reasons_json as reasonsJson,
       metrics_json as metricsJson,
       sector_context_json as sectorContextJson,
       chart_image_url as chartImageUrl,
       chart_snapshot_path as chartSnapshotPath,
       data_freshness_json as dataFreshnessJson,
       analysis_source as analysisSource,
       destructive_action as destructiveAction,
       destructive_confirmed as destructiveConfirmed,
       removal_reason as removalReason,
       status,
       user_override_flag as userOverrideFlag,
       user_note as userNote,
       approved_by as approvedBy,
       approved_at as approvedAt,
       applied_at as appliedAt,
       created_at as createdAt,
       updated_at as updatedAt
     FROM watchlist_review_candidates
     WHERE id = ?
     LIMIT 1`,
  ).bind(candidateId).first<WatchlistReviewCandidateRow>();
  return row ? mapCandidateRow(row) : null;
}

async function persistCandidate(env: Env, previous: WatchlistReviewCandidate, next: WatchlistReviewCandidate, eventType: string, payload: Record<string, unknown> = {}): Promise<WatchlistReviewCandidate> {
  await env.DB.prepare(
    `UPDATE watchlist_review_candidates
       SET proposed_flag = ?,
           recommendation_type = ?,
           destructive_action = ?,
           destructive_confirmed = ?,
           removal_reason = ?,
           status = ?,
           user_override_flag = ?,
           user_note = ?,
           approved_by = ?,
           approved_at = ?,
           applied_at = ?,
           updated_at = ?
     WHERE id = ?`,
  ).bind(
    next.proposedFlag,
    next.recommendationType,
    boolInt(next.destructiveAction),
    boolInt(next.destructiveConfirmed),
    next.removalReason,
    next.status,
    next.userOverrideFlag,
    next.userNote,
    next.approvedBy,
    next.approvedAt,
    next.appliedAt,
    next.updatedAt,
    next.id,
  ).run();
  await insertEvent(env, {
    runId: previous.runId,
    candidateId: previous.id,
    ticker: previous.ticker,
    eventType,
    previousStatus: previous.status,
    nextStatus: next.status,
    previousFlag: previous.proposedFlag,
    nextFlag: next.proposedFlag,
    actor: next.approvedBy ?? "authorized-user",
    payload,
  });
  await updateRunSummaryAndStatus(env, previous.runId);
  return (await loadCandidate(env, next.id)) ?? next;
}

function destructiveGuard(candidate: WatchlistReviewCandidate, confirmed: boolean | undefined, actionLabel = "Unflag/Remove"): void {
  if (candidate.destructiveAction && !confirmed && !candidate.destructiveConfirmed) {
    throw new Error(`${actionLabel} requires explicit destructive-action confirmation.`);
  }
}

export async function patchWatchlistReviewCandidate(env: Env, candidateId: string, input: WatchlistReviewCandidatePatchInput): Promise<WatchlistReviewCandidate | null> {
  try {
    const current = await loadCandidate(env, candidateId);
    if (!current) return null;
    const now = new Date().toISOString();
    const by = actor(input.approvedBy);
    const next: WatchlistReviewCandidate = {
      ...current,
      updatedAt: now,
      userNote: input.userNote === undefined ? current.userNote : cleanText(input.userNote, 2000),
    };

    if (input.action === "note") {
      return await persistCandidate(env, current, next, "note_added", { userNote: next.userNote });
    }

    if (input.action === "skip") {
      next.status = "skipped";
      next.userOverrideFlag = null;
      next.approvedAt = null;
      next.approvedBy = null;
      return await persistCandidate(env, current, next, "skipped");
    }

    if (input.action === "approve") {
      destructiveGuard(current, input.destructiveConfirmed, "Approving Unflag/Remove");
      next.status = "approved";
      next.destructiveConfirmed = current.destructiveAction ? true : current.destructiveConfirmed;
      next.removalReason = current.destructiveAction
        ? cleanText(input.removalReason, 1000) ?? current.removalReason
        : current.removalReason;
      next.approvedAt = now;
      next.approvedBy = by;
      return await persistCandidate(env, current, next, "approved", { destructiveConfirmed: next.destructiveConfirmed });
    }

    if (input.action === "keep_current") {
      next.proposedFlag = "keep";
      next.recommendationType = "KEEP_CURRENT";
      next.destructiveAction = false;
      next.destructiveConfirmed = false;
      next.status = "overridden";
      next.userOverrideFlag = "keep";
      next.approvedAt = now;
      next.approvedBy = by;
      return await persistCandidate(env, current, next, "overridden", { override: "keep_current" });
    }

    if (input.action === "move_red" || input.action === "move_blue" || input.action === "move_yellow_orange") {
      next.proposedFlag = input.action === "move_red" ? "red" : input.action === "move_blue" ? "blue" : "orange";
      next.recommendationType = deriveWatchlistRecommendationType(next.currentFlag, next.proposedFlag);
      next.destructiveAction = false;
      next.destructiveConfirmed = false;
      next.status = "overridden";
      next.userOverrideFlag = next.proposedFlag;
      next.approvedAt = now;
      next.approvedBy = by;
      return await persistCandidate(env, current, next, "overridden", { override: next.proposedFlag });
    }

    if (input.action === "unflag_remove") {
      const removalReason = cleanText(input.removalReason, 1000) ?? current.removalReason ?? "Explicit Unflag/Remove override approved by authorized user.";
      next.proposedFlag = "remove";
      next.recommendationType = "ANY_TO_UNFLAG";
      next.destructiveAction = true;
      destructiveGuard(next, input.destructiveConfirmed, "Unflag/Remove");
      next.destructiveConfirmed = true;
      next.removalReason = removalReason;
      next.status = "overridden";
      next.userOverrideFlag = "remove";
      next.approvedAt = now;
      next.approvedBy = by;
      return await persistCandidate(env, current, next, "destructive_override_approved", {
        removalReason,
        rollbackHint: rollbackHint(next),
      });
    }

    return current;
  } catch (error) {
    if (isSchemaMissingError(error)) throw new WatchlistReviewSchemaMissingError();
    throw error;
  }
}

function candidateIdsClause(candidateIds: string[] | undefined): { clause: string; args: string[] } {
  const ids = Array.from(new Set((candidateIds ?? []).map((id) => id.trim()).filter(Boolean))).slice(0, 500);
  if (ids.length === 0) return { clause: "", args: [] };
  return { clause: `AND id IN (${ids.map(() => "?").join(",")})`, args: ids };
}

async function pendingCandidatesForBatch(env: Env, runId: string, candidateIds?: string[]): Promise<WatchlistReviewCandidate[]> {
  const ids = candidateIdsClause(candidateIds);
  const rows = await env.DB.prepare(
    `SELECT
       id,
       run_id as runId,
       ticker,
       company_name as companyName,
       current_flag as currentFlag,
       proposed_flag as proposedFlag,
       recommendation_type as recommendationType,
       confidence,
       reasons_json as reasonsJson,
       metrics_json as metricsJson,
       sector_context_json as sectorContextJson,
       chart_image_url as chartImageUrl,
       chart_snapshot_path as chartSnapshotPath,
       data_freshness_json as dataFreshnessJson,
       analysis_source as analysisSource,
       destructive_action as destructiveAction,
       destructive_confirmed as destructiveConfirmed,
       removal_reason as removalReason,
       status,
       user_override_flag as userOverrideFlag,
       user_note as userNote,
       approved_by as approvedBy,
       approved_at as approvedAt,
       applied_at as appliedAt,
       created_at as createdAt,
       updated_at as updatedAt
     FROM watchlist_review_candidates
     WHERE run_id = ?
       AND status = 'pending'
       ${ids.clause}
     ORDER BY confidence DESC, ticker ASC`,
  ).bind(runId, ...ids.args).all<WatchlistReviewCandidateRow>();
  return (rows.results ?? []).map(mapCandidateRow);
}

export async function approveAllWatchlistReviewCandidates(env: Env, runId: string, input: WatchlistReviewBatchInput = {}): Promise<{ ok: true; updated: number; detail: WatchlistReviewRunDetail | null }> {
  try {
    const candidates = await pendingCandidatesForBatch(env, runId, input.candidateIds);
    if (candidates.some((candidate) => candidate.destructiveAction && !candidate.destructiveConfirmed) && !input.destructiveConfirmed) {
      throw new Error("Batch approve includes Unflag/Remove candidates and requires explicit confirmation.");
    }
    const now = new Date().toISOString();
    const by = actor(input.approvedBy);
    const statements = candidates.flatMap((candidate) => [
      env.DB.prepare(
        `UPDATE watchlist_review_candidates
            SET status = 'approved',
                destructive_confirmed = CASE WHEN destructive_action = 1 THEN 1 ELSE destructive_confirmed END,
                approved_by = ?,
                approved_at = ?,
                updated_at = ?
          WHERE id = ?`,
      ).bind(by, now, now, candidate.id),
      env.DB.prepare(
        `INSERT INTO watchlist_review_events
           (id, run_id, candidate_id, ticker, event_type, previous_status, next_status, previous_flag, next_flag, actor, payload_json, created_at)
         VALUES (?, ?, ?, ?, 'batch_approved', ?, 'approved', ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        runId,
        candidate.id,
        candidate.ticker,
        candidate.status,
        candidate.proposedFlag,
        candidate.proposedFlag,
        by,
        JSON.stringify({ destructiveConfirmed: candidate.destructiveAction }),
        now,
      ),
    ]);
    for (let index = 0; index < statements.length; index += 50) await env.DB.batch(statements.slice(index, index + 50));
    await updateRunSummaryAndStatus(env, runId);
    return { ok: true, updated: candidates.length, detail: await loadWatchlistReviewRunDetail(env, runId) };
  } catch (error) {
    if (isSchemaMissingError(error)) throw new WatchlistReviewSchemaMissingError();
    throw error;
  }
}

export async function skipAllWatchlistReviewCandidates(env: Env, runId: string, input: WatchlistReviewBatchInput = {}): Promise<{ ok: true; updated: number; detail: WatchlistReviewRunDetail | null }> {
  try {
    const candidates = await pendingCandidatesForBatch(env, runId, input.candidateIds);
    const now = new Date().toISOString();
    const by = actor(input.approvedBy);
    const statements = candidates.flatMap((candidate) => [
      env.DB.prepare(
        `UPDATE watchlist_review_candidates
            SET status = 'skipped',
                approved_by = NULL,
                approved_at = NULL,
                updated_at = ?
          WHERE id = ?`,
      ).bind(now, candidate.id),
      env.DB.prepare(
        `INSERT INTO watchlist_review_events
           (id, run_id, candidate_id, ticker, event_type, previous_status, next_status, previous_flag, next_flag, actor, payload_json, created_at)
         VALUES (?, ?, ?, ?, 'batch_skipped', ?, 'skipped', ?, ?, ?, '{}', ?)`,
      ).bind(crypto.randomUUID(), runId, candidate.id, candidate.ticker, candidate.status, candidate.proposedFlag, candidate.proposedFlag, by, now),
    ]);
    for (let index = 0; index < statements.length; index += 50) await env.DB.batch(statements.slice(index, index + 50));
    await updateRunSummaryAndStatus(env, runId);
    return { ok: true, updated: candidates.length, detail: await loadWatchlistReviewRunDetail(env, runId) };
  } catch (error) {
    if (isSchemaMissingError(error)) throw new WatchlistReviewSchemaMissingError();
    throw error;
  }
}

function reasonText(candidate: WatchlistReviewCandidate): string {
  const note = candidate.userNote?.trim();
  const reasons = candidate.reasons.join("; ");
  return note ? `${note}${reasons ? ` | ${reasons}` : ""}` : reasons;
}

function flagLabel(flag: WatchlistReviewFlag | WatchlistReviewProposedFlag): string {
  if (flag === "red") return "Red = Actionable";
  if (flag === "blue") return "Blue = Near CP";
  if (flag === "yellow" || flag === "orange") return "Yellow/Orange = Monitor";
  if (flag === "keep") return "Keep Current";
  if (flag === "unflag" || flag === "remove" || flag === "unflagged") return "Unflag/Remove";
  return "Manual Review";
}

function rollbackHint(candidate: WatchlistReviewCandidate): string {
  if (!candidate.destructiveAction) return "";
  return `Restore ${candidate.ticker} to ${flagLabel(candidate.currentFlag)} if Hermes apply is reversed; confirm original TradingView flag before removal.`;
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

export function watchlistReviewExportRows(
  run: WatchlistReviewRun,
  candidates: WatchlistReviewCandidate[],
  approvedBy = "authorized-user",
): WatchlistReviewExportRow[] {
  return candidates
    .filter((candidate) => APPROVED_EXPORT_STATUSES.has(candidate.status))
    .map((candidate) => ({
      run_id: run.id,
      ticker: candidate.ticker,
      current_flag: candidate.currentFlag,
      proposed_flag: candidate.proposedFlag,
      recommendation_type: candidate.recommendationType,
      approved_by: candidate.approvedBy ?? approvedBy,
      approved_at: candidate.approvedAt,
      reason: reasonText(candidate),
      destructive_action: candidate.destructiveAction,
      rollback_hint: rollbackHint(candidate),
    }));
}

export function watchlistReviewExportCsv(rows: WatchlistReviewExportRow[]): string {
  const headers: Array<keyof WatchlistReviewExportRow> = [
    "run_id",
    "ticker",
    "current_flag",
    "proposed_flag",
    "recommendation_type",
    "approved_by",
    "approved_at",
    "reason",
    "destructive_action",
    "rollback_hint",
  ];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
}

export function buildWatchlistReviewExportPayload(
  run: WatchlistReviewRun,
  candidates: WatchlistReviewCandidate[],
  input: WatchlistReviewExportInput = {},
  generatedAt = new Date().toISOString(),
): WatchlistReviewExportPayload {
  const rows = watchlistReviewExportRows(run, candidates, actor(input.approvedBy));
  const destructiveRows = candidates.filter((candidate) => APPROVED_EXPORT_STATUSES.has(candidate.status) && candidate.destructiveAction);
  const unconfirmed = destructiveRows.filter((candidate) => !candidate.destructiveConfirmed);
  if (unconfirmed.length > 0) {
    throw new Error(`Export blocked: ${unconfirmed.length} Unflag/Remove approval${unconfirmed.length === 1 ? "" : "s"} lack candidate confirmation.`);
  }
  if (destructiveRows.length > 0 && !input.destructiveConfirmed) {
    throw new Error("Export includes Unflag/Remove approvals and requires explicit export confirmation.");
  }
  const exportPath = `watchlist-review-${run.id}-approved-${generatedAt.slice(0, 10)}.json`;
  return {
    ok: true,
    runId: run.id,
    generatedAt,
    approvedCount: rows.length,
    destructiveCount: rows.filter((row) => row.destructive_action).length,
    rows,
    json: rows,
    csv: watchlistReviewExportCsv(rows),
    exportPath,
  };
}

export async function exportApprovedWatchlistReviewChanges(env: Env, runId: string, input: WatchlistReviewExportInput = {}): Promise<WatchlistReviewExportPayload> {
  try {
    const detail = await loadWatchlistReviewRunDetail(env, runId);
    if (!detail) throw new Error("Watchlist review run not found.");
    const payload = buildWatchlistReviewExportPayload(detail.run, detail.candidates, input);
    await env.DB.prepare(
      "UPDATE watchlist_review_runs SET export_path = ?, updated_at = ? WHERE id = ?",
    ).bind(payload.exportPath, payload.generatedAt, runId).run();
    await insertEvent(env, {
      runId,
      eventType: "approved_changes_exported",
      actor: input.approvedBy,
      payload: { approvedCount: payload.approvedCount, destructiveCount: payload.destructiveCount, exportPath: payload.exportPath },
    });
    return payload;
  } catch (error) {
    if (isSchemaMissingError(error)) throw new WatchlistReviewSchemaMissingError();
    throw error;
  }
}

export async function applyApprovedWatchlistReviewChanges(env: Env, runId: string, input: WatchlistReviewExportInput = {}): Promise<WatchlistReviewExportPayload> {
  const payload = await exportApprovedWatchlistReviewChanges(env, runId, input);
  await insertEvent(env, {
    runId,
    eventType: "apply_stub_exported",
    actor: input.approvedBy,
    payload: { approvedCount: payload.approvedCount, destructiveCount: payload.destructiveCount, exportPath: payload.exportPath },
  });
  return {
    ...payload,
    message: "Approved changes exported for Hermes TradingView MCP apply step.",
  };
}

async function updateRunSummaryAndStatus(env: Env, runId: string): Promise<void> {
  const candidates = await loadRunCandidates(env, runId);
  const summaryCounts = computeWatchlistReviewSummaryCounts(candidates);
  const current = await loadRun(env, runId);
  if (!current || current.status === "archived") return;
  const decisionCount = candidates.filter((candidate) => candidate.status !== "pending").length;
  const appliedCount = candidates.filter((candidate) => candidate.status === "applied").length;
  const nextStatus: WatchlistReviewRunStatus = candidates.length > 0 && appliedCount === candidates.length
    ? "applied"
    : decisionCount > 0
      ? "partially_approved"
      : "ready";
  await env.DB.prepare(
    "UPDATE watchlist_review_runs SET summary_counts_json = ?, status = ?, updated_at = ? WHERE id = ?",
  ).bind(JSON.stringify(summaryCounts), nextStatus, new Date().toISOString(), runId).run();
}
