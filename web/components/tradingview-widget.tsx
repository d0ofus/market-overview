"use client";

import { useEffect, useRef } from "react";

export function TradingViewWidget({ ticker, compact = false }: { ticker: string; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const containerId = `tv-adv-${ticker.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;
  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = "";
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
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
  }, [ticker, containerId]);

  return (
    <div className="card p-2">
      <div
        className={`tradingview-widget-container mx-auto w-full ${
          compact ? "h-[640px] max-w-[760px]" : "h-[760px] max-w-[1040px]"
        }`}
        ref={ref}
      >
        <div id={containerId} className="h-full" />
      </div>
    </div>
  );
}
