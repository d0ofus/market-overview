import { AlertTriangle, ArrowDownCircle } from "lucide-react";
import type { OverviewFreshnessSummary } from "@/lib/overview-freshness";

type Props = {
  summary: OverviewFreshnessSummary | null;
};

function toneClass(tone: OverviewFreshnessSummary["tone"]): string {
  if (tone === "danger") return "border-red-400/35 bg-red-500/10 text-red-100";
  return "border-warning/35 bg-warning/10 text-warning";
}

function chipClass(tone: OverviewFreshnessSummary["tone"]): string {
  if (tone === "danger") return "border-red-300/30 bg-red-500/10 text-red-100";
  return "border-warning/30 bg-warning/10 text-warning";
}

export function OverviewFreshnessBanner({ summary }: Props) {
  if (!summary) return null;

  return (
    <section className={`rounded-2xl border px-4 py-3 shadow-sm ${toneClass(summary.tone)}`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-current/25 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em]">
                {summary.label}
              </span>
              <h2 className="text-sm font-semibold text-current md:text-base">{summary.title}</h2>
            </div>
            <p className="mt-1 text-sm leading-6 text-current/85">{summary.message}</p>
          </div>
        </div>
        {summary.auditHref ? (
          <a
            href={summary.auditHref}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-current/25 bg-current/10 px-3 py-2 text-sm font-medium text-current transition hover:bg-current/15"
          >
            <ArrowDownCircle className="h-4 w-4" />
            Quote audit
          </a>
        ) : null}
      </div>
      {summary.details.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {summary.details.map((detail) => (
            <span key={detail} className={`rounded-full border px-2.5 py-1 text-xs ${chipClass(summary.tone)}`}>
              {detail}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
