"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Maximize2 } from "lucide-react";
import {
  getPeerTickerDetail,
  getPeerTickerMetrics,
  type PeerMetricRow,
  type PeerTickerDetail,
} from "@/lib/api";
import { TradingViewWidget } from "./tradingview-widget";

function formatPrice(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function formatCompact(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
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
  const [activeChartTicker, setActiveChartTicker] = useState<string | null>(null);

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

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-950/70 p-4" onClick={onClose}>
        <div className="w-full max-w-6xl" onClick={(event) => event.stopPropagation()}>
          <div className="mb-2 flex items-center justify-between rounded border border-borderSoft bg-panel px-3 py-2">
            <h4 className="text-sm font-semibold text-slate-100">
              {ticker} Peer Group {activeGroup ? `- ${activeGroup.name}` : ""}
            </h4>
            <button data-modal-close="true" className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-200" onClick={onClose}>
              Close
            </button>
          </div>
          <div className="mb-2 flex items-center gap-2 rounded border border-slate-300/70 bg-slate-100/95 px-3 py-2 text-xs text-slate-700 dark:border-borderSoft/70 dark:bg-panelSoft/30 dark:text-slate-200">
            <span className="text-slate-700 dark:text-slate-400">Source:</span>
            <span className="rounded bg-accent/20 px-2 py-1 text-accent">{activeGroup?.name ?? "Peer database"}</span>
            <span className="ml-auto rounded bg-white/90 px-2 py-1 text-slate-700 shadow-sm dark:bg-slate-800/80 dark:text-slate-200 dark:shadow-none">
              {sortedMembers.length} ticker{sortedMembers.length === 1 ? "" : "s"}
            </span>
          </div>
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
          {loading ? (
            <div className="card flex items-center gap-2 p-4 text-sm text-slate-300">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading peer group...
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {sortedMembers.map((member) => (
                <div key={`${ticker}-${member.ticker}`} className="card p-2">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-semibold text-accent">{member.ticker}</span>
                    <span className={`text-xs ${(metrics[member.ticker]?.change1d ?? 0) >= 0 ? "text-pos" : "text-neg"}`}>
                      {typeof metrics[member.ticker]?.change1d === "number"
                        ? `${metrics[member.ticker]!.change1d!.toFixed(2)}%`
                        : "-"}
                    </span>
                  </div>
                  <div className="mb-1 text-xs text-slate-300">
                    <div className="grid grid-cols-3 gap-2 text-[11px] text-slate-400">
                      <div>Price: <span className="text-slate-200">{formatPrice(metrics[member.ticker]?.price)}</span></div>
                      <div>Mkt Cap: <span className="text-slate-200">{formatCompact(metrics[member.ticker]?.marketCap)}</span></div>
                      <div>Avg Vol: <span className="text-slate-200">{formatCompact(metrics[member.ticker]?.avgVolume)}</span></div>
                    </div>
                  </div>
                  <p className="mb-2 line-clamp-2 text-xs text-slate-400">{member.name ?? member.ticker}</p>
                  <TradingViewWidget ticker={member.ticker} size="small" chartOnly initialRange="3M" className="!border-0 !bg-transparent !shadow-none !p-0" />
                  <button
                    className="mt-2 inline-flex items-center gap-1 rounded border border-borderSoft px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800/60"
                    onClick={() => setActiveChartTicker(member.ticker)}
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                    Expand chart
                  </button>
                </div>
              ))}
              {!loading && sortedMembers.length === 0 && (
                <div className="card p-4 text-sm text-slate-300">No peer group members available for this ticker.</div>
              )}
            </div>
          )}
        </div>
      </div>

      {activeChartTicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4" onClick={() => setActiveChartTicker(null)}>
          <div className="w-full max-w-5xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between rounded border border-borderSoft bg-panel px-3 py-2">
              <h4 className="text-sm font-semibold text-slate-100">TradingView: {activeChartTicker}</h4>
              <button data-modal-close="true" className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-200" onClick={() => setActiveChartTicker(null)}>
                Close
              </button>
            </div>
            <TradingViewWidget ticker={activeChartTicker} chartOnly initialRange="3M" />
          </div>
        </div>
      )}
    </>
  );
}
