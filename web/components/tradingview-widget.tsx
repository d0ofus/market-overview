"use client";

import { useEffect, useId, useRef } from "react";

export function TradingViewWidget({
  ticker,
  compact = false,
  className = "",
}: {
  ticker: string;
  compact?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const containerId = `tv-adv-${ticker.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}-${uid}`;
  const standardizedSize = compact ? "h-[520px] md:h-[620px]" : "h-[520px] md:h-[620px]";
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
    <div className={`card p-2 ${className}`}>
      <div
        className={`tradingview-widget-container mx-auto w-full max-w-[980px] ${standardizedSize}`}
        ref={ref}
      >
        <div id={containerId} className="h-full" />
      </div>
    </div>
  );
}
