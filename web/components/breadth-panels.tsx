"use client";

import { useMemo, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Row = {
  asOfDate: string;
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
};

type Lookback = 30 | 60 | 90;
const lookbacks: Lookback[] = [30, 60, 90];

const metricOptions = [
  { key: "pctAbove20MA", label: "% > 20MA" },
  { key: "pctAbove50MA", label: "% > 50MA" },
  { key: "pctAbove200MA", label: "% > 200MA" },
  { key: "medianReturn1D", label: "Median Return 1D (%)" },
  { key: "medianReturn5D", label: "Median Return 5D (%)" },
] as const;

const positive = "text-pos";
const negative = "text-neg";

function colorForPercent(value: number, threshold = 0): string {
  return value >= threshold ? positive : negative;
}

export function BreadthPanels({ rows }: { rows: Row[] }) {
  const [lookback, setLookback] = useState<Lookback>(60);
  const [metricKey, setMetricKey] = useState<(typeof metricOptions)[number]["key"]>("pctAbove20MA");

  const scoped = useMemo(() => rows.slice(-lookback), [rows, lookback]);
  const latest = scoped[scoped.length - 1];
  const chartData = useMemo(
    () =>
      scoped.map((r) => ({
        ...r,
        metricValue: r[metricKey],
      })),
    [scoped, metricKey],
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
        <div className="card p-3">
          <div className="text-xs text-slate-400">Adv/Dec</div>
          <div className={`text-lg font-semibold ${(latest?.advancers ?? 0) >= (latest?.decliners ?? 0) ? positive : negative}`}>
            {latest?.advancers ?? 0}/{latest?.decliners ?? 0}
          </div>
        </div>
        <div className="card p-3">
          <div className="text-xs text-slate-400">% &gt; 20MA</div>
          <div className={`text-lg font-semibold ${colorForPercent(latest?.pctAbove20MA ?? 0, 50)}`}>{(latest?.pctAbove20MA ?? 0).toFixed(1)}%</div>
        </div>
        <div className="card p-3">
          <div className="text-xs text-slate-400">% &gt; 50MA</div>
          <div className={`text-lg font-semibold ${colorForPercent(latest?.pctAbove50MA ?? 0, 50)}`}>{(latest?.pctAbove50MA ?? 0).toFixed(1)}%</div>
        </div>
        <div className="card p-3">
          <div className="text-xs text-slate-400">% &gt; 200MA</div>
          <div className={`text-lg font-semibold ${colorForPercent(latest?.pctAbove200MA ?? 0, 50)}`}>{(latest?.pctAbove200MA ?? 0).toFixed(1)}%</div>
        </div>
        <div className="card p-3">
          <div className="text-xs text-slate-400">New 20D Highs</div>
          <div className={`text-lg font-semibold ${colorForPercent((latest?.new20DHighs ?? 0) - (latest?.new20DLows ?? 0), 0)}`}>{latest?.new20DHighs ?? 0}</div>
        </div>
        <div className="card p-3">
          <div className="text-xs text-slate-400">New 20D Lows</div>
          <div className="text-lg font-semibold text-neg">{latest?.new20DLows ?? 0}</div>
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
                {["Date", "Adv", "Dec", "Unc", "% > 20MA", "% > 50MA", "% > 200MA", "20D Highs", "20D Lows", "Median 1D%", "Median 5D%"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...scoped].reverse().map((r) => (
                <tr key={r.asOfDate} className="border-t border-borderSoft/60">
                  <td className="px-3 py-2">{r.asOfDate}</td>
                  <td className={`px-3 py-2 ${colorForPercent(r.advancers - r.decliners, 0)}`}>{r.advancers}</td>
                  <td className="px-3 py-2 text-slate-300">{r.decliners}</td>
                  <td className="px-3 py-2 text-slate-300">{r.unchanged}</td>
                  <td className={`px-3 py-2 ${colorForPercent(r.pctAbove20MA, 50)}`}>{r.pctAbove20MA.toFixed(1)}%</td>
                  <td className={`px-3 py-2 ${colorForPercent(r.pctAbove50MA, 50)}`}>{r.pctAbove50MA.toFixed(1)}%</td>
                  <td className={`px-3 py-2 ${colorForPercent(r.pctAbove200MA, 50)}`}>{r.pctAbove200MA.toFixed(1)}%</td>
                  <td className={`px-3 py-2 ${colorForPercent(r.new20DHighs - r.new20DLows, 0)}`}>{r.new20DHighs}</td>
                  <td className="px-3 py-2 text-slate-300">{r.new20DLows}</td>
                  <td className={`px-3 py-2 ${colorForPercent(r.medianReturn1D, 0)}`}>{r.medianReturn1D.toFixed(2)}%</td>
                  <td className={`px-3 py-2 ${colorForPercent(r.medianReturn5D, 0)}`}>{r.medianReturn5D.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
