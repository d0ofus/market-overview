"use client";

import { useMemo, useState } from "react";
import type { BarFreshnessStatus, OverviewSeriesStatus, QuoteFreshnessStatus, SnapshotReadyResponse } from "@/types/dashboard";

type SnapshotSection = SnapshotReadyResponse["sections"][number];
type AuditFilter = "problem" | "history" | QuoteFreshnessStatus;

type AuditRow = {
  ticker: string;
  name: string | null;
  groupTitle: string;
  quoteStatus: QuoteFreshnessStatus;
  barStatus: BarFreshnessStatus;
  seriesStatus: OverviewSeriesStatus;
  seriesThroughDate: string | null;
  barDate: string | null;
  source: string | null;
  providerStatusSummary: string;
  missingCurrentFields: string[];
  needsReview: boolean;
  quoteReason: string | null;
  barReason: string | null;
};

const OPTIONAL_CURRENT_FIELDS = [
  "change1w",
  "change5d",
  "change3m",
  "change6m",
  "ytd",
  "pctFrom52wHigh",
  "above20Sma",
  "above50Sma",
  "above200Sma",
] as const;
const ESSENTIAL_CURRENT_FIELDS = ["price", "change1d"] as const;

const FILTERS: Array<{ key: AuditFilter; label: string }> = [
  { key: "problem", label: "Needs Review" },
  { key: "history", label: "Chart History" },
  { key: "stale", label: "Stale" },
  { key: "unavailable", label: "Unavailable" },
  { key: "unsupported", label: "Unsupported" },
  { key: "fresh", label: "Fresh" },
];

function statusLabel(status: QuoteFreshnessStatus | OverviewSeriesStatus): string {
  if (status === "fresh") return "Fresh";
  if (status === "fallback") return "Fallback";
  if (status === "stale") return "Stale";
  if (status === "unavailable") return "Unavailable";
  return "Unsupported";
}

function statusClass(status: QuoteFreshnessStatus | OverviewSeriesStatus): string {
  if (status === "fresh") return "border-emerald-400/25 bg-emerald-500/10 text-emerald-200";
  if (status === "fallback") return "border-sky-400/30 bg-sky-500/10 text-sky-200";
  if (status === "stale") return "border-amber-400/35 bg-amber-500/10 text-amber-200";
  if (status === "unavailable") return "border-red-400/35 bg-red-500/10 text-red-200";
  return "border-slate-500/45 bg-slate-700/40 text-slate-300";
}

function includesFilter(row: AuditRow, filter: AuditFilter): boolean {
  if (filter === "problem") return row.needsReview;
  if (filter === "history") return row.seriesStatus !== "fresh";
  if (filter === "fresh") return !row.needsReview;
  return row.quoteStatus === filter;
}

export function QuoteFreshnessAudit({
  sections,
  embedded = false,
  anchorId = "overview-quote-audit",
}: {
  sections: SnapshotSection[];
  embedded?: boolean;
  anchorId?: string;
}) {
  const [filter, setFilter] = useState<AuditFilter>("problem");
  const rows = useMemo<AuditRow[]>(() => {
    return sections.flatMap((section) =>
      section.groups.flatMap((group) =>
        group.rows.map((row) => {
          const missingEssentialFields = row.currentData
            ? ESSENTIAL_CURRENT_FIELDS.filter((field) => !row.currentData?.fieldSources[field])
            : [];
          const missingOptionalFields = row.currentData
            ? OPTIONAL_CURRENT_FIELDS.filter((field) => !row.currentData?.fieldSources[field])
            : [];
          const quoteStatus = row.quoteFreshnessStatus ?? "unavailable";
          const unsupported = quoteStatus === "unsupported";
          const seriesStatus = row.historyData?.seriesStatus
            ?? (((row.sparkline?.length ?? 0) > 1 || (row.relativeStrength30dVsSpy?.length ?? 0) > 1)
              ? "fallback"
              : row.barFreshnessStatus ?? "unavailable");
          return {
            ticker: row.ticker,
            name: row.displayName,
            groupTitle: group.title,
            quoteStatus,
            barStatus: row.barFreshnessStatus ?? (row.barDate ? "fresh" : "unavailable"),
            seriesStatus,
            seriesThroughDate: row.historyData?.seriesThroughDate ?? null,
            barDate: row.barDate ?? null,
            source: Array.from(new Set([
              row.currentData?.quoteSource,
              row.currentData?.performanceSource,
              row.currentData?.smaSource,
            ].filter((value): value is string => Boolean(value)))).join(", ") || row.quoteSource || null,
            providerStatusSummary: Object.entries(row.currentData?.providerStatuses ?? {})
              .map(([provider, diagnostic]) => `${provider}: ${diagnostic.status}`)
              .join(", ") || "unavailable",
            missingCurrentFields: [...missingEssentialFields, ...missingOptionalFields],
            needsReview: (!unsupported && (quoteStatus === "stale" || quoteStatus === "unavailable"))
              || row.currentData?.status === "retrying"
              || missingEssentialFields.length > 0
              || (!unsupported && seriesStatus === "unavailable"),
            quoteReason: [
              row.currentData?.reason ?? row.quoteFreshnessReason,
              missingEssentialFields.length > 0 ? `Missing essential fields: ${missingEssentialFields.join(", ")}.` : null,
              missingOptionalFields.length > 0 ? `Optional fields unavailable: ${missingOptionalFields.join(", ")}.` : null,
              ...Object.entries(row.currentData?.providerStatuses ?? {}).map(
                ([provider, diagnostic]) => `${provider}: ${diagnostic.status} - ${diagnostic.reason}`,
              ),
            ].filter(Boolean).join(" ") || null,
            barReason: row.historyData?.seriesReason ?? row.barFreshnessReason ?? null,
          };
        }),
      ),
    ).sort((left, right) => {
      const statusOrder: Record<QuoteFreshnessStatus, number> = {
        unavailable: 0,
        stale: 1,
        unsupported: 2,
        fresh: 3,
      };
      const statusCompare = statusOrder[left.quoteStatus] - statusOrder[right.quoteStatus];
      if (statusCompare !== 0) return statusCompare;
      const barCompare = statusOrder[left.barStatus] - statusOrder[right.barStatus];
      if (barCompare !== 0) return barCompare;
      const groupCompare = left.groupTitle.localeCompare(right.groupTitle);
      if (groupCompare !== 0) return groupCompare;
      return left.ticker.localeCompare(right.ticker);
    });
  }, [sections]);

  const counts = useMemo(() => {
    const initial: Record<QuoteFreshnessStatus, number> = { fresh: 0, stale: 0, unavailable: 0, unsupported: 0 };
    for (const row of rows) initial[row.quoteStatus] += 1;
    return initial;
  }, [rows]);
  const historyProblemCount = rows.filter((row) => row.seriesStatus === "unavailable").length;
  const historyInfoCount = rows.filter((row) => row.seriesStatus !== "fresh").length;
  const visibleRows = rows.filter((row) => includesFilter(row, filter));
  const problemCount = rows.filter((row) => row.needsReview).length;

  return (
    <section id={anchorId} className={`${embedded ? "" : "card scroll-mt-28 md:scroll-mt-32"} overflow-hidden`}>
      <div className="flex flex-col gap-3 border-b border-borderSoft px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="font-medium tracking-wide text-slate-100">Market Data Freshness Audit</h3>
          <p className="mt-1 text-xs text-slate-400">{problemCount} actionable rows / {historyProblemCount} chart series unavailable / {counts.unsupported} unsupported / {rows.length} tracked rows</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((item) => {
            const count = item.key === "problem"
              ? problemCount
              : item.key === "history"
                ? historyInfoCount
                : item.key === "fresh"
                  ? rows.length - problemCount
                  : counts[item.key];
            const active = filter === item.key;
            return (
              <button
                key={item.key}
                type="button"
                className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition ${
                  active
                    ? "border-accent/45 bg-accent/14 text-accent"
                    : "border-borderSoft/70 bg-panelSoft/30 text-slate-300 hover:bg-panelSoft/50"
                }`}
                onClick={() => setFilter(item.key)}
              >
                {item.label} {count}
              </button>
            );
          })}
        </div>
      </div>
      <div className="max-h-[28rem] overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-slate-900/95">
            <tr>
              {["Ticker", "Current Data", "History", "Last Bar", "Group", "Source", "Provider Status"].map((heading) => (
                <th key={heading} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={`${row.groupTitle}-${row.ticker}`} className="border-t border-borderSoft/80">
                <td className="px-3 py-2">
                  <div className="font-semibold text-accent">{row.ticker}</div>
                  <div className="max-w-72 truncate text-xs text-slate-400">{row.name ?? row.ticker}</div>
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${statusClass(row.quoteStatus)}`} title={row.quoteReason ?? statusLabel(row.quoteStatus)}>
                    {statusLabel(row.quoteStatus)}
                  </span>
                  {row.missingCurrentFields.length > 0 ? (
                    <div className="mt-1 text-[10px] text-slate-500">{row.missingCurrentFields.length} fields N/A</div>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${statusClass(row.seriesStatus)}`} title={row.barReason ?? statusLabel(row.seriesStatus)}>
                    {statusLabel(row.seriesStatus)}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-slate-300">{row.barDate ?? row.seriesThroughDate ?? "N/A"}</td>
                <td className="px-3 py-2 text-slate-300">{row.groupTitle}</td>
                <td className="px-3 py-2 text-slate-400">{row.source ?? "N/A"}</td>
                <td className="max-w-80 px-3 py-2 text-xs text-slate-400">{row.providerStatusSummary}</td>
              </tr>
            ))}
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-slate-400">
                  No rows match this filter.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
