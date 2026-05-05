"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, KeyRound, Loader2, Plus, RefreshCw, Search, Trash2, XCircle } from "lucide-react";
import {
  createSocialAlertHandle,
  deleteSocialAlertCredential,
  getSocialAlertHandles,
  getSocialAlertHealth,
  getSocialAlertResults,
  runSocialAlertScrape,
  saveSocialAlertCredential,
  type SocialAlertHealthResponse,
  type SocialAlertMetrics,
  type SocialAlertResultRow,
  type SocialAlertResultsResponse,
  type SocialAlertSourceRow,
} from "@/lib/api";
import { ChartGridPager } from "./chart-grid-pager";
import { TickerMultiGrid, type TickerMultiGridItem } from "./ticker-multi-grid";

const QUICK_PRESETS = [1, 3, 7, 14, 30] as const;
const DEFAULT_LIMIT_PER_HANDLE = 25;
const MAX_LIMIT_PER_HANDLE = 100;
const MAX_HANDLES_PER_RUN = 10;
const DEFAULT_CHARTS_PER_PAGE = 12;

const INPUT_CLASS =
  "mt-1 w-full rounded-lg border border-borderSoft/80 bg-panelSoft/80 px-2.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60";
const BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-borderSoft/80 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800/60 disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-accent/40 bg-accent/15 px-2.5 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60";
const DANGER_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-500/40 px-2.5 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50";
const EMPTY_METRICS: SocialAlertMetrics = { tweets: 0, cashtagHits: 0, uniqueTickers: 0, failures: 0, runtimeMs: 0 };

function localIsoDate(value = new Date()) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function addDays(isoDate: string, days: number) {
  const value = new Date(`${isoDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

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

function formatRuntime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function statusLabel(status: string | null | undefined): string {
  if (!status) return "Unknown";
  return status.replace(/_/g, " ").replace(/\b\w/g, (value) => value.toUpperCase());
}

function statusClass(status: string | null | undefined): string {
  if (status === "working") return "border-pos/40 bg-pos/10 text-pos";
  if (status === "configured") return "border-accent/40 bg-accent/10 text-accent";
  if (status === "missing_token") return "border-warning/40 bg-warning/10 text-warning";
  return "border-red-500/40 bg-red-500/10 text-red-300";
}

function metricItems(metrics: SocialAlertMetrics) {
  return [
    ["Tweets", String(metrics.tweets)],
    ["Cashtag hits", String(metrics.cashtagHits)],
    ["Unique tickers", String(metrics.uniqueTickers)],
    ["Failures", String(metrics.failures)],
    ["Runtime", formatRuntime(metrics.runtimeMs)],
  ];
}

function countTickerMentions(rows: SocialAlertResultRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const ticker of row.cashtags) {
      counts.set(ticker, (counts.get(ticker) ?? 0) + 1);
    }
  }
  return counts;
}

export function SocialAlertsDashboard() {
  const [handles, setHandles] = useState<SocialAlertSourceRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [newHandle, setNewHandle] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [health, setHealth] = useState<SocialAlertHealthResponse | null>(null);
  const [results, setResults] = useState<SocialAlertResultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingToken, setSavingToken] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const [startDate, setStartDate] = useState(addDays(localIsoDate(), -1));
  const [limitPerHandle, setLimitPerHandle] = useState(DEFAULT_LIMIT_PER_HANDLE);
  const [mode, setMode] = useState<"table" | "charts">("table");
  const [tickerFilter, setTickerFilter] = useState("");
  const [textFilter, setTextFilter] = useState("");
  const [handleFilter, setHandleFilter] = useState("");
  const [chartPage, setChartPage] = useState(1);
  const [chartsPerPage, setChartsPerPage] = useState(DEFAULT_CHARTS_PER_PAGE);

  const load = useCallback(async (options?: { probe?: boolean; silent?: boolean }) => {
    if (!options?.silent) setLoading(true);
    try {
      const [handlesRes, healthRes, resultsRes] = await Promise.all([
        getSocialAlertHandles(),
        getSocialAlertHealth({ probe: options?.probe }),
        getSocialAlertResults({ limit: 500, offset: 0 }),
      ]);
      setHandles(handlesRes.rows);
      setHealth(healthRes);
      setResults(resultsRes);
      setSelectedIds((current) => {
        const activeIds = handlesRes.rows.filter((row) => row.isActive).map((row) => row.id);
        if (current.size > 0) {
          return new Set(Array.from(current).filter((id) => activeIds.includes(id)));
        }
        return new Set(activeIds.slice(0, MAX_HANDLES_PER_RUN));
      });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to load social alerts." });
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeHandles = useMemo(() => handles.filter((row) => row.isActive), [handles]);
  const selectedHandles = useMemo(
    () => activeHandles.filter((row) => selectedIds.has(row.id)),
    [activeHandles, selectedIds],
  );
  const allSelected = activeHandles.length > 0 && activeHandles.slice(0, MAX_HANDLES_PER_RUN).every((row) => selectedIds.has(row.id));
  const metrics = results?.metrics ?? EMPTY_METRICS;
  const rows = results?.rows ?? [];
  const tickerCounts = useMemo(() => countTickerMentions(rows), [rows]);
  const chartTickers = useMemo(() => {
    const tickers = results?.uniqueTickers ?? [];
    return [...tickers].sort((left, right) => (tickerCounts.get(right) ?? 0) - (tickerCounts.get(left) ?? 0) || left.localeCompare(right));
  }, [results?.uniqueTickers, tickerCounts]);
  const chartItems = useMemo<TickerMultiGridItem[]>(() => {
    const start = (chartPage - 1) * chartsPerPage;
    return chartTickers.slice(start, start + chartsPerPage).map((ticker) => ({
      key: ticker,
      ticker,
      title: ticker,
      subtitle: `${tickerCounts.get(ticker) ?? 0} mention${(tickerCounts.get(ticker) ?? 0) === 1 ? "" : "s"}`,
      popupTitle: ticker,
      popupSubtitle: `${tickerCounts.get(ticker) ?? 0} Social Alert mention${(tickerCounts.get(ticker) ?? 0) === 1 ? "" : "s"}`,
    }));
  }, [chartPage, chartTickers, chartsPerPage, tickerCounts]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(chartTickers.length / chartsPerPage));
    if (chartPage > totalPages) setChartPage(totalPages);
  }, [chartPage, chartTickers.length, chartsPerPage]);

  const applyPreset = (days: number) => {
    setStartDate(addDays(localIsoDate(), -days));
  };

  const addHandle = async () => {
    if (!newHandle.trim()) return;
    try {
      const res = await createSocialAlertHandle(newHandle);
      setNewHandle("");
      setMessage({ tone: "success", text: `Added @${res.row.handle}.` });
      await load({ silent: true });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to add handle." });
    }
  };

  const applyFilters = async () => {
    try {
      const next = await getSocialAlertResults({
        ticker: tickerFilter.trim() || undefined,
        handle: handleFilter.trim() || undefined,
        q: textFilter.trim() || undefined,
        limit: 500,
        offset: 0,
      });
      setResults(next);
      setChartPage(1);
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to apply filters." });
    }
  };

  const saveToken = async () => {
    if (!authToken.trim()) return;
    setSavingToken(true);
    try {
      const res = await saveSocialAlertCredential(authToken.trim(), true);
      setAuthToken("");
      setHealth({
        status: res.status,
        tokenConfigured: res.ok,
        tokenLast4: res.tokenLast4,
        functionReachable: res.status !== "function_unreachable" && res.status !== "missing_config",
        lastValidatedAt: res.status === "working" ? res.updatedAt : null,
        updatedAt: res.updatedAt,
        message: res.message,
      });
      setMessage({ tone: res.ok ? "success" : "danger", text: res.ok ? "Scweet token saved and tested." : (res.message ?? "Scweet token test failed.") });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to save Scweet token." });
    } finally {
      setSavingToken(false);
    }
  };

  const clearToken = async () => {
    try {
      await deleteSocialAlertCredential();
      setAuthToken("");
      await load({ silent: true });
      setMessage({ tone: "info", text: "Scweet token cleared." });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to clear Scweet token." });
    }
  };

  const runScrape = async () => {
    setRunning(true);
    setMessage(null);
    try {
      const res = await runSocialAlertScrape({
        allHandles: false,
        handleIds: selectedHandles.map((row) => row.id),
        startDate,
        limitPerHandle,
      });
      setMessage({
        tone: res.ok ? "success" : "danger",
        text: res.ok
          ? `Scrape completed: ${res.metrics.tweets} tweets, ${res.metrics.uniqueTickers} unique tickers.`
          : (res.authStatus.message ?? "Scrape failed."),
      });
      await load({ silent: true });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to run Scweet scrape." });
    } finally {
      setRunning(false);
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_HANDLES_PER_RUN) next.add(id);
      return next;
    });
  };

  const canRun = health?.status === "working" && selectedHandles.length > 0 && !running;

  if (loading) {
    return (
      <div className="card flex items-center gap-2 p-4 text-sm text-slate-300">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading social alerts...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {message ? (
        <div className={`rounded-2xl border p-3 text-sm ${
          message.tone === "success"
            ? "border-pos/40 bg-pos/10 text-pos"
            : message.tone === "danger"
              ? "border-red-500/40 bg-red-500/10 text-red-300"
              : "border-accent/40 bg-accent/10 text-accent"
        }`}>
          {message.text}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr),minmax(22rem,0.9fr)]">
        <section className="card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Scweet Access</h3>
              <p className="mt-1 text-xs text-slate-400">Paste the dedicated X account auth_token when it needs to be added or refreshed.</p>
            </div>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${statusClass(health?.status)}`}>
              {health?.status === "working" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
              {statusLabel(health?.status)}
            </span>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr),auto]">
            <label className="text-xs text-slate-300">
              Auth token
              <input
                className={INPUT_CLASS}
                type="password"
                value={authToken}
                onChange={(event) => setAuthToken(event.target.value)}
                placeholder="Paste auth_token"
                autoComplete="off"
              />
            </label>
            <div className="flex items-end gap-2">
              <button className={PRIMARY_BUTTON_CLASS} disabled={!authToken.trim() || savingToken} onClick={() => void saveToken()} type="button">
                {savingToken ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                Save & Test
              </button>
              <button className={BUTTON_CLASS} disabled={savingToken} onClick={() => void load({ probe: true, silent: true })} type="button">
                <RefreshCw className="h-3.5 w-3.5" />
                Re-test
              </button>
              <button className={DANGER_BUTTON_CLASS} disabled={!health?.tokenConfigured} onClick={() => void clearToken()} type="button">
                <Trash2 className="h-3.5 w-3.5" />
                Clear
              </button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-400">
            <span>Token: {health?.tokenLast4 ? `****${health.tokenLast4}` : "-"}</span>
            <span>Last test: {formatDateTime(health?.lastValidatedAt)}</span>
            <span>Function: {health?.functionReachable ? "reachable" : "not ready"}</span>
            {health?.message ? <span className="text-warning">{health.message}</span> : null}
          </div>
        </section>

        <section className="card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Source Handles</h3>
              <p className="mt-1 text-xs text-slate-400">Select up to {MAX_HANDLES_PER_RUN} saved public handles per scrape.</p>
            </div>
            <div className="flex gap-2">
              <button
                className={BUTTON_CLASS}
                onClick={() => setSelectedIds(allSelected ? new Set<string>() : new Set(activeHandles.slice(0, MAX_HANDLES_PER_RUN).map((row) => row.id)))}
                type="button"
              >
                {allSelected ? "Clear" : "Select All"}
              </button>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-lg border border-borderSoft/80 bg-panelSoft/80 px-2.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              value={newHandle}
              onChange={(event) => setNewHandle(event.target.value)}
              placeholder="@handle or x.com/handle"
              onKeyDown={(event) => {
                if (event.key === "Enter") void addHandle();
              }}
            />
            <button className={PRIMARY_BUTTON_CLASS} disabled={!newHandle.trim()} onClick={() => void addHandle()} type="button">
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>
          <div className="mt-3 max-h-56 space-y-2 overflow-auto pr-1">
            {activeHandles.map((row) => (
              <label key={row.id} className="flex cursor-pointer items-start gap-2 rounded-lg border border-borderSoft/60 bg-panelSoft/25 p-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selectedIds.has(row.id)}
                  onChange={() => toggleSelected(row.id)}
                  disabled={!selectedIds.has(row.id) && selectedIds.size >= MAX_HANDLES_PER_RUN}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-semibold text-slate-100">@{row.handle}</span>
                  <span className="ml-2 text-xs text-slate-500">{row.lastScrapedAt ? `Last ${formatDateTime(row.lastScrapedAt)}` : "Not scraped yet"}</span>
                  {row.lastError ? <span className="mt-1 block text-xs text-red-300">{row.lastError}</span> : null}
                </span>
              </label>
            ))}
            {activeHandles.length === 0 ? (
              <div className="rounded-lg border border-borderSoft/60 bg-panelSoft/25 p-3 text-sm text-slate-400">No saved handles yet.</div>
            ) : null}
          </div>
        </section>
      </div>

      <section className="card p-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(12rem,0.8fr),minmax(10rem,0.6fr),minmax(0,1fr),auto]">
          <label className="text-xs text-slate-300">
            Start date
            <input className={INPUT_CLASS} type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </label>
          <label className="text-xs text-slate-300">
            Limit per handle
            <input
              className={INPUT_CLASS}
              type="number"
              min={1}
              max={MAX_LIMIT_PER_HANDLE}
              value={limitPerHandle}
              onChange={(event) => setLimitPerHandle(Math.max(1, Math.min(MAX_LIMIT_PER_HANDLE, Number(event.target.value) || DEFAULT_LIMIT_PER_HANDLE)))}
            />
          </label>
          <div className="text-xs text-slate-300">
            Days before today
            <div className="mt-1 flex flex-wrap gap-2">
              {QUICK_PRESETS.map((days) => (
                <button
                  key={days}
                  className={`rounded-lg px-3 py-2 text-xs ${startDate === addDays(localIsoDate(), -days) ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                  onClick={() => applyPreset(days)}
                  type="button"
                >
                  {days}D
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-end">
            <button className={PRIMARY_BUTTON_CLASS} disabled={!canRun} onClick={() => void runScrape()} type="button">
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {running ? "Scraping..." : "Run Scweet Scrape"}
            </button>
          </div>
        </div>
        <div className="mt-3 text-xs text-slate-400">
          Selected {selectedHandles.length} handle{selectedHandles.length === 1 ? "" : "s"}. Scweet runs on demand only.
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {metricItems(metrics).map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-borderSoft/70 bg-panel/80 p-3">
            <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">{label}</div>
            <div className="mt-1 text-xl font-semibold text-slate-100">{value}</div>
          </div>
        ))}
      </section>

      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Results</h3>
            <p className="mt-1 text-xs text-slate-400">
              {results?.run ? `Run ${results.run.id.slice(0, 8)} from ${formatDateTime(results.run.createdAt)}` : "No scrape run yet."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className={`${mode === "table" ? PRIMARY_BUTTON_CLASS : BUTTON_CLASS}`} onClick={() => setMode("table")} type="button">Table</button>
            <button className={`${mode === "charts" ? PRIMARY_BUTTON_CLASS : BUTTON_CLASS}`} onClick={() => setMode("charts")} type="button">Multi Grid</button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="text-xs text-slate-300">
            Ticker
            <input className={INPUT_CLASS} value={tickerFilter} onChange={(event) => setTickerFilter(event.target.value.toUpperCase())} placeholder="NVDA" />
          </label>
          <label className="text-xs text-slate-300">
            Handle
            <input className={INPUT_CLASS} value={handleFilter} onChange={(event) => setHandleFilter(event.target.value)} placeholder="handle" />
          </label>
          <label className="text-xs text-slate-300">
            Text
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 h-3.5 w-3.5 text-slate-500" />
              <input className={`${INPUT_CLASS} pl-9`} value={textFilter} onChange={(event) => setTextFilter(event.target.value)} placeholder="breakout" />
            </div>
          </label>
        </div>
        <div className="mt-3 flex justify-end">
          <button className={BUTTON_CLASS} onClick={() => void applyFilters()} type="button">
            <RefreshCw className="h-3.5 w-3.5" />
            Apply Filters
          </button>
        </div>

        {mode === "table" ? (
          <div className="mt-4 overflow-auto rounded-xl border border-borderSoft/70">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/60">
                <tr>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">Cashtags</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">Text</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">URL</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">Handle</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">Time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t border-borderSoft/60 align-top">
                    <td className="px-3 py-3">
                      <div className="flex max-w-[14rem] flex-wrap gap-1">
                        {row.cashtags.map((ticker) => (
                          <span key={`${row.id}-${ticker}`} className="rounded bg-accent/15 px-2 py-1 text-xs font-semibold text-accent">
                            ${ticker}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="max-w-2xl px-3 py-3 text-slate-300">{row.text}</td>
                    <td className="max-w-xs px-3 py-3">
                      <a className="break-all text-accent hover:underline" href={row.url} target="_blank" rel="noreferrer">
                        {row.url}
                      </a>
                    </td>
                    <td className="px-3 py-3 text-slate-300">@{row.handle}</td>
                    <td className="px-3 py-3 text-slate-400">{formatDateTime(row.tweetCreatedAt ?? row.lastSeenAt)}</td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-sm text-slate-400">
                      {results?.run ? "No cashtag posts match the current filters." : "Run a scrape to populate Social Alerts."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-borderSoft/70 bg-panelSoft/30 p-3">
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <span>Charts per page</span>
                <input
                  type="number"
                  min={1}
                  max={48}
                  className="w-20 rounded border border-borderSoft bg-panelSoft px-2 py-1 text-sm"
                  value={chartsPerPage}
                  onChange={(event) => {
                    setChartsPerPage(Math.max(1, Math.min(48, Number(event.target.value) || DEFAULT_CHARTS_PER_PAGE)));
                    setChartPage(1);
                  }}
                />
              </label>
              <ChartGridPager
                totalItems={chartTickers.length}
                page={chartPage}
                pageSize={chartsPerPage}
                itemLabel="tickers"
                onPageChange={setChartPage}
              />
            </div>
            <TickerMultiGrid
              title={`Social Alerts Multi-Chart (${chartTickers.length} ticker${chartTickers.length === 1 ? "" : "s"})`}
              items={chartItems}
              emptyMessage="No unique cashtag tickers are available for the current scrape."
              showChartStatusLine
              enableChartPopup
            />
            <div className="flex justify-end px-1">
              <ChartGridPager
                totalItems={chartTickers.length}
                page={chartPage}
                pageSize={chartsPerPage}
                itemLabel="tickers"
                onPageChange={setChartPage}
              />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
