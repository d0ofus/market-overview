"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, Loader2, RefreshCw } from "lucide-react";
import {
  apiUrl,
  compileAdminWatchlistCompilerSet,
  createAdminResearchRun,
  getResearchProfiles,
  getResearchRunResults,
  getResearchRuns,
  getResearchRunStatus,
  getResearchSnapshot,
  getResearchSnapshotCompare,
  getTickerResearchHistory,
  getWatchlistCompilerCompiled,
  getWatchlistCompilerExportUrl,
  getWatchlistCompilerRuns,
  getWatchlistCompilerSet,
  getWatchlistCompilerSets,
  getWatchlistCompilerUnique,
  type ResearchProfileRow,
  type ResearchRunListRow,
  type ResearchRunResultsResponse,
  type ResearchRunStatusResponse,
  type ResearchSnapshotCompareResponse,
  type ResearchSnapshotDetailResponse,
  type ResearchSnapshotRow,
  type ResearchTickerResult,
  type ScanCompiledRow,
  type ScanUniqueTickerRow,
  type WatchlistCompilerRunSummary,
  type WatchlistCompilerSetDetail,
  type WatchlistCompilerSetRow,
} from "@/lib/api";
import { ResearchResultsTable } from "./research-results-table";
import { ResearchRunDrawer } from "./research-run-drawer";
import { ResearchTickerDrawer } from "./research-ticker-drawer";
import { TradingViewWidget } from "./tradingview-widget";
import { WatchlistResearchPanel } from "./watchlist-research-panel";

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
  const [selectedTickers, setSelectedTickers] = useState<string[]>([]);
  const [researchProfiles, setResearchProfiles] = useState<ResearchProfileRow[]>([]);
  const [selectedResearchProfileId, setSelectedResearchProfileId] = useState<string | null>(null);
  const [researchRuns, setResearchRuns] = useState<ResearchRunListRow[]>([]);
  const [selectedResearchRunId, setSelectedResearchRunId] = useState<string | null>(null);
  const [researchStatus, setResearchStatus] = useState<ResearchRunStatusResponse | null>(null);
  const [researchResults, setResearchResults] = useState<ResearchRunResultsResponse | null>(null);
  const [researchRunning, setResearchRunning] = useState(false);
  const [researchSourceBasis, setResearchSourceBasis] = useState<"compiled" | "unique">("unique");
  const [researchRefreshMode, setResearchRefreshMode] = useState<"reuse_fresh_search_cache" | "force_fresh">("reuse_fresh_search_cache");
  const [researchRankingMode, setResearchRankingMode] = useState<"rank_only" | "rank_and_deep_dive">("rank_only");
  const [researchMaxTickers, setResearchMaxTickers] = useState(12);
  const [researchDeepDiveTopN, setResearchDeepDiveTopN] = useState(3);
  const [openResearchTicker, setOpenResearchTicker] = useState<ResearchTickerResult | null>(null);
  const [openResearchDetail, setOpenResearchDetail] = useState<ResearchSnapshotDetailResponse | null>(null);
  const [openResearchHistory, setOpenResearchHistory] = useState<ResearchSnapshotRow[]>([]);
  const [openResearchCompare, setOpenResearchCompare] = useState<ResearchSnapshotCompareResponse | null>(null);
  const [openResearchBaselineId, setOpenResearchBaselineId] = useState<string | null>(null);
  const [openResearchRunDrawer, setOpenResearchRunDrawer] = useState(false);
  const [manualTickerInput, setManualTickerInput] = useState("");

  const selectedSet = useMemo(
    () => sets.find((row) => row.id === selectedSetId) ?? null,
    [sets, selectedSetId],
  );

  const loadResearchProfiles = async () => {
    try {
      const res = await getResearchProfiles();
      const rows = res.rows ?? [];
      setResearchProfiles(rows);
      setSelectedResearchProfileId((current) => current ?? rows.find((row) => row.isDefault)?.id ?? rows[0]?.id ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load research profiles.");
    }
  };

  const loadResearchRuns = async (setId: string, preferredRunId?: string | null) => {
    try {
      const res = await getResearchRuns({ sourceType: "watchlist_set", sourceId: setId, limit: 12 });
      const rows = res.rows ?? [];
      setResearchRuns(rows);
      const nextRunId = preferredRunId ?? selectedResearchRunId ?? rows[0]?.run.id ?? null;
      setSelectedResearchRunId(nextRunId);
      if (nextRunId) {
        const [statusRes, resultsRes] = await Promise.all([
          getResearchRunStatus(nextRunId),
          getResearchRunResults(nextRunId),
        ]);
        setResearchStatus(statusRes);
        setResearchResults(resultsRes);
        setResearchRunning(statusRes.run.status === "queued" || statusRes.run.status === "running");
      } else {
        setResearchStatus(null);
        setResearchResults(null);
        setResearchRunning(false);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load research runs.");
      setResearchRuns([]);
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
      setSelectedTickers([]);
      await loadResearchRuns(setId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load watchlist compiler detail.");
      setDetail(null);
      setRuns([]);
      setCompiledRows([]);
      setUniqueRows([]);
      setResearchRuns([]);
      setResearchStatus(null);
      setResearchResults(null);
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    void loadSets();
    void loadResearchProfiles();
  }, []);

  useEffect(() => {
    if (!selectedSetId) return;
    void loadSelected(selectedSetId, selectedRunId);
  }, [selectedSetId, viewMode]);

  const visibleTickers = useMemo(() => (
    viewMode === "compiled" ? compiledRows.map((row) => row.ticker) : uniqueRows.map((row) => row.ticker)
  ), [compiledRows, uniqueRows, viewMode]);

  const uniqueVisibleTickers = useMemo(
    () => Array.from(new Set(visibleTickers)),
    [visibleTickers],
  );

  useEffect(() => {
    if (!selectedResearchRunId) return;
    let cancelled = false;
    let timer: number | null = null;
    let eventSource: EventSource | null = null;

    const load = async () => {
      try {
        const [statusRes, resultsRes] = await Promise.all([
          getResearchRunStatus(selectedResearchRunId),
          getResearchRunResults(selectedResearchRunId),
        ]);
        if (cancelled) return;
        setResearchStatus(statusRes);
        setResearchResults(resultsRes);
        setResearchRunning(statusRes.run.status === "queued" || statusRes.run.status === "running");
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Failed to load research run.");
      }
    };

    const startPollingFallback = () => {
      if (timer !== null) return;
      timer = window.setInterval(() => {
        void load();
      }, 5000);
    };

    if (researchRunning) {
      eventSource = new EventSource(apiUrl(`/api/research/runs/${encodeURIComponent(selectedResearchRunId)}/stream`));
      eventSource.addEventListener("update", (event) => {
        if (cancelled) return;
        try {
          const payload = JSON.parse((event as MessageEvent).data) as {
            status: ResearchRunStatusResponse;
            results: ResearchRunResultsResponse;
          };
          setResearchStatus(payload.status);
          setResearchResults(payload.results);
          const isStillRunning = payload.status.run.status === "queued" || payload.status.run.status === "running";
          setResearchRunning(isStillRunning);
          if (!isStillRunning) {
            eventSource?.close();
            eventSource = null;
          }
        } catch {
          startPollingFallback();
        }
      });
      eventSource.addEventListener("done", () => {
        if (cancelled) return;
        setResearchRunning(false);
        eventSource?.close();
        eventSource = null;
      });
      eventSource.addEventListener("error", () => {
        eventSource?.close();
        eventSource = null;
        if (!cancelled) startPollingFallback();
      });
      void load();
    } else {
      void load();
    }
    return () => {
      cancelled = true;
      if (eventSource) eventSource.close();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [selectedResearchRunId, researchRunning]);

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

  const parsedManualTickers = useMemo(
    () => Array.from(new Set(manualTickerInput.split(/[\s,;\n\r\t]+/).map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))),
    [manualTickerInput],
  );

  const toggleTickerSelection = (ticker: string) => {
    setSelectedTickers((current) => current.includes(ticker)
      ? current.filter((value) => value !== ticker)
      : [...current, ticker]);
  };

  const openTickerResearch = async (result: ResearchTickerResult) => {
    setOpenResearchTicker(result);
    setOpenResearchDetail(null);
    setOpenResearchHistory([]);
    setOpenResearchCompare(null);
    setOpenResearchBaselineId(null);
    try {
      const [detailRes, historyRes, compareRes] = await Promise.all([
        getResearchSnapshot(result.snapshotId),
        getTickerResearchHistory(result.ticker, researchResults?.run.profileId ?? selectedResearchProfileId),
        getResearchSnapshotCompare(result.snapshotId),
      ]);
      setOpenResearchDetail(detailRes);
      setOpenResearchHistory(historyRes.rows ?? []);
      setOpenResearchCompare(compareRes);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load research detail.");
    }
  };

  useEffect(() => {
    if (!openResearchTicker) return;
    let cancelled = false;
    const loadCompare = async () => {
      try {
        const compareRes = await getResearchSnapshotCompare(openResearchTicker.snapshotId, openResearchBaselineId);
        if (!cancelled) setOpenResearchCompare(compareRes);
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Failed to load snapshot comparison.");
      }
    };
    void loadCompare();
    return () => {
      cancelled = true;
    };
  }, [openResearchTicker, openResearchBaselineId]);

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

        {selectedSetId && (
          <WatchlistResearchPanel
            profiles={researchProfiles}
            selectedProfileId={selectedResearchProfileId}
            onProfileChange={setSelectedResearchProfileId}
            sourceBasis={researchSourceBasis}
            onSourceBasisChange={setResearchSourceBasis}
            refreshMode={researchRefreshMode}
            onRefreshModeChange={setResearchRefreshMode}
            rankingMode={researchRankingMode}
            onRankingModeChange={setResearchRankingMode}
            maxTickers={researchMaxTickers}
            onMaxTickersChange={setResearchMaxTickers}
            deepDiveTopN={researchDeepDiveTopN}
            onDeepDiveTopNChange={setResearchDeepDiveTopN}
            selectedCount={selectedTickers.length}
            visibleCount={uniqueVisibleTickers.length}
            isRunning={researchRunning}
            onRun={async () => {
              if (!selectedSetId) return;
              try {
                setResearchRunning(true);
                const run = await createAdminResearchRun({
                  sourceType: "watchlist_set",
                  sourceId: selectedSetId,
                  watchlistRunId: selectedRunId,
                  sourceBasis: researchSourceBasis,
                  selectedTickers: selectedTickers.length > 0 ? selectedTickers : undefined,
                  profileId: selectedResearchProfileId,
                  maxTickers: researchMaxTickers,
                  refreshMode: researchRefreshMode,
                  rankingMode: researchRankingMode,
                  deepDiveTopN: researchRankingMode === "rank_and_deep_dive" ? researchDeepDiveTopN : 0,
                });
                setSelectedResearchRunId(run.run.id);
                await loadResearchRuns(selectedSetId, run.run.id);
                setMessage(`Research run started for ${run.run.requestedTickerCount} ticker${run.run.requestedTickerCount === 1 ? "" : "s"}.`);
              } catch (error) {
                setResearchRunning(false);
                setMessage(error instanceof Error ? error.message : "Failed to start research run.");
              }
            }}
            runs={researchRuns}
            selectedRunId={selectedResearchRunId}
            onSelectRun={setSelectedResearchRunId}
            selectedRunStatus={researchStatus}
            selectedRunResults={researchResults}
            selectedRunErrorDetail={researchStatus?.tickers.find((row) => row.lastError)?.lastError ?? null}
            onOpenRunDrawer={() => setOpenResearchRunDrawer(true)}
            manualTickerInput={manualTickerInput}
            onManualTickerInputChange={setManualTickerInput}
            onRunManual={async () => {
              try {
                setResearchRunning(true);
                const run = await createAdminResearchRun({
                  sourceType: "manual",
                  sourceLabel: selectedSet?.name ? `${selectedSet.name} Manual` : "Manual Research Run",
                  tickers: parsedManualTickers,
                  profileId: selectedResearchProfileId,
                  maxTickers: researchMaxTickers,
                  refreshMode: researchRefreshMode,
                  rankingMode: researchRankingMode,
                  deepDiveTopN: researchRankingMode === "rank_and_deep_dive" ? researchDeepDiveTopN : 0,
                });
                setSelectedResearchRunId(run.run.id);
                setManualTickerInput("");
                const statusRes = await getResearchRunStatus(run.run.id);
                const resultsRes = await getResearchRunResults(run.run.id);
                setResearchStatus(statusRes);
                setResearchResults(resultsRes);
                setMessage(`Manual research run started for ${run.run.requestedTickerCount} ticker${run.run.requestedTickerCount === 1 ? "" : "s"}.`);
              } catch (error) {
                setResearchRunning(false);
                setMessage(error instanceof Error ? error.message : "Failed to start manual research run.");
              }
            }}
          />
        )}

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
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded border border-borderSoft/60 bg-panelSoft/35 px-3 py-2 text-xs text-slate-400">
                <div>{selectedTickers.length} selected</div>
                <div className="flex gap-2">
                  <button className="rounded border border-borderSoft px-2 py-1 hover:bg-panelSoft/70" onClick={() => setSelectedTickers(uniqueVisibleTickers)} type="button">
                    Select Visible
                  </button>
                  <button className="rounded border border-borderSoft px-2 py-1 hover:bg-panelSoft/70" onClick={() => setSelectedTickers([])} type="button">
                    Clear
                  </button>
                </div>
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
                        {["", "Ticker", "Company", "Source", "Price", "1D"].map((label) => (
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
                            <td className="px-2 py-1.5">
                              <input type="checkbox" checked={selectedTickers.includes(row.ticker)} onChange={() => toggleTickerSelection(row.ticker)} />
                            </td>
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
                          <td colSpan={6} className="px-2 py-4 text-center text-slate-400">No compiled rows yet.</td>
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
                        {["", "Ticker", "Company", "Occurrences", "Price", "1D"].map((label) => (
                          <th key={label} className="px-2 py-1.5 text-left text-slate-300">{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {uniqueRows.map((row) => (
                        <tr key={row.ticker} className="border-t border-borderSoft/60 hover:bg-slate-900/30">
                          <td className="px-2 py-1.5">
                            <input type="checkbox" checked={selectedTickers.includes(row.ticker)} onChange={() => toggleTickerSelection(row.ticker)} />
                          </td>
                          <td className="px-2 py-1.5 font-semibold text-accent">{row.ticker}</td>
                          <td className="px-2 py-1.5 text-slate-300">{row.displayName ?? "-"}</td>
                          <td className="px-2 py-1.5 text-slate-300">{row.occurrences}</td>
                          <td className="px-2 py-1.5 text-slate-300">{fmtNumber(row.latestPrice)}</td>
                          <td className={`px-2 py-1.5 ${(row.latestChange1d ?? 0) >= 0 ? "text-pos" : "text-neg"}`}>{fmtNumber(row.latestChange1d)}</td>
                        </tr>
                      ))}
                      {uniqueRows.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-2 py-4 text-center text-slate-400">No unique tickers yet.</td>
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

        <ResearchResultsTable
          results={researchResults?.results ?? []}
          onOpenTicker={(result) => {
            void openTickerResearch(result);
          }}
        />
        {researchStatus && (researchStatus.run.status === "failed" || researchStatus.run.status === "partial") ? (
          <div className="card border-red-500/20 bg-red-500/5 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-red-100">Selected Run Error</h3>
                <p className="mt-1 text-xs text-red-200/90">
                  {researchStatus.run.errorSummary ?? researchStatus.tickers.find((row) => row.lastError)?.lastError ?? "This run did not complete successfully."}
                </p>
              </div>
              <button
                className="rounded border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-100 hover:bg-red-500/10"
                onClick={() => setOpenResearchRunDrawer(true)}
                type="button"
              >
                Open Details
              </button>
            </div>
          </div>
        ) : null}
      </section>
      <ResearchRunDrawer
        open={openResearchRunDrawer}
        status={researchStatus}
        results={researchResults}
        onClose={() => setOpenResearchRunDrawer(false)}
      />
      <ResearchTickerDrawer
        open={Boolean(openResearchTicker)}
        result={openResearchTicker}
        detail={openResearchDetail}
        history={openResearchHistory}
        compare={openResearchCompare}
        baselineSnapshotId={openResearchBaselineId}
        onBaselineChange={setOpenResearchBaselineId}
        onClose={() => {
          setOpenResearchTicker(null);
          setOpenResearchBaselineId(null);
        }}
      />
    </div>
  );
}
