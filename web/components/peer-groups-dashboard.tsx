"use client";

import { useRouter } from "next/navigation";
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

type PeerMemberSortKey = "ticker" | "name" | "price" | "marketCap" | "avgVolume";
type MultiChartSortKey = "change1d" | "marketCap";
const CORRELATION_DEFAULT_LOOKBACK = "252D";
const CORRELATION_DEFAULT_ROLLING_WINDOW = "60D";
const CORRELATION_LAUNCH_MAX_TICKERS = 10;

function fmtCompact(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function fmtPrice(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function fmtPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function MultiChartPager({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-slate-400">
      <span>Page {page} of {totalPages}</span>
      <button
        className="rounded border border-borderSoft px-2 py-1 disabled:opacity-40"
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={page === 1}
        type="button"
      >
        Previous
      </button>
      <button
        className="rounded border border-borderSoft px-2 py-1 disabled:opacity-40"
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        type="button"
      >
        Next
      </button>
    </div>
  );
}

function normalizeCorrelationTickers(tickers: string[]): string[] {
  return Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
}

function buildCorrelationLaunchHref(tickers: string[], groupId: string, groupName: string): string {
  const params = new URLSearchParams();
  params.set("tickers", tickers.join(","));
  params.set("lookback", CORRELATION_DEFAULT_LOOKBACK);
  params.set("rollingWindow", CORRELATION_DEFAULT_ROLLING_WINDOW);
  params.set("source", "peer-group");
  params.set("peerGroupId", groupId);
  params.set("peerGroupName", groupName);
  return `/correlation?${params.toString()}`;
}

export function PeerGroupsDashboard() {
  const router = useRouter();
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
  const [chartSortKey, setChartSortKey] = useState<MultiChartSortKey>("change1d");
  const [chartsPerPage, setChartsPerPage] = useState(12);
  const [chartPage, setChartPage] = useState(1);
  const [memberSortKey, setMemberSortKey] = useState<PeerMemberSortKey>("ticker");
  const [memberSortDir, setMemberSortDir] = useState<"asc" | "desc">("asc");
  const [correlationPickerState, setCorrelationPickerState] = useState<{
    groupId: string;
    groupName: string;
    tickers: string[];
  } | null>(null);
  const [correlationSelection, setCorrelationSelection] = useState<string[]>([]);
  const [correlationSelectionError, setCorrelationSelectionError] = useState<string | null>(null);
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
  const sortedMemberRows = useMemo(() => {
    if (!detail || !activeGroup) return [];
    const rows = Array.from(new Set([detail.symbol.ticker, ...activeGroup.members.map((member) => member.ticker)])).map((ticker) => {
      const member = activeGroup.members.find((row) => row.ticker === ticker);
      const metric = metricsByTicker.get(ticker);
      return {
        ticker,
        name: member?.name ?? (ticker === detail.symbol.ticker ? detail.symbol.name : null),
        metric,
      };
    });
    rows.sort((a, b) => {
      const getValue = (row: typeof rows[number]) => {
        if (memberSortKey === "ticker") return row.ticker;
        if (memberSortKey === "name") return row.name ?? row.ticker;
        if (memberSortKey === "price") return row.metric?.price ?? Number.NEGATIVE_INFINITY;
        if (memberSortKey === "marketCap") return row.metric?.marketCap ?? Number.NEGATIVE_INFINITY;
        return row.metric?.avgVolume ?? Number.NEGATIVE_INFINITY;
      };
      const left = getValue(a);
      const right = getValue(b);
      if (typeof left === "string" || typeof right === "string") {
        const comparison = String(left).localeCompare(String(right));
        return memberSortDir === "asc" ? comparison : -comparison;
      }
      const comparison = left - right;
      return memberSortDir === "asc" ? comparison : -comparison;
    });
    return rows;
  }, [activeGroup, detail, memberSortDir, memberSortKey, metricsByTicker]);
  const chartItems = useMemo(() => {
    if (!detail || !activeGroup) return [];
    const ordered = [...sortedMemberRows].sort((a, b) => {
      const left = chartSortKey === "change1d"
        ? a.metric?.change1d ?? Number.NEGATIVE_INFINITY
        : a.metric?.marketCap ?? Number.NEGATIVE_INFINITY;
      const right = chartSortKey === "change1d"
        ? b.metric?.change1d ?? Number.NEGATIVE_INFINITY
        : b.metric?.marketCap ?? Number.NEGATIVE_INFINITY;
      if (right !== left) return right - left;
      return a.ticker.localeCompare(b.ticker);
    });
    const startIndex = (chartPage - 1) * chartsPerPage;
    const paged = ordered.slice(startIndex, startIndex + chartsPerPage);
    return paged.map(({ ticker, name, metric }) => {
      const change1d = metric?.change1d ?? null;
      return {
        key: ticker,
        ticker,
        title: ticker,
        subtitle: name,
        headerDetail: (
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-right text-[11px] text-slate-400">
            <div>Price: <span className="text-slate-200">{fmtPrice(metric?.price)}</span></div>
            <div>1D: <span className={change1d != null && change1d < 0 ? "text-neg" : "text-pos"}>{fmtPct(change1d)}</span></div>
            <div>Mkt Cap: <span className="text-slate-200">{fmtCompact(metric?.marketCap)}</span></div>
            <div>Avg Vol: <span className="text-slate-200">{fmtCompact(metric?.avgVolume)}</span></div>
          </div>
        ),
      };
    });
  }, [activeGroup, chartPage, chartSortKey, chartsPerPage, detail, sortedMemberRows]);
  const totalChartPages = useMemo(
    () => Math.max(1, Math.ceil(sortedMemberRows.length / chartsPerPage)),
    [chartsPerPage, sortedMemberRows.length],
  );
  const correlationLaunchTickers = useMemo(
    () => normalizeCorrelationTickers(sortedMemberRows.map((row) => row.ticker)),
    [sortedMemberRows],
  );
  const recommendedCorrelationTickers = useMemo(
    () => correlationLaunchTickers.slice(0, CORRELATION_LAUNCH_MAX_TICKERS),
    [correlationLaunchTickers],
  );
  const canLaunchCorrelation = !!activeGroup && correlationLaunchTickers.length >= 2;

  useEffect(() => {
    setChartPage(1);
  }, [activeGroup?.id, chartSortKey, chartsPerPage]);

  useEffect(() => {
    if (chartPage <= totalChartPages) return;
    setChartPage(totalChartPages);
  }, [chartPage, totalChartPages]);

  useEffect(() => {
    setCorrelationPickerState(null);
    setCorrelationSelection([]);
    setCorrelationSelectionError(null);
  }, [activeGroup?.id, detail?.symbol.ticker]);

  const onMemberSort = (key: PeerMemberSortKey) => {
    if (memberSortKey === key) {
      setMemberSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setMemberSortKey(key);
    setMemberSortDir(key === "ticker" || key === "name" ? "asc" : "desc");
  };

  const launchCorrelation = (tickers: string[], groupId: string, groupName: string) => {
    const normalizedTickers = normalizeCorrelationTickers(tickers);
    if (normalizedTickers.length < 2) return;
    router.push(buildCorrelationLaunchHref(normalizedTickers, groupId, groupName));
  };

  const openCorrelationPicker = () => {
    if (!activeGroup) return;
    if (correlationLaunchTickers.length <= CORRELATION_LAUNCH_MAX_TICKERS) {
      launchCorrelation(correlationLaunchTickers, activeGroup.id, activeGroup.name);
      return;
    }
    setCorrelationPickerState({
      groupId: activeGroup.id,
      groupName: activeGroup.name,
      tickers: correlationLaunchTickers,
    });
    setCorrelationSelection(recommendedCorrelationTickers);
    setCorrelationSelectionError(null);
  };

  const toggleCorrelationSelection = (ticker: string) => {
    setCorrelationSelectionError(null);
    setCorrelationSelection((current) => {
      if (current.includes(ticker)) {
        return current.filter((value) => value !== ticker);
      }
      if (current.length >= CORRELATION_LAUNCH_MAX_TICKERS) {
        setCorrelationSelectionError(`Select up to ${CORRELATION_LAUNCH_MAX_TICKERS} tickers for a correlation run.`);
        return current;
      }
      return [...current, ticker];
    });
  };

  const submitCorrelationPicker = () => {
    if (!correlationPickerState) return;
    const normalizedSelection = correlationPickerState.tickers.filter((ticker) => correlationSelection.includes(ticker));
    if (normalizedSelection.length < 2) {
      setCorrelationSelectionError("Select at least 2 tickers to run correlation.");
      return;
    }
    launchCorrelation(normalizedSelection, correlationPickerState.groupId, correlationPickerState.groupName);
  };

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
              <div className="mb-2 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-200">{activeGroup.name}</h3>
                  <p className="mt-1 text-xs text-slate-400">
                    {correlationLaunchTickers.length} ticker{correlationLaunchTickers.length === 1 ? "" : "s"} ready for correlation launch.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">{activeGroup.members.length} members</span>
                  <button
                    type="button"
                    className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={openCorrelationPicker}
                    disabled={!canLaunchCorrelation}
                  >
                    {correlationLaunchTickers.length > CORRELATION_LAUNCH_MAX_TICKERS ? "Choose Tickers For Correlation" : "Run Correlation"}
                  </button>
                </div>
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
                          {[
                            ["ticker", "Ticker"],
                            ["name", "Company"],
                            ["price", "Price"],
                            ["marketCap", "Mkt Cap"],
                            ["avgVolume", "Avg Vol"],
                          ].map(([key, label]) => (
                            <th key={key} className="px-2 py-1.5 text-left text-slate-300">
                              <button className="hover:text-slate-100" onClick={() => onMemberSort(key as PeerMemberSortKey)}>
                                {label}
                              </button>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sortedMemberRows.map(({ ticker, metric, name }) => {
                          return (
                            <tr key={`${activeGroup.id}-${ticker}`} className="border-t border-borderSoft/60">
                              <td className="px-2 py-1.5 font-semibold text-accent">{ticker}</td>
                              <td className="px-2 py-1.5 text-slate-300">{name ?? "-"}</td>
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
        <div className="space-y-3">
          <div className="card p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
                <label className="flex items-center gap-2">
                  <span>Sort multi-chart by</span>
                  <select
                    className="rounded border border-borderSoft bg-panelSoft px-2 py-1 text-sm"
                    value={chartSortKey}
                    onChange={(event) => setChartSortKey(event.target.value as MultiChartSortKey)}
                  >
                    <option value="change1d">1D % Change</option>
                    <option value="marketCap">Market Capitalization</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <span>Charts per page</span>
                  <input
                    type="number"
                    min={1}
                    max={48}
                    className="w-20 rounded border border-borderSoft bg-panelSoft px-2 py-1 text-sm"
                    value={chartsPerPage}
                    onChange={(event) => setChartsPerPage(Math.max(1, Math.min(48, Number(event.target.value) || 12)))}
                  />
                </label>
              </div>
              <MultiChartPager page={chartPage} totalPages={totalChartPages} onPageChange={setChartPage} />
            </div>
          </div>
          <TickerMultiGrid
            title={activeGroup ? `${activeGroup.name} Multi-Chart` : "Peer Group Multi-Chart"}
            items={chartItems}
            selectedKey={selectedTicker}
            onSelect={(ticker) => void loadTicker(ticker)}
            emptyMessage="No peer charts available for the current selection."
            showChartStatusLine
          />
          <div className="flex justify-end px-1">
            <MultiChartPager page={chartPage} totalPages={totalChartPages} onPageChange={setChartPage} />
          </div>
        </div>
      )}

      {correlationPickerState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4" onClick={() => setCorrelationPickerState(null)}>
          <div
            className="w-full max-w-2xl rounded-2xl border border-borderSoft/80 bg-panel p-4 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Peer Group Launch</div>
                <h3 className="mt-1 text-lg font-semibold text-slate-100">{correlationPickerState.groupName}</h3>
                <p className="mt-1 text-sm text-slate-400">
                  Select 2 to {CORRELATION_LAUNCH_MAX_TICKERS} tickers to run in correlation. Recommended selections follow the current peer-group sort order.
                </p>
              </div>
              <button
                type="button"
                className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-300"
                onClick={() => setCorrelationPickerState(null)}
              >
                Close
              </button>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-borderSoft/70 bg-panelSoft/30 px-3 py-2 text-sm text-slate-300">
              <div>
                Selected <span className="font-semibold text-slate-100">{correlationSelection.length}</span> of {correlationPickerState.tickers.length}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-300 hover:bg-slate-800/60"
                  onClick={() => {
                    setCorrelationSelection(recommendedCorrelationTickers);
                    setCorrelationSelectionError(null);
                  }}
                >
                  Select Recommended 10
                </button>
                <button
                  type="button"
                  className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-300 hover:bg-slate-800/60"
                  onClick={() => {
                    setCorrelationSelection([]);
                    setCorrelationSelectionError(null);
                  }}
                >
                  Clear
                </button>
              </div>
            </div>

            <div className="mt-4 max-h-[26rem] overflow-auto rounded-xl border border-borderSoft/70">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-900/60">
                  <tr>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">Use</th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">Ticker</th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">Company</th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">Price</th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">Mkt Cap</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedMemberRows.map(({ ticker, name, metric }) => {
                    const checked = correlationSelection.includes(ticker);
                    const disableUnchecked = !checked && correlationSelection.length >= CORRELATION_LAUNCH_MAX_TICKERS;
                    return (
                      <tr key={`correlation-launch-${ticker}`} className="border-t border-borderSoft/60">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-borderSoft bg-panelSoft"
                            checked={checked}
                            disabled={disableUnchecked}
                            onChange={() => toggleCorrelationSelection(ticker)}
                          />
                        </td>
                        <td className="px-3 py-2 font-semibold text-accent">{ticker}</td>
                        <td className="px-3 py-2 text-slate-300">{name ?? "-"}</td>
                        <td className="px-3 py-2 text-slate-300">{fmtPrice(metric?.price)}</td>
                        <td className="px-3 py-2 text-slate-300">{fmtCompact(metric?.marketCap)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {correlationSelectionError && <p className="mt-3 text-sm text-rose-300">{correlationSelectionError}</p>}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="rounded border border-borderSoft px-3 py-2 text-sm text-slate-300 hover:bg-slate-800/60"
                onClick={() => setCorrelationPickerState(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={submitCorrelationPicker}
                disabled={correlationSelection.length < 2 || correlationSelection.length > CORRELATION_LAUNCH_MAX_TICKERS}
              >
                Run Correlation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

