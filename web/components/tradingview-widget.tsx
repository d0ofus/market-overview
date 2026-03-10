"use client";

import { useEffect, useId, useRef } from "react";
import { useState } from "react";

const DEFAULT_CHART_INTERVAL = "D";
const DEFAULT_CHART_STYLE = "1";

export function TradingViewWidget({
  ticker,
  compareSymbol,
  compact = false,
  size = "default",
  chartOnly = false,
  showStatusLine = false,
  initialRange = "1M",
  className = "",
}: {
  ticker: string;
  compareSymbol?: string;
  compact?: boolean;
  size?: "small" | "default";
  chartOnly?: boolean;
  showStatusLine?: boolean;
  initialRange?: "1M" | "3M" | "6M" | "12M";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const containerId = `tv-adv-${ticker.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}-${uid}`;
  const maxWidth = size === "small" ? 420 : compact ? 640 : 880;
  const frameClass = size === "small" ? "w-full max-w-[420px] aspect-[4/3]" : compact ? "w-full max-w-[640px] aspect-[4/3]" : "w-full max-w-[880px] aspect-[4/3]";

  useEffect(() => {
    const syncTheme = () => {
      setTheme(document.documentElement.classList.contains("light") ? "light" : "dark");
    };
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!ref.current) return;
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
      timezone: "Etc/UTC",
      theme,
      style: DEFAULT_CHART_STYLE,
      allow_symbol_change: chartOnly ? false : !chartOnly,
      hide_top_toolbar: chartOnly,
      hide_side_toolbar: chartOnly,
      hide_legend: chartOnly ? !showStatusLine : false,
      volume_force_overlay: false,
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
  }, [ticker, compareSymbol, containerId, maxWidth, size, chartOnly, showStatusLine, initialRange, theme]);

  return (
    <div className={`card p-2 ${className}`}>
      <div className={`tradingview-widget-container mx-auto ${frameClass}`} ref={ref}>
        <div id={containerId} className="h-full" />
      </div>
    </div>
  );
}
