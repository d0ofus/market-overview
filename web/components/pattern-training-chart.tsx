"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, createChart, HistogramSeries, type IChartApi, type Time } from "lightweight-charts";
import type { PatternChartData, PatternSelectionMode } from "@/lib/api";

export type PatternChartSelection = {
  startDate: string;
  endDate: string;
  barCount: number;
  selectionMode: PatternSelectionMode;
};

type DragMode = "new" | "resize-start" | "resize-end" | "move";
type DragState = {
  mode: DragMode;
  anchorDate: string;
  anchorIndex: number;
  initialStartDate?: string;
  initialEndDate?: string;
  initialStartIndex?: number;
  initialEndIndex?: number;
};

const QUICK_LENGTHS = [20, 40, 60, 80, 120];
const DRAG_ATTRIBUTE = "data-pattern-drag";

function timeToDate(value: Time | null): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (typeof value === "number") return new Date(value * 1000).toISOString().slice(0, 10);
  return `${value.year.toString().padStart(4, "0")}-${value.month.toString().padStart(2, "0")}-${value.day.toString().padStart(2, "0")}`;
}

function countBars(dates: string[], startDate: string, endDate: string) {
  return dates.filter((date) => date >= startDate && date <= endDate).length;
}

function snapDate(dates: string[], target: string | null) {
  if (!target || dates.length === 0) return null;
  if (dates.includes(target)) return target;
  const targetTime = Date.parse(`${target}T00:00:00Z`);
  let best = dates[0];
  let bestDistance = Math.abs(Date.parse(`${best}T00:00:00Z`) - targetTime);
  for (const date of dates) {
    const distance = Math.abs(Date.parse(`${date}T00:00:00Z`) - targetTime);
    if (distance < bestDistance) {
      best = date;
      bestDistance = distance;
    }
  }
  return best;
}

function moveWindow(dates: string[], startDate: string, endDate: string, anchorDate: string, targetDate: string) {
  const anchorIndex = dates.indexOf(anchorDate);
  const targetIndex = dates.indexOf(targetDate);
  const startIndex = dates.indexOf(startDate);
  const endIndex = dates.indexOf(endDate);
  if (anchorIndex < 0 || targetIndex < 0 || startIndex < 0 || endIndex < 0) return null;
  const length = Math.max(1, endIndex - startIndex + 1);
  const delta = targetIndex - anchorIndex;
  const maxStart = Math.max(0, dates.length - length);
  const nextStart = Math.max(0, Math.min(maxStart, startIndex + delta));
  return {
    startDate: dates[nextStart],
    endDate: dates[Math.min(dates.length - 1, nextStart + length - 1)],
  };
}

function moveWindowByIndex(dates: string[], startIndex: number, endIndex: number, anchorIndex: number, targetIndex: number) {
  if (dates.length === 0) return null;
  const normalizedStart = Math.max(0, Math.min(startIndex, endIndex));
  const normalizedEnd = Math.min(dates.length - 1, Math.max(startIndex, endIndex));
  const length = Math.max(1, normalizedEnd - normalizedStart + 1);
  const delta = targetIndex - anchorIndex;
  const maxStart = Math.max(0, dates.length - length);
  const nextStart = Math.max(0, Math.min(maxStart, normalizedStart + delta));
  return {
    startDate: dates[nextStart],
    endDate: dates[Math.min(dates.length - 1, nextStart + length - 1)],
  };
}

export function PatternTrainingChart({
  data,
  selection,
  onSelectionChange,
  height = 440,
}: {
  data: PatternChartData;
  selection: PatternChartSelection | null;
  onSelectionChange: (selection: PatternChartSelection) => void;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [rect, setRect] = useState<{ left: number; width: number } | null>(null);
  const dates = useMemo(() => data.bars.map((bar) => bar.date), [data.bars]);

  const emitSelection = (startDate: string, endDate: string) => {
    const start = startDate <= endDate ? startDate : endDate;
    const end = startDate <= endDate ? endDate : startDate;
    const snappedStart = snapDate(dates, start);
    const snappedEnd = snapDate(dates, end);
    if (!snappedStart || !snappedEnd) return;
    onSelectionChange({
      startDate: snappedStart <= snappedEnd ? snappedStart : snappedEnd,
      endDate: snappedStart <= snappedEnd ? snappedEnd : snappedStart,
      barCount: countBars(dates, snappedStart <= snappedEnd ? snappedStart : snappedEnd, snappedStart <= snappedEnd ? snappedEnd : snappedStart),
      selectionMode: "chart_range",
    });
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
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
        borderColor: "rgba(148, 163, 184, 0.18)",
      },
      timeScale: {
        borderColor: "rgba(148, 163, 184, 0.18)",
        timeVisible: false,
      },
      crosshair: {
        mode: 0,
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
      color: "rgba(56, 189, 248, 0.35)",
    });
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
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
      color: bar.c >= bar.o ? "rgba(34, 197, 94, 0.28)" : "rgba(239, 68, 68, 0.25)",
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
      setRect(null);
      return;
    }
    const updateRect = () => {
      const start = chart.timeScale().timeToCoordinate(selection.startDate as Time);
      const end = chart.timeScale().timeToCoordinate(selection.endDate as Time);
      if (start == null || end == null) {
        setRect(null);
        return;
      }
      const left = Math.min(start, end);
      setRect({ left, width: Math.max(2, Math.abs(end - start)) });
    };
    updateRect();
    chart.timeScale().subscribeVisibleLogicalRangeChange(updateRect);
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(updateRect);
  }, [selection, data]);

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

  const indexFromPointer = (clientX: number) => {
    const chart = chartRef.current;
    const overlay = overlayRef.current;
    if (!chart || !overlay) return null;
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

  const dragModeFromTarget = (target: EventTarget | null): DragMode | null => {
    if (!(target instanceof HTMLElement)) return null;
    const element = target.closest(`[${DRAG_ATTRIBUTE}]`);
    const mode = element?.getAttribute(DRAG_ATTRIBUTE);
    if (mode === "move" || mode === "resize-start" || mode === "resize-end") return mode;
    return null;
  };

  const selectLast = (length: number) => {
    if (dates.length === 0) return;
    const end = snapDate(dates, data.availableEndDate ?? data.endDate) ?? dates[dates.length - 1];
    const endIndex = dates.indexOf(end);
    const startIndex = Math.max(0, endIndex - length + 1);
    emitSelection(dates[startIndex], end);
  };

  return (
    <div className="rounded-lg border border-borderSoft/70 bg-slate-950/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-100">{data.ticker}</div>
          <div className="text-xs text-slate-500">{data.availableStartDate ?? "-"} to {data.availableEndDate ?? "-"}</div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {QUICK_LENGTHS.map((length) => (
            <button
              key={length}
              className="rounded-md border border-borderSoft/70 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800/70"
              onClick={() => selectLast(length)}
              type="button"
            >
              {length}
            </button>
          ))}
        </div>
      </div>
      <div className="relative mt-3 overflow-hidden rounded border border-borderSoft/50">
        <div ref={containerRef} className="w-full" style={{ height }} />
        <div
          ref={overlayRef}
          className="absolute inset-0 cursor-crosshair"
          role="application"
          aria-label="Pattern date range selector"
          style={{ touchAction: "none" }}
          onPointerDown={(event) => {
            event.preventDefault();
            const date = dateFromPointer(event.clientX);
            const pointerIndex = indexFromPointer(event.clientX);
            if (!date || pointerIndex == null) return;
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
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
        >
          {rect ? (
            <div
              className="absolute bottom-0 top-0 cursor-grab border-x border-accent/80 bg-accent/15 active:cursor-grabbing"
              data-pattern-drag="move"
              style={{ left: rect.left, width: rect.width }}
            >
              <div className="absolute inset-y-0 left-3 right-3 cursor-grab active:cursor-grabbing" data-pattern-drag="move" />
              <div className="absolute -left-2 top-0 h-full w-4 cursor-ew-resize bg-accent/70" data-pattern-drag="resize-start" />
              <div className="absolute -right-2 top-0 h-full w-4 cursor-ew-resize bg-accent/70" data-pattern-drag="resize-end" />
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-3 grid gap-2 text-xs text-slate-400 md:grid-cols-3">
        <div>Start <span className="font-mono text-slate-200">{selection?.startDate ?? "-"}</span></div>
        <div>End <span className="font-mono text-slate-200">{selection?.endDate ?? "-"}</span></div>
        <div>Bars <span className="font-mono text-slate-200">{selection?.barCount ?? "-"}</span></div>
      </div>
      {data.warnings.length ? (
        <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          {data.warnings.join(" ")}
        </div>
      ) : null}
    </div>
  );
}
