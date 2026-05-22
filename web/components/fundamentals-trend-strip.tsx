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

function TrendIcon({ direction }: { direction: FundamentalTrendDirection }) {
  if (direction === "up") return <TrendingUp className="h-3 w-3" />;
  if (direction === "down") return <TrendingDown className="h-3 w-3" />;
  return <Minus className="h-3 w-3" />;
}

function TrendChip({
  label,
  direction,
  value,
}: {
  label: string;
  direction: FundamentalTrendDirection;
  value: number | null;
}) {
  return (
    <span
      className={`inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[10px] font-medium ${trendClasses(direction)}`}
      title={`${label} YoY momentum: ${direction}, latest ${formatPct(value)}`}
    >
      <span>{label}</span>
      <TrendIcon direction={direction} />
      <span className="font-mono">{formatPct(value)}</span>
    </span>
  );
}

function MiniBars({
  values,
  color,
  negativeColor,
  y,
  height,
}: {
  values: Array<number | null>;
  color: string;
  negativeColor: string;
  y: number;
  height: number;
}) {
  const finiteValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const maxAbs = Math.max(1, ...finiteValues.map((value) => Math.abs(value)));
  const slotWidth = 96 / Math.max(1, values.length);
  const barWidth = Math.max(2, slotWidth - 2);
  const midY = y + height / 2;
  return (
    <>
      <line x1={0} x2={96} y1={midY} y2={midY} stroke="rgba(148, 163, 184, 0.18)" strokeWidth={0.75} />
      {values.map((value, index) => {
        const x = index * slotWidth + 1;
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return <rect key={`missing-${index}`} x={x} y={midY - 1} width={barWidth} height={2} rx={0.8} fill="rgba(100, 116, 139, 0.55)" />;
        }
        const normalized = Math.max(2, (Math.abs(value) / maxAbs) * (height / 2 - 1));
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
          />
        );
      })}
    </>
  );
}

function TrendBars({ row }: { row: FundamentalTrendRow }) {
  const quarters = row.quarters.slice(-8);
  const revenueValues = quarters.map((quarter) => quarter.revenue);
  const netIncomeValues = quarters.map((quarter) => quarter.netIncome);
  return (
    <svg className="h-9 w-24 shrink-0" viewBox="0 0 96 36" role="img" aria-label={`${row.ticker} revenue and net income trend`}>
      <MiniBars values={revenueValues} color="#5eead4" negativeColor="#f87171" y={0} height={16} />
      <MiniBars values={netIncomeValues} color="#facc15" negativeColor="#fb7185" y={20} height={16} />
    </svg>
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
    <div className="flex min-h-10 items-center justify-between gap-2 rounded border border-borderSoft/50 bg-panelSoft/20 px-2 py-1">
      <TrendBars row={row} />
      <div className="flex flex-col items-end gap-1">
        <TrendChip label="Rev" direction={row.revenueTrend} value={row.latestRevenueYoY} />
        <TrendChip label="NI" direction={row.netIncomeTrend} value={row.latestNetIncomeYoY} />
      </div>
    </div>
  );
}
