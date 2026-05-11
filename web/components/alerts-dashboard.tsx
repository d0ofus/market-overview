"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Loader2, Maximize2, RefreshCw } from "lucide-react";
import {
  getAlertNews,
  getAlerts,
  getAlertTickerDays,
  type AlertLogRow,
  type AlertNewsRow,
  type AlertTickerDayRow,
  type AlertsSessionFilter,
} from "@/lib/api";
import { ChartGridPager } from "./chart-grid-pager";
import { TradingViewWidget } from "./tradingview-widget";
import { PeerGroupModal } from "./peer-group-modal";
import { FundamentalsModal } from "./fundamentals-modal";

const SESSION_OPTIONS: Array<{ value: AlertsSessionFilter; label: string }> = [
  { value: "all", label: "All Sessions" },
  { value: "premarket", label: "Premarket" },
  { value: "regular", label: "Regular" },
  { value: "after-hours", label: "After-Hours" },
];

const QUICK_RANGE_OPTIONS = [3, 5, 10, 30] as const;
const DEFAULT_CHARTS_PER_PAGE = 12;

const localIsoDate = (value = new Date()) =>
  `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;

const addDays = (isoDate: string, days: number) => {
  const value = new Date(`${isoDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const defaultEndDate = () => localIsoDate();
const defaultStartDate = () => addDays(defaultEndDate(), -1);

const rangeStartDate = (endDate: string, days: number) => addDays(endDate, -(days - 1));

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
  }).format(parsed);
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
  }).format(parsed);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
  return `${date}, ${weekday}, ${time}`;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(parsed);
}

function formatAlertStamp(value: string | null | undefined, marketSession?: string | null): string {
  const timestamp = formatDateTime(value);
  if (!marketSession) return timestamp;
  return `${timestamp} • ${marketSession}`;
}

function formatCompact(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function formatPrice(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function formatPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function metricChangeClass(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "text-slate-100";
  return value < 0 ? "text-neg" : "text-pos";
}

function MetricBubble({
  label,
  value,
  valueClass = "text-slate-100",
  className = "",
}: {
  label: string;
  value: string;
  valueClass?: string;
  className?: string;
}) {
  return (
    <span className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-borderSoft/60 bg-panelSoft/30 px-3 py-1.5 text-xs text-slate-200 ${className}`}>
      <span className="shrink-0 uppercase tracking-[0.12em] text-slate-500">{label}</span>
      <span className={`min-w-0 max-w-[12rem] truncate font-semibold ${valueClass}`} title={value}>
        {value}
      </span>
    </span>
  );
}

function summarizeDescription(row: AlertLogRow): string {
  const fromSubject = (row.rawEmailSubject ?? "")
    .replace(/^\s*(tradingview\s+alert\s*[-:]\s*|alert\s*:\s*)/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (fromSubject) return fromSubject.length > 120 ? `${fromSubject.slice(0, 117)}...` : fromSubject;
  const fromPayload = (row.rawPayload ?? "").replace(/\s+/g, " ").trim();
  if (fromPayload) return fromPayload.length > 120 ? `${fromPayload.slice(0, 117)}...` : fromPayload;
  return row.alertType ?? row.strategyName ?? "-";
}

function keyFor(ticker: string, tradingDay: string): string {
  return `${ticker}|${tradingDay}`;
}

function NewsList({
  items,
  expanded,
  onToggle,
  compact = false,
}: {
  items: AlertNewsRow[];
  expanded: Set<string>;
  onToggle: (key: string) => void;
  compact?: boolean;
}) {
  if (items.length === 0) {
    return <p className="text-xs text-slate-400">No news found for this ticker/day.</p>;
  }

  return (
    <div className="space-y-2">
      {items.slice(0, 3).map((item, idx) => {
        const expandKey = `${item.ticker}-${item.tradingDay}-${idx}`;
        const isOpen = expanded.has(expandKey);
        return (
          <article key={expandKey} className="rounded border border-borderSoft/60 bg-panelSoft/25 p-2">
            <a href={item.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-accent hover:underline">
              {item.headline}
            </a>
            <div className="mt-1 text-[11px] text-slate-400">
              {item.source} {item.publishedAt ? `• ${formatDateTime(item.publishedAt)}` : ""}
            </div>
            <button
              className="mt-1 text-[11px] text-slate-300 underline decoration-dotted"
              onClick={() => onToggle(expandKey)}
            >
              {isOpen ? "Hide details" : "Show details"}
            </button>
            {isOpen && (
              <div className="mt-1 text-xs leading-relaxed text-slate-300">
                {item.snippet ?? "No summary available from provider."}
              </div>
            )}
            {!compact && (
              <div className="mt-1 text-[11px] text-slate-500 break-all">
                <a href={item.url} target="_blank" rel="noreferrer" className="hover:text-slate-300">
                  {item.url}
                </a>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

export function AlertsDashboard() {
  const [startDate, setStartDate] = useState(defaultStartDate());
  const [endDate, setEndDate] = useState(defaultEndDate());
  const [session, setSession] = useState<AlertsSessionFilter>("all");
  const [mode, setMode] = useState<"single" | "multi">("multi");
  const [showUniqueOnly, setShowUniqueOnly] = useState(true);
  const [alerts, setAlerts] = useState<AlertLogRow[]>([]);
  const [tickerDays, setTickerDays] = useState<AlertTickerDayRow[]>([]);
  const [tickerDayTotal, setTickerDayTotal] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedNews, setSelectedNews] = useState<AlertNewsRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [newsLoading, setNewsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedNews, setExpandedNews] = useState<Set<string>>(new Set());
  const [expandedGridNews, setExpandedGridNews] = useState<Set<string>>(new Set());
  const [activePeerTicker, setActivePeerTicker] = useState<string | null>(null);
  const [activeFundamentalsTicker, setActiveFundamentalsTicker] = useState<string | null>(null);
  const [activeChartRow, setActiveChartRow] = useState<AlertTickerDayRow | null>(null);
  const [chartPage, setChartPage] = useState(1);
  const [chartsPerPage, setChartsPerPage] = useState(DEFAULT_CHARTS_PER_PAGE);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [alertsRes, uniqueRes] = await Promise.all([
        getAlerts({ startDate, endDate, session, limit: 2000 }),
        getAlertTickerDays({
          startDate,
          endDate,
          session,
          limit: chartsPerPage,
          offset: (chartPage - 1) * chartsPerPage,
        }),
      ]);
      const rows = alertsRes.rows ?? [];
      const uniqueRows = uniqueRes.rows ?? [];
      setAlerts(rows);
      setTickerDays(uniqueRows);
      setTickerDayTotal(uniqueRes.total ?? uniqueRows.length);

      const defaultPair = uniqueRows[0]
        ? keyFor(uniqueRows[0].ticker, uniqueRows[0].tradingDay)
        : rows[0]
          ? keyFor(rows[0].ticker, rows[0].tradingDay)
          : null;

      setSelectedKey((current) => {
        if (!current) return defaultPair;
        const currentExists =
          uniqueRows.some((row) => keyFor(row.ticker, row.tradingDay) === current) ||
          rows.some((row) => keyFor(row.ticker, row.tradingDay) === current);
        return currentExists ? current : defaultPair;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load alerts.");
      setAlerts([]);
      setTickerDays([]);
      setTickerDayTotal(0);
    } finally {
      setLoading(false);
    }
  }, [chartPage, chartsPerPage, endDate, session, startDate]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedTickerDay = useMemo(() => {
    if (!selectedKey) return null;
    const [ticker, tradingDay] = selectedKey.split("|");
    if (!ticker || !tradingDay) return null;
    const existing = tickerDays.find((row) => row.ticker === ticker && row.tradingDay === tradingDay);
    if (existing) return existing;
    return { ticker, tradingDay, alertCount: 0, latestReceivedAt: "", marketSession: "regular" as const, news: [] };
  }, [selectedKey, tickerDays]);
  const selectedLatestAlert = useMemo(() => {
    if (!selectedTickerDay) return null;
    return (
      alerts.find((row) => row.ticker === selectedTickerDay.ticker && row.tradingDay === selectedTickerDay.tradingDay) ?? null
    );
  }, [alerts, selectedTickerDay]);

  useEffect(() => {
    const ticker = selectedTickerDay?.ticker;
    const tradingDay = selectedTickerDay?.tradingDay;
    if (!ticker || !tradingDay) {
      setSelectedNews([]);
      return;
    }
    setNewsLoading(true);
    getAlertNews(ticker, tradingDay)
      .then((res) => setSelectedNews(res.rows ?? []))
      .catch(() => setSelectedNews([]))
      .finally(() => setNewsLoading(false));
  }, [selectedTickerDay?.ticker, selectedTickerDay?.tradingDay]);

  const uniqueTickers = useMemo(() => Array.from(new Set(alerts.map((row) => row.ticker))), [alerts]);
  const totalChartPages = Math.max(1, Math.ceil(tickerDayTotal / chartsPerPage));
  const visibleAlerts = useMemo(() => {
    if (!showUniqueOnly) return alerts;
    const seen = new Set<string>();
    const deduped: AlertLogRow[] = [];
    for (const row of alerts) {
      const description = summarizeDescription(row);
      const key = [row.tradingDay, row.marketSession, row.ticker, description].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(row);
    }
    return deduped;
  }, [alerts, showUniqueOnly]);
  const alertDescriptionByTickerDay = useMemo(() => {
    const descriptions = new Map<string, string>();
    for (const row of alerts) {
      const compoundKey = keyFor(row.ticker, row.tradingDay);
      if (descriptions.has(compoundKey)) continue;
      descriptions.set(compoundKey, summarizeDescription(row));
    }
    return descriptions;
  }, [alerts]);

  const onToggleNews = (key: string) => {
    setExpandedNews((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleGridNews = (key: string) => {
    setExpandedGridNews((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const onSelectRow = (row: { ticker: string; tradingDay: string }) => {
    setSelectedKey(keyFor(row.ticker, row.tradingDay));
    setMode("single");
  };

  const applyQuickRange = (days: number) => {
    setChartPage(1);
    setStartDate(rangeStartDate(endDate, days));
  };

  useEffect(() => {
    if (chartPage <= totalChartPages) return;
    setChartPage(totalChartPages);
  }, [chartPage, totalChartPages]);

  const isQuickRangeActive = (days: number) => startDate === rangeStartDate(endDate, days);

  const singleNews = selectedTickerDay?.news?.length ? selectedTickerDay.news : selectedNews;
  const activeChartDescription = activeChartRow
    ? (alertDescriptionByTickerDay.get(keyFor(activeChartRow.ticker, activeChartRow.tradingDay)) ?? "-")
    : "-";

  return (
    <div className="space-y-4">
      <div className="card p-3">
        <div className="grid gap-3 md:grid-cols-5">
          <label className="text-xs text-slate-300">
            Start date
            <input
              type="date"
              className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1 text-sm"
              value={startDate}
              onChange={(e) => {
                setChartPage(1);
                setStartDate(e.target.value);
              }}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              {QUICK_RANGE_OPTIONS.map((days) => (
                <button
                  key={days}
                  type="button"
                  className={`rounded px-2 py-1 text-[11px] ${
                    isQuickRangeActive(days) ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"
                  }`}
                  onClick={() => applyQuickRange(days)}
                >
                  {days}d
                </button>
              ))}
            </div>
          </label>
          <label className="text-xs text-slate-300">
            End date
            <input
              type="date"
              className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1 text-sm"
              value={endDate}
              onChange={(e) => {
                setChartPage(1);
                setEndDate(e.target.value);
              }}
            />
          </label>
          <label className="text-xs text-slate-300">
            Session
            <select
              className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1 text-sm"
              value={session}
              onChange={(e) => {
                setChartPage(1);
                setSession(e.target.value as AlertsSessionFilter);
              }}
            >
              {SESSION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="text-xs text-slate-300">
            Chart mode
            <div className="mt-1 flex gap-2">
              <button
                className={`rounded px-3 py-1.5 text-xs ${mode === "single" ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                onClick={() => setMode("single")}
              >
                Single
              </button>
              <button
                className={`rounded px-3 py-1.5 text-xs ${mode === "multi" ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                onClick={() => setMode("multi")}
              >
                Multi Grid
              </button>
            </div>
          </div>
          <div className="flex items-end">
            <button
              className="inline-flex items-center gap-2 rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Reload
            </button>
          </div>
        </div>
        <div className="mt-3 text-xs text-slate-400">
          {loading ? "Loading alerts..." : `${visibleAlerts.length}${showUniqueOnly ? " visible unique" : ""} alerts, ${tickerDayTotal} unique ticker-days, ${uniqueTickers.length} unique tickers`}
        </div>
      </div>

      {error && <div className="card border border-red-500/40 p-3 text-sm text-red-300">{error}</div>}

      <div className={mode === "single" ? "grid gap-4 xl:grid-cols-[minmax(0,1.45fr),minmax(22rem,1fr)]" : "grid gap-4"}>
        <section className="space-y-3">
          {mode === "single" ? (
            <>
              <div className="card p-3">
                <div className="mb-2 text-sm text-slate-300">
                  {selectedTickerDay ? (
                    <>
                      <button
                        className="font-semibold text-accent underline decoration-dotted"
                        onClick={() => setActivePeerTicker(selectedTickerDay.ticker)}
                      >
                        {selectedTickerDay.ticker}
                      </button>{" "}
                      •{" "}
                      {formatAlertStamp(selectedLatestAlert?.receivedAt ?? selectedTickerDay.latestReceivedAt, selectedTickerDay.marketSession)}
                    </>
                  ) : (
                    "Select an alert to open a chart."
                  )}
                </div>
                {selectedTickerDay ? (
                  <TradingViewWidget ticker={selectedTickerDay.ticker} chartOnly showStatusLine initialRange="3M" />
                ) : (
                  <div className="rounded border border-borderSoft/60 bg-panelSoft/20 p-4 text-sm text-slate-400">No ticker selected.</div>
                )}
              </div>

              <div className="card p-3">
                <h3 className="mb-2 text-sm font-semibold text-slate-200">Top News (Ticker/Day)</h3>
                {selectedTickerDay && (
                  <div className="mb-2 text-xs text-slate-400">
                    {selectedTickerDay.ticker} • {selectedTickerDay.tradingDay}
                  </div>
                )}
                {newsLoading ? (
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading news...
                  </div>
                ) : (
                  <NewsList items={singleNews ?? []} expanded={expandedNews} onToggle={onToggleNews} />
                )}
              </div>
            </>
          ) : (
            <div className="space-y-3">
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
                        const next = Math.max(1, Math.min(48, Number(event.target.value) || DEFAULT_CHARTS_PER_PAGE));
                        setChartsPerPage(next);
                        setChartPage(1);
                      }}
                    />
                  </label>
                  <ChartGridPager
                    totalItems={tickerDayTotal}
                    page={chartPage}
                    pageSize={chartsPerPage}
                    itemLabel="ticker-days"
                    onPageChange={setChartPage}
                  />
                </div>
              </div>
              <div className="card p-3">
                <div className="text-sm text-slate-300">
                  Multi-Chart Grid ({tickerDayTotal} ticker-day{tickerDayTotal === 1 ? "" : "s"})
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {tickerDays.map((row) => {
                  const compoundKey = keyFor(row.ticker, row.tradingDay);
                  const description = alertDescriptionByTickerDay.get(compoundKey) ?? "-";
                  const gridNewsOpen = expandedGridNews.has(compoundKey);
                  const isSelected = selectedKey === compoundKey;
                  return (
                    <div
                      key={compoundKey}
                      role="group"
                      tabIndex={0}
                      aria-label={`${row.ticker} chart card`}
                      aria-keyshortcuts="Alt+Enter"
                      className={`rounded-[24px] border bg-gradient-to-b from-panelSoft/45 to-panel/40 p-4 ${
                        isSelected ? "border-accent/60" : "border-borderSoft/60"
                      } focus:outline-none focus:ring-2 focus:ring-accent/45`}
                      onKeyDown={(event) => {
                        if (!event.altKey || event.key !== "Enter") return;
                        event.preventDefault();
                        event.stopPropagation();
                        setActiveChartRow(row);
                      }}
                    >
                      <div className="mb-4 space-y-2">
                        <div className="grid grid-cols-[auto,minmax(0,1fr)] items-center gap-3">
                          <button
                            type="button"
                            className="text-left text-lg font-semibold text-accent hover:underline"
                            onClick={() => setActivePeerTicker(row.ticker)}
                          >
                            {row.ticker}
                          </button>
                          <button
                            type="button"
                            className="flex min-w-0 items-center justify-end gap-2 text-left"
                            onClick={() => setSelectedKey(compoundKey)}
                          >
                            <span className="shrink-0 rounded-full border border-accent/35 bg-accent/10 px-3 py-1 text-[11px] font-semibold text-accent">
                              {formatDateTime(row.latestReceivedAt)}
                            </span>
                            <span className="min-w-0 truncate text-sm leading-snug text-slate-300">
                              {description}
                            </span>
                          </button>
                        </div>
                        <div className="grid min-w-0 grid-cols-[minmax(0,1fr),auto,auto] items-center gap-2">
                          <MetricBubble className="w-full" label="Industry" value={row.industry ?? "-"} />
                          <MetricBubble className="shrink-0" label="Mkt Cap" value={formatCompact(row.marketCap)} />
                          <MetricBubble className="shrink-0" label="Avg $ Vol" value={formatCompact(row.priceAvgVolume)} />
                        </div>
                      </div>
                      <div className="rounded-[22px] bg-panelSoft/25 p-2.5">
                        <TradingViewWidget
                          ticker={row.ticker}
                          chartOnly
                          showStatusLine
                          fillContainer
                          initialRange="3M"
                          surface="plain"
                        />
                      </div>
                      <div className="mt-4 flex flex-wrap justify-between gap-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="inline-flex items-center gap-2 rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55"
                            onClick={() => toggleGridNews(compoundKey)}
                          >
                            {gridNewsOpen ? "Hide latest news" : "Show latest news"}
                          </button>
                          <button
                            type="button"
                            className="inline-flex items-center gap-2 rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55"
                            onClick={() => setActiveFundamentalsTicker(row.ticker)}
                          >
                            <BarChart3 className="h-3.5 w-3.5" />
                            Fundamentals
                          </button>
                        </div>
                        <button
                          type="button"
                          className="inline-flex items-center justify-center gap-2 rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55"
                          onClick={() => setActiveChartRow(row)}
                        >
                          <Maximize2 className="h-3.5 w-3.5" />
                          Expand chart
                        </button>
                      </div>
                      {gridNewsOpen ? (
                        <div className="mt-4 rounded-[18px] border border-borderSoft/60 bg-panelSoft/25 p-3">
                          <h4 className="mb-2 text-sm font-semibold text-slate-100">Latest News</h4>
                          <NewsList items={row.news} expanded={expandedNews} onToggle={onToggleNews} compact />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {tickerDays.length === 0 ? (
                  <div className="card p-4 text-sm text-slate-300">No tickers match current filters.</div>
                ) : null}
              </div>
              <div className="flex justify-end px-1">
                <ChartGridPager
                  totalItems={tickerDayTotal}
                  page={chartPage}
                  pageSize={chartsPerPage}
                  itemLabel="ticker-days"
                  onPageChange={setChartPage}
                />
              </div>
            </div>
          )}
        </section>

        {mode === "single" && <aside className="space-y-3">
          <div className="card p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-200">Alerts Log (Last 30d Window)</h3>
              <button
                className={`rounded px-3 py-1.5 text-xs ${showUniqueOnly ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                onClick={() => setShowUniqueOnly((current) => !current)}
              >
                {showUniqueOnly ? "Show All Alerts" : "Show Unique Only"}
              </button>
            </div>
            <div className="max-h-[58rem] overflow-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-900/60">
                  <tr>
                    <th className="px-2 py-1.5 text-left text-slate-300">Time</th>
                    <th className="px-2 py-1.5 text-left text-slate-300">Ticker</th>
                    <th className="px-2 py-1.5 text-left text-slate-300">Session</th>
                    <th className="px-2 py-1.5 text-left text-slate-300">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleAlerts.map((row) => {
                    const isActive = selectedKey === keyFor(row.ticker, row.tradingDay);
                    return (
                      <tr
                        key={row.id}
                        className={`cursor-pointer border-t border-borderSoft/60 ${isActive ? "bg-accent/10" : "hover:bg-slate-900/30"}`}
                        onClick={() => onSelectRow(row)}
                      >
                        <td className="px-2 py-1.5 text-slate-300">{formatDateTime(row.receivedAt)}</td>
                        <td className="px-2 py-1.5 font-semibold text-accent">
                          <button
                            className="hover:underline"
                            onClick={(event) => {
                              event.stopPropagation();
                              setActivePeerTicker(row.ticker);
                            }}
                          >
                            {row.ticker}
                          </button>
                        </td>
                        <td className="px-2 py-1.5 text-slate-300">{row.marketSession}</td>
                        <td className="px-2 py-1.5 text-slate-300">{summarizeDescription(row)}</td>
                      </tr>
                    );
                  })}
                  {visibleAlerts.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-2 py-4 text-center text-slate-400">
                        No alerts found for the selected filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </aside>}
      </div>

      {activePeerTicker && <PeerGroupModal ticker={activePeerTicker} onClose={() => setActivePeerTicker(null)} />}
      {activeFundamentalsTicker ? (
        <FundamentalsModal ticker={activeFundamentalsTicker} onClose={() => setActiveFundamentalsTicker(null)} />
      ) : null}
      {activeChartRow ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-2 md:p-3" onClick={() => setActiveChartRow(null)}>
          <div
            className="flex h-[calc(100vh-1rem)] w-full max-w-[98vw] flex-col overflow-hidden rounded-[24px] border border-borderSoft/75 bg-panel/95 shadow-[0_24px_80px_rgba(2,6,23,0.55)] md:h-[calc(100vh-1.5rem)] 2xl:max-w-[140rem]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-borderSoft/60 bg-panelSoft/35 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Expanded Chart</p>
                  <h4 className="text-base font-semibold text-slate-100">{activeChartRow.ticker}</h4>
                  <span className="min-w-0 truncate text-sm text-slate-400">
                    {formatAlertStamp(activeChartRow.latestReceivedAt, activeChartRow.marketSession)}
                  </span>
                </div>
                <div className="mt-1 max-w-[72rem] truncate text-sm text-slate-400" title={activeChartDescription}>
                  {activeChartDescription}
                </div>
              </div>
              <button
                type="button"
                data-modal-close="true"
                className="inline-flex shrink-0 items-center justify-center rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55"
                onClick={() => setActiveChartRow(null)}
              >
                Close
              </button>
            </div>
            <div className="overflow-x-auto border-b border-borderSoft/50 px-4 py-2">
              <div className="flex min-w-max flex-nowrap gap-2">
                <MetricBubble className="shrink-0" label="Alerts" value={String(activeChartRow.alertCount)} />
                <MetricBubble className="shrink-0" label="Price" value={formatPrice(activeChartRow.price)} />
                <MetricBubble className="shrink-0" label="1D %" value={formatPct(activeChartRow.change1d)} valueClass={metricChangeClass(activeChartRow.change1d)} />
                <MetricBubble className="min-w-[16rem] shrink-0" label="Industry" value={activeChartRow.industry ?? "-"} />
                <MetricBubble className="shrink-0" label="Mkt Cap" value={formatCompact(activeChartRow.marketCap)} />
                <MetricBubble className="shrink-0" label="Avg Vol" value={formatCompact(activeChartRow.avgVolume)} />
                <MetricBubble className="shrink-0" label="Avg $ Vol" value={formatCompact(activeChartRow.priceAvgVolume)} />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden p-3">
              <div className="h-full min-h-0 rounded-[20px] bg-panelSoft/25 p-2">
                <TradingViewWidget
                  ticker={activeChartRow.ticker}
                  chartOnly
                  showStatusLine
                  fillContainer
                  heightMode="fill"
                  initialRange="3M"
                  surface="plain"
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

