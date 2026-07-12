"use client";

import { useEffect, useMemo, useState } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown, Loader2, Maximize2 } from "lucide-react";
import { HistogramSparkline } from "./histogram-sparkline";
import { Sparkline } from "./sparkline";
import { ChartGridPager } from "./chart-grid-pager";
import { ExpandedTradingViewChartModal, HoverChartPreviewPanel, useHoverChartPreview } from "./hover-chart-preview";
import { TradingViewWidget } from "./tradingview-widget";
import { getEtfConstituents } from "@/lib/api";
import type { BarFreshnessStatus, OverviewCurrentData, QuoteFreshnessStatus } from "@/types/dashboard";

const CHARTS_PER_PAGE = 20;

type Row = {
  ticker: string;
  displayName: string | null;
  price: number | null;
  change1d: number | null;
  change1w: number | null;
  change5d: number | null;
  change3m: number | null;
  change6m: number | null;
  ytd: number | null;
  pctFrom52wHigh: number | null;
  sparkline: number[] | null;
  relativeStrength30dVsSpy: number[] | null;
  above20Sma: boolean | null;
  above50Sma: boolean | null;
  above200Sma: boolean | null;
  barDate?: string | null;
  barFreshnessStatus?: BarFreshnessStatus;
  barFreshnessReason?: string | null;
  quotePrice?: number | null;
  quotePrevClose?: number | null;
  quoteChange1d?: number | null;
  quoteFreshnessStatus?: QuoteFreshnessStatus;
  quoteFreshnessReason?: string | null;
  quoteSource?: string | null;
  currentData?: OverviewCurrentData;
  holdings: string[] | null;
};

type Props = {
  title: string;
  rows: Row[];
  columns: string[];
  defaultOpen?: boolean;
  pinTop10?: boolean;
  anchorId?: string;
};

const cellClass = (n: number | null | undefined) => (typeof n === "number" && n < 0 ? "text-neg" : "text-pos");
const pct = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "N/A");
const isSmaColumn = (column: string) => column === "20SMA" || column === "50SMA" || column === "200SMA";
const smaSortValue = (value: boolean | null): number | null => {
  if (value == null) return null;
  return value ? 1 : 0;
};
const regressionSlope = (values: number[] | null): number | null => {
  if (!values || values.length < 2) return null;
  const count = values.length;
  const meanX = (count - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / count;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < count; index += 1) {
    const centeredX = index - meanX;
    numerator += centeredX * (values[index] - meanY);
    denominator += centeredX * centeredX;
  }
  if (denominator === 0) return null;
  return numerator / denominator;
};
const defaultSortDirectionFor = (column: string): "asc" | "desc" =>
  column === "1D" || column === "relativeStrength30dVsSpy" || isSmaColumn(column) ? "desc" : "asc";
const titleCase = (value: string): string => {
  if (value === "1D" || value === "5D" || value === "1W" || value === "3M" || value === "6M" || value === "YTD" || isSmaColumn(value)) return value;
  if (value === "pctFrom52WHigh") return "% From 52W High";
  if (value === "relativeStrength30dVsSpy") return "RS 30d vs SPY";
  return value.charAt(0).toUpperCase() + value.slice(1);
};
const hasCurrentField = (row: Row, field: string): boolean => {
  if (row.currentData) return Boolean(row.currentData.fieldSources[field]);
  return row.quoteFreshnessStatus === "fresh";
};
const hasHistoricalMetrics = (row: Row) => row.barFreshnessStatus === "fresh";
const quoteFreshnessLabel = (status: QuoteFreshnessStatus | undefined): string => {
  if (status === "stale") return "Stale";
  if (status === "unavailable") return "N/A";
  if (status === "unsupported") return "Unsupported";
  return "Fresh";
};
const quoteFreshnessClass = (status: QuoteFreshnessStatus | undefined): string => {
  if (status === "stale") return "border-amber-400/35 bg-amber-500/10 text-amber-200";
  if (status === "unavailable") return "border-red-400/35 bg-red-500/10 text-red-200";
  if (status === "unsupported") return "border-slate-500/45 bg-slate-700/40 text-slate-300";
  return "border-emerald-400/25 bg-emerald-500/10 text-emerald-200";
};

function QuoteFreshnessBadge({ row }: { row: Row }) {
  const status = row.quoteFreshnessStatus;
  const retrying = row.currentData?.status === "retrying";
  if ((!status || status === "fresh") && !retrying) return null;
  const providerDetails = Object.entries(row.currentData?.providerStatuses ?? {})
    .map(([provider, diagnostic]) => `${provider}: ${diagnostic.status} (${diagnostic.reason})`)
    .join(" ");
  const title = [
    row.currentData?.reason ?? row.quoteFreshnessReason,
    providerDetails || null,
    row.barDate ? `Bar date: ${row.barDate}` : null,
    row.quoteSource ? `Source: ${row.quoteSource}` : null,
  ].filter(Boolean).join(" ");
  return (
    <span
      className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${quoteFreshnessClass(retrying ? "stale" : status)}`}
      title={title || quoteFreshnessLabel(status)}
    >
      {retrying ? "Retrying" : quoteFreshnessLabel(status)}
    </span>
  );
}

function HistoryFreshnessBadge({ row }: { row: Row }) {
  const status = row.barFreshnessStatus;
  if (!status || status === "fresh") return null;
  const title = [
    row.barFreshnessReason,
    row.barDate ? `Bar date: ${row.barDate}` : null,
  ].filter(Boolean).join(" ");
  return (
    <span
      className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${quoteFreshnessClass(status)}`}
      title={title || `History ${quoteFreshnessLabel(status)}`}
    >
      History
    </span>
  );
}

function SmaStatusIndicator({ value }: { value: boolean | null }) {
  if (value == null) {
    return <span className="text-xs text-slate-500" title="Current-session SMA status unavailable">N/A</span>;
  }
  if (value) {
    return (
      <span
        className="inline-block h-0 w-0 border-x-[6px] border-b-[10px] border-x-transparent border-b-emerald-400"
        title="Price above SMA"
      />
    );
  }
  return (
    <span
      className="inline-block h-0 w-0 border-x-[6px] border-t-[10px] border-x-transparent border-t-rose-400"
      title="Price below SMA"
    />
  );
}

export function GroupPanel({ title, rows, columns, defaultOpen = true, pinTop10 = false, anchorId }: Props) {
  const [activeEtf, setActiveEtf] = useState<{ ticker: string; name: string | null } | null>(null);
  const [constituentLoading, setConstituentLoading] = useState(false);
  const [constituentWarning, setConstituentWarning] = useState<string | null>(null);
  const [constituents, setConstituents] = useState<Array<{ ticker: string; name: string | null; weight: number | null; change1d?: number; lastPrice?: number }>>([]);
  const [constituentSort, setConstituentSort] = useState<"weight" | "change1d">("change1d");
  const [activeChartTicker, setActiveChartTicker] = useState<string | null>(null);
  const hoverChart = useHoverChartPreview({ disabled: Boolean(activeChartTicker || activeEtf) });
  const [constituentPage, setConstituentPage] = useState(1);
  const showsEtfConstituents = title === "Sector ETFs" || title.startsWith("Industry/Thematic ETFs");
  const defaultSortKey = columns.includes("1D")
    ? "1D"
    : columns.includes("ticker")
      ? "ticker"
      : columns[0] ?? "ticker";
  const [sortKey, setSortKey] = useState<string>(defaultSortKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(defaultSortDirectionFor(defaultSortKey));
  const sortedRows = useMemo(() => {
    const copy = [...rows];
    const stringValueFor = (row: Row, key: string): string | null => {
      if (key === "ticker") return row.ticker ?? "";
      if (key === "name") return (row.displayName ?? row.ticker ?? "").toUpperCase();
      return null;
    };
    const numberValueFor = (row: Row, key: string): number | null => {
      if (key === "price") return hasCurrentField(row, "price") ? row.quotePrice ?? null : null;
      if (key === "1D") return hasCurrentField(row, "change1d") ? row.quoteChange1d ?? null : null;
      if (key === "sparkline" || key === "relativeStrength30dVsSpy") {
        if (!hasHistoricalMetrics(row)) return null;
      }
      if (key === "1W") return hasCurrentField(row, "change1w") ? row.change1w ?? null : null;
      if (key === "5D") return hasCurrentField(row, "change5d") ? row.change5d ?? null : null;
      if (key === "3M") return hasCurrentField(row, "change3m") ? row.change3m ?? null : null;
      if (key === "6M") return hasCurrentField(row, "change6m") ? row.change6m ?? null : null;
      if (key === "YTD") return hasCurrentField(row, "ytd") ? row.ytd ?? null : null;
      if (key === "pctFrom52WHigh") return hasCurrentField(row, "pctFrom52wHigh") ? row.pctFrom52wHigh ?? null : null;
      if (key === "sparkline") return row.sparkline?.[row.sparkline.length - 1] ?? null;
      if (key === "relativeStrength30dVsSpy") return regressionSlope(row.relativeStrength30dVsSpy);
      if (key === "20SMA") return hasCurrentField(row, "above20Sma") ? smaSortValue(row.above20Sma) : null;
      if (key === "50SMA") return hasCurrentField(row, "above50Sma") ? smaSortValue(row.above50Sma) : null;
      if (key === "200SMA") return hasCurrentField(row, "above200Sma") ? smaSortValue(row.above200Sma) : null;
      return null;
    };
    copy.sort((a, b) => {
      const avString = stringValueFor(a, sortKey);
      const bvString = stringValueFor(b, sortKey);
      if (avString != null || bvString != null) {
        const cmp = String(avString ?? "").localeCompare(String(bvString ?? ""));
        return sortDir === "asc" ? cmp : -cmp;
      }
      const av = numberValueFor(a, sortKey);
      const bv = numberValueFor(b, sortKey);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = av - bv;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortDir, sortKey]);
  const selected = pinTop10 ? sortedRows.slice(0, 10) : sortedRows;
  const sortGlyph = (col: string): string => {
    if (sortKey !== col) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  };
  const onSort = (col: string) => {
    if (sortKey === col) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(col);
    setSortDir(defaultSortDirectionFor(col));
  };
  const openExpandedChart = (ticker: string) => {
    hoverChart.clearPreview();
    setActiveChartTicker(ticker);
  };

  const closeExpandedChart = () => {
    hoverChart.clearPreview();
    setActiveChartTicker(null);
  };
  const renderCell = (row: Row, column: string) => {
    if (column === "ticker") {
      return (
        <td key={`${row.ticker}-${column}`} className="px-3 py-2 font-semibold">
          <div className="flex items-center gap-2">
            {showsEtfConstituents ? (
              <button
                className="text-left text-accent hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  void openEtfConstituents(row.ticker, row.displayName);
                }}
                onMouseEnter={(event) => hoverChart.openPreview(row.ticker, event.currentTarget)}
                onMouseLeave={() => hoverChart.closePreviewForTicker(row.ticker)}
                title={row.displayName ?? row.ticker}
              >
                {row.ticker}
              </button>
            ) : (
              <span
                className="text-accent"
                onMouseEnter={(event) => hoverChart.openPreview(row.ticker, event.currentTarget)}
                onMouseLeave={() => hoverChart.closePreviewForTicker(row.ticker)}
                title={row.displayName ?? row.ticker}
              >
                {row.ticker}
              </span>
            )}
            <button
              type="button"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-borderSoft/60 bg-panelSoft/35 text-slate-400 opacity-75 transition hover:bg-panelSoft/55 hover:text-accent focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-accent/25"
              onClick={(event) => {
                event.stopPropagation();
                openExpandedChart(row.ticker);
              }}
              title={`Pin chart for ${row.ticker}`}
              aria-label={`Pin chart for ${row.ticker}`}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
            <QuoteFreshnessBadge row={row} />
            <HistoryFreshnessBadge row={row} />
          </div>
        </td>
      );
    }
    if (column === "name") {
      return <td key={`${row.ticker}-${column}`} className="max-w-64 truncate px-3 py-2 text-slate-300">{row.displayName ?? row.ticker}</td>;
    }
    if (column === "sparkline") {
      return (
        <td key={`${row.ticker}-${column}`} className="px-3 py-2">
          {hasHistoricalMetrics(row) && row.sparkline ? <Sparkline values={row.sparkline} /> : <span className="text-slate-500">N/A</span>}
        </td>
      );
    }
    if (column === "relativeStrength30dVsSpy") {
      return (
        <td key={`${row.ticker}-${column}`} className="px-3 py-2">
          {hasHistoricalMetrics(row) ? <HistogramSparkline values={row.relativeStrength30dVsSpy} /> : <span className="text-slate-500">N/A</span>}
        </td>
      );
    }
    if (column === "price") {
      return <td key={`${row.ticker}-${column}`} className="px-3 py-2">{hasCurrentField(row, "price") && typeof row.quotePrice === "number" ? row.quotePrice.toFixed(2) : "N/A"}</td>;
    }
    if (column === "20SMA") {
      return <td key={`${row.ticker}-${column}`} className="px-3 py-2 text-center"><SmaStatusIndicator value={hasCurrentField(row, "above20Sma") ? row.above20Sma : null} /></td>;
    }
    if (column === "50SMA") {
      return <td key={`${row.ticker}-${column}`} className="px-3 py-2 text-center"><SmaStatusIndicator value={hasCurrentField(row, "above50Sma") ? row.above50Sma : null} /></td>;
    }
    if (column === "200SMA") {
      return <td key={`${row.ticker}-${column}`} className="px-3 py-2 text-center"><SmaStatusIndicator value={hasCurrentField(row, "above200Sma") ? row.above200Sma : null} /></td>;
    }
    if (column === "1D") {
      return <td key={`${row.ticker}-${column}`} className={`px-3 py-2 ${hasCurrentField(row, "change1d") ? cellClass(row.quoteChange1d) : "text-slate-500"}`}>{hasCurrentField(row, "change1d") ? pct(row.quoteChange1d) : "N/A"}</td>;
    }
    if (column === "1W") {
      return <td key={`${row.ticker}-${column}`} className={`px-3 py-2 ${hasCurrentField(row, "change1w") ? cellClass(row.change1w) : "text-slate-500"}`}>{hasCurrentField(row, "change1w") ? pct(row.change1w) : "N/A"}</td>;
    }
    if (column === "5D") {
      return <td key={`${row.ticker}-${column}`} className={`px-3 py-2 ${hasCurrentField(row, "change5d") ? cellClass(row.change5d) : "text-slate-500"}`}>{hasCurrentField(row, "change5d") ? pct(row.change5d) : "N/A"}</td>;
    }
    if (column === "3M") {
      return <td key={`${row.ticker}-${column}`} className={`px-3 py-2 ${hasCurrentField(row, "change3m") ? cellClass(row.change3m) : "text-slate-500"}`}>{hasCurrentField(row, "change3m") ? pct(row.change3m) : "N/A"}</td>;
    }
    if (column === "6M") {
      return <td key={`${row.ticker}-${column}`} className={`px-3 py-2 ${hasCurrentField(row, "change6m") ? cellClass(row.change6m) : "text-slate-500"}`}>{hasCurrentField(row, "change6m") ? pct(row.change6m) : "N/A"}</td>;
    }
    if (column === "YTD") {
      return <td key={`${row.ticker}-${column}`} className={`px-3 py-2 ${hasCurrentField(row, "ytd") ? cellClass(row.ytd) : "text-slate-500"}`}>{hasCurrentField(row, "ytd") ? pct(row.ytd) : "N/A"}</td>;
    }
    if (column === "pctFrom52WHigh") {
      return <td key={`${row.ticker}-${column}`} className={`px-3 py-2 ${hasCurrentField(row, "pctFrom52wHigh") ? cellClass(row.pctFrom52wHigh) : "text-slate-500"}`}>{hasCurrentField(row, "pctFrom52wHigh") ? pct(row.pctFrom52wHigh) : "N/A"}</td>;
    }
    return null;
  };
  const sortedConstituents = useMemo(() => {
    const rowsCopy = [...constituents];
    if (constituentSort === "change1d") {
      rowsCopy.sort((a, b) => (b.change1d ?? 0) - (a.change1d ?? 0));
      return rowsCopy;
    }
    rowsCopy.sort((a, b) => (b.weight ?? Number.NEGATIVE_INFINITY) - (a.weight ?? Number.NEGATIVE_INFINITY));
    return rowsCopy;
  }, [constituents, constituentSort]);
  const pagedConstituents = useMemo(
    () => sortedConstituents.slice((constituentPage - 1) * CHARTS_PER_PAGE, constituentPage * CHARTS_PER_PAGE),
    [constituentPage, sortedConstituents],
  );

  const openEtfConstituents = async (ticker: string, name: string | null) => {
    hoverChart.clearPreview();
    setActiveEtf({ ticker, name });
    setConstituentLoading(true);
    setConstituentWarning(null);
    setConstituents([]);
    setConstituentSort("change1d");
    setConstituentPage(1);
    try {
      const res = await getEtfConstituents(ticker);
      setConstituents((res.rows ?? []).map((row) => ({
        ticker: String(row.ticker ?? "").toUpperCase(),
        name: typeof row.name === "string" ? row.name : null,
        weight: typeof row.weight === "number" ? row.weight : null,
        change1d: typeof row.change1d === "number" ? row.change1d : undefined,
        lastPrice: typeof row.lastPrice === "number" ? row.lastPrice : undefined,
      })));
      setConstituentWarning(res.warning ?? null);
    } catch (error) {
      setConstituentWarning(error instanceof Error ? error.message : "Failed to load ETF constituents.");
    } finally {
      setConstituentLoading(false);
    }
  };

  useEffect(() => {
    if (!activeEtf && !activeChartTicker) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (activeChartTicker) {
        closeExpandedChart();
        return;
      }
      hoverChart.clearPreview();
      setActiveEtf(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeChartTicker, activeEtf, hoverChart]);

  useEffect(() => {
    setConstituentPage(1);
  }, [activeEtf?.ticker, constituentSort, sortedConstituents.length]);

  return (
    <>
      <Collapsible.Root
        id={anchorId}
        defaultOpen={defaultOpen}
        className={`card overflow-hidden shadow-[0_6px_30px_rgba(15,23,42,0.3)] ${anchorId ? "scroll-mt-28 md:scroll-mt-32" : ""}`}
      >
        <Collapsible.Trigger className="flex w-full items-center justify-between border-b border-borderSoft px-4 py-3 text-left">
          <span className="font-medium tracking-wide">{title}</span>
          <ChevronDown className="h-4 w-4" />
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/60">
                <tr>
                  {columns.map((c) => (
                    <th key={c} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">
                      <button className="inline-flex items-center gap-1 text-left hover:text-slate-100" onClick={() => onSort(c)}>
                        {titleCase(c)}
                        <span className="text-[10px] text-slate-400">{sortGlyph(c)}</span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {selected.map((row) => (
                  <tr
                    key={row.ticker}
                    className="border-t border-borderSoft/80 transition-colors hover:bg-slate-900/30"
                  >
                    {columns.map((column) => renderCell(row, column))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
      {activeEtf && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4" onClick={() => setActiveEtf(null)}>
          <div className="flex h-[calc(100vh-2rem)] w-[80vw] max-w-[80vw] flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between rounded border border-borderSoft bg-panel px-3 py-2">
              <h4 className="text-sm font-semibold text-slate-100">
                {activeEtf.ticker} Constituents {activeEtf.name ? `- ${activeEtf.name}` : ""}
              </h4>
              <button className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-200" onClick={() => setActiveEtf(null)}>
                Close
              </button>
            </div>
            <div className="mb-2 flex items-center gap-2 rounded border border-slate-300/70 bg-slate-100/95 px-3 py-2 text-xs text-slate-700 dark:border-borderSoft/70 dark:bg-panelSoft/30 dark:text-slate-200">
              <span className="text-slate-700 dark:text-slate-400">Sort constituents by:</span>
              <button
                className={`rounded px-2 py-1 ${constituentSort === "weight" ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                onClick={() => setConstituentSort("weight")}
              >
                Weight %
              </button>
              <button
                className={`rounded px-2 py-1 ${constituentSort === "change1d" ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                onClick={() => setConstituentSort("change1d")}
              >
                1D %
              </button>
              <span className="ml-auto rounded bg-white/90 px-2 py-1 text-slate-700 shadow-sm dark:bg-slate-800/80 dark:text-slate-200 dark:shadow-none">
                {sortedConstituents.length} ticker{sortedConstituents.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="overflow-y-auto pr-1">
              {constituentWarning && (
                <div className="mb-2 rounded border border-yellow-700/50 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-200">
                  Constituent sync warning: {constituentWarning}
                </div>
              )}
              <ChartGridPager
                totalItems={sortedConstituents.length}
                page={constituentPage}
                pageSize={CHARTS_PER_PAGE}
                itemLabel="tickers"
                onPageChange={setConstituentPage}
              />
              {constituentLoading ? (
                <div className="card flex items-center gap-2 p-4 text-sm text-slate-300">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading constituents...
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {pagedConstituents.map((row) => (
                    <div key={`${activeEtf.ticker}-${row.ticker}`} className="card p-2">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="font-semibold text-accent">{row.ticker}</span>
                        <span className="text-xs text-slate-400">{row.weight != null ? `${row.weight.toFixed(2)}%` : "-"}</span>
                      </div>
                      <div className="mb-1 text-xs">
                        <span className={cellClass(row.change1d ?? 0)}>{pct(row.change1d ?? 0)}</span>
                        <span className="ml-2 text-slate-400">{(row.lastPrice ?? 0).toFixed(2)}</span>
                      </div>
                      <p className="mb-2 line-clamp-2 text-xs text-slate-400">{row.name ?? row.ticker}</p>
                      <TradingViewWidget
                        ticker={row.ticker}
                        size="small"
                        chartOnly
                        showStatusLine
                        fillContainer
                        initialRange="3M"
                        className="!border-0 !bg-transparent !shadow-none !p-0"
                      />
                      <button
                        className="mt-2 inline-flex items-center gap-1 rounded border border-borderSoft px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800/60"
                        onClick={() => openExpandedChart(row.ticker)}
                      >
                        <Maximize2 className="h-3.5 w-3.5" />
                        Expand chart
                      </button>
                    </div>
                  ))}
                  {constituents.length === 0 && (
                    <div className="card p-4 text-sm text-slate-300">No constituents available for this ETF.</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <HoverChartPreviewPanel
        preview={hoverChart.preview}
        onPreviewMouseEnter={hoverChart.handlePreviewMouseEnter}
        onPreviewMouseLeave={hoverChart.handlePreviewMouseLeave}
        onPinChart={openExpandedChart}
      />
      <ExpandedTradingViewChartModal ticker={activeChartTicker} onClose={closeExpandedChart} />
    </>
  );
}
