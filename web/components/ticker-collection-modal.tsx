"use client";

import { type ReactNode } from "react";
import { Loader2, Maximize2 } from "lucide-react";
import { ChartGridPager } from "./chart-grid-pager";
import { TradingViewWidget } from "./tradingview-widget";

const SECONDARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55";

export type TickerCollectionModalItem = {
  key: string;
  ticker: string;
  name?: string | null;
  metricLabel?: string;
  metricValue?: string | null;
  badges?: ReactNode;
  stats?: ReactNode;
};

export function TickerCollectionModal({
  eyebrow,
  title,
  description,
  items,
  totalItems,
  page,
  pageSize,
  itemLabel,
  controls,
  warning,
  loading = false,
  loadingLabel = "Loading charts...",
  emptyMessage,
  onPageChange,
  onClose,
  onExpandChart,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  items: TickerCollectionModalItem[];
  totalItems: number;
  page: number;
  pageSize: number;
  itemLabel: string;
  controls?: ReactNode;
  warning?: string | null;
  loading?: boolean;
  loadingLabel?: string;
  emptyMessage: string;
  onPageChange: (page: number) => void;
  onClose: () => void;
  onExpandChart: (ticker: string) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4" onClick={onClose}>
      <div
        className="flex h-[calc(100vh-2rem)] w-full max-w-[96vw] flex-col overflow-hidden rounded-[30px] border border-borderSoft/75 bg-panel/95 shadow-[0_24px_80px_rgba(2,6,23,0.55)] 2xl:max-w-[150rem]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-borderSoft/60 bg-panelSoft/35 px-5 py-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{eyebrow}</p>
            <h4 className="mt-1 text-base font-semibold text-slate-100">{title}</h4>
            {description ? <div className="mt-2 text-sm text-slate-400">{description}</div> : null}
          </div>
          <button data-modal-close="true" className={SECONDARY_BUTTON_CLASS} onClick={onClose}>
            Close
          </button>
        </div>

        {controls ? <div className="border-b border-borderSoft/50 px-5 py-4">{controls}</div> : null}

        <div className="overflow-y-auto px-5 py-5">
          {warning ? (
            <div className="mb-3 rounded-2xl border border-yellow-700/45 bg-yellow-900/15 px-4 py-3 text-sm text-yellow-200">
              {warning}
            </div>
          ) : null}

          <ChartGridPager
            totalItems={totalItems}
            page={page}
            pageSize={pageSize}
            itemLabel={itemLabel}
            onPageChange={onPageChange}
          />

          {loading ? (
            <div className="card flex items-center gap-2 p-4 text-sm text-slate-300">
              <Loader2 className="h-4 w-4 animate-spin" />
              {loadingLabel}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {items.map((item) => (
                <div key={item.key} className="rounded-[24px] border border-borderSoft/60 bg-gradient-to-b from-panelSoft/45 to-panel/40 p-4">
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-lg font-semibold text-accent">{item.ticker}</div>
                      {item.name && item.name !== item.ticker ? (
                        <p className="mt-1 line-clamp-1 text-sm text-slate-400">{item.name}</p>
                      ) : null}
                    </div>
                    {item.stats ? (
                      <div className="flex flex-wrap items-center justify-end gap-2">{item.stats}</div>
                    ) : item.metricLabel || item.metricValue ? (
                      <div className="text-right text-xs">
                        {item.metricLabel ? <div className="text-slate-500">{item.metricLabel}</div> : null}
                        <div className="mt-1 text-sm font-semibold text-slate-100">{item.metricValue ?? "-"}</div>
                      </div>
                    ) : null}
                  </div>

                  {item.badges ? <div className="mb-4 flex items-center gap-2 text-sm">{item.badges}</div> : null}

                  <div className="rounded-[22px] bg-slate-950/20 p-2.5">
                    <TradingViewWidget
                      ticker={item.ticker}
                      size="small"
                      chartOnly
                      showStatusLine
                      fillContainer
                      initialRange="3M"
                      surface="plain"
                    />
                  </div>

                  <div className="mt-4 flex justify-end">
                    <button className={SECONDARY_BUTTON_CLASS} onClick={() => onExpandChart(item.ticker)}>
                      <Maximize2 className="h-3.5 w-3.5" />
                      Expand chart
                    </button>
                  </div>
                </div>
              ))}
              {totalItems === 0 ? (
                <div className="rounded-[24px] border border-borderSoft/60 bg-panelSoft/30 p-5 text-sm text-slate-300">
                  {emptyMessage}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
