"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Maximize2, RefreshCw } from "lucide-react";
import {
  getAlertNews,
  getAlerts,
  getAlertTickerDays,
  getPeerTickerDetail,
  type AlertLogRow,
  type AlertNewsRow,
  type AlertTickerDayRow,
  type AlertsSessionFilter,
  type PeerTickerDetail,
} from "@/lib/api";
import { TradingViewWidget } from "./tradingview-widget";
import { TickerMultiGrid } from "./ticker-multi-grid";

const SESSION_OPTIONS: Array<{ value: AlertsSessionFilter; label: string }> = [
  { value: "all", label: "All Sessions" },
  { value: "premarket", label: "Premarket" },
  { value: "regular", label: "Regular" },
  { value: "after-hours", label: "After-Hours" },
];

const localIsoDate = (value = new Date()) =>
  `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;

const addDays = (isoDate: string, days: number) => {
  const value = new Date(`${isoDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const defaultEndDate = () => localIsoDate();
const defaultStartDate = () => addDays(defaultEndDate(), -1);

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
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedNews, setSelectedNews] = useState<AlertNewsRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [newsLoading, setNewsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedNews, setExpandedNews] = useState<Set<string>>(new Set());
  const [activePeerTicker, setActivePeerTicker] = useState<string | null>(null);
  const [activePeerDetail, setActivePeerDetail] = useState<PeerTickerDetail | null>(null);
  const [activePeerLoading, setActivePeerLoading] = useState(false);
  const [activePeerError, setActivePeerError] = useState<string | null>(null);
  const [activePeerChartTicker, setActivePeerChartTicker] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [alertsRes, uniqueRes] = await Promise.all([
        getAlerts({ startDate, endDate, session, limit: 2000 }),
        getAlertTickerDays({ startDate, endDate, session, limit: 1000 }),
      ]);
      const rows = alertsRes.rows ?? [];
      const uniqueRows = uniqueRes.rows ?? [];
      setAlerts(rows);
      setTickerDays(uniqueRows);

      const defaultPair = uniqueRows[0]
        ? keyFor(uniqueRows[0].ticker, uniqueRows[0].tradingDay)
        : rows[0]
          ? keyFor(rows[0].ticker, rows[0].tradingDay)
          : null;

      setSelectedKey((current) => current ?? defaultPair);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load alerts.");
      setAlerts([]);
      setTickerDays([]);
    } finally {
      setLoading(false);
    }
  }, [endDate, session, startDate]);

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

  const uniqueTickers = useMemo(() => Array.from(new Set(tickerDays.map((row) => row.ticker))), [tickerDays]);
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

  const onToggleNews = (key: string) => {
    setExpandedNews((current) => {
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

  const openPeerGroupModal = useCallback(async (ticker: string) => {
    setActivePeerTicker(ticker);
    setActivePeerDetail(null);
    setActivePeerError(null);
    setActivePeerLoading(true);
    try {
      const detail = await getPeerTickerDetail(ticker);
      setActivePeerDetail(detail);
    } catch (loadError) {
      setActivePeerError(loadError instanceof Error ? loadError.message : "Failed to load peer group.");
    } finally {
      setActivePeerLoading(false);
    }
  }, []);

  const singleNews = selectedTickerDay?.news?.length ? selectedTickerDay.news : selectedNews;
  const activePeerGroup = activePeerDetail?.groups[0] ?? null;
  const sortedPeerMembers = useMemo(() => {
    if (!activePeerGroup) return [];
    return [...activePeerGroup.members].sort((a, b) => {
      if (a.ticker === activePeerDetail?.symbol.ticker) return -1;
      if (b.ticker === activePeerDetail?.symbol.ticker) return 1;
      return a.ticker.localeCompare(b.ticker);
    });
  }, [activePeerDetail?.symbol.ticker, activePeerGroup]);

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
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>
          <label className="text-xs text-slate-300">
            End date
            <input
              type="date"
              className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1 text-sm"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </label>
          <label className="text-xs text-slate-300">
            Session
            <select
              className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1 text-sm"
              value={session}
              onChange={(e) => setSession(e.target.value as AlertsSessionFilter)}
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
          {loading ? "Loading alerts..." : `${visibleAlerts.length}${showUniqueOnly ? " visible unique" : ""} alerts, ${tickerDays.length} unique ticker-days, ${uniqueTickers.length} unique tickers`}
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
                        onClick={() => void openPeerGroupModal(selectedTickerDay.ticker)}
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
            <TickerMultiGrid
              title="Multi-Chart Grid (Top 9)"
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              emptyMessage="No tickers match current filters."
              items={tickerDays.slice(0, 9).map((row) => ({
                key: keyFor(row.ticker, row.tradingDay),
                ticker: row.ticker,
                title: row.ticker,
                subtitle: formatAlertStamp(row.latestReceivedAt, row.marketSession),
                detail: <NewsList items={row.news} expanded={expandedNews} onToggle={onToggleNews} compact />,
              }))}
            />
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
                              void openPeerGroupModal(row.ticker);
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

      {activePeerTicker && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-950/70 p-4" onClick={() => setActivePeerTicker(null)}>
          <div className="w-full max-w-6xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between rounded border border-borderSoft bg-panel px-3 py-2">
              <h4 className="text-sm font-semibold text-slate-100">
                {activePeerTicker} Peer Group {activePeerGroup ? `- ${activePeerGroup.name}` : ""}
              </h4>
              <button data-modal-close="true" className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-200" onClick={() => setActivePeerTicker(null)}>
                Close
              </button>
            </div>
            <div className="mb-2 flex items-center gap-2 rounded border border-borderSoft/70 bg-panelSoft/30 px-3 py-2 text-xs">
              <span className="text-slate-400">Source:</span>
              <span className="rounded bg-accent/20 px-2 py-1 text-accent">
                {activePeerGroup?.name ?? "Peer database"}
              </span>
            </div>
            {activePeerError && (
              <div className="mb-2 rounded border border-red-500/40 bg-red-900/20 px-3 py-2 text-xs text-red-200">
                {activePeerError}
              </div>
            )}
            {activePeerLoading ? (
              <div className="card flex items-center gap-2 p-4 text-sm text-slate-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading peer group...
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {sortedPeerMembers.map((member) => (
                  <div key={`${activePeerTicker}-${member.ticker}`} className="card p-2">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-semibold text-accent">{member.ticker}</span>
                      <span className="text-xs text-slate-400">
                        {member.source.replace("_", " ")}
                      </span>
                    </div>
                    <div className="mb-1 text-xs text-slate-300">
                      {member.confidence != null ? `${(member.confidence * 100).toFixed(0)}% confidence` : "Peer member"}
                    </div>
                    <p className="mb-2 line-clamp-2 text-xs text-slate-400">{member.name ?? member.ticker}</p>
                    <TradingViewWidget ticker={member.ticker} size="small" chartOnly initialRange="3M" className="!border-0 !bg-transparent !shadow-none !p-0" />
                    <button
                      className="mt-2 inline-flex items-center gap-1 rounded border border-borderSoft px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800/60"
                      onClick={() => setActivePeerChartTicker(member.ticker)}
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                      Expand chart
                    </button>
                  </div>
                ))}
                {!activePeerLoading && sortedPeerMembers.length === 0 && (
                  <div className="card p-4 text-sm text-slate-300">No peer group members available for this ticker.</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {activePeerChartTicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4" onClick={() => setActivePeerChartTicker(null)}>
          <div className="w-full max-w-5xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between rounded border border-borderSoft bg-panel px-3 py-2">
              <h4 className="text-sm font-semibold text-slate-100">TradingView: {activePeerChartTicker}</h4>
              <button data-modal-close="true" className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-200" onClick={() => setActivePeerChartTicker(null)}>
                Close
              </button>
            </div>
            <TradingViewWidget ticker={activePeerChartTicker} chartOnly initialRange="3M" />
          </div>
        </div>
      )}
    </div>
  );
}

