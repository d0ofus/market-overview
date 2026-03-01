"use client";

import { useEffect, useId, useRef } from "react";

export function TradingViewWidget({
  ticker,
  compact = false,
  size = "default",
  className = "",
}: {
  ticker: string;
  compact?: boolean;
  size?: "small" | "default";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const containerId = `tv-adv-${ticker.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}-${uid}`;
  const maxWidth = size === "small" ? 420 : compact ? 640 : 880;
  const frameClass = size === "small" ? "w-full max-w-[420px] aspect-[4/3]" : compact ? "w-full max-w-[640px] aspect-[4/3]" : "w-full max-w-[880px] aspect-[4/3]";
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
      interval: "1D",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      allow_symbol_change: true,
      hide_top_toolbar: false,
      save_image: false,
      container_id: containerId,
    });
    ref.current.appendChild(script);
  }, [ticker, containerId, maxWidth, size]);

  return (
    <div className={`card p-2 ${className}`}>
      <div className={`tradingview-widget-container mx-auto ${frameClass}`} ref={ref}>
        <div id={containerId} className="h-full" />
      </div>
    </div>
  );
}
