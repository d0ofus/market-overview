import { describe, expect, it, vi } from "vitest";
import * as providerModule from "../src/provider";
import {
  buildTradingViewScanPayload,
  deleteScanPreset,
  duplicateScanPreset,
  fetchTradingViewScanRows,
  loadCompiledScansSnapshot,
  loadCompiledScansSnapshotForCompilePreset,
  normalizeScanRows,
  processRelativeStrengthRefreshJob,
  refreshScansSnapshot,
  refreshScanCompilePreset,
  requestScansRefresh,
  type ScanPreset,
  type ScanSnapshot,
  type ScanSnapshotRow,
} from "../src/scans-page-service";

const topGainersPreset: ScanPreset = {
  id: "scan-preset-top-gainers",
  name: "Top Gainers",
  scanType: "tradingview",
  isDefault: true,
  isActive: true,
  rules: [
    { id: "close", field: "close", operator: "gt", value: 1 },
    { id: "change", field: "change", operator: "gt", value: 3 },
    { id: "type", field: "type", operator: "in", value: ["stock", "dr"] },
    { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ", "NYSE", "AMEX"] },
    { id: "volume", field: "volume", operator: "gt", value: 100000 },
    { id: "traded", field: "Value.Traded", operator: "gt", value: 10000000 },
    {
      id: "industry",
      field: "industry",
      operator: "not_in",
      value: [
        "Biotechnology",
        "Pharmaceuticals: generic",
        "Pharmaceuticals: major",
        "Pharmaceuticals: other",
      ],
    },
  ],
  prefilterRules: [],
  benchmarkTicker: null,
  verticalOffset: 30,
  rsMaLength: 21,
  rsMaType: "EMA",
  newHighLookback: 252,
  outputMode: "all",
  sortField: "change",
  sortDirection: "desc",
  rowLimit: 100,
  createdAt: "",
  updatedAt: "",
};

type MutableCompilePreset = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  members: Array<{ scanPresetId: string; scanPresetName: string; sortOrder: number }>;
};

type MutableSnapshot = {
  id: string;
  presetId: string;
  providerLabel: string;
  generatedAt: string;
  rowCount: number;
  matchedRowCount: number;
  status: "ok" | "warning" | "error" | "empty";
  error: string | null;
};

type MutableScanRefreshJob = {
  id: string;
  presetId: string;
  jobType: string;
  status: "queued" | "running" | "completed" | "failed";
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
  rsMaType: "SMA" | "EMA";
  rsMaLength: number;
  newHighLookback: number;
  fullCandidateCount: number;
  materializationCandidateCount: number;
  alreadyCurrentCandidateCount: number;
  lastAdvancedAt: string | null;
};

type MutableRelativeStrengthMaterializationRun = {
  id: string;
  configKey: string;
  expectedTradingDate: string;
  benchmarkTicker: string;
  rsMaType: "SMA" | "EMA";
  rsMaLength: number;
  newHighLookback: number;
  status: "queued" | "running" | "completed" | "failed";
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
};

type MutableRelativeStrengthMaterializationRunCandidate = {
  runId: string;
  cursorOffset: number;
  ticker: string;
};

type MutableRelativeStrengthMaterializationQueueRow = {
  runId: string;
  priority: number;
  source: string | null;
  enqueuedAt: string;
  lastAttemptedAt: string | null;
  attempts: number;
};

type MutableRelativeStrengthLatestCacheRow = {
  configKey: string;
  ticker: string;
  benchmarkTicker: string;
  rsMaType: "SMA" | "EMA";
  rsMaLength: number;
  newHighLookback: number;
  tradingDate: string;
  priceClose: number | null;
  change1d: number | null;
  rsRatioClose: number | null;
  rsRatioMa: number | null;
  rsAboveMa: number;
  rsNewHigh: number;
  rsNewHighBeforePrice: number;
  bullCross: number;
  approxRsRating: number | null;
};

type MutableRelativeStrengthRatioCacheRow = {
  benchmarkTicker: string;
  ticker: string;
  tradingDate: string;
  priceClose: number | null;
  benchmarkClose: number | null;
  rsRatioClose: number | null;
};

type MutableScanRefreshJobCandidate = {
  jobId: string;
  cursorOffset: number;
  ticker: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  relativeVolume: number | null;
  avgVolume: number | null;
  priceAvgVolume: number | null;
  materializationRequired: number;
};

type MutableRelativeStrengthConfigState = {
  configKey: string;
  ticker: string;
  benchmarkTicker: string;
  rsMaType: "SMA" | "EMA";
  rsMaLength: number;
  newHighLookback: number;
  stateVersion: number;
  latestTradingDate: string;
  updatedAt: string | null;
  priceClose: number | null;
  change1d: number | null;
  rsRatioClose: number | null;
  rsRatioMa: number | null;
  rsAboveMa: number;
  rsNewHigh: number;
  rsNewHighBeforePrice: number;
  bullCross: number;
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

type MutableRelativeStrengthRefreshQueueRow = {
  jobId: string;
  source: string | null;
  enqueuedAt: string;
  lastAttemptedAt: string | null;
  attempts: number;
};

const CURRENT_RS_SESSION = "2026-04-21";

function makeBars(ticker: string, count: number, closeBase: number, closeStep: number) {
  const rows: Array<{ ticker: string; date: string; o: number; h: number; l: number; c: number; volume: number }> = [];
  const start = new Date("2025-01-02T00:00:00Z");
  let current = new Date(start);
  while (rows.length < count) {
    const weekday = current.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      const close = closeBase + rows.length * closeStep;
      rows.push({
        ticker,
        date: current.toISOString().slice(0, 10),
        o: close,
        h: close,
        l: close,
        c: close,
        volume: 1_000_000 + rows.length * 1000,
      });
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return rows;
}

function makeBarsEndingOn(
  ticker: string,
  count: number,
  closeBase: number,
  closeStep: number,
  endIsoDate = CURRENT_RS_SESSION,
) {
  const tradingDates: string[] = [];
  const current = new Date(`${endIsoDate}T00:00:00Z`);
  while (tradingDates.length < count) {
    const weekday = current.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      tradingDates.push(current.toISOString().slice(0, 10));
    }
    current.setUTCDate(current.getUTCDate() - 1);
  }
  return tradingDates.reverse().map((date, index) => {
    const close = closeBase + index * closeStep;
    return {
      ticker,
      date,
      o: close,
      h: close,
      l: close,
      c: close,
      volume: 1_000_000 + index * 1000,
    };
  });
}

function createMutableScansEnv(input: {
  presets: ScanPreset[];
  compilePresets?: MutableCompilePreset[];
  snapshots?: MutableSnapshot[];
  symbols?: string[];
  dailyBarsByTicker?: Record<string, Array<{ date: string; o: number; h: number; l: number; c: number; volume: number }>>;
  rowsBySnapshotId?: Record<string, Array<Partial<ScanSnapshotRow> & Pick<ScanSnapshotRow, "ticker">>>;
}) {
  const presets = [...input.presets];
  const compilePresets = [...(input.compilePresets ?? [])];
  const snapshots = [...(input.snapshots ?? [])];
  const symbols = new Set((input.symbols ?? []).map((ticker) => ticker.toUpperCase()));
  const dailyBarsByTicker = new Map(
    Object.entries(input.dailyBarsByTicker ?? {}).map(([ticker, bars]) => [ticker.toUpperCase(), [...bars]]),
  );
  const scanRefreshJobs: MutableScanRefreshJob[] = [];
  const scanRefreshJobCandidates: MutableScanRefreshJobCandidate[] = [];
  const relativeStrengthLatestCache = new Map<string, MutableRelativeStrengthLatestCacheRow>();
  const relativeStrengthRatioCache = new Map<string, MutableRelativeStrengthRatioCacheRow>();
  const relativeStrengthConfigState = new Map<string, MutableRelativeStrengthConfigState>();
  const relativeStrengthRefreshQueue = new Map<string, MutableRelativeStrengthRefreshQueueRow>();
  const relativeStrengthMaterializationRuns = new Map<string, MutableRelativeStrengthMaterializationRun>();
  const relativeStrengthMaterializationRunCandidates = new Map<string, MutableRelativeStrengthMaterializationRunCandidate>();
  const relativeStrengthMaterializationQueue = new Map<string, MutableRelativeStrengthMaterializationQueueRow>();
  const rowsBySnapshotId = new Map<string, ScanSnapshotRow[]>(
    Object.entries(input.rowsBySnapshotId ?? {}).map(([snapshotId, rows]) => [snapshotId, rows.map((row) => ({
      name: null,
      sector: null,
      industry: null,
      change1d: null,
      marketCap: null,
      relativeVolume: null,
      price: null,
      avgVolume: null,
      priceAvgVolume: null,
      rsClose: null,
      rsMa: null,
      rsAboveMa: false,
      rsNewHigh: false,
      rsNewHighBeforePrice: false,
      bullCross: false,
      approxRsRating: null,
      rawJson: null,
      ...row,
    }))]),
  );
  let generatedCounter = snapshots.length;
  let timestampCounter = 0;

  const nextTimestamp = () => {
    timestampCounter += 1;
    return new Date(Date.UTC(2026, 2, 18, 12, 0, timestampCounter)).toISOString();
  };

  const nextGeneratedAt = () => {
    generatedCounter += 1;
    return `2026-03-18T${String(generatedCounter).padStart(2, "0")}:00:00.000Z`;
  };

  const buildCompilePresetRows = (compilePresetId?: string) =>
    compilePresets
      .filter((preset) => !compilePresetId || preset.id === compilePresetId)
      .flatMap((preset) => (
        preset.members.length > 0
          ? preset.members.map((member) => ({
            id: preset.id,
            name: preset.name,
            createdAt: preset.createdAt,
            updatedAt: preset.updatedAt,
            scanPresetId: member.scanPresetId,
            scanPresetName: member.scanPresetName,
            sortOrder: member.sortOrder,
          }))
          : [{
            id: preset.id,
            name: preset.name,
            createdAt: preset.createdAt,
            updatedAt: preset.updatedAt,
            scanPresetId: null,
            scanPresetName: null,
            sortOrder: null,
          }]
      ));

  const getRequestedTickers = (args: unknown[], trailingCount: number) =>
    args.slice(0, Math.max(0, args.length - trailingCount)).map((value) => String(value).toUpperCase());

  const getBarsInRange = (tickers: string[], startDate: string, endDate: string) =>
    tickers.flatMap((ticker) =>
      (dailyBarsByTicker.get(ticker) ?? [])
        .filter((row) => row.date >= startDate && row.date <= endDate)
        .map((row) => ({ ticker, ...row })),
    );

  const getLatestBarDates = (tickers: string[]) =>
    tickers.flatMap((ticker) => {
      const rows = dailyBarsByTicker.get(ticker) ?? [];
      const lastDate = rows.length > 0 ? [...rows].sort((left, right) => right.date.localeCompare(left.date))[0]?.date ?? null : null;
      return lastDate ? [{ ticker, lastDate }] : [];
    });

  const getCoverageRows = (tickers: string[], endDate: string) =>
    tickers.flatMap((ticker) => {
      const rows = (dailyBarsByTicker.get(ticker) ?? []).filter((row) => row.date <= endDate);
      if (rows.length === 0) return [];
      const lastDate = [...rows].sort((left, right) => right.date.localeCompare(left.date))[0]?.date ?? null;
      return [{ ticker, lastDate, barCount: rows.length }];
    });

  const getLastBarsByCount = (tickers: string[], endDate: string, barLimit: number) =>
    tickers.flatMap((ticker) =>
      (dailyBarsByTicker.get(ticker) ?? [])
        .filter((row) => row.date <= endDate)
        .sort((left, right) => left.date.localeCompare(right.date))
        .slice(-barLimit)
        .map((row) => ({ ticker, ...row })),
    );

  const updateJob = (sql: string, args: unknown[]) => {
    const jobId = String(args[args.length - 1] ?? "");
    const job = scanRefreshJobs.find((row) => row.id === jobId);
    if (!job) return;
    const setClause = sql.match(/SET\s+(.+)\s+WHERE/i)?.[1] ?? "";
    const assignments = setClause.split(",").map((part) => part.trim()).filter(Boolean);
    let argIndex = 0;
    for (const assignment of assignments) {
      if (assignment === "updated_at = CURRENT_TIMESTAMP") {
        job.updatedAt = nextTimestamp();
        continue;
      }
      const [column] = assignment.split("=").map((part) => part.trim());
      const value = args[argIndex++];
      if (column === "status") job.status = String(value ?? "queued") as MutableScanRefreshJob["status"];
      else if (column === "error") job.error = value == null ? null : String(value);
      else if (column === "processed_candidates") job.processedCandidates = Number(value ?? 0);
      else if (column === "matched_candidates") job.matchedCandidates = Number(value ?? 0);
      else if (column === "cursor_offset") job.cursorOffset = Number(value ?? 0);
      else if (column === "latest_snapshot_id") job.latestSnapshotId = value == null ? null : String(value);
      else if (column === "benchmark_bars_json") job.benchmarkBarsJson = value == null ? null : String(value);
      else if (column === "required_bar_count") job.requiredBarCount = Number(value ?? job.requiredBarCount);
      else if (column === "shared_run_id") job.sharedRunId = value == null ? null : String(value);
      else if (column === "full_candidate_count") job.fullCandidateCount = Number(value ?? job.fullCandidateCount);
      else if (column === "materialization_candidate_count") job.materializationCandidateCount = Number(value ?? job.materializationCandidateCount);
      else if (column === "already_current_candidate_count") job.alreadyCurrentCandidateCount = Number(value ?? job.alreadyCurrentCandidateCount);
      else if (column === "last_advanced_at") job.lastAdvancedAt = value == null ? null : String(value);
      else if (column === "completed_at") job.completedAt = value == null ? null : String(value);
    }
  };

  const updateMaterializationRun = (sql: string, args: unknown[]) => {
    const runId = String(args[args.length - 1] ?? "");
    const run = relativeStrengthMaterializationRuns.get(runId);
    if (!run) return;
    const setClause = sql.match(/SET\s+(.+)\s+WHERE/i)?.[1] ?? "";
    const assignments = setClause.split(",").map((part) => part.trim()).filter(Boolean);
    let argIndex = 0;
    for (const assignment of assignments) {
      if (assignment === "updated_at = CURRENT_TIMESTAMP") {
        run.updatedAt = nextTimestamp();
        continue;
      }
      const [column] = assignment.split("=").map((part) => part.trim());
      const value = args[argIndex++];
      if (column === "status") run.status = String(value ?? "queued") as MutableRelativeStrengthMaterializationRun["status"];
      else if (column === "error") run.error = value == null ? null : String(value);
      else if (column === "benchmark_bars_json") run.benchmarkBarsJson = value == null ? null : String(value);
      else if (column === "required_bar_count") run.requiredBarCount = Number(value ?? run.requiredBarCount);
      else if (column === "full_candidate_count") run.fullCandidateCount = Number(value ?? run.fullCandidateCount);
      else if (column === "materialization_candidate_count") run.materializationCandidateCount = Number(value ?? run.materializationCandidateCount);
      else if (column === "already_current_candidate_count") run.alreadyCurrentCandidateCount = Number(value ?? run.alreadyCurrentCandidateCount);
      else if (column === "processed_candidates") run.processedCandidates = Number(value ?? run.processedCandidates);
      else if (column === "matched_candidates") run.matchedCandidates = Number(value ?? run.matchedCandidates);
      else if (column === "cursor_offset") run.cursorOffset = Number(value ?? run.cursorOffset);
      else if (column === "last_advanced_at") run.lastAdvancedAt = value == null ? null : String(value);
      else if (column === "completed_at") run.completedAt = value == null ? null : String(value);
    }
  };

  const env = {
    __testState: {
      scanRefreshJobs,
      scanRefreshJobCandidates,
      relativeStrengthLatestCache,
      relativeStrengthRatioCache,
      relativeStrengthConfigState,
      relativeStrengthRefreshQueue,
      relativeStrengthMaterializationRuns,
      relativeStrengthMaterializationRunCandidates,
      relativeStrengthMaterializationQueue,
      dailyBarsByTicker,
    },
    DB: {
      prepare(sql: string) {
        const makeBound = (args: unknown[]) => ({
          __sql: sql,
          __args: args,
          async first<T>() {
            if (sql.includes("FROM scan_presets WHERE id = ?")) {
              return presets.find((row) => row.id === args[0]) ?? null as T;
            }
            if (sql.includes("FROM relative_strength_materialization_runs") && sql.includes("WHERE id = ?")) {
              return (relativeStrengthMaterializationRuns.get(String(args[0] ?? "")) ?? null) as T;
            }
            if (sql.includes("FROM relative_strength_materialization_runs") && sql.includes("WHERE config_key = ?")) {
              const configKey = String(args[0] ?? "");
              const expectedTradingDate = String(args[1] ?? "");
              const candidates = Array.from(relativeStrengthMaterializationRuns.values())
                .filter((row) => row.configKey === configKey && row.expectedTradingDate === expectedTradingDate)
                .filter((row) => row.status === "queued" || row.status === "running")
                .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
              return (candidates[0] ?? null) as T;
            }
            if (sql.includes("COUNT(*) as count FROM relative_strength_materialization_run_candidates")) {
              const runId = String(args[0] ?? "");
              const count = Array.from(relativeStrengthMaterializationRunCandidates.values())
                .filter((row) => row.runId === runId)
                .length;
              return { count } as T;
            }
            if (sql.includes("MAX(cursor_offset) as maxCursorOffset FROM relative_strength_materialization_run_candidates")) {
              const runId = String(args[0] ?? "");
              const rows = Array.from(relativeStrengthMaterializationRunCandidates.values())
                .filter((row) => row.runId === runId);
              const maxCursorOffset = rows.length > 0 ? Math.max(...rows.map((row) => row.cursorOffset)) : null;
              return { maxCursorOffset } as T;
            }
            if (sql.includes("FROM scan_refresh_job_candidates") && sql.includes("COUNT(*) as candidateCount")) {
              const jobId = String(args[0] ?? "");
              const rows = scanRefreshJobCandidates.filter((row) => row.jobId === jobId);
              return {
                candidateCount: rows.length,
                materializationCount: rows.filter((row) => row.materializationRequired === 1).length,
              } as T;
            }
            if (sql.includes("FROM scan_refresh_jobs") && sql.includes("WHERE id = ?")) {
              return scanRefreshJobs.find((row) => row.id === args[0]) ?? null as T;
            }
            if (sql.includes("FROM scan_refresh_jobs") && sql.includes("WHERE config_key = ?")) {
              const configKey = String(args[0] ?? "");
              const expectedTradingDate = sql.includes("expected_trading_date = ?") ? String(args[1] ?? "") : null;
              const activeOnly = sql.includes("status IN ('queued', 'running')");
              const completedOnly = sql.includes("status = 'completed'");
              const candidates = scanRefreshJobs
                .filter((row) => row.configKey === configKey)
                .filter((row) => !expectedTradingDate || row.expectedTradingDate === expectedTradingDate)
                .filter((row) => !activeOnly || row.status === "queued" || row.status === "running")
                .filter((row) => !completedOnly || row.status === "completed")
                .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
              return (candidates[0] ?? null) as T;
            }
            if (sql.includes("FROM scan_refresh_jobs") && sql.includes("WHERE preset_id = ?")) {
              const presetId = String(args[0] ?? "");
              const expectedTradingDate = sql.includes("expected_trading_date = ?") ? String(args[1] ?? "") : null;
              const activeOnly = sql.includes("status IN ('queued', 'running')");
              const completedOnly = sql.includes("status = 'completed'");
              const candidates = scanRefreshJobs
                .filter((row) => row.presetId === presetId)
                .filter((row) => !expectedTradingDate || row.expectedTradingDate === expectedTradingDate)
                .filter((row) => !activeOnly || row.status === "queued" || row.status === "running")
                .filter((row) => !completedOnly || row.status === "completed")
                .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
              return (candidates[0] ?? null) as T;
            }
            if (sql.includes("SELECT COUNT(*) as count") && sql.includes("FROM symbols s")) {
              const count = Array.from(symbols).filter((ticker) => (dailyBarsByTicker.get(ticker) ?? []).length > 0).length;
              return { count } as T;
            }
            if (sql.includes("SELECT COUNT(*) as count") && sql.includes("FROM relative_strength_latest_cache")) {
              const configKey = String(args[0] ?? "");
              const tradingDate = String(args[1] ?? "");
              const count = Array.from(relativeStrengthLatestCache.values()).filter((row) => row.configKey === configKey && row.tradingDate === tradingDate).length;
              return { count } as T;
            }
            if (sql.includes("FROM scan_snapshots")) {
              const presetId = String(args[0] ?? "");
              const usableOnly = sql.includes("status != 'error'");
              const candidate = snapshots
                .filter((row) => row.presetId === presetId && (!usableOnly || row.status !== "error"))
                .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0] ?? null;
              return candidate as T;
            }
            return null as T;
          },
          async all<T>() {
            if (sql.includes("FROM symbols s") && sql.includes("LIMIT ?") && sql.includes("OFFSET ?")) {
              const limit = Number(args[0] ?? 0);
              const offset = Number(args[1] ?? 0);
              const results = Array.from(symbols)
                .filter((ticker) => (dailyBarsByTicker.get(ticker) ?? []).length > 0)
                .sort((left, right) => left.localeCompare(right))
                .slice(offset, offset + limit)
                .map((ticker) => ({ ticker }));
              return { results: results as T[] };
            }
            if (sql.includes("FROM symbols")) {
              return { results: Array.from(symbols).map((ticker) => ({ ticker })) as T[] };
            }
            if (sql.includes("FROM relative_strength_latest_cache")) {
              const configKey = String(args[0] ?? "");
              const tradingDate = String(args[1] ?? "");
              const tickers = args.slice(2).map((value) => String(value).toUpperCase());
              const results = Array.from(relativeStrengthLatestCache.values())
                .filter((row) => row.configKey === configKey && row.tradingDate === tradingDate && tickers.includes(row.ticker));
              return { results: results as T[] };
            }
            if (sql.includes("FROM relative_strength_config_state")) {
              const configKey = String(args[0] ?? "");
              const tickers = args.slice(1).map((value) => String(value).toUpperCase());
              const results = Array.from(relativeStrengthConfigState.values())
                .filter((row) => row.configKey === configKey && tickers.includes(row.ticker));
              return { results: results as T[] };
            }
            if (sql.includes("FROM relative_strength_refresh_queue")) {
              const results = Array.from(relativeStrengthRefreshQueue.values())
                .sort((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt));
              return { results: results as T[] };
            }
            if (sql.includes("FROM relative_strength_materialization_queue")) {
              const results = Array.from(relativeStrengthMaterializationQueue.values())
                .sort((left, right) => (
                  right.priority - left.priority
                  || left.enqueuedAt.localeCompare(right.enqueuedAt)
                ));
              return { results: results as T[] };
            }
            if (sql.includes("FROM relative_strength_materialization_runs")) {
              const results = Array.from(relativeStrengthMaterializationRuns.values())
                .filter((row) => row.status === "queued" || row.status === "running")
                .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
              return { results: results as T[] };
            }
            if (sql.includes("FROM relative_strength_materialization_run_candidates")) {
              const runId = String(args[0] ?? "");
              const rows = Array.from(relativeStrengthMaterializationRunCandidates.values())
                .filter((row) => row.runId === runId)
                .sort((left, right) => left.cursorOffset - right.cursorOffset);
              if (sql.includes("AND ticker IN")) {
                const requested = args.slice(1).map((value) => String(value).toUpperCase());
                return { results: rows.filter((row) => requested.includes(row.ticker)) as T[] };
              }
              const limit = Number(args[1] ?? rows.length);
              const offset = Number(args[2] ?? 0);
              return { results: rows.slice(offset, offset + limit) as T[] };
            }
            if (sql.includes("FROM scan_refresh_job_candidates")) {
              const jobId = String(args[0] ?? "");
              const results = scanRefreshJobCandidates
                .filter((row) => row.jobId === jobId)
                .sort((left, right) => left.cursorOffset - right.cursorOffset);
              if (sql.includes("materialization_required = 1")) {
                const limit = Number(args[1] ?? results.length);
                const offset = Number(args[2] ?? 0);
                return {
                  results: results
                    .filter((row) => row.materializationRequired === 1)
                    .slice(offset, offset + limit) as T[],
                };
              }
              return { results: results as T[] };
            }
            if (sql.includes("MAX(trading_date) as lastDate, COUNT(*) as rowCount")) {
              const benchmarkTicker = String(args[0] ?? "").toUpperCase();
              const endDate = String(args[args.length - 1] ?? "");
              const requestedTickers = args.slice(1, -1).map((value) => String(value).toUpperCase());
              const results = requestedTickers.flatMap((ticker) => {
                const rows = Array.from(relativeStrengthRatioCache.values())
                  .filter((row) => row.benchmarkTicker === benchmarkTicker && row.ticker === ticker && row.tradingDate <= endDate);
                if (rows.length === 0) return [];
                const lastDate = [...rows].sort((left, right) => right.tradingDate.localeCompare(left.tradingDate))[0]?.tradingDate ?? null;
                return [{ ticker, lastDate, rowCount: rows.length }];
              });
              return { results: results as T[] };
            }
            if (sql.includes("FROM rs_ratio_cache") && sql.includes("ROW_NUMBER() OVER")) {
              const benchmarkTicker = String(args[0] ?? "").toUpperCase();
              const barLimit = Number(args[args.length - 1] ?? 0);
              const endDate = String(args[args.length - 2] ?? "");
              const requestedTickers = args.slice(1, -2).map((value) => String(value).toUpperCase());
              const results = requestedTickers.flatMap((ticker) =>
                Array.from(relativeStrengthRatioCache.values())
                  .filter((row) => row.benchmarkTicker === benchmarkTicker && row.ticker === ticker && row.tradingDate <= endDate)
                  .sort((left, right) => left.tradingDate.localeCompare(right.tradingDate))
                  .slice(-barLimit),
              );
              return { results: results as T[] };
            }
            if (sql.includes("ROW_NUMBER() OVER")) {
              const barLimit = Number(args[args.length - 1] ?? 0);
              const endDate = String(args[args.length - 2] ?? "");
              const requestedTickers = getRequestedTickers(args, 2);
              return { results: getLastBarsByCount(requestedTickers, endDate, barLimit) as T[] };
            }
            if (sql.includes("MAX(date) as lastDate, COUNT(*) as barCount")) {
              const endDate = String(args[args.length - 1] ?? "");
              const requestedTickers = getRequestedTickers(args, 1);
              return { results: getCoverageRows(requestedTickers, endDate) as T[] };
            }
            if (sql.includes("MAX(date) as lastDate FROM daily_bars")) {
              const requestedTickers = args.map((value) => String(value).toUpperCase());
              return { results: getLatestBarDates(requestedTickers) as T[] };
            }
            if (sql.includes("FROM daily_bars")) {
              const endDate = String(args[args.length - 1] ?? "");
              const startDate = String(args[args.length - 2] ?? "");
              const requestedTickers = getRequestedTickers(args, 2);
              const results = getBarsInRange(requestedTickers, startDate, endDate);
              return { results: results as T[] };
            }
            if (sql.includes("FROM scan_refresh_jobs") && sql.includes("shared_run_id = ?")) {
              const sharedRunId = String(args[0] ?? "");
              const activeOnly = sql.includes("status IN ('queued', 'running')");
              const results = scanRefreshJobs
                .filter((row) => row.sharedRunId === sharedRunId)
                .filter((row) => !activeOnly || row.status === "queued" || row.status === "running")
                .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
              return { results: results as T[] };
            }
            if (sql.includes("FROM scan_compile_presets cp")) {
              const compilePresetId = sql.includes("WHERE cp.id = ?") ? String(args[0] ?? "") : undefined;
              return { results: buildCompilePresetRows(compilePresetId) as T[] };
            }
            if (sql.includes("FROM scan_rows WHERE snapshot_id = ?")) {
              return { results: (rowsBySnapshotId.get(String(args[0] ?? "")) ?? []) as T[] };
            }
            if (sql.includes("FROM scan_compile_presets cp")) {
              return { results: [] as T[] };
            }
            return { results: [] as T[] };
          },
          async run() {
            if (sql.includes("INSERT INTO scan_snapshots")) {
              const [id, presetId, providerLabel, rowCountArg, matchedRowCountArg, statusArg, errorArg] = args;
              if (args.length >= 4) {
                const isLegacyErrorInsert = args.length === 4;
                const rowCount = isLegacyErrorInsert ? 0 : Number(rowCountArg ?? 0);
                const matchedRowCount = isLegacyErrorInsert ? 0 : Number(matchedRowCountArg ?? rowCountArg ?? 0);
                const status = isLegacyErrorInsert ? "error" : String(statusArg ?? "ok");
                const error = isLegacyErrorInsert ? String(rowCountArg ?? "") : (errorArg == null ? null : String(errorArg));
                snapshots.push({
                  id: String(id),
                  presetId: String(presetId),
                  providerLabel: String(providerLabel),
                  generatedAt: nextGeneratedAt(),
                  rowCount,
                  matchedRowCount,
                  status: status as MutableSnapshot["status"],
                  error,
                });
              }
            }
            if (sql.includes("INSERT INTO scan_refresh_jobs")) {
              const [
                id,
                presetId,
                totalCandidates,
                matchedCandidates,
                requestedBy,
                requiredBarCount,
                configKey,
                sharedRunId,
                expectedTradingDate,
                benchmarkTicker,
                rsMaType,
                rsMaLength,
                newHighLookback,
                fullCandidateCount,
                materializationCandidateCount,
                alreadyCurrentCandidateCount,
              ] = args;
              scanRefreshJobs.push({
                id: String(id),
                presetId: String(presetId),
                jobType: "relative-strength",
                status: "queued",
                startedAt: nextTimestamp(),
                updatedAt: nextTimestamp(),
                completedAt: null,
                error: null,
                totalCandidates: Number(totalCandidates ?? 0),
                processedCandidates: 0,
                matchedCandidates: Number(matchedCandidates ?? 0),
                cursorOffset: 0,
                latestSnapshotId: null,
                requestedBy: requestedBy == null ? null : String(requestedBy),
                benchmarkBarsJson: null,
                requiredBarCount: Number(requiredBarCount ?? 0),
                configKey: configKey == null ? null : String(configKey),
                sharedRunId: sharedRunId == null ? null : String(sharedRunId),
                expectedTradingDate: expectedTradingDate == null ? null : String(expectedTradingDate),
                benchmarkTicker: benchmarkTicker == null ? null : String(benchmarkTicker),
                rsMaType: String(rsMaType ?? "EMA") as "SMA" | "EMA",
                rsMaLength: Number(rsMaLength ?? 21),
                newHighLookback: Number(newHighLookback ?? 252),
                fullCandidateCount: Number(fullCandidateCount ?? totalCandidates ?? 0),
                materializationCandidateCount: Number(materializationCandidateCount ?? totalCandidates ?? 0),
                alreadyCurrentCandidateCount: Number(alreadyCurrentCandidateCount ?? 0),
                lastAdvancedAt: null,
              });
            }
            if (sql.includes("UPDATE scan_refresh_jobs SET")) {
              updateJob(sql, args);
            }
            if (sql.includes("INSERT INTO relative_strength_materialization_runs")) {
              const [
                id,
                configKey,
                expectedTradingDate,
                benchmarkTicker,
                rsMaType,
                rsMaLength,
                newHighLookback,
                requiredBarCount,
              ] = args;
              relativeStrengthMaterializationRuns.set(String(id), {
                id: String(id),
                configKey: String(configKey),
                expectedTradingDate: String(expectedTradingDate),
                benchmarkTicker: String(benchmarkTicker),
                rsMaType: String(rsMaType ?? "EMA") as "SMA" | "EMA",
                rsMaLength: Number(rsMaLength ?? 21),
                newHighLookback: Number(newHighLookback ?? 252),
                status: "queued",
                startedAt: nextTimestamp(),
                updatedAt: nextTimestamp(),
                completedAt: null,
                error: null,
                benchmarkBarsJson: null,
                requiredBarCount: Number(requiredBarCount ?? 0),
                fullCandidateCount: 0,
                materializationCandidateCount: 0,
                alreadyCurrentCandidateCount: 0,
                processedCandidates: 0,
                matchedCandidates: 0,
                cursorOffset: 0,
                lastAdvancedAt: null,
              });
            }
            if (sql.includes("UPDATE relative_strength_materialization_runs SET")) {
              updateMaterializationRun(sql, args);
            }
            if (sql.includes("INSERT INTO relative_strength_refresh_queue")) {
              const [jobId, source] = args;
              relativeStrengthRefreshQueue.set(String(jobId), {
                jobId: String(jobId),
                source: source == null ? null : String(source),
                enqueuedAt: nextTimestamp(),
                lastAttemptedAt: null,
                attempts: 0,
              });
            }
            if (sql.includes("INSERT INTO relative_strength_materialization_queue")) {
              const [runId, priority, source] = args;
              const existing = relativeStrengthMaterializationQueue.get(String(runId));
              relativeStrengthMaterializationQueue.set(String(runId), {
                runId: String(runId),
                priority: Math.max(Number(priority ?? 0), existing?.priority ?? 0),
                source: source == null ? null : String(source),
                enqueuedAt: nextTimestamp(),
                lastAttemptedAt: null,
                attempts: existing?.attempts ?? 0,
              });
            }
            if (sql.includes("UPDATE relative_strength_refresh_queue")) {
              const [jobId] = args;
              const row = relativeStrengthRefreshQueue.get(String(jobId));
              if (row) {
                row.lastAttemptedAt = nextTimestamp();
                row.attempts += 1;
              }
            }
            if (sql.includes("UPDATE relative_strength_materialization_queue")) {
              const [runId] = args;
              const row = relativeStrengthMaterializationQueue.get(String(runId));
              if (row) {
                row.lastAttemptedAt = nextTimestamp();
                row.attempts += 1;
              }
            }
            if (sql.includes("DELETE FROM relative_strength_refresh_queue WHERE job_id = ?")) {
              relativeStrengthRefreshQueue.delete(String(args[0] ?? ""));
            }
            if (sql.includes("DELETE FROM relative_strength_materialization_queue WHERE run_id = ?")) {
              relativeStrengthMaterializationQueue.delete(String(args[0] ?? ""));
            }
            if (sql.includes("DELETE FROM relative_strength_materialization_run_candidates WHERE run_id = ?")) {
              const runId = String(args[0] ?? "");
              for (const [key, row] of relativeStrengthMaterializationRunCandidates.entries()) {
                if (row.runId === runId) relativeStrengthMaterializationRunCandidates.delete(key);
              }
            }
            if (sql.includes("DELETE FROM relative_strength_materialization_runs WHERE id = ?")) {
              relativeStrengthMaterializationRuns.delete(String(args[0] ?? ""));
            }
            if (sql.includes("DELETE FROM rs_ratio_cache")) {
              const benchmarkTicker = String(args[0] ?? "").toUpperCase();
              const keepBars = Number(args[args.length - 1] ?? 0);
              const requestedTickers = args.slice(1, -1).map((value) => String(value).toUpperCase());
              for (const ticker of requestedTickers) {
                const rows = Array.from(relativeStrengthRatioCache.values())
                  .filter((row) => row.benchmarkTicker === benchmarkTicker && row.ticker === ticker)
                  .sort((left, right) => left.tradingDate.localeCompare(right.tradingDate));
                const keep = rows.slice(-keepBars);
                for (const row of rows) {
                  relativeStrengthRatioCache.delete(`${row.benchmarkTicker}|${row.ticker}|${row.tradingDate}`);
                }
                for (const row of keep) {
                  relativeStrengthRatioCache.set(`${row.benchmarkTicker}|${row.ticker}|${row.tradingDate}`, row);
                }
              }
            }
            if (sql.includes("INSERT OR IGNORE INTO symbols")) {
              const [ticker] = args;
              if (ticker != null) symbols.add(String(ticker).toUpperCase());
            }
            return {};
          },
        });

        return {
          bind(...args: unknown[]) {
            return makeBound(args);
          },
          async all<T>() {
            if (sql.includes("FROM scan_presets ORDER BY")) {
              return { results: presets as T[] };
            }
            if (sql.includes("FROM symbols")) {
              return { results: Array.from(symbols).map((ticker) => ({ ticker })) as T[] };
            }
            return { results: [] as T[] };
          },
          async first<T>() {
            if (sql.includes("SELECT COUNT(*) as count") && sql.includes("FROM symbols s")) {
              const count = Array.from(symbols).filter((ticker) => (dailyBarsByTicker.get(ticker) ?? []).length > 0).length;
              return { count } as T;
            }
            return null as T;
          },
          async run() {
            return {};
          },
        };
      },
      async batch(statements: Array<{ __sql?: string; __args?: unknown[] }>) {
        for (const statement of statements) {
          if (!statement.__sql) continue;
          if (statement.__sql.includes("INSERT INTO scan_snapshots")) {
            const [id, presetId, providerLabel, rowCount, matchedRowCount, status, error] = statement.__args ?? [];
            snapshots.push({
              id: String(id),
              presetId: String(presetId),
              providerLabel: String(providerLabel),
              generatedAt: nextGeneratedAt(),
              rowCount: Number(rowCount ?? 0),
              matchedRowCount: Number(matchedRowCount ?? rowCount ?? 0),
              status: String(status ?? "ok") as MutableSnapshot["status"],
              error: error == null ? null : String(error),
            });
            continue;
          }
          if (statement.__sql.includes("INSERT INTO scan_rows")) {
            const [id, snapshotId, ticker, name, sector, industry, change1d, marketCap, price, avgVolume, priceAvgVolume, rawJson] = statement.__args ?? [];
            const rows = rowsBySnapshotId.get(String(snapshotId)) ?? [];
            rows.push({
              ticker: String(ticker),
              name: name == null ? null : String(name),
              sector: sector == null ? null : String(sector),
              industry: industry == null ? null : String(industry),
              change1d: change1d == null ? null : Number(change1d),
              marketCap: marketCap == null ? null : Number(marketCap),
              relativeVolume: null,
              price: price == null ? null : Number(price),
              avgVolume: avgVolume == null ? null : Number(avgVolume),
              priceAvgVolume: priceAvgVolume == null ? null : Number(priceAvgVolume),
              rsClose: null,
              rsMa: null,
              rsAboveMa: false,
              rsNewHigh: false,
              rsNewHighBeforePrice: false,
              bullCross: false,
              approxRsRating: null,
              rawJson: rawJson == null ? null : String(rawJson),
            });
            rowsBySnapshotId.set(String(snapshotId), rows);
            void id;
            continue;
          }
          if (statement.__sql.includes("INSERT INTO relative_strength_latest_cache")) {
            const [
              configKey,
              ticker,
              benchmarkTicker,
              rsMaType,
              rsMaLength,
              newHighLookback,
              tradingDate,
              priceClose,
              change1d,
              rsRatioClose,
              rsRatioMa,
              rsAboveMa,
              rsNewHigh,
              rsNewHighBeforePrice,
              bullCross,
              approxRsRating,
            ] = statement.__args ?? [];
            relativeStrengthLatestCache.set(`${String(configKey)}|${String(ticker).toUpperCase()}`, {
              configKey: String(configKey),
              ticker: String(ticker).toUpperCase(),
              benchmarkTicker: String(benchmarkTicker),
              rsMaType: String(rsMaType ?? "EMA") as "SMA" | "EMA",
              rsMaLength: Number(rsMaLength ?? 21),
              newHighLookback: Number(newHighLookback ?? 252),
              tradingDate: String(tradingDate),
              priceClose: priceClose == null ? null : Number(priceClose),
              change1d: change1d == null ? null : Number(change1d),
              rsRatioClose: rsRatioClose == null ? null : Number(rsRatioClose),
              rsRatioMa: rsRatioMa == null ? null : Number(rsRatioMa),
              rsAboveMa: Number(rsAboveMa ?? 0),
              rsNewHigh: Number(rsNewHigh ?? 0),
              rsNewHighBeforePrice: Number(rsNewHighBeforePrice ?? 0),
              bullCross: Number(bullCross ?? 0),
              approxRsRating: approxRsRating == null ? null : Number(approxRsRating),
            });
            continue;
          }
          if (statement.__sql.includes("INSERT INTO scan_refresh_job_candidates")) {
            const [jobId, cursorOffset, ticker, name, sector, industry, marketCap, relativeVolume, avgVolume, priceAvgVolume, materializationRequired] = statement.__args ?? [];
            scanRefreshJobCandidates.push({
              jobId: String(jobId),
              cursorOffset: Number(cursorOffset ?? 0),
              ticker: String(ticker).toUpperCase(),
              name: name == null ? null : String(name),
              sector: sector == null ? null : String(sector),
              industry: industry == null ? null : String(industry),
              marketCap: marketCap == null ? null : Number(marketCap),
              relativeVolume: relativeVolume == null ? null : Number(relativeVolume),
              avgVolume: avgVolume == null ? null : Number(avgVolume),
              priceAvgVolume: priceAvgVolume == null ? null : Number(priceAvgVolume),
              materializationRequired: Number(materializationRequired ?? 1),
            });
            continue;
          }
          if (statement.__sql.includes("INSERT INTO relative_strength_materialization_run_candidates")) {
            const [runId, cursorOffset, ticker] = statement.__args ?? [];
            relativeStrengthMaterializationRunCandidates.set(`${String(runId)}|${String(ticker).toUpperCase()}`, {
              runId: String(runId),
              cursorOffset: Number(cursorOffset ?? 0),
              ticker: String(ticker).toUpperCase(),
            });
            continue;
          }
          if (statement.__sql.includes("INSERT INTO relative_strength_config_state")) {
            const [
              configKey,
              ticker,
              benchmarkTicker,
              rsMaType,
              rsMaLength,
              newHighLookback,
              stateVersion,
              latestTradingDate,
              priceClose,
              change1d,
              rsRatioClose,
              rsRatioMa,
              rsAboveMa,
              rsNewHigh,
              rsNewHighBeforePrice,
              bullCross,
              approxRsRating,
              priceCloseHistoryJson,
              benchmarkCloseHistoryJson,
              weightedScoreHistoryJson,
              rsNewHighWindowJson,
              priceNewHighWindowJson,
              smaWindowJson,
              smaSum,
              emaValue,
              previousRsClose,
              previousRsMa,
            ] = statement.__args ?? [];
            relativeStrengthConfigState.set(`${String(configKey)}|${String(ticker).toUpperCase()}`, {
              configKey: String(configKey),
              ticker: String(ticker).toUpperCase(),
              benchmarkTicker: String(benchmarkTicker).toUpperCase(),
              rsMaType: String(rsMaType ?? "EMA") as "SMA" | "EMA",
              rsMaLength: Number(rsMaLength ?? 21),
              newHighLookback: Number(newHighLookback ?? 252),
              stateVersion: Number(stateVersion ?? 0),
              latestTradingDate: String(latestTradingDate),
              updatedAt: nextTimestamp(),
              priceClose: priceClose == null ? null : Number(priceClose),
              change1d: change1d == null ? null : Number(change1d),
              rsRatioClose: rsRatioClose == null ? null : Number(rsRatioClose),
              rsRatioMa: rsRatioMa == null ? null : Number(rsRatioMa),
              rsAboveMa: Number(rsAboveMa ?? 0),
              rsNewHigh: Number(rsNewHigh ?? 0),
              rsNewHighBeforePrice: Number(rsNewHighBeforePrice ?? 0),
              bullCross: Number(bullCross ?? 0),
              approxRsRating: approxRsRating == null ? null : Number(approxRsRating),
              priceCloseHistoryJson: priceCloseHistoryJson == null ? null : String(priceCloseHistoryJson),
              benchmarkCloseHistoryJson: benchmarkCloseHistoryJson == null ? null : String(benchmarkCloseHistoryJson),
              weightedScoreHistoryJson: weightedScoreHistoryJson == null ? null : String(weightedScoreHistoryJson),
              rsNewHighWindowJson: rsNewHighWindowJson == null ? null : String(rsNewHighWindowJson),
              priceNewHighWindowJson: priceNewHighWindowJson == null ? null : String(priceNewHighWindowJson),
              smaWindowJson: smaWindowJson == null ? null : String(smaWindowJson),
              smaSum: smaSum == null ? null : Number(smaSum),
              emaValue: emaValue == null ? null : Number(emaValue),
              previousRsClose: previousRsClose == null ? null : Number(previousRsClose),
              previousRsMa: previousRsMa == null ? null : Number(previousRsMa),
            });
            continue;
          }
          if (statement.__sql.includes("INSERT INTO rs_ratio_cache")) {
            const [benchmarkTicker, ticker, tradingDate, priceClose, benchmarkClose, rsRatioClose] = statement.__args ?? [];
            relativeStrengthRatioCache.set(`${String(benchmarkTicker).toUpperCase()}|${String(ticker).toUpperCase()}|${String(tradingDate)}`, {
              benchmarkTicker: String(benchmarkTicker).toUpperCase(),
              ticker: String(ticker).toUpperCase(),
              tradingDate: String(tradingDate),
              priceClose: priceClose == null ? null : Number(priceClose),
              benchmarkClose: benchmarkClose == null ? null : Number(benchmarkClose),
              rsRatioClose: rsRatioClose == null ? null : Number(rsRatioClose),
            });
            continue;
          }
          if (statement.__sql.includes("INSERT OR REPLACE INTO daily_bars")) {
            const [ticker, date, o, h, l, c, volume] = statement.__args ?? [];
            const normalizedTicker = String(ticker).toUpperCase();
            const rows = dailyBarsByTicker.get(normalizedTicker) ?? [];
            const nextRow = {
              date: String(date),
              o: Number(o ?? 0),
              h: Number(h ?? 0),
              l: Number(l ?? 0),
              c: Number(c ?? 0),
              volume: Number(volume ?? 0),
            };
            const filtered = rows.filter((row) => row.date !== nextRow.date);
            filtered.push(nextRow);
            filtered.sort((left, right) => left.date.localeCompare(right.date));
            dailyBarsByTicker.set(normalizedTicker, filtered);
            symbols.add(normalizedTicker);
            continue;
          }
          if (statement.__sql.includes("INSERT OR IGNORE INTO symbols")) {
            const [ticker] = statement.__args ?? [];
            if (ticker != null) symbols.add(String(ticker).toUpperCase());
          }
        }
        return [];
      },
    },
  } as any;

  return { env, snapshots, rowsBySnapshotId, scanRefreshJobs, relativeStrengthLatestCache };
}

async function completeRelativeStrengthMaterializationJob(env: any, presetId: string) {
  const queued = await requestScansRefresh(env, presetId, "test");
  expect(queued.async).toBe(true);
  expect(queued.job).not.toBeNull();
  let job = queued.job;
  while (job && (job.status === "queued" || job.status === "running")) {
    job = await processRelativeStrengthRefreshJob(env, job.id, { maxBatches: 20, timeBudgetMs: 60_000 });
  }
  if (job?.status !== "completed") {
    throw new Error(`Relative strength materialization failed: ${job?.status ?? "missing"}${job?.error ? ` (${job.error})` : ""}`);
  }
  return job;
}

async function materializeRelativeStrengthPreset(env: any, presetId: string) {
  await completeRelativeStrengthMaterializationJob(env, presetId);
  return requestScansRefresh(env, presetId, "test");
}

function seedCompletedRelativeStrengthCache(
  env: any,
  preset: ScanPreset,
  rows: Array<{
    ticker: string;
    tradingDate: string;
    priceClose: number;
    change1d?: number | null;
    rsRatioClose: number;
    rsRatioMa?: number | null;
    rsAboveMa?: boolean;
    rsNewHigh?: boolean;
    rsNewHighBeforePrice?: boolean;
    bullCross?: boolean;
    approxRsRating?: number | null;
  }>,
) {
  const benchmarkTicker = preset.benchmarkTicker ?? "SPY";
  const configKey = `${benchmarkTicker}|${preset.rsMaType}|${preset.rsMaLength}|${preset.newHighLookback}`;
  const expectedTradingDate = rows[0]?.tradingDate ?? CURRENT_RS_SESSION;
  env.__testState.scanRefreshJobs.push({
    id: `job-${preset.id}`,
    presetId: preset.id,
    jobType: "relative-strength",
    status: "completed",
    startedAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:05:00.000Z",
    completedAt: "2026-04-21T00:05:00.000Z",
    error: null,
    totalCandidates: rows.length,
    processedCandidates: rows.length,
    matchedCandidates: rows.length,
    cursorOffset: rows.length,
    latestSnapshotId: null,
    requestedBy: "test",
    benchmarkBarsJson: null,
    requiredBarCount: Math.max(preset.newHighLookback, 504),
    configKey,
    sharedRunId: null,
    expectedTradingDate,
    benchmarkTicker,
    rsMaType: preset.rsMaType,
    rsMaLength: preset.rsMaLength,
    newHighLookback: preset.newHighLookback,
    fullCandidateCount: rows.length,
    materializationCandidateCount: 0,
    alreadyCurrentCandidateCount: rows.length,
    lastAdvancedAt: "2026-04-21T00:05:00.000Z",
  });
  rows.forEach((row, index) => {
    env.__testState.scanRefreshJobCandidates.push({
      jobId: `job-${preset.id}`,
      cursorOffset: index,
      ticker: row.ticker.toUpperCase(),
      name: row.ticker,
      sector: "Technology",
      industry: "Semiconductors",
      marketCap: 1,
      relativeVolume: 1,
      avgVolume: 1,
      priceAvgVolume: 1,
      materializationRequired: 0,
    });
  });
  for (const row of rows) {
    env.__testState.relativeStrengthLatestCache.set(`${configKey}|${row.ticker.toUpperCase()}`, {
      configKey,
      ticker: row.ticker.toUpperCase(),
      benchmarkTicker,
      rsMaType: preset.rsMaType,
      rsMaLength: preset.rsMaLength,
      newHighLookback: preset.newHighLookback,
      tradingDate: row.tradingDate,
      priceClose: row.priceClose,
      change1d: row.change1d ?? null,
      rsRatioClose: row.rsRatioClose,
      rsRatioMa: row.rsRatioMa ?? null,
      rsAboveMa: row.rsAboveMa ? 1 : 0,
      rsNewHigh: row.rsNewHigh ? 1 : 0,
      rsNewHighBeforePrice: row.rsNewHighBeforePrice ? 1 : 0,
      bullCross: row.bullCross ? 1 : 0,
      approxRsRating: row.approxRsRating ?? null,
    });
    env.__testState.relativeStrengthConfigState.set(`${configKey}|${row.ticker.toUpperCase()}`, {
      configKey,
      ticker: row.ticker.toUpperCase(),
      benchmarkTicker,
      rsMaType: preset.rsMaType,
      rsMaLength: preset.rsMaLength,
      newHighLookback: preset.newHighLookback,
      stateVersion: 1,
      latestTradingDate: row.tradingDate,
      updatedAt: "2026-04-21T00:05:00.000Z",
      priceClose: row.priceClose,
      change1d: row.change1d ?? null,
      rsRatioClose: row.rsRatioClose,
      rsRatioMa: row.rsRatioMa ?? null,
      rsAboveMa: row.rsAboveMa ? 1 : 0,
      rsNewHigh: row.rsNewHigh ? 1 : 0,
      rsNewHighBeforePrice: row.rsNewHighBeforePrice ? 1 : 0,
      bullCross: row.bullCross ? 1 : 0,
      approxRsRating: row.approxRsRating ?? null,
      priceCloseHistoryJson: JSON.stringify([row.priceClose]),
      benchmarkCloseHistoryJson: JSON.stringify([100]),
      weightedScoreHistoryJson: JSON.stringify([0]),
      rsNewHighWindowJson: JSON.stringify([row.rsRatioClose]),
      priceNewHighWindowJson: JSON.stringify([row.priceClose]),
      smaWindowJson: JSON.stringify(row.rsRatioMa == null ? [] : [row.rsRatioClose]),
      smaSum: row.rsRatioMa == null ? null : row.rsRatioClose,
      emaValue: row.rsRatioMa ?? row.rsRatioClose,
      previousRsClose: row.rsRatioClose,
      previousRsMa: row.rsRatioMa ?? row.rsRatioClose,
    });
  }
  return { configKey, expectedTradingDate };
}

describe("scans page service", () => {
  it("normalizes rows, computes price * avg volume fallback, and sorts by 1D change descending", () => {
    const rows = normalizeScanRows([
      {
        ticker: "NASDAQ:MSFT",
        name: "Microsoft",
        sector: "Technology",
        industry: "Software",
        change1d: 4.2,
        marketCap: 3_000_000_000_000,
        relativeVolume: 1.3,
        price: 420,
        avgVolume: 20_000_000,
      },
      {
        ticker: "nyse:abc",
        name: "ABC Corp",
        sector: "Industrials",
        industry: "Machinery",
        change1d: 8.5,
        marketCap: "1200000000",
        relativeVolume: "2.75",
        price: "12.5",
        avgVolume: "2500000",
        raw: { source: "tv" },
      },
      {
        ticker: "",
        name: "Invalid",
        change1d: 99,
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ticker: "MSFT",
      name: "Microsoft",
      relativeVolume: 1.3,
      priceAvgVolume: 8_400_000_000,
    });
    expect(rows[1]).toMatchObject({
      ticker: "ABC",
      name: "ABC Corp",
      change1d: 8.5,
      marketCap: 1_200_000_000,
      price: 12.5,
      avgVolume: 2_500_000,
      relativeVolume: 2.75,
      priceAvgVolume: 31_250_000,
    });
  });

  it("builds a tradingview payload that pushes numeric rules upstream and expands fetch size for post-filters", () => {
    const payload = buildTradingViewScanPayload(topGainersPreset);

    expect(payload.sort).toEqual({ sortBy: "change", sortOrder: "desc" });
    expect(payload.range).toEqual([0, 1000]);
    expect(payload.filter).toEqual([
      { left: "close", operation: "greater", right: 1 },
      { left: "change", operation: "greater", right: 3 },
      { left: "volume", operation: "greater", right: 100000 },
      { left: "Value.Traded", operation: "greater", right: 10000000 },
    ]);
  });

  it("keeps field-reference rules as post-filters and fetches the comparison field column", () => {
    const payload = buildTradingViewScanPayload({
      ...topGainersPreset,
      rules: [
        { id: "ema5-max", field: "EMA5", operator: "lte", value: { type: "field", field: "close", multiplier: 1 } },
        { id: "ema5-min", field: "EMA5", operator: "gte", value: { type: "field", field: "close", multiplier: 0.97 } },
      ],
    });

    expect(payload.filter).toEqual([
      { left: "EMA5", operation: "eless", right: "close" },
    ]);
    expect(payload.columns).toContain("EMA5");
    expect(payload.columns).toContain("close");
    expect(payload.range).toEqual([0, 1000]);
  });

  it("applies string post-filters after the TradingView response is parsed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            s: "NASDAQ:NVDA",
            d: ["NVIDIA", "Technology", "Semiconductors", 5.7, 2_000_000_000_000, 1.8, 910, 45_000_000, 40_950_000_000, 60_000_000, "NASDAQ", "stock"],
          },
          {
            s: "NASDAQ:BIOX",
            d: ["Bio X", "Health Care", "Biotechnology", 2_500_000_000, 1.1, 6.2, 9.4, 4_000_000, 37_600_000, 8_000_000, "NASDAQ", "stock"],
          },
          {
            s: "OTC:OTCC",
            d: ["OTC Co", "Technology", "Software", 8.2, 900_000_000, 0.8, 5.5, 2_000_000, 11_000_000, 3_000_000, "OTC", "stock"],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTradingViewScanRows(topGainersPreset);

    expect(result.status).toBe("ok");
    expect(result.rows.map((row) => row.ticker)).toEqual(["NVDA"]);
    expect(result.rows[0]?.relativeVolume).toBe(1.8);
    vi.unstubAllGlobals();
  });

  it("applies field-reference comparisons after the TradingView response is parsed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            s: "NASDAQ:PASS",
            d: ["Pass Corp", "Technology", "Software", 4.1, 500_000_000, 1.5, 100, 5_000_000, 500_000_000, 6_000_000, "NASDAQ", "stock", 98],
          },
          {
            s: "NASDAQ:TOOLOW",
            d: ["Too Low", "Technology", "Software", 3.7, 400_000_000, 1.2, 100, 4_000_000, 400_000_000, 5_000_000, "NASDAQ", "stock", 96],
          },
          {
            s: "NASDAQ:TOOHIGH",
            d: ["Too High", "Technology", "Software", 3.9, 450_000_000, 1.3, 100, 4_500_000, 450_000_000, 5_500_000, "NASDAQ", "stock", 101],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTradingViewScanRows({
      ...topGainersPreset,
      rules: [
        { id: "type", field: "type", operator: "in", value: ["stock"] },
        { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ"] },
        { id: "ema5-max", field: "EMA5", operator: "lte", value: { type: "field", field: "close", multiplier: 1 } },
        { id: "ema5-min", field: "EMA5", operator: "gte", value: { type: "field", field: "close", multiplier: 0.97 } },
      ],
    });

    expect(result.status).toBe("ok");
    expect(result.rows.map((row) => row.ticker)).toEqual(["PASS"]);
    vi.unstubAllGlobals();
  });

  it("pages through upstream-sorted results so post-filters are not biased to the first market-cap slice", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { range?: [number, number] };
      const rangeStart = payload.range?.[0] ?? 0;
      if (rangeStart === 0) {
        return {
          ok: true,
          json: async () => ({
            totalCount: 1002,
            data: Array.from({ length: 1000 }, (_, index) => ({
              s: `NASDAQ:BIG${index}`,
              d: [`Big ${index}`, "Technology", "Software", 1.5, 200_000_000_000 - index, 1.1, 50, 5_000_000, 250_000_000, 5_000_000, "NASDAQ", "stock", 60, 40],
            })),
          }),
        };
      }
      if (rangeStart === 1000) {
        return {
          ok: true,
          json: async () => ({
            totalCount: 1002,
            data: [
              {
                s: "NASDAQ:MID1",
                d: ["Mid 1", "Technology", "Software", 4.1, 35_000_000_000, 1.5, 25, 3_500_000, 87_500_000, 3_500_000, "NASDAQ", "stock", 25.2, 20],
              },
              {
                s: "NASDAQ:MID2",
                d: ["Mid 2", "Technology", "Software", 3.8, 34_000_000_000, 1.4, 24, 3_200_000, 76_800_000, 3_200_000, "NASDAQ", "stock", 24.1, 19],
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              s: "NASDAQ:SMALL1",
              d: ["Small 1", "Technology", "Software", 4.2, 2_000_000_000, 1.7, 20, 3_000_000, 60_000_000, 3_000_000, "NASDAQ", "stock", 20.1, 18],
            },
            {
              s: "NASDAQ:SMALL2",
              d: ["Small 2", "Technology", "Software", 3.6, 1_500_000_000, 1.6, 14, 2_500_000, 35_000_000, 2_500_000, "NASDAQ", "stock", 14.2, 12],
            },
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTradingViewScanRows({
      ...topGainersPreset,
      sortField: "market_cap_basic",
      sortDirection: "desc",
      rowLimit: 2,
      rules: [
        { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ"] },
        { id: "close-max", field: "close", operator: "lte", value: { type: "field", field: "EMA5", multiplier: 1.03 } },
        { id: "close-min", field: "close", operator: "gte", value: { type: "field", field: "EMA5", multiplier: 0.97 } },
        { id: "sma200", field: "SMA200", operator: "lt", value: { type: "field", field: "close", multiplier: 1 } },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.rows.map((row) => row.ticker)).toEqual(["MID1", "MID2"]);
    vi.unstubAllGlobals();
  });

  it("compiles unique tickers across the latest snapshots of multiple presets", async () => {
    const presetRows = [
      { id: "preset-a", name: "Leaders", isDefault: 1, isActive: 1, rulesJson: "[]", sortField: "change", sortDirection: "desc", rowLimit: 100, createdAt: "", updatedAt: "" },
      { id: "preset-b", name: "Breakouts", isDefault: 0, isActive: 1, rulesJson: "[]", sortField: "change", sortDirection: "desc", rowLimit: 100, createdAt: "", updatedAt: "" },
    ];
    const snapshotRows = {
      "preset-a": { id: "snap-a", presetId: "preset-a", providerLabel: "TV", generatedAt: "2026-03-18T01:00:00.000Z", rowCount: 2, matchedRowCount: 2, status: "ok", error: null },
      "preset-b": { id: "snap-b", presetId: "preset-b", providerLabel: "TV", generatedAt: "2026-03-18T02:00:00.000Z", rowCount: 2, matchedRowCount: 2, status: "ok", error: null },
    } as const;
    const scanRows = {
      "snap-a": [
        { ticker: "NVDA", name: "NVIDIA", sector: "Technology", industry: "Semiconductors", change1d: 4.5, marketCap: 1, price: 100, avgVolume: 10, priceAvgVolume: 1000, rawJson: JSON.stringify({ relative_volume_10d_calc: 2.1 }) },
        { ticker: "PLTR", name: "Palantir", sector: "Technology", industry: "Software", change1d: 2.2, marketCap: 1, price: 20, avgVolume: 10, priceAvgVolume: 200, rawJson: JSON.stringify({ relative_volume_10d_calc: 1.4 }) },
      ],
      "snap-b": [
        { ticker: "NVDA", name: "NVIDIA", sector: "Technology", industry: "Semiconductors", change1d: 5.1, marketCap: 1, price: 101, avgVolume: 10, priceAvgVolume: 1010, rawJson: JSON.stringify({ relative_volume_10d_calc: 2.3 }) },
        { ticker: "SNOW", name: "Snowflake", sector: "Technology", industry: "Software", change1d: 3.1, marketCap: 1, price: 30, avgVolume: 10, priceAvgVolume: 300, rawJson: JSON.stringify({ relative_volume_10d_calc: 1.8 }) },
      ],
    } as const;

    const env = {
      DB: {
        prepare(query: string) {
          return {
            bind(value: string) {
              return {
                async first() {
                  if (query.includes("FROM scan_presets WHERE id = ?")) {
                    return presetRows.find((row) => row.id === value) ?? null;
                  }
                  if (query.includes("FROM scan_snapshots")) {
                    return snapshotRows[value as keyof typeof snapshotRows] ?? null;
                  }
                  return null;
                },
                async all() {
                  if (query.includes("FROM scan_rows WHERE snapshot_id = ?")) {
                    return { results: scanRows[value as keyof typeof scanRows] ?? [] };
                  }
                  return { results: [] };
                },
              };
            },
          };
        },
      },
    } as any;

    const result = await loadCompiledScansSnapshot(env, ["preset-a", "preset-b"]);

    expect(result.presetNames).toEqual(["Leaders", "Breakouts"]);
    expect(result.generatedAt).toBe("2026-03-18T02:00:00.000Z");
    expect(result.rows.map((row) => [row.ticker, row.occurrences])).toEqual([
      ["NVDA", 2],
      ["SNOW", 1],
      ["PLTR", 1],
    ]);
    expect(result.rows[0]).toMatchObject({
      ticker: "NVDA",
      presetNames: ["Leaders", "Breakouts"],
      latestPrice: 101,
      latestRelativeVolume: 2.3,
    });
  });

  it("retries relative strength benchmark history on earlier sessions when the latest benchmark day is unavailable", async () => {
    const relativeStrengthPreset: ScanPreset = {
      ...topGainersPreset,
      id: "preset-rs",
      name: "Relative Strength",
      scanType: "relative-strength",
      rules: [],
      prefilterRules: [
        { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ"] },
      ],
      benchmarkTicker: "SPY",
      sortField: "rs_close",
      sortDirection: "desc",
      rowLimit: 50,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            s: "NASDAQ:NVDA",
            d: ["NVIDIA", "Technology", "Semiconductors", 5.2, 1, 2.3, 120, 10, 1200, 10, "NASDAQ", "stock"],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const stockBars = makeBarsEndingOn("NVDA", 260, 100, 1);
    const benchmarkBars = makeBarsEndingOn("SPY", 260, 90, 0.5);
    const { env } = createMutableScansEnv({
      presets: [relativeStrengthPreset],
      symbols: ["NVDA"],
      dailyBarsByTicker: {
        NVDA: stockBars.map(({ date, o, h, l, c, volume }) => ({ date, o, h, l, c, volume })),
      },
    });
    const primaryProvider = {
      label: "primary",
      getDailyBars: vi.fn(async (tickers: string[]) => (tickers[0] === "NVDA" ? stockBars : [])),
    };
    let fallbackBenchmarkCalls = 0;
    const fallbackProvider = {
      label: "fallback",
      getDailyBars: vi.fn(async (tickers: string[]) => {
        if (tickers[0] !== "SPY") return [];
        fallbackBenchmarkCalls += 1;
        return fallbackBenchmarkCalls >= 2 ? benchmarkBars : [];
      }),
    };
    vi.spyOn(providerModule, "getProvider").mockImplementation((providerEnv: any) =>
      providerEnv.DATA_PROVIDER === "stooq" ? fallbackProvider as any : primaryProvider as any);

    const job = await completeRelativeStrengthMaterializationJob(env, "preset-rs");
    const attemptedEndDates = new Set(fallbackProvider.getDailyBars.mock.calls.map((call) => String(call[2] ?? "")));

    expect(job.status).toBe("completed");
    expect(fallbackProvider.getDailyBars).toHaveBeenCalled();
    expect(attemptedEndDates.size).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });

  it("falls back to stored benchmark bars when live providers cannot return the benchmark ticker", async () => {
    const relativeStrengthPreset: ScanPreset = {
      ...topGainersPreset,
      id: "preset-rs-stored",
      name: "Relative Strength",
      scanType: "relative-strength",
      rules: [],
      prefilterRules: [
        { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ"] },
      ],
      benchmarkTicker: "SPY",
      sortField: "rs_close",
      sortDirection: "desc",
      rowLimit: 50,
    };
    const stockBars = makeBarsEndingOn("NVDA", 260, 100, 1);
    const storedBenchmarkBars = makeBarsEndingOn("SPY", 260, 90, 0.5);
    const { env } = createMutableScansEnv({
      presets: [relativeStrengthPreset],
      symbols: ["NVDA", "SPY"],
      dailyBarsByTicker: {
        NVDA: stockBars.map(({ date, o, h, l, c, volume }) => ({ date, o, h, l, c, volume })),
        SPY: storedBenchmarkBars.map(({ date, o, h, l, c, volume }) => ({ date, o, h, l, c, volume })),
      },
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            s: "NASDAQ:NVDA",
            d: ["NVIDIA", "Technology", "Semiconductors", 5.2, 1, 2.3, 120, 10, 1200, 10, "NASDAQ", "stock"],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const providerWithoutBenchmark = {
      label: "provider-without-benchmark",
      getDailyBars: vi.fn(async (tickers: string[]) => (tickers[0] === "NVDA" ? stockBars : [])),
    };
    vi.spyOn(providerModule, "getProvider").mockImplementation(() => providerWithoutBenchmark as any);

    const job = await completeRelativeStrengthMaterializationJob(env, "preset-rs-stored");

    expect(job.status).toBe("completed");

    vi.unstubAllGlobals();
  });

  it("maps the SP:SPX benchmark preset to ^GSPC market data while preserving the preset value in scan output", async () => {
    const relativeStrengthPreset: ScanPreset = {
      ...topGainersPreset,
      id: "preset-rs-spx",
      name: "Relative Strength",
      scanType: "relative-strength",
      rules: [],
      prefilterRules: [
        { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ"] },
      ],
      benchmarkTicker: "SP:SPX",
      sortField: "rs_close",
      sortDirection: "desc",
      rowLimit: 50,
    };
    const stockBars = makeBarsEndingOn("NVDA", 260, 100, 1);
    const benchmarkBars = makeBarsEndingOn("^GSPC", 260, 90, 0.5);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            s: "NASDAQ:NVDA",
            d: ["NVIDIA", "Technology", "Semiconductors", 5.2, 1, 2.3, 120, 10, 1200, 10, "NASDAQ", "stock"],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { env } = createMutableScansEnv({
      presets: [relativeStrengthPreset],
      symbols: ["NVDA"],
      dailyBarsByTicker: {
        NVDA: stockBars.map(({ date, o, h, l, c, volume }) => ({ date, o, h, l, c, volume })),
      },
    });

    const provider = {
      label: "provider-with-spx-alias",
      getDailyBars: vi.fn(async (tickers: string[]) => {
        if (tickers[0] === "^GSPC") return benchmarkBars;
        if (tickers[0] === "NVDA") return stockBars;
        return [];
      }),
    };
    vi.spyOn(providerModule, "getProvider").mockImplementation(() => provider as any);

    const job = await completeRelativeStrengthMaterializationJob(env, "preset-rs-spx");

    expect(job.status).toBe("completed");
    expect(provider.getDailyBars.mock.calls.some((call) => (call[0] as string[])[0] === "^GSPC")).toBe(true);

    vi.unstubAllGlobals();
  });

  it("backfills full history for sparse stored bars before evaluating RS new highs", async () => {
    const relativeStrengthPreset: ScanPreset = {
      ...topGainersPreset,
      id: "preset-rs-sparse-history",
      name: "Relative Strength",
      scanType: "relative-strength",
      rules: [],
      prefilterRules: [
        { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ"] },
      ],
      benchmarkTicker: "SPY",
      sortField: "rs_close",
      sortDirection: "desc",
      rowLimit: 50,
      outputMode: "rs_new_high_only",
    };
    const benchmarkBars = makeBarsEndingOn("SPY", 260, 100, 0.1);
    const stockValues = Array.from({ length: 260 }, (_, index) => 140 + index * 0.2);
    stockValues[40] = 455.9;
    stockValues[259] = 170.81;
    const stockBars = makeBarsEndingOn("MSTR", 260, 140, 0.2).map((bar, index) => ({
      ...bar,
      c: stockValues[index],
      o: stockValues[index],
      h: stockValues[index],
      l: stockValues[index],
    }));
    const sparseStoredBars = stockBars.slice(-29);
    const { env } = createMutableScansEnv({
      presets: [relativeStrengthPreset],
      symbols: ["MSTR"],
      dailyBarsByTicker: {
        MSTR: sparseStoredBars.map(({ date, o, h, l, c, volume }) => ({ date, o, h, l, c, volume })),
      },
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            s: "NASDAQ:MSTR",
            d: ["MicroStrategy", "Technology Services", "Internet Software/Services", 2.5, 1, 1.1, 170.81, 10, 1708.1, 10, "NASDAQ", "stock"],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = {
      label: "provider-with-full-history-backfill",
      getDailyBars: vi.fn(async (tickers: string[]) => {
        if (tickers[0] === "SPY") return benchmarkBars;
        if (tickers[0] === "MSTR") return stockBars;
        return [];
      }),
    };
    vi.spyOn(providerModule, "getProvider").mockImplementation(() => provider as any);

    const response = await materializeRelativeStrengthPreset(env, "preset-rs-sparse-history");
    const result = response.snapshot;

    expect(response.async).toBe(false);
    expect(result?.status).toBe("empty");
    expect(result?.rows).toEqual([]);
    expect(env.__testState.dailyBarsByTicker.get("MSTR")).toHaveLength(stockBars.length);
    expect(env.__testState.relativeStrengthLatestCache.size).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });

  it("builds a warm RS snapshot directly from the shared latest cache", async () => {
    const relativeStrengthPreset: ScanPreset = {
      ...topGainersPreset,
      id: "preset-rs-stale-top-up",
      name: "Relative Strength",
      scanType: "relative-strength",
      rules: [],
      prefilterRules: [
        { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ"] },
      ],
      benchmarkTicker: "SPY",
      sortField: "rs_close",
      sortDirection: "desc",
      rowLimit: 50,
      outputMode: "rs_new_high_only",
    };
    const { env } = createMutableScansEnv({
      presets: [relativeStrengthPreset],
      symbols: ["NVDA"],
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            s: "NASDAQ:NVDA",
            d: ["NVIDIA", "Technology", "Semiconductors", 5.2, 1, 2.3, 120, 10, 1200, 10, "NASDAQ", "stock"],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const latestTradingDate = CURRENT_RS_SESSION;
    const latestPriceClose = 199;
    seedCompletedRelativeStrengthCache(env, relativeStrengthPreset, [
      {
        ticker: "NVDA",
        tradingDate: latestTradingDate,
        priceClose: latestPriceClose,
        change1d: 2.7,
        rsRatioClose: 1.5,
        rsRatioMa: 1.2,
        rsAboveMa: true,
        rsNewHigh: true,
        rsNewHighBeforePrice: false,
        bullCross: true,
        approxRsRating: 99,
      },
    ]);

    const response = await requestScansRefresh(env, "preset-rs-stale-top-up", "test");
    const result = response.snapshot;

    expect(response.async).toBe(false);
    expect(result?.status).toBe("ok");
    expect(result?.rows.map((row) => row.ticker)).toEqual(["NVDA"]);
    expect(result?.rows[0]?.price).toBe(latestPriceClose);
    expect(result?.rows[0]?.rsNewHigh).toBe(true);
    expect(result?.rows[0]?.rawJson).toContain(`"tradingDate":"${latestTradingDate}"`);

    vi.unstubAllGlobals();
  });

  it("resets malformed active RS jobs that are missing candidate rows before creating a fresh job", async () => {
    const relativeStrengthPreset: ScanPreset = {
      ...topGainersPreset,
      id: "preset-rs-reset-broken-job",
      name: "Relative Strength",
      scanType: "relative-strength",
      rules: [],
      prefilterRules: [
        { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ"] },
      ],
      benchmarkTicker: "SPY",
      sortField: "rs_close",
      sortDirection: "desc",
      rowLimit: 50,
    };
    const { env } = createMutableScansEnv({
      presets: [relativeStrengthPreset],
      symbols: ["NVDA"],
    });

    env.__testState.scanRefreshJobs.push({
      id: "broken-rs-job",
      presetId: relativeStrengthPreset.id,
      jobType: "relative-strength",
      status: "running",
      startedAt: "2026-04-22T10:30:00.000Z",
      updatedAt: "2026-04-22T10:30:00.000Z",
      completedAt: null,
      error: null,
      totalCandidates: 1,
      processedCandidates: 0,
      matchedCandidates: 0,
      cursorOffset: 0,
      latestSnapshotId: null,
      requestedBy: "test",
      benchmarkBarsJson: null,
      requiredBarCount: 504,
      configKey: "SPY|EMA|21|252",
      sharedRunId: null,
      expectedTradingDate: CURRENT_RS_SESSION,
      benchmarkTicker: "SPY",
      rsMaType: "EMA",
      rsMaLength: 21,
      newHighLookback: 252,
      fullCandidateCount: 1,
      materializationCandidateCount: 1,
      alreadyCurrentCandidateCount: 0,
      lastAdvancedAt: null,
    });
    env.__testState.relativeStrengthRefreshQueue.set("broken-rs-job", {
      jobId: "broken-rs-job",
      source: "continuation",
      enqueuedAt: "2026-04-22T10:30:00.000Z",
      lastAttemptedAt: null,
      attempts: 3,
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            s: "NASDAQ:NVDA",
            d: ["NVIDIA", "Technology", "Semiconductors", 5.2, 1, 2.3, 120, 10, 1200, 10, "NASDAQ", "stock"],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestScansRefresh(env, relativeStrengthPreset.id, "test");

    expect(response.async).toBe(true);
    expect(response.job).not.toBeNull();
    expect(response.job?.id).not.toBe("broken-rs-job");
    const brokenJob = env.__testState.scanRefreshJobs.find((job: MutableScanRefreshJob) => job.id === "broken-rs-job");
    expect(brokenJob?.status).toBe("failed");
    expect(brokenJob?.error).toContain("missing candidate rows");
    expect(env.__testState.relativeStrengthRefreshQueue.has("broken-rs-job")).toBe(false);
    expect(env.__testState.scanRefreshJobCandidates.filter((row: MutableScanRefreshJobCandidate) => row.jobId === response.job?.id)).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it("completes RS jobs immediately when there are no stale candidates left to materialize", async () => {
    const relativeStrengthPreset: ScanPreset = {
      ...topGainersPreset,
      id: "preset-rs-zero-stale",
      name: "Relative Strength",
      scanType: "relative-strength",
      rules: [],
      prefilterRules: [
        { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ"] },
      ],
      benchmarkTicker: "SPY",
      sortField: "rs_close",
      sortDirection: "desc",
      rowLimit: 50,
    };
    const { env } = createMutableScansEnv({
      presets: [relativeStrengthPreset],
      symbols: ["NVDA"],
    });

    env.__testState.scanRefreshJobs.push({
      id: "zero-stale-job",
      presetId: relativeStrengthPreset.id,
      jobType: "relative-strength",
      status: "running",
      startedAt: "2026-04-22T10:35:00.000Z",
      updatedAt: "2026-04-22T10:35:00.000Z",
      completedAt: null,
      error: null,
      totalCandidates: 1,
      processedCandidates: 0,
      matchedCandidates: 0,
      cursorOffset: 0,
      latestSnapshotId: null,
      requestedBy: "test",
      benchmarkBarsJson: null,
      requiredBarCount: 504,
      configKey: "SPY|EMA|21|252",
      sharedRunId: null,
      expectedTradingDate: CURRENT_RS_SESSION,
      benchmarkTicker: "SPY",
      rsMaType: "EMA",
      rsMaLength: 21,
      newHighLookback: 252,
      fullCandidateCount: 1,
      materializationCandidateCount: 0,
      alreadyCurrentCandidateCount: 1,
      lastAdvancedAt: null,
    });
    env.__testState.scanRefreshJobCandidates.push({
      jobId: "zero-stale-job",
      cursorOffset: 0,
      ticker: "NVDA",
      name: "NVIDIA",
      sector: "Technology",
      industry: "Semiconductors",
      marketCap: 1,
      relativeVolume: 1,
      avgVolume: 1,
      priceAvgVolume: 1,
      materializationRequired: 0,
    });
    env.__testState.relativeStrengthRefreshQueue.set("zero-stale-job", {
      jobId: "zero-stale-job",
      source: "continuation",
      enqueuedAt: "2026-04-22T10:35:00.000Z",
      lastAttemptedAt: null,
      attempts: 0,
    });

    const processed = await processRelativeStrengthRefreshJob(env, "zero-stale-job", {
      maxBatches: 1,
      timeBudgetMs: 60_000,
    });

    expect(processed?.status).toBe("completed");
    expect(processed?.matchedCandidates).toBe(1);
    expect(processed?.materializationCandidateCount).toBe(0);
    expect(env.__testState.relativeStrengthRefreshQueue.has("zero-stale-job")).toBe(false);
  });

  it("drops stale RS rows when a ticker cannot be refreshed to the benchmark's latest session", async () => {
    const relativeStrengthPreset: ScanPreset = {
      ...topGainersPreset,
      id: "preset-rs-stale-drop",
      name: "Relative Strength",
      scanType: "relative-strength",
      rules: [],
      prefilterRules: [
        { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ"] },
      ],
      benchmarkTicker: "SPY",
      sortField: "rs_close",
      sortDirection: "desc",
      rowLimit: 50,
      outputMode: "rs_new_high_only",
    };
    const benchmarkBars = makeBarsEndingOn("SPY", 260, 100, 0.1);
    const stockValues = Array.from({ length: 260 }, (_, index) => 80 + index * 0.4);
    stockValues[258] = 200;
    stockValues[259] = 199;
    benchmarkBars[259] = { ...benchmarkBars[259], o: 90, h: 90, l: 90, c: 90, volume: benchmarkBars[259]?.volume ?? 0 };
    const stockBars = makeBarsEndingOn("NVDA", 260, 80, 0.4).map((bar, index) => ({ ...bar, c: stockValues[index], o: stockValues[index], h: stockValues[index], l: stockValues[index] }));
    const storedStockBars = stockBars.slice(0, -5);
    const staleTradingDate = storedStockBars.at(-1)?.date;
    const { env } = createMutableScansEnv({
      presets: [relativeStrengthPreset],
      symbols: ["NVDA"],
      dailyBarsByTicker: {
        NVDA: storedStockBars.map(({ date, o, h, l, c, volume }) => ({ date, o, h, l, c, volume })),
      },
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            s: "NASDAQ:NVDA",
            d: ["NVIDIA", "Technology", "Semiconductors", 5.2, 1, 2.3, 120, 10, 1200, 10, "NASDAQ", "stock"],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = {
      label: "provider-without-stale-top-up",
      getDailyBars: vi.fn(async (tickers: string[]) => (tickers[0] === "SPY" ? benchmarkBars : [])),
    };
    vi.spyOn(providerModule, "getProvider").mockImplementation(() => provider as any);

    const response = await materializeRelativeStrengthPreset(env, "preset-rs-stale-drop");
    const result = response.snapshot;

    expect(response.async).toBe(false);
    expect(result?.status).toBe("empty");
    expect(result?.rows).toEqual([]);
    expect(staleTradingDate).not.toBe(benchmarkBars.at(-1)?.date);

    vi.unstubAllGlobals();
  });

  it("reuses current RS config state across presets when the config matches", async () => {
    const sharedBasePreset: ScanPreset = {
      ...topGainersPreset,
      scanType: "relative-strength",
      rules: [],
      prefilterRules: [
        { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ"] },
      ],
      benchmarkTicker: "SPY",
      sortField: "rs_close",
      sortDirection: "desc",
      rowLimit: 50,
    };
    const presetA: ScanPreset = {
      ...sharedBasePreset,
      id: "preset-rs-shared-a",
      name: "Relative Strength A",
      verticalOffset: 30,
    };
    const presetB: ScanPreset = {
      ...sharedBasePreset,
      id: "preset-rs-shared-b",
      name: "Relative Strength B",
      verticalOffset: 45,
      outputMode: "both",
    };
    const { env } = createMutableScansEnv({
      presets: [presetA, presetB],
      symbols: ["NVDA"],
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            s: "NASDAQ:NVDA",
            d: ["NVIDIA", "Technology", "Semiconductors", 5.2, 1, 2.3, 120, 10, 1200, 10, "NASDAQ", "stock"],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const seeded = seedCompletedRelativeStrengthCache(env, presetA, [
      {
        ticker: "NVDA",
        tradingDate: CURRENT_RS_SESSION,
        priceClose: 170.81,
        change1d: 2.55,
        rsRatioClose: 1.42,
        rsRatioMa: 1.31,
        rsAboveMa: true,
        rsNewHigh: true,
        rsNewHighBeforePrice: false,
        bullCross: false,
        approxRsRating: 85,
      },
    ]);
    const warmedA = await requestScansRefresh(env, presetA.id, "test");
    const warmedB = await requestScansRefresh(env, presetB.id, "test");

    expect(warmedA.async).toBe(false);
    expect(warmedB.async).toBe(false);
    expect(warmedA.snapshot?.rows.map((row) => row.ticker)).toEqual(["NVDA"]);
    expect(warmedA.snapshot?.rows[0]?.rawJson).toContain(`"tradingDate":"${seeded.expectedTradingDate}"`);
    expect(warmedB.job).toBeNull();
    expect(warmedB.snapshot?.rows.map((row) => row.ticker)).toEqual(["NVDA"]);

    vi.unstubAllGlobals();
  });

  it("shares one RS materialization run across same-config presets with different output modes", async () => {
    const presetA: ScanPreset = {
      ...topGainersPreset,
      id: "preset-rs-shared-run-a",
      name: "Relative Strength - New Highs",
      scanType: "relative-strength",
      rules: [],
      prefilterRules: [
        { id: "exchange", field: "exchange", operator: "in", value: ["NASDAQ"] },
      ],
      benchmarkTicker: "SPY",
      outputMode: "rs_new_high_only",
      sortField: "rs_close",
      sortDirection: "desc",
      rowLimit: 50,
    };
    const presetB: ScanPreset = {
      ...presetA,
      id: "preset-rs-shared-run-b",
      name: "Relative Strength - Signal",
      outputMode: "both",
    };
    const benchmarkBars = makeBarsEndingOn("SPY", 520, 100, 0.15);
    const tickerBars = makeBarsEndingOn("NVDA", 520, 40, 0.5);
    const { env } = createMutableScansEnv({
      presets: [presetA, presetB],
      symbols: ["NVDA"],
      dailyBarsByTicker: {
        SPY: benchmarkBars,
        NVDA: tickerBars,
      },
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            s: "NASDAQ:NVDA",
            d: ["NVIDIA", "Technology", "Semiconductors", 5.2, 1, 2.3, 120, 10, 1200, 10, "NASDAQ", "stock"],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await requestScansRefresh(env, presetA.id, "test");
    const second = await requestScansRefresh(env, presetB.id, "test");

    expect(first.async).toBe(true);
    expect(second.async).toBe(true);
    expect(first.job?.sharedRunId).toBeTruthy();
    expect(second.job?.sharedRunId).toBe(first.job?.sharedRunId);
    expect(env.__testState.relativeStrengthMaterializationRuns.size).toBe(1);

    let job = second.job;
    while (job && (job.status === "queued" || job.status === "running")) {
      job = await processRelativeStrengthRefreshJob(env, job.id, { maxBatches: 20, timeBudgetMs: 60_000 });
    }

    const firstCompleted = env.__testState.scanRefreshJobs.find((row: MutableScanRefreshJob) => row.id === first.job?.id);
    const secondCompleted = env.__testState.scanRefreshJobs.find((row: MutableScanRefreshJob) => row.id === second.job?.id);
    expect(firstCompleted?.status).toBe("completed");
    expect(secondCompleted?.status).toBe("completed");

    vi.unstubAllGlobals();
  });

  it("duplicates presets with copied settings, a fresh id, and incremented copy naming", async () => {
    const originalPrefilterRules = [
      { id: "prefilter-cap", field: "market_cap", operator: "gt", value: 1_000_000_000 },
      { id: "prefilter-price", field: "close", operator: "gt", value: 20 },
    ];
    const presetRows = [
      {
        id: "preset-a",
        name: "Momentum",
        scanType: "relative-strength",
        isDefault: 1,
        isActive: 1,
        rulesJson: JSON.stringify(topGainersPreset.rules),
        prefilterRulesJson: JSON.stringify(originalPrefilterRules),
        benchmarkTicker: "SPY",
        verticalOffset: 30,
        rsMaLength: 21,
        rsMaType: "EMA",
        newHighLookback: 252,
        outputMode: "rs_new_high_only",
        sortField: "change",
        sortDirection: "desc",
        rowLimit: 100,
        createdAt: "",
        updatedAt: "",
      },
      { id: "preset-b", name: "Momentum Copy", isDefault: 0, isActive: 1, rulesJson: "[]", sortField: "change", sortDirection: "desc", rowLimit: 50, createdAt: "", updatedAt: "" },
      { id: "preset-c", name: "Momentum Copy 2", isDefault: 0, isActive: 1, rulesJson: "[]", sortField: "ticker", sortDirection: "asc", rowLimit: 25, createdAt: "", updatedAt: "" },
    ];
    let insertedRow: any = null;

    const env = {
      DB: {
        prepare(query: string) {
          return {
            bind(...args: any[]) {
              return {
                async first() {
                  if (query.includes("FROM scan_presets WHERE id = ?")) {
                    const id = args[0];
                    if (insertedRow?.id === id) return insertedRow;
                    return presetRows.find((row) => row.id === id) ?? null;
                  }
                  return null;
                },
                async all() {
                  if (query.includes("FROM scan_presets ORDER BY")) {
                    return { results: insertedRow ? [...presetRows, insertedRow] : presetRows };
                  }
                  return { results: [] };
                },
                async run() {
                  if (query.includes("UPDATE scan_presets SET is_default = 0")) return {};
                  if (query.includes("INSERT INTO scan_presets")) {
                    insertedRow = {
                      id: args[0],
                      name: args[1],
                      scanType: args[2],
                      isDefault: args[3],
                      isActive: args[4],
                      rulesJson: args[5],
                      prefilterRulesJson: args[6],
                      benchmarkTicker: args[7],
                      verticalOffset: args[8],
                      rsMaLength: args[9],
                      rsMaType: args[10],
                      newHighLookback: args[11],
                      outputMode: args[12],
                      sortField: args[13],
                      sortDirection: args[14],
                      rowLimit: args[15],
                      createdAt: "",
                      updatedAt: "",
                    };
                  }
                  return {};
                },
              };
            },
            async all() {
              if (query.includes("FROM scan_presets ORDER BY")) {
                return { results: insertedRow ? [...presetRows, insertedRow] : presetRows };
              }
              return { results: [] };
            },
            async run() {
              if (query.includes("UPDATE scan_presets SET is_default = 0")) return {};
              return {};
            },
          };
        },
      },
    } as any;

    const result = await duplicateScanPreset(env, "preset-a");

    expect(result.id).not.toBe("preset-a");
    expect(result.name).toBe("Momentum Copy 3");
    expect(result.isDefault).toBe(false);
    expect(result.isActive).toBe(true);
    expect(result.sortField).toBe("change");
    expect(result.sortDirection).toBe("desc");
    expect(result.rowLimit).toBe(100);
    expect(result.scanType).toBe("relative-strength");
    expect(result.prefilterRules).toEqual(originalPrefilterRules);
    expect(result.benchmarkTicker).toBe("SPY");
    expect(result.outputMode).toBe("rs_new_high_only");
    expect(result.rules).toEqual(topGainersPreset.rules);
  });

  it("loads compiled rows from a saved compile preset", async () => {
    const compilePresetRows = [
      { id: "compile-daily", name: "Daily", createdAt: "", updatedAt: "", scanPresetId: "preset-a", scanPresetName: "Leaders", sortOrder: 1 },
      { id: "compile-daily", name: "Daily", createdAt: "", updatedAt: "", scanPresetId: "preset-b", scanPresetName: "Breakouts", sortOrder: 2 },
    ];
    const presetRows = [
      { id: "preset-a", name: "Leaders", isDefault: 1, isActive: 1, rulesJson: "[]", sortField: "change", sortDirection: "desc", rowLimit: 100, createdAt: "", updatedAt: "" },
      { id: "preset-b", name: "Breakouts", isDefault: 0, isActive: 1, rulesJson: "[]", sortField: "change", sortDirection: "desc", rowLimit: 100, createdAt: "", updatedAt: "" },
    ];
    const snapshotRows = {
      "preset-a": { id: "snap-a", presetId: "preset-a", providerLabel: "TV", generatedAt: "2026-03-18T01:00:00.000Z", rowCount: 1, matchedRowCount: 1, status: "ok", error: null },
      "preset-b": { id: "snap-b", presetId: "preset-b", providerLabel: "TV", generatedAt: "2026-03-18T02:00:00.000Z", rowCount: 1, matchedRowCount: 1, status: "ok", error: null },
    } as const;
    const scanRows = {
      "snap-a": [
        { ticker: "NVDA", name: "NVIDIA", sector: "Technology", industry: "Semiconductors", change1d: 4.5, marketCap: 1, price: 100, avgVolume: 10, priceAvgVolume: 1000, rawJson: JSON.stringify({ relative_volume_10d_calc: 2.1 }) },
      ],
      "snap-b": [
        { ticker: "SNOW", name: "Snowflake", sector: "Technology", industry: "Software", change1d: 3.1, marketCap: 1, price: 30, avgVolume: 10, priceAvgVolume: 300, rawJson: JSON.stringify({ relative_volume_10d_calc: 1.8 }) },
      ],
    } as const;

    const env = {
      DB: {
        prepare(query: string) {
          return {
            bind(value: string) {
              return {
                async first() {
                  if (query.includes("FROM scan_presets WHERE id = ?")) {
                    return presetRows.find((row) => row.id === value) ?? null;
                  }
                  if (query.includes("FROM scan_snapshots")) {
                    return snapshotRows[value as keyof typeof snapshotRows] ?? null;
                  }
                  return null;
                },
                async all() {
                  if (query.includes("FROM scan_compile_presets cp")) {
                    return { results: compilePresetRows };
                  }
                  if (query.includes("FROM scan_rows WHERE snapshot_id = ?")) {
                    return { results: scanRows[value as keyof typeof scanRows] ?? [] };
                  }
                  return { results: [] };
                },
              };
            },
          };
        },
      },
    } as any;

    const result = await loadCompiledScansSnapshotForCompilePreset(env, "compile-daily");

    expect(result.compilePresetId).toBe("compile-daily");
    expect(result.compilePresetName).toBe("Daily");
    expect(result.presetNames).toEqual(["Leaders", "Breakouts"]);
    expect(result.rows.map((row) => row.ticker)).toEqual(["NVDA", "SNOW"]);
  });

  it("falls back to the latest usable member snapshot when the newest snapshot is an error", async () => {
    const { env } = createMutableScansEnv({
      presets: [
        { ...topGainersPreset, id: "preset-a", name: "Leaders" },
        { ...topGainersPreset, id: "preset-b", name: "Breakouts", sortField: "close" },
      ],
      snapshots: [
        { id: "snap-a-usable", presetId: "preset-a", providerLabel: "TV", generatedAt: "2026-03-18T01:00:00.000Z", rowCount: 1, matchedRowCount: 1, status: "ok", error: null },
        { id: "snap-a-error", presetId: "preset-a", providerLabel: "TV", generatedAt: "2026-03-18T02:00:00.000Z", rowCount: 0, matchedRowCount: 0, status: "error", error: "TV unavailable" },
        { id: "snap-b-usable", presetId: "preset-b", providerLabel: "TV", generatedAt: "2026-03-18T03:00:00.000Z", rowCount: 1, matchedRowCount: 1, status: "ok", error: null },
      ],
      rowsBySnapshotId: {
        "snap-a-usable": [
          { ticker: "NVDA", name: "NVIDIA", sector: "Technology", industry: "Semiconductors", change1d: 4.2, marketCap: 1, relativeVolume: null, price: 100, avgVolume: 10, priceAvgVolume: 1000, rawJson: JSON.stringify({ relative_volume_10d_calc: 2.1 }) },
        ],
        "snap-b-usable": [
          { ticker: "SNOW", name: "Snowflake", sector: "Technology", industry: "Software", change1d: 3.1, marketCap: 1, relativeVolume: null, price: 30, avgVolume: 10, priceAvgVolume: 300, rawJson: JSON.stringify({ relative_volume_10d_calc: 1.8 }) },
        ],
      },
    });

    const result = await loadCompiledScansSnapshot(env, ["preset-a", "preset-b"]);

    expect(result.rows.map((row) => row.ticker)).toEqual(["NVDA", "SNOW"]);
    expect(result.generatedAt).toBe("2026-03-18T03:00:00.000Z");
  });

  it("refreshes every compile preset member, falls back on member failure, and reports outcomes", async () => {
    const presetA = { ...topGainersPreset, id: "preset-a", name: "Leaders", sortField: "change" } satisfies ScanPreset;
    const presetB = { ...topGainersPreset, id: "preset-b", name: "Breakouts", sortField: "close" } satisfies ScanPreset;
    const { env } = createMutableScansEnv({
      presets: [presetA, presetB],
      compilePresets: [{
        id: "compile-daily",
        name: "Daily",
        createdAt: "",
        updatedAt: "",
        members: [
          { scanPresetId: "preset-a", scanPresetName: "Leaders", sortOrder: 1 },
          { scanPresetId: "preset-b", scanPresetName: "Breakouts", sortOrder: 2 },
        ],
      }],
      snapshots: [
        { id: "snap-b-prev", presetId: "preset-b", providerLabel: "TV", generatedAt: "2026-03-18T01:00:00.000Z", rowCount: 1, matchedRowCount: 1, status: "ok", error: null },
      ],
      rowsBySnapshotId: {
        "snap-b-prev": [
          { ticker: "OLDB", name: "Old Breakout", sector: "Technology", industry: "Software", change1d: 1.5, marketCap: 1, relativeVolume: null, price: 10, avgVolume: 10, priceAvgVolume: 100, rawJson: JSON.stringify({ relative_volume_10d_calc: 1.1 }) },
        ],
      },
    });

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { sort?: { sortBy?: string } };
      if (payload.sort?.sortBy === "change") {
        return {
          ok: true,
          json: async () => ({
            data: [
              {
                s: "NASDAQ:NVDA",
                d: ["NVIDIA", "Technology", "Semiconductors", 5.2, 1, 2.3, 120, 10, 1200, 10, "NASDAQ", "stock"],
              },
            ],
          }),
        };
      }
      return {
        ok: false,
        status: 503,
        text: async () => "upstream unavailable",
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshScanCompilePreset(env, "compile-daily");

    expect(result.compilePresetName).toBe("Daily");
    expect(result.refreshedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.memberResults.map((row) => [row.presetName, row.status, row.usedFallback, row.includedInCompiled])).toEqual([
      ["Leaders", "ok", false, true],
      ["Breakouts", "error", true, true],
    ]);
    expect(result.memberResults[1]?.usableSnapshot?.rows.map((row) => row.ticker)).toEqual(["OLDB"]);
    expect(result.snapshot.rows.map((row) => row.ticker)).toEqual(["NVDA", "OLDB"]);

    vi.unstubAllGlobals();
  });

  it("reports failed members with no prior usable snapshot as omitted from the compiled result", async () => {
    const presetA = { ...topGainersPreset, id: "preset-a", name: "Leaders", sortField: "change" } satisfies ScanPreset;
    const presetB = { ...topGainersPreset, id: "preset-b", name: "Breakouts", sortField: "close" } satisfies ScanPreset;
    const { env } = createMutableScansEnv({
      presets: [presetA, presetB],
      compilePresets: [{
        id: "compile-daily",
        name: "Daily",
        createdAt: "",
        updatedAt: "",
        members: [
          { scanPresetId: "preset-a", scanPresetName: "Leaders", sortOrder: 1 },
          { scanPresetId: "preset-b", scanPresetName: "Breakouts", sortOrder: 2 },
        ],
      }],
    });

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { sort?: { sortBy?: string } };
      if (payload.sort?.sortBy === "change") {
        return {
          ok: true,
          json: async () => ({
            data: [
              {
                s: "NASDAQ:NVDA",
                d: ["NVIDIA", "Technology", "Semiconductors", 5.2, 1, 2.3, 120, 10, 1200, 10, "NASDAQ", "stock"],
              },
            ],
          }),
        };
      }
      return {
        ok: false,
        status: 503,
        text: async () => "upstream unavailable",
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshScanCompilePreset(env, "compile-daily");

    expect(result.failedCount).toBe(1);
    expect(result.memberResults[1]).toMatchObject({
      presetName: "Breakouts",
      status: "error",
      usedFallback: false,
      includedInCompiled: false,
      usableSnapshot: null,
    });
    expect(result.snapshot.rows.map((row) => row.ticker)).toEqual(["NVDA"]);

    vi.unstubAllGlobals();
  });

  it("blocks deleting a scan preset that is used by a compile preset", async () => {
    const env = {
      DB: {
        prepare(query: string) {
          return {
            bind(value: string) {
              return {
                async first() {
                  if (query.includes("FROM scan_presets WHERE id = ?")) {
                    return { id: value, name: "Leaders", isDefault: 0, isActive: 1, rulesJson: "[]", sortField: "change", sortDirection: "desc", rowLimit: 100, createdAt: "", updatedAt: "" };
                  }
                  return null;
                },
                async all() {
                  if (query.includes("FROM scan_compile_presets cp")) {
                    return { results: [{ name: "Daily" }] };
                  }
                  return { results: [] };
                },
              };
            },
            async batch() {
              throw new Error("batch should not be called");
            },
          };
        },
      },
    } as any;

    await expect(deleteScanPreset(env, "preset-a")).rejects.toThrow(
      "Cannot delete scan preset because it is used by compile presets: Daily",
    );
  });

  it("deletes scan refresh jobs before snapshots and the preset itself", async () => {
    const batchQueries: string[] = [];
    const env = {
      DB: {
        prepare(query: string) {
          return {
            __query: query,
            bind(value: string) {
              return {
                __query: query,
                async first() {
                  if (query.includes("FROM scan_presets WHERE id = ?")) {
                    return {
                      id: value,
                      name: "Relative Strength Copy",
                      scanType: "relative-strength",
                      isDefault: 0,
                      isActive: 1,
                      rulesJson: "[]",
                      prefilterRulesJson: "[]",
                      benchmarkTicker: "SPY",
                      verticalOffset: 30,
                      rsMaLength: 21,
                      rsMaType: "EMA",
                      newHighLookback: 252,
                      outputMode: "all",
                      sortField: "change",
                      sortDirection: "desc",
                      rowLimit: 100,
                      createdAt: "",
                      updatedAt: "",
                    };
                  }
                  return null;
                },
                async all() {
                  if (query.includes("FROM scan_compile_presets cp")) {
                    return { results: [] };
                  }
                  return { results: [] };
                },
              };
            },
          };
        },
        async batch(statements: Array<{ __query?: string }>) {
          batchQueries.push(...statements.map((statement) => statement.__query ?? ""));
          return [];
        },
      },
    } as any;

    await deleteScanPreset(env, "preset-a");

    expect(batchQueries[0]).toContain("DELETE FROM scan_refresh_jobs");
    expect(batchQueries[1]).toContain("DELETE FROM scan_rows");
    expect(batchQueries[2]).toContain("DELETE FROM scan_snapshots");
    expect(batchQueries[3]).toContain("DELETE FROM scan_presets");
  });
});
