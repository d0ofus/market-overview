"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2 } from "lucide-react";
import { TradingViewWidget } from "./tradingview-widget";

export type TickerMultiGridItem = {
  key: string;
  ticker: string;
  title?: string;
  subtitle?: string | null;
  detail?: ReactNode;
  headerDetail?: ReactNode;
  onTitleClick?: () => void;
  popupTitle?: string;
  popupSubtitle?: ReactNode;
  popupMetrics?: {
    price?: number | null;
    change1d?: number | null;
    marketCap?: number | null;
    avgVolume?: number | null;
  };
};

function formatPrice(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function formatPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatCompact(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function metricChangeClass(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "text-slate-100";
  return value < 0 ? "text-neg" : "text-pos";
}

export function TickerMultiGrid({
  title,
  items,
  selectedKey,
  onSelect,
  emptyMessage,
  showChartStatusLine = false,
  enableChartPopup = false,
}: {
  title: string;
  items: TickerMultiGridItem[];
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  emptyMessage: string;
  showChartStatusLine?: boolean;
  enableChartPopup?: boolean;
}) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [activeChartItem, setActiveChartItem] = useState<TickerMultiGridItem | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onFullChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullChange);
    return () => document.removeEventListener("fullscreenchange", onFullChange);
  }, []);

  useEffect(() => {
    if (!activeChartItem) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveChartItem(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeChartItem]);

  return (
    <>
      <div className="card p-3" ref={gridRef}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
          <button
            className="inline-flex items-center gap-1 rounded border border-borderSoft px-2 py-1 text-xs text-slate-300 hover:bg-slate-800/60"
            onClick={async () => {
              if (!gridRef.current) return;
              if (!document.fullscreenElement) {
                await gridRef.current.requestFullscreen().catch(() => undefined);
              } else {
                await document.exitFullscreen().catch(() => undefined);
              }
            }}
          >
            <Maximize2 className="h-3.5 w-3.5" />
            {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
          </button>
        </div>
        <div className={`grid gap-3 md:grid-cols-2 ${isFullscreen ? "xl:grid-cols-4" : "xl:grid-cols-3 2xl:grid-cols-4"}`}>
          {items.map((item) => {
            const isSelected = selectedKey != null && selectedKey === item.key;
            return (
              <div
                key={item.key}
                className={`rounded border ${showChartStatusLine ? "p-1.5" : "p-2"} ${isSelected ? "border-accent/60" : "border-borderSoft/60"}`}
              >
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {item.onTitleClick ? (
                      <button
                        className="block text-left text-sm font-semibold text-accent hover:underline"
                        onClick={item.onTitleClick}
                      >
                        {item.title ?? item.ticker}
                      </button>
                    ) : (
                      <div className="text-sm font-semibold text-accent">{item.title ?? item.ticker}</div>
                    )}
                    {item.subtitle && (
                      <button
                        className={`mt-0.5 block w-full text-left text-[11px] text-slate-400 ${onSelect ? "" : "cursor-default"}`}
                        onClick={() => onSelect?.(item.key)}
                        disabled={!onSelect}
                      >
                        {item.subtitle}
                      </button>
                    )}
                  </div>
                  {item.headerDetail ? <div className="shrink-0">{item.headerDetail}</div> : null}
                </div>
                <TradingViewWidget
                  ticker={item.ticker}
                  size="small"
                  chartOnly
                  showStatusLine={showChartStatusLine}
                  fillContainer
                  initialRange="3M"
                  className="!border-0 !bg-transparent !shadow-none !p-0"
                />
                {enableChartPopup ? (
                  <button
                    type="button"
                    className="mt-2 inline-flex items-center gap-1 rounded border border-borderSoft px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800/60"
                    onClick={() => setActiveChartItem(item)}
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                    Expand chart
                  </button>
                ) : null}
                {item.detail ? <div className="mt-2">{item.detail}</div> : null}
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="rounded border border-borderSoft/60 bg-panelSoft/20 p-3 text-sm text-slate-400">{emptyMessage}</div>
          )}
        </div>
      </div>
      {enableChartPopup && activeChartItem ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4" onClick={() => setActiveChartItem(null)}>
          <div
            className="flex h-[calc(100vh-2rem)] w-full max-w-[96vw] flex-col overflow-hidden rounded-[30px] border border-borderSoft/75 bg-panel/95 shadow-[0_24px_80px_rgba(2,6,23,0.55)] 2xl:max-w-[140rem]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-borderSoft/60 bg-panelSoft/35 px-5 py-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Expanded Chart</p>
                <h4 className="mt-1 text-base font-semibold text-slate-100">{activeChartItem.popupTitle ?? activeChartItem.title ?? activeChartItem.ticker}</h4>
                {activeChartItem.popupSubtitle ? <div className="mt-2 text-sm text-slate-400">{activeChartItem.popupSubtitle}</div> : null}
              </div>
              <button
                type="button"
                data-modal-close="true"
                className="inline-flex items-center justify-center rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55"
                onClick={() => setActiveChartItem(null)}
              >
                Close
              </button>
            </div>
            {activeChartItem.popupMetrics ? (
              <div className="border-b border-borderSoft/50 px-5 py-4">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Price</div>
                    <div className="mt-1 text-sm font-semibold text-slate-100">{formatPrice(activeChartItem.popupMetrics.price)}</div>
                  </div>
                  <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">1D %</div>
                    <div className={`mt-1 text-sm font-semibold ${metricChangeClass(activeChartItem.popupMetrics.change1d)}`}>
                      {formatPct(activeChartItem.popupMetrics.change1d)}
                    </div>
                  </div>
                  <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Market Cap</div>
                    <div className="mt-1 text-sm font-semibold text-slate-100">{formatCompact(activeChartItem.popupMetrics.marketCap)}</div>
                  </div>
                  <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Avg Vol</div>
                    <div className="mt-1 text-sm font-semibold text-slate-100">{formatCompact(activeChartItem.popupMetrics.avgVolume)}</div>
                  </div>
                </div>
              </div>
            ) : null}
            <div className="flex-1 overflow-y-auto p-5">
              <div className="rounded-[24px] bg-panelSoft/25 p-3">
                <TradingViewWidget
                  ticker={activeChartItem.ticker}
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
      ) : null}
    </>
  );
}
