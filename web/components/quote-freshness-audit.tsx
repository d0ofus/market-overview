"use client";

import { useMemo, useState } from "react";
import type { QuoteFreshnessStatus, SnapshotReadyResponse } from "@/types/dashboard";

type SnapshotSection = SnapshotReadyResponse["sections"][number];
type AuditFilter = "problem" | QuoteFreshnessStatus;

type AuditRow = {
  ticker: string;
  name: string | null;
  groupTitle: string;
  status: QuoteFreshnessStatus;
  barDate: string | null;
  source: string | null;
  reason: string | null;
};

const FILTERS: Array<{ key: AuditFilter; label: string }> = [
  { key: "problem", label: "Needs Review" },
  { key: "stale", label: "Stale" },
  { key: "unavailable", label: "Unavailable" },
  { key: "unsupported", label: "Unverified" },
  { key: "fresh", label: "Fresh" },
];

function statusLabel(status: QuoteFreshnessStatus): string {
  if (status === "fresh") return "Fresh";
  if (status === "stale") return "Stale";
  if (status === "unavailable") return "Unavailable";
  return "Unverified";
}

function statusClass(status: QuoteFreshnessStatus): string {
  if (status === "fresh") return "border-emerald-400/25 bg-emerald-500/10 text-emerald-200";
  if (status === "stale") return "border-amber-400/35 bg-amber-500/10 text-amber-200";
  if (status === "unavailable") return "border-red-400/35 bg-red-500/10 text-red-200";
  return "border-slate-500/45 bg-slate-700/40 text-slate-300";
}

function includesFilter(row: AuditRow, filter: AuditFilter): boolean {
  if (filter === "problem") return row.status !== "fresh";
  return row.status === filter;
}

export function QuoteFreshnessAudit({ sections }: { sections: SnapshotSection[] }) {
  const [filter, setFilter] = useState<AuditFilter>("problem");
  const rows = useMemo<AuditRow[]>(() => {
    return sections.flatMap((section) =>
      section.groups.flatMap((group) =>
        group.rows.map((row) => ({
          ticker: row.ticker,
          name: row.displayName,
          groupTitle: group.title,
          status: row.quoteFreshnessStatus ?? (row.barDate ? "fresh" : "unavailable"),
          barDate: row.barDate ?? null,
          source: row.quoteSource ?? null,
          reason: row.quoteFreshnessReason ?? null,
        })),
      ),
    ).sort((left, right) => {
      const statusOrder: Record<QuoteFreshnessStatus, number> = {
        unavailable: 0,
        stale: 1,
        unsupported: 2,
        fresh: 3,
      };
      const statusCompare = statusOrder[left.status] - statusOrder[right.status];
      if (statusCompare !== 0) return statusCompare;
      const groupCompare = left.groupTitle.localeCompare(right.groupTitle);
      if (groupCompare !== 0) return groupCompare;
      return left.ticker.localeCompare(right.ticker);
    });
  }, [sections]);

  const counts = useMemo(() => {
    const initial: Record<QuoteFreshnessStatus, number> = { fresh: 0, stale: 0, unavailable: 0, unsupported: 0 };
    for (const row of rows) initial[row.status] += 1;
    return initial;
  }, [rows]);
  const visibleRows = rows.filter((row) => includesFilter(row, filter));
  const problemCount = rows.length - counts.fresh;

  return (
    <section id="overview-quote-audit" className="card scroll-mt-28 overflow-hidden md:scroll-mt-32">
      <div className="flex flex-col gap-3 border-b border-borderSoft px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="font-medium tracking-wide text-slate-100">Quote Freshness Audit</h3>
          <p className="mt-1 text-xs text-slate-400">{problemCount} need review / {rows.length} tracked rows</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((item) => {
            const count = item.key === "problem" ? problemCount : counts[item.key];
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
              {["Ticker", "Status", "Last Bar", "Group", "Source"].map((heading) => (
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
                  <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${statusClass(row.status)}`} title={row.reason ?? statusLabel(row.status)}>
                    {statusLabel(row.status)}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-slate-300">{row.barDate ?? "N/A"}</td>
                <td className="px-3 py-2 text-slate-300">{row.groupTitle}</td>
                <td className="px-3 py-2 text-slate-400">{row.source ?? "N/A"}</td>
              </tr>
            ))}
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-slate-400">
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
