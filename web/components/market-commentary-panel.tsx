"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import * as Collapsible from "@radix-ui/react-collapsible";
import { AlertTriangle, CheckCircle2, ChevronDown, Database, ExternalLink, FileText, RefreshCw } from "lucide-react";
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
  if (status === "ready") return "border-emerald-400/35 bg-emerald-500/10 text-emerald-200";
  if (status === "failed") return "border-amber-400/35 bg-amber-500/10 text-amber-200";
  return "border-slate-600 bg-slate-800/70 text-slate-300";
}

function sessionLabel(value: string | undefined): string {
  if (value === "regular") return "Intraday";
  if (value === "after_hours") return "Post-close";
  if (value === "pre_market") return "Pre-market";
  if (value === "closed") return "Market closed";
  return "No report";
}

function InlineMarkdown({ text }: { text: string }) {
  const nodes = text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index} className="font-semibold text-slate-100">{part.slice(2, -2)}</strong>;
    }
    return <span key={index}>{part}</span>;
  });
  return <>{nodes}</>;
}

function MarkdownTable({ lines }: { lines: string[] }) {
  const rows = lines
    .filter((line) => !/^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim()))
    .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()));
  if (rows.length === 0) return null;
  const [header, ...body] = rows;
  return (
    <div className="my-3 overflow-x-auto rounded border border-borderSoft/70">
      <table className="min-w-full divide-y divide-borderSoft/70 text-left text-xs">
        <thead className="bg-slate-950/60 text-slate-300">
          <tr>
            {header.map((cell, index) => (
              <th key={index} className="px-3 py-2 font-medium">
                <InlineMarkdown text={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-borderSoft/50">
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className="align-top">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-3 py-2 text-slate-300">
                  <InlineMarkdown text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MarkdownReport({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => {
    const lines = markdown.split(/\r?\n/);
    const output: Array<{ type: "line"; value: string; index: number } | { type: "table"; value: string[]; index: number }> = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim().startsWith("|")) {
        const table: string[] = [];
        let cursor = index;
        while (cursor < lines.length && lines[cursor].trim().startsWith("|")) {
          table.push(lines[cursor]);
          cursor += 1;
        }
        output.push({ type: "table", value: table, index });
        index = cursor - 1;
      } else {
        output.push({ type: "line", value: line, index });
      }
    }
    return output;
  }, [markdown]);

  return (
    <div className="space-y-1 break-words text-sm leading-6 text-slate-300">
      {blocks.map((block) => {
        if (block.type === "table") {
          return <MarkdownTable key={block.index} lines={block.value} />;
        }
        const line = block.value.trim();
        if (!line) return <div key={block.index} className="h-2" />;
        if (/^={5,}$/.test(line)) return <div key={block.index} className="my-3 border-t border-borderSoft/60" />;
        if (line.startsWith("# ")) {
          return <h2 key={block.index} className="pt-2 text-lg font-semibold text-slate-50"><InlineMarkdown text={line.slice(2)} /></h2>;
        }
        if (line.startsWith("## ")) {
          return <h3 key={block.index} className="pt-2 text-base font-semibold text-slate-100"><InlineMarkdown text={line.slice(3)} /></h3>;
        }
        if (/^\d+\.\s+[A-Z]/.test(line)) {
          return <h3 key={block.index} className="pt-3 text-base font-semibold text-slate-100"><InlineMarkdown text={line} /></h3>;
        }
        if (line.startsWith("- ")) {
          return (
            <p key={block.index} className="pl-4">
              <span className="mr-2 text-accent">-</span>
              <InlineMarkdown text={line.slice(2)} />
            </p>
          );
        }
        return <p key={block.index}><InlineMarkdown text={line} /></p>;
      })}
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
          : "border-borderSoft bg-slate-900/40 text-slate-300 hover:border-slate-500"
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
            <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition ${open ? "" : "-rotate-90"}`} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-slate-50">US Market State of Play</h2>
                <span className={`rounded-full border px-2 py-0.5 text-xs ${statusClass(commentary.status)}`}>
                  {commentary.status === "ready" ? "Ready" : commentary.status === "failed" ? "Needs attention" : "Not generated"}
                </span>
                <span className="rounded-full border border-borderSoft bg-slate-900/60 px-2 py-0.5 text-xs text-slate-300">
                  {sessionLabel(report?.marketSession)}
                </span>
              </div>
              <p className="mt-1 truncate text-xs text-slate-400">
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
        {message && <p className="mt-2 text-xs text-slate-400">{message}</p>}
      </div>

      <Collapsible.Content>
        <div className="space-y-4 p-4">
          {commentary.status === "failed" && (
            <div className="flex gap-2 rounded border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{commentary.warning ?? report?.error ?? "Commentary generation failed."}</span>
            </div>
          )}

          {!hasReport && (
            <div className="rounded border border-borderSoft bg-slate-900/40 p-4 text-sm text-slate-300">
              No market commentary has been generated yet. The rest of Overview is still using the existing market data workflow.
            </div>
          )}

          {report && (
            <>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded border border-borderSoft/70 bg-slate-950/35 p-3">
                  <div className="text-xs uppercase text-slate-500">Session date</div>
                  <div className="mt-1 font-mono text-sm text-slate-100">{report.sessionDate}</div>
                </div>
                <div className="rounded border border-borderSoft/70 bg-slate-950/35 p-3">
                  <div className="text-xs uppercase text-slate-500">As of</div>
                  <div className="mt-1 text-sm text-slate-100">{formatDateTime(report.asOf)}</div>
                </div>
                <div className="rounded border border-borderSoft/70 bg-slate-950/35 p-3">
                  <div className="text-xs uppercase text-slate-500">Model</div>
                  <div className="mt-1 font-mono text-sm text-slate-100">{report.model}</div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <TabButton active={tab === "report"} onClick={() => setTab("report")} icon={<FileText className="h-4 w-4" />}>Report</TabButton>
                <TabButton active={tab === "sources"} onClick={() => setTab("sources")} icon={<ExternalLink className="h-4 w-4" />}>Sources</TabButton>
                <TabButton active={tab === "quality"} onClick={() => setTab("quality")} icon={<Database className="h-4 w-4" />}>Data Quality</TabButton>
              </div>

              {tab === "report" && (
                <div className="max-h-[760px] overflow-auto rounded border border-borderSoft/70 bg-slate-950/35 p-4">
                  <MarkdownReport markdown={report.reportMarkdown} />
                </div>
              )}

              {tab === "sources" && (
                <div className="max-h-[520px] overflow-auto rounded border border-borderSoft/70 bg-slate-950/35">
                  {sources.length === 0 ? (
                    <p className="p-4 text-sm text-slate-400">No sources were recorded for this report.</p>
                  ) : (
                    <div className="divide-y divide-borderSoft/60">
                      {sources.map((source, index) => (
                        <div key={`${source.url ?? source.sourceName}-${index}`} className="p-4 text-sm">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-medium text-slate-100">{source.sourceName}</div>
                              <div className="mt-1 text-slate-400">{source.dataUsed}</div>
                              {source.timestamp && <div className="mt-1 font-mono text-xs text-slate-500">{source.timestamp}</div>}
                              {source.note && <div className="mt-1 text-xs text-slate-500">{source.note}</div>}
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
                <div className="max-h-[520px] overflow-auto rounded border border-borderSoft/70 bg-slate-950/35">
                  {dataQuality.length === 0 ? (
                    <p className="p-4 text-sm text-slate-400">No data-quality notes were recorded for this report.</p>
                  ) : (
                    <div className="divide-y divide-borderSoft/60">
                      {dataQuality.map((item, index) => (
                        <div key={`${item.metric}-${index}`} className="flex gap-3 p-4 text-sm">
                          <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${item.status === "ok" ? "text-emerald-300" : "text-amber-300"}`} />
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-slate-100">{item.metric}</span>
                              <span className="rounded-full border border-borderSoft bg-slate-900/60 px-2 py-0.5 text-xs text-slate-300">{item.status}</span>
                            </div>
                            <div className="mt-1 text-slate-400">{item.note}</div>
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
