"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, createChart, HistogramSeries, type IChartApi, type Time } from "lightweight-charts";
import { MoveHorizontal, RotateCcw } from "lucide-react";
import { getPatternChart, type PatternChartData } from "@/lib/api";
import {
  countBars,
  DRAG_ATTRIBUTE,
  moveWindow,
  moveWindowByIndex,
  QUICK_LENGTHS,
  snapDate,
  timeToDate,
  type DragMode,
  type DragState,
  type PatternChartSelection,
} from "./pattern-chart-selection";

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
  selection,
  engineSelection,
  onSelectionChange,
  onResetSelection,
  contextBars = 260,
}: {
  profileId: string;
  ticker: string;
  endDate: string;
  selection: PatternChartSelection | null;
  engineSelection: PatternChartSelection | null;
  onSelectionChange?: (selection: PatternChartSelection) => void;
  onResetSelection?: () => void;
  contextBars?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [visible, setVisible] = useState(false);
  const [data, setData] = useState<PatternChartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rangeRect, setRangeRect] = useState<{ left: number; width: number } | null>(null);
  const [adjustMode, setAdjustMode] = useState(false);
  const [rangeDragActive, setRangeDragActive] = useState(false);
  const compact = useIsCompactChart();
  const height = compact ? 220 : 260;
  const dates = useMemo(() => data?.bars.map((bar) => bar.date) ?? [], [data]);
  const selectionChanged = Boolean(selection && (!engineSelection || (
    selection.startDate !== engineSelection.startDate ||
    selection.endDate !== engineSelection.endDate ||
    selection.barCount !== engineSelection.barCount
  )));
  const canAdjust = Boolean(onSelectionChange);

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

  const emitSelection = (startDate: string, endDateValue: string) => {
    if (!onSelectionChange || dates.length === 0) return;
    const start = startDate <= endDateValue ? startDate : endDateValue;
    const end = startDate <= endDateValue ? endDateValue : startDate;
    const snappedStart = snapDate(dates, start);
    const snappedEnd = snapDate(dates, end);
    if (!snappedStart || !snappedEnd) return;
    const normalizedStart = snappedStart <= snappedEnd ? snappedStart : snappedEnd;
    const normalizedEnd = snappedStart <= snappedEnd ? snappedEnd : snappedStart;
    onSelectionChange({
      startDate: normalizedStart,
      endDate: normalizedEnd,
      barCount: countBars(dates, normalizedStart, normalizedEnd),
      selectionMode: "chart_range",
    });
  };

  const setChartDragPanEnabled = (enabled: boolean) => {
    chartRef.current?.applyOptions({
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: enabled,
        horzTouchDrag: enabled,
        vertTouchDrag: false,
      },
    });
  };

  const indexFromPointer = (clientX: number) => {
    const chart = chartRef.current;
    const overlay = overlayRef.current;
    if (!chart || !overlay || dates.length === 0) return null;
    const bounds = overlay.getBoundingClientRect();
    const x = clientX - bounds.left;
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < dates.length; index += 1) {
      const coordinate = chart.timeScale().timeToCoordinate(dates[index] as Time);
      if (coordinate == null || !Number.isFinite(coordinate)) continue;
      const distance = Math.abs(coordinate - x);
      if (distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    }
    if (bestIndex >= 0) return bestIndex;
    const logical = chart.timeScale().coordinateToLogical(x);
    if (logical == null || !Number.isFinite(logical)) return null;
    return Math.max(0, Math.min(dates.length - 1, Math.round(Number(logical))));
  };

  const dateFromPointer = (clientX: number) => {
    const index = indexFromPointer(clientX);
    if (index != null) return dates[index];
    const chart = chartRef.current;
    const overlay = overlayRef.current;
    if (!chart || !overlay) return null;
    const bounds = overlay.getBoundingClientRect();
    const time = chart.timeScale().coordinateToTime(clientX - bounds.left);
    return snapDate(dates, timeToDate(time));
  };

  const dragModeFromTarget = (target: EventTarget | null): DragMode | null => {
    if (!(target instanceof HTMLElement)) return null;
    const element = target.closest(`[${DRAG_ATTRIBUTE}]`);
    const mode = element?.getAttribute(DRAG_ATTRIBUTE);
    if (mode === "move" || mode === "resize-start" || mode === "resize-end") return mode;
    return null;
  };

  const selectLength = (length: number) => {
    if (!data || dates.length === 0) return;
    const end = snapDate(dates, selection?.endDate ?? data.availableEndDate ?? data.endDate) ?? dates[dates.length - 1];
    const endIndex = dates.indexOf(end);
    const startIndex = Math.max(0, endIndex - length + 1);
    emitSelection(dates[startIndex], end);
  };

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
    if (!chart || !selection) {
      setRangeRect(null);
      return;
    }
    const updateRect = () => {
      const start = chart.timeScale().timeToCoordinate(selection.startDate as Time);
      const end = chart.timeScale().timeToCoordinate(selection.endDate as Time);
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
  }, [data, selection]);

  return (
    <div ref={hostRef} className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Chart</div>
          <div className="mt-1 text-sm text-slate-300">{data?.availableStartDate ?? "-"} to {data?.availableEndDate ?? endDate}</div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {data?.warnings.length ? <span className="text-xs text-amber-200">{data.warnings[0]}</span> : null}
          {canAdjust ? (
            <>
              <button
                className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  adjustMode
                    ? "border-accent/50 bg-accent/20 text-accent"
                    : "border-borderSoft/80 text-slate-300 hover:bg-slate-800/60"
                }`}
                disabled={!data}
                onClick={() => setAdjustMode((current) => !current)}
                title="Adjust Window"
                type="button"
              >
                <MoveHorizontal className="h-3.5 w-3.5" />
                Adjust Window
              </button>
              {selectionChanged ? (
                <button
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-borderSoft/80 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800/60 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!data}
                  onClick={onResetSelection}
                  title="Reset to Engine Match"
                  type="button"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reset
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {adjustMode && data ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {QUICK_LENGTHS.map((length) => (
            <button
              key={length}
              className="rounded-md border border-borderSoft/70 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800/70"
              onClick={() => selectLength(length)}
              type="button"
            >
              {length}
            </button>
          ))}
        </div>
      ) : null}
      <div className="relative mt-3 overflow-hidden rounded border border-borderSoft/50" style={{ height }}>
        {!visible ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">Chart pending</div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-red-200">{error}</div>
        ) : data ? (
          <>
            <div ref={chartContainerRef} className="h-full w-full" />
            <div
              ref={overlayRef}
              className={`absolute inset-0 z-50 ${adjustMode ? "cursor-crosshair" : "pointer-events-none"}`}
              role="application"
              aria-label="Candidate pattern date range selector"
              style={{ touchAction: adjustMode ? "none" : "auto" }}
              onPointerDown={(event) => {
                if (!adjustMode) return;
                event.preventDefault();
                event.stopPropagation();
                const date = dateFromPointer(event.clientX);
                const pointerIndex = indexFromPointer(event.clientX);
                if (!date || pointerIndex == null) return;
                setRangeDragActive(true);
                setChartDragPanEnabled(false);
                const mode = selection ? (dragModeFromTarget(event.target) ?? "new") : "new";
                const initialStartIndex = selection ? dates.indexOf(selection.startDate) : -1;
                const initialEndIndex = selection ? dates.indexOf(selection.endDate) : -1;
                dragRef.current = {
                  mode,
                  anchorDate: mode === "resize-start"
                    ? (selection?.endDate ?? date)
                    : mode === "resize-end"
                      ? (selection?.startDate ?? date)
                      : date,
                  anchorIndex: pointerIndex,
                  initialStartDate: selection?.startDate,
                  initialEndDate: selection?.endDate,
                  initialStartIndex: initialStartIndex >= 0 ? initialStartIndex : undefined,
                  initialEndIndex: initialEndIndex >= 0 ? initialEndIndex : undefined,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
                if (mode === "new") emitSelection(date, date);
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!drag) return;
                event.preventDefault();
                event.stopPropagation();
                const date = dateFromPointer(event.clientX);
                const pointerIndex = indexFromPointer(event.clientX);
                if (!date || pointerIndex == null) return;
                if (drag.mode === "resize-start") emitSelection(date, drag.anchorDate);
                else if (drag.mode === "resize-end") emitSelection(drag.anchorDate, date);
                else if (drag.mode === "move" && drag.initialStartIndex != null && drag.initialEndIndex != null) {
                  const next = moveWindowByIndex(dates, drag.initialStartIndex, drag.initialEndIndex, drag.anchorIndex, pointerIndex);
                  if (next) emitSelection(next.startDate, next.endDate);
                }
                else if (drag.mode === "move" && drag.initialStartDate && drag.initialEndDate) {
                  const next = moveWindow(dates, drag.initialStartDate, drag.initialEndDate, drag.anchorDate, date);
                  if (next) emitSelection(next.startDate, next.endDate);
                }
                else emitSelection(drag.anchorDate, date);
              }}
              onPointerUp={(event) => {
                dragRef.current = null;
                setRangeDragActive(false);
                setChartDragPanEnabled(true);
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                dragRef.current = null;
                setRangeDragActive(false);
                setChartDragPanEnabled(true);
              }}
            >
              {rangeRect ? (
                <div
                  className={`absolute inset-y-0 rounded border border-accent/50 bg-accent/10 ${
                    adjustMode || rangeDragActive ? "cursor-grab active:cursor-grabbing" : "pointer-events-none"
                  }`}
                  data-pattern-drag="move"
                  style={{ left: rangeRect.left, width: rangeRect.width }}
                >
                  {adjustMode ? (
                    <>
                      <div className="absolute inset-y-0 left-3 right-3 cursor-grab active:cursor-grabbing" data-pattern-drag="move" />
                      <div className="absolute -left-2 top-0 h-full w-4 cursor-ew-resize bg-accent/70" data-pattern-drag="resize-start" />
                      <div className="absolute -right-2 top-0 h-full w-4 cursor-ew-resize bg-accent/70" data-pattern-drag="resize-end" />
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">Loading chart</div>
        )}
      </div>
      <div className="mt-3 grid gap-2 text-xs text-slate-400 md:grid-cols-3">
        <div>Start <span className="font-mono text-slate-200">{selection?.startDate ?? "-"}</span></div>
        <div>End <span className="font-mono text-slate-200">{selection?.endDate ?? "-"}</span></div>
        <div>Bars <span className="font-mono text-slate-200">{selection?.barCount || "-"}</span></div>
      </div>
      {selectionChanged && selection && selection.barCount > 0 && selection.barCount < 10 ? (
        <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          Short window selected: {selection.barCount} bars.
        </div>
      ) : null}
    </div>
  );
}
