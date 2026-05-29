"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Loader2 } from "lucide-react";
import { getTicker } from "@/lib/api";
import type { TickerHistoryBackfillStatus, TickerSeriesTimeframe } from "@/lib/api";
import type { TradingViewComparePosition } from "./tradingview-widget";

type ComparisonItem = {
  ticker: string;
  color: string;
};

type LoadedSeries = {
  ticker: string;
  color: string;
  rows: Array<{ date: string; close: number }>;
  historyStatus?: {
    timeframe: TickerSeriesTimeframe;
    requestedBars: number | null;
    availableBars: number;
    complete: boolean;
    backfill: TickerHistoryBackfillStatus | null;
  };
};

type ChartRow = Record<string, number | string | null> & { date: string };

const CHART_GRID_COLOR = "rgba(148,163,184,0.12)";
const CHART_AXIS_COLOR = "#94a3b8";
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function normalizeTicker(value: string): string {
  return value.trim().toUpperCase();
}

function formatDate(value: string, includeYear = false): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  const label = `${parsed.getUTCDate()}-${MONTH_LABELS[parsed.getUTCMonth()]}`;
  return includeYear ? `${label}-${parsed.getUTCFullYear()}` : label;
}

function formatPrice(value: number): string {
  return Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 100 ? 2 : 3,
  }).format(value);
}

function formatPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function chartValueFormatter(mode: TradingViewComparePosition) {
  return (value: unknown, name: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return ["-", String(name)] as [string, string];
    return [mode === "SameScale" ? formatPercent(value) : formatPrice(value), String(name)] as [string, string];
  };
}

function historyStatusMessage(item: LoadedSeries): string | null {
  const status = item.historyStatus;
  if (!status || status.timeframe !== "2Y" || status.complete) return null;
  const countLabel = `${status.availableBars}/${status.requestedBars ?? 500}`;
  if (status.backfill?.status === "queued") {
    return `${item.ticker}: 2Y history is short (${countLabel} bars); background backfill queued.`;
  }
  if (status.backfill?.status === "recently_requested") {
    return `${item.ticker}: 2Y history is short (${countLabel} bars); background backfill was recently requested.`;
  }
  if (status.backfill?.status === "unavailable") {
    return `${item.ticker}: 2Y history is short (${countLabel} bars); background backfill is unavailable.`;
  }
  return `${item.ticker}: 2Y history is short (${countLabel} bars).`;
}

function uniqueItems(items: ComparisonItem[]): ComparisonItem[] {
  const seen = new Set<string>();
  const unique: ComparisonItem[] = [];
  for (const item of items) {
    const ticker = normalizeTicker(item.ticker);
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    unique.push({ ticker, color: item.color });
  }
  return unique;
}

function buildRows(series: LoadedSeries[], mode: TradingViewComparePosition): ChartRow[] {
  if (series.length === 0) return [];
  const firstDates = series
    .map((item) => item.rows[0]?.date)
    .filter((date): date is string => Boolean(date));
  const commonStart = mode === "SameScale"
    ? firstDates.sort().at(-1) ?? null
    : null;
  const dates = Array.from(new Set(
    series.flatMap((item) => item.rows.map((row) => row.date)),
  ))
    .filter((date) => !commonStart || date >= commonStart)
    .sort();

  const closeByTicker = new Map(
    series.map((item) => [
      item.ticker,
      new Map(item.rows.map((row) => [row.date, row.close])),
    ]),
  );
  const baseCloseByTicker = new Map<string, number>();
  if (mode === "SameScale") {
    for (const item of series) {
      const base = item.rows.find((row) => !commonStart || row.date >= commonStart);
      if (base && Number.isFinite(base.close) && base.close > 0) {
        baseCloseByTicker.set(item.ticker, base.close);
      }
    }
  }

  return dates.map((date) => {
    const row: ChartRow = { date };
    for (const item of series) {
      const close = closeByTicker.get(item.ticker)?.get(date);
      if (typeof close !== "number" || !Number.isFinite(close)) {
        row[item.ticker] = null;
        continue;
      }
      if (mode === "SameScale") {
        const baseClose = baseCloseByTicker.get(item.ticker);
        row[item.ticker] = baseClose ? ((close / baseClose) - 1) * 100 : null;
      } else {
        row[item.ticker] = close;
      }
    }
    return row;
  });
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full min-h-[18rem] items-center justify-center px-4 text-sm text-slate-400">
      {message}
    </div>
  );
}

function MultiLineChart({
  items,
  rows,
  mode,
}: {
  items: LoadedSeries[];
  rows: ChartRow[];
  mode: TradingViewComparePosition;
}) {
  const sameScale = mode === "SameScale";
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={rows} margin={{ top: 16, right: 24, left: 4, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} />
        <XAxis
          dataKey="date"
          minTickGap={28}
          stroke={CHART_AXIS_COLOR}
          tickFormatter={(value) => formatDate(String(value))}
        />
        {sameScale ? (
          <YAxis
            yAxisId="percent"
            stroke={CHART_AXIS_COLOR}
            tickFormatter={(value) => formatPercent(Number(value))}
          />
        ) : (
          items.map((item) => (
            <YAxis key={`axis-${item.ticker}`} yAxisId={item.ticker} hide domain={["dataMin", "dataMax"]} />
          ))
        )}
        <Tooltip
          contentStyle={{ background: "#020617", border: "1px solid rgba(148,163,184,0.18)" }}
          labelFormatter={(value) => formatDate(String(value), true)}
          formatter={chartValueFormatter(mode)}
        />
        {items.map((item) => (
          <Line
            key={item.ticker}
            type="monotone"
            dataKey={item.ticker}
            name={item.ticker}
            yAxisId={sameScale ? "percent" : item.ticker}
            stroke={item.color}
            dot={false}
            connectNulls={false}
            strokeWidth={2}
            activeDot={{ r: 3 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function PaneChart({
  item,
}: {
  item: LoadedSeries;
}) {
  const rows = item.rows.map((row) => ({ date: row.date, close: row.close }));
  return (
    <div className="min-h-36 rounded border border-borderSoft/60 bg-slate-950/30 p-2">
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-slate-100">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
        {item.ticker}
      </div>
      <div className="h-28">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <XAxis dataKey="date" hide />
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <Tooltip
              contentStyle={{ background: "#020617", border: "1px solid rgba(148,163,184,0.18)" }}
              labelFormatter={(value) => formatDate(String(value), true)}
              formatter={(value) => [
                typeof value === "number" && Number.isFinite(value) ? formatPrice(value) : "-",
                item.ticker,
              ] as [string, string]}
            />
            <Line
              type="monotone"
              dataKey="close"
              stroke={item.color}
              dot={false}
              strokeWidth={2}
              activeDot={{ r: 3 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function PerplexityComparisonChart({
  items,
  mode,
  timeframe,
}: {
  items: ComparisonItem[];
  mode: TradingViewComparePosition;
  timeframe: TickerSeriesTimeframe;
}) {
  const chartItems = useMemo(() => uniqueItems(items), [items]);
  const tickersKey = chartItems.map((item) => item.ticker).join(",");
  const [series, setSeries] = useState<LoadedSeries[]>([]);
  const [loading, setLoading] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [historyMessages, setHistoryMessages] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setSeries([]);
      setWarnings([]);
      setHistoryMessages([]);
      const results = await Promise.all(chartItems.map(async (item) => {
        try {
          const data = await getTicker(item.ticker, timeframe);
          return {
            ok: true as const,
            item,
            historyStatus: data.historyStatus,
            rows: data.series
              .filter((row) => Number.isFinite(row.c))
              .map((row) => ({ date: row.date, close: row.c })),
          };
        } catch (error) {
          return {
            ok: false as const,
            item,
            message: error instanceof Error ? error.message : "Series unavailable.",
          };
        }
      }));
      if (cancelled) return;
      setSeries(results
        .filter((result): result is Extract<typeof result, { ok: true }> => result.ok)
        .filter((result) => result.rows.length > 1)
        .map((result) => ({
          ticker: result.item.ticker,
          color: result.item.color,
          rows: result.rows,
          historyStatus: result.historyStatus,
        })));
      setHistoryMessages(results
        .filter((result): result is Extract<typeof result, { ok: true }> => result.ok)
        .map((result) => historyStatusMessage({
          ticker: result.item.ticker,
          color: result.item.color,
          rows: result.rows,
          historyStatus: result.historyStatus,
        }))
        .filter((message): message is string => Boolean(message)));
      setWarnings(results
        .filter((result): result is Extract<typeof result, { ok: false }> => !result.ok)
        .map((result) => `${result.item.ticker}: ${result.message}`));
      setLoading(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [chartItems, tickersKey, timeframe]);

  const rows = useMemo(() => buildRows(series, mode), [mode, series]);

  if (loading && series.length === 0) {
    return (
      <div className="flex h-full min-h-[18rem] items-center justify-center gap-2 text-sm text-slate-300">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading comparison series...
      </div>
    );
  }

  if (series.length === 0 || rows.length === 0) {
    return <EmptyState message="No stored comparison series are available for the selected tickers." />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {mode === "NewPane" ? (
          <div className="h-full overflow-auto p-3">
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {series.map((item) => <PaneChart key={item.ticker} item={item} />)}
            </div>
          </div>
        ) : (
          <div className="h-full min-h-[18rem] p-2">
            <MultiLineChart items={series} rows={rows} mode={mode} />
          </div>
        )}
      </div>
      {historyMessages.length > 0 ? (
        <div className="border-t border-borderSoft/70 px-3 py-2 text-[11px] text-sky-100">
          {historyMessages.slice(0, 3).join(" ")}
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className="border-t border-borderSoft/70 px-3 py-2 text-[11px] text-yellow-100">
          {warnings.slice(0, 3).join(" ")}
        </div>
      ) : null}
    </div>
  );
}
