"use client";

import { useEffect, useId, useRef, useState } from "react";

const DEFAULT_CHART_INTERVAL = "D";
const DEFAULT_CHART_STYLE = "1";
const DEFAULT_CHART_TIMEZONE = "Etc/UTC";

type WidgetTheme = "dark" | "light";
export type TradingViewComparePosition = "SameScale" | "NewPriceScale" | "NewPane";
export type TradingViewCompareSymbol = {
  symbol: string;
  position: TradingViewComparePosition;
  lineColor?: string;
  lineWidth?: number;
};
type TradingViewChartStyle = "1" | "2" | "3";

let cachedTheme: WidgetTheme = "dark";
let themeObserver: MutationObserver | null = null;
const themeListeners = new Set<(theme: WidgetTheme) => void>();

function readTheme(): WidgetTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

function ensureThemeObserver() {
  if (typeof document === "undefined" || themeObserver) return;
  cachedTheme = readTheme();
  themeObserver = new MutationObserver(() => {
    const nextTheme = readTheme();
    if (nextTheme === cachedTheme) return;
    cachedTheme = nextTheme;
    themeListeners.forEach((listener) => listener(nextTheme));
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}

function subscribeToTheme(listener: (theme: WidgetTheme) => void) {
  ensureThemeObserver();
  themeListeners.add(listener);
  listener(cachedTheme);
  return () => {
    themeListeners.delete(listener);
    if (themeListeners.size === 0 && themeObserver) {
      themeObserver.disconnect();
      themeObserver = null;
    }
  };
}

export function TradingViewWidget({
  ticker,
  compareSymbol,
  compareSymbols,
  chartStyle = DEFAULT_CHART_STYLE,
  compact = false,
  size = "default",
  chartOnly = false,
  showStatusLine = false,
  showCorporateEvents = false,
  baseSeriesColor,
  baseSeriesLineWidth,
  fillContainer = false,
  heightMode = "aspect",
  initialRange = "1M",
  surface = "card",
  className = "",
}: {
  ticker: string;
  compareSymbol?: string;
  compareSymbols?: TradingViewCompareSymbol[];
  chartStyle?: TradingViewChartStyle;
  compact?: boolean;
  size?: "small" | "default";
  chartOnly?: boolean;
  showStatusLine?: boolean;
  showCorporateEvents?: boolean;
  baseSeriesColor?: string;
  baseSeriesLineWidth?: number;
  fillContainer?: boolean;
  heightMode?: "aspect" | "fill";
  initialRange?: "1M" | "3M" | "6M" | "12M";
  surface?: "card" | "plain";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<WidgetTheme>("dark");
  const [shouldLoad, setShouldLoad] = useState(false);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const containerId = `tv-adv-${ticker.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}-${uid}`;
  const denseStatusLayout = chartOnly && showStatusLine;
  const maxWidth = fillContainer
    ? Number.POSITIVE_INFINITY
    : size === "small"
      ? (denseStatusLayout ? 560 : 420)
      : compact
        ? 640
        : 880;
  const frameClass = heightMode === "fill"
    ? "h-full min-h-0 w-full"
    : fillContainer
      ? denseStatusLayout
        ? "w-full aspect-[8/5]"
        : "w-full aspect-[16/11]"
      : size === "small"
        ? denseStatusLayout
          ? "w-full max-w-[560px] aspect-[7/5]"
          : "w-full max-w-[420px] aspect-[4/3]"
        : compact
          ? "w-full max-w-[640px] aspect-[4/3]"
          : "w-full max-w-[880px] aspect-[4/3]";
  const resolvedCompareSymbols = [
    ...(compareSymbol ? [{ symbol: compareSymbol, position: "SameScale" as const }] : []),
    ...(compareSymbols ?? []),
  ].filter((item, index, array) => (
    item.symbol.trim()
    && array.findIndex((candidate) => candidate.symbol === item.symbol) === index
  ));
  const compareSymbolsKey = JSON.stringify(resolvedCompareSymbols);

  useEffect(() => {
    return subscribeToTheme(setTheme);
  }, []);

  useEffect(() => {
    if (!ref.current || shouldLoad) return;
    if (typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin: "300px 0px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [shouldLoad]);

  useEffect(() => {
    if (!ref.current || !shouldLoad) return;
    const minWidth = size === "small" ? 280 : 360;
    const width = Math.max(minWidth, Math.min(ref.current.clientWidth, maxWidth));
    const height = heightMode === "fill"
      ? ref.current.clientHeight || Math.round(width * 0.75)
      : Math.round(width * 0.75);
    const overrides: Record<string, boolean | number | string> = {};
    if (showStatusLine) {
      Object.assign(overrides, {
        "paneProperties.legendProperties.showSeriesOHLC": true,
        "paneProperties.legendProperties.showBarChange": true,
        "paneProperties.legendProperties.showVolume": true,
        "mainSeriesProperties.statusViewStyle.showExchange": false,
        "mainSeriesProperties.statusViewStyle.showInterval": false,
      });
    }
    if (baseSeriesColor) {
      Object.assign(overrides, {
        "mainSeriesProperties.lineStyle.color": baseSeriesColor,
        "mainSeriesProperties.priceLineColor": baseSeriesColor,
      });
    }
    if (typeof baseSeriesLineWidth === "number" && Number.isFinite(baseSeriesLineWidth)) {
      Object.assign(overrides, {
        "mainSeriesProperties.lineStyle.linewidth": baseSeriesLineWidth,
        "mainSeriesProperties.lineStyle.lineWidth": baseSeriesLineWidth,
      });
    }
    const serializedCompareSymbols = resolvedCompareSymbols.map((item) => ({
      symbol: item.symbol,
      position: item.position,
      ...(item.lineColor ? { lineColor: item.lineColor, color: item.lineColor } : {}),
      ...(typeof item.lineWidth === "number" && Number.isFinite(item.lineWidth) ? { lineWidth: item.lineWidth } : {}),
    }));
    ref.current.innerHTML = "";
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.innerHTML = JSON.stringify({
      width,
      height,
      symbol: ticker,
      interval: DEFAULT_CHART_INTERVAL,
      timeframe: initialRange,
      timezone: DEFAULT_CHART_TIMEZONE,
      theme,
      style: chartStyle,
      allow_symbol_change: chartOnly ? false : !chartOnly,
      hide_top_toolbar: chartOnly,
      hide_side_toolbar: chartOnly,
      hide_legend: chartOnly ? !showStatusLine : false,
      volume_force_overlay: false,
      overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      withdateranges: chartOnly ? false : true,
      calendar: showCorporateEvents,
      save_image: false,
      compareSymbols: serializedCompareSymbols,
      container_id: containerId,
    });
    ref.current.appendChild(script);
  }, [ticker, chartStyle, compareSymbolsKey, containerId, maxWidth, size, chartOnly, showStatusLine, showCorporateEvents, baseSeriesColor, baseSeriesLineWidth, initialRange, theme, shouldLoad, heightMode]);

  const heightClassName = heightMode === "fill" ? "h-full min-h-0" : "";
  const shellClassName = surface === "plain"
    ? `${heightClassName} ${className}`.trim()
    : `card ${denseStatusLayout ? "p-1" : "p-2"} ${heightClassName} ${className}`.trim();

  return (
    <div className={shellClassName}>
      <div className={`tradingview-widget-container ${fillContainer ? "" : "mx-auto"} ${frameClass}`} ref={ref}>
        <div id={containerId} className={`h-full ${shouldLoad ? "" : "animate-pulse rounded bg-slate-900/30"}`} />
      </div>
    </div>
  );
}
