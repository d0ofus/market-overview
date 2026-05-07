import type { Time } from "lightweight-charts";
import type { PatternSelectionMode } from "@/lib/api";

export type PatternChartSelection = {
  startDate: string;
  endDate: string;
  barCount: number;
  selectionMode: PatternSelectionMode;
};

export type DragMode = "new" | "resize-start" | "resize-end" | "move";

export type DragState = {
  mode: DragMode;
  anchorDate: string;
  anchorIndex: number;
  initialStartDate?: string;
  initialEndDate?: string;
  initialStartIndex?: number;
  initialEndIndex?: number;
};

export const QUICK_LENGTHS = [20, 40, 60, 80, 120];
export const DRAG_ATTRIBUTE = "data-pattern-drag";

export function timeToDate(value: Time | null): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (typeof value === "number") return new Date(value * 1000).toISOString().slice(0, 10);
  return `${value.year.toString().padStart(4, "0")}-${value.month.toString().padStart(2, "0")}-${value.day.toString().padStart(2, "0")}`;
}

export function countBars(dates: string[], startDate: string, endDate: string) {
  return dates.filter((date) => date >= startDate && date <= endDate).length;
}

export function snapDate(dates: string[], target: string | null) {
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

export function moveWindow(dates: string[], startDate: string, endDate: string, anchorDate: string, targetDate: string) {
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

export function moveWindowByIndex(dates: string[], startIndex: number, endIndex: number, anchorIndex: number, targetIndex: number) {
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
