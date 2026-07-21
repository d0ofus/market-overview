"use client";

import * as Collapsible from "@radix-ui/react-collapsible";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { countActionableOverviewRows, type OverviewFreshnessSummary } from "@/lib/overview-freshness";
import type { SnapshotReadyResponse } from "@/types/dashboard";
import { QuoteFreshnessAudit } from "./quote-freshness-audit";

type SnapshotSection = SnapshotReadyResponse["sections"][number];

type Props = {
  summary: OverviewFreshnessSummary | null;
  sections: SnapshotSection[];
};

function toneClass(tone: OverviewFreshnessSummary["tone"]): string {
  return tone === "danger"
    ? "border-red-400/35 bg-red-500/10 text-red-100"
    : "border-warning/35 bg-warning/10 text-warning";
}

export function OverviewFreshnessDisclosure({ summary, sections }: Props) {
  if (!summary) return null;
  const affectedRows = countActionableOverviewRows(sections);

  return (
    <Collapsible.Root id="overview-quote-audit" defaultOpen={false} className={`scroll-mt-28 overflow-hidden rounded-2xl border shadow-sm md:scroll-mt-32 ${toneClass(summary.tone)}`}>
      <Collapsible.Trigger className="group flex w-full items-center gap-3 px-4 py-3 text-left">
        <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
        <span className="rounded-full border border-current/25 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em]">
          {summary.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold md:text-base">{summary.title}</span>
        <span className="shrink-0 text-xs text-current/80">{affectedRows} affected row{affectedRows === 1 ? "" : "s"}</span>
        <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
      </Collapsible.Trigger>
      <Collapsible.Content className="border-t border-current/15">
        <div className="px-4 py-3">
          <p className="text-sm leading-6 text-current/85">{summary.message}</p>
          {summary.details.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {summary.details.map((detail) => (
                <span key={detail} className="rounded-full border border-current/25 bg-current/10 px-2.5 py-1 text-xs">
                  {detail}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="border-t border-current/15 bg-slate-950/25 text-slate-100">
          <QuoteFreshnessAudit sections={sections} embedded anchorId="overview-quote-audit-table" />
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
