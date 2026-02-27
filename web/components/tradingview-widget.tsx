"use client";

import { useEffect, useRef } from "react";

export function TradingViewWidget({ ticker }: { ticker: string }) {
  const ref = useRef<HTMLDivElement>(null);
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
      container_id: "tv-adv",
    });
    ref.current.appendChild(script);
  }, [ticker]);

  return (
    <div className="card p-2">
      <div className="tradingview-widget-container h-[480px]" ref={ref}>
        <div id="tv-adv" className="h-full" />
      </div>
    </div>
  );
}
