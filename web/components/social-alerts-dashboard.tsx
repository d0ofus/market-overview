"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Ban, CheckCircle2, ChevronDown, ChevronUp, Clock, KeyRound, Loader2, Maximize2, Plus, RefreshCw, Search, Trash2, XCircle } from "lucide-react";
import {
  createSocialAlertBlacklistEntry,
  createSocialAlertHandle,
  deleteSocialAlertBlacklistEntry,
  deleteSocialAlertCredential,
  getSocialAlertHandles,
  getSocialAlertHealth,
  getSocialAlertResults,
  getSocialAlertSettings,
  runSocialAlertScrape,
  saveSocialAlertCredential,
  updateSocialAlertSettings,
  type SocialAlertBlacklistedCashtagRow,
  type SocialAlertHealthResponse,
  type SocialAlertMention,
  type SocialAlertMetrics,
  type SocialAlertResultsResponse,
  type SocialAlertSettings,
  type SocialAlertSourceRow,
  type SocialAlertTickerSummary,
} from "@/lib/api";
import { ChartGridPager } from "./chart-grid-pager";
import { TradingViewWidget } from "./tradingview-widget";

const SCRAPE_PRESETS = [1, 3, 7, 14, 30] as const;
const LOG_PRESETS = [1, 3, 7, 10] as const;
const DEFAULT_LIMIT_PER_HANDLE = 50;
const MAX_LIMIT_PER_HANDLE = 500;
const MAX_HANDLES_PER_RUN = 10;
const DEFAULT_CHARTS_PER_PAGE = 12;
const DEFAULT_LOG_LOOKBACK_DAYS = 10;

const INPUT_CLASS =
  "mt-1 w-full rounded-lg border border-borderSoft/80 bg-panelSoft/80 px-2.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60";
const BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-borderSoft/80 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800/60 disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-accent/40 bg-accent/15 px-2.5 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60";
const DANGER_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-500/40 px-2.5 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50";
const EMPTY_METRICS: SocialAlertMetrics = { tweets: 0, cashtagHits: 0, uniqueTickers: 0, failures: 0, runtimeMs: 0 };
const LATEST_POST_TEXT_STYLE: CSSProperties = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};
const DEFAULT_SETTINGS: SocialAlertSettings = {
  id: "default",
  dailyScrapeEnabled: false,
  dailyScrapeTimeLocal: "10:00",
  dailyScrapeTimezone: "Australia/Melbourne",
  dailyScrapeLookbackDays: 1,
  updatedAt: "",
};

function localIsoDate(value = new Date()) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function addDays(isoDate: string, days: number) {
  const value = new Date(`${isoDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function rangeStartDate(endDate: string, days: number) {
  return addDays(endDate, -(days - 1));
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

function normalizeCashtagInput(value: string): string {
  return value.trim().replace(/^\$+/, "").toUpperCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightedCashtagText({ text, ticker }: { text: string; ticker: string }) {
  const normalized = normalizeCashtagInput(ticker);
  if (!normalized) return <>{text}</>;
  const pattern = new RegExp(`(\\$${escapeRegExp(normalized)})(?![A-Za-z0-9._-])`, "gi");
  return (
    <>
      {text.split(pattern).map((part, index) => {
        if (part.toUpperCase() === `$${normalized}`) {
          return <strong key={`${part}-${index}`} className="font-semibold text-slate-100">{part}</strong>;
        }
        return part;
      })}
    </>
  );
}

function MentionList({ mentions, ticker, compact = false }: { mentions: SocialAlertMention[]; ticker: string; compact?: boolean }) {
  return (
    <div className="space-y-2">
      {mentions.map((mention) => (
        <article key={`${mention.postId}-${mention.handle}`} className="rounded border border-borderSoft/60 bg-panelSoft/25 p-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
            <span className="font-semibold text-slate-300">@{mention.handle}</span>
            <span>{formatDateTime(mention.tweetCreatedAt ?? mention.lastSeenAt)}</span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-300">
            <HighlightedCashtagText text={mention.text} ticker={ticker} />
          </p>
          {!compact ? (
            <a className="mt-1 block break-all text-[11px] text-accent hover:underline" href={mention.url} target="_blank" rel="noreferrer">
              {mention.url}
            </a>
          ) : null}
        </article>
      ))}
    </div>
  );
}

export function SocialAlertsDashboard() {
  const [handles, setHandles] = useState<SocialAlertSourceRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [newHandle, setNewHandle] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [health, setHealth] = useState<SocialAlertHealthResponse | null>(null);
  const [settings, setSettings] = useState<SocialAlertSettings>(DEFAULT_SETTINGS);
  const [results, setResults] = useState<SocialAlertResultsResponse | null>(null);
  const [blacklist, setBlacklist] = useState<SocialAlertBlacklistedCashtagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingToken, setSavingToken] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingBlacklist, setSavingBlacklist] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const [startDate, setStartDate] = useState(addDays(localIsoDate(), -1));
  const [limitPerHandle, setLimitPerHandle] = useState(DEFAULT_LIMIT_PER_HANDLE);
  const [mode, setMode] = useState<"table" | "charts">("charts");
  const [tickerFilter, setTickerFilter] = useState("");
  const [textFilter, setTextFilter] = useState("");
  const [handleFilter, setHandleFilter] = useState("");
  const [logEndDate, setLogEndDate] = useState(localIsoDate());
  const [logLookbackDays, setLogLookbackDays] = useState(DEFAULT_LOG_LOOKBACK_DAYS);
  const [chartPage, setChartPage] = useState(1);
  const [chartsPerPage, setChartsPerPage] = useState(DEFAULT_CHARTS_PER_PAGE);
  const [expandedMentions, setExpandedMentions] = useState<Set<string>>(new Set());
  const [expandedLatestDescriptions, setExpandedLatestDescriptions] = useState<Set<string>>(new Set());
  const [activeChartSummary, setActiveChartSummary] = useState<SocialAlertTickerSummary | null>(null);
  const [blacklistTicker, setBlacklistTicker] = useState("");
  const [blacklistReason, setBlacklistReason] = useState("");

  const logStartDate = useMemo(() => rangeStartDate(logEndDate, logLookbackDays), [logEndDate, logLookbackDays]);

  const loadResults = useCallback(async (overrides?: Partial<{ ticker: string; handle: string; text: string; startDate: string; endDate: string; lookbackDays: number }>) => {
    const nextFilters = {
      ticker: overrides?.ticker ?? tickerFilter,
      handle: overrides?.handle ?? handleFilter,
      text: overrides?.text ?? textFilter,
      startDate: overrides?.startDate ?? logStartDate,
      endDate: overrides?.endDate ?? logEndDate,
      lookbackDays: overrides?.lookbackDays ?? logLookbackDays,
    };
    const next = await getSocialAlertResults({
      ticker: nextFilters.ticker.trim() || undefined,
      handle: nextFilters.handle.trim() || undefined,
      q: nextFilters.text.trim() || undefined,
      startDate: nextFilters.startDate,
      endDate: nextFilters.endDate,
      lookbackDays: nextFilters.lookbackDays,
      limit: 500,
      offset: 0,
    });
    setResults(next);
    setBlacklist(next.blacklist ?? []);
    setChartPage(1);
  }, [handleFilter, logEndDate, logLookbackDays, logStartDate, textFilter, tickerFilter]);

  const load = useCallback(async (options?: { probe?: boolean; silent?: boolean }) => {
    if (!options?.silent) setLoading(true);
    try {
      const [handlesRes, healthRes, settingsRes, resultsRes] = await Promise.all([
        getSocialAlertHandles(),
        getSocialAlertHealth({ probe: options?.probe }),
        getSocialAlertSettings(),
        getSocialAlertResults({ startDate: logStartDate, endDate: logEndDate, lookbackDays: logLookbackDays, limit: 500, offset: 0 }),
      ]);
      setHandles(handlesRes.rows);
      setHealth(healthRes);
      setSettings(settingsRes);
      setResults(resultsRes);
      setBlacklist(resultsRes.blacklist ?? []);
      setSelectedIds((current) => {
        const activeIds = handlesRes.rows.filter((row) => row.isActive).map((row) => row.id);
        if (current.size > 0) return new Set(Array.from(current).filter((id) => activeIds.includes(id)));
        return new Set(activeIds.slice(0, MAX_HANDLES_PER_RUN));
      });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to load social alerts." });
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [logEndDate, logLookbackDays, logStartDate]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeHandles = useMemo(() => handles.filter((row) => row.isActive), [handles]);
  const selectedHandles = useMemo(() => activeHandles.filter((row) => selectedIds.has(row.id)), [activeHandles, selectedIds]);
  const allSelected = activeHandles.length > 0 && activeHandles.slice(0, MAX_HANDLES_PER_RUN).every((row) => selectedIds.has(row.id));
  const metrics = results?.metrics ?? EMPTY_METRICS;
  const rows = results?.rows ?? [];
  const tickerSummaries = results?.tickerSummaries ?? [];
  const visibleSummaries = useMemo(() => tickerSummaries.slice((chartPage - 1) * chartsPerPage, chartPage * chartsPerPage), [chartPage, chartsPerPage, tickerSummaries]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(tickerSummaries.length / chartsPerPage));
    if (chartPage > totalPages) setChartPage(totalPages);
  }, [chartPage, chartsPerPage, tickerSummaries.length]);

  const applyScrapePreset = (days: number) => setStartDate(addDays(localIsoDate(), -days));
  const applyLogPreset = (days: number) => {
    const endDate = localIsoDate();
    const start = rangeStartDate(endDate, days);
    setLogLookbackDays(days);
    setLogEndDate(endDate);
    void loadResults({ startDate: start, endDate, lookbackDays: days });
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
      await loadResults();
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

  const saveScheduleSettings = async () => {
    setSavingSettings(true);
    try {
      const res = await updateSocialAlertSettings({
        dailyScrapeEnabled: settings.dailyScrapeEnabled,
        dailyScrapeTimeLocal: settings.dailyScrapeTimeLocal,
        dailyScrapeTimezone: settings.dailyScrapeTimezone,
        dailyScrapeLookbackDays: settings.dailyScrapeLookbackDays,
      });
      setSettings(res.settings);
      setMessage({ tone: "success", text: "Saved Social Alerts schedule settings." });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to save schedule settings." });
    } finally {
      setSavingSettings(false);
    }
  };

  const addBlacklist = async () => {
    const ticker = normalizeCashtagInput(blacklistTicker);
    if (!ticker) return;
    setSavingBlacklist(true);
    try {
      const res = await createSocialAlertBlacklistEntry(ticker, blacklistReason.trim() || null);
      setBlacklist((current) => [...current.filter((row) => row.ticker !== res.row.ticker), res.row].sort((left, right) => left.ticker.localeCompare(right.ticker)));
      await loadResults();
      setBlacklistTicker("");
      setBlacklistReason("");
      setMessage({ tone: "success", text: `Blacklisted $${ticker}.` });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to save blacklisted cashtag." });
    } finally {
      setSavingBlacklist(false);
    }
  };

  const removeBlacklist = async (ticker: string) => {
    try {
      await deleteSocialAlertBlacklistEntry(ticker);
      await loadResults();
      setBlacklist((current) => current.filter((row) => row.ticker !== ticker));
      setMessage({ tone: "info", text: `Removed $${ticker} from the blacklist.` });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to remove blacklisted cashtag." });
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

  const toggleMentions = (ticker: string) => {
    setExpandedMentions((current) => {
      const next = new Set(current);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
  };

  const toggleLatestDescription = (ticker: string) => {
    setExpandedLatestDescriptions((current) => {
      const next = new Set(current);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
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
              <p className="mt-1 text-xs text-slate-400">Select up to {MAX_HANDLES_PER_RUN} saved public handles per manual scrape.</p>
            </div>
            <button
              className={BUTTON_CLASS}
              onClick={() => setSelectedIds(allSelected ? new Set<string>() : new Set(activeHandles.slice(0, MAX_HANDLES_PER_RUN).map((row) => row.id)))}
              type="button"
            >
              {allSelected ? "Clear" : "Select All"}
            </button>
          </div>
          <div className="mt-3 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-lg border border-borderSoft/80 bg-panelSoft/80 px-2.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60"
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
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr),minmax(22rem,0.8fr)]">
          <div>
            <div className="flex items-center gap-2">
              <Ban className="h-4 w-4 text-accent" />
              <h3 className="text-sm font-semibold text-slate-100">Cashtag Blacklist</h3>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-[10rem,minmax(0,1fr),auto]">
              <input className={INPUT_CLASS} value={blacklistTicker} onChange={(event) => setBlacklistTicker(normalizeCashtagInput(event.target.value))} placeholder="SPY" />
              <input className={INPUT_CLASS} value={blacklistReason} onChange={(event) => setBlacklistReason(event.target.value)} placeholder="Optional reason" />
              <button className={PRIMARY_BUTTON_CLASS} disabled={!blacklistTicker.trim() || savingBlacklist} onClick={() => void addBlacklist()} type="button">
                {savingBlacklist ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                Blacklist
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {blacklist.map((row) => (
                <span key={row.ticker} className="inline-flex items-center gap-2 rounded-full border border-borderSoft/70 bg-panelSoft/40 px-3 py-1 text-xs text-slate-300">
                  <span className="font-semibold text-slate-100">${row.ticker}</span>
                  {row.reason ? <span className="max-w-[16rem] truncate text-slate-500">{row.reason}</span> : null}
                  <button className="text-slate-500 hover:text-red-300" onClick={() => void removeBlacklist(row.ticker)} type="button" aria-label={`Remove ${row.ticker} from blacklist`}>
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {blacklist.length === 0 ? <span className="text-xs text-slate-500">No blacklisted cashtags.</span> : null}
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-accent" />
              <h3 className="text-sm font-semibold text-slate-100">Daily 1D Scweet Scrape</h3>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-[auto,1fr]">
              <label className="flex items-center gap-2 rounded-lg border border-borderSoft/70 bg-panelSoft/30 px-3 py-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={settings.dailyScrapeEnabled}
                  onChange={(event) => setSettings((current) => ({ ...current, dailyScrapeEnabled: event.target.checked }))}
                />
                Enabled
              </label>
              <div className="grid gap-2 sm:grid-cols-3">
                <input className={INPUT_CLASS} type="time" value={settings.dailyScrapeTimeLocal} onChange={(event) => setSettings((current) => ({ ...current, dailyScrapeTimeLocal: event.target.value }))} />
                <input className={INPUT_CLASS} value={settings.dailyScrapeTimezone} onChange={(event) => setSettings((current) => ({ ...current, dailyScrapeTimezone: event.target.value }))} />
                <input className={INPUT_CLASS} type="number" min={1} max={10} value={settings.dailyScrapeLookbackDays} onChange={(event) => setSettings((current) => ({ ...current, dailyScrapeLookbackDays: Math.max(1, Math.min(10, Number(event.target.value) || 1)) }))} />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
              <span>Scope: all active handles, capped at {MAX_HANDLES_PER_RUN}. Default remains off until saved enabled.</span>
              <button className={PRIMARY_BUTTON_CLASS} disabled={savingSettings} onClick={() => void saveScheduleSettings()} type="button">
                {savingSettings ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
                Save Schedule
              </button>
            </div>
          </div>
        </div>
      </section>

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
              {SCRAPE_PRESETS.map((days) => (
                <button
                  key={days}
                  className={`rounded-lg px-3 py-2 text-xs ${startDate === addDays(localIsoDate(), -days) ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                  onClick={() => applyScrapePreset(days)}
                  type="button"
                >
                  {days}D
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-end">
            <button className={PRIMARY_BUTTON_CLASS} disabled={!canRun || running} onClick={() => void runScrape()} type="button">
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {running ? "Scraping..." : "Run Scweet Scrape"}
            </button>
          </div>
        </div>
        <div className="mt-3 text-xs text-slate-400">
          Selected {selectedHandles.length} handle{selectedHandles.length === 1 ? "" : "s"}. Manual scrapes run on demand.
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
            <h3 className="text-sm font-semibold text-slate-100">Results Log</h3>
            <p className="mt-1 text-xs text-slate-400">
              {results?.window ? `${results.window.startDate} to ${results.window.endDate}` : "Rolling 10-day social alert log."}
              {results?.run ? ` Latest run ${results.run.id.slice(0, 8)} from ${formatDateTime(results.run.createdAt)}.` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className={`${mode === "table" ? PRIMARY_BUTTON_CLASS : BUTTON_CLASS}`} onClick={() => setMode("table")} type="button">Table</button>
            <button className={`${mode === "charts" ? PRIMARY_BUTTON_CLASS : BUTTON_CLASS}`} onClick={() => setMode("charts")} type="button">Multi Grid</button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 xl:grid-cols-[repeat(5,minmax(0,1fr)),auto]">
          <label className="text-xs text-slate-300">
            Log end
            <input className={INPUT_CLASS} type="date" value={logEndDate} onChange={(event) => setLogEndDate(event.target.value)} />
          </label>
          <div className="text-xs text-slate-300">
            Log window
            <div className="mt-1 flex flex-wrap gap-2">
              {LOG_PRESETS.map((days) => (
                <button
                  key={days}
                  className={`rounded-lg px-3 py-2 text-xs ${logLookbackDays === days ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                  onClick={() => applyLogPreset(days)}
                  type="button"
                >
                  {days}D
                </button>
              ))}
            </div>
          </div>
          <label className="text-xs text-slate-300">
            Ticker
            <input className={INPUT_CLASS} value={tickerFilter} onChange={(event) => setTickerFilter(normalizeCashtagInput(event.target.value))} placeholder="NVDA" />
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
          <div className="flex items-end">
            <button className={BUTTON_CLASS} onClick={() => void applyFilters()} type="button">
              <RefreshCw className="h-3.5 w-3.5" />
              Apply
            </button>
          </div>
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
                        {row.cashtags.length > 0 ? row.cashtags.map((ticker) => (
                          <span key={`${row.id}-${ticker}`} className="rounded bg-accent/15 px-2 py-1 text-xs font-semibold text-accent">
                            ${ticker}
                          </span>
                        )) : <span className="text-xs text-slate-500">No counted cashtags</span>}
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
                      No scraped posts match the current filters.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="card p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
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
                <ChartGridPager totalItems={tickerSummaries.length} page={chartPage} pageSize={chartsPerPage} itemLabel="tickers" onPageChange={setChartPage} />
              </div>
            </div>
            <div className="card p-3">
              <div className="text-sm text-slate-300">Social Alerts Multi-Chart ({tickerSummaries.length} ticker{tickerSummaries.length === 1 ? "" : "s"})</div>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visibleSummaries.map((summary) => {
                const isOpen = expandedMentions.has(summary.ticker);
                const latestExpanded = expandedLatestDescriptions.has(summary.ticker);
                return (
                  <div key={summary.ticker} className="rounded-[24px] border border-borderSoft/60 bg-gradient-to-b from-panelSoft/45 to-panel/40 p-4">
                    <div className="mb-4 space-y-2">
                      <div className="grid grid-cols-[auto,minmax(0,1fr)] items-center gap-3">
                        <div className="text-lg font-semibold text-accent">{summary.ticker}</div>
                        <div className="flex min-w-0 items-start justify-end gap-2 text-left">
                          <span className="shrink-0 rounded-full border border-accent/35 bg-accent/10 px-3 py-1 text-[11px] font-semibold text-accent">
                            {formatDateTime(summary.latestMention.tweetCreatedAt ?? summary.latestMention.lastSeenAt)}
                          </span>
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left text-xs leading-snug text-slate-400 transition hover:text-slate-200"
                            style={latestExpanded ? undefined : LATEST_POST_TEXT_STYLE}
                            onClick={() => toggleLatestDescription(summary.ticker)}
                            aria-expanded={latestExpanded}
                            title={latestExpanded ? "Collapse post text" : "Show full post text"}
                          >
                            <span className="font-semibold text-slate-300">@{summary.latestMention.handle}: </span>
                            <HighlightedCashtagText text={summary.latestMention.text} ticker={summary.ticker} />
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="rounded-[22px] bg-panelSoft/25 p-2.5">
                      <TradingViewWidget ticker={summary.ticker} chartOnly showStatusLine fillContainer initialRange="3M" surface="plain" />
                    </div>
                    <div className="mt-4 flex flex-wrap justify-between gap-2">
                      <button
                        type="button"
                        className="inline-flex items-center gap-2 rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55"
                        onClick={() => toggleMentions(summary.ticker)}
                      >
                        {isOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        {isOpen ? "Hide X mentions" : `Show ${summary.mentionCount} X mention${summary.mentionCount === 1 ? "" : "s"}`}
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center justify-center gap-2 rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55"
                        onClick={() => setActiveChartSummary(summary)}
                      >
                        <Maximize2 className="h-3.5 w-3.5" />
                        Expand chart
                      </button>
                    </div>
                    {isOpen ? (
                      <div className="mt-4 rounded-[18px] border border-borderSoft/60 bg-panelSoft/25 p-3">
                        <h4 className="mb-2 text-sm font-semibold text-slate-100">X Mentions</h4>
                        <MentionList mentions={summary.mentions} ticker={summary.ticker} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {visibleSummaries.length === 0 ? <div className="card p-4 text-sm text-slate-300">No unique non-blacklisted tickers match current filters.</div> : null}
            </div>
            <div className="flex justify-end px-1">
              <ChartGridPager totalItems={tickerSummaries.length} page={chartPage} pageSize={chartsPerPage} itemLabel="tickers" onPageChange={setChartPage} />
            </div>
          </div>
        )}
      </section>

      {activeChartSummary ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4" onClick={() => setActiveChartSummary(null)}>
          <div
            className="flex h-[calc(100vh-2rem)] w-full max-w-[96vw] flex-col overflow-hidden rounded-[30px] border border-borderSoft/75 bg-panel/95 shadow-[0_24px_80px_rgba(2,6,23,0.55)] 2xl:max-w-[140rem]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-borderSoft/60 bg-panelSoft/35 px-5 py-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Expanded Chart</p>
                <h4 className="mt-1 text-base font-semibold text-slate-100">{activeChartSummary.ticker}</h4>
                <div className="mt-2 max-w-4xl text-sm text-slate-400">
                  @{activeChartSummary.latestMention.handle}:{" "}
                  <HighlightedCashtagText text={activeChartSummary.latestMention.text} ticker={activeChartSummary.ticker} />
                </div>
              </div>
              <button
                type="button"
                data-modal-close="true"
                className="inline-flex items-center justify-center rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55"
                onClick={() => setActiveChartSummary(null)}
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <div className="rounded-[24px] bg-panelSoft/25 p-3">
                <TradingViewWidget ticker={activeChartSummary.ticker} chartOnly showStatusLine fillContainer initialRange="3M" surface="plain" />
              </div>
              <div className="mt-4 rounded-[18px] border border-borderSoft/60 bg-panelSoft/25 p-3">
                <h4 className="mb-2 text-sm font-semibold text-slate-100">X Mentions</h4>
                <MentionList mentions={activeChartSummary.mentions} ticker={activeChartSummary.ticker} />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
