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
};

export function TickerMultiGrid({
  title,
  items,
  selectedKey,
  onSelect,
  emptyMessage,
}: {
  title: string;
  items: TickerMultiGridItem[];
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  emptyMessage: string;
}) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onFullChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullChange);
    return () => document.removeEventListener("fullscreenchange", onFullChange);
  }, []);

  return (
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
              className={`rounded border p-2 ${isSelected ? "border-accent/60" : "border-borderSoft/60"}`}
            >
              <button
                className={`mb-2 block w-full text-left ${onSelect ? "" : "cursor-default"}`}
                onClick={() => onSelect?.(item.key)}
                disabled={!onSelect}
              >
                <div className="text-sm font-semibold text-accent">{item.title ?? item.ticker}</div>
                {item.subtitle && <div className="text-[11px] text-slate-400">{item.subtitle}</div>}
              </button>
              <TradingViewWidget
                ticker={item.ticker}
                size="small"
                chartOnly
                initialRange="3M"
                className="!border-0 !bg-transparent !shadow-none !p-0"
              />
              {item.detail ? <div className="mt-2">{item.detail}</div> : null}
            </div>
          );
        })}
        {items.length === 0 && (
          <div className="rounded border border-borderSoft/60 bg-panelSoft/20 p-3 text-sm text-slate-400">{emptyMessage}</div>
        )}
      </div>
    </div>
  );
}

