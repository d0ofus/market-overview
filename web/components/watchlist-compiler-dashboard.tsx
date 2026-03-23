"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, Loader2, RefreshCw } from "lucide-react";
import {
  compileAdminWatchlistCompilerSet,
  getWatchlistCompilerCompiled,
  getWatchlistCompilerExportUrl,
  getWatchlistCompilerRuns,
  getWatchlistCompilerSet,
  getWatchlistCompilerSets,
  getWatchlistCompilerUnique,
  type ScanCompiledRow,
  type ScanUniqueTickerRow,
  type WatchlistCompilerRunSummary,
  type WatchlistCompilerSetDetail,
  type WatchlistCompilerSetRow,
} from "@/lib/api";
import { TradingViewWidget } from "./tradingview-widget";

type ViewMode = "compiled" | "unique";

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

function localDateSuffix() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function parseSourceSections(value: string | null | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const part of value.split(/[\r\n,;]+/)) {
    const normalized = part.replace(/^#+/, "").replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

export function WatchlistCompilerDashboard() {
  const [sets, setSets] = useState<WatchlistCompilerSetRow[]>([]);
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WatchlistCompilerSetDetail | null>(null);
  const [runs, setRuns] = useState<WatchlistCompilerRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("compiled");
  const [compiledRows, setCompiledRows] = useState<ScanCompiledRow[]>([]);
  const [uniqueRows, setUniqueRows] = useState<ScanUniqueTickerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const selectedSet = useMemo(
    () => sets.find((row) => row.id === selectedSetId) ?? null,
    [sets, selectedSetId],
  );

  const loadSets = async (preferredId?: string | null) => {
    setLoading(true);
    try {
      const res = await getWatchlistCompilerSets();
      const rows = res.rows ?? [];
      setSets(rows);
      setSelectedSetId((current) => preferredId ?? current ?? rows[0]?.id ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load watchlist compiler sets.");
      setSets([]);
      setSelectedSetId(null);
    } finally {
      setLoading(false);
    }
  };

  const loadSelected = async (setId: string, runId?: string | null) => {
    setDetailLoading(true);
    try {
      const [detailRes, runsRes, rowsRes] = await Promise.all([
        getWatchlistCompilerSet(setId),
        getWatchlistCompilerRuns(setId, 25),
        viewMode === "compiled" ? getWatchlistCompilerCompiled(setId, runId) : getWatchlistCompilerUnique(setId, runId),
      ]);
      setDetail(detailRes);
      setRuns(runsRes.rows ?? []);
      setSelectedRunId(runId ?? rowsRes.runId ?? runsRes.rows?.[0]?.id ?? null);
      if (viewMode === "compiled") {
        setCompiledRows((rowsRes as { rows: ScanCompiledRow[] }).rows ?? []);
      } else {
        setUniqueRows((rowsRes as { rows: ScanUniqueTickerRow[] }).rows ?? []);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load watchlist compiler detail.");
      setDetail(null);
      setRuns([]);
      setCompiledRows([]);
      setUniqueRows([]);
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    void loadSets();
  }, []);

  useEffect(() => {
    if (!selectedSetId) return;
    void loadSelected(selectedSetId, selectedRunId);
  }, [selectedSetId, viewMode]);

  const visibleTickers = useMemo(() => (
    viewMode === "compiled" ? compiledRows.map((row) => row.ticker) : uniqueRows.map((row) => row.ticker)
  ), [compiledRows, uniqueRows, viewMode]);

  const exportDate = localDateSuffix();
  const exportCsvUrl = selectedSetId ? getWatchlistCompilerExportUrl(selectedSetId, "csv", viewMode, { runId: selectedRunId, dateSuffix: exportDate }) : null;
  const exportTxtUrl = selectedSetId ? getWatchlistCompilerExportUrl(selectedSetId, "txt", viewMode, { runId: selectedRunId, dateSuffix: exportDate }) : null;
  const selectedSections = useMemo(() => {
    if (!detail) return [];
    const seen = new Set<string>();
    const output: string[] = [];
    detail.sources.forEach((source) => {
      parseSourceSections(source.sourceSections).forEach((section) => {
        if (seen.has(section)) return;
        seen.add(section);
        output.push(section);
      });
    });
    return output;
  }, [detail]);

  return (
    <div className="grid gap-4 xl:grid-cols-[22rem,minmax(0,1fr)]">
      <aside className="space-y-4">
        <section className="card p-3">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-200">Saved Sets</h3>
            <span className="text-[11px] text-slate-500">{sets.length} total</span>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading sets...
            </div>
          ) : (
            <div className="space-y-2">
              {sets.map((row) => (
                <button
                  key={row.id}
                  className={`w-full rounded border px-3 py-2 text-left ${row.id === selectedSetId ? "border-accent/60 bg-accent/10" : "border-borderSoft/60 hover:bg-slate-900/30"}`}
                  onClick={() => {
                    setSelectedSetId(row.id);
                    setSelectedRunId(row.latestRun?.id ?? null);
                  }}
                >
                  <div className="text-sm font-semibold text-accent">{row.name}</div>
                  <div className="text-[11px] text-slate-400">
                    {row.sourceCount} source{row.sourceCount === 1 ? "" : "s"} • {row.compileDaily ? "daily" : "manual"}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {row.latestRun ? `${row.latestRun.compiledRowCount} compiled / ${row.latestRun.uniqueTickerCount} unique` : "No runs yet"}
                  </div>
                </button>
              ))}
              {sets.length === 0 && <p className="text-xs text-slate-400">No watchlist compiler sets configured yet.</p>}
            </div>
          )}
        </section>

        <section className="card p-3 text-sm text-slate-300">
          <h3 className="mb-2 font-semibold text-slate-200">Selected Set</h3>
          {detail ? (
            <div className="space-y-2">
              <div className="text-base font-semibold text-accent">{detail.name}</div>
              <div className="text-xs text-slate-400">
                {detail.compileDaily
                  ? `Daily at ${detail.dailyCompileTimeLocal ?? "-"} ${detail.dailyCompileTimezone ?? "-"}`
                  : "Manual compile only"}
              </div>
              {selectedSections.length > 0 && (
                <div className="rounded border border-accent/20 bg-accent/5 p-2 text-xs text-slate-300">
                  <div className="mb-1 font-semibold text-accent">Sections Pulled</div>
                  <div>{selectedSections.join(", ")}</div>
                </div>
              )}
              <div className="rounded border border-borderSoft/60 bg-panelSoft/30 p-2 text-xs text-slate-400">
                {detail.sources.map((source) => (
                  <div key={source.id} className="truncate">
                    {source.sortOrder}. {(source.sourceName?.trim() || `Source ${source.sortOrder}`)} - {source.sourceUrl}
                  </div>
                ))}
                {detail.sources.length === 0 && <div>No source URLs configured.</div>}
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-400">Select a saved set to inspect and compile it.</p>
          )}
        </section>
      </aside>

      <section className="space-y-4">
        <div className="card p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-200">{selectedSet?.name ?? "Watchlist Compiler"}</h3>
              <p className="text-xs text-slate-400">
                {selectedSet?.latestRun ? `Latest run ${formatTime(selectedSet.latestRun.ingestedAt)}` : "Run a compile to populate this workspace."}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="inline-flex items-center gap-2 rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent disabled:opacity-60"
                disabled={!selectedSetId || compiling}
                onClick={async () => {
                  if (!selectedSetId) return;
                  setCompiling(true);
                  setMessage(null);
                  try {
                    const res = await compileAdminWatchlistCompilerSet(selectedSetId);
                    await loadSets(selectedSetId);
                    await loadSelected(selectedSetId, res.run.id);
                    setSelectedRunId(res.run.id);
                    setMessage(`Compiled ${res.run.compiledRowCount} rows and ${res.run.uniqueTickerCount} unique tickers.`);
                  } catch (error) {
                    setMessage(error instanceof Error ? error.message : "Failed to compile watchlist set.");
                  } finally {
                    setCompiling(false);
                  }
                }}
              >
                <RefreshCw className={`h-4 w-4 ${compiling ? "animate-spin" : ""}`} />
                {compiling ? "Compiling..." : "Compile"}
              </button>
              {exportCsvUrl && (
                <a className="rounded border border-borderSoft px-3 py-2 text-sm text-slate-300 hover:bg-slate-800/60" href={exportCsvUrl} target="_blank" rel="noreferrer">
                  Export CSV
                </a>
              )}
              {exportTxtUrl && (
                <a className="rounded border border-borderSoft px-3 py-2 text-sm text-slate-300 hover:bg-slate-800/60" href={exportTxtUrl} target="_blank" rel="noreferrer">
                  Export TXT
                </a>
              )}
              <button
                className="inline-flex items-center gap-2 rounded border border-borderSoft px-3 py-2 text-sm text-slate-300 disabled:opacity-50 hover:bg-slate-800/60"
                disabled={visibleTickers.length === 0}
                onClick={async () => {
                  await navigator.clipboard.writeText(visibleTickers.join("\n"));
                  setMessage("Tickers copied.");
                }}
              >
                <Copy className="h-4 w-4" />
                Copy View
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
                    className={`rounded px-3 py-1.5 text-xs ${viewMode === "compiled" ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                    onClick={() => setViewMode("compiled")}
                  >
                    Compiled
                  </button>
                  <button
                    className={`rounded px-3 py-1.5 text-xs ${viewMode === "unique" ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                    onClick={() => setViewMode("unique")}
                  >
                    Unique Only
                  </button>
                </div>
                <select
                  className="rounded border border-borderSoft bg-panelSoft px-2 py-1 text-xs"
                  value={selectedRunId ?? ""}
                  onChange={async (event) => {
                    const nextRunId = event.target.value || null;
                    setSelectedRunId(nextRunId);
                    if (selectedSetId) await loadSelected(selectedSetId, nextRunId);
                  }}
                >
                  <option value="">Latest Run</option>
                  {runs.map((run) => (
                    <option key={run.id} value={run.id}>
                      {formatTime(run.ingestedAt)} • {run.compiledRowCount}/{run.uniqueTickerCount}
                    </option>
                  ))}
                </select>
              </div>
              {detailLoading ? (
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading compiled results...
                </div>
              ) : viewMode === "compiled" ? (
                <div className="max-h-[36rem] overflow-auto">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-900/60">
                      <tr>
                        {["Ticker", "Company", "Source", "Price", "1D"].map((label) => (
                          <th key={label} className="px-2 py-1.5 text-left text-slate-300">{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {compiledRows.map((row) => {
                        const source = (() => {
                          try {
                            const parsed = row.rawJson ? JSON.parse(row.rawJson) : null;
                            return typeof parsed?.sourceUrl === "string" ? parsed.sourceUrl : "-";
                          } catch {
                            return "-";
                          }
                        })();
                        return (
                          <tr key={row.id} className="border-t border-borderSoft/60 hover:bg-slate-900/30">
                            <td className="px-2 py-1.5 font-semibold text-accent">{row.ticker}</td>
                            <td className="px-2 py-1.5 text-slate-300">{row.displayName ?? "-"}</td>
                            <td className="max-w-44 truncate px-2 py-1.5 text-slate-400" title={source}>{source}</td>
                            <td className="px-2 py-1.5 text-slate-300">{fmtNumber(row.price)}</td>
                            <td className={`px-2 py-1.5 ${(row.change1d ?? 0) >= 0 ? "text-pos" : "text-neg"}`}>{fmtNumber(row.change1d)}</td>
                          </tr>
                        );
                      })}
                      {compiledRows.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-2 py-4 text-center text-slate-400">No compiled rows yet.</td>
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
                        {["Ticker", "Company", "Occurrences", "Price", "1D"].map((label) => (
                          <th key={label} className="px-2 py-1.5 text-left text-slate-300">{label}</th>
                        ))}
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
                          <td colSpan={5} className="px-2 py-4 text-center text-slate-400">No unique tickers yet.</td>
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
              {visibleTickers.slice(0, 4).map((ticker, index) => (
                <div key={`${ticker}-${index}`} className="rounded border border-borderSoft/60 p-2">
                  <div className="mb-2 text-sm font-semibold text-accent">{ticker}</div>
                  <TradingViewWidget ticker={ticker} size="small" chartOnly initialRange="3M" className="!border-0 !bg-transparent !shadow-none !p-0" />
                </div>
              ))}
              {visibleTickers.length === 0 && <p className="text-sm text-slate-400">Run a compile to populate the review grid.</p>}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
