"use client";

import { Fragment, useMemo, useState } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown, ChartNoAxesCombined } from "lucide-react";
import { Sparkline } from "./sparkline";
import { TradingViewWidget } from "./tradingview-widget";

type Row = {
  ticker: string;
  displayName: string | null;
  price: number;
  change1d: number;
  change1w: number;
  change5d: number;
  ytd: number;
  pctFrom52wHigh: number;
  sparkline: number[];
  holdings: string[] | null;
};

type Props = {
  title: string;
  rows: Row[];
  columns: string[];
  defaultOpen?: boolean;
  pinTop10?: boolean;
};

const cellClass = (n: number) => (n >= 0 ? "text-pos" : "text-neg");
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const titleCase = (value: string): string => {
  if (value === "1D" || value === "5D" || value === "1W" || value === "YTD") return value;
  if (value === "pctFrom52WHigh") return "% From 52W High";
  return value.charAt(0).toUpperCase() + value.slice(1);
};

export function GroupPanel({ title, rows, columns, defaultOpen = true, pinTop10 = false }: Props) {
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);
  const selected = pinTop10 ? rows.slice(0, 10) : rows;
  const columnCount = useMemo(() => columns.length + 1, [columns.length]);
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className="card overflow-hidden shadow-[0_6px_30px_rgba(15,23,42,0.3)]">
      <Collapsible.Trigger className="flex w-full items-center justify-between border-b border-borderSoft px-4 py-3 text-left">
        <span className="font-medium tracking-wide">{title}</span>
        <ChevronDown className="h-4 w-4" />
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/70">
              <tr>
                {columns.map((c) => (
                  <th key={c} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">
                    {titleCase(c)}
                  </th>
                ))}
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">
                  Chart
                </th>
              </tr>
            </thead>
            <tbody>
              {selected.map((row) => {
                const isOpen = expandedTicker === row.ticker;
                return (
                  <Fragment key={row.ticker}>
                    <tr className="border-t border-borderSoft/80 transition-colors hover:bg-slate-900/30">
                      {columns.includes("ticker") && (
                        <td className="px-3 py-2 font-semibold text-accent">{row.ticker}</td>
                      )}
                      {columns.includes("name") && (
                        <td className="max-w-64 truncate px-3 py-2 text-slate-300">{row.displayName ?? row.ticker}</td>
                      )}
                      {columns.includes("price") && <td className="px-3 py-2">{row.price.toFixed(2)}</td>}
                      {columns.includes("1D") && <td className={`px-3 py-2 ${cellClass(row.change1d)}`}>{pct(row.change1d)}</td>}
                      {columns.includes("1W") && <td className={`px-3 py-2 ${cellClass(row.change1w)}`}>{pct(row.change1w)}</td>}
                      {columns.includes("5D") && <td className={`px-3 py-2 ${cellClass(row.change5d)}`}>{pct(row.change5d)}</td>}
                      {columns.includes("YTD") && <td className={`px-3 py-2 ${cellClass(row.ytd)}`}>{pct(row.ytd)}</td>}
                      {columns.includes("pctFrom52WHigh") && (
                        <td className={`px-3 py-2 ${cellClass(row.pctFrom52wHigh)}`}>{pct(row.pctFrom52wHigh)}</td>
                      )}
                      {columns.includes("sparkline") && (
                        <td className="px-3 py-2">
                          <Sparkline values={row.sparkline} />
                        </td>
                      )}
                      <td className="px-3 py-2">
                        <button
                          onClick={() => setExpandedTicker(isOpen ? null : row.ticker)}
                          className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs ${isOpen ? "border-accent/60 bg-accent/10 text-accent" : "border-borderSoft text-slate-300"}`}
                        >
                          <ChartNoAxesCombined className="h-3.5 w-3.5" />
                          {isOpen ? "Hide" : "Show"}
                        </button>
                      </td>
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
  );
}
