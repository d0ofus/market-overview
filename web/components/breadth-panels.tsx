"use client";

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

export function BreadthPanels({ rows }: { rows: Row[] }) {
  const latest = rows[rows.length - 1];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
        <div className="card p-3">Adv/Dec: {latest?.advancers ?? 0}/{latest?.decliners ?? 0}</div>
        <div className="card p-3">% &gt; 20MA: {(latest?.pctAbove20MA ?? 0).toFixed(1)}%</div>
        <div className="card p-3">% &gt; 50MA: {(latest?.pctAbove50MA ?? 0).toFixed(1)}%</div>
        <div className="card p-3">% &gt; 200MA: {(latest?.pctAbove200MA ?? 0).toFixed(1)}%</div>
        <div className="card p-3">New 20D Highs: {latest?.new20DHighs ?? 0}</div>
        <div className="card p-3">New 20D Lows: {latest?.new20DLows ?? 0}</div>
      </div>
      <div className="card h-72 p-3">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows}>
            <XAxis dataKey="asOfDate" hide />
            <YAxis />
            <Tooltip />
            <Line type="monotone" dataKey="pctAbove50MA" stroke="#38BDF8" dot={false} />
            <Line type="monotone" dataKey="pctAbove200MA" stroke="#22C55E" dot={false} />
            <Line type="monotone" dataKey="medianReturn1D" stroke="#F59E0B" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
