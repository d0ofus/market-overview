"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, Loader2, RefreshCw, Save } from "lucide-react";
import {
  createOrUpdateScan,
  getScanCompiledRows,
  getScanCompiledUniqueTickers,
  getScanExportUrl,
  getScanRunCompiledRows,
  getScanRunUniqueTickers,
  getScanRuns,
  getScans,
  ingestScan,
  type ScanCompiledRow,
  type ScanDefinitionRow,
  type ScanRunSummary,
  type ScanSourceType,
  type ScanUniqueTickerRow,
} from "@/lib/api";
import { TradingViewWidget } from "./tradingview-widget";

type ViewMode = "compiled" | "unique";
type ScopeMode = "aggregate" | "run";

const SOURCE_OPTIONS: Array<{ value: ScanSourceType; label: string }> = [
  { value: "tradingview-public-link", label: "TradingView Public Link" },
  { value: "csv-text", label: "CSV Text" },
  { value: "ticker-list", label: "Ticker List" },
];

const initialForm = {
  id: "",
  name: "",
  providerKey: "tradingview-public-link",
  sourceType: "tradingview-public-link" as ScanSourceType,
  sourceValue: "",
  fallbackSourceType: "ticker-list" as ScanSourceType,
  fallbackSourceValue: "",
  isActive: true,
  notes: "",
};

function formatTime(value: string | null | undefined): string {
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

function fmtNumber(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-";
}

export function ScanningDashboard() {
  const [scans, setScans] = useState<ScanDefinitionRow[]>([]);
  const [selectedScanId, setSelectedScanId] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScanRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [compiledRows, setCompiledRows] = useState<ScanCompiledRow[]>([]);
  const [uniqueRows, setUniqueRows] = useState<ScanUniqueTickerRow[]>([]);
  const [scopeMode, setScopeMode] = useState<ScopeMode>("aggregate");
  const [viewMode, setViewMode] = useState<ViewMode>("compiled");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState(initialForm);

  const selectedScan = useMemo(
    () => scans.find((scan) => scan.id === selectedScanId) ?? null,
    [scans, selectedScanId],
  );

  const visibleTickers = useMemo(() => {
    if (viewMode === "unique") return uniqueRows.map((row) => row.ticker);
    return compiledRows.map((row) => row.ticker);
  }, [compiledRows, uniqueRows, viewMode]);

  const chartTickers = visibleTickers.slice(0, 4);

  async function loadScans(preferredScanId?: string | null) {
    setLoading(true);
    try {
      const scansRes = await getScans();
      const nextScans = scansRes.rows ?? [];
      setScans(nextScans);
      const resolvedId = preferredScanId ?? selectedScanId ?? nextScans[0]?.id ?? null;
      setSelectedScanId(resolvedId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load scans.");
    } finally {
      setLoading(false);
    }
  }

  async function loadSelectedDetail(scanId: string, scope: ScopeMode, runId?: string | null) {
    setDetailLoading(true);
    try {
      const runsRes = await getScanRuns(scanId, 25);
      const nextRuns = runsRes.rows ?? [];
      setRuns(nextRuns);
      const resolvedRunId = runId ?? selectedRunId ?? nextRuns[0]?.id ?? null;
      setSelectedRunId(resolvedRunId);

      if (scope === "run" && resolvedRunId) {
        const [compiledRes, uniqueRes] = await Promise.all([
          getScanRunCompiledRows(scanId, resolvedRunId),
          getScanRunUniqueTickers(scanId, resolvedRunId),
        ]);
        setCompiledRows(compiledRes.rows ?? []);
        setUniqueRows(uniqueRes.rows ?? []);
        return;
      }

      const [compiledRes, uniqueRes] = await Promise.all([
        getScanCompiledRows(scanId),
        getScanCompiledUniqueTickers(scanId),
      ]);
      setCompiledRows(compiledRes.rows ?? []);
      setUniqueRows(uniqueRes.rows ?? []);
    } catch (error) {
      setCompiledRows([]);
      setUniqueRows([]);
      setMessage(error instanceof Error ? error.message : "Failed to load scan details.");
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    void loadScans();
  }, []);

  useEffect(() => {
    if (!selectedScanId) return;
    void loadSelectedDetail(selectedScanId, scopeMode);
  }, [selectedScanId, scopeMode]);

  useEffect(() => {
    if (!selectedScan) return;
    setForm({
      id: selectedScan.id,
      name: selectedScan.name,
      providerKey: selectedScan.providerKey,
      sourceType: selectedScan.sourceType,
      sourceValue: selectedScan.sourceValue,
      fallbackSourceType: selectedScan.fallbackSourceType ?? "ticker-list",
      fallbackSourceValue: selectedScan.fallbackSourceValue ?? "",
      isActive: selectedScan.isActive,
      notes: selectedScan.notes ?? "",
    });
  }, [selectedScan]);

  const activeExportUrl = selectedScan
    ? getScanExportUrl(selectedScan.id, viewMode, scopeMode === "run" ? selectedRunId : null)
    : null;

  return (
    <div className="grid gap-4 xl:grid-cols-[23rem,minmax(0,1fr)]">
      <aside className="space-y-4">
        <section className="card p-3">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-200">Saved Scans</h3>
            <button
              className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-300 hover:bg-slate-800/60"
              onClick={() => {
                setSelectedScanId(null);
                setRuns([]);
                setSelectedRunId(null);
                setCompiledRows([]);
                setUniqueRows([]);
                setForm(initialForm);
              }}
            >
              New
            </button>
          </div>
          <div className="space-y-2">
            {scans.map((scan) => (
              <button
                key={scan.id}
                className={`w-full rounded border px-3 py-2 text-left ${scan.id === selectedScanId ? "border-accent/60 bg-accent/10" : "border-borderSoft/60 hover:bg-slate-900/30"}`}
                onClick={() => setSelectedScanId(scan.id)}
              >
                <div className="text-sm font-semibold text-accent">{scan.name}</div>
                <div className="text-[11px] text-slate-400">
                  {scan.providerKey} • {scan.sourceType} • {scan.latestRun?.compiledRowCount ?? 0} compiled / {scan.latestRun?.uniqueTickerCount ?? 0} unique
                </div>
                <div className="text-[11px] text-slate-500">
                  {scan.latestRun ? `${scan.latestRun.status} • ${formatTime(scan.latestRun.ingestedAt)}` : "No runs yet"}
                </div>
              </button>
            ))}
            {scans.length === 0 && <p className="text-xs text-slate-400">No saved scans yet.</p>}
          </div>
        </section>

        <section className="card p-3">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-200">{form.id ? "Edit Scan" : "Create Scan"}</h3>
            <button
              className="inline-flex items-center gap-2 rounded border border-accent/40 bg-accent/15 px-2 py-1 text-xs font-medium text-accent disabled:opacity-60"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                setMessage(null);
                try {
                  const res = await createOrUpdateScan({
                    id: form.id || null,
                    name: form.name,
                    providerKey: form.providerKey,
                    sourceType: form.sourceType,
                    sourceValue: form.sourceValue,
                    fallbackSourceType: form.fallbackSourceValue.trim() ? form.fallbackSourceType : null,
                    fallbackSourceValue: form.fallbackSourceValue.trim() || null,
                    isActive: form.isActive,
                    notes: form.notes.trim() || null,
                  });
                  await loadScans(res.id);
                  setMessage("Scan saved.");
                } catch (error) {
                  setMessage(error instanceof Error ? error.message : "Failed to save scan.");
                } finally {
                  setSaving(false);
                }
              }}
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
          <div className="space-y-3 text-xs text-slate-300">
            <label className="block">
              Name
              <input
                className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                value={form.name}
                onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))}
              />
            </label>
            <label className="block">
              Provider
              <select
                className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                value={form.providerKey}
                onChange={(e) => setForm((current) => ({ ...current, providerKey: e.target.value, sourceType: e.target.value as ScanSourceType }))}
              >
                {SOURCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              Source Type
              <select
                className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                value={form.sourceType}
                onChange={(e) => setForm((current) => ({ ...current, sourceType: e.target.value as ScanSourceType }))}
              >
                {SOURCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              Source Value
              <textarea
                className="mt-1 min-h-28 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                value={form.sourceValue}
                onChange={(e) => setForm((current) => ({ ...current, sourceValue: e.target.value }))}
              />
            </label>
            <label className="block">
              Fallback Type
              <select
                className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                value={form.fallbackSourceType}
                onChange={(e) => setForm((current) => ({ ...current, fallbackSourceType: e.target.value as ScanSourceType }))}
              >
                {SOURCE_OPTIONS.filter((option) => option.value !== "tradingview-public-link" || form.sourceType !== "tradingview-public-link").map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              Fallback Value
              <textarea
                className="mt-1 min-h-20 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                value={form.fallbackSourceValue}
                onChange={(e) => setForm((current) => ({ ...current, fallbackSourceValue: e.target.value }))}
              />
            </label>
            <label className="block">
              Notes
              <textarea
                className="mt-1 min-h-16 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                value={form.notes}
                onChange={(e) => setForm((current) => ({ ...current, notes: e.target.value }))}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm((current) => ({ ...current, isActive: e.target.checked }))}
              />
              Active for manual refresh-all
            </label>
          </div>
        </section>
      </aside>

      <section className="space-y-4">
        <div className="card p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-200">{selectedScan?.name ?? "Scanning Workspace"}</h3>
              <p className="text-xs text-slate-400">
                {selectedScan ? `${selectedScan.providerKey} • ${selectedScan.sourceType}` : "Select or create a saved scan."}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="inline-flex items-center gap-2 rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent disabled:opacity-60"
                disabled={!selectedScan || ingesting}
                onClick={async () => {
                  if (!selectedScan) return;
                  setIngesting(true);
                  setMessage(null);
                  try {
                    const res = await ingestScan(selectedScan.id);
                    await loadScans(selectedScan.id);
                    await loadSelectedDetail(selectedScan.id, scopeMode, res.run.id);
                    setSelectedRunId(res.run.id);
                    setScopeMode("run");
                    setMessage(`Ingest complete: ${res.run.compiledRowCount} compiled rows, ${res.run.uniqueTickerCount} unique tickers.`);
                  } catch (error) {
                    setMessage(error instanceof Error ? error.message : "Failed to ingest scan.");
                  } finally {
                    setIngesting(false);
                  }
                }}
              >
                <RefreshCw className={`h-4 w-4 ${ingesting ? "animate-spin" : ""}`} />
                {ingesting ? "Ingesting..." : "Run Ingest"}
              </button>
              {activeExportUrl && (
                <a
                  className="rounded border border-borderSoft px-3 py-2 text-sm text-slate-300 hover:bg-slate-800/60"
                  href={activeExportUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Export {viewMode === "compiled" ? "CSV" : "Tickers CSV"}
                </a>
              )}
              <button
                className="inline-flex items-center gap-2 rounded border border-borderSoft px-3 py-2 text-sm text-slate-300 disabled:opacity-50 hover:bg-slate-800/60"
                disabled={uniqueRows.length === 0}
                onClick={async () => {
                  await navigator.clipboard.writeText(uniqueRows.map((row) => row.ticker).join("\n"));
                  setMessage("Unique ticker list copied.");
                }}
              >
                <Copy className="h-4 w-4" />
                Copy Unique
              </button>
            </div>
          </div>
          {message && <p className="mt-2 text-xs text-slate-400">{message}</p>}
        </div>

        <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.35fr),minmax(24rem,1fr)]">
          <div className="space-y-4">
            <div className="card p-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                  <button
                    className={`rounded px-3 py-1.5 text-xs ${scopeMode === "aggregate" ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                    onClick={() => setScopeMode("aggregate")}
                  >
                    Saved Scan Aggregate
                  </button>
                  <button
                    className={`rounded px-3 py-1.5 text-xs ${scopeMode === "run" ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                    onClick={() => setScopeMode("run")}
                    disabled={runs.length === 0}
                  >
                    Selected Run
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={`rounded px-3 py-1.5 text-xs ${viewMode === "compiled" ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                    onClick={() => setViewMode("compiled")}
                  >
                    Compiled List
                  </button>
                  <button
                    className={`rounded px-3 py-1.5 text-xs ${viewMode === "unique" ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                    onClick={() => setViewMode("unique")}
                  >
                    Unique Tickers
                  </button>
                </div>
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-400">Runs:</span>
                <select
                  className="rounded border border-borderSoft bg-panelSoft px-2 py-1 text-xs"
                  value={selectedRunId ?? ""}
                  onChange={(e) => {
                    const nextRunId = e.target.value || null;
                    setSelectedRunId(nextRunId);
                    setScopeMode(nextRunId ? "run" : "aggregate");
                    if (selectedScanId) void loadSelectedDetail(selectedScanId, nextRunId ? "run" : "aggregate", nextRunId);
                  }}
                >
                  <option value="">Latest Aggregate</option>
                  {runs.map((run) => (
                    <option key={run.id} value={run.id}>
                      {formatTime(run.ingestedAt)} • {run.status} • {run.compiledRowCount}/{run.uniqueTickerCount}
                    </option>
                  ))}
                </select>
              </div>
              {detailLoading ? (
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading scan detail...
                </div>
              ) : viewMode === "compiled" ? (
                <div className="max-h-[36rem] overflow-auto">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-900/60">
                      <tr>
                        <th className="px-2 py-1.5 text-left text-slate-300">Ticker</th>
                        <th className="px-2 py-1.5 text-left text-slate-300">Name</th>
                        <th className="px-2 py-1.5 text-left text-slate-300">Rank</th>
                        <th className="px-2 py-1.5 text-left text-slate-300">Price</th>
                        <th className="px-2 py-1.5 text-left text-slate-300">1D</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compiledRows.map((row) => (
                        <tr key={row.id} className="border-t border-borderSoft/60 hover:bg-slate-900/30">
                          <td className="px-2 py-1.5 font-semibold text-accent">{row.ticker}</td>
                          <td className="px-2 py-1.5 text-slate-300">{row.displayName ?? "-"}</td>
                          <td className="px-2 py-1.5 text-slate-300">
                            {row.rankLabel ?? "-"} {row.rankValue != null ? `(${fmtNumber(row.rankValue)})` : ""}
                          </td>
                          <td className="px-2 py-1.5 text-slate-300">{fmtNumber(row.price)}</td>
                          <td className={`px-2 py-1.5 ${(row.change1d ?? 0) >= 0 ? "text-pos" : "text-neg"}`}>{fmtNumber(row.change1d)}</td>
                        </tr>
                      ))}
                      {compiledRows.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-2 py-4 text-center text-slate-400">
                            No compiled rows available.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="max-h-[36rem] overflow-auto">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-900/60">
                      <tr>
                        <th className="px-2 py-1.5 text-left text-slate-300">Ticker</th>
                        <th className="px-2 py-1.5 text-left text-slate-300">Name</th>
                        <th className="px-2 py-1.5 text-left text-slate-300">Occurrences</th>
                        <th className="px-2 py-1.5 text-left text-slate-300">Price</th>
                        <th className="px-2 py-1.5 text-left text-slate-300">1D</th>
                      </tr>
                    </thead>
                    <tbody>
                      {uniqueRows.map((row) => (
                        <tr key={row.ticker} className="border-t border-borderSoft/60 hover:bg-slate-900/30">
                          <td className="px-2 py-1.5 font-semibold text-accent">{row.ticker}</td>
                          <td className="px-2 py-1.5 text-slate-300">{row.displayName ?? "-"}</td>
                          <td className="px-2 py-1.5 text-slate-300">{row.occurrences}</td>
                          <td className="px-2 py-1.5 text-slate-300">{fmtNumber(row.latestPrice)}</td>
                          <td className={`px-2 py-1.5 ${(row.latestChange1d ?? 0) >= 0 ? "text-pos" : "text-neg"}`}>{fmtNumber(row.latestChange1d)}</td>
                        </tr>
                      ))}
                      {uniqueRows.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-2 py-4 text-center text-slate-400">
                            No unique tickers available.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="card p-3">
            <h3 className="mb-3 text-sm font-semibold text-slate-200">TradingView Review Grid (Top 4)</h3>
            <div className="grid gap-3 md:grid-cols-2">
              {chartTickers.map((ticker, idx) => (
                <div key={`${ticker}-${idx}`} className="rounded border border-borderSoft/60 p-2">
                  <div className="mb-2 text-sm font-semibold text-accent">{ticker}</div>
                  <TradingViewWidget ticker={ticker} size="small" chartOnly initialRange="3M" className="!border-0 !bg-transparent !shadow-none !p-0" />
                </div>
              ))}
              {chartTickers.length === 0 && <p className="text-sm text-slate-400">Run an ingest or select a saved scan with rows to populate the review grid.</p>}
            </div>
          </div>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading scans...
          </div>
        )}
      </section>
    </div>
  );
}
