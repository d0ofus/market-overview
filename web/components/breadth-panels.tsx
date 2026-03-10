"use client";

import { useMemo, useState } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type BreadthMetrics = {
  memberCount: number;
  totalUniverseMembers: number;
  dataCoveragePct: number;
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
const HISTORY_DAYS = 90;

const metricOptions = [
  { key: "advancers", label: "Advancers", format: (value: number) => numFmt.format(Math.round(value)) },
  { key: "decliners", label: "Decliners", format: (value: number) => numFmt.format(Math.round(value)) },
  { key: "unchanged", label: "Unchanged", format: (value: number) => numFmt.format(Math.round(value)) },
  { key: "advDecRatio", label: "A/D Ratio", format: (value: number) => value.toFixed(2) },
  { key: "pctAbove5MA", label: "% > 5MA", format: (value: number) => pct(value) },
  { key: "pctAbove20MA", label: "% > 20MA", format: (value: number) => pct(value) },
  { key: "pctAbove50MA", label: "% > 50MA", format: (value: number) => pct(value) },
  { key: "pctAbove100MA", label: "% > 100MA", format: (value: number) => pct(value) },
  { key: "pctAbove200MA", label: "% > 200MA", format: (value: number) => pct(value) },
  { key: "new5DHighs", label: "New 5D Highs (#)", format: (value: number) => numFmt.format(Math.round(value)) },
  { key: "new1MHighs", label: "New 1M Highs (#)", format: (value: number) => numFmt.format(Math.round(value)) },
  { key: "new3MHighs", label: "New 3M Highs (#)", format: (value: number) => numFmt.format(Math.round(value)) },
  { key: "new6MHighs", label: "New 6M Highs (#)", format: (value: number) => numFmt.format(Math.round(value)) },
  { key: "new52WHighs", label: "New 52W Highs (#)", format: (value: number) => numFmt.format(Math.round(value)) },
  { key: "totalVolume", label: "Total Volume", format: (value: number) => numFmt.format(Math.round(value)) },
  { key: "medianReturn1D", label: "Median Return 1D (%)", format: (value: number) => `${value.toFixed(2)}%` },
  { key: "medianReturn5D", label: "Median Return 5D (%)", format: (value: number) => `${value.toFixed(2)}%` },
  { key: "stocksGtPos4Pct", label: "# > +4% Today", format: (value: number) => numFmt.format(Math.round(value)) },
  { key: "stocksLtNeg4Pct", label: "# < -4% Today", format: (value: number) => numFmt.format(Math.round(value)) },
  { key: "stocksGtPos25Q", label: "# > +25% Quarter", format: (value: number) => numFmt.format(Math.round(value)) },
  { key: "stocksLtNeg25Q", label: "# < -25% Quarter", format: (value: number) => numFmt.format(Math.round(value)) },
] as const;

const positive = "text-pos";
const negative = "text-neg";
const neutral = "text-slate-200";
const numFmt = new Intl.NumberFormat("en-US");
const metricSourceMap = [
  "Advancers/Decliners/Unchanged and A/D Ratio: computed from each member's latest 1D close change in the selected universe.",
  "Stocks Above 5/20/50/100/200 MA: computed from daily close vs simple moving average from stored daily bars.",
  "New Highs (5D/1M/3M/6M/52W): computed from rolling high windows on stored daily closes; percentages are count / universe members.",
  "Total Volume: sum of latest daily volume across universe members from daily bars.",
  "Other Breadth Indicators (>+4%, <-4%, >+25% quarter, <-25% quarter): computed from 1D and ~63-trading-day returns.",
];

function asNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  const fallbackParsed = typeof fallback === "number" ? fallback : Number(fallback);
  return Number.isFinite(fallbackParsed) ? fallbackParsed : 0;
}

function asNullableNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function colorForPercent(value: number, threshold = 0): string {
  return value >= threshold ? positive : negative;
}

function colorVsPrevious(current: number, previous: number | null | undefined): string {
  if (previous == null || !Number.isFinite(previous)) return neutral;
  if (current > previous) return positive;
  if (current < previous) return negative;
  return neutral;
}

function pct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function normalizeMetrics(row: HistoricalRow | SummaryRow): BreadthMetrics {
  const m = (row.metrics ?? {}) as Record<string, unknown>;
  const memberCount = asNumber(m.memberCount, row.advancers + row.decliners + row.unchanged);
  const totalUniverseMembers = asNumber(m.totalUniverseMembers, memberCount);
  const dataCoveragePct = asNumber(m.dataCoveragePct, totalUniverseMembers > 0 ? (memberCount / totalUniverseMembers) * 100 : 0);
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
    totalUniverseMembers,
    dataCoveragePct,
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
  const value = metrics[key];
  return typeof value === "number" ? value : 0;
}

function ratioText(value: number | null): string {
  if (value === null) return "N/A";
  return value.toFixed(2);
}

function highCell(count: number, pctValue: number): string {
  return `${count} (${pctValue.toFixed(1)}%)`;
}

function CollapsibleInfoSection({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="card overflow-hidden">
      <Collapsible.Trigger className="flex w-full items-center justify-between border-b border-borderSoft/70 px-4 py-3 text-left">
        <span className="text-sm font-semibold">{title}</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </Collapsible.Trigger>
      <Collapsible.Content className="p-4">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

export function BreadthPanels({
  rows,
  summary,
  histories,
  footer,
}: {
  rows: HistoricalRow[];
  summary: SummaryPayload;
  histories: Record<string, HistoricalRow[]>;
  footer?: React.ReactNode;
}) {
  const [lookback, setLookback] = useState<Lookback>(90);
  const [metricKey, setMetricKey] = useState<(typeof metricOptions)[number]["key"]>("pctAbove20MA");

  const historyRows = useMemo(() => rows.slice(-HISTORY_DAYS), [rows]);
  const scoped = useMemo(() => historyRows.slice(-lookback), [historyRows, lookback]);
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
  const selectedMetric = useMemo(
    () => metricOptions.find((option) => option.key === metricKey) ?? metricOptions[0],
    [metricKey],
  );

  const previousByUniverse = useMemo(() => {
    const map = new Map<string, BreadthMetrics>();
    for (const [universeId, universeRows] of Object.entries(histories)) {
      if ((universeRows ?? []).length < 2) continue;
      const prevRow = universeRows[universeRows.length - 2];
      if (prevRow) map.set(universeId, normalizeMetrics(prevRow));
    }
    return map;
  }, [histories]);

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

  const historicalRows = useMemo(
    () =>
      historyRows
        .map((row, i) => ({
          row,
          metrics: normalizeMetrics(row),
          prevMetrics: i > 0 ? normalizeMetrics(historyRows[i - 1]) : null,
        }))
        .reverse(),
    [historyRows],
  );

  return (
    <div className="space-y-4">
      {headline && (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          <div className="card p-3">
            <div className="text-xs text-slate-400">{headline.universeName} Members</div>
            <div className="text-lg font-semibold">{numFmt.format(headline.metrics.memberCount)}</div>
            <div className="text-[11px] text-slate-500">coverage {headline.metrics.dataCoveragePct.toFixed(1)}%</div>
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
            <thead className="bg-slate-900/60">
              <tr>
                {["Universe", "% > 5MA", "% > 20MA", "% > 50MA", "% > 100MA", "% > 200MA"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summaryRows.map((row) => {
                const prev = previousByUniverse.get(row.universeId);
                return (
                  <tr key={`ma-${row.universeId}`} className="border-t border-borderSoft/60">
                    <td className="px-3 py-2">{row.universeName}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.pctAbove5MA, prev?.pctAbove5MA)}`}>{pct(row.metrics.pctAbove5MA)}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.pctAbove20MA, prev?.pctAbove20MA)}`}>{pct(row.metrics.pctAbove20MA)}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.pctAbove50MA, prev?.pctAbove50MA)}`}>{pct(row.metrics.pctAbove50MA)}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.pctAbove100MA, prev?.pctAbove100MA)}`}>{pct(row.metrics.pctAbove100MA)}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.pctAbove200MA, prev?.pctAbove200MA)}`}>{pct(row.metrics.pctAbove200MA)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold">Stocks Making New Highs (# / %)</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/60">
              <tr>
                {["Universe", "5D", "1M", "3M", "6M", "52W"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summaryRows.map((row) => {
                const prev = previousByUniverse.get(row.universeId);
                return (
                  <tr key={`highs-${row.universeId}`} className="border-t border-borderSoft/60">
                    <td className="px-3 py-2">{row.universeName}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.new5DHighs, prev?.new5DHighs)}`}>{highCell(row.metrics.new5DHighs, row.metrics.pctNew5DHighs)}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.new1MHighs, prev?.new1MHighs)}`}>{highCell(row.metrics.new1MHighs, row.metrics.pctNew1MHighs)}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.new3MHighs, prev?.new3MHighs)}`}>{highCell(row.metrics.new3MHighs, row.metrics.pctNew3MHighs)}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.new6MHighs, prev?.new6MHighs)}`}>{highCell(row.metrics.new6MHighs, row.metrics.pctNew6MHighs)}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.new52WHighs, prev?.new52WHighs)}`}>{highCell(row.metrics.new52WHighs, row.metrics.pctNew52WHighs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold">Advance / Decline + Volume</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/60">
              <tr>
                {["Universe", "Adv", "Dec", "Unchanged", "A/D Ratio", "Total Volume"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summaryRows.map((row) => {
                const prev = previousByUniverse.get(row.universeId);
                return (
                  <tr key={`ad-${row.universeId}`} className="border-t border-borderSoft/60">
                    <td className="px-3 py-2">{row.universeName}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.advancers, prev?.advancers)}`}>{row.metrics.advancers}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.decliners, prev?.decliners)}`}>{row.metrics.decliners}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.unchanged, prev?.unchanged)}`}>{row.metrics.unchanged}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.advDecRatio ?? 0, prev?.advDecRatio ?? null)}`}>{ratioText(row.metrics.advDecRatio)}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.totalVolume, prev?.totalVolume)}`}>{numFmt.format(Math.round(row.metrics.totalVolume))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold">Other Breadth Indicators</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/60">
              <tr>
                {["Universe", "# > +4% Today", "# < -4% Today", "# > +25% (Quarter)", "# < -25% (Quarter)"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summaryRows.map((row) => {
                const prev = previousByUniverse.get(row.universeId);
                return (
                  <tr key={`other-${row.universeId}`} className="border-t border-borderSoft/60">
                    <td className="px-3 py-2">{row.universeName}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.stocksGtPos4Pct, prev?.stocksGtPos4Pct)}`}>{row.metrics.stocksGtPos4Pct}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.stocksLtNeg4Pct, prev?.stocksLtNeg4Pct)}`}>{row.metrics.stocksLtNeg4Pct}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.stocksGtPos25Q, prev?.stocksGtPos25Q)}`}>{row.metrics.stocksGtPos25Q}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(row.metrics.stocksLtNeg25Q, prev?.stocksLtNeg25Q)}`}>{row.metrics.stocksLtNeg25Q}</td>
                  </tr>
                );
              })}
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
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const raw = payload[0]?.value;
                  const value = typeof raw === "number" ? raw : Number(raw ?? 0);
                  return (
                    <div className="rounded border border-slate-600/50 bg-slate-950/95 px-2 py-1 text-xs text-white">
                      <div className="text-white">{label}</div>
                      <div className="font-medium text-white">{selectedMetric.format(value)}</div>
                    </div>
                  );
                }}
              />
              <Line type="monotone" dataKey="metricValue" stroke="#38BDF8" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold">Historical Metrics Table (90 days)</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/60">
              <tr>
                {["Date", "Adv", "Dec", "Unc", "A/D", "%>5", "%>20", "%>50", "%>100", "%>200", "5D Highs", "1M Highs", "3M Highs", "6M Highs", "52W Highs", "Vol", "Med 1D", "Med 5D", ">+4%", "<-4%", ">+25Q", "<-25Q"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {historicalRows.map(({ row, metrics, prevMetrics }) => {
                return (
                  <tr key={row.asOfDate} className="border-t border-borderSoft/60">
                    <td className="px-3 py-2">{row.asOfDate}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.advancers, prevMetrics?.advancers)}`}>{metrics.advancers}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.decliners, prevMetrics?.decliners)}`}>{metrics.decliners}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.unchanged, prevMetrics?.unchanged)}`}>{metrics.unchanged}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.advDecRatio ?? 0, prevMetrics?.advDecRatio ?? null)}`}>{ratioText(metrics.advDecRatio)}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.pctAbove5MA, prevMetrics?.pctAbove5MA)}`}>{pct(metrics.pctAbove5MA)}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.pctAbove20MA, prevMetrics?.pctAbove20MA)}`}>{pct(metrics.pctAbove20MA)}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.pctAbove50MA, prevMetrics?.pctAbove50MA)}`}>{pct(metrics.pctAbove50MA)}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.pctAbove100MA, prevMetrics?.pctAbove100MA)}`}>{pct(metrics.pctAbove100MA)}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.pctAbove200MA, prevMetrics?.pctAbove200MA)}`}>{pct(metrics.pctAbove200MA)}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.new5DHighs, prevMetrics?.new5DHighs)}`}>{metrics.new5DHighs}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.new1MHighs, prevMetrics?.new1MHighs)}`}>{metrics.new1MHighs}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.new3MHighs, prevMetrics?.new3MHighs)}`}>{metrics.new3MHighs}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.new6MHighs, prevMetrics?.new6MHighs)}`}>{metrics.new6MHighs}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.new52WHighs, prevMetrics?.new52WHighs)}`}>{metrics.new52WHighs}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.totalVolume, prevMetrics?.totalVolume)}`}>{numFmt.format(Math.round(metrics.totalVolume))}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.medianReturn1D, prevMetrics?.medianReturn1D)}`}>{metrics.medianReturn1D.toFixed(2)}%</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.medianReturn5D, prevMetrics?.medianReturn5D)}`}>{metrics.medianReturn5D.toFixed(2)}%</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.stocksGtPos4Pct, prevMetrics?.stocksGtPos4Pct)}`}>{metrics.stocksGtPos4Pct}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.stocksLtNeg4Pct, prevMetrics?.stocksLtNeg4Pct)}`}>{metrics.stocksLtNeg4Pct}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.stocksGtPos25Q, prevMetrics?.stocksGtPos25Q)}`}>{metrics.stocksGtPos25Q}</td>
                    <td className={`px-3 py-2 ${colorVsPrevious(metrics.stocksLtNeg25Q, prevMetrics?.stocksLtNeg25Q)}`}>{metrics.stocksLtNeg25Q}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {!latestMetrics && <p className="text-sm text-slate-400">No breadth history available yet. Run EOD refresh to populate.</p>}
      {footer}

      {summaryRows.some((row) => row.dataSource) && (
        <CollapsibleInfoSection title="Data Sources">
          <div className="space-y-1 text-sm text-slate-300">
            {summaryRows.map((row) => (
              <p key={`src-${row.universeId}`}>
                <span className="font-medium text-slate-200">{row.universeName}:</span> {row.dataSource ?? "Source metadata unavailable"}
              </p>
            ))}
          </div>
        </CollapsibleInfoSection>
      )}

      <CollapsibleInfoSection title="Metric Source Map">
        <div className="space-y-1 text-sm text-slate-300">
          {metricSourceMap.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </CollapsibleInfoSection>
    </div>
  );
}
