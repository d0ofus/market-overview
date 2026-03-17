"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import {
  createScanPreset,
  deleteScanPreset,
  getScanPresets,
  getScansSnapshot,
  getTickerNews,
  refreshScansSnapshot,
  updateScanPreset,
  type AlertNewsRow,
  type ScanPreset,
  type ScanRow,
  type ScanRule,
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
  | "price"
  | "priceAvgVolume";

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

const FIELD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "close", label: "Price" },
  { value: "change", label: "Change %" },
  { value: "market_cap_basic", label: "Market Capitalization" },
  { value: "type", label: "Symbol Type" },
  { value: "exchange", label: "Exchange" },
  { value: "volume", label: "Volume" },
  { value: "Value.Traded", label: "Volume*Price" },
  { value: "industry", label: "Industry" },
  { value: "ADR", label: "Average Day Range (14)" },
  { value: "relative_volume", label: "Relative Volume" },
];

const CUSTOM_FIELD_OPTION = "__custom__";

const FIELD_LABELS: Record<string, string> = {
  close: "Price",
  change: "Change %",
  market_cap_basic: "Market Capitalization",
  marketCap: "Market Capitalization",
  market_cap: "Market Capitalization",
  type: "Symbol Type",
  exchange: "Exchange",
  volume: "Volume",
  "Value.Traded": "Volume*Price",
  valueTraded: "Volume*Price",
  industry: "Industry",
  ADR: "Average Day Range (14)",
  average_day_range_14: "Average Day Range (14)",
  averageDayRange14: "Average Day Range (14)",
  relative_volume: "Relative Volume",
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
  isDefault: false,
  isActive: true,
  rules: [emptyDraftRule()],
  sortField: "change",
  sortDirection: "desc",
  rowLimit: 100,
  createdAt: "",
  updatedAt: "",
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

function valueToInput(rule: ScanRule): string {
  return Array.isArray(rule.value) ? rule.value.join(", ") : String(rule.value ?? "");
}

function ruleFromInput(rule: ScanRule, rawValue: string): ScanRule {
  const trimmed = rawValue.trim();
  if (rule.operator === "in" || rule.operator === "not_in") {
    return {
      ...rule,
      value: trimmed.split(",").map((value) => value.trim()).filter(Boolean),
    };
  }
  if (trimmed === "") return { ...rule, value: "" };
  const parsed = Number(trimmed);
  return {
    ...rule,
    value: Number.isFinite(parsed) && !/[A-Za-z]/.test(trimmed) ? parsed : trimmed,
  };
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

function isSuggestedField(field: string): boolean {
  return FIELD_OPTIONS.some((option) => option.value === field);
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
      if (sortKey === "price") return row.price ?? Number.NEGATIVE_INFINITY;
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
  const [draftPreset, setDraftPreset] = useState<ScanPreset>(emptyDraftPreset);
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);
  const [newsByTicker, setNewsByTicker] = useState<Record<string, AlertNewsRow[]>>({});
  const [newsLoadingTicker, setNewsLoadingTicker] = useState<string | null>(null);
  const [peerTicker, setPeerTicker] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("change1d");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) ?? null,
    [presets, selectedPresetId],
  );

  const sortedRows = useMemo(
    () => sortRows(snapshot?.rows ?? [], sortKey, sortDir),
    [snapshot?.rows, sortDir, sortKey],
  );

  const loadAll = async (preferredPresetId?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const presetsRes = await getScanPresets();
      const rows = presetsRes.rows ?? [];
      setPresets(rows);
      const nextPresetId = preferredPresetId ?? selectedPresetId ?? rows.find((row) => row.isDefault)?.id ?? rows[0]?.id ?? null;
      setSelectedPresetId(nextPresetId);
      if (nextPresetId) {
        const nextSnapshot = await getScansSnapshot(nextPresetId);
        setSnapshot(nextSnapshot);
      } else {
        setSnapshot(null);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load scans.");
    } finally {
      setLoading(false);
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
    if (!selectedPresetId || loading) return;
    void (async () => {
      try {
        const nextSnapshot = await getScansSnapshot(selectedPresetId);
        setSnapshot(nextSnapshot);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Failed to load scan snapshot.");
      }
    })();
  }, [selectedPresetId]);

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
    const rules = draftPreset.rules.filter((rule) => rule.field.trim());
    if (!trimmedName) {
      setError("Preset name is required.");
      setMessage(null);
      return;
    }
    if (rules.length === 0) {
      setError("Add at least one scan rule before saving.");
      setMessage(null);
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload = {
        name: trimmedName,
        isDefault: draftPreset.isDefault,
        isActive: draftPreset.isActive,
        rules,
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

  const onRefresh = async () => {
    if (!selectedPresetId) return;
    setRefreshing(true);
    setError(null);
    setMessage(null);
    try {
      const response = await refreshScansSnapshot(selectedPresetId);
      setSnapshot(response.snapshot);
      setExpandedTicker(null);
      setNewsByTicker({});
      setMessage(`Refreshed ${response.snapshot.rowCount} rows.`);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to refresh scans.");
    } finally {
      setRefreshing(false);
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

  if (loading) {
    return (
      <div className="card flex items-center gap-2 p-4 text-sm text-slate-300">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading scans...
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[24rem,minmax(0,1fr)]">
      <aside className="space-y-4">
        <section className="card p-3">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-200">Saved Presets</h3>
            <button
              className="inline-flex items-center gap-1 rounded border border-borderSoft px-2 py-1 text-xs text-slate-300 hover:bg-slate-800/60"
              onClick={() => {
                setSelectedPresetId(null);
                setDraftPreset(emptyDraftPreset());
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              New
            </button>
          </div>
          <div className="space-y-2">
            {presets.map((preset) => (
              <button
                key={preset.id}
                className={`w-full rounded border px-3 py-2 text-left ${preset.id === selectedPresetId ? "border-accent/60 bg-accent/10" : "border-borderSoft/60 hover:bg-slate-900/30"}`}
                onClick={() => setSelectedPresetId(preset.id)}
              >
                <div className="text-sm font-semibold text-accent">{preset.name}</div>
                <div className="text-[11px] text-slate-400">
                  {preset.rules.length} rule{preset.rules.length === 1 ? "" : "s"} - {preset.rowLimit} rows - {preset.sortField} {preset.sortDirection}
                </div>
                <div className="text-[11px] text-slate-500">
                  {preset.isDefault ? "Default" : "Preset"} {preset.isActive ? "- Active" : "- Inactive"}
                </div>
              </button>
            ))}
            {presets.length === 0 && <p className="text-xs text-slate-400">No scan presets saved yet.</p>}
          </div>
        </section>

        <section className="card p-3">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-200">{draftPreset.id ? "Edit Preset" : "Create Preset"}</h3>
            <div className="flex items-center gap-2">
              <button
                className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/15 px-2 py-1 text-xs font-medium text-accent disabled:opacity-60"
                disabled={saving}
                onClick={() => void onSavePreset()}
              >
                <Save className="h-3.5 w-3.5" />
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                className="inline-flex items-center gap-1 rounded border border-red-500/40 px-2 py-1 text-xs text-red-300 disabled:opacity-50"
                disabled={!draftPreset.id || draftPreset.isDefault}
                onClick={() => void onDeletePreset()}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            </div>
          </div>

          <div className="space-y-3 text-xs text-slate-300">
            <label className="block">
              Name
              <input
                className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                value={draftPreset.name}
                onChange={(event) => setDraftPreset((current) => ({ ...current, name: event.target.value }))}
              />
            </label>

            <div className="grid gap-2 md:grid-cols-2">
              <label className="block">
                Sort Field
                <input
                  className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                  value={draftPreset.sortField}
                  onChange={(event) => setDraftPreset((current) => ({ ...current, sortField: event.target.value }))}
                />
              </label>
              <label className="block">
                Sort Direction
                <select
                  className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                  value={draftPreset.sortDirection}
                  onChange={(event) => setDraftPreset((current) => ({ ...current, sortDirection: event.target.value === "asc" ? "asc" : "desc" }))}
                >
                  <option value="desc">Descending</option>
                  <option value="asc">Ascending</option>
                </select>
              </label>
            </div>

            <label className="block">
              Row Limit
              <input
                className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                type="number"
                min={1}
                max={250}
                value={draftPreset.rowLimit}
                onChange={(event) => setDraftPreset((current) => ({ ...current, rowLimit: Math.max(1, Math.min(250, Number(event.target.value) || 100)) }))}
              />
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draftPreset.isDefault}
                onChange={(event) => setDraftPreset((current) => ({ ...current, isDefault: event.target.checked }))}
              />
              Default preset
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draftPreset.isActive}
                onChange={(event) => setDraftPreset((current) => ({ ...current, isActive: event.target.checked }))}
              />
              Active
            </label>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Rules</h4>
                <button
                  className="rounded border border-borderSoft px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800/60"
                  onClick={() => setDraftPreset((current) => ({ ...current, rules: [...current.rules, emptyDraftRule()] }))}
                >
                  Add Rule
                </button>
              </div>
              {draftPreset.rules.map((rule, index) => (
                <div key={rule.id} className="rounded border border-borderSoft/70 bg-panelSoft/30 p-2">
                  <div className="mb-2 grid gap-2 md:grid-cols-[minmax(0,1.2fr),minmax(0,1fr),8rem]">
                    <label className="block">
                      Field
                      <select
                        className="mt-1 w-full rounded border border-borderSoft bg-panel px-2 py-1.5 text-sm"
                        value={isSuggestedField(rule.field) ? rule.field : CUSTOM_FIELD_OPTION}
                        onChange={(event) => setDraftPreset((current) => ({
                          ...current,
                          rules: current.rules.map((row) => {
                            if (row.id !== rule.id) return row;
                            return {
                              ...row,
                              field: event.target.value === CUSTOM_FIELD_OPTION ? "" : event.target.value,
                            };
                          }),
                        }))}
                      >
                        {FIELD_OPTIONS.map((field) => (
                          <option key={field.value} value={field.value}>{field.label}</option>
                        ))}
                        <option value={CUSTOM_FIELD_OPTION}>Custom field...</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="sr-only">Field ID</span>
                      <input
                        className="mt-1 w-full rounded border border-borderSoft bg-panelSoft/50 px-2 py-1.5 text-sm text-slate-300"
                        value={rule.field}
                        onChange={(event) => setDraftPreset((current) => ({
                          ...current,
                          rules: current.rules.map((row) => row.id === rule.id ? { ...row, field: event.target.value } : row),
                        }))}
                      />
                    </label>
                    <label className="block">
                      Operator
                      <select
                        className="mt-1 w-full rounded border border-borderSoft bg-panel px-2 py-1.5 text-sm"
                        value={rule.operator}
                        onChange={(event) => setDraftPreset((current) => ({
                          ...current,
                          rules: current.rules.map((row) => row.id === rule.id ? { ...row, operator: event.target.value as ScanRuleOperator } : row),
                        }))}
                      >
                        {RULE_OPERATORS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="block">
                    Value
                    <input
                      className="mt-1 w-full rounded border border-borderSoft bg-panel px-2 py-1.5 text-sm"
                      value={valueToInput(rule)}
                      onChange={(event) => setDraftPreset((current) => ({
                        ...current,
                        rules: current.rules.map((row) => row.id === rule.id ? ruleFromInput(row, event.target.value) : row),
                      }))}
                      placeholder={rule.operator === "in" || rule.operator === "not_in" ? "Comma-separated values" : "Enter value"}
                    />
                  </label>
                  <div className="mt-2 flex justify-end">
                    <button
                      className="rounded border border-red-500/40 px-2 py-1 text-[11px] text-red-300 disabled:opacity-40"
                      disabled={draftPreset.rules.length === 1}
                      onClick={() => setDraftPreset((current) => ({
                        ...current,
                        rules: current.rules.filter((row) => row.id !== rule.id),
                      }))}
                    >
                      Remove Rule
                    </button>
                  </div>
                  {index === 0 ? (
                    <p className="mt-2 text-[11px] text-slate-500">
                      Suggestions: {FIELD_OPTIONS.map((field) => `${field.label} (${field.value})`).join(", ")}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </section>
      </aside>

      <section className="space-y-4">
        <div className="card p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-200">{snapshot?.presetName ?? selectedPreset?.name ?? "Scans"}</h3>
              <p className="text-xs text-slate-400">
                Last updated: {formatDateTime(snapshot?.generatedAt)} - Source: {snapshot?.providerLabel ?? "TradingView Screener (Python)"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`rounded px-2 py-1 text-xs ${snapshot?.status === "error" ? "bg-red-500/15 text-red-300" : snapshot?.status === "warning" ? "bg-yellow-500/15 text-yellow-200" : "bg-slate-800/60 text-slate-300"}`}>
                Status: {snapshot?.status ?? "empty"}
              </span>
              <button
                className="inline-flex items-center gap-2 rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent disabled:opacity-60"
                disabled={!selectedPresetId || refreshing}
                onClick={() => void onRefresh()}
              >
                <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
                {refreshing ? "Refreshing..." : "Refresh Scan"}
              </button>
            </div>
          </div>
          {message && <p className="mt-2 text-xs text-slate-300">{message}</p>}
          {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
        </div>

        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/60">
                <tr>
                  {[
                    ["ticker", "Ticker"],
                    ["name", "Company"],
                    ["sector", "Sector"],
                    ["industry", "Industry"],
                    ["change1d", "1D Change %"],
                    ["marketCap", "Market Cap"],
                    ["price", "Price"],
                    ["priceAvgVolume", "Price * Avg Vol"],
                  ].map(([key, label]) => (
                    <th key={key} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">
                      <button className="inline-flex items-center gap-1 text-left hover:text-slate-100" onClick={() => onSort(key as SortKey)}>
                        {label}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => {
                  const isOpen = expandedTicker === row.ticker;
                  const news = newsByTicker[row.ticker] ?? [];
                  return (
                    <Fragment key={row.ticker}>
                      <tr className="cursor-pointer border-t border-borderSoft/80 transition-colors hover:bg-slate-900/30" onClick={() => onToggleRow(row.ticker)}>
                        <td className="px-3 py-2 font-semibold text-accent">
                          <button
                            className="hover:underline"
                            onClick={(event) => {
                              event.stopPropagation();
                              setPeerTicker(row.ticker);
                            }}
                          >
                            {row.ticker}
                          </button>
                        </td>
                        <td className="max-w-48 truncate px-3 py-2 text-slate-300">{row.name ?? row.ticker}</td>
                        <td className="px-3 py-2 text-slate-300">{row.sector ?? "-"}</td>
                        <td className="px-3 py-2 text-slate-300">{row.industry ?? "-"}</td>
                        <td className={`px-3 py-2 ${(row.change1d ?? 0) >= 0 ? "text-pos" : "text-neg"}`}>{formatPct(row.change1d)}</td>
                        <td className="px-3 py-2 text-slate-300">{formatCompact(row.marketCap)}</td>
                        <td className="px-3 py-2 text-slate-300">{formatNumber(row.price)}</td>
                        <td className="px-3 py-2 text-slate-300">{formatCompact(row.priceAvgVolume)}</td>
                      </tr>
                      {isOpen && (
                        <tr className="border-t border-borderSoft/60 bg-panel/50">
                          <td colSpan={8} className="px-3 py-3">
                            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr),minmax(24rem,1fr)]">
                              <div className="rounded border border-borderSoft/70 bg-panelSoft/70 p-3">
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
                              <div className="rounded border border-borderSoft/70 bg-panelSoft/70 p-3">
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
                    <td colSpan={8} className="px-3 py-6 text-center text-sm text-slate-400">
                      No scan rows are available yet. Save a preset and run a refresh to populate this table.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {peerTicker && <PeerGroupModal ticker={peerTicker} onClose={() => setPeerTicker(null)} />}
    </div>
  );
}
