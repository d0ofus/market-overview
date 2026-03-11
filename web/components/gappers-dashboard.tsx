"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { getGappers, type GapperRow, type GappersSnapshot } from "@/lib/api";
import { TradingViewWidget } from "./tradingview-widget";

type SortKey =
  | "ticker"
  | "name"
  | "sector"
  | "industry"
  | "marketCap"
  | "price"
  | "prevClose"
  | "premarketPrice"
  | "gapPct"
  | "premarketVolume"
  | "newsCount"
  | "compositeScore";

const POLL_MS = 45_000;

function fmtNumber(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function fmtPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function fmtCompact(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

const cellClass = (n: number) => (n >= 0 ? "text-pos" : "text-neg");

export function GappersDashboard() {
  const [snapshot, setSnapshot] = useState<GappersSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("gapPct");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const next = await getGappers(25, false);
        if (cancelled) return;
        setSnapshot(next);
        setError(null);
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load gappers.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load();
    };

    void load();
    const interval = window.setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const rows = snapshot?.rows ?? [];
  const sortedRows = useMemo(() => {
    const copy = [...rows];
    const valueFor = (row: GapperRow, key: SortKey): number | string => {
      if (key === "ticker") return row.ticker;
      if (key === "name") return row.name ?? row.ticker;
      if (key === "sector") return row.sector ?? "";
      if (key === "industry") return row.industry ?? "";
      if (key === "marketCap") return row.marketCap ?? Number.NEGATIVE_INFINITY;
      if (key === "price") return row.price ?? Number.NEGATIVE_INFINITY;
      if (key === "prevClose") return row.prevClose ?? Number.NEGATIVE_INFINITY;
      if (key === "premarketPrice") return row.premarketPrice ?? Number.NEGATIVE_INFINITY;
      if (key === "gapPct") return row.gapPct ?? Number.NEGATIVE_INFINITY;
      if (key === "premarketVolume") return row.premarketVolume ?? Number.NEGATIVE_INFINITY;
      if (key === "newsCount") return row.news.length;
      return row.compositeScore ?? Number.NEGATIVE_INFINITY;
    };
    copy.sort((a, b) => {
      const av = valueFor(a, sortKey);
      const bv = valueFor(b, sortKey);
      if (typeof av === "string" || typeof bv === "string") {
        const cmp = String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      }
      const cmp = av - bv;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortDir, sortKey]);

  const onSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "ticker" || key === "name" || key === "sector" || key === "industry" ? "asc" : "desc");
  };

  if (loading && !snapshot) {
    return (
      <div className="card flex items-center gap-2 p-4 text-sm text-slate-300">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading gappers...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card p-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-xl bg-slate-800/70 px-2 py-1">
            Last updated: <b>{fmtDateTime(snapshot?.generatedAt)}</b>
          </span>
          <span className="rounded-xl bg-slate-800/50 px-2 py-1 text-slate-300">Session: {snapshot?.marketSession ?? "premarket"}</span>
          <span className="rounded-xl bg-slate-800/50 px-2 py-1 text-slate-300">Tracked: {snapshot?.rowCount ?? 0}</span>
          <span className="rounded-xl bg-accent/15 px-2 py-1 text-accent">Source: {snapshot?.providerLabel ?? "-"}</span>
          <span className={`rounded-xl px-2 py-1 ${snapshot?.status === "error" ? "bg-red-500/15 text-red-300" : "bg-slate-800/50 text-slate-300"}`}>
            Status: {snapshot?.status ?? "-"}
          </span>
        </div>
        {snapshot?.warning && <p className="mt-2 text-xs text-yellow-200">{snapshot.warning}</p>}
        {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
      </div>

      <div className="card overflow-hidden shadow-[0_6px_30px_rgba(15,23,42,0.3)]">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/60">
              <tr>
                {[
                  ["ticker", "Ticker"],
                  ["name", "Company"],
                  ["sector", "Sector"],
                  ["industry", "Industry"],
                  ["marketCap", "Market Cap"],
                  ["price", "Price"],
                  ["prevClose", "Prev Close"],
                  ["premarketPrice", "Pre Price"],
                  ["gapPct", "Gap %"],
                  ["premarketVolume", "Pre Vol"],
                  ["newsCount", "News"],
                  ["compositeScore", "Score"],
                ].map(([key, label]) => (
                  <th key={key} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">
                    <button className="inline-flex items-center gap-1 text-left hover:text-slate-100" onClick={() => onSort(key as SortKey)}>
                      {label}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const isOpen = expandedTicker === row.ticker;
                return (
                  <Fragment key={row.ticker}>
                    <tr
                      className="cursor-pointer border-t border-borderSoft/80 transition-colors hover:bg-slate-900/30"
                      onClick={() => setExpandedTicker((current) => (current === row.ticker ? null : row.ticker))}
                    >
                      <td className="px-3 py-2 font-semibold text-accent">{row.ticker}</td>
                      <td className="max-w-48 truncate px-3 py-2 text-slate-300">{row.name ?? row.ticker}</td>
                      <td className="px-3 py-2 text-slate-300">{row.sector ?? "-"}</td>
                      <td className="px-3 py-2 text-slate-300">{row.industry ?? "-"}</td>
                      <td className="px-3 py-2 text-slate-300">{fmtCompact(row.marketCap)}</td>
                      <td className="px-3 py-2 text-slate-300">{fmtNumber(row.price)}</td>
                      <td className="px-3 py-2 text-slate-300">{fmtNumber(row.prevClose)}</td>
                      <td className="px-3 py-2 text-slate-300">{fmtNumber(row.premarketPrice)}</td>
                      <td className={`px-3 py-2 ${cellClass(row.gapPct)}`}>{fmtPct(row.gapPct)}</td>
                      <td className="px-3 py-2 text-slate-300">{fmtCompact(row.premarketVolume)}</td>
                      <td className="px-3 py-2 text-slate-300">{row.news.length}</td>
                      <td className="px-3 py-2 text-slate-300">{fmtNumber(row.compositeScore, 0)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="border-t border-borderSoft/60 bg-slate-950/40">
                        <td colSpan={12} className="px-3 py-3">
                          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr),minmax(24rem,1fr)]">
                            <div className="space-y-3">
                              <div className="rounded border border-borderSoft/60 bg-panelSoft/20 p-3">
                                <h4 className="mb-2 text-sm font-semibold text-slate-100">Latest News</h4>
                                <div className="space-y-2">
                                  {row.news.map((item, idx) => (
                                    <article key={`${row.ticker}-${idx}`} className="rounded border border-borderSoft/50 bg-panelSoft/25 p-2">
                                      <a href={item.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-accent hover:underline">
                                        {item.headline}
                                      </a>
                                      <div className="mt-1 text-[11px] text-slate-400">
                                        {item.source} {item.publishedAt ? `• ${fmtDateTime(item.publishedAt)}` : ""}
                                      </div>
                                      <div className="mt-1 text-xs text-slate-300">{item.snippet ?? "No summary available."}</div>
                                    </article>
                                  ))}
                                  {row.news.length === 0 && <p className="text-xs text-slate-400">No ranked news items were found for this ticker.</p>}
                                </div>
                              </div>
                              <div className="rounded border border-borderSoft/60 bg-panelSoft/20 p-3">
                                <h4 className="mb-2 text-sm font-semibold text-slate-100">Analysis</h4>
                                {row.analysis ? (
                                  <div className="space-y-2 text-sm">
                                    <p className="text-slate-200">{row.analysis.summary}</p>
                                    <div className="flex flex-wrap gap-2 text-xs">
                                      <span className="rounded bg-slate-800 px-2 py-1 text-slate-300">Freshness: {row.analysis.freshnessLabel} ({fmtNumber(row.analysis.freshnessScore, 0)})</span>
                                      <span className="rounded bg-slate-800 px-2 py-1 text-slate-300">Impact: {row.analysis.impactLabel} ({fmtNumber(row.analysis.impactScore, 0)})</span>
                                      <span className="rounded bg-slate-800 px-2 py-1 text-slate-300">Liquidity risk: {row.analysis.liquidityRiskLabel} ({fmtNumber(row.analysis.liquidityRiskScore, 0)})</span>
                                      <span className="rounded bg-accent/15 px-2 py-1 text-accent">Composite: {fmtNumber(row.analysis.compositeScore, 0)}</span>
                                    </div>
                                    <ul className="list-disc pl-4 text-xs text-slate-300">
                                      {row.analysis.reasoningBullets.map((item, idx) => (
                                        <li key={`${row.ticker}-reason-${idx}`}>{item}</li>
                                      ))}
                                    </ul>
                                  </div>
                                ) : (
                                  <p className="text-xs text-slate-400">No analysis available.</p>
                                )}
                              </div>
                            </div>
                            <div className="rounded border border-borderSoft/60 bg-panelSoft/20 p-3">
                              <h4 className="mb-2 text-sm font-semibold text-slate-100">Chart</h4>
                              <TradingViewWidget ticker={row.ticker} compact chartOnly showStatusLine initialRange="3M" />
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {sortedRows.length === 0 && (
                <tr>
                  <td colSpan={12} className="px-3 py-6 text-center text-sm text-slate-400">
                    No valid premarket gappers are available right now.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
