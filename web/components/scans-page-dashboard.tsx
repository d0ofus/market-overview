"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Columns3, Copy, Loader2, Plus, RefreshCw, Save, Settings2, Table2, Trash2 } from "lucide-react";
import {
  createScanPreset,
  createScanCompilePreset,
  deleteScanCompilePreset,
  deleteScanPreset,
  duplicateScanPreset,
  getScanCompilePreset,
  getScanCompilePresetExportUrl,
  getScanCompilePresetSnapshot,
  getScanCompilePresets,
  getScanExportUrl,
  getScanPresets,
  getScansSnapshot,
  getLatestScanRefreshJob,
  getTickerNews,
  refreshScansSnapshot,
  refreshScanCompilePreset,
  updateScanCompilePreset,
  updateScanPreset,
  type AlertNewsRow,
  type CompiledScansSnapshot,
  type ScanCompilePresetDetail,
  type ScanCompilePresetRow,
  type RelativeStrengthMaType,
  type RelativeStrengthOutputMode,
  type ScanRefreshJob,
  type ScanPreset,
  type ScanPresetType,
  type ScanRow,
  type ScanRule,
  type ScanRuleFieldReference,
  type ScanRuleOperator,
  type ScanSnapshot,
} from "@/lib/api";
import { TradingViewWidget } from "./tradingview-widget";
import { PeerGroupModal } from "./peer-group-modal";

type SortKey =
  | "ticker"
  | "name"
  | "sector"
  | "industry"
  | "change1d"
  | "marketCap"
  | "relativeVolume"
  | "price"
  | "priceAvgVolume"
  | "rsClose"
  | "rsMa"
  | "approxRsRating";

type ResultColumnKey =
  | "ticker"
  | "name"
  | "sector"
  | "industry"
  | "change1d"
  | "marketCap"
  | "relativeVolume"
  | "price"
  | "priceAvgVolume"
  | "rsClose"
  | "rsMa"
  | "approxRsRating";

type TradingViewFieldOption = {
  value: string;
  label: string;
  type: string;
};

type WorkspaceTab = "scan" | "compile";

const RULE_OPERATORS: Array<{ value: ScanRuleOperator; label: string }> = [
  { value: "gt", label: ">" },
  { value: "gte", label: ">=" },
  { value: "lt", label: "<" },
  { value: "lte", label: "<=" },
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "in", label: "in" },
  { value: "not_in", label: "not in" },
];

const RESULT_COLUMNS: Array<{ key: ResultColumnKey; label: string }> = [
  { key: "ticker", label: "Ticker" },
  { key: "name", label: "Company" },
  { key: "sector", label: "Sector" },
  { key: "industry", label: "Industry" },
  { key: "change1d", label: "1D Change %" },
  { key: "marketCap", label: "Market Cap" },
  { key: "relativeVolume", label: "Relative Volume" },
  { key: "price", label: "Price" },
  { key: "priceAvgVolume", label: "Price * Avg Vol" },
  { key: "rsClose", label: "RS Line" },
  { key: "rsMa", label: "RS MA" },
  { key: "approxRsRating", label: "RS Rating" },
];

const SORT_FIELD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "ticker", label: "Ticker" },
  { value: "name", label: "Company" },
  { value: "sector", label: "Sector" },
  { value: "industry", label: "Industry" },
  { value: "change", label: "1D Change %" },
  { value: "market_cap_basic", label: "Market Cap" },
  { value: "relative_volume_10d_calc", label: "Relative Volume" },
  { value: "close", label: "Price" },
  { value: "Value.Traded", label: "Price * Avg Vol" },
  { value: "rs_close", label: "RS Line" },
  { value: "rs_ma", label: "RS MA" },
  { value: "approx_rs_rating", label: "RS Rating" },
];

const SCAN_TYPE_OPTIONS: Array<{ value: ScanPresetType; label: string }> = [
  { value: "tradingview", label: "TradingView Screener" },
  { value: "relative-strength", label: "Relative Strength" },
];

const RS_MA_TYPE_OPTIONS: RelativeStrengthMaType[] = ["EMA", "SMA"];
const RS_OUTPUT_MODE_OPTIONS: Array<{ value: RelativeStrengthOutputMode; label: string }> = [
  { value: "all", label: "All Rows" },
  { value: "rs_new_high_only", label: "RS New High Only" },
  { value: "rs_new_high_before_price_only", label: "RS New High Before Price Only" },
  { value: "both", label: "Either RS High Signal" },
];

const DEFAULT_VISIBLE_COLUMNS: ResultColumnKey[] = [
  "ticker",
  "name",
  "sector",
  "industry",
  "change1d",
  "marketCap",
  "relativeVolume",
  "price",
  "priceAvgVolume",
];
const RIGHT_ALIGNED_RESULT_COLUMNS = new Set<ResultColumnKey>([
  "change1d",
  "marketCap",
  "relativeVolume",
  "price",
  "priceAvgVolume",
  "rsClose",
  "rsMa",
  "approxRsRating",
]);
const RESULTS_COLUMNS_STORAGE_KEY = "scans-results-columns";
const DEFAULT_FIELD_SEARCH_LIMIT = 50;

const CUSTOM_FIELD_OPTION = "__custom__";
const FIELD_VALUE_MODE = "field";
const LITERAL_VALUE_MODE = "literal";
const FORM_INPUT_CLASS =
  "mt-1 w-full rounded-lg border border-borderSoft/80 bg-panelSoft/80 px-2.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60";
const FORM_SELECT_CLASS =
  "mt-1 w-full rounded-lg border border-borderSoft/80 bg-panelSoft/80 px-2.5 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60";
const SECONDARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-borderSoft/80 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800/60 disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-accent/40 bg-accent/15 px-2.5 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60";
const DANGER_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-500/40 px-2.5 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50";
const TABLE_HEAD_CLASS =
  "px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300";
const NUMERIC_CELL_CLASS = "px-3 py-3 text-right tabular-nums text-slate-300";
const TEXT_CELL_CLASS = "px-3 py-3 text-slate-300";

const FIELD_LABELS: Record<string, string> = {
  marketCap: "Market Capitalization",
  market_cap: "Market Capitalization",
  valueTraded: "Volume*Price",
  average_day_range_14: "Average Day Range (14)",
  averageDayRange14: "Average Day Range (14)",
  relative_volume_10d_calc: "Relative Volume",
};

const emptyDraftRule = (): ScanRule => ({
  id: crypto.randomUUID(),
  field: "",
  operator: "gt",
  value: "",
});

const emptyDraftPreset = (): ScanPreset => ({
  id: "",
  name: "",
  scanType: "tradingview",
  isDefault: false,
  isActive: true,
  rules: [emptyDraftRule()],
  prefilterRules: [emptyDraftRule()],
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
});

const emptyDraftCompilePreset = (): ScanCompilePresetDetail => ({
  id: "",
  name: "",
  memberCount: 0,
  presetIds: [],
  presetNames: [],
  createdAt: "",
  updatedAt: "",
  members: [],
});

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function formatDurationMs(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (value < 1000) return `${Math.max(0, Math.round(value))}ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function formatRsRefreshSummary(job: ScanRefreshJob, snapshot: ScanSnapshot | null): string {
  if (job.appliesToPreset === false) {
    return `Another RS refresh is ${job.status} for ${job.presetName}; ${job.processedCandidates}/${job.fullCandidateCount} checked for ${job.expectedTradingDate ?? "the latest session"}.`;
  }
  const runtime = job.status === "running" || job.status === "queued"
    ? `elapsed ${formatDurationMs(job.elapsedMs)}`
    : `completed in ${formatDurationMs(job.durationMs ?? job.elapsedMs)}`;
  const verified = job.status === "completed" && snapshot && snapshot.status !== "error"
    ? " Latest-session output verified."
    : "";
  const counts = [
    `${job.processedCandidates}/${job.fullCandidateCount} checked`,
    `${job.cacheHitCount ?? job.alreadyCurrentCandidateCount ?? 0} cache reused`,
    `${job.computedCount ?? job.matchedCandidates ?? 0} newly computed`,
    `${job.missingBarsCount ?? 0} missing bars`,
    `${job.insufficientHistoryCount ?? 0} insufficient history`,
    `${job.errorCount ?? 0} errors`,
  ];
  return `RS refresh ${job.status} for ${job.expectedTradingDate ?? "the latest session"} (${runtime}): ${counts.join(", ")}.${verified}${snapshot ? ` Displaying snapshot from ${formatDateTime(snapshot.generatedAt)}.` : ""}`;
}

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}

function formatPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatCompact(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function formatRatio(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function isFieldReferenceValue(value: ScanRule["value"]): value is ScanRuleFieldReference {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.type === "field";
}

function getRuleValueMode(rule: ScanRule): "literal" | "field" {
  return isFieldReferenceValue(rule.value) ? "field" : "literal";
}

function emptyFieldReferenceValue(): ScanRuleFieldReference {
  return { type: "field", field: "", multiplier: 1 };
}

function valueToInput(rule: ScanRule): string {
  if (isFieldReferenceValue(rule.value)) return "";
  return Array.isArray(rule.value) ? rule.value.join(", ") : String(rule.value ?? "");
}

function ruleFromInput(rule: ScanRule, rawValue: string): ScanRule {
  if (isFieldReferenceValue(rule.value)) return rule;
  const trimmed = rawValue.trim();
  if (rule.operator === "in" || rule.operator === "not_in") {
    return {
      ...rule,
      value: trimmed.split(",").map((value) => value.trim()).filter(Boolean),
    };
  }
  if (trimmed === "") return { ...rule, value: "" };
  if (trimmed === "-" || trimmed === "." || trimmed === "-." || trimmed.endsWith(".")) {
    return { ...rule, value: trimmed };
  }
  const parsed = Number(trimmed);
  return {
    ...rule,
    value: Number.isFinite(parsed) && !/[A-Za-z]/.test(trimmed) ? parsed : trimmed,
  };
}

function compareFieldToInput(rule: ScanRule): string {
  return isFieldReferenceValue(rule.value) ? rule.value.field : "";
}

function compareMultiplierToInput(rule: ScanRule): string {
  if (!isFieldReferenceValue(rule.value)) return "1";
  const multiplier = typeof rule.value.multiplier === "number" && Number.isFinite(rule.value.multiplier)
    ? rule.value.multiplier
    : 1;
  return String(multiplier);
}

function setRuleValueMode(rule: ScanRule, mode: "literal" | "field"): ScanRule {
  if (mode === "field") {
    return {
      ...rule,
      operator: rule.operator === "in" || rule.operator === "not_in" ? "eq" : rule.operator,
      value: isFieldReferenceValue(rule.value) ? rule.value : emptyFieldReferenceValue(),
    };
  }
  return {
    ...rule,
    value: isFieldReferenceValue(rule.value) ? "" : rule.value,
  };
}

function setRuleCompareField(rule: ScanRule, field: string): ScanRule {
  if (!isFieldReferenceValue(rule.value)) return rule;
  return { ...rule, value: { ...rule.value, field } };
}

function setRuleCompareMultiplier(rule: ScanRule, rawValue: string): ScanRule {
  if (!isFieldReferenceValue(rule.value)) return rule;
  const trimmed = rawValue.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "." || trimmed === "-." || trimmed.endsWith(".")) {
    return { ...rule, value: { ...rule.value, multiplier: 1 } };
  }
  const parsed = Number(trimmed);
  return {
    ...rule,
    value: {
      ...rule.value,
      multiplier: Number.isFinite(parsed) ? parsed : 1,
    },
  };
}

function normalizeRuleForSave(rule: ScanRule, rawCompareMultiplierInput?: string): ScanRule {
  if (!isFieldReferenceValue(rule.value)) return rule;
  const withField = setRuleCompareField(rule, rule.value.field.trim());
  return setRuleCompareMultiplier(withField, rawCompareMultiplierInput ?? compareMultiplierToInput(withField));
}

function humanizeFieldName(field: string): string {
  return field
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getFieldLabel(field: string): string {
  const trimmed = field.trim();
  return FIELD_LABELS[trimmed] ?? humanizeFieldName(trimmed || "Custom field");
}

function isSuggestedField(field: string, options: TradingViewFieldOption[]): boolean {
  return options.some((option) => option.value === field);
}

function sortRows(rows: ScanRow[], sortKey: SortKey, sortDir: "asc" | "desc"): ScanRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    const valueFor = (row: ScanRow): string | number => {
      if (sortKey === "ticker") return row.ticker;
      if (sortKey === "name") return row.name ?? row.ticker;
      if (sortKey === "sector") return row.sector ?? "";
      if (sortKey === "industry") return row.industry ?? "";
      if (sortKey === "change1d") return row.change1d ?? Number.NEGATIVE_INFINITY;
      if (sortKey === "marketCap") return row.marketCap ?? Number.NEGATIVE_INFINITY;
      if (sortKey === "relativeVolume") return row.relativeVolume ?? Number.NEGATIVE_INFINITY;
      if (sortKey === "price") return row.price ?? Number.NEGATIVE_INFINITY;
      if (sortKey === "rsClose") return row.rsClose ?? Number.NEGATIVE_INFINITY;
      if (sortKey === "rsMa") return row.rsMa ?? Number.NEGATIVE_INFINITY;
      if (sortKey === "approxRsRating") return row.approxRsRating ?? Number.NEGATIVE_INFINITY;
      return row.priceAvgVolume ?? Number.NEGATIVE_INFINITY;
    };
    const left = valueFor(a);
    const right = valueFor(b);
    if (typeof left === "string" || typeof right === "string") {
      const comparison = String(left).localeCompare(String(right));
      return sortDir === "asc" ? comparison : -comparison;
    }
    const comparison = left - right;
    return sortDir === "asc" ? comparison : -comparison;
  });
  return copy;
}

function sortKeyFromPresetField(field: string | null | undefined): SortKey {
  const normalized = String(field ?? "").trim();
  if (normalized === "ticker") return "ticker";
  if (normalized === "name") return "name";
  if (normalized === "sector") return "sector";
  if (normalized === "industry") return "industry";
  if (normalized === "market_cap_basic") return "marketCap";
  if (normalized === "relative_volume_10d_calc") return "relativeVolume";
  if (normalized === "close") return "price";
  if (normalized === "Value.Traded") return "priceAvgVolume";
  if (normalized === "rs_close") return "rsClose";
  if (normalized === "rs_ma") return "rsMa";
  if (normalized === "approx_rs_rating") return "approxRsRating";
  return "change1d";
}

function NewsList({ items }: { items: AlertNewsRow[] }) {
  if (items.length === 0) return <p className="text-xs text-slate-400">No news found for this ticker.</p>;
  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <article key={`${item.ticker}-${item.tradingDay}-${index}`} className="rounded border border-borderSoft/60 bg-panelSoft/25 p-2">
          <a href={item.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-accent hover:underline">
            {item.headline}
          </a>
          <div className="mt-1 text-[11px] text-slate-400">
            {item.source} {item.publishedAt ? ` - ${formatDateTime(item.publishedAt)}` : ""}
          </div>
          {item.snippet ? <p className="mt-1 text-xs text-slate-300">{item.snippet}</p> : null}
        </article>
      ))}
    </div>
  );
}

export function ScansPageDashboard() {
  const [presets, setPresets] = useState<ScanPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [compilePresets, setCompilePresets] = useState<ScanCompilePresetRow[]>([]);
  const [selectedCompilePresetId, setSelectedCompilePresetId] = useState<string | null>(null);
  const [draftPreset, setDraftPreset] = useState<ScanPreset>(emptyDraftPreset);
  const [draftCompilePreset, setDraftCompilePreset] = useState<ScanCompilePresetDetail>(emptyDraftCompilePreset);
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null);
  const [refreshJob, setRefreshJob] = useState<ScanRefreshJob | null>(null);
  const [compiledSnapshot, setCompiledSnapshot] = useState<CompiledScansSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [compiledLoading, setCompiledLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [compiledRefreshing, setCompiledRefreshing] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("scan");
  const [saving, setSaving] = useState(false);
  const [compiledListCollapsed, setCompiledListCollapsed] = useState(true);
  const [resultsTableCollapsed, setResultsTableCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compiledError, setCompiledError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [compiledMessage, setCompiledMessage] = useState<string | null>(null);
  const [compiledWarnings, setCompiledWarnings] = useState<string[]>([]);
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);
  const [newsByTicker, setNewsByTicker] = useState<Record<string, AlertNewsRow[]>>({});
  const [newsLoadingTicker, setNewsLoadingTicker] = useState<string | null>(null);
  const [peerTicker, setPeerTicker] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("change1d");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [visibleColumns, setVisibleColumns] = useState<ResultColumnKey[]>(DEFAULT_VISIBLE_COLUMNS);
  const [fieldOptionsByQuery, setFieldOptionsByQuery] = useState<Record<string, TradingViewFieldOption[]>>({});
  const [fieldLabelMap, setFieldLabelMap] = useState<Record<string, string>>(FIELD_LABELS);
  const [compareMultiplierInputByRule, setCompareMultiplierInputByRule] = useState<Record<string, string>>({});
  const [ruleValueInputByRule, setRuleValueInputByRule] = useState<Record<string, string>>({});
  const compilePresetDetailRequestId = useRef(0);
  const compiledSnapshotRequestId = useRef(0);
  const draftRules = draftPreset.scanType === "relative-strength" ? draftPreset.prefilterRules : draftPreset.rules;
  const updateDraftRules = (updater: (rules: ScanRule[]) => ScanRule[]) => {
    setDraftPreset((current) => (
      current.scanType === "relative-strength"
        ? { ...current, prefilterRules: updater(current.prefilterRules) }
        : { ...current, rules: updater(current.rules) }
    ));
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(RESULTS_COLUMNS_STORAGE_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as ResultColumnKey[];
      const normalized = DEFAULT_VISIBLE_COLUMNS.filter((key) => parsed.includes(key));
      if (normalized.length > 0) setVisibleColumns(normalized);
    } catch {
      // Ignore malformed saved column preferences.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(RESULTS_COLUMNS_STORAGE_KEY, JSON.stringify(visibleColumns));
  }, [visibleColumns]);

  useEffect(() => {
    setCompareMultiplierInputByRule((current) => {
      const next: Record<string, string> = {};
      for (const rule of draftRules) {
        if (current[rule.id] != null) {
          next[rule.id] = current[rule.id];
        }
      }
      return next;
    });
  }, [draftRules]);

  useEffect(() => {
    setRuleValueInputByRule((current) => {
      const next: Record<string, string> = {};
      for (const rule of draftRules) {
        if (current[rule.id] != null) {
          next[rule.id] = current[rule.id];
        }
      }
      return next;
    });
  }, [draftRules]);

  useEffect(() => {
    const queries = Array.from(new Set(["", ...draftRules.map((rule) => rule.field.trim())]));
    for (const query of queries) {
      const key = query.toLowerCase();
      if (fieldOptionsByQuery[key]) continue;
      void (async () => {
        try {
          const params = new URLSearchParams({ limit: String(DEFAULT_FIELD_SEARCH_LIMIT) });
          if (query) params.set("q", query);
          const response = await fetch(`/api/tradingview-stock-fields?${params.toString()}`);
          if (!response.ok) return;
          const payload = await response.json() as { rows?: TradingViewFieldOption[] };
          const rows = payload.rows ?? [];
          setFieldOptionsByQuery((current) => current[key] ? current : { ...current, [key]: rows });
          if (rows.length > 0) {
            setFieldLabelMap((current) => ({ ...current, ...Object.fromEntries(rows.map((row) => [row.value, row.label])) }));
          }
        } catch {
          // Keep the editor usable even if the catalog lookup fails.
        }
      })();
    }
  }, [draftRules, fieldOptionsByQuery]);

  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) ?? null,
    [presets, selectedPresetId],
  );
  const selectedCompilePreset = useMemo(
    () => compilePresets.find((preset) => preset.id === selectedCompilePresetId) ?? null,
    [compilePresets, selectedCompilePresetId],
  );

  const sortedRows = useMemo(
    () => sortRows(snapshot?.rows ?? [], sortKey, sortDir),
    [snapshot?.rows, sortDir, sortKey],
  );
  const orderedVisibleColumns = useMemo(
    () => RESULT_COLUMNS.filter((column) => visibleColumns.includes(column.key)),
    [visibleColumns],
  );
  const compiledExportUrl = useMemo(
    () => (
      selectedCompilePresetId
        ? getScanCompilePresetExportUrl(selectedCompilePresetId, new Date().toISOString().slice(0, 10))
        : null
    ),
    [selectedCompilePresetId],
  );
  const scanExportUrl = useMemo(
    () => (
      selectedPresetId
        ? getScanExportUrl(selectedPresetId, new Date().toISOString().slice(0, 10))
        : null
    ),
    [selectedPresetId],
  );

  const loadAll = async (preferredPresetId?: string | null, preferredCompilePresetId?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const [presetsRes, compilePresetsRes] = await Promise.all([
        getScanPresets(),
        getScanCompilePresets(),
      ]);
      const rows = presetsRes.rows ?? [];
      const compileRows = compilePresetsRes.rows ?? [];
      setPresets(rows);
      setCompilePresets(compileRows);
      const requestedPresetId = preferredPresetId === undefined ? selectedPresetId : preferredPresetId;
      const requestedCompilePresetId = preferredCompilePresetId === undefined ? selectedCompilePresetId : preferredCompilePresetId;
      const nextPresetId = (requestedPresetId && rows.some((row) => row.id === requestedPresetId))
        ? requestedPresetId
        : rows.find((row) => row.isDefault)?.id ?? rows[0]?.id ?? null;
      const nextCompilePresetId = (requestedCompilePresetId && compileRows.some((row) => row.id === requestedCompilePresetId))
        ? requestedCompilePresetId
        : compileRows[0]?.id ?? null;
      setSelectedPresetId(nextPresetId);
      setSelectedCompilePresetId(nextCompilePresetId);
      if (nextPresetId) {
        const nextSnapshot = await getScansSnapshot(nextPresetId);
        setSnapshot(nextSnapshot);
        try {
          const refreshResponse = await getLatestScanRefreshJob(nextPresetId);
          setRefreshJob(refreshResponse.job ?? null);
          if (refreshResponse.snapshot) setSnapshot(refreshResponse.snapshot);
        } catch {
          setRefreshJob(null);
        }
      } else {
        setSnapshot(null);
        setRefreshJob(null);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load scans.");
    } finally {
      setLoading(false);
    }
  };

  const loadCompiled = async (compilePresetId: string | null) => {
    const requestId = ++compiledSnapshotRequestId.current;
    if (!compilePresetId) {
      setCompiledSnapshot(null);
      setCompiledError(null);
      return;
    }
    setCompiledLoading(true);
    setCompiledError(null);
    try {
      const nextSnapshot = await getScanCompilePresetSnapshot(compilePresetId);
      if (compiledSnapshotRequestId.current !== requestId) return;
      setCompiledSnapshot(nextSnapshot);
    } catch (loadError) {
      if (compiledSnapshotRequestId.current !== requestId) return;
      setCompiledError(loadError instanceof Error ? loadError.message : "Failed to load compiled scan preset.");
      setCompiledSnapshot(null);
    } finally {
      if (compiledSnapshotRequestId.current !== requestId) return;
      setCompiledLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (selectedPreset) setDraftPreset(structuredClone(selectedPreset));
    else setDraftPreset(emptyDraftPreset());
  }, [selectedPreset]);

  useEffect(() => {
    if (!selectedCompilePresetId) {
      compilePresetDetailRequestId.current += 1;
      setDraftCompilePreset(emptyDraftCompilePreset());
      setCompiledError(null);
      return;
    }
    const requestId = ++compilePresetDetailRequestId.current;
    void (async () => {
      try {
        const detail = await getScanCompilePreset(selectedCompilePresetId);
        if (compilePresetDetailRequestId.current !== requestId) return;
        setCompiledError(null);
        setDraftCompilePreset(detail);
      } catch (loadError) {
        if (compilePresetDetailRequestId.current !== requestId) return;
        setCompiledError(loadError instanceof Error ? loadError.message : "Failed to load compile preset.");
        setDraftCompilePreset(emptyDraftCompilePreset());
      }
    })();
  }, [selectedCompilePresetId]);

  useEffect(() => {
    setCompiledMessage(null);
    setCompiledWarnings([]);
  }, [selectedCompilePresetId]);

  useEffect(() => {
    if (!selectedPreset) return;
    setSortKey(sortKeyFromPresetField(selectedPreset.sortField));
    setSortDir(selectedPreset.sortDirection === "asc" ? "asc" : "desc");
  }, [selectedPreset]);

  useEffect(() => {
    if (!selectedPresetId || loading) return;
    void (async () => {
      try {
        const nextSnapshot = await getScansSnapshot(selectedPresetId);
        setSnapshot(nextSnapshot);
        try {
          const refreshResponse = await getLatestScanRefreshJob(selectedPresetId);
          setRefreshJob(refreshResponse.job ?? null);
          if (refreshResponse.snapshot) setSnapshot(refreshResponse.snapshot);
        } catch {
          setRefreshJob(null);
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Failed to load scan snapshot.");
      }
    })();
  }, [loading, selectedPresetId]);

  useEffect(() => {
    if (!refreshJob || (refreshJob.status !== "queued" && refreshJob.status !== "running")) return;
    if (!selectedPresetId) return;
    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await getLatestScanRefreshJob(selectedPresetId);
          setRefreshJob(response.job ?? null);
          if (response.snapshot) setSnapshot(response.snapshot);
          if (response.job?.status === "completed" && selectedCompilePreset?.presetIds.includes(response.job.presetId)) {
            await loadCompiled(selectedCompilePresetId);
          }
        } catch {
          // Keep the current snapshot visible while the background refresh continues.
        }
      })();
    }, 2000);
    return () => window.clearTimeout(timeoutId);
  }, [loadCompiled, refreshJob, selectedCompilePreset, selectedCompilePresetId, selectedPresetId]);

  useEffect(() => {
    void loadCompiled(selectedCompilePresetId);
  }, [selectedCompilePresetId]);

  const loadTickerNews = async (ticker: string) => {
    if (newsByTicker[ticker]) return;
    setNewsLoadingTicker(ticker);
    try {
      const payload = await getTickerNews(ticker, null, 5);
      setNewsByTicker((current) => ({ ...current, [ticker]: payload.rows ?? [] }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load ticker news.");
    } finally {
      setNewsLoadingTicker((current) => (current === ticker ? null : current));
    }
  };

  const onToggleRow = (ticker: string) => {
    setExpandedTicker((current) => {
      const next = current === ticker ? null : ticker;
      if (next) void loadTickerNews(next);
      return next;
    });
  };

  const onSavePreset = async () => {
    const trimmedName = draftPreset.name.trim();
    const activeRules = draftRules
      .filter((rule) => rule.field.trim())
      .map((rule) => normalizeRuleForSave(rule, compareMultiplierInputByRule[rule.id]));
    if (!trimmedName) {
      setError("Preset name is required.");
      setMessage(null);
      return;
    }
    if (activeRules.length === 0) {
      setError(draftPreset.scanType === "relative-strength"
        ? "Add at least one prefilter rule before saving."
        : "Add at least one scan rule before saving.");
      setMessage(null);
      return;
    }
    const incompleteFieldRule = activeRules.find((rule) => isFieldReferenceValue(rule.value) && !rule.value.field.trim());
    if (incompleteFieldRule) {
      setError(`Rule "${getFieldLabel(incompleteFieldRule.field)}" needs a comparison field.`);
      setMessage(null);
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload = {
        name: trimmedName,
        scanType: draftPreset.scanType,
        isDefault: draftPreset.isDefault,
        isActive: draftPreset.isActive,
        rules: draftPreset.scanType === "relative-strength" ? [] : activeRules,
        prefilterRules: draftPreset.scanType === "relative-strength" ? activeRules : draftPreset.prefilterRules,
        benchmarkTicker: draftPreset.scanType === "relative-strength"
          ? (draftPreset.benchmarkTicker?.trim() || "SPY")
          : undefined,
        verticalOffset: draftPreset.verticalOffset,
        rsMaLength: draftPreset.rsMaLength,
        rsMaType: draftPreset.rsMaType,
        newHighLookback: draftPreset.newHighLookback,
        outputMode: draftPreset.outputMode,
        sortField: draftPreset.sortField.trim() || "change",
        sortDirection: draftPreset.sortDirection,
        rowLimit: draftPreset.rowLimit,
      };
      const response = draftPreset.id
        ? await updateScanPreset(draftPreset.id, payload)
        : await createScanPreset(payload);
      await loadAll(response.preset.id);
      setMessage("Preset saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save preset.");
    } finally {
      setSaving(false);
    }
  };

  const onDeletePreset = async () => {
    if (!draftPreset.id) {
      setDraftPreset(emptyDraftPreset());
      return;
    }
    try {
      setError(null);
      setMessage(null);
      await deleteScanPreset(draftPreset.id);
      await loadAll(null);
      setDraftPreset(emptyDraftPreset());
      setMessage("Preset deleted.");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete preset.");
    }
  };

  const onDuplicatePreset = async (presetId: string) => {
    try {
      setError(null);
      setMessage(null);
      const response = await duplicateScanPreset(presetId);
      await loadAll(response.preset.id, selectedCompilePresetId);
      setMessage(`Duplicated ${response.preset.name}.`);
    } catch (duplicateError) {
      setError(duplicateError instanceof Error ? duplicateError.message : "Failed to duplicate preset.");
    }
  };

  const onSaveCompilePreset = async () => {
    const trimmedName = draftCompilePreset.name.trim();
    const scanPresetIds = draftCompilePreset.members.map((member) => member.scanPresetId);
    if (!trimmedName) {
      setCompiledError("Compile preset name is required.");
      setMessage(null);
      return;
    }
    if (scanPresetIds.length === 0) {
      setCompiledError("Choose at least one saved scan preset.");
      setMessage(null);
      return;
    }
    setSaving(true);
    setCompiledError(null);
    setMessage(null);
    try {
      const payload = { name: trimmedName, scanPresetIds };
      const response = draftCompilePreset.id
        ? await updateScanCompilePreset(draftCompilePreset.id, payload)
        : await createScanCompilePreset(payload);
      await loadAll(selectedPresetId, response.preset.id);
      setMessage("Compile preset saved.");
    } catch (saveError) {
      setCompiledError(saveError instanceof Error ? saveError.message : "Failed to save compile preset.");
    } finally {
      setSaving(false);
    }
  };

  const onDeleteCompilePreset = async () => {
    if (!draftCompilePreset.id) {
      setDraftCompilePreset(emptyDraftCompilePreset());
      return;
    }
    try {
      setCompiledError(null);
      setMessage(null);
      await deleteScanCompilePreset(draftCompilePreset.id);
      await loadAll(selectedPresetId, null);
      setDraftCompilePreset(emptyDraftCompilePreset());
      setMessage("Compile preset deleted.");
    } catch (deleteError) {
      setCompiledError(deleteError instanceof Error ? deleteError.message : "Failed to delete compile preset.");
    }
  };

  const onRefresh = async () => {
    if (!selectedPresetId) return;
    setRefreshing(true);
    setError(null);
    setMessage(null);
    try {
      const response = await refreshScansSnapshot(selectedPresetId);
      if (response.snapshot) setSnapshot(response.snapshot);
      setRefreshJob(response.job ?? null);
      if (!response.async && selectedCompilePreset?.presetIds.includes(selectedPresetId)) {
        await loadCompiled(selectedCompilePresetId);
      }
      setExpandedTicker(null);
      setNewsByTicker({});
      if (response.async && response.job) {
        setMessage(
          `Started RS refresh for ${response.job.expectedTradingDate ?? "the latest session"}: ${response.job.processedCandidates}/${response.job.fullCandidateCount} checked, ${response.job.cacheHitCount ?? 0} cache reused, ${response.job.computedCount ?? 0} newly computed.`,
        );
      } else if (response.snapshot) {
        setMessage(
          response.snapshot.matchedRowCount > response.snapshot.rowCount
            ? `Refreshed ${response.snapshot.rowCount} displayed rows from ${response.snapshot.matchedRowCount} matched rows.`
            : `Refreshed ${response.snapshot.rowCount} rows.`,
        );
      } else {
        setMessage("Refresh started.");
      }
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to refresh scans.");
    } finally {
      setRefreshing(false);
    }
  };

  const onRefreshCompiledPreset = async () => {
    if (!selectedCompilePresetId) return;
    setCompiledRefreshing(true);
    setCompiledError(null);
    setCompiledMessage(null);
    setCompiledWarnings([]);
    try {
      const response = await refreshScanCompilePreset(selectedCompilePresetId);
      setCompiledSnapshot(response.snapshot);
      const selectedMember = selectedPresetId
        ? response.memberResults.find((result) => result.presetId === selectedPresetId)
        : null;
      if (selectedMember?.snapshot ?? selectedMember?.usableSnapshot) {
        setSnapshot(selectedMember.snapshot ?? selectedMember.usableSnapshot ?? null);
      }
      setExpandedTicker(null);
      setNewsByTicker({});
      setCompiledWarnings(
        response.memberResults
          .filter((result) => result.status === "error")
          .map((result) => {
            const fallbackNote = result.usedFallback
              ? ` Using the previous usable snapshot with ${result.usableSnapshot?.rowCount ?? 0} rows.`
              : " No usable prior snapshot was available.";
            return `${result.presetName}: ${result.error ?? "Refresh failed."}${fallbackNote}`;
          }),
      );
      const memberLabel = response.refreshedCount === 1 ? "member scan" : "member scans";
      setCompiledMessage(`Refreshed ${response.refreshedCount} ${memberLabel}; ${response.failedCount} failed.`);
    } catch (refreshError) {
      setCompiledError(refreshError instanceof Error ? refreshError.message : "Failed to refresh compiled scan preset.");
    } finally {
      setCompiledRefreshing(false);
    }
  };

  const onSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "ticker" || key === "name" || key === "sector" || key === "industry" ? "asc" : "desc");
  };

  const toggleColumn = (key: ResultColumnKey) => {
    setVisibleColumns((current) => {
      if (current.includes(key)) {
        if (current.length === 1) return current;
        return current.filter((column) => column !== key);
      }
      return DEFAULT_VISIBLE_COLUMNS.filter((column) => current.includes(column) || column === key);
    });
  };

  const toggleCompilePresetMember = (scanPresetId: string) => {
    setDraftCompilePreset((current) => {
      const existing = current.members.find((member) => member.scanPresetId === scanPresetId);
      if (existing) {
        const members = current.members
          .filter((member) => member.scanPresetId !== scanPresetId)
          .map((member, index) => ({ ...member, sortOrder: index + 1 }));
        return {
          ...current,
          members,
          memberCount: members.length,
          presetIds: members.map((member) => member.scanPresetId),
          presetNames: members.map((member) => member.scanPresetName),
        };
      }
      const preset = presets.find((row) => row.id === scanPresetId);
      if (!preset) return current;
      const members = [
        ...current.members,
        {
          scanPresetId: preset.id,
          scanPresetName: preset.name,
          sortOrder: current.members.length + 1,
        },
      ];
      return {
        ...current,
        members,
        memberCount: members.length,
        presetIds: members.map((member) => member.scanPresetId),
        presetNames: members.map((member) => member.scanPresetName),
      };
    });
  };

  const renderCell = (row: ScanRow, key: ResultColumnKey) => {
    if (key === "ticker") {
      return (
        <td className="px-3 py-3 font-semibold text-accent">
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="rounded text-left hover:underline focus:outline-none focus:ring-2 focus:ring-accent/30"
              onClick={(event) => {
                event.stopPropagation();
                setPeerTicker(row.ticker);
              }}
            >
              {row.ticker}
            </button>
            {row.rsNewHigh ? (
              <span className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-emerald-200">
                RS High
              </span>
            ) : null}
            {row.rsNewHighBeforePrice ? (
              <span className="rounded-full border border-fuchsia-400/40 bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-fuchsia-200">
                RS Lead
              </span>
            ) : null}
          </div>
        </td>
      );
    }
    if (key === "name") return <td className="max-w-56 truncate px-3 py-3 text-slate-300">{row.name ?? row.ticker}</td>;
    if (key === "sector") return <td className={TEXT_CELL_CLASS}>{row.sector ?? "-"}</td>;
    if (key === "industry") return <td className={TEXT_CELL_CLASS}>{row.industry ?? "-"}</td>;
    if (key === "change1d") {
      return <td className={`px-3 py-3 text-right tabular-nums ${(row.change1d ?? 0) >= 0 ? "text-pos" : "text-neg"}`}>{formatPct(row.change1d)}</td>;
    }
    if (key === "marketCap") return <td className={NUMERIC_CELL_CLASS}>{formatCompact(row.marketCap)}</td>;
    if (key === "relativeVolume") return <td className={NUMERIC_CELL_CLASS}>{formatRatio(row.relativeVolume)}</td>;
    if (key === "price") return <td className={NUMERIC_CELL_CLASS}>{formatNumber(row.price)}</td>;
    if (key === "rsClose") return <td className={NUMERIC_CELL_CLASS}>{formatNumber(row.rsClose)}</td>;
    if (key === "rsMa") return <td className={NUMERIC_CELL_CLASS}>{formatNumber(row.rsMa)}</td>;
    if (key === "approxRsRating") return <td className={NUMERIC_CELL_CLASS}>{formatNumber(row.approxRsRating, 0)}</td>;
    return <td className={NUMERIC_CELL_CLASS}>{formatCompact(row.priceAvgVolume)}</td>;
  };

  if (loading) {
    return (
      <div className="card flex items-center gap-2 p-4 text-sm text-slate-300">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading scans...
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr),26rem]">
      <section className="min-w-0 space-y-4">
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="card p-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Active Scan</div>
                <h3 className="mt-1 truncate text-lg font-semibold text-slate-100">
                  {snapshot?.presetName ?? selectedPreset?.name ?? "Scans"}
                </h3>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${snapshot?.status === "error" ? "bg-red-500/15 text-red-300" : snapshot?.status === "warning" ? "bg-yellow-500/15 text-yellow-200" : "bg-slate-800/60 text-slate-300"}`}>
                  {snapshot?.status ?? "empty"}
                </span>
                {refreshJob ? (
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${refreshJob.status === "failed" ? "bg-red-500/15 text-red-300" : refreshJob.status === "completed" ? "bg-emerald-500/15 text-emerald-300" : "bg-accent/15 text-accent"}`}>
                    {refreshJob.status}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Rows</div>
                <div className="mt-1 text-sm font-semibold text-slate-200">
                  {snapshot ? `${snapshot.rowCount}${snapshot.matchedRowCount > snapshot.rowCount ? ` / ${snapshot.matchedRowCount}` : ""}` : "-"}
                </div>
              </div>
              <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Updated</div>
                <div className="mt-1 text-sm font-semibold text-slate-200">{formatDateTime(snapshot?.generatedAt)}</div>
              </div>
              <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Source</div>
                <div className="mt-1 truncate text-sm font-semibold text-slate-200">{snapshot?.providerLabel ?? "TradingView Screener (Python)"}</div>
              </div>
            </div>

            {refreshJob ? <p className="mt-3 text-xs leading-5 text-slate-400">{formatRsRefreshSummary(refreshJob, snapshot)}</p> : null}
            {message && <p className="mt-3 rounded-lg border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-xs text-slate-300">{message}</p>}
            {error && <p className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {scanExportUrl && (
                <a className={SECONDARY_BUTTON_CLASS} href={scanExportUrl} target="_blank" rel="noreferrer">
                  Export TXT
                </a>
              )}
              <button className={PRIMARY_BUTTON_CLASS} disabled={!selectedPresetId || refreshing} onClick={() => void onRefresh()}>
                <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
                {refreshing ? "Refreshing..." : "Refresh Scan"}
              </button>
            </div>
          </div>

          <div className="card p-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Compiled Watchlist</div>
                <h3 className="mt-1 truncate text-lg font-semibold text-slate-100">
                  {selectedCompilePreset?.name ?? "Compiled Unique Tickers"}
                </h3>
              </div>
              <div className="rounded-full bg-slate-800/60 px-2.5 py-1 text-xs font-medium text-slate-300">
                {compiledSnapshot?.rows.length ?? 0} unique
              </div>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Members</div>
                <div className="mt-1 text-sm font-semibold text-slate-200">{selectedCompilePreset?.memberCount ?? draftCompilePreset.members.length}</div>
              </div>
              <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Updated</div>
                <div className="mt-1 text-sm font-semibold text-slate-200">{formatDateTime(compiledSnapshot?.generatedAt)}</div>
              </div>
              <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Rows</div>
                <div className="mt-1 text-sm font-semibold text-slate-200">{compiledSnapshot?.rows.length ?? "-"}</div>
              </div>
            </div>

            <p className="mt-3 text-xs leading-5 text-slate-400">
              {selectedCompilePreset
                ? `${selectedCompilePreset.memberCount} scan preset${selectedCompilePreset.memberCount === 1 ? "" : "s"} in ${selectedCompilePreset.name}`
                : "Select a saved compile preset to load a combined watchlist."}
            </p>
            {compiledMessage && <p className="mt-3 rounded-lg border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-xs text-slate-300">{compiledMessage}</p>}
            {compiledWarnings.length > 0 && (
              <div className="mt-3 space-y-1 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
                {compiledWarnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            )}
            {compiledError && <p className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{compiledError}</p>}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                className={PRIMARY_BUTTON_CLASS}
                disabled={!selectedCompilePresetId || draftCompilePreset.members.length === 0 || compiledRefreshing}
                onClick={() => void onRefreshCompiledPreset()}
              >
                <RefreshCw className={`h-4 w-4 ${compiledRefreshing ? "animate-spin" : ""}`} />
                {compiledRefreshing ? "Refreshing..." : "Refresh Compiled"}
              </button>
              {compiledExportUrl && (
                <a className={SECONDARY_BUTTON_CLASS} href={compiledExportUrl} target="_blank" rel="noreferrer">
                  Export TXT
                </a>
              )}
              <button
                className={SECONDARY_BUTTON_CLASS}
                disabled={(compiledSnapshot?.rows.length ?? 0) === 0}
                onClick={async () => {
                  await navigator.clipboard.writeText((compiledSnapshot?.rows ?? []).map((row) => row.ticker).join("\n"));
                  setCompiledMessage("Compiled tickers copied.");
                }}
              >
                <Copy className="h-4 w-4" />
                Copy Tickers
              </button>
            </div>
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-borderSoft/70 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Table2 className="h-4 w-4 text-accent" />
                  <h3 className="text-sm font-semibold text-slate-100">Scan Results</h3>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  {snapshot
                    ? `${snapshot.rowCount} row${snapshot.rowCount === 1 ? "" : "s"}${snapshot.matchedRowCount > snapshot.rowCount ? ` of ${snapshot.matchedRowCount} matched` : ""}`
                    : "No scan snapshot loaded yet."}
                </p>
              </div>
              <button className={SECONDARY_BUTTON_CLASS} onClick={() => setResultsTableCollapsed((current) => !current)}>
                {resultsTableCollapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
                {resultsTableCollapsed ? "Expand" : "Collapse"}
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                <Columns3 className="h-3.5 w-3.5" />
                Columns
              </span>
              {RESULT_COLUMNS.map((column) => {
                const checked = visibleColumns.includes(column.key);
                return (
                  <label
                    key={column.key}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${checked ? "border-accent/40 bg-accent/10 text-accent" : "border-borderSoft/70 text-slate-400 hover:bg-slate-800/40"}`}
                  >
                    <input
                      className="h-3 w-3 accent-sky-400"
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleColumn(column.key)}
                      disabled={visibleColumns.length === 1 && checked}
                    />
                    {column.label}
                  </label>
                );
              })}
            </div>
          </div>
          {resultsTableCollapsed ? (
            <div className="px-4 py-8 text-center text-sm text-slate-400">Scan result rows are hidden.</div>
          ) : (
            <div className="max-h-[70vh] overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="sticky top-0 z-10 bg-slate-900/90 backdrop-blur">
                  <tr>
                    {orderedVisibleColumns.map((column) => {
                      const rightAligned = RIGHT_ALIGNED_RESULT_COLUMNS.has(column.key);
                      const active = sortKey === column.key;
                      return (
                        <th key={column.key} className={`${TABLE_HEAD_CLASS} ${rightAligned ? "text-right" : "text-left"}`}>
                          <button
                            className={`inline-flex w-full items-center gap-1 ${rightAligned ? "justify-end text-right" : "justify-start text-left"} hover:text-slate-100`}
                            onClick={() => onSort(column.key as SortKey)}
                          >
                            {column.label}
                            {active ? (
                              sortDir === "asc" ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <span className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => {
                    const isOpen = expandedTicker === row.ticker;
                    const news = newsByTicker[row.ticker] ?? [];
                    return (
                      <Fragment key={row.ticker}>
                        <tr
                          className={`cursor-pointer border-t border-borderSoft/80 transition-colors ${isOpen ? "bg-panelSoft/25" : "hover:bg-slate-900/30"}`}
                          onClick={() => onToggleRow(row.ticker)}
                        >
                          {orderedVisibleColumns.map((column) => (
                            <Fragment key={column.key}>{renderCell(row, column.key)}</Fragment>
                          ))}
                        </tr>
                        {isOpen && (
                          <tr className="border-t border-borderSoft/60 bg-panel/50">
                            <td colSpan={Math.max(orderedVisibleColumns.length, 1)} className="px-3 py-3">
                              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr),minmax(24rem,1fr)]">
                                <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/70 p-3">
                                  <h4 className="mb-2 text-sm font-semibold text-slate-100">Latest News</h4>
                                  {newsLoadingTicker === row.ticker ? (
                                    <div className="flex items-center gap-2 text-xs text-slate-400">
                                      <Loader2 className="h-4 w-4 animate-spin" />
                                      Loading news...
                                    </div>
                                  ) : (
                                    <NewsList items={news} />
                                  )}
                                </div>
                                <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/70 p-3">
                                  <h4 className="mb-2 text-sm font-semibold text-slate-100">Chart</h4>
                                  <TradingViewWidget ticker={row.ticker} compact chartOnly showStatusLine initialRange="3M" />
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {sortedRows.length === 0 && (
                    <tr>
                      <td colSpan={Math.max(orderedVisibleColumns.length, 1)} className="px-3 py-12 text-center text-sm text-slate-400">
                        <div className="mx-auto flex max-w-sm flex-col items-center gap-2">
                          <Table2 className="h-5 w-5 text-slate-500" />
                          <span>No scan rows are available yet. Save a preset and run a refresh to populate this table.</span>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-borderSoft/70 px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Compiled Unique List</h3>
              <p className="mt-1 text-xs text-slate-400">{compiledSnapshot?.rows.length ?? 0} unique ticker{(compiledSnapshot?.rows.length ?? 0) === 1 ? "" : "s"}</p>
            </div>
            <button className={SECONDARY_BUTTON_CLASS} onClick={() => setCompiledListCollapsed((current) => !current)}>
              {compiledListCollapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
              {compiledListCollapsed ? "Expand" : "Collapse"}
            </button>
          </div>
          {compiledListCollapsed ? (
            <div className="px-4 py-8 text-center text-sm text-slate-400">Compiled unique ticker rows are hidden.</div>
          ) : compiledLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-slate-300">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading compiled scan preset...
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-900/80">
                  <tr>
                    {["Ticker", "Company", "Hits", "1D Change %", "Price", "Preset Matches"].map((label, index) => (
                      <th key={label} className={`${TABLE_HEAD_CLASS} ${index >= 2 && index <= 4 ? "text-right" : "text-left"}`}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(compiledSnapshot?.rows ?? []).map((row) => (
                    <tr key={row.ticker} className="border-t border-borderSoft/80 transition-colors hover:bg-slate-900/30">
                      <td className="px-3 py-3 font-semibold text-accent">{row.ticker}</td>
                      <td className="max-w-56 truncate px-3 py-3 text-slate-300">{row.name ?? row.ticker}</td>
                      <td className={NUMERIC_CELL_CLASS}>{row.occurrences}</td>
                      <td className={`px-3 py-3 text-right tabular-nums ${(row.latestChange1d ?? 0) >= 0 ? "text-pos" : "text-neg"}`}>{formatPct(row.latestChange1d)}</td>
                      <td className={NUMERIC_CELL_CLASS}>{formatNumber(row.latestPrice)}</td>
                      <td className="px-3 py-3 text-slate-300">{row.presetNames.join(", ") || "-"}</td>
                    </tr>
                  ))}
                  {(compiledSnapshot?.rows.length ?? 0) === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-10 text-center text-sm text-slate-400">
                        {selectedCompilePresetId
                          ? "No compiled tickers are available yet for the selected compile preset."
                          : "Choose a saved compile preset to build a combined watchlist."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">
        <div className="card overflow-hidden">
          <div className="border-b border-borderSoft/70 p-2">
            <div className="grid grid-cols-2 gap-1 rounded-xl border border-borderSoft/70 bg-panelSoft/35 p-1">
              <button
                type="button"
                className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${workspaceTab === "scan" ? "bg-accent/20 text-accent" : "text-slate-300 hover:bg-panelSoft/60"}`}
                onClick={() => setWorkspaceTab("scan")}
              >
                <Settings2 className="h-4 w-4" />
                Scan Presets
              </button>
              <button
                type="button"
                className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${workspaceTab === "compile" ? "bg-accent/20 text-accent" : "text-slate-300 hover:bg-panelSoft/60"}`}
                onClick={() => setWorkspaceTab("compile")}
              >
                <Columns3 className="h-4 w-4" />
                Compile
              </button>
            </div>
          </div>

          {workspaceTab === "scan" ? (
            <>
              <div className="border-b border-borderSoft/70 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">Scan Presets</h3>
                    <p className="text-xs text-slate-500">{presets.length} saved</p>
                  </div>
                  <button
                    className={SECONDARY_BUTTON_CLASS}
                    type="button"
                    onClick={() => {
                      setSelectedPresetId(null);
                      setDraftPreset(emptyDraftPreset());
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New
                  </button>
                </div>
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {presets.map((preset) => (
                    <div
                      key={preset.id}
                      className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${preset.id === selectedPresetId ? "border-accent/60 bg-accent/10 shadow-[0_0_0_1px_rgba(56,189,248,0.12)]" : "border-borderSoft/60 bg-panelSoft/20 hover:bg-slate-900/30"}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedPresetId(preset.id)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        setSelectedPresetId(preset.id);
                      }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-accent">{preset.name}</div>
                          <div className="mt-1 text-[11px] text-slate-400">
                            {(preset.scanType === "relative-strength" ? preset.prefilterRules.length : preset.rules.length)} {preset.scanType === "relative-strength" ? "prefilter" : "rule"}{(preset.scanType === "relative-strength" ? preset.prefilterRules.length : preset.rules.length) === 1 ? "" : "s"} / {preset.rowLimit} rows
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {preset.scanType === "relative-strength" ? "Relative Strength" : "TradingView"} / {preset.isDefault ? "Default" : "Preset"} / {preset.isActive ? "Active" : "Inactive"}
                          </div>
                        </div>
                        <button
                          className={SECONDARY_BUTTON_CLASS}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void onDuplicatePreset(preset.id);
                          }}
                        >
                          <Copy className="h-3.5 w-3.5" />
                          Duplicate
                        </button>
                      </div>
                    </div>
                  ))}
                  {presets.length === 0 && <p className="rounded-xl border border-borderSoft/70 bg-panelSoft/25 px-3 py-4 text-center text-xs text-slate-400">No scan presets saved yet.</p>}
                </div>
              </div>

              <div className="p-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">{draftPreset.id ? "Edit Preset" : "Create Preset"}</h3>
                    <p className="text-xs text-slate-500">{draftPreset.scanType === "relative-strength" ? "Relative Strength" : "TradingView Screener"}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button className={PRIMARY_BUTTON_CLASS} disabled={saving} onClick={() => void onSavePreset()}>
                      <Save className="h-3.5 w-3.5" />
                      {saving ? "Saving..." : "Save"}
                    </button>
                    <button className={DANGER_BUTTON_CLASS} disabled={!draftPreset.id || draftPreset.isDefault} onClick={() => void onDeletePreset()}>
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </button>
                  </div>
                </div>

                <div className="space-y-4 text-xs text-slate-300">
                  <label className="block">
                    Name
                    <input className={FORM_INPUT_CLASS} value={draftPreset.name} onChange={(event) => setDraftPreset((current) => ({ ...current, name: event.target.value }))} />
                  </label>

                  <label className="block">
                    Preset Type
                    <select
                      className={FORM_SELECT_CLASS}
                      value={draftPreset.scanType}
                      onChange={(event) => setDraftPreset((current) => ({
                        ...current,
                        scanType: event.target.value as ScanPresetType,
                        sortField: event.target.value === "relative-strength" && current.sortField === "change" ? "rs_close" : current.sortField,
                      }))}
                    >
                      {SCAN_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>

                  <div className="grid gap-2 md:grid-cols-2">
                    <label className="block">
                      Sort Field
                      <select className={FORM_SELECT_CLASS} value={draftPreset.sortField} onChange={(event) => setDraftPreset((current) => ({ ...current, sortField: event.target.value }))}>
                        {SORT_FIELD_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      Sort Direction
                      <select className={FORM_SELECT_CLASS} value={draftPreset.sortDirection} onChange={(event) => setDraftPreset((current) => ({ ...current, sortDirection: event.target.value === "asc" ? "asc" : "desc" }))}>
                        <option value="desc">Descending</option>
                        <option value="asc">Ascending</option>
                      </select>
                    </label>
                  </div>

                  <div className="grid gap-2 md:grid-cols-2">
                    <label className="block">
                      Row Limit
                      <input className={FORM_INPUT_CLASS} type="number" min={1} max={250} value={draftPreset.rowLimit} onChange={(event) => setDraftPreset((current) => ({ ...current, rowLimit: Math.max(1, Math.min(250, Number(event.target.value) || 100)) }))} />
                    </label>
                    <label className="block">
                      Benchmark
                      <input className={FORM_INPUT_CLASS} value={draftPreset.benchmarkTicker ?? "SPY"} disabled={draftPreset.scanType !== "relative-strength"} onChange={(event) => setDraftPreset((current) => ({ ...current, benchmarkTicker: event.target.value.toUpperCase() }))} />
                    </label>
                  </div>

                  {draftPreset.scanType === "relative-strength" ? (
                    <>
                      <div className="grid gap-2 md:grid-cols-2">
                        <label className="block">
                          RS MA Length
                          <input className={FORM_INPUT_CLASS} type="number" min={1} max={250} value={draftPreset.rsMaLength} onChange={(event) => setDraftPreset((current) => ({ ...current, rsMaLength: Math.max(1, Math.min(250, Number(event.target.value) || 21)) }))} />
                        </label>
                        <label className="block">
                          RS MA Type
                          <select className={FORM_SELECT_CLASS} value={draftPreset.rsMaType} onChange={(event) => setDraftPreset((current) => ({ ...current, rsMaType: event.target.value as RelativeStrengthMaType }))}>
                            {RS_MA_TYPE_OPTIONS.map((option) => (
                              <option key={option} value={option}>{option}</option>
                            ))}
                          </select>
                        </label>
                        <label className="block">
                          New High Lookback
                          <input className={FORM_INPUT_CLASS} type="number" min={1} max={520} value={draftPreset.newHighLookback} onChange={(event) => setDraftPreset((current) => ({ ...current, newHighLookback: Math.max(1, Math.min(520, Number(event.target.value) || 252)) }))} />
                        </label>
                        <label className="block">
                          Vertical Offset
                          <input className={FORM_INPUT_CLASS} type="number" min={0.25} step={0.25} max={500} value={draftPreset.verticalOffset} onChange={(event) => setDraftPreset((current) => ({ ...current, verticalOffset: Math.max(0.25, Math.min(500, Number(event.target.value) || 30)) }))} />
                        </label>
                      </div>
                      <label className="block">
                        Output Filter
                        <select className={FORM_SELECT_CLASS} value={draftPreset.outputMode} onChange={(event) => setDraftPreset((current) => ({ ...current, outputMode: event.target.value as RelativeStrengthOutputMode }))}>
                          {RS_OUTPUT_MODE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                    </>
                  ) : null}

                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="flex items-center gap-2 rounded-lg border border-borderSoft/70 bg-panelSoft/25 px-3 py-2 text-sm">
                      <input type="checkbox" checked={draftPreset.isDefault} onChange={(event) => setDraftPreset((current) => ({ ...current, isDefault: event.target.checked }))} />
                      Default preset
                    </label>
                    <label className="flex items-center gap-2 rounded-lg border border-borderSoft/70 bg-panelSoft/25 px-3 py-2 text-sm">
                      <input type="checkbox" checked={draftPreset.isActive} onChange={(event) => setDraftPreset((current) => ({ ...current, isActive: event.target.checked }))} />
                      Active
                    </label>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
                        {draftPreset.scanType === "relative-strength" ? "Prefilter Rules" : "Rules"}
                      </h4>
                      <button className={SECONDARY_BUTTON_CLASS} type="button" onClick={() => updateDraftRules((rules) => [...rules, emptyDraftRule()])}>
                        <Plus className="h-3.5 w-3.5" />
                        Add Rule
                      </button>
                    </div>
                    {draftRules.map((rule) => {
                      const fieldQuery = rule.field.trim().toLowerCase();
                      const fieldOptions = fieldOptionsByQuery[fieldQuery] ?? fieldOptionsByQuery[""] ?? [];
                      const selectedFieldLabel = fieldLabelMap[rule.field.trim()] ?? getFieldLabel(rule.field);
                      const compareField = compareFieldToInput(rule);
                      const compareFieldQuery = compareField.trim().toLowerCase();
                      const compareFieldOptions = fieldOptionsByQuery[compareFieldQuery] ?? fieldOptionsByQuery[""] ?? [];
                      const selectedCompareFieldLabel = fieldLabelMap[compareField.trim()] ?? getFieldLabel(compareField);
                      const valueMode = getRuleValueMode(rule);
                      const operatorOptions = valueMode === FIELD_VALUE_MODE
                        ? RULE_OPERATORS.filter((option) => option.value !== "in" && option.value !== "not_in")
                        : RULE_OPERATORS;
                      const compareMultiplierInput = compareMultiplierInputByRule[rule.id] ?? compareMultiplierToInput(rule);
                      const rawRuleValueInput = ruleValueInputByRule[rule.id] ?? valueToInput(rule);
                      return (
                        <div key={rule.id} className="rounded-xl border border-borderSoft/70 bg-panelSoft/30 p-3">
                          <div className="mb-2 grid gap-2 md:grid-cols-[minmax(0,1.2fr),minmax(0,1fr),7rem]">
                            <label className="block">
                              Field
                              <select
                                className={FORM_SELECT_CLASS}
                                value={isSuggestedField(rule.field, fieldOptions) ? rule.field : CUSTOM_FIELD_OPTION}
                                onChange={(event) => updateDraftRules((rules) => rules.map((row) => {
                                  if (row.id !== rule.id) return row;
                                  return { ...row, field: event.target.value === CUSTOM_FIELD_OPTION ? "" : event.target.value };
                                }))}
                              >
                                {fieldOptions.map((field) => (
                                  <option key={field.value} value={field.value}>{field.label}</option>
                                ))}
                                {!isSuggestedField(rule.field, fieldOptions) && rule.field.trim() ? (
                                  <option value={CUSTOM_FIELD_OPTION}>Custom field ({selectedFieldLabel})</option>
                                ) : null}
                                <option value={CUSTOM_FIELD_OPTION}>Custom field...</option>
                              </select>
                            </label>
                            <label className="block">
                              <span className="sr-only">Field ID</span>
                              <input className={FORM_INPUT_CLASS} value={rule.field} onChange={(event) => updateDraftRules((rules) => rules.map((row) => row.id === rule.id ? { ...row, field: event.target.value } : row))} placeholder="Field ID" />
                            </label>
                            <label className="block">
                              Operator
                              <select
                                className={FORM_SELECT_CLASS}
                                value={rule.operator}
                                onChange={(event) => {
                                  const nextOperator = event.target.value as ScanRuleOperator;
                                  setRuleValueInputByRule((current) => {
                                    const next = { ...current };
                                    if (nextOperator !== "in" && nextOperator !== "not_in") delete next[rule.id];
                                    return next;
                                  });
                                  updateDraftRules((rules) => rules.map((row) => row.id === rule.id ? { ...row, operator: nextOperator } : row));
                                }}
                              >
                                {operatorOptions.map((option) => (
                                  <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                              </select>
                            </label>
                          </div>
                          <div className="grid gap-2">
                            <label className="block">
                              Comparison Target
                              <select
                                className={`${FORM_SELECT_CLASS} md:max-w-48`}
                                value={valueMode}
                                onChange={(event) => {
                                  const nextMode = event.target.value === FIELD_VALUE_MODE ? "field" : "literal";
                                  if (nextMode === "field") {
                                    setRuleValueInputByRule((current) => {
                                      const next = { ...current };
                                      delete next[rule.id];
                                      return next;
                                    });
                                  }
                                  updateDraftRules((rules) => rules.map((row) => row.id === rule.id ? setRuleValueMode(row, nextMode) : row));
                                }}
                              >
                                <option value={LITERAL_VALUE_MODE}>Fixed value</option>
                                <option value={FIELD_VALUE_MODE}>Another field</option>
                              </select>
                            </label>
                            {valueMode === FIELD_VALUE_MODE ? (
                              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr),7rem]">
                                <div className="grid gap-2 md:grid-cols-[minmax(0,1.2fr),minmax(0,1fr)]">
                                  <label className="block">
                                    Reference Field
                                    <select
                                      className={FORM_SELECT_CLASS}
                                      value={isSuggestedField(compareField, compareFieldOptions) ? compareField : CUSTOM_FIELD_OPTION}
                                      onChange={(event) => updateDraftRules((rules) => rules.map((row) => {
                                        if (row.id !== rule.id) return row;
                                        return setRuleCompareField(row, event.target.value === CUSTOM_FIELD_OPTION ? "" : event.target.value);
                                      }))}
                                    >
                                      {compareFieldOptions.map((field) => (
                                        <option key={field.value} value={field.value}>{field.label}</option>
                                      ))}
                                      {!isSuggestedField(compareField, compareFieldOptions) && compareField.trim() ? (
                                        <option value={CUSTOM_FIELD_OPTION}>Custom field ({selectedCompareFieldLabel})</option>
                                      ) : null}
                                      <option value={CUSTOM_FIELD_OPTION}>Custom field...</option>
                                    </select>
                                  </label>
                                  <label className="block">
                                    <span className="sr-only">Reference field ID</span>
                                    <input className={FORM_INPUT_CLASS} value={compareField} onChange={(event) => updateDraftRules((rules) => rules.map((row) => row.id === rule.id ? setRuleCompareField(row, event.target.value) : row))} placeholder="Reference field ID" />
                                  </label>
                                </div>
                                <label className="block">
                                  Multiplier
                                  <input
                                    className={FORM_INPUT_CLASS}
                                    value={compareMultiplierInput}
                                    onChange={(event) => {
                                      const rawValue = event.target.value;
                                      setCompareMultiplierInputByRule((current) => ({ ...current, [rule.id]: rawValue }));
                                      const trimmed = rawValue.trim();
                                      if (!trimmed || trimmed === "-" || trimmed === "." || trimmed === "-." || trimmed.endsWith(".")) return;
                                      updateDraftRules((rules) => rules.map((row) => row.id === rule.id ? setRuleCompareMultiplier(row, rawValue) : row));
                                    }}
                                    onBlur={() => {
                                      updateDraftRules((rules) => rules.map((row) => row.id === rule.id ? setRuleCompareMultiplier(row, compareMultiplierInput) : row));
                                      setCompareMultiplierInputByRule((current) => {
                                        const next = { ...current };
                                        delete next[rule.id];
                                        return next;
                                      });
                                    }}
                                    placeholder="1"
                                  />
                                </label>
                              </div>
                            ) : (
                              <label className="block">
                                Value
                                <input
                                  className={FORM_INPUT_CLASS}
                                  value={rawRuleValueInput}
                                  onChange={(event) => {
                                    const rawValue = event.target.value;
                                    if (rule.operator === "in" || rule.operator === "not_in") {
                                      setRuleValueInputByRule((current) => ({ ...current, [rule.id]: rawValue }));
                                    }
                                    updateDraftRules((rules) => rules.map((row) => row.id === rule.id ? ruleFromInput(row, rawValue) : row));
                                  }}
                                  onBlur={() => {
                                    if (rule.operator !== "in" && rule.operator !== "not_in") return;
                                    setRuleValueInputByRule((current) => {
                                      const next = { ...current };
                                      delete next[rule.id];
                                      return next;
                                    });
                                  }}
                                  placeholder={rule.operator === "in" || rule.operator === "not_in" ? "Comma-separated values" : "Enter value"}
                                />
                              </label>
                            )}
                          </div>
                          <div className="mt-3 flex justify-end">
                            <button
                              className={DANGER_BUTTON_CLASS}
                              disabled={draftRules.length === 1}
                              onClick={() => {
                                setRuleValueInputByRule((current) => {
                                  const next = { ...current };
                                  delete next[rule.id];
                                  return next;
                                });
                                updateDraftRules((rules) => rules.filter((row) => row.id !== rule.id));
                              }}
                            >
                              Remove Rule
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="border-b border-borderSoft/70 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">Compile Presets</h3>
                    <p className="text-xs text-slate-500">{compilePresets.length} saved</p>
                  </div>
                  <button
                    className={SECONDARY_BUTTON_CLASS}
                    type="button"
                    onClick={() => {
                      setSelectedCompilePresetId(null);
                      setDraftCompilePreset(emptyDraftCompilePreset());
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New
                  </button>
                </div>
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {compilePresets.map((preset) => (
                    <button
                      key={preset.id}
                      className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${preset.id === selectedCompilePresetId ? "border-accent/60 bg-accent/10 shadow-[0_0_0_1px_rgba(56,189,248,0.12)]" : "border-borderSoft/60 bg-panelSoft/20 hover:bg-slate-900/30"}`}
                      type="button"
                      onClick={() => setSelectedCompilePresetId(preset.id)}
                    >
                      <div className="truncate text-sm font-semibold text-accent">{preset.name}</div>
                      <div className="mt-1 text-[11px] text-slate-400">
                        {preset.memberCount} scan preset{preset.memberCount === 1 ? "" : "s"}
                      </div>
                      <div className="truncate text-[11px] text-slate-500">{preset.presetNames.join(", ") || "No member presets"}</div>
                    </button>
                  ))}
                  {compilePresets.length === 0 && <p className="rounded-xl border border-borderSoft/70 bg-panelSoft/25 px-3 py-4 text-center text-xs text-slate-400">No compile presets saved yet.</p>}
                </div>
              </div>

              <div className="p-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">{draftCompilePreset.id ? "Edit Compile Preset" : "Create Compile Preset"}</h3>
                    <p className="text-xs text-slate-500">{draftCompilePreset.members.length} selected</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button className={PRIMARY_BUTTON_CLASS} disabled={saving} onClick={() => void onSaveCompilePreset()}>
                      <Save className="h-3.5 w-3.5" />
                      {saving ? "Saving..." : "Save"}
                    </button>
                    <button className={DANGER_BUTTON_CLASS} disabled={!draftCompilePreset.id} onClick={() => void onDeleteCompilePreset()}>
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </button>
                  </div>
                </div>

                <div className="space-y-4 text-xs text-slate-300">
                  <label className="block">
                    Name
                    <input className={FORM_INPUT_CLASS} value={draftCompilePreset.name} onChange={(event) => setDraftCompilePreset((current) => ({ ...current, name: event.target.value }))} />
                  </label>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Member Scan Presets</h4>
                      <span className="text-[11px] text-slate-500">{draftCompilePreset.members.length} selected</span>
                    </div>
                    <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                      {presets.map((preset) => {
                        const checked = draftCompilePreset.members.some((member) => member.scanPresetId === preset.id);
                        return (
                          <label
                            key={preset.id}
                            className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm transition ${checked ? "border-accent/40 bg-accent/10 text-slate-100" : "border-borderSoft/70 bg-panelSoft/20 text-slate-300 hover:bg-slate-900/25"}`}
                          >
                            <input className="mt-1 accent-sky-400" type="checkbox" checked={checked} onChange={() => toggleCompilePresetMember(preset.id)} />
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{preset.name}</span>
                              <span className="block text-[11px] text-slate-400">
                                {(preset.scanType === "relative-strength" ? preset.prefilterRules.length : preset.rules.length)} {preset.scanType === "relative-strength" ? "prefilter" : "rule"}{(preset.scanType === "relative-strength" ? preset.prefilterRules.length : preset.rules.length) === 1 ? "" : "s"} / {preset.rowLimit} rows
                              </span>
                            </span>
                          </label>
                        );
                      })}
                      {presets.length === 0 && <p className="rounded-xl border border-borderSoft/70 bg-panelSoft/25 px-3 py-4 text-center text-xs text-slate-400">Create a scan preset first, then add it to a compile preset.</p>}
                    </div>
                  </div>

                  {draftCompilePreset.members.length > 0 ? (
                    <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/25 p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Compile Order</div>
                      <div className="mt-2 space-y-1.5 text-sm text-slate-300">
                        {draftCompilePreset.members.map((member, index) => (
                          <div key={member.scanPresetId} className="flex items-center gap-2">
                            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-800/70 text-[11px] text-slate-300">{index + 1}</span>
                            <span className="truncate">{member.scanPresetName}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </div>
      </aside>

      {peerTicker && <PeerGroupModal ticker={peerTicker} onClose={() => setPeerTicker(null)} />}
    </div>
  );
}
