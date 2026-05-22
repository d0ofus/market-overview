import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import type { FundamentalTrendDirection, FundamentalTrendRow } from "@/lib/api";

function formatPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function trendClasses(direction: FundamentalTrendDirection): string {
  if (direction === "up") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-300";
  if (direction === "down") return "border-red-400/30 bg-red-400/10 text-red-300";
  return "border-borderSoft/60 bg-panelSoft/30 text-slate-300";
}

function trendPanelClasses(direction: FundamentalTrendDirection): string {
  if (direction === "up") return "border-emerald-400/25 bg-emerald-400/[0.06]";
  if (direction === "down") return "border-red-400/25 bg-red-400/[0.06]";
  return "border-borderSoft/60 bg-panelSoft/25";
}

function TrendIcon({ direction }: { direction: FundamentalTrendDirection }) {
  if (direction === "up") return <TrendingUp className="h-3 w-3" />;
  if (direction === "down") return <TrendingDown className="h-3 w-3" />;
  return <Minus className="h-3 w-3" />;
}

function MiniBarChart({
  values,
  color,
  negativeColor,
}: {
  values: Array<number | null>;
  color: string;
  negativeColor: string;
}) {
  const width = 160;
  const height = 48;
  const finiteValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const maxAbs = Math.max(1, ...finiteValues.map((value) => Math.abs(value)));
  const slotWidth = width / Math.max(1, values.length);
  const barWidth = Math.max(3, slotWidth - 3);
  const midY = height / 2;
  const maxBarHeight = (height / 2) - 4;
  return (
    <svg className="mt-1 h-12 w-full" viewBox={`0 0 ${width} ${height}`} role="presentation" aria-hidden="true">
      <line x1={0} x2={width} y1={midY} y2={midY} stroke="rgba(148, 163, 184, 0.18)" strokeWidth={0.75} />
      {values.map((value, index) => {
        const x = index * slotWidth + 1;
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return <rect key={`missing-${index}`} x={x} y={midY - 1} width={barWidth} height={2} rx={0.8} fill="rgba(100, 116, 139, 0.55)" />;
        }
        const normalized = Math.max(3, (Math.abs(value) / maxAbs) * maxBarHeight);
        const isNegative = value < 0;
        return (
          <rect
            key={`${index}-${value}`}
            x={x}
            y={isNegative ? midY : midY - normalized}
            width={barWidth}
            height={normalized}
            rx={0.8}
            fill={isNegative ? negativeColor : color}
          >
            <title>{value.toLocaleString("en-US")}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function TrendMetricPanel({
  label,
  direction,
  value,
  values,
  color,
  negativeColor,
}: {
  label: string;
  direction: FundamentalTrendDirection;
  value: number | null;
  values: Array<number | null>;
  color: string;
  negativeColor: string;
}) {
  const formattedValue = formatPct(value);
  return (
    <div
      className={`min-w-[8.75rem] rounded border px-2 py-1.5 ${trendPanelClasses(direction)}`}
      title={`${label} YoY momentum: ${direction}, latest ${formattedValue}`}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
          {label}
        </span>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${trendClasses(direction)}`}>
          <TrendIcon direction={direction} />
          <span className="font-mono">{formattedValue}</span>
        </span>
      </div>
      <MiniBarChart values={values} color={color} negativeColor={negativeColor} />
    </div>
  );
}

export function FundamentalsTrendStrip({
  row,
  loading,
  error,
}: {
  row?: FundamentalTrendRow | null;
  loading?: boolean;
  error?: string | null;
}) {
  if (loading) {
    return (
      <div className="flex h-10 items-center justify-between gap-2 rounded border border-borderSoft/50 bg-panelSoft/20 px-2">
        <div className="h-3 w-20 animate-pulse rounded bg-slate-700/60" />
        <div className="h-6 w-24 animate-pulse rounded bg-slate-700/50" />
      </div>
    );
  }

  if (error || !row || row.warning || row.quarters.length === 0) {
    return (
      <div
        className="flex h-10 items-center justify-between gap-2 rounded border border-borderSoft/50 bg-panelSoft/20 px-2 text-[11px] text-slate-500"
        title={error ?? row?.warning ?? "No cached fundamentals trend data."}
      >
        <span>Earnings trend</span>
        <span className="font-mono">-</span>
      </div>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <TrendMetricPanel
        label="Revenue"
        direction={row.revenueTrend}
        value={row.latestRevenueYoY}
        values={row.quarters.slice(-8).map((quarter) => quarter.revenue)}
        color="#5eead4"
        negativeColor="#f87171"
      />
      <TrendMetricPanel
        label="Net income"
        direction={row.netIncomeTrend}
        value={row.latestNetIncomeYoY}
        values={row.quarters.slice(-8).map((quarter) => quarter.netIncome)}
        color="#facc15"
        negativeColor="#fb7185"
      />
    </div>
  );
}
