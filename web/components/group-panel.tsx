"use client";

import Link from "next/link";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown } from "lucide-react";
import { Sparkline } from "./sparkline";

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

export function GroupPanel({ title, rows, columns, defaultOpen = true, pinTop10 = false }: Props) {
  const selected = pinTop10 ? rows.slice(0, 10) : rows;
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className="card overflow-hidden">
      <Collapsible.Trigger className="flex w-full items-center justify-between border-b border-borderSoft px-4 py-3 text-left">
        <span className="font-medium">{title}</span>
        <ChevronDown className="h-4 w-4" />
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-panelSoft">
              <tr>
                {columns.map((c) => (
                  <th key={c} className="px-3 py-2 text-left font-medium text-slate-300">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {selected.map((row) => (
                <tr key={row.ticker} className="border-t border-borderSoft">
                  {columns.includes("ticker") && (
                    <td className="px-3 py-2">
                      <Link href={`/ticker/${row.ticker}`} className="font-semibold text-accent">
                        {row.ticker}
                      </Link>
                      <div className="text-xs text-slate-400">{row.displayName ?? ""}</div>
                    </td>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
