"use client";

import { useEffect, useState } from "react";

type Props = {
  values: number[] | null;
  width?: number;
  height?: number;
  ariaLabel?: string;
  tooltipEnabled?: boolean;
  barLabels?: string[];
  valueFormatter?: (value: number) => string;
};

const BASE_BAR_COLOR = "#3347A8";
const LATEST_BAR_COLOR = "#DC2626";
const TOOLTIP_HALF_WIDTH = 52;

export function HistogramSparkline({
  values,
  width = 120,
  height = 28,
  ariaLabel = "Histogram sparkline",
  tooltipEnabled = false,
  barLabels,
  valueFormatter,
}: Props) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const formatValue = valueFormatter ?? ((value: number) => value.toString());

  useEffect(() => {
    if (activeIndex == null || !values?.length) return;
    if (activeIndex >= values.length) setActiveIndex(null);
  }, [activeIndex, values]);

  if (!values?.length) {
    return (
      <div className="flex items-center text-xs text-slate-500" style={{ width, height }}>
        -
      </div>
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const barSlotWidth = width / values.length;
  const gap = Math.max(1, Math.min(3, barSlotWidth * 0.25));
  const barWidth = Math.max(1, barSlotWidth - gap);
  const minBarHeight = 3;
  const showTooltip = tooltipEnabled && activeIndex != null && activeIndex >= 0 && activeIndex < values.length;
  const tooltipValue = showTooltip ? values[activeIndex] : null;
  const tooltipLabel = showTooltip ? barLabels?.[activeIndex] ?? null : null;
  const tooltipBarCenter = showTooltip
    ? Math.min(
      Math.max(activeIndex * barSlotWidth + barSlotWidth / 2, TOOLTIP_HALF_WIDTH),
      width - TOOLTIP_HALF_WIDTH,
    )
    : 0;
  return (
    <div className="relative inline-flex" style={{ width, height }}>
      {showTooltip && tooltipValue != null && (
        <div
          className="pointer-events-none absolute bottom-full z-10 mb-2 -translate-x-1/2 rounded border border-slate-600/50 bg-slate-950/95 px-2 py-1 text-[11px] text-white shadow-lg"
          style={{ left: tooltipBarCenter }}
        >
          {tooltipLabel && <div className="whitespace-nowrap text-slate-300">{tooltipLabel}</div>}
          <div className="whitespace-nowrap font-medium text-white">{formatValue(tooltipValue)}</div>
        </div>
      )}
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label={ariaLabel}>
        {values.map((value, index) => {
          const normalizedHeight = range === 0
            ? height * 0.6
            : minBarHeight + ((value - min) / range) * (height - minBarHeight);
          const x = index * barSlotWidth + gap / 2;
          const y = height - normalizedHeight;
          const isLatest = index === values.length - 1;
          const formattedValue = formatValue(value);
          const label = barLabels?.[index];
          return (
            <rect
              key={`${index}-${value}`}
              x={x}
              y={y}
              width={barWidth}
              height={normalizedHeight}
              rx={0.75}
              fill={isLatest ? LATEST_BAR_COLOR : BASE_BAR_COLOR}
              tabIndex={tooltipEnabled ? 0 : undefined}
              focusable={tooltipEnabled || undefined}
              aria-label={tooltipEnabled ? `${label ? `${label}: ` : ""}${formattedValue}` : undefined}
              onMouseEnter={tooltipEnabled ? () => setActiveIndex(index) : undefined}
              onMouseMove={tooltipEnabled ? () => setActiveIndex(index) : undefined}
              onMouseLeave={tooltipEnabled ? () => setActiveIndex(null) : undefined}
              onFocus={tooltipEnabled ? () => setActiveIndex(index) : undefined}
              onBlur={tooltipEnabled ? () => setActiveIndex(null) : undefined}
            >
              <title>{label ? `${label}: ${formattedValue}` : formattedValue}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}
