"use client";

import { useCallback, useState } from "react";
import { Activity, BarChart3, Loader2, Maximize2 } from "lucide-react";
import { getTickerNews, type AlertNewsRow } from "@/lib/api";
import { earningsGridMetricClass, type EarningsGridCard } from "@/lib/earnings-multi-chart";
import { ChartGridPager } from "./chart-grid-pager";
import { FundamentalsModal } from "./fundamentals-modal";
import {
  MultiChartMetricBubble,
  MultiChartMovementExpansion,
  MultiChartNewsList,
  useMultiChartMovement,
} from "./multi-chart-grid-primitives";
import { PeerGroupModal } from "./peer-group-modal";
import { TradingViewWidget } from "./tradingview-widget";

type NewsCardState = {
  loading: boolean;
  rows: AlertNewsRow[];
  error: string | null;
};

export function EarningsMultiChartGrid({
  cards,
  total,
  page,
  pageSize,
  loading,
  error,
  onPageChange,
  onPageSizeChange,
}: {
  cards: EarningsGridCard[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  error: string | null;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const [openNews, setOpenNews] = useState<Set<string>>(new Set());
  const [expandedNews, setExpandedNews] = useState<Set<string>>(new Set());
  const [newsByKey, setNewsByKey] = useState<Record<string, NewsCardState>>({});
  const [activePeerTicker, setActivePeerTicker] = useState<string | null>(null);
  const [activeFundamentalsTicker, setActiveFundamentalsTicker] = useState<string | null>(null);
  const [activeChart, setActiveChart] = useState<EarningsGridCard | null>(null);
  const { movementByKey, loadMovement, openMovementVerification, toggleMovement } = useMultiChartMovement();

  const loadNews = useCallback(async (card: EarningsGridCard) => {
    setNewsByKey((current) => ({
      ...current,
      [card.id]: { loading: true, rows: current[card.id]?.rows ?? [], error: null },
    }));
    try {
      const response = await getTickerNews(card.ticker, card.reportDate, 3);
      setNewsByKey((current) => ({
        ...current,
        [card.id]: { loading: false, rows: response.rows ?? [], error: null },
      }));
    } catch (newsError) {
      setNewsByKey((current) => ({
        ...current,
        [card.id]: {
          loading: false,
          rows: current[card.id]?.rows ?? [],
          error: newsError instanceof Error ? newsError.message : "Failed to load earnings-date news.",
        },
      }));
    }
  }, []);

  const toggleNews = useCallback((card: EarningsGridCard) => {
    const isOpen = openNews.has(card.id);
    setOpenNews((current) => {
      const next = new Set(current);
      if (isOpen) next.delete(card.id);
      else next.add(card.id);
      return next;
    });
    if (!isOpen && !newsByKey[card.id]) void loadNews(card);
  }, [loadNews, newsByKey, openNews]);

  const toggleNewsDetails = (key: string) => {
    setExpandedNews((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
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
              value={pageSize}
              onChange={(event) => onPageSizeChange(Math.max(1, Math.min(48, Number(event.target.value) || 12)))}
            />
          </label>
          <ChartGridPager totalItems={total} page={page} pageSize={pageSize} itemLabel="earnings events" onPageChange={onPageChange} />
        </div>
      </div>
      <div className="card p-3">
        <div className="text-sm text-slate-300">Multi-Chart Grid ({total} earnings event{total === 1 ? "" : "s"})</div>
      </div>
      {error ? <div className="rounded border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</div> : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => {
          const newsOpen = openNews.has(card.id);
          const newsState = newsByKey[card.id];
          const movementState = movementByKey[card.id];
          const movementOpen = movementState?.open ?? false;
          return (
            <div
              key={card.id}
              role="group"
              tabIndex={0}
              aria-label={`${card.ticker} chart card for ${card.reportDate}`}
              aria-keyshortcuts="Alt+Enter"
              className="rounded-[24px] border border-borderSoft/60 bg-gradient-to-b from-panelSoft/45 to-panel/40 p-4 focus:outline-none focus:ring-2 focus:ring-accent/45"
              onKeyDown={(event) => {
                if (!event.altKey || event.key !== "Enter") return;
                event.preventDefault();
                event.stopPropagation();
                setActiveChart(card);
              }}
            >
              <div className="mb-4 space-y-2">
                <div className="grid grid-cols-[auto,minmax(0,1fr)] items-center gap-3">
                  <button type="button" className="text-left text-lg font-semibold text-accent hover:underline" onClick={() => setActivePeerTicker(card.ticker)}>
                    {card.ticker}
                  </button>
                  <div className="flex min-w-0 items-center justify-end">
                    <span className="shrink-0 rounded-full border border-accent/35 bg-accent/10 px-3 py-1 text-[11px] font-semibold text-accent">
                      {card.reportDate || "-"}
                    </span>
                  </div>
                </div>
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr),auto,auto] items-center gap-2">
                  {card.primaryMetrics.map((item, index) => (
                    <MultiChartMetricBubble key={item.label} className={index === 0 ? "w-full" : "shrink-0"} label={item.label} value={item.value} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  {card.signedMetrics.map((item) => (
                    <MultiChartMetricBubble key={item.label} label={item.label} value={item.value} valueClass={earningsGridMetricClass(item.rawValue)} />
                  ))}
                </div>
              </div>
              <div className="rounded-[22px] bg-panelSoft/25 p-2.5">
                <TradingViewWidget ticker={card.ticker} chartOnly showStatusLine fillContainer initialRange="3M" surface="plain" />
              </div>
              <div className="mt-4 flex flex-wrap justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="inline-flex items-center gap-2 rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55" onClick={() => toggleNews(card)}>
                    {newsOpen ? "Hide latest news" : "Show latest news"}
                  </button>
                  <button type="button" className="inline-flex items-center gap-2 rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55" onClick={() => setActiveFundamentalsTicker(card.ticker)}>
                    <BarChart3 className="h-3.5 w-3.5" /> Fundamentals
                  </button>
                  <button
                    type="button"
                    className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition ${movementOpen ? "border-accent/45 bg-accent/15 text-accent" : "border-borderSoft/70 bg-panelSoft/35 text-slate-200 hover:bg-panelSoft/55"}`}
                    onClick={() => toggleMovement(card.id, card.ticker)}
                  >
                    <Activity className="h-3.5 w-3.5" /> Movement
                  </button>
                </div>
                <button type="button" className="inline-flex items-center justify-center gap-2 rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55" onClick={() => setActiveChart(card)}>
                  <Maximize2 className="h-3.5 w-3.5" /> Expand chart
                </button>
              </div>
              {movementOpen && movementState ? (
                <MultiChartMovementExpansion
                  ticker={card.ticker}
                  state={movementState}
                  onRefresh={() => void loadMovement(card.id, card.ticker, true)}
                  onVerify={() => void openMovementVerification(card.id, card.ticker)}
                />
              ) : null}
              {newsOpen ? (
                <div className="mt-4 rounded-[18px] border border-borderSoft/60 bg-panelSoft/25 p-3">
                  <h4 className="mb-2 text-sm font-semibold text-slate-100">Latest News Around {card.reportDate}</h4>
                  {newsState?.loading ? (
                    <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading news...</div>
                  ) : newsState?.error ? (
                    <div className="rounded border border-red-500/40 bg-red-900/20 px-3 py-2 text-xs text-red-200">{newsState.error}</div>
                  ) : (
                    <MultiChartNewsList items={newsState?.rows ?? []} expanded={expandedNews} onToggle={toggleNewsDetails} compact />
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
        {loading ? (
          <div className="card flex min-h-40 items-center justify-center p-4 text-sm text-slate-300"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading earnings charts...</div>
        ) : cards.length === 0 && !error ? (
          <div className="card p-4 text-sm text-slate-300">No earnings events match current filters.</div>
        ) : null}
      </div>
      <div className="flex justify-end px-1">
        <ChartGridPager totalItems={total} page={page} pageSize={pageSize} itemLabel="earnings events" onPageChange={onPageChange} />
      </div>

      {activePeerTicker ? <PeerGroupModal ticker={activePeerTicker} onClose={() => setActivePeerTicker(null)} /> : null}
      {activeFundamentalsTicker ? <FundamentalsModal ticker={activeFundamentalsTicker} onClose={() => setActiveFundamentalsTicker(null)} /> : null}
      {activeChart ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-2 md:p-3" onClick={() => setActiveChart(null)}>
          <div className="flex h-[calc(100vh-1rem)] w-full max-w-[98vw] flex-col overflow-hidden rounded-[24px] border border-borderSoft/75 bg-panel/95 shadow-[0_24px_80px_rgba(2,6,23,0.55)] md:h-[calc(100vh-1.5rem)] 2xl:max-w-[140rem]" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 border-b border-borderSoft/60 bg-panelSoft/35 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Expanded Chart</p>
                  <h4 className="text-base font-semibold text-slate-100">{activeChart.ticker}</h4>
                  <span className="text-sm text-slate-400">Report {activeChart.reportDate}</span>
                </div>
              </div>
              <button type="button" data-modal-close="true" className="inline-flex shrink-0 items-center justify-center rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55" onClick={() => setActiveChart(null)}>Close</button>
            </div>
            <div className="overflow-x-auto border-b border-borderSoft/50 px-4 py-2">
              <div className="flex min-w-max flex-nowrap gap-2">
                {activeChart.expandedMetrics.map((item) => (
                  <MultiChartMetricBubble key={item.label} className="shrink-0" label={item.label} value={item.value} valueClass={earningsGridMetricClass(item.rawValue)} />
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden p-3">
              <div className="h-full min-h-0 rounded-[20px] bg-panelSoft/25 p-2">
                <TradingViewWidget ticker={activeChart.ticker} chartOnly showStatusLine fillContainer heightMode="fill" initialRange="3M" surface="plain" />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
