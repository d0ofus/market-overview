"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, createChart, HistogramSeries, type IChartApi, type Time } from "lightweight-charts";
import { getPatternChart, type PatternChartData } from "@/lib/api";

const chartCache = new Map<string, Promise<PatternChartData> | PatternChartData>();

function chartCacheKey(profileId: string, ticker: string, endDate: string, contextBars: number) {
  return `${profileId}:${ticker}:${endDate}:${contextBars}`;
}

function getCachedPatternChart(profileId: string, ticker: string, endDate: string, contextBars: number) {
  const key = chartCacheKey(profileId, ticker, endDate, contextBars);
  const cached = chartCache.get(key);
  if (cached) return cached;
  const request = getPatternChart({ profileId, ticker, endDate, contextBars })
    .then((data) => {
      chartCache.set(key, data);
      return data;
    })
    .catch((error) => {
      chartCache.delete(key);
      throw error;
    });
  chartCache.set(key, request);
  return request;
}

function useIsCompactChart() {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 768px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}

export function PatternCandidateChart({
  profileId,
  ticker,
  endDate,
  patternStartDate,
  patternEndDate,
  contextBars = 260,
}: {
  profileId: string;
  ticker: string;
  endDate: string;
  patternStartDate: string | null;
  patternEndDate: string | null;
  contextBars?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [visible, setVisible] = useState(false);
  const [data, setData] = useState<PatternChartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rangeRect, setRangeRect] = useState<{ left: number; width: number } | null>(null);
  const compact = useIsCompactChart();
  const height = compact ? 220 : 260;
  const range = useMemo(() => ({
    start: patternStartDate,
    end: patternEndDate ?? endDate,
  }), [patternStartDate, patternEndDate, endDate]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "650px 0px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || data || !ticker || !endDate) return;
    let cancelled = false;
    setError(null);
    void Promise.resolve(getCachedPatternChart(profileId, ticker, endDate, contextBars))
      .then((chartData) => {
        if (!cancelled) setData(chartData);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Chart unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, [contextBars, data, endDate, profileId, ticker, visible]);

  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container || !data || data.bars.length === 0) return;
    const chart = createChart(container, {
      height,
      layout: {
        background: { color: "transparent" },
        textColor: "#94a3b8",
      },
      grid: {
        vertLines: { color: "rgba(148, 163, 184, 0.08)" },
        horzLines: { color: "rgba(148, 163, 184, 0.08)" },
      },
      rightPriceScale: {
        borderColor: "rgba(148, 163, 184, 0.16)",
      },
      timeScale: {
        borderColor: "rgba(148, 163, 184, 0.16)",
        timeVisible: false,
      },
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: false,
        mouseWheel: false,
        pinch: true,
      },
    });
    chartRef.current = chart;
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#86efac",
      wickDownColor: "#fca5a5",
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.24 } });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    candleSeries.setData(data.bars.map((bar) => ({
      time: bar.date as Time,
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
    })));
    volumeSeries.setData(data.bars.map((bar) => ({
      time: bar.date as Time,
      value: bar.volume,
      color: bar.c >= bar.o ? "rgba(34, 197, 94, 0.28)" : "rgba(239, 68, 68, 0.24)",
    })));
    chart.timeScale().fitContent();
    const resizeObserver = new ResizeObserver((entries) => {
      const width = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (width > 0) chart.resize(width, height);
    });
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [data, height]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !range.start || !range.end) {
      setRangeRect(null);
      return;
    }
    const updateRect = () => {
      const start = chart.timeScale().timeToCoordinate(range.start as Time);
      const end = chart.timeScale().timeToCoordinate(range.end as Time);
      if (start == null || end == null) {
        setRangeRect(null);
        return;
      }
      const left = Math.min(start, end);
      setRangeRect({ left, width: Math.max(3, Math.abs(end - start)) });
    };
    updateRect();
    chart.timeScale().subscribeVisibleLogicalRangeChange(updateRect);
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(updateRect);
  }, [data, range.end, range.start]);

  return (
    <div ref={hostRef} className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Chart</div>
          <div className="mt-1 text-sm text-slate-300">{data?.availableStartDate ?? "-"} to {data?.availableEndDate ?? endDate}</div>
        </div>
        {data?.warnings.length ? <span className="text-xs text-amber-200">{data.warnings[0]}</span> : null}
      </div>
      <div className="relative mt-3 overflow-hidden rounded border border-borderSoft/50" style={{ height }}>
        {!visible ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">Chart pending</div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-red-200">{error}</div>
        ) : data ? (
          <>
            <div ref={chartContainerRef} className="h-full w-full" />
            {rangeRect ? (
              <div
                className="pointer-events-none absolute inset-y-0 rounded border border-accent/40 bg-accent/10"
                style={{ left: rangeRect.left, width: rangeRect.width }}
              />
            ) : null}
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">Loading chart</div>
        )}
      </div>
    </div>
  );
}
