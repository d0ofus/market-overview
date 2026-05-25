"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import * as Collapsible from "@radix-ui/react-collapsible";
import { AlertTriangle, CheckCircle2, ChevronDown, Database, ExternalLink, FileText, RefreshCw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { refreshMarketCommentary, type MarketCommentaryResponse } from "@/lib/api";

type TabKey = "report" | "sources" | "quality";

type Props = {
  initial: MarketCommentaryResponse;
};

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function statusClass(status: MarketCommentaryResponse["status"]): string {
  if (status === "ready") return "border-success/35 bg-success/10 text-success";
  if (status === "failed") return "border-warning/35 bg-warning/10 text-warning";
  return "border-borderSoft bg-panelSoft text-text/70";
}

function sessionLabel(value: string | undefined): string {
  if (value === "regular") return "Intraday";
  if (value === "after_hours") return "Post-close";
  if (value === "pre_market") return "Pre-market";
  if (value === "closed") return "Market closed";
  return "No report";
}

const markdownComponents: Components = {
  h1: ({ node: _node, ...props }) => (
    <h1 className="mb-5 text-xl font-semibold leading-tight text-text md:text-2xl" {...props} />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2 className="mt-8 border-t border-borderSoft/70 pt-5 text-lg font-semibold leading-tight text-text" {...props} />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3 className="mt-6 text-base font-semibold leading-snug text-text" {...props} />
  ),
  p: ({ node: _node, ...props }) => (
    <p className="my-3 text-sm leading-6 text-text/85" {...props} />
  ),
  strong: ({ node: _node, ...props }) => (
    <strong className="font-semibold text-text" {...props} />
  ),
  ul: ({ node: _node, ...props }) => (
    <ul className="my-3 list-disc space-y-2 pl-5 text-sm leading-6 text-text/85" {...props} />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol className="my-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-text/85" {...props} />
  ),
  li: ({ node: _node, ...props }) => (
    <li className="pl-1" {...props} />
  ),
  hr: ({ node: _node, ...props }) => (
    <hr className="my-6 border-borderSoft/70" {...props} />
  ),
  a: ({ node: _node, ...props }) => (
    <a className="font-medium text-accent underline underline-offset-2 hover:text-accent/80" target="_blank" rel="noreferrer" {...props} />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="my-5 overflow-x-auto rounded border border-borderSoft/70 bg-panel">
      <table className="min-w-full divide-y divide-borderSoft/70 text-left text-xs" {...props} />
    </div>
  ),
  thead: ({ node: _node, ...props }) => (
    <thead className="bg-panelSoft text-text" {...props} />
  ),
  tbody: ({ node: _node, ...props }) => (
    <tbody className="divide-y divide-borderSoft/50" {...props} />
  ),
  tr: ({ node: _node, ...props }) => (
    <tr className="align-top" {...props} />
  ),
  th: ({ node: _node, ...props }) => (
    <th className="px-3 py-2 font-semibold text-text" {...props} />
  ),
  td: ({ node: _node, ...props }) => (
    <td className="px-3 py-2 text-text/80" {...props} />
  ),
};

function MarkdownReport({ markdown }: { markdown: string }) {
  return (
    <div className="break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition ${
        active
          ? "border-accent/50 bg-accent/15 text-accent"
          : "border-borderSoft bg-panelSoft/70 text-text/70 hover:border-accent/40 hover:text-text"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

export function MarketCommentaryPanel({ initial }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<TabKey>("report");
  const [commentary, setCommentary] = useState<MarketCommentaryResponse>(initial);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const messageTimerRef = useRef<number | null>(null);
  const report = commentary.report;
  const sources = report?.sourceAudit ?? [];
  const dataQuality = report?.dataQuality ?? [];
  const hasReport = Boolean(report);

  useEffect(() => {
    return () => {
      if (messageTimerRef.current != null) window.clearTimeout(messageTimerRef.current);
    };
  }, []);

  function showMessage(value: string) {
    setMessage(value);
    if (messageTimerRef.current != null) window.clearTimeout(messageTimerRef.current);
    messageTimerRef.current = window.setTimeout(() => setMessage(null), 5000);
  }

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="card overflow-hidden">
      <div className="border-b border-borderSoft/70 bg-panel/50 px-4 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Collapsible.Trigger className="flex min-w-0 items-center gap-3 text-left">
            <ChevronDown className={`h-4 w-4 shrink-0 text-text/55 transition ${open ? "" : "-rotate-90"}`} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-text">US Market State of Play</h2>
                <span className={`rounded-full border px-2 py-0.5 text-xs ${statusClass(commentary.status)}`}>
                  {commentary.status === "ready" ? "Ready" : commentary.status === "failed" ? "Needs attention" : "Not generated"}
                </span>
                <span className="rounded-full border border-borderSoft bg-panelSoft/80 px-2 py-0.5 text-xs text-text/70">
                  {sessionLabel(report?.marketSession)}
                </span>
              </div>
              <p className="mt-1 truncate text-xs text-text/60">
                {report ? `${report.marketSessionLabel} - generated ${formatDateTime(report.generatedAt)}` : commentary.warning ?? "Generate the first report when ready."}
              </p>
            </div>
          </Collapsible.Trigger>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent disabled:opacity-60"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                setMessage(null);
                try {
                  const refreshed = await refreshMarketCommentary();
                  setCommentary(refreshed);
                  setOpen(true);
                  setTab("report");
                  showMessage(refreshed.warning ?? (refreshed.ok ? "Market commentary refreshed." : "Commentary refresh completed with warnings."));
                  router.refresh();
                } catch (error) {
                  showMessage(error instanceof Error ? error.message : "Commentary refresh failed.");
                } finally {
                  setLoading(false);
                }
              }}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Refreshing..." : "Refresh Commentary"}
            </button>
          </div>
        </div>
        {message && <p className="mt-2 text-xs text-text/60">{message}</p>}
      </div>

      <Collapsible.Content>
        <div className="space-y-4 p-4">
          {commentary.status === "failed" && (
            <div className="flex gap-2 rounded border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{commentary.warning ?? report?.error ?? "Commentary generation failed."}</span>
            </div>
          )}

          {!hasReport && (
            <div className="rounded border border-borderSoft bg-panelSoft/55 p-4 text-sm text-text/75">
              No market commentary has been generated yet. The rest of Overview is still using the existing market data workflow.
            </div>
          )}

          {report && (
            <>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded border border-borderSoft/70 bg-panelSoft/55 p-3">
                  <div className="text-xs uppercase text-text/55">Session date</div>
                  <div className="mt-1 font-mono text-sm text-text">{report.sessionDate}</div>
                </div>
                <div className="rounded border border-borderSoft/70 bg-panelSoft/55 p-3">
                  <div className="text-xs uppercase text-text/55">As of</div>
                  <div className="mt-1 text-sm text-text">{formatDateTime(report.asOf)}</div>
                </div>
                <div className="rounded border border-borderSoft/70 bg-panelSoft/55 p-3">
                  <div className="text-xs uppercase text-text/55">Model</div>
                  <div className="mt-1 font-mono text-sm text-text">{report.model}</div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <TabButton active={tab === "report"} onClick={() => setTab("report")} icon={<FileText className="h-4 w-4" />}>Report</TabButton>
                <TabButton active={tab === "sources"} onClick={() => setTab("sources")} icon={<ExternalLink className="h-4 w-4" />}>Sources</TabButton>
                <TabButton active={tab === "quality"} onClick={() => setTab("quality")} icon={<Database className="h-4 w-4" />}>Data Quality</TabButton>
              </div>

              {tab === "report" && (
                <div className="max-h-[760px] overflow-auto rounded border border-borderSoft/70 bg-panel p-4 shadow-sm">
                  <MarkdownReport markdown={report.reportMarkdown} />
                </div>
              )}

              {tab === "sources" && (
                <div className="max-h-[520px] overflow-auto rounded border border-borderSoft/70 bg-panel">
                  {sources.length === 0 ? (
                    <p className="p-4 text-sm text-text/60">No sources were recorded for this report.</p>
                  ) : (
                    <div className="divide-y divide-borderSoft/60">
                      {sources.map((source, index) => (
                        <div key={`${source.url ?? source.sourceName}-${index}`} className="p-4 text-sm">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-medium text-text">{source.sourceName}</div>
                              <div className="mt-1 text-text/65">{source.dataUsed}</div>
                              {source.timestamp && <div className="mt-1 font-mono text-xs text-text/50">{source.timestamp}</div>}
                              {source.note && <div className="mt-1 text-xs text-text/50">{source.note}</div>}
                            </div>
                            {source.url && (
                              <a
                                href={source.url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex shrink-0 items-center gap-1 rounded border border-borderSoft px-2 py-1 text-xs text-accent hover:border-accent/60"
                              >
                                Open
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {tab === "quality" && (
                <div className="max-h-[520px] overflow-auto rounded border border-borderSoft/70 bg-panel">
                  {dataQuality.length === 0 ? (
                    <p className="p-4 text-sm text-text/60">No data-quality notes were recorded for this report.</p>
                  ) : (
                    <div className="divide-y divide-borderSoft/60">
                      {dataQuality.map((item, index) => (
                        <div key={`${item.metric}-${index}`} className="flex gap-3 p-4 text-sm">
                          <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${item.status === "ok" ? "text-success" : "text-warning"}`} />
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-text">{item.metric}</span>
                              <span className="rounded-full border border-borderSoft bg-panelSoft/80 px-2 py-0.5 text-xs text-text/70">{item.status}</span>
                            </div>
                            <div className="mt-1 text-text/65">{item.note}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
