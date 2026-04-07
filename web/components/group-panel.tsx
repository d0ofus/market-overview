"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown, Loader2, Maximize2, X } from "lucide-react";
import { HistogramSparkline } from "./histogram-sparkline";
import { Sparkline } from "./sparkline";
import { ChartGridPager } from "./chart-grid-pager";
import { TradingViewWidget } from "./tradingview-widget";
import { getEtfConstituents } from "@/lib/api";

const CHARTS_PER_PAGE = 20;

type Row = {
  ticker: string;
  displayName: string | null;
  price: number;
  change1d: number;
  change1w: number;
  change5d: number;
  change3m: number;
  change6m: number;
  ytd: number;
  pctFrom52wHigh: number;
  sparkline: number[];
  relativeStrength30dVsSpy: number[] | null;
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

const cellClass = (n: number) => (n >= 0 ? "text-pos" : "text-neg");
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const titleCase = (value: string): string => {
  if (value === "1D" || value === "5D" || value === "1W" || value === "3M" || value === "6M" || value === "YTD") return value;
  if (value === "pctFrom52WHigh") return "% From 52W High";
  if (value === "relativeStrength30dVsSpy") return "RS 30d vs SPY";
  return value.charAt(0).toUpperCase() + value.slice(1);
};

export function GroupPanel({ title, rows, columns, defaultOpen = true, pinTop10 = false, anchorId }: Props) {
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);
  const [activeEtf, setActiveEtf] = useState<{ ticker: string; name: string | null } | null>(null);
  const [constituentLoading, setConstituentLoading] = useState(false);
  const [constituentWarning, setConstituentWarning] = useState<string | null>(null);
  const [constituents, setConstituents] = useState<Array<{ ticker: string; name: string | null; weight: number | null; change1d?: number; lastPrice?: number }>>([]);
  const [constituentSort, setConstituentSort] = useState<"weight" | "change1d">("change1d");
  const [activeChartTicker, setActiveChartTicker] = useState<string | null>(null);
  const [constituentPage, setConstituentPage] = useState(1);
  const showsEtfConstituents = title === "Sector ETFs" || title.startsWith("Industry/Thematic ETFs");
  const defaultSortKey = columns.includes("1D")
    ? "1D"
    : columns.includes("ticker")
      ? "ticker"
      : columns[0] ?? "ticker";
  const [sortKey, setSortKey] = useState<string>(defaultSortKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(defaultSortKey === "1D" ? "desc" : "asc");
  const sortedRows = useMemo(() => {
    const copy = [...rows];
    const stringValueFor = (row: Row, key: string): string | null => {
      if (key === "ticker") return row.ticker ?? "";
      if (key === "name") return (row.displayName ?? row.ticker ?? "").toUpperCase();
      return null;
    };
    const numberValueFor = (row: Row, key: string): number | null => {
      if (key === "price") return row.price ?? null;
      if (key === "1D") return row.change1d ?? null;
      if (key === "1W") return row.change1w ?? null;
      if (key === "5D") return row.change5d ?? null;
      if (key === "3M") return row.change3m ?? null;
      if (key === "6M") return row.change6m ?? null;
      if (key === "YTD") return row.ytd ?? null;
      if (key === "pctFrom52WHigh") return row.pctFrom52wHigh ?? null;
      if (key === "sparkline") return row.sparkline?.[row.sparkline.length - 1] ?? null;
      if (key === "relativeStrength30dVsSpy") return row.relativeStrength30dVsSpy?.[row.relativeStrength30dVsSpy.length - 1] ?? null;
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
  const columnCount = columns.length;
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
    setSortDir(col === "1D" ? "desc" : "asc");
  };
  const toggleExpandedTicker = (ticker: string) => {
    setExpandedTicker((current) => (current === ticker ? null : ticker));
  };
  const renderCell = (row: Row, column: string) => {
    if (column === "ticker") {
      return (
        <td key={`${row.ticker}-${column}`} className="px-3 py-2 font-semibold text-accent">
          {showsEtfConstituents ? (
            <button
              className="text-left hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                void openEtfConstituents(row.ticker, row.displayName);
              }}
            >
              {row.ticker}
            </button>
          ) : (
            row.ticker
          )}
        </td>
      );
    }
    if (column === "name") {
      return <td key={`${row.ticker}-${column}`} className="max-w-64 truncate px-3 py-2 text-slate-300">{row.displayName ?? row.ticker}</td>;
    }
    if (column === "sparkline") {
      return (
        <td key={`${row.ticker}-${column}`} className="px-3 py-2">
          <Sparkline values={row.sparkline} />
        </td>
      );
    }
    if (column === "relativeStrength30dVsSpy") {
      return (
        <td key={`${row.ticker}-${column}`} className="px-3 py-2">
          <HistogramSparkline values={row.relativeStrength30dVsSpy} />
        </td>
      );
    }
    if (column === "price") {
      return <td key={`${row.ticker}-${column}`} className="px-3 py-2">{row.price.toFixed(2)}</td>;
    }
    if (column === "1D") {
      return <td key={`${row.ticker}-${column}`} className={`px-3 py-2 ${cellClass(row.change1d)}`}>{pct(row.change1d)}</td>;
    }
    if (column === "1W") {
      return <td key={`${row.ticker}-${column}`} className={`px-3 py-2 ${cellClass(row.change1w)}`}>{pct(row.change1w)}</td>;
    }
    if (column === "5D") {
      return <td key={`${row.ticker}-${column}`} className={`px-3 py-2 ${cellClass(row.change5d)}`}>{pct(row.change5d)}</td>;
    }
    if (column === "3M") {
      return <td key={`${row.ticker}-${column}`} className={`px-3 py-2 ${cellClass(row.change3m)}`}>{pct(row.change3m)}</td>;
    }
    if (column === "6M") {
      return <td key={`${row.ticker}-${column}`} className={`px-3 py-2 ${cellClass(row.change6m)}`}>{pct(row.change6m)}</td>;
    }
    if (column === "YTD") {
      return <td key={`${row.ticker}-${column}`} className={`px-3 py-2 ${cellClass(row.ytd)}`}>{pct(row.ytd)}</td>;
    }
    if (column === "pctFrom52WHigh") {
      return <td key={`${row.ticker}-${column}`} className={`px-3 py-2 ${cellClass(row.pctFrom52wHigh)}`}>{pct(row.pctFrom52wHigh)}</td>;
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
        setActiveChartTicker(null);
        return;
      }
      setActiveEtf(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeChartTicker, activeEtf]);

  useEffect(() => {
    setConstituentPage(1);
  }, [activeEtf?.ticker, constituentSort, sortedConstituents.length]);

  return (
    <>
      <Collapsible.Root id={anchorId} defaultOpen={defaultOpen} className="card overflow-hidden shadow-[0_6px_30px_rgba(15,23,42,0.3)]">
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
                {selected.map((row) => {
                  const isOpen = expandedTicker === row.ticker;
                  return (
                    <Fragment key={row.ticker}>
                      <tr
                        className="cursor-pointer border-t border-borderSoft/80 transition-colors hover:bg-slate-900/30"
                        onClick={() => toggleExpandedTicker(row.ticker)}
                      >
                        {columns.map((column) => renderCell(row, column))}
                      </tr>
                      {isOpen && (
                        <tr className="border-t border-borderSoft/60 bg-slate-950/40">
                          <td colSpan={columnCount} className="px-3 py-3">
                            <TradingViewWidget ticker={row.ticker} compact />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
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
                        onClick={() => setActiveChartTicker(row.ticker)}
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
      {activeChartTicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4" onClick={() => setActiveChartTicker(null)}>
          <div className="w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between rounded border border-borderSoft bg-panel px-3 py-2">
              <h4 className="text-sm font-semibold text-slate-100">TradingView: {activeChartTicker}</h4>
              <button className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-200" onClick={() => setActiveChartTicker(null)}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <TradingViewWidget ticker={activeChartTicker} chartOnly showStatusLine fillContainer initialRange="3M" />
          </div>
        </div>
      )}
    </>
  );
}
