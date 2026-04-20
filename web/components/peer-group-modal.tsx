"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Maximize2 } from "lucide-react";
import {
  getPeerTickerDetail,
  getPeerTickerMetrics,
  type PeerMetricRow,
  type PeerTickerDetail,
} from "@/lib/api";
import { ChartGridPager } from "./chart-grid-pager";
import { TradingViewWidget } from "./tradingview-widget";

const CHARTS_PER_PAGE = 20;

function formatPrice(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function formatCompact(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function formatPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function metricChangeClass(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "text-slate-100";
  return value < 0 ? "text-neg" : "text-pos";
}

export function PeerGroupModal({
  ticker,
  onClose,
}: {
  ticker: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<PeerTickerDetail | null>(null);
  const [metrics, setMetrics] = useState<Record<string, PeerMetricRow>>({});
  const [error, setError] = useState<string | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeChartTicker, setActiveChartTicker] = useState<{
    ticker: string;
    name: string | null;
    price: number | null;
    change1d: number | null;
    marketCap: number | null;
    avgVolume: number | null;
  } | null>(null);
  const [memberPage, setMemberPage] = useState(1);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      setMetricsError(null);
      try {
        const [nextDetail, nextMetrics] = await Promise.all([
          getPeerTickerDetail(ticker),
          getPeerTickerMetrics(ticker),
        ]);
        if (cancelled) return;
        setDetail(nextDetail);
        setMetrics(Object.fromEntries((nextMetrics.rows ?? []).map((row) => [row.ticker, row])));
        setMetricsError(nextMetrics.error ?? null);
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load peer group.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (activeChartTicker) setActiveChartTicker(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeChartTicker, onClose]);

  const activeGroup = detail?.groups[0] ?? null;
  const sortedMembers = useMemo(() => {
    if (!activeGroup) return [];
    return [...activeGroup.members].sort((a, b) => {
      const left = metrics[a.ticker]?.change1d ?? Number.NEGATIVE_INFINITY;
      const right = metrics[b.ticker]?.change1d ?? Number.NEGATIVE_INFINITY;
      if (right !== left) return right - left;
      return a.ticker.localeCompare(b.ticker);
    });
  }, [activeGroup, metrics]);
  const pagedMembers = useMemo(
    () => sortedMembers.slice((memberPage - 1) * CHARTS_PER_PAGE, memberPage * CHARTS_PER_PAGE),
    [memberPage, sortedMembers],
  );

  useEffect(() => {
    setMemberPage(1);
  }, [ticker, activeGroup?.name, sortedMembers.length]);

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4" onClick={onClose}>
        <div
          className="flex h-[calc(100vh-2rem)] w-full max-w-[96vw] flex-col overflow-hidden rounded-[30px] border border-borderSoft/75 bg-panel/95 shadow-[0_24px_80px_rgba(2,6,23,0.55)] 2xl:max-w-[140rem]"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-borderSoft/60 bg-panelSoft/35 px-5 py-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Peer Group</p>
              <h4 className="mt-1 text-base font-semibold text-slate-100">
                {ticker} {activeGroup ? `- ${activeGroup.name}` : "Peer Group"}
              </h4>
            </div>
            <button
              data-modal-close="true"
              className="inline-flex items-center justify-center rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55"
              onClick={onClose}
            >
              Close
            </button>
          </div>
          <div className="border-b border-borderSoft/50 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2 rounded-[22px] border border-borderSoft/60 bg-panelSoft/30 px-3 py-3 text-sm text-slate-300">
              <span className="text-slate-400">Source:</span>
              <span className="rounded-full bg-accent/12 px-2.5 py-1 text-xs font-medium text-accent">{activeGroup?.name ?? "Peer database"}</span>
              <span className="ml-auto rounded-full bg-panel/55 px-3 py-1.5 text-xs text-slate-300">
              {sortedMembers.length} ticker{sortedMembers.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>
          <div className="overflow-y-auto px-5 py-5">
            {error && (
              <div className="mb-2 rounded border border-red-500/40 bg-red-900/20 px-3 py-2 text-xs text-red-200">
                {error}
              </div>
            )}
            {metricsError && !error && (
              <div className="mb-2 rounded border border-yellow-700/50 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-200">
                Metrics warning: {metricsError}
              </div>
            )}
            <ChartGridPager
              totalItems={sortedMembers.length}
              page={memberPage}
              pageSize={CHARTS_PER_PAGE}
              itemLabel="tickers"
              onPageChange={setMemberPage}
            />
            {loading ? (
              <div className="card flex items-center gap-2 p-4 text-sm text-slate-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading peer group...
              </div>
            ) : (
              <>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {pagedMembers.map((member) => (
                    <div
                      key={`${ticker}-${member.ticker}`}
                      className="rounded-[24px] border border-borderSoft/60 bg-gradient-to-b from-panelSoft/45 to-panel/40 p-4"
                    >
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-lg font-semibold text-accent">{member.ticker}</div>
                          <p className="mt-1 line-clamp-1 text-sm text-slate-400">{member.name ?? member.ticker}</p>
                        </div>
                        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${metricChangeClass(metrics[member.ticker]?.change1d)}`}>
                          {formatPct(metrics[member.ticker]?.change1d)}
                        </span>
                      </div>
                      <div className="mb-4 grid gap-3 sm:grid-cols-3">
                        <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-3 py-2.5">
                          <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Price</div>
                          <div className="mt-1 text-sm font-semibold text-slate-100">{formatPrice(metrics[member.ticker]?.price)}</div>
                        </div>
                        <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-3 py-2.5">
                          <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Mkt Cap</div>
                          <div className="mt-1 text-sm font-semibold text-slate-100">{formatCompact(metrics[member.ticker]?.marketCap)}</div>
                        </div>
                        <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-3 py-2.5">
                          <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Avg Vol</div>
                          <div className="mt-1 text-sm font-semibold text-slate-100">{formatCompact(metrics[member.ticker]?.avgVolume)}</div>
                        </div>
                      </div>
                      <div className="rounded-[22px] bg-panelSoft/25 p-2.5">
                        <TradingViewWidget
                          ticker={member.ticker}
                          chartOnly
                          showStatusLine
                          fillContainer
                          initialRange="3M"
                          surface="plain"
                        />
                      </div>
                      <div className="mt-4 flex justify-end">
                        <button
                          className="inline-flex items-center justify-center gap-2 rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55"
                          onClick={() => setActiveChartTicker({
                            ticker: member.ticker,
                            name: member.name ?? null,
                            price: metrics[member.ticker]?.price ?? null,
                            change1d: metrics[member.ticker]?.change1d ?? null,
                            marketCap: metrics[member.ticker]?.marketCap ?? null,
                            avgVolume: metrics[member.ticker]?.avgVolume ?? null,
                          })}
                        >
                          <Maximize2 className="h-3.5 w-3.5" />
                          Expand chart
                        </button>
                      </div>
                    </div>
                  ))}
                  {!loading && sortedMembers.length === 0 && (
                    <div className="card p-4 text-sm text-slate-300">No peer group members available for this ticker.</div>
                  )}
                </div>
                <div className="mt-3">
                  <ChartGridPager
                    totalItems={sortedMembers.length}
                    page={memberPage}
                    pageSize={CHARTS_PER_PAGE}
                    itemLabel="tickers"
                    onPageChange={setMemberPage}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {activeChartTicker && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4" onClick={() => setActiveChartTicker(null)}>
          <div
            className="flex h-[calc(100vh-2rem)] w-full max-w-[96vw] flex-col overflow-hidden rounded-[30px] border border-borderSoft/75 bg-panel/95 shadow-[0_24px_80px_rgba(2,6,23,0.55)] 2xl:max-w-[140rem]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-borderSoft/60 bg-panelSoft/35 px-5 py-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Expanded Chart</p>
                <h4 className="mt-1 text-base font-semibold text-slate-100">{activeChartTicker.ticker}</h4>
                {activeChartTicker.name ? <div className="mt-2 text-sm text-slate-400">{activeChartTicker.name}</div> : null}
              </div>
              <button
                data-modal-close="true"
                className="inline-flex items-center justify-center rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55"
                onClick={() => setActiveChartTicker(null)}
              >
                Close
              </button>
            </div>
            <div className="border-b border-borderSoft/50 px-5 py-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Price</div>
                  <div className="mt-1 text-sm font-semibold text-slate-100">{formatPrice(activeChartTicker.price)}</div>
                </div>
                <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">1D %</div>
                  <div className={`mt-1 text-sm font-semibold ${metricChangeClass(activeChartTicker.change1d)}`}>{formatPct(activeChartTicker.change1d)}</div>
                </div>
                <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Market Cap</div>
                  <div className="mt-1 text-sm font-semibold text-slate-100">{formatCompact(activeChartTicker.marketCap)}</div>
                </div>
                <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Avg Vol</div>
                  <div className="mt-1 text-sm font-semibold text-slate-100">{formatCompact(activeChartTicker.avgVolume)}</div>
                </div>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <div className="rounded-[24px] bg-panelSoft/25 p-3">
                <TradingViewWidget
                  ticker={activeChartTicker.ticker}
                  chartOnly
                  showStatusLine
                  fillContainer
                  initialRange="3M"
                  surface="plain"
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
