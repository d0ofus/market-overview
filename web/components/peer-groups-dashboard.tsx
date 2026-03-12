"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Loader2, Search } from "lucide-react";
import {
  getPeerDirectory,
  getPeerGroups,
  getPeerTickerDetail,
  getPeerTickerMetrics,
  type PeerDirectoryRow,
  type PeerGroupRow,
  type PeerMetricRow,
  type PeerTickerDetail,
} from "@/lib/api";
import { TickerMultiGrid } from "./ticker-multi-grid";

function fmtCompact(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function fmtPrice(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

export function PeerGroupsDashboard() {
  const [groups, setGroups] = useState<PeerGroupRow[]>([]);
  const [directory, setDirectory] = useState<PeerDirectoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState("");
  const [loadingDirectory, setLoadingDirectory] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [detail, setDetail] = useState<PeerTickerDetail | null>(null);
  const [metrics, setMetrics] = useState<PeerMetricRow[]>([]);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const pageSize = 50;

  useEffect(() => {
    getPeerGroups()
      .then((res) => setGroups(res.rows ?? []))
      .catch(() => setGroups([]));
  }, []);

  useEffect(() => {
    setLoadingDirectory(true);
    setDirectoryError(null);
    getPeerDirectory({
      q: deferredQuery,
      groupId: groupFilter || undefined,
      limit: pageSize,
      offset,
    })
      .then((res) => {
        setDirectory(res.rows ?? []);
        setTotal(res.total ?? 0);
      })
      .catch((error) => {
        setDirectory([]);
        setTotal(0);
        setDirectoryError(error instanceof Error ? error.message : "Failed to load peer directory.");
      })
      .finally(() => setLoadingDirectory(false));
  }, [deferredQuery, groupFilter, offset]);

  const loadTicker = async (tickerInput: string) => {
    const ticker = tickerInput.trim().toUpperCase();
    if (!ticker) return;
    setSelectedTicker(ticker);
    setLoadingDetail(true);
    setLoadingMetrics(true);
    setDetailError(null);
    setMetricsError(null);

    const [detailRes, metricsRes] = await Promise.allSettled([
      getPeerTickerDetail(ticker),
      getPeerTickerMetrics(ticker),
    ]);

    if (detailRes.status === "fulfilled") {
      setDetail(detailRes.value);
      setSelectedGroupId((current) => current && detailRes.value.groups.some((group) => group.id === current)
        ? current
        : detailRes.value.groups[0]?.id ?? null);
    } else {
      setDetail(null);
      setSelectedGroupId(null);
      setDetailError(detailRes.reason instanceof Error ? detailRes.reason.message : "Failed to load peer detail.");
    }

    if (metricsRes.status === "fulfilled") {
      setMetrics(metricsRes.value.rows ?? []);
      setMetricsError(metricsRes.value.error ?? null);
    } else {
      setMetrics([]);
      setMetricsError(metricsRes.reason instanceof Error ? metricsRes.reason.message : "Failed to load runtime metrics.");
    }

    setLoadingDetail(false);
    setLoadingMetrics(false);
  };

  const activeGroup = useMemo(
    () => detail?.groups.find((group) => group.id === selectedGroupId) ?? detail?.groups[0] ?? null,
    [detail, selectedGroupId],
  );
  const metricsByTicker = useMemo(() => new Map(metrics.map((row) => [row.ticker.toUpperCase(), row])), [metrics]);
  const chartItems = useMemo(() => {
    if (!detail || !activeGroup) return [];
    const ordered = Array.from(new Set([detail.symbol.ticker, ...activeGroup.members.map((member) => member.ticker)])).slice(0, 9);
    return ordered.map((ticker) => {
      const member = activeGroup.members.find((row) => row.ticker === ticker);
      const metric = metricsByTicker.get(ticker);
      return {
        key: ticker,
        ticker,
        title: ticker,
        subtitle: member?.name ?? (ticker === detail.symbol.ticker ? detail.symbol.name : null),
        detail: (
          <div className="grid grid-cols-3 gap-2 text-[11px] text-slate-400">
            <div>Price: <span className="text-slate-200">{fmtPrice(metric?.price)}</span></div>
            <div>Mkt Cap: <span className="text-slate-200">{fmtCompact(metric?.marketCap)}</span></div>
            <div>Avg Vol: <span className="text-slate-200">{fmtCompact(metric?.avgVolume)}</span></div>
          </div>
        ),
      };
    });
  }, [activeGroup, detail, metricsByTicker]);

  return (
    <div className="space-y-4">
      <div className="card p-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr),14rem,auto]">
          <label className="text-xs text-slate-300">
            Search ticker or company
            <div className="mt-1 flex items-center rounded border border-borderSoft bg-panelSoft px-2">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                className="w-full bg-transparent px-2 py-2 text-sm outline-none"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setOffset(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void loadTicker(query);
                }}
                placeholder="AAPL or Apple"
              />
            </div>
          </label>
          <label className="text-xs text-slate-300">
            Filter by peer group
            <select
              className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm"
              value={groupFilter}
              onChange={(event) => {
                setGroupFilter(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">All Groups</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <button
              className="inline-flex items-center gap-2 rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent"
              onClick={() => void loadTicker(query)}
              disabled={!query.trim()}
            >
              Analyze
            </button>
          </div>
        </div>
        <div className="mt-3 text-xs text-slate-400">
          {loadingDirectory ? "Loading directory..." : `${directory.length} rows shown of ${total} matching tickers`}
        </div>
        {directoryError && <p className="mt-2 text-sm text-red-300">{directoryError}</p>}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr),minmax(24rem,28rem)]">
        <section className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/60">
                <tr>
                  {["Ticker", "Company", "Peer Groups", "Sector", "Industry"].map((label) => (
                    <th key={label} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {directory.map((row) => (
                  <tr
                    key={row.ticker}
                    className={`cursor-pointer border-t border-borderSoft/60 ${selectedTicker === row.ticker ? "bg-accent/10" : "hover:bg-slate-900/30"}`}
                    onClick={() => void loadTicker(row.ticker)}
                  >
                    <td className="px-3 py-2 font-semibold text-accent">{row.ticker}</td>
                    <td className="px-3 py-2 text-slate-300">{row.name ?? "-"}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {row.groups.length > 0 ? row.groups.map((group) => (
                          <span key={`${row.ticker}-${group.id}`} className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">
                            {group.name}
                          </span>
                        )) : <span className="text-slate-500">No groups</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-300">{row.sector ?? "-"}</td>
                    <td className="px-3 py-2 text-slate-300">{row.industry ?? "-"}</td>
                  </tr>
                ))}
                {!loadingDirectory && directory.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-sm text-slate-400">
                      No peer-group tickers matched the current search.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-borderSoft/60 px-3 py-2 text-xs text-slate-400">
            <span>Page {(offset / pageSize) + 1}</span>
            <div className="flex gap-2">
              <button
                className="rounded border border-borderSoft px-2 py-1 disabled:opacity-40"
                onClick={() => setOffset((current) => Math.max(0, current - pageSize))}
                disabled={offset === 0}
              >
                Previous
              </button>
              <button
                className="rounded border border-borderSoft px-2 py-1 disabled:opacity-40"
                onClick={() => setOffset((current) => current + pageSize)}
                disabled={offset + pageSize >= total}
              >
                Next
              </button>
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <div className="card p-3">
            {loadingDetail ? (
              <div className="flex items-center gap-2 text-sm text-slate-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading peer detail...
              </div>
            ) : detail ? (
              <div className="space-y-3">
                <div>
                  <div className="text-lg font-semibold text-accent">{detail.symbol.ticker}</div>
                  <div className="text-sm text-slate-300">{detail.symbol.name ?? "-"}</div>
                  <div className="mt-1 text-xs text-slate-400">
                    {detail.symbol.exchange ?? "-"} • {detail.symbol.sector ?? "-"} • {detail.symbol.industry ?? "-"}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {detail.groups.map((group) => (
                    <button
                      key={group.id}
                      className={`rounded px-3 py-1.5 text-xs ${activeGroup?.id === group.id ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                      onClick={() => setSelectedGroupId(group.id)}
                    >
                      {group.name}
                    </button>
                  ))}
                  {detail.groups.length === 0 && <span className="text-xs text-slate-500">Ticker is not assigned to any peer group.</span>}
                </div>
                {detailError && <p className="text-sm text-red-300">{detailError}</p>}
              </div>
            ) : (
              <p className="text-sm text-slate-400">Search or select a ticker to load peer analysis.</p>
            )}
          </div>

          {detail && activeGroup && (
            <div className="card p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-200">{activeGroup.name}</h3>
                <span className="text-xs text-slate-400">{activeGroup.members.length} members</span>
              </div>
              {loadingMetrics ? (
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading Alpaca metrics...
                </div>
              ) : (
                <div className="space-y-2">
                  {metricsError && <p className="text-xs text-yellow-200">{metricsError}</p>}
                  <div className="max-h-72 overflow-auto">
                    <table className="min-w-full text-xs">
                      <thead className="bg-slate-900/60">
                        <tr>
                          {["Ticker", "Company", "Price", "Mkt Cap", "Avg Vol"].map((label) => (
                            <th key={label} className="px-2 py-1.5 text-left text-slate-300">{label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from(new Set([detail.symbol.ticker, ...activeGroup.members.map((member) => member.ticker)])).map((ticker) => {
                          const metric = metricsByTicker.get(ticker);
                          const member = activeGroup.members.find((row) => row.ticker === ticker);
                          return (
                            <tr key={`${activeGroup.id}-${ticker}`} className="border-t border-borderSoft/60">
                              <td className="px-2 py-1.5 font-semibold text-accent">{ticker}</td>
                              <td className="px-2 py-1.5 text-slate-300">{member?.name ?? (ticker === detail.symbol.ticker ? detail.symbol.name : "-")}</td>
                              <td className="px-2 py-1.5 text-slate-300">{fmtPrice(metric?.price)}</td>
                              <td className="px-2 py-1.5 text-slate-300">{fmtCompact(metric?.marketCap)}</td>
                              <td className="px-2 py-1.5 text-slate-300">{fmtCompact(metric?.avgVolume)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      {detail && (
        <TickerMultiGrid
          title={activeGroup ? `${activeGroup.name} Multi-Chart` : "Peer Group Multi-Chart"}
          items={chartItems}
          selectedKey={selectedTicker}
          onSelect={(ticker) => void loadTicker(ticker)}
          emptyMessage="No peer charts available for the current selection."
        />
      )}
    </div>
  );
}

