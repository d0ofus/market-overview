"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Maximize2 } from "lucide-react";
import { TradingViewWidget } from "./tradingview-widget";

const HOVER_CHART_OPEN_DELAY_MS = 180;
const HOVER_CHART_CLOSE_DELAY_MS = 180;
const SECONDARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55";

type HoverChartTarget = {
  ticker: string;
  rect: DOMRect;
};

export type HoverChartPreviewState = {
  ticker: string;
  style: CSSProperties;
};

function computeHoverPreviewStyle(anchorRect: DOMRect): CSSProperties {
  if (typeof window === "undefined") {
    return { top: 16, left: 16, width: 960 };
  }

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const gutter = 16;
  const previewGap = 14;
  const minWidth = 420;
  const maxWidth = Math.min(960, viewportWidth - gutter * 2);
  const availableRight = viewportWidth - anchorRect.right - previewGap - gutter;
  const availableLeft = anchorRect.left - previewGap - gutter;
  const preferredSide = availableRight >= availableLeft ? "right" : "left";
  const bestSideSpace = Math.max(availableRight, availableLeft);

  let width = maxWidth;
  let left = gutter;
  let top = anchorRect.top - 20;

  if (bestSideSpace >= minWidth) {
    width = Math.min(maxWidth, bestSideSpace);
    left = preferredSide === "right"
      ? anchorRect.right + previewGap
      : anchorRect.left - width - previewGap;
  } else {
    left = Math.min(
      Math.max(gutter, anchorRect.left + anchorRect.width / 2 - width / 2),
      viewportWidth - width - gutter,
    );
    top = anchorRect.bottom + previewGap;
  }

  const estimatedHeight = Math.min(viewportHeight - gutter * 2, Math.max(420, Math.round(width * 0.7)));

  if (top + estimatedHeight + gutter > viewportHeight) {
    top = anchorRect.top - estimatedHeight - previewGap;
  }

  top = Math.min(Math.max(gutter, top), viewportHeight - estimatedHeight - gutter);

  return {
    top,
    left,
    width,
  };
}

export function useHoverChartPreview({ disabled = false }: { disabled?: boolean } = {}) {
  const [hoverChartTarget, setHoverChartTarget] = useState<HoverChartTarget | null>(null);
  const [hoverChartPreview, setHoverChartPreview] = useState<HoverChartPreviewState | null>(null);
  const [isHoverPreviewHovered, setIsHoverPreviewHovered] = useState(false);
  const [supportsTickerHover, setSupportsTickerHover] = useState(false);
  const hoverOpenTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverTimers = useCallback(() => {
    if (hoverOpenTimeoutRef.current) {
      clearTimeout(hoverOpenTimeoutRef.current);
      hoverOpenTimeoutRef.current = null;
    }
    if (hoverCloseTimeoutRef.current) {
      clearTimeout(hoverCloseTimeoutRef.current);
      hoverCloseTimeoutRef.current = null;
    }
  }, []);

  const clearPreview = useCallback(() => {
    clearHoverTimers();
    setHoverChartTarget(null);
    setHoverChartPreview(null);
    setIsHoverPreviewHovered(false);
  }, [clearHoverTimers]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
    const syncHoverSupport = () => setSupportsTickerHover(mediaQuery.matches);
    syncHoverSupport();
    mediaQuery.addEventListener?.("change", syncHoverSupport);
    return () => mediaQuery.removeEventListener?.("change", syncHoverSupport);
  }, []);

  useEffect(() => () => clearHoverTimers(), [clearHoverTimers]);

  useEffect(() => {
    if (!disabled) return;
    clearPreview();
  }, [clearPreview, disabled]);

  useEffect(() => {
    if (disabled || !supportsTickerHover || !hoverChartTarget) {
      if (hoverOpenTimeoutRef.current) {
        clearTimeout(hoverOpenTimeoutRef.current);
        hoverOpenTimeoutRef.current = null;
      }
      return;
    }
    if (hoverChartPreview?.ticker === hoverChartTarget.ticker) return;
    if (hoverOpenTimeoutRef.current) clearTimeout(hoverOpenTimeoutRef.current);
    hoverOpenTimeoutRef.current = setTimeout(() => {
      setHoverChartPreview({
        ticker: hoverChartTarget.ticker,
        style: computeHoverPreviewStyle(hoverChartTarget.rect),
      });
      hoverOpenTimeoutRef.current = null;
    }, HOVER_CHART_OPEN_DELAY_MS);
    return () => {
      if (hoverOpenTimeoutRef.current) {
        clearTimeout(hoverOpenTimeoutRef.current);
        hoverOpenTimeoutRef.current = null;
      }
    };
  }, [disabled, hoverChartPreview?.ticker, hoverChartTarget, supportsTickerHover]);

  useEffect(() => {
    if (!hoverChartPreview) {
      if (hoverCloseTimeoutRef.current) {
        clearTimeout(hoverCloseTimeoutRef.current);
        hoverCloseTimeoutRef.current = null;
      }
      return;
    }
    if (hoverChartTarget || isHoverPreviewHovered || disabled) {
      if (hoverCloseTimeoutRef.current) {
        clearTimeout(hoverCloseTimeoutRef.current);
        hoverCloseTimeoutRef.current = null;
      }
      return;
    }
    if (hoverCloseTimeoutRef.current) clearTimeout(hoverCloseTimeoutRef.current);
    hoverCloseTimeoutRef.current = setTimeout(() => {
      setHoverChartPreview(null);
      hoverCloseTimeoutRef.current = null;
    }, HOVER_CHART_CLOSE_DELAY_MS);
    return () => {
      if (hoverCloseTimeoutRef.current) {
        clearTimeout(hoverCloseTimeoutRef.current);
        hoverCloseTimeoutRef.current = null;
      }
    };
  }, [disabled, hoverChartPreview, hoverChartTarget, isHoverPreviewHovered]);

  useEffect(() => {
    if (disabled || !supportsTickerHover || !hoverChartTarget || !hoverChartPreview) return;
    if (hoverChartPreview.ticker !== hoverChartTarget.ticker) return;
    setHoverChartPreview((current) => {
      if (!current || current.ticker !== hoverChartTarget.ticker) return current;
      return {
        ticker: current.ticker,
        style: computeHoverPreviewStyle(hoverChartTarget.rect),
      };
    });
  }, [disabled, hoverChartPreview, hoverChartTarget, supportsTickerHover]);

  const openPreview = useCallback((ticker: string, element: HTMLElement) => {
    if (!supportsTickerHover || disabled) return;
    setHoverChartTarget({ ticker, rect: element.getBoundingClientRect() });
  }, [disabled, supportsTickerHover]);

  const closePreviewForTicker = useCallback((ticker: string) => {
    if (!supportsTickerHover || disabled) return;
    setHoverChartTarget((current) => (current?.ticker === ticker ? null : current));
  }, [disabled, supportsTickerHover]);

  const handlePreviewMouseEnter = useCallback(() => setIsHoverPreviewHovered(true), []);
  const handlePreviewMouseLeave = useCallback(() => setIsHoverPreviewHovered(false), []);

  return {
    preview: hoverChartPreview,
    openPreview,
    closePreviewForTicker,
    clearPreview,
    handlePreviewMouseEnter,
    handlePreviewMouseLeave,
  };
}

export function HoverChartPreviewPanel({
  preview,
  onPreviewMouseEnter,
  onPreviewMouseLeave,
  onPinChart,
}: {
  preview: HoverChartPreviewState | null;
  onPreviewMouseEnter: () => void;
  onPreviewMouseLeave: () => void;
  onPinChart: (ticker: string) => void;
}) {
  if (!preview) return null;

  return (
    <div
      className="fixed z-40 hidden max-h-[calc(100vh-2rem)] overflow-hidden rounded-[30px] border border-borderSoft/75 bg-panel/95 shadow-[0_24px_80px_rgba(2,6,23,0.48)] xl:block"
      style={preview.style}
      onMouseEnter={onPreviewMouseEnter}
      onMouseLeave={onPreviewMouseLeave}
    >
      <div className="flex items-center justify-between border-b border-borderSoft/60 bg-panelSoft/35 px-5 py-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Hover Preview</p>
          <h4 className="mt-1 text-base font-semibold text-slate-100">TradingView: {preview.ticker}</h4>
        </div>
        <button className={SECONDARY_BUTTON_CLASS} onClick={() => onPinChart(preview.ticker)}>
          <Maximize2 className="h-3.5 w-3.5" />
          Pin chart
        </button>
      </div>
      <div className="p-4">
        <div className="rounded-[24px] bg-panelSoft/25 p-3">
          <TradingViewWidget ticker={preview.ticker} chartOnly showStatusLine fillContainer initialRange="3M" surface="plain" />
        </div>
      </div>
    </div>
  );
}

export function ExpandedTradingViewChartModal({ ticker, onClose }: { ticker: string | null; onClose: () => void }) {
  if (!ticker) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4" onClick={onClose}>
      <div className="w-full max-w-5xl overflow-hidden rounded-[30px] border border-borderSoft/75 bg-panel/95 shadow-[0_24px_80px_rgba(2,6,23,0.55)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-borderSoft/60 bg-panelSoft/35 px-5 py-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Expanded Chart</p>
            <h4 className="mt-1 text-base font-semibold text-slate-100">TradingView: {ticker}</h4>
          </div>
          <button data-modal-close="true" className={SECONDARY_BUTTON_CLASS} onClick={onClose}>
            Close
          </button>
        </div>
        <div className="p-4">
          <div className="rounded-[24px] bg-panelSoft/25 p-3">
            <TradingViewWidget ticker={ticker} chartOnly showStatusLine fillContainer initialRange="3M" surface="plain" />
          </div>
        </div>
      </div>
    </div>
  );
}
