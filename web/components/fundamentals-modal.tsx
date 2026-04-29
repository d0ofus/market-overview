"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  getTickerFundamentals,
  refreshTickerFundamentals,
  type FundamentalQuarterRow,
  type FundamentalsResponse,
} from "@/lib/api";

type ChartRow = FundamentalQuarterRow & {
  quarterLabel: string;
  revenueBillions: number | null;
  netIncomeBillions: number | null;
};

const CHART_COLORS = {
  revenue: "#5eead4",
  netIncome: "#fbbf24",
  revenueYoY: "#38bdf8",
  revenueQoQ: "#22c55e",
  netIncomeYoY: "#f472b6",
  netIncomeQoQ: "#fb923c",
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", year: "numeric", timeZone: "UTC" }).format(parsed);
}

function formatBillions(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `$${value.toFixed(1)}B`;
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

function FundamentalsTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: ChartRow }> }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="min-w-64 rounded border border-borderSoft/80 bg-slate-950/95 p-3 text-xs shadow-2xl">
      <div className="font-semibold text-slate-100">{row.quarterLabel}</div>
      <div className="mt-1 text-[11px] text-slate-400">
        {formatDate(row.periodEnd)} {row.derivation ? `- ${row.derivation === "direct" ? "direct" : "derived"}` : ""}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        <div>
          <div className="text-slate-500">Revenue</div>
          <div className="font-semibold text-slate-100">{formatBillions(row.revenueBillions)}</div>
        </div>
        <div>
          <div className="text-slate-500">Net income</div>
          <div className="font-semibold text-slate-100">{formatBillions(row.netIncomeBillions)}</div>
        </div>
        <div>
          <div className="text-slate-500">Revenue YoY / QoQ</div>
          <div>
            <span className={percentClass(row.revenueYoY)}>{formatPercent(row.revenueYoY)}</span>
            <span className="text-slate-500"> / </span>
            <span className={percentClass(row.revenueQoQ)}>{formatPercent(row.revenueQoQ)}</span>
          </div>
        </div>
        <div>
          <div className="text-slate-500">NI YoY / QoQ</div>
          <div>
            <span className={percentClass(row.netIncomeYoY)}>{formatPercent(row.netIncomeYoY)}</span>
            <span className="text-slate-500"> / </span>
            <span className={percentClass(row.netIncomeQoQ)}>{formatPercent(row.netIncomeQoQ)}</span>
          </div>
        </div>
      </div>
      {row.warnings.length > 0 ? <div className="mt-3 text-[11px] leading-4 text-yellow-200">{row.warnings[0]}</div> : null}
    </div>
  );
}

function yAxisBillions(value: number): string {
  return `$${value.toFixed(0)}B`;
}

function yAxisPercent(value: number): string {
  return `${value.toFixed(0)}%`;
}

export function FundamentalsModal({
  ticker,
  onClose,
}: {
  ticker: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<FundamentalsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getTickerFundamentals(ticker, 8);
      setData(response);
    } catch (loadError) {
      setData(null);
      setError(loadError instanceof Error ? loadError.message : "Failed to load fundamentals.");
    } finally {
      setLoading(false);
    }
  }, [ticker]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const chartRows = useMemo(() => toChartRows(data?.rows ?? []), [data?.rows]);
  const issuerName = data?.issuer?.companyName ?? chartRows[0]?.companyName ?? null;
  const latest = chartRows.at(-1) ?? null;
  const hasRows = chartRows.length > 0;

  const onRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await refreshTickerFundamentals(ticker);
      await load();
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to refresh SEC fundamentals.");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4" onClick={onClose}>
      <div
        className="flex h-[calc(100vh-2rem)] w-full max-w-[96vw] flex-col overflow-hidden rounded-[30px] border border-borderSoft/75 bg-panel/95 shadow-[0_24px_80px_rgba(2,6,23,0.55)] 2xl:max-w-[92rem]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-borderSoft/60 bg-panelSoft/35 px-5 py-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Fundamentals</p>
            <h4 className="mt-1 text-base font-semibold text-slate-100">{ticker.toUpperCase()}</h4>
            {issuerName ? <div className="mt-1 text-sm text-slate-400">{issuerName}</div> : null}
            {data?.issuer?.lastRefreshedAt ? (
              <div className="mt-1 text-xs text-slate-500">SEC cache refreshed {formatDate(data.issuer.lastRefreshedAt.slice(0, 10))}</div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onRefresh}
              disabled={loading || refreshing}
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              {refreshing ? "Refreshing" : "Refresh SEC"}
            </button>
            <button
              type="button"
              aria-label="Close fundamentals modal"
              data-modal-close="true"
              className="inline-flex items-center justify-center rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex h-80 items-center justify-center gap-2 text-sm text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" />
              Loading fundamentals...
            </div>
          ) : error ? (
            <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">{error}</div>
          ) : !hasRows ? (
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
          ) : (
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
                    <p className="mt-1 text-xs text-slate-400">USD billions, latest {chartRows.length} fiscal quarters</p>
                  </div>
                  <div className="flex flex-wrap gap-3 text-xs text-slate-300">
                    <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: CHART_COLORS.revenue }} />Revenue</span>
                    <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: CHART_COLORS.netIncome }} />Net income</span>
                  </div>
                </div>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartRows} margin={{ top: 12, right: 14, left: 6, bottom: 8 }}>
                      <CartesianGrid stroke="rgba(148, 163, 184, 0.16)" vertical={false} />
                      <XAxis dataKey="quarterLabel" tick={{ fill: "#cbd5e1", fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis tickFormatter={yAxisBillions} tick={{ fill: "#cbd5e1", fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
                      <Tooltip content={<FundamentalsTooltip />} cursor={{ fill: "rgba(148, 163, 184, 0.08)" }} />
                      <Legend wrapperStyle={{ color: "#cbd5e1", fontSize: 12 }} />
                      <Bar dataKey="revenueBillions" name="Revenue" fill={CHART_COLORS.revenue} radius={[4, 4, 0, 0]} />
                      <Bar dataKey="netIncomeBillions" name="Net income" fill={CHART_COLORS.netIncome} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </section>

              <section className="rounded-[24px] border border-borderSoft/70 bg-panelSoft/25 p-4">
                <div className="mb-3">
                  <h5 className="text-sm font-semibold text-slate-100">Growth: YoY + QoQ</h5>
                  <p className="mt-1 text-xs text-slate-400">Revenue and net income growth rates</p>
                </div>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartRows} margin={{ top: 12, right: 14, left: 6, bottom: 8 }}>
                      <CartesianGrid stroke="rgba(148, 163, 184, 0.16)" vertical={false} />
                      <XAxis dataKey="quarterLabel" tick={{ fill: "#cbd5e1", fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis tickFormatter={yAxisPercent} tick={{ fill: "#cbd5e1", fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
                      <Tooltip content={<FundamentalsTooltip />} cursor={{ stroke: "rgba(148, 163, 184, 0.55)", strokeDasharray: "4 4" }} />
                      <Legend wrapperStyle={{ color: "#cbd5e1", fontSize: 12 }} />
                      <Line type="monotone" dataKey="revenueYoY" name="Revenue YoY" stroke={CHART_COLORS.revenueYoY} strokeWidth={2.2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                      <Line type="monotone" dataKey="revenueQoQ" name="Revenue QoQ" stroke={CHART_COLORS.revenueQoQ} strokeWidth={2.2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                      <Line type="monotone" dataKey="netIncomeYoY" name="NI YoY" stroke={CHART_COLORS.netIncomeYoY} strokeWidth={2.2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                      <Line type="monotone" dataKey="netIncomeQoQ" name="NI QoQ" stroke={CHART_COLORS.netIncomeQoQ} strokeWidth={2.2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
