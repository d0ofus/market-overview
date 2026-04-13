"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2, X } from "lucide-react";
import { TradingViewWidget } from "./tradingview-widget";

export type TickerMultiGridItem = {
  key: string;
  ticker: string;
  title?: string;
  subtitle?: string | null;
  detail?: ReactNode;
  headerDetail?: ReactNode;
  onTitleClick?: () => void;
};

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
  const [activeChartTicker, setActiveChartTicker] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onFullChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullChange);
    return () => document.removeEventListener("fullscreenchange", onFullChange);
  }, []);

  useEffect(() => {
    if (!activeChartTicker) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveChartTicker(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeChartTicker]);

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
                    onClick={() => setActiveChartTicker(item.ticker)}
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
      {enableChartPopup && activeChartTicker ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4" onClick={() => setActiveChartTicker(null)}>
          <div className="w-full max-w-5xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between rounded border border-borderSoft bg-panel px-3 py-2">
              <h4 className="text-sm font-semibold text-slate-100">TradingView: {activeChartTicker}</h4>
              <button
                type="button"
                className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-200"
                onClick={() => setActiveChartTicker(null)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <TradingViewWidget ticker={activeChartTicker} chartOnly showStatusLine fillContainer initialRange="3M" />
          </div>
        </div>
      ) : null}
    </>
  );
}
