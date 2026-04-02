"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Loader2, RefreshCw } from "lucide-react";
import {
  apiUrl,
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
import {
  cancelResearchLabRun,
  createResearchLabRun,
  getResearchLabProfiles,
  getResearchLabRunResults,
  getResearchLabRunStatus,
  getResearchLabRuns,
  getResearchLabTickerHistory,
  pumpResearchLabRun,
  type ResearchLabProfileDetail,
  type ResearchLabRunItemResult,
  type ResearchLabRunListRow,
  type ResearchLabRunResultsResponse,
  type ResearchLabRunStatusResponse,
  type ResearchLabTickerHistoryEntry,
} from "@/lib/research-lab-api";
import { ResearchLabResultCard } from "./research-lab-result-card";
import { TradingViewWidget } from "./tradingview-widget";
import { WatchlistResearchPanel } from "./watchlist-research-panel";

type ViewMode = "compiled" | "unique";

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(parsed);
}

function fmtNumber(value: number | null | undefined, digits = 2) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function localDateSuffix() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
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
  const [selectedTickers, setSelectedTickers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [profiles, setProfiles] = useState<ResearchLabProfileDetail[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [researchRuns, setResearchRuns] = useState<ResearchLabRunListRow[]>([]);
  const [selectedResearchRunId, setSelectedResearchRunId] = useState<string | null>(null);
  const [researchStatus, setResearchStatus] = useState<ResearchLabRunStatusResponse | null>(null);
  const [researchResults, setResearchResults] = useState<ResearchLabRunResultsResponse | null>(null);
  const [researchRunning, setResearchRunning] = useState(false);
  const [researchStopping, setResearchStopping] = useState(false);
  const [sourceBasis, setSourceBasis] = useState<"compiled" | "unique">("unique");
  const [maxTickers, setMaxTickers] = useState(12);
  const [historyTicker, setHistoryTicker] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<ResearchLabTickerHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const selectedResearchRunIdRef = useRef<string | null>(null);

  const selectedSet = useMemo(() => sets.find((row) => row.id === selectedSetId) ?? null, [sets, selectedSetId]);
  const visibleTickers = useMemo(() => (viewMode === "compiled" ? compiledRows.map((row) => row.ticker) : uniqueRows.map((row) => row.ticker)), [compiledRows, uniqueRows, viewMode]);
  const uniqueVisibleTickers = useMemo(() => Array.from(new Set(visibleTickers)), [visibleTickers]);

  const loadProfiles = async () => {
    try {
      const res = await getResearchLabProfiles();
      const rows = res.rows ?? [];
      setProfiles(rows);
      setSelectedProfileId((current) => current ?? rows.find((row) => row.isDefault)?.id ?? rows[0]?.id ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load research-lab profiles.");
    }
  };

  const applyResearchStatus = (statusRes: ResearchLabRunStatusResponse) => {
    setResearchStatus(statusRes);
    setResearchRuns((current) => {
      const existing = current.find((row) => row.run.id === statusRes.run.id);
      const row: ResearchLabRunListRow = {
        run: statusRes.run,
        profileName: statusRes.profile?.name ?? existing?.profileName ?? null,
        profileVersionNumber: statusRes.profileVersion?.versionNumber ?? existing?.profileVersionNumber ?? null,
        promptConfigName: statusRes.promptConfig?.name ?? existing?.promptConfigName ?? null,
        evidenceProfileName: statusRes.evidenceProfile?.name ?? existing?.evidenceProfileName ?? null,
      };
      const index = current.findIndex((entry) => entry.run.id === row.run.id);
      if (index >= 0) {
        const next = [...current];
        next[index] = row;
        return next;
      }
      return [row, ...current].slice(0, 12);
    });
    setResearchRunning(statusRes.run.status === "queued" || statusRes.run.status === "running");
  };

  const applyResearchResults = (resultsRes: ResearchLabRunResultsResponse) => {
    setResearchResults(resultsRes);
  };

  const loadResearchRunDetail = async (runId: string) => {
    const statusRes = await getResearchLabRunStatus(runId);
    applyResearchStatus(statusRes);
    void getResearchLabRunResults(runId).then((resultsRes) => {
      setResearchResults((current) => (current?.run.id === runId || selectedResearchRunIdRef.current === runId || !current ? resultsRes : current));
    }).catch((error) => {
      setMessage(error instanceof Error ? error.message : "Failed to load research-lab results.");
    });
  };

  const loadResearchRuns = async (setId: string, preferredRunId?: string | null) => {
    const res = await getResearchLabRuns({ sourceType: "watchlist_set", sourceId: setId, limit: 12 });
    const rows = res.rows ?? [];
    setResearchRuns(rows);
    const nextRunId = preferredRunId ?? selectedResearchRunIdRef.current ?? rows[0]?.run.id ?? null;
    setSelectedResearchRunId(nextRunId);
    if (nextRunId) {
      await loadResearchRunDetail(nextRunId);
    } else {
      setResearchStatus(null);
      setResearchResults(null);
      setResearchRunning(false);
    }
  };

  const loadSets = async (preferredId?: string | null) => {
    setLoading(true);
    try {
      const res = await getWatchlistCompilerSets();
      const rows = res.rows ?? [];
      setSets(rows);
      setSelectedSetId((current) => preferredId ?? current ?? rows[0]?.id ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load watchlist compiler sets.");
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
      if (viewMode === "compiled") setCompiledRows((rowsRes as { rows: ScanCompiledRow[] }).rows ?? []);
      else setUniqueRows((rowsRes as { rows: ScanUniqueTickerRow[] }).rows ?? []);
      setSelectedTickers([]);
      await loadResearchRuns(setId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load watchlist compiler detail.");
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    void loadSets();
    void loadProfiles();
  }, []);

  useEffect(() => {
    if (!selectedSetId) return;
    void loadSelected(selectedSetId, selectedRunId);
  }, [selectedSetId, viewMode]);

  useEffect(() => {
    selectedResearchRunIdRef.current = selectedResearchRunId;
  }, [selectedResearchRunId]);

  useEffect(() => {
    setResearchResults((current) => (current?.run.id === selectedResearchRunId ? current : null));
  }, [selectedResearchRunId]);

  useEffect(() => {
    if (!selectedResearchRunId || !researchStatus || researchStatus.run.id !== selectedResearchRunId || !["queued", "running"].includes(researchStatus.run.status)) return;
    const eventSource = new EventSource(apiUrl(`/api/research-lab/runs/${encodeURIComponent(selectedResearchRunId)}/stream`));
    const kickProgress = () => {
      void pumpResearchLabRun(selectedResearchRunId).catch((error) => {
        setMessage(error instanceof Error ? error.message : "Failed to advance research-lab run.");
      });
    };
    kickProgress();
    const intervalId = window.setInterval(kickProgress, 4_000);
    eventSource.addEventListener("update", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { status: ResearchLabRunStatusResponse; results: ResearchLabRunResultsResponse };
      applyResearchStatus(payload.status);
      applyResearchResults(payload.results);
    });
    eventSource.addEventListener("done", () => {
      eventSource.close();
      setResearchRunning(false);
    });
    eventSource.addEventListener("error", () => {
      eventSource.close();
    });
    return () => {
      window.clearInterval(intervalId);
      eventSource.close();
    };
  }, [selectedResearchRunId, researchStatus?.run.id, researchStatus?.run.status]);

  const exportDate = localDateSuffix();
  const exportCsvUrl = selectedSetId ? getWatchlistCompilerExportUrl(selectedSetId, "csv", viewMode, { runId: selectedRunId, dateSuffix: exportDate }) : null;
  const exportTxtUrl = selectedSetId ? getWatchlistCompilerExportUrl(selectedSetId, "txt", viewMode, { runId: selectedRunId, dateSuffix: exportDate }) : null;

  const toggleTickerSelection = (ticker: string) => {
    setSelectedTickers((current) => current.includes(ticker) ? current.filter((value) => value !== ticker) : [...current, ticker]);
  };

  const openHistory = async (ticker: string) => {
    setHistoryTicker(ticker);
    setHistoryRows([]);
    setHistoryLoading(true);
    try {
      const res = await getResearchLabTickerHistory(ticker);
      setHistoryRows(res.rows ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load ticker history.");
    } finally {
      setHistoryLoading(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[22rem,minmax(0,1fr)]">
      <aside className="space-y-4">
        <section className="card p-3">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-200">Saved Sets</h3>
            <span className="text-[11px] text-slate-500">{sets.length} total</span>
          </div>
          {loading ? <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Loading sets...</div> : (
            <div className="space-y-2">
              {sets.map((row) => (
                <button key={row.id} className={`w-full rounded border px-3 py-2 text-left ${row.id === selectedSetId ? "border-accent/60 bg-accent/10" : "border-borderSoft/60 hover:bg-slate-900/30"}`} onClick={() => { setSelectedSetId(row.id); setSelectedRunId(row.latestRun?.id ?? null); }}>
                  <div className="text-sm font-semibold text-accent">{row.name}</div>
                  <div className="text-[11px] text-slate-400">{row.sourceCount} source{row.sourceCount === 1 ? "" : "s"} · {row.compileDaily ? "daily" : "manual"}</div>
                  <div className="text-[11px] text-slate-500">{row.latestRun ? `${row.latestRun.compiledRowCount} compiled / ${row.latestRun.uniqueTickerCount} unique` : "No runs yet"}</div>
                </button>
              ))}
            </div>
          )}
        </section>
        <section className="card p-3 text-sm text-slate-300">
          <h3 className="mb-2 font-semibold text-slate-200">Selected Set</h3>
          {detail ? (
            <div className="space-y-1">
              <div className="text-base font-semibold text-accent">{detail.name}</div>
              <div className="text-xs text-slate-400">
                {detail.compileDaily
                  ? `Daily at ${detail.dailyCompileTimeLocal ?? "-"} ${detail.dailyCompileTimezone ?? "-"}`
                  : "Manual compile only"}
              </div>
              <div className="text-xs text-slate-500">{detail.sources.length} source{detail.sources.length === 1 ? "" : "s"}</div>
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
              <p className="text-xs text-slate-400">{selectedSet?.latestRun ? `Latest run ${formatTime(selectedSet.latestRun.ingestedAt)}` : "Run a compile to populate this workspace."}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button className="inline-flex items-center gap-2 rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent disabled:opacity-60" disabled={!selectedSetId || compiling} onClick={async () => {
                if (!selectedSetId) return;
                setCompiling(true);
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
              }}>
                <RefreshCw className={`h-4 w-4 ${compiling ? "animate-spin" : ""}`} />
                {compiling ? "Compiling..." : "Compile"}
              </button>
              {exportCsvUrl ? <a className="rounded border border-borderSoft px-3 py-2 text-sm text-slate-300 hover:bg-slate-800/60" href={exportCsvUrl} target="_blank" rel="noreferrer">Export CSV</a> : null}
              {exportTxtUrl ? <a className="rounded border border-borderSoft px-3 py-2 text-sm text-slate-300 hover:bg-slate-800/60" href={exportTxtUrl} target="_blank" rel="noreferrer">Export TXT</a> : null}
              <button className="inline-flex items-center gap-2 rounded border border-borderSoft px-3 py-2 text-sm text-slate-300 disabled:opacity-50 hover:bg-slate-800/60" disabled={visibleTickers.length === 0} onClick={async () => { await navigator.clipboard.writeText(visibleTickers.join("\n")); setMessage("Tickers copied."); }}>
                <Copy className="h-4 w-4" />
                Copy View
              </button>
            </div>
          </div>
          {message ? <p className="mt-2 text-xs text-slate-400">{message}</p> : null}
        </div>

        {selectedSetId ? (
          <WatchlistResearchPanel
            profiles={profiles}
            selectedProfileId={selectedProfileId}
            onProfileChange={setSelectedProfileId}
            sourceBasis={sourceBasis}
            onSourceBasisChange={setSourceBasis}
            maxTickers={maxTickers}
            onMaxTickersChange={setMaxTickers}
            selectedCount={selectedTickers.length}
            visibleCount={uniqueVisibleTickers.length}
            isRunning={researchRunning}
            onRun={async () => {
              try {
                setResearchRunning(true);
                const run = await createResearchLabRun({
                  tickers: [],
                  sourceType: "watchlist_set",
                  sourceId: selectedSetId,
                  watchlistRunId: selectedRunId,
                  sourceBasis,
                  selectedTickers: selectedTickers.length > 0 ? selectedTickers : undefined,
                  maxTickers,
                  profileId: selectedProfileId,
                });
                void pumpResearchLabRun(run.run.id);
                setResearchRuns((current) => [{
                  run: run.run,
                  profileName: profiles.find((profile) => profile.id === (selectedProfileId ?? ""))?.name ?? null,
                  profileVersionNumber: null,
                  promptConfigName: null,
                  evidenceProfileName: null,
                }, ...current.filter((entry) => entry.run.id !== run.run.id)].slice(0, 12));
                setResearchStatus({
                  run: run.run,
                  items: [],
                  events: [],
                  profile: profiles.find((profile) => profile.id === (selectedProfileId ?? "")) ?? null,
                  profileVersion: null,
                  promptConfig: null,
                  evidenceProfile: null,
                });
                setResearchResults({
                  run: run.run,
                  items: [],
                  profile: profiles.find((profile) => profile.id === (selectedProfileId ?? "")) ?? null,
                  profileVersion: null,
                  promptConfig: null,
                  evidenceProfile: null,
                });
                setSelectedResearchRunId(run.run.id);
                void loadResearchRuns(selectedSetId, run.run.id);
              } catch (error) {
                setResearchRunning(false);
                setMessage(error instanceof Error ? error.message : "Failed to start research-lab run.");
              }
            }}
            runs={researchRuns}
            selectedRunId={selectedResearchRunId}
            onSelectRun={(runId) => { setSelectedResearchRunId(runId); void loadResearchRunDetail(runId); }}
            selectedRunStatus={researchStatus}
            selectedRunResults={researchResults}
            stoppingRun={researchStopping}
            onStopRun={researchStatus && ["queued", "running"].includes(researchStatus.run.status) ? async () => {
              try {
                setResearchStopping(true);
                await cancelResearchLabRun(researchStatus.run.id);
                await loadResearchRunDetail(researchStatus.run.id);
              } finally {
                setResearchStopping(false);
              }
            } : undefined}
          />
        ) : null}

        <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.35fr),minmax(24rem,1fr)]">
          <div className="card p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-2">
                <button className={`rounded px-3 py-1.5 text-xs ${viewMode === "compiled" ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`} onClick={() => setViewMode("compiled")}>Compiled</button>
                <button className={`rounded px-3 py-1.5 text-xs ${viewMode === "unique" ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`} onClick={() => setViewMode("unique")}>Unique Only</button>
              </div>
              <div className="flex items-center gap-3">
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
                      {formatTime(run.ingestedAt)} · {run.compiledRowCount}/{run.uniqueTickerCount}
                    </option>
                  ))}
                </select>
                <div className="text-xs text-slate-500">{selectedTickers.length} selected</div>
              </div>
            </div>
            {detailLoading ? <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Loading rows...</div> : (
              <div className="max-h-[36rem] overflow-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-900/60">
                    <tr>{["", "Ticker", "Company", viewMode === "compiled" ? "Source" : "Occurrences", "Price", "1D"].map((label) => <th key={label} className="px-2 py-1.5 text-left text-slate-300">{label}</th>)}</tr>
                  </thead>
                  <tbody>
                    {(viewMode === "compiled" ? compiledRows : uniqueRows).map((row: any) => (
                      <tr key={row.id ?? row.ticker} className="border-t border-borderSoft/60 hover:bg-slate-900/30">
                        <td className="px-2 py-1.5"><input type="checkbox" checked={selectedTickers.includes(row.ticker)} onChange={() => toggleTickerSelection(row.ticker)} /></td>
                        <td className="px-2 py-1.5 font-semibold text-accent">{row.ticker}</td>
                        <td className="px-2 py-1.5 text-slate-300">{row.displayName ?? "-"}</td>
                        <td className="px-2 py-1.5 text-slate-400">{viewMode === "compiled" ? "-" : row.occurrences}</td>
                        <td className="px-2 py-1.5 text-slate-300">{fmtNumber(viewMode === "compiled" ? row.price : row.latestPrice)}</td>
                        <td className={`px-2 py-1.5 ${((viewMode === "compiled" ? row.change1d : row.latestChange1d) ?? 0) >= 0 ? "text-pos" : "text-neg"}`}>{fmtNumber(viewMode === "compiled" ? row.change1d : row.latestChange1d)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
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
            </div>
          </div>
        </div>

        <section className="space-y-4">
          {(researchResults?.items ?? []).map((itemResult: ResearchLabRunItemResult) => (
            <ResearchLabResultCard
              key={itemResult.item.id}
              itemResult={itemResult}
              actions={<button className="rounded border border-borderSoft px-3 py-2 text-xs text-slate-300 hover:bg-panelSoft/70" onClick={() => void openHistory(itemResult.item.ticker)} type="button">History</button>}
            />
          ))}
        </section>
      </section>

      {historyTicker ? (
        <div className="fixed inset-y-0 right-0 z-40 w-full max-w-xl border-l border-borderSoft/70 bg-panel p-4 shadow-2xl">
          <div className="flex items-center justify-between gap-3">
            <div><div className="text-lg font-semibold text-slate-200">{historyTicker} History</div><div className="text-xs text-slate-500">Stored research-lab outputs</div></div>
            <button className="rounded border border-borderSoft px-3 py-1.5 text-sm text-slate-300" onClick={() => setHistoryTicker(null)} type="button">Close</button>
          </div>
          <div className="mt-4 max-h-[calc(100vh-6rem)] space-y-3 overflow-auto pr-1">
            {historyLoading ? <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Loading history...</div> : historyRows.map((row) => (
              <div key={row.output.id} className="rounded-xl border border-borderSoft/60 bg-panelSoft/35 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-accent">{formatTime(row.output.createdAt)}</div>
                  <div className="text-[11px] text-slate-500">{row.run?.sourceLabel ?? "Research Lab"}</div>
                </div>
                <div className="mt-2 text-sm text-slate-200">{row.output.synthesisJson.overallSummary}</div>
                {row.output.deltaJson?.summary ? <div className="mt-2 rounded-lg border border-borderSoft/50 bg-panel/60 px-3 py-2 text-xs text-slate-300">{row.output.deltaJson.summary}</div> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
