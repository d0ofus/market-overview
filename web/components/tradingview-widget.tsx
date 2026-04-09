"use client";

import { useEffect, useId, useRef, useState } from "react";

const DEFAULT_CHART_INTERVAL = "D";
const DEFAULT_CHART_STYLE = "1";
const DEFAULT_CHART_TIMEZONE = "Etc/UTC";

type WidgetTheme = "dark" | "light";

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
  compact = false,
  size = "default",
  chartOnly = false,
  showStatusLine = false,
  fillContainer = false,
  initialRange = "1M",
  surface = "card",
  className = "",
}: {
  ticker: string;
  compareSymbol?: string;
  compact?: boolean;
  size?: "small" | "default";
  chartOnly?: boolean;
  showStatusLine?: boolean;
  fillContainer?: boolean;
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
  const frameClass = fillContainer
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
    const height = Math.round(width * 0.75);
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
      style: DEFAULT_CHART_STYLE,
      allow_symbol_change: chartOnly ? false : !chartOnly,
      hide_top_toolbar: chartOnly,
      hide_side_toolbar: chartOnly,
      hide_legend: chartOnly ? !showStatusLine : false,
      volume_force_overlay: false,
      overrides: showStatusLine
        ? {
            "paneProperties.legendProperties.showSeriesOHLC": true,
            "paneProperties.legendProperties.showBarChange": true,
            "paneProperties.legendProperties.showVolume": true,
            "mainSeriesProperties.statusViewStyle.showExchange": false,
            "mainSeriesProperties.statusViewStyle.showInterval": false,
          }
        : undefined,
      withdateranges: chartOnly ? false : true,
      save_image: false,
      compareSymbols: compareSymbol
        ? [
            {
              symbol: compareSymbol,
              position: "SameScale",
            },
          ]
        : [],
      container_id: containerId,
    });
    ref.current.appendChild(script);
  }, [ticker, compareSymbol, containerId, maxWidth, size, chartOnly, showStatusLine, initialRange, theme, shouldLoad]);

  const shellClassName = surface === "plain"
    ? className
    : `card ${denseStatusLayout ? "p-1" : "p-2"} ${className}`;

  return (
    <div className={shellClassName}>
      <div className={`tradingview-widget-container ${fillContainer ? "" : "mx-auto"} ${frameClass}`} ref={ref}>
        <div id={containerId} className={`h-full ${shouldLoad ? "" : "animate-pulse rounded bg-slate-900/30"}`} />
      </div>
    </div>
  );
}
