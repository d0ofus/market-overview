"use client";

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { FundamentalQuarterRow, FundamentalsResponse } from "@/lib/api";

type ChartRow = FundamentalQuarterRow & {
  quarterLabel: string;
  revenueBillions: number | null;
  netIncomeBillions: number | null;
};

type BarChartRow = ChartRow & {
  revenueScaled: number | null;
  netIncomeScaled: number | null;
};

type MetricKey =
  | "revenueBillions"
  | "netIncomeBillions"
  | "revenueYoY"
  | "revenueQoQ"
  | "netIncomeYoY"
  | "netIncomeQoQ";

type MetricVisibility = Record<MetricKey, boolean>;

type LegendItem = {
  key: MetricKey;
  label: string;
  color: string;
  shape: "bar" | "line";
  lineStyle?: "solid" | "dotted";
};

type UsdAxisScale = {
  divisor: number;
  suffix: string;
  subtitle: string;
};

const CHART_COLORS = {
  revenue: "#5eead4",
  netIncome: "#fbbf24",
  revenueYoY: "#38bdf8",
  revenueQoQ: "#22c55e",
  netIncomeYoY: "#f472b6",
  netIncomeQoQ: "#fb923c",
};

const INITIAL_VISIBILITY: MetricVisibility = {
  revenueBillions: true,
  netIncomeBillions: true,
  revenueYoY: true,
  revenueQoQ: true,
  netIncomeYoY: true,
  netIncomeQoQ: true,
};

const BAR_LEGEND_ITEMS: LegendItem[] = [
  { key: "revenueBillions", label: "Revenue", color: CHART_COLORS.revenue, shape: "bar" },
  { key: "netIncomeBillions", label: "Net income", color: CHART_COLORS.netIncome, shape: "bar" },
];

const GROWTH_LEGEND_ITEMS: LegendItem[] = [
  { key: "revenueYoY", label: "Revenue YoY", color: CHART_COLORS.revenueYoY, shape: "line", lineStyle: "dotted" },
  { key: "revenueQoQ", label: "Revenue QoQ", color: CHART_COLORS.revenueQoQ, shape: "line", lineStyle: "dotted" },
  { key: "netIncomeYoY", label: "NI YoY", color: CHART_COLORS.netIncomeYoY, shape: "line" },
  { key: "netIncomeQoQ", label: "NI QoQ", color: CHART_COLORS.netIncomeQoQ, shape: "line" },
];

export function formatFundamentalDate(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", year: "numeric", timeZone: "UTC" }).format(parsed);
}

function formatBillions(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `$${value.toFixed(1)}B`;
}

function formatUsdCompact(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function percentClass(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "text-slate-200";
  return value < 0 ? "text-neg" : "text-pos";
}

function toChartRows(rows: FundamentalQuarterRow[]): ChartRow[] {
  return rows.map((row) => ({
    ...row,
    quarterLabel: `FY${String(row.fiscalYear).slice(-2)} Q${row.fiscalQuarter}`,
    revenueBillions: typeof row.revenue === "number" && Number.isFinite(row.revenue) ? row.revenue / 1_000_000_000 : null,
    netIncomeBillions: typeof row.netIncome === "number" && Number.isFinite(row.netIncome) ? row.netIncome / 1_000_000_000 : null,
  }));
}

function barMetricUsdValue(row: ChartRow, key: MetricKey): number | null {
  if (key === "revenueBillions") return row.revenue;
  if (key === "netIncomeBillions") return row.netIncome;
  return null;
}

function barMetricValues(rows: ChartRow[], keys: MetricKey[]): number[] {
  return rows
    .flatMap((row) => keys.map((key) => barMetricUsdValue(row, key)))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function axisScaleForUsd(values: number[]): UsdAxisScale {
  const maxAbs = Math.max(0, ...values.map((value) => Math.abs(value)));
  if (maxAbs >= 1_000_000_000) return { divisor: 1_000_000_000, suffix: "B", subtitle: "USD billions" };
  if (maxAbs >= 1_000_000) return { divisor: 1_000_000, suffix: "M", subtitle: "USD millions" };
  return { divisor: 1, suffix: "", subtitle: "USD" };
}

function scaleBarRows(rows: ChartRow[], axisScale: UsdAxisScale): BarChartRow[] {
  return rows.map((row) => ({
    ...row,
    revenueScaled: typeof row.revenue === "number" && Number.isFinite(row.revenue) ? row.revenue / axisScale.divisor : null,
    netIncomeScaled: typeof row.netIncome === "number" && Number.isFinite(row.netIncome) ? row.netIncome / axisScale.divisor : null,
  }));
}

function domainForValues(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];

  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    const padding = Math.max(Math.abs(min) * 0.15, 1);
    return [min - padding, max + padding];
  }

  const padding = (max - min) * 0.12;
  return [min - padding, max + padding];
}

function domainFor(rows: ChartRow[], keys: MetricKey[]): [number, number] {
  const values = rows
    .flatMap((row) => keys.map((key) => row[key]))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return domainForValues(values);
}

function MetricLegend({
  items,
  visibility,
  onToggle,
}: {
  items: LegendItem[];
  visibility: MetricVisibility;
  onToggle: (key: MetricKey) => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap justify-center gap-3 text-xs">
      {items.map((item) => {
        const isVisible = visibility[item.key];
        const color = isVisible ? item.color : "#64748b";
        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={isVisible}
            className={`inline-flex items-center gap-1.5 rounded px-1 py-0.5 transition ${
              isVisible ? "text-slate-200 hover:text-white" : "text-slate-500 hover:text-slate-300"
            }`}
            onClick={() => onToggle(item.key)}
          >
            {item.shape === "line" && item.lineStyle === "dotted" ? (
              <span
                className="h-1.5 w-4"
                style={{
                  backgroundImage: `radial-gradient(circle, ${color} 1.5px, transparent 1.6px)`,
                  backgroundPosition: "left center",
                  backgroundRepeat: "repeat-x",
                  backgroundSize: "6px 6px",
                }}
              />
            ) : (
              <span
                className={item.shape === "line" ? "h-0.5 w-4 rounded-full" : "h-2.5 w-2.5 rounded-sm"}
                style={{ backgroundColor: color }}
              />
            )}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function FundamentalsTooltip({
  active,
  payload,
  visibleMetrics,
}: {
  active?: boolean;
  payload?: Array<{ payload?: ChartRow }>;
  visibleMetrics: MetricKey[];
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const showRevenue = visibleMetrics.includes("revenueBillions");
  const showNetIncome = visibleMetrics.includes("netIncomeBillions");
  const showRevenueYoY = visibleMetrics.includes("revenueYoY");
  const showRevenueQoQ = visibleMetrics.includes("revenueQoQ");
  const showNetIncomeYoY = visibleMetrics.includes("netIncomeYoY");
  const showNetIncomeQoQ = visibleMetrics.includes("netIncomeQoQ");

  return (
    <div className="min-w-64 rounded border border-borderSoft/80 bg-slate-950/95 p-3 text-xs shadow-2xl">
      <div className="font-semibold text-slate-100">{row.quarterLabel}</div>
      <div className="mt-1 text-[11px] text-slate-400">
        {formatFundamentalDate(row.periodEnd)} {row.derivation ? `- ${row.derivation === "direct" ? "direct" : "derived"}` : ""}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        {showRevenue ? (
          <div>
            <div className="text-slate-500">Revenue</div>
            <div className="font-semibold text-slate-100">{formatBillions(row.revenueBillions)}</div>
          </div>
        ) : null}
        {showNetIncome ? (
          <div>
            <div className="text-slate-500">Net income</div>
            <div className="font-semibold text-slate-100">{formatUsdCompact(row.netIncome)}</div>
          </div>
        ) : null}
        {showRevenueYoY || showRevenueQoQ ? (
          <div>
            <div className="text-slate-500">Revenue YoY / QoQ</div>
            <div>
              {showRevenueYoY ? <span className={percentClass(row.revenueYoY)}>{formatPercent(row.revenueYoY)}</span> : null}
              {showRevenueYoY && showRevenueQoQ ? <span className="text-slate-500"> / </span> : null}
              {showRevenueQoQ ? <span className={percentClass(row.revenueQoQ)}>{formatPercent(row.revenueQoQ)}</span> : null}
            </div>
          </div>
        ) : null}
        {showNetIncomeYoY || showNetIncomeQoQ ? (
          <div>
            <div className="text-slate-500">NI YoY / QoQ</div>
            <div>
              {showNetIncomeYoY ? <span className={percentClass(row.netIncomeYoY)}>{formatPercent(row.netIncomeYoY)}</span> : null}
              {showNetIncomeYoY && showNetIncomeQoQ ? <span className="text-slate-500"> / </span> : null}
              {showNetIncomeQoQ ? <span className={percentClass(row.netIncomeQoQ)}>{formatPercent(row.netIncomeQoQ)}</span> : null}
            </div>
          </div>
        ) : null}
      </div>
      {row.warnings.length > 0 ? <div className="mt-3 text-[11px] leading-4 text-yellow-200">{row.warnings[0]}</div> : null}
    </div>
  );
}

function yAxisUsd(value: number, axisScale: UsdAxisScale): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const digits = axisScale.suffix === "B" ? (abs < 1 ? 1 : 0) : axisScale.suffix === "M" && abs < 10 ? 1 : 0;
  return `${sign}$${abs.toFixed(digits)}${axisScale.suffix}`;
}

function yAxisPercent(value: number): string {
  return `${value.toFixed(0)}%`;
}

function MetricChip({ active, color, label }: { active: boolean; color: string; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${active ? "text-slate-300" : "text-slate-500"}`}>
      <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: active ? color : "#64748b" }} />
      {label}
    </span>
  );
}

function VerificationTable({ rows }: { rows: ChartRow[] }) {
  return (
    <section className="rounded-[24px] border border-borderSoft/70 bg-panelSoft/25 p-4">
      <div className="mb-3">
        <h5 className="text-sm font-semibold text-slate-100">Verification Rows</h5>
        <p className="mt-1 text-xs text-slate-400">Cached SEC values from D1 with source metadata.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[64rem] text-left text-sm">
          <thead className="text-xs uppercase tracking-[0.18em] text-slate-500">
            <tr>
              <th className="py-2 pr-3">Quarter</th>
              <th className="py-2 pr-3">Period End</th>
              <th className="py-2 pr-3">Filed</th>
              <th className="py-2 pr-3">Form</th>
              <th className="py-2 pr-3">Accession</th>
              <th className="py-2 pr-3 text-right">Revenue</th>
              <th className="py-2 pr-3 text-right">Net Income</th>
              <th className="py-2 pr-3">Derivation</th>
              <th className="py-2">Warnings</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-borderSoft/60 text-slate-300">
            {[...rows].reverse().map((row) => (
              <tr key={`${row.ticker}-${row.fiscalYear}-${row.fiscalQuarter}-${row.periodEnd}`}>
                <td className="py-2 pr-3 font-mono text-xs text-text">{row.quarterLabel}</td>
                <td className="py-2 pr-3">{formatFundamentalDate(row.periodEnd)}</td>
                <td className="py-2 pr-3">{formatFundamentalDate(row.filedAt)}</td>
                <td className="py-2 pr-3">{row.form ?? "-"}</td>
                <td className="max-w-[13rem] truncate py-2 pr-3 font-mono text-xs text-slate-400" title={row.accession ?? undefined}>{row.accession ?? "-"}</td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-text">{formatUsdCompact(row.revenue)}</td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-text">{formatUsdCompact(row.netIncome)}</td>
                <td className="max-w-[12rem] truncate py-2 pr-3 text-xs text-slate-400" title={row.derivation ?? undefined}>{row.derivation ?? "-"}</td>
                <td className="max-w-[18rem] truncate py-2 text-xs text-yellow-200" title={row.warnings.join(" | ") || undefined}>{row.warnings.join(" | ") || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function FundamentalsChartPanel({
  data,
  error,
  loading,
  onRefresh,
  refreshing,
  showVerificationTable = false,
}: {
  data: FundamentalsResponse | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  showVerificationTable?: boolean;
}) {
  const [visibility, setVisibility] = useState<MetricVisibility>(INITIAL_VISIBILITY);
  const chartRows = toChartRows(data?.rows ?? []);
  const latest = chartRows.at(-1) ?? null;
  const hasRows = chartRows.length > 0;
  const visibleBarKeys = BAR_LEGEND_ITEMS.map((item) => item.key).filter((key) => visibility[key]);
  const visibleRevenueGrowthKeys = (["revenueYoY", "revenueQoQ"] as MetricKey[]).filter((key) => visibility[key]);
  const visibleNetIncomeGrowthKeys = (["netIncomeYoY", "netIncomeQoQ"] as MetricKey[]).filter((key) => visibility[key]);
  const visibleGrowthKeys = GROWTH_LEGEND_ITEMS.map((item) => item.key).filter((key) => visibility[key]);
  const barValues = barMetricValues(chartRows, visibleBarKeys);
  const barAxisScale = axisScaleForUsd(barValues);
  const barChartRows = scaleBarRows(chartRows, barAxisScale);
  const barDomain = domainForValues(barValues.map((value) => value / barAxisScale.divisor));
  const revenueGrowthDomain = domainFor(chartRows, visibleRevenueGrowthKeys);
  const netIncomeGrowthDomain = domainFor(chartRows, visibleNetIncomeGrowthKeys);
  const toggleMetric = (key: MetricKey) => {
    setVisibility((current) => ({ ...current, [key]: !current[key] }));
  };

  if (loading) {
    return (
      <div className="flex h-80 items-center justify-center gap-2 text-sm text-slate-400">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading fundamentals...
      </div>
    );
  }

  if (error) {
    return <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">{error}</div>;
  }

  if (!hasRows) {
    return (
      <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/30 p-5">
        <h5 className="text-sm font-semibold text-slate-100">No cached fundamentals</h5>
        <p className="mt-2 text-sm text-slate-400">{data?.warning ?? "No SEC fundamentals were cached for this ticker."}</p>
        <button
          type="button"
          className="mt-4 inline-flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:opacity-50"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh SEC
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Latest Quarter</div>
          <div className="mt-1 text-sm font-semibold text-slate-100">{latest?.quarterLabel ?? "-"}</div>
        </div>
        <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Revenue</div>
          <div className="mt-1 text-sm font-semibold text-slate-100">{formatBillions(latest?.revenueBillions)}</div>
        </div>
        <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Net Income</div>
          <div className="mt-1 text-sm font-semibold text-slate-100">{formatBillions(latest?.netIncomeBillions)}</div>
        </div>
        <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Source</div>
          <div className="mt-1 text-sm font-semibold text-slate-100">{latest?.form ?? "-"}</div>
        </div>
      </div>

      <section className="rounded-[24px] border border-borderSoft/70 bg-panelSoft/25 p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h5 className="text-sm font-semibold text-slate-100">Quarterly Revenue + Net Income</h5>
            <p className="mt-1 text-xs text-slate-400">{barAxisScale.subtitle}, latest {chartRows.length} fiscal quarters</p>
          </div>
          <div className="flex flex-wrap gap-3 text-xs">
            <MetricChip color={CHART_COLORS.revenue} label="Revenue" active={visibility.revenueBillions} />
            <MetricChip color={CHART_COLORS.netIncome} label="Net income" active={visibility.netIncomeBillions} />
          </div>
        </div>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={barChartRows} margin={{ top: 12, right: 14, left: 6, bottom: 8 }}>
              <CartesianGrid stroke="rgba(148, 163, 184, 0.16)" vertical={false} />
              <XAxis dataKey="quarterLabel" tick={{ fill: "#cbd5e1", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis domain={barDomain} tickFormatter={(value) => yAxisUsd(value, barAxisScale)} tick={{ fill: "#cbd5e1", fontSize: 11 }} axisLine={false} tickLine={false} width={64} />
              <Tooltip content={<FundamentalsTooltip visibleMetrics={visibleBarKeys} />} cursor={{ fill: "rgba(148, 163, 184, 0.08)" }} />
              <Bar dataKey="revenueScaled" name="Revenue" fill={CHART_COLORS.revenue} hide={!visibility.revenueBillions} radius={[4, 4, 0, 0]} />
              <Bar dataKey="netIncomeScaled" name="Net income" fill={CHART_COLORS.netIncome} hide={!visibility.netIncomeBillions} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <MetricLegend items={BAR_LEGEND_ITEMS} visibility={visibility} onToggle={toggleMetric} />
      </section>

      <section className="rounded-[24px] border border-borderSoft/70 bg-panelSoft/25 p-4">
        <div className="mb-3">
          <h5 className="text-sm font-semibold text-slate-100">Growth: YoY + QoQ</h5>
          <p className="mt-1 text-xs text-slate-400">Revenue and net income growth rates</p>
        </div>
        <div className="relative h-72">
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-between px-1 text-[11px] font-semibold uppercase tracking-[0.12em]">
            <span className={visibleRevenueGrowthKeys.length > 0 ? "text-sky-300" : "text-slate-500"}>Revenue</span>
            <span className={visibleNetIncomeGrowthKeys.length > 0 ? "text-pink-300" : "text-slate-500"}>Net Income</span>
          </div>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartRows} margin={{ top: 30, right: 28, left: 6, bottom: 8 }}>
              <CartesianGrid stroke="rgba(148, 163, 184, 0.16)" vertical={false} />
              <XAxis dataKey="quarterLabel" tick={{ fill: "#cbd5e1", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="revenueGrowth" domain={revenueGrowthDomain} tickFormatter={yAxisPercent} tick={{ fill: "#cbd5e1", fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
              <YAxis yAxisId="netIncomeGrowth" domain={netIncomeGrowthDomain} orientation="right" tickFormatter={yAxisPercent} tick={{ fill: "#cbd5e1", fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
              <Tooltip content={<FundamentalsTooltip visibleMetrics={visibleGrowthKeys} />} cursor={{ stroke: "rgba(148, 163, 184, 0.55)", strokeDasharray: "4 4" }} />
              <Line yAxisId="revenueGrowth" type="monotone" dataKey="revenueYoY" name="Revenue YoY" stroke={CHART_COLORS.revenueYoY} strokeWidth={2.2} strokeDasharray="1 7" strokeLinecap="round" dot={{ r: 3 }} activeDot={{ r: 5 }} hide={!visibility.revenueYoY} />
              <Line yAxisId="revenueGrowth" type="monotone" dataKey="revenueQoQ" name="Revenue QoQ" stroke={CHART_COLORS.revenueQoQ} strokeWidth={2.2} strokeDasharray="1 7" strokeLinecap="round" dot={{ r: 3 }} activeDot={{ r: 5 }} hide={!visibility.revenueQoQ} />
              <Line yAxisId="netIncomeGrowth" type="monotone" dataKey="netIncomeYoY" name="NI YoY" stroke={CHART_COLORS.netIncomeYoY} strokeWidth={2.2} dot={{ r: 3 }} activeDot={{ r: 5 }} hide={!visibility.netIncomeYoY} />
              <Line yAxisId="netIncomeGrowth" type="monotone" dataKey="netIncomeQoQ" name="NI QoQ" stroke={CHART_COLORS.netIncomeQoQ} strokeWidth={2.2} dot={{ r: 3 }} activeDot={{ r: 5 }} hide={!visibility.netIncomeQoQ} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <MetricLegend items={GROWTH_LEGEND_ITEMS} visibility={visibility} onToggle={toggleMetric} />
      </section>

      {showVerificationTable ? <VerificationTable rows={chartRows} /> : null}
    </div>
  );
}
