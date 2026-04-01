"use client";

import { useMemo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type {
  ResearchLabRunEventRecord,
  ResearchLabRunItemResult,
} from "@/lib/research-lab-api";

function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
}

function formatNumber(value: number | null | undefined, digits = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function statusTone(status: string) {
  if (status === "completed") return "border-emerald-400/30 bg-emerald-500/10 text-emerald-200";
  if (status === "failed" || status.endsWith("_failed")) return "border-rose-400/30 bg-rose-500/10 text-rose-200";
  if (status === "running" || status === "gathering" || status === "synthesizing" || status === "persisting" || status === "memory_loading") {
    return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  }
  return "border-borderSoft/80 bg-panelSoft/70 text-slate-300";
}

function formatUsage(value: Record<string, unknown> | null | undefined) {
  if (!value) return null;
  return Object.entries(value)
    .map(([key, entry]) => {
      if (typeof entry === "number") return `${key}: ${formatNumber(entry)}`;
      if (entry && typeof entry === "object") return `${key}: ${JSON.stringify(entry)}`;
      return `${key}: ${String(entry)}`;
    })
    .join(" | ");
}

function sortEvents(events: ResearchLabRunEventRecord[]) {
  return [...events].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-borderSoft/60 bg-panel/60 p-3">
      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-medium capitalize text-text">{value.replaceAll("_", " ")}</p>
    </div>
  );
}

function TextCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-2xl border border-borderSoft/60 bg-panel/60 p-4">
      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{title}</p>
      <p className="mt-2 text-sm text-slate-300">{text}</p>
    </div>
  );
}

function ListCard({ title, items, emptyLabel }: { title: string; items: string[]; emptyLabel: string }) {
  return (
    <div className="rounded-2xl border border-borderSoft/60 bg-panel/60 p-4">
      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{title}</p>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-slate-400">{emptyLabel}</p>
      ) : (
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-slate-300">
          {items.map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}
    </div>
  );
}

export function ResearchLabResultCard({
  itemResult,
  actions,
}: {
  itemResult: ResearchLabRunItemResult;
  actions?: ReactNode;
}) {
  const events = useMemo(() => sortEvents(itemResult.events), [itemResult.events]);
  const output = itemResult.output?.synthesisJson ?? null;
  const usageSummary = [
    itemResult.item.gatherUsageJson ? `Perplexity ${formatUsage(itemResult.item.gatherUsageJson)}` : null,
    itemResult.item.synthUsageJson ? `Claude ${formatUsage(itemResult.item.synthUsageJson)}` : null,
  ].filter(Boolean).join(" | ");

  return (
    <article className="rounded-3xl border border-borderSoft/70 bg-panel/90 p-5 shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h4 className="text-xl font-semibold text-text">{itemResult.item.ticker}</h4>
            <span className={`rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] ${statusTone(itemResult.item.status)}`}>
              {itemResult.item.status}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-400">{itemResult.item.companyName ?? "Company name pending"}</p>
          <p className="mt-2 text-xs text-slate-500">
            Gather: {itemResult.item.gatherModel ?? "-"} ({formatNumber(itemResult.item.gatherLatencyMs)} ms) ·
            {" "}Synth: {itemResult.item.synthModel ?? "-"} ({formatNumber(itemResult.item.synthLatencyMs)} ms)
          </p>
          {usageSummary ? <p className="mt-1 text-xs text-slate-500">{usageSummary}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {itemResult.item.lastError ? (
            <div className="inline-flex items-center gap-2 rounded-2xl border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
              <AlertTriangle className="h-4 w-4" />
              {itemResult.item.lastError}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-4">
          <details open className="rounded-2xl border border-borderSoft/70 bg-panelSoft/60 p-4">
            <summary className="cursor-pointer text-sm font-medium text-text">Activity</summary>
            <div className="mt-3 space-y-3">
              {events.length === 0 ? <p className="text-sm text-slate-400">No events yet.</p> : events.map((event) => (
                <div key={event.id} className="rounded-2xl border border-borderSoft/60 bg-panel/60 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm text-text">{event.message}</p>
                      <p className="mt-1 text-xs text-slate-500">{event.eventType}</p>
                    </div>
                    <span className="text-xs text-slate-500">{formatTime(event.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          </details>

          <details open className="rounded-2xl border border-borderSoft/70 bg-panelSoft/60 p-4">
            <summary className="cursor-pointer text-sm font-medium text-text">Evidence ({itemResult.evidence.length})</summary>
            <div className="mt-3 space-y-3">
              {itemResult.evidence.length === 0 ? <p className="text-sm text-slate-400">No evidence persisted.</p> : itemResult.evidence.map((record) => (
                <div key={record.id} className="rounded-2xl border border-borderSoft/60 bg-panel/60 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{record.queryLabel}</p>
                      <p className="mt-1 text-sm font-medium text-text">{record.title}</p>
                      <p className="mt-2 text-sm text-slate-300">{record.summary}</p>
                      {record.bullets.length > 0 ? (
                        <ul className="mt-2 list-disc pl-5 text-xs text-slate-400">
                          {record.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
                        </ul>
                      ) : null}
                    </div>
                    <div className="text-right text-xs text-slate-500">
                      <div>{record.sourceDomain ?? "-"}</div>
                      <div className="mt-1">{formatTime(record.publishedAt)}</div>
                    </div>
                  </div>
                  {record.canonicalUrl ? (
                    <a
                      href={record.canonicalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 inline-flex text-xs text-accent hover:underline"
                    >
                      Open source
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          </details>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/60 p-4">
            <p className="text-sm font-medium text-text">Final Synthesis</p>
            {!output ? (
              <div className="mt-3 rounded-2xl border border-rose-400/20 bg-rose-500/10 p-4 text-sm text-rose-100">
                No synthesis was persisted for this ticker.
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <div className="grid gap-3 md:grid-cols-4">
                  <MetricPill label="Opinion" value={output.opinion} />
                  <MetricPill label="Valuation" value={output.valuationView.label} />
                  <MetricPill label="Earnings" value={output.earningsQualityView.label} />
                  <MetricPill label="Priced In" value={output.pricedInView.label} />
                </div>
                <div className="rounded-2xl border border-borderSoft/60 bg-panel/60 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Overall Summary</p>
                  <p className="mt-2 text-sm text-slate-200">{output.overallSummary}</p>
                  <p className="mt-3 text-xs uppercase tracking-[0.18em] text-slate-500">Why Now</p>
                  <p className="mt-2 text-sm text-slate-300">{output.whyNow}</p>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <TextCard title="Valuation View" text={output.valuationView.summary} />
                  <TextCard title="Earnings Quality" text={output.earningsQualityView.summary} />
                  <TextCard title="Priced In" text={output.pricedInView.summary} />
                  <TextCard
                    title="Confidence"
                    text={`${output.confidence.summary} (${output.confidence.label}, ${output.confidence.score.toFixed(2)})`}
                  />
                </div>
                {output.modules?.keyDrivers ? (
                  <ListCard
                    title="Key Drivers"
                    items={output.modules.keyDrivers.drivers.map((item) => `${item.title}: ${item.whyItMatters} (${item.priceRelationship})`)}
                    emptyLabel="No key drivers returned."
                  />
                ) : null}
                <ListCard
                  title="Catalysts"
                  items={output.catalysts.map((item) => `${item.title}: ${item.summary}`)}
                  emptyLabel="No catalysts returned."
                />
                <ListCard
                  title="Risks"
                  items={output.risks.map((item) => `${item.title}: ${item.summary}`)}
                  emptyLabel="No risks returned."
                />
                <ListCard
                  title="Contradictions"
                  items={output.contradictions.map((item) => `${item.title}: ${item.summary}`)}
                  emptyLabel="No contradictions returned."
                />
                <ListCard
                  title="Monitoring Points"
                  items={output.monitoringPoints}
                  emptyLabel="No monitoring points returned."
                />
                {itemResult.output?.deltaJson?.summary ? (
                  <div className="rounded-2xl border border-borderSoft/60 bg-panel/60 p-4">
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Delta vs Prior Memory</p>
                    <p className="mt-2 text-sm text-slate-300">{itemResult.output.deltaJson.summary}</p>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
