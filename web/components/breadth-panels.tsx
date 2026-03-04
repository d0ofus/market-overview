"use client";

import { useMemo, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type BreadthMetrics = {
  memberCount: number;
  advancers: number;
  decliners: number;
  unchanged: number;
  advDecRatio: number | null;
  totalVolume: number;
  pctAbove5MA: number;
  pctAbove20MA: number;
  pctAbove50MA: number;
  pctAbove100MA: number;
  pctAbove200MA: number;
  new5DHighs: number;
  new1MHighs: number;
  new3MHighs: number;
  new6MHighs: number;
  new52WHighs: number;
  pctNew5DHighs: number;
  pctNew1MHighs: number;
  pctNew3MHighs: number;
  pctNew6MHighs: number;
  pctNew52WHighs: number;
  stocksGtPos4Pct: number;
  stocksLtNeg4Pct: number;
  stocksGtPos25Q: number;
  stocksLtNeg25Q: number;
  medianReturn1D: number;
  medianReturn5D: number;
};

type HistoricalRow = {
  asOfDate: string;
  universeId: string;
  advancers: number;
  decliners: number;
  unchanged: number;
  pctAbove20MA: number;
  pctAbove50MA: number;
  pctAbove200MA: number;
  new20DHighs: number;
  new20DLows: number;
  medianReturn1D: number;
  medianReturn5D: number;
  metrics?: Record<string, unknown> | null;
  dataSource?: string | null;
};

type SummaryRow = HistoricalRow & {
  universeName: string;
};

type SummaryPayload = {
  asOfDate: string | null;
  rows: SummaryRow[];
  unavailable: Array<{ id: string; name: string; reason: string }>;
};

type Lookback = 30 | 60 | 90;
const lookbacks: Lookback[] = [30, 60, 90];

const metricOptions = [
  { key: "pctAbove20MA", label: "% > 20MA" },
  { key: "pctAbove50MA", label: "% > 50MA" },
  { key: "pctAbove200MA", label: "% > 200MA" },
  { key: "new1MHighs", label: "New 1M Highs (#)" },
  { key: "new52WHighs", label: "New 52W Highs (#)" },
  { key: "medianReturn1D", label: "Median Return 1D (%)" },
] as const;

const positive = "text-pos";
const negative = "text-neg";
const numFmt = new Intl.NumberFormat("en-US");

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function colorForPercent(value: number, threshold = 0): string {
  return value >= threshold ? positive : negative;
}

function pct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function normalizeMetrics(row: HistoricalRow | SummaryRow): BreadthMetrics {
  const m = (row.metrics ?? {}) as Record<string, unknown>;
  const memberCount = asNumber(m.memberCount, row.advancers + row.decliners + row.unchanged);
  const advancers = asNumber(m.advancers, row.advancers);
  const decliners = asNumber(m.decliners, row.decliners);
  const unchanged = asNumber(m.unchanged, row.unchanged);
  const high5 = asNumber(m.new5DHighs, row.new20DHighs);
  const high1m = asNumber(m.new1MHighs, row.new20DHighs);
  const high3m = asNumber(m.new3MHighs, row.new20DHighs);
  const high6m = asNumber(m.new6MHighs, row.new20DHighs);
  const high52w = asNumber(m.new52WHighs, row.new20DHighs);
  const toPct = (count: number) => (memberCount > 0 ? (count / memberCount) * 100 : 0);
  return {
    memberCount,
    advancers,
    decliners,
    unchanged,
    advDecRatio: asNullableNumber(m.advDecRatio) ?? (decliners > 0 ? advancers / decliners : advancers > 0 ? null : 0),
    totalVolume: asNumber(m.totalVolume, 0),
    pctAbove5MA: asNumber(m.pctAbove5MA, row.pctAbove20MA),
    pctAbove20MA: asNumber(m.pctAbove20MA, row.pctAbove20MA),
    pctAbove50MA: asNumber(m.pctAbove50MA, row.pctAbove50MA),
    pctAbove100MA: asNumber(m.pctAbove100MA, row.pctAbove50MA),
    pctAbove200MA: asNumber(m.pctAbove200MA, row.pctAbove200MA),
    new5DHighs: high5,
    new1MHighs: high1m,
    new3MHighs: high3m,
    new6MHighs: high6m,
    new52WHighs: high52w,
    pctNew5DHighs: asNumber(m.pctNew5DHighs, toPct(high5)),
    pctNew1MHighs: asNumber(m.pctNew1MHighs, toPct(high1m)),
    pctNew3MHighs: asNumber(m.pctNew3MHighs, toPct(high3m)),
    pctNew6MHighs: asNumber(m.pctNew6MHighs, toPct(high6m)),
    pctNew52WHighs: asNumber(m.pctNew52WHighs, toPct(high52w)),
    stocksGtPos4Pct: asNumber(m.stocksGtPos4Pct, 0),
    stocksLtNeg4Pct: asNumber(m.stocksLtNeg4Pct, 0),
    stocksGtPos25Q: asNumber(m.stocksGtPos25Q, 0),
    stocksLtNeg25Q: asNumber(m.stocksLtNeg25Q, 0),
    medianReturn1D: asNumber(m.medianReturn1D, row.medianReturn1D),
    medianReturn5D: asNumber(m.medianReturn5D, row.medianReturn5D),
  };
}

function metricValue(metrics: BreadthMetrics, key: (typeof metricOptions)[number]["key"]): number {
  if (key === "new1MHighs") return metrics.new1MHighs;
  if (key === "new52WHighs") return metrics.new52WHighs;
  return metrics[key];
}

function ratioText(value: number | null): string {
  if (value === null) return "N/A";
  return value.toFixed(2);
}

function highCell(count: number, pctValue: number): string {
  return `${count} (${pctValue.toFixed(1)}%)`;
}

export function BreadthPanels({ rows, summary }: { rows: HistoricalRow[]; summary: SummaryPayload }) {
  const [lookback, setLookback] = useState<Lookback>(60);
  const [metricKey, setMetricKey] = useState<(typeof metricOptions)[number]["key"]>("pctAbove20MA");

  const scoped = useMemo(() => rows.slice(-lookback), [rows, lookback]);
  const latest = scoped[scoped.length - 1];
  const latestMetrics = latest ? normalizeMetrics(latest) : null;

  const chartData = useMemo(
    () =>
      scoped.map((r) => {
        const metrics = normalizeMetrics(r);
        return {
          asOfDate: r.asOfDate,
          metricValue: metricValue(metrics, metricKey),
        };
      }),
    [scoped, metricKey],
  );

  const summaryRows = useMemo(
    () =>
      summary.rows.map((row) => ({
        ...row,
        metrics: normalizeMetrics(row),
      })),
    [summary.rows],
  );

  const headline = useMemo(() => {
    return summaryRows.find((r) => r.universeId === "sp500-core") ?? summaryRows[0] ?? null;
  }, [summaryRows]);

  return (
    <div className="space-y-4">
      {headline && (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          <div className="card p-3">
            <div className="text-xs text-slate-400">{headline.universeName} Members</div>
            <div className="text-lg font-semibold">{numFmt.format(headline.metrics.memberCount)}</div>
          </div>
          <div className="card p-3">
            <div className="text-xs text-slate-400">Adv/Dec Ratio</div>
            <div className={`text-lg font-semibold ${colorForPercent((headline.metrics.advDecRatio ?? 0) - 1, 0)}`}>{ratioText(headline.metrics.advDecRatio)}</div>
          </div>
          <div className="card p-3">
            <div className="text-xs text-slate-400">% &gt; 20MA</div>
            <div className={`text-lg font-semibold ${colorForPercent(headline.metrics.pctAbove20MA, 50)}`}>{pct(headline.metrics.pctAbove20MA)}</div>
          </div>
          <div className="card p-3">
            <div className="text-xs text-slate-400">% &gt; 200MA</div>
            <div className={`text-lg font-semibold ${colorForPercent(headline.metrics.pctAbove200MA, 50)}`}>{pct(headline.metrics.pctAbove200MA)}</div>
          </div>
          <div className="card p-3">
            <div className="text-xs text-slate-400">New 52W Highs</div>
            <div className={`text-lg font-semibold ${colorForPercent(headline.metrics.pctNew52WHighs, 10)}`}>{highCell(headline.metrics.new52WHighs, headline.metrics.pctNew52WHighs)}</div>
          </div>
        </div>
      )}

      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold">Stocks Above Moving Average</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/70">
              <tr>
                {["Universe", "% > 5MA", "% > 20MA", "% > 50MA", "% > 100MA", "% > 200MA"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summaryRows.map((row) => (
                <tr key={`ma-${row.universeId}`} className="border-t border-borderSoft/60">
                  <td className="px-3 py-2">{row.universeName}</td>
                  <td className={`px-3 py-2 ${colorForPercent(row.metrics.pctAbove5MA, 50)}`}>{pct(row.metrics.pctAbove5MA)}</td>
                  <td className={`px-3 py-2 ${colorForPercent(row.metrics.pctAbove20MA, 50)}`}>{pct(row.metrics.pctAbove20MA)}</td>
                  <td className={`px-3 py-2 ${colorForPercent(row.metrics.pctAbove50MA, 50)}`}>{pct(row.metrics.pctAbove50MA)}</td>
                  <td className={`px-3 py-2 ${colorForPercent(row.metrics.pctAbove100MA, 50)}`}>{pct(row.metrics.pctAbove100MA)}</td>
                  <td className={`px-3 py-2 ${colorForPercent(row.metrics.pctAbove200MA, 50)}`}>{pct(row.metrics.pctAbove200MA)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold">Stocks Making New Highs (# / %)</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/70">
              <tr>
                {["Universe", "5D", "1M", "3M", "6M", "52W"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summaryRows.map((row) => (
                <tr key={`highs-${row.universeId}`} className="border-t border-borderSoft/60">
                  <td className="px-3 py-2">{row.universeName}</td>
                  <td className="px-3 py-2">{highCell(row.metrics.new5DHighs, row.metrics.pctNew5DHighs)}</td>
                  <td className="px-3 py-2">{highCell(row.metrics.new1MHighs, row.metrics.pctNew1MHighs)}</td>
                  <td className="px-3 py-2">{highCell(row.metrics.new3MHighs, row.metrics.pctNew3MHighs)}</td>
                  <td className="px-3 py-2">{highCell(row.metrics.new6MHighs, row.metrics.pctNew6MHighs)}</td>
                  <td className="px-3 py-2">{highCell(row.metrics.new52WHighs, row.metrics.pctNew52WHighs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold">Advance / Decline + Volume</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/70">
              <tr>
                {["Universe", "Adv", "Dec", "Unchanged", "A/D Ratio", "Total Volume"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summaryRows.map((row) => (
                <tr key={`ad-${row.universeId}`} className="border-t border-borderSoft/60">
                  <td className="px-3 py-2">{row.universeName}</td>
                  <td className={`px-3 py-2 ${colorForPercent(row.metrics.advancers - row.metrics.decliners, 0)}`}>{row.metrics.advancers}</td>
                  <td className="px-3 py-2">{row.metrics.decliners}</td>
                  <td className="px-3 py-2">{row.metrics.unchanged}</td>
                  <td className={`px-3 py-2 ${colorForPercent((row.metrics.advDecRatio ?? 0) - 1, 0)}`}>{ratioText(row.metrics.advDecRatio)}</td>
                  <td className="px-3 py-2">{numFmt.format(Math.round(row.metrics.totalVolume))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold">Other Breadth Indicators</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/70">
              <tr>
                {["Universe", "# > +4% Today", "# < -4% Today", "# > +25% (Quarter)", "# < -25% (Quarter)"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summaryRows.map((row) => (
                <tr key={`other-${row.universeId}`} className="border-t border-borderSoft/60">
                  <td className="px-3 py-2">{row.universeName}</td>
                  <td className="px-3 py-2">{row.metrics.stocksGtPos4Pct}</td>
                  <td className="px-3 py-2">{row.metrics.stocksLtNeg4Pct}</td>
                  <td className="px-3 py-2">{row.metrics.stocksGtPos25Q}</td>
                  <td className="px-3 py-2">{row.metrics.stocksLtNeg25Q}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold">Historical Breadth Trend</div>
          <div className="flex items-center gap-2">
            <select
              className="rounded-xl border border-borderSoft bg-panelSoft px-2 py-1 text-sm"
              value={metricKey}
              onChange={(e) => setMetricKey(e.target.value as (typeof metricOptions)[number]["key"])}
            >
              {metricOptions.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </select>
            {lookbacks.map((d) => (
              <button
                key={d}
                onClick={() => setLookback(d)}
                className={`rounded-lg px-2 py-1 text-xs ${lookback === d ? "bg-accent/20 text-accent" : "bg-slate-800/70 text-slate-300"}`}
              >
                {d}D
              </button>
            ))}
          </div>
        </div>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <XAxis dataKey="asOfDate" tick={{ fill: "#94A3B8", fontSize: 11 }} />
              <YAxis tick={{ fill: "#94A3B8", fontSize: 11 }} />
              <Tooltip />
              <Line type="monotone" dataKey="metricValue" stroke="#38BDF8" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold">Historical Metrics Table ({lookback} days)</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/70">
              <tr>
                {["Date", "Adv", "Dec", "Unc", "A/D Ratio", "% > 20MA", "% > 50MA", "% > 200MA", "1M Highs", "52W Highs"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...scoped].reverse().map((row) => {
                const metrics = normalizeMetrics(row);
                return (
                  <tr key={row.asOfDate} className="border-t border-borderSoft/60">
                    <td className="px-3 py-2">{row.asOfDate}</td>
                    <td className={`px-3 py-2 ${colorForPercent(metrics.advancers - metrics.decliners, 0)}`}>{metrics.advancers}</td>
                    <td className="px-3 py-2">{metrics.decliners}</td>
                    <td className="px-3 py-2">{metrics.unchanged}</td>
                    <td className={`px-3 py-2 ${colorForPercent((metrics.advDecRatio ?? 0) - 1, 0)}`}>{ratioText(metrics.advDecRatio)}</td>
                    <td className={`px-3 py-2 ${colorForPercent(metrics.pctAbove20MA, 50)}`}>{pct(metrics.pctAbove20MA)}</td>
                    <td className={`px-3 py-2 ${colorForPercent(metrics.pctAbove50MA, 50)}`}>{pct(metrics.pctAbove50MA)}</td>
                    <td className={`px-3 py-2 ${colorForPercent(metrics.pctAbove200MA, 50)}`}>{pct(metrics.pctAbove200MA)}</td>
                    <td className="px-3 py-2">{metrics.new1MHighs}</td>
                    <td className="px-3 py-2">{metrics.new52WHighs}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {summary.unavailable.length > 0 && (
        <div className="card p-4">
          <div className="mb-2 text-sm font-semibold">Unavailable Free Data</div>
          <div className="space-y-2 text-sm text-slate-300">
            {summary.unavailable.map((entry) => (
              <p key={entry.id}>
                <span className="font-medium text-slate-200">{entry.name}:</span> {entry.reason}
              </p>
            ))}
          </div>
        </div>
      )}

      {summaryRows.some((row) => row.dataSource) && (
        <div className="card p-4">
          <div className="mb-2 text-sm font-semibold">Data Sources</div>
          <div className="space-y-1 text-sm text-slate-300">
            {summaryRows.map((row) => (
              <p key={`src-${row.universeId}`}>
                <span className="font-medium text-slate-200">{row.universeName}:</span> {row.dataSource ?? "Source metadata unavailable"}
              </p>
            ))}
          </div>
        </div>
      )}

      {!latestMetrics && <p className="text-sm text-slate-400">No breadth history available yet. Run EOD refresh to populate.</p>}
    </div>
  );
}
