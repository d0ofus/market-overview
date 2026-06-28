"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { AlertTriangle, CheckCircle2, ChevronDown, Database, ExternalLink, FileText, RefreshCw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  generateWeeklyMarketReview,
  getMarketCommentary,
  getWeeklyMarketReview,
  refreshMarketCommentary,
  type MarketCommentaryResponse,
  type WeeklyMarketReviewResponse,
} from "@/lib/api";
import {
  deriveCommentaryFreshnessSummary,
  type FreshnessTone,
  type OverviewFreshnessContext,
} from "@/lib/overview-freshness";

type TabKey = "report" | "sources" | "quality";
type ReportMode = "daily" | "weekly";

type Props = {
  initial?: MarketCommentaryResponse | null;
  overviewFreshness?: OverviewFreshnessContext | null;
};

const COMMENTARY_LOAD_TIMEOUT_MS = 10_000;

const EMPTY_COMMENTARY: MarketCommentaryResponse = {
  status: "empty",
  warning: null,
  report: null,
};

const EMPTY_WEEKLY_REVIEW: WeeklyMarketReviewResponse = {
  status: "empty",
  warning: null,
  report: null,
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

function freshnessBadgeClass(tone: FreshnessTone): string {
  if (tone === "ok") return "border-success/30 bg-success/10 text-success";
  if (tone === "danger") return "border-red-400/35 bg-red-500/10 text-red-200";
  return "border-warning/35 bg-warning/10 text-warning";
}

function freshnessPanelClass(tone: FreshnessTone): string {
  if (tone === "danger") return "border-red-400/30 bg-red-500/10 text-red-200";
  return "border-warning/30 bg-warning/10 text-warning";
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function sessionLabel(value: string | undefined): string {
  if (value === "regular") return "Intraday";
  if (value === "after_hours") return "Post-close";
  if (value === "pre_market") return "Pre-market";
  if (value === "closed") return "Market closed";
  return "No report";
}

function weeklyProviderLabel(report: WeeklyMarketReviewResponse["report"]): string {
  if (!report) return "Not generated";
  return report.generationProvider === "hermes_gpt" ? "Hermes / GPT-5.5" : "Gemini fallback";
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

export function MarketCommentaryPanel({ initial, overviewFreshness = null }: Props) {
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<ReportMode>("daily");
  const [tab, setTab] = useState<TabKey>("report");
  const [commentary, setCommentary] = useState<MarketCommentaryResponse>(() => initial ?? EMPTY_COMMENTARY);
  const [weeklyReview, setWeeklyReview] = useState<WeeklyMarketReviewResponse>(EMPTY_WEEKLY_REVIEW);
  const [cachedLoading, setCachedLoading] = useState(() => !initial);
  const [loading, setLoading] = useState(false);
  const [weeklyCachedLoading, setWeeklyCachedLoading] = useState(false);
  const [weeklyLoading, setWeeklyLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const messageTimerRef = useRef<number | null>(null);
  const cachedLoadControllerRef = useRef<AbortController | null>(null);
  const cachedLoadRequestRef = useRef(0);
  const weeklyLoadControllerRef = useRef<AbortController | null>(null);
  const weeklyLoadRequestRef = useRef(0);
  const dailyReport = commentary.report;
  const weeklyReport = weeklyReview.report;
  const activeStatus = mode === "daily" ? commentary.status : weeklyReview.status;
  const activeWarning = mode === "daily" ? commentary.warning : weeklyReview.warning;
  const activeLoading = mode === "daily" ? cachedLoading : weeklyCachedLoading;
  const report = mode === "daily" ? dailyReport : weeklyReport;
  const sources = mode === "daily" ? dailyReport?.sourceAudit ?? [] : weeklyReport?.sourceAudit ?? [];
  const dataQuality = mode === "daily" ? dailyReport?.dataQuality ?? [] : weeklyReport?.dataQuality ?? [];
  const hasReport = Boolean(report);
  const activeMarkdown = mode === "daily" ? dailyReport?.reportMarkdown : weeklyReport?.reviewMarkdown;
  const commentaryFreshness = deriveCommentaryFreshnessSummary({
    mode,
    status: activeStatus,
    warning: activeWarning,
    report,
    dataQuality,
    overview: overviewFreshness,
  });
  const statusLabel =
    activeLoading && !hasReport
      ? "Loading"
      : activeStatus === "ready"
        ? "Ready"
        : activeStatus === "failed"
          ? "Needs attention"
          : "Not generated";
  const summaryText = mode === "daily"
    ? dailyReport
      ? `${dailyReport.marketSessionLabel} - generated ${formatDateTime(dailyReport.generatedAt)}`
      : cachedLoading
        ? "Loading cached market commentary..."
        : commentary.warning ?? "Generate the first report when ready."
    : weeklyReport
      ? `${weeklyReport.weekStart} to ${weeklyReport.weekEnd} - generated ${formatDateTime(weeklyReport.generatedAt)}`
      : weeklyCachedLoading
        ? "Loading weekly market review..."
        : weeklyReview.warning ?? "Weekly review has not been generated yet.";
  const emptyText = mode === "daily"
    ? cachedLoading
      ? "Loading market commentary. The rest of Overview is already available."
      : commentary.warning ?? "No market commentary has been generated yet. The rest of Overview is still using the existing market data workflow."
    : weeklyCachedLoading
      ? "Loading weekly market review. Daily commentary is still available."
      : weeklyReview.warning ?? "No weekly market review has been generated for the latest completed week yet. It should appear automatically after the weekly schedule. If it is missing, use Generate Weekly Review to run the Gemini fallback.";

  useEffect(() => {
    return () => {
      if (messageTimerRef.current != null) window.clearTimeout(messageTimerRef.current);
      weeklyLoadControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (initial) {
      setCommentary(initial);
      setCachedLoading(false);
      return;
    }

    const requestId = cachedLoadRequestRef.current + 1;
    cachedLoadRequestRef.current = requestId;
    const controller = new AbortController();
    let cancelled = false;
    cachedLoadControllerRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), COMMENTARY_LOAD_TIMEOUT_MS);

    setCachedLoading(true);
    getMarketCommentary({ signal: controller.signal })
      .then((snapshot) => {
        if (cancelled || cachedLoadRequestRef.current !== requestId) return;
        setCommentary(snapshot);
      })
      .catch((error) => {
        if (cancelled || cachedLoadRequestRef.current !== requestId) return;
        const timeoutWarning =
          isAbortError(error)
            ? "Market commentary is taking too long to load. The rest of Overview is ready."
            : error instanceof Error
              ? error.message
              : "Market commentary could not be loaded.";
        setCommentary({ status: "empty", warning: timeoutWarning, report: null });
      })
      .finally(() => {
        if (!cancelled && cachedLoadRequestRef.current === requestId) setCachedLoading(false);
        if (cachedLoadControllerRef.current === controller) cachedLoadControllerRef.current = null;
        window.clearTimeout(timeout);
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (cachedLoadControllerRef.current === controller) cachedLoadControllerRef.current = null;
      window.clearTimeout(timeout);
    };
  }, [initial]);

  useEffect(() => {
    if (mode !== "weekly" || weeklyReview.report || weeklyReview.warning) return;

    const requestId = weeklyLoadRequestRef.current + 1;
    weeklyLoadRequestRef.current = requestId;
    const controller = new AbortController();
    let cancelled = false;
    weeklyLoadControllerRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), COMMENTARY_LOAD_TIMEOUT_MS);

    setWeeklyCachedLoading(true);
    getWeeklyMarketReview({ signal: controller.signal })
      .then((snapshot) => {
        if (cancelled || weeklyLoadRequestRef.current !== requestId) return;
        setWeeklyReview(snapshot);
      })
      .catch((error) => {
        if (cancelled || weeklyLoadRequestRef.current !== requestId) return;
        const timeoutWarning =
          isAbortError(error)
            ? "Weekly market review is taking too long to load. Daily commentary is still available."
            : error instanceof Error
              ? error.message
              : "Weekly market review could not be loaded.";
        setWeeklyReview({ status: "empty", warning: timeoutWarning, report: null });
      })
      .finally(() => {
        if (!cancelled && weeklyLoadRequestRef.current === requestId) setWeeklyCachedLoading(false);
        if (weeklyLoadControllerRef.current === controller) weeklyLoadControllerRef.current = null;
        window.clearTimeout(timeout);
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (weeklyLoadControllerRef.current === controller) weeklyLoadControllerRef.current = null;
      window.clearTimeout(timeout);
    };
  }, [mode, weeklyReview.report, weeklyReview.warning]);

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
                <span className={`rounded-full border px-2 py-0.5 text-xs ${statusClass(activeStatus)}`}>
                  {statusLabel}
                </span>
                <span className="rounded-full border border-borderSoft bg-panelSoft/80 px-2 py-0.5 text-xs text-text/70">
                  {mode === "daily" ? sessionLabel(dailyReport?.marketSession) : weeklyProviderLabel(weeklyReport)}
                </span>
                {!(activeLoading && !hasReport) && (
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${freshnessBadgeClass(commentaryFreshness.tone)}`}>
                    {commentaryFreshness.label}
                  </span>
                )}
              </div>
              <p className="mt-1 truncate text-xs text-text/60">
                {summaryText}
              </p>
            </div>
          </Collapsible.Trigger>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-xl border border-borderSoft bg-panelSoft/70 p-1">
              {(["daily", "weekly"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => {
                    setMode(value);
                    setTab("report");
                    setMessage(null);
                  }}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    mode === value
                      ? "bg-accent/15 text-accent"
                      : "text-text/65 hover:bg-panelSoft hover:text-text"
                  }`}
                >
                  {value === "daily" ? "Daily" : "Weekly"}
                </button>
              ))}
            </div>
            {mode === "daily" ? (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent disabled:opacity-60"
                disabled={loading}
                onClick={async () => {
                  cachedLoadRequestRef.current += 1;
                  cachedLoadControllerRef.current?.abort();
                  setCachedLoading(false);
                  setLoading(true);
                  setMessage(null);
                  try {
                    const refreshed = await refreshMarketCommentary();
                    setCommentary(refreshed);
                    setOpen(true);
                    setTab("report");
                    showMessage(refreshed.warning ?? (refreshed.ok ? "Market commentary refreshed." : "Commentary refresh completed with warnings."));
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
            ) : weeklyReview.status !== "ready" ? (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent disabled:opacity-60"
                disabled={weeklyLoading || weeklyCachedLoading}
                onClick={async () => {
                  weeklyLoadRequestRef.current += 1;
                  weeklyLoadControllerRef.current?.abort();
                  setWeeklyCachedLoading(false);
                  setWeeklyLoading(true);
                  setMessage(null);
                  try {
                    const generated = await generateWeeklyMarketReview(false);
                    setWeeklyReview(generated);
                    setOpen(true);
                    setTab("report");
                    showMessage(generated.warning ?? (generated.ok ? "Weekly market review loaded." : "Weekly review generation completed with warnings."));
                  } catch (error) {
                    showMessage(error instanceof Error ? error.message : "Weekly review generation failed.");
                  } finally {
                    setWeeklyLoading(false);
                  }
                }}
              >
                <RefreshCw className={`h-4 w-4 ${weeklyLoading ? "animate-spin" : ""}`} />
                {weeklyLoading ? "Generating..." : "Generate Weekly Review"}
              </button>
            ) : null}
          </div>
        </div>
        {message && <p className="mt-2 text-xs text-text/60">{message}</p>}
      </div>

      <Collapsible.Content>
        <div className="space-y-4 p-4">
          {activeStatus === "failed" && (
            <div className="flex gap-2 rounded border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{activeWarning ?? report?.error ?? (mode === "daily" ? "Commentary generation failed." : "Weekly review generation failed.")}</span>
            </div>
          )}

          {report && activeStatus !== "failed" && commentaryFreshness.tone !== "ok" && (
            <div className={`rounded border p-3 text-sm ${freshnessPanelClass(commentaryFreshness.tone)}`}>
              <div className="flex gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <div className="font-medium">{commentaryFreshness.label}</div>
                  {commentaryFreshness.message ? (
                    <div className="mt-1 leading-5 text-current/85">{commentaryFreshness.message}</div>
                  ) : null}
                </div>
              </div>
              {commentaryFreshness.issues.length > 1 ? (
                <ul className="mt-2 space-y-1 pl-10 text-xs leading-5 text-current/80">
                  {commentaryFreshness.issues.slice(1, 4).map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}

          {!hasReport && (
            <div className="rounded border border-borderSoft bg-panelSoft/55 p-4 text-sm text-text/75">
              {emptyText}
            </div>
          )}

          {report && (
            <>
              {mode === "daily" && dailyReport ? (
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded border border-borderSoft/70 bg-panelSoft/55 p-3">
                    <div className="text-xs uppercase text-text/55">Session date</div>
                    <div className="mt-1 font-mono text-sm text-text">{dailyReport.sessionDate}</div>
                  </div>
                  <div className="rounded border border-borderSoft/70 bg-panelSoft/55 p-3">
                    <div className="text-xs uppercase text-text/55">As of</div>
                    <div className="mt-1 text-sm text-text">{formatDateTime(dailyReport.asOf)}</div>
                  </div>
                  <div className="rounded border border-borderSoft/70 bg-panelSoft/55 p-3">
                    <div className="text-xs uppercase text-text/55">Model</div>
                    <div className="mt-1 font-mono text-sm text-text">{dailyReport.model}</div>
                  </div>
                </div>
              ) : weeklyReport ? (
                <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
                  <div className="rounded border border-borderSoft/70 bg-panelSoft/55 p-3">
                    <div className="text-xs uppercase text-text/55">Week</div>
                    <div className="mt-1 font-mono text-sm text-text">{weeklyReport.weekStart} to {weeklyReport.weekEnd}</div>
                  </div>
                  <div className="rounded border border-borderSoft/70 bg-panelSoft/55 p-3">
                    <div className="text-xs uppercase text-text/55">Generated</div>
                    <div className="mt-1 text-sm text-text">{formatDateTime(weeklyReport.generatedAt)}</div>
                  </div>
                  <div className="rounded border border-borderSoft/70 bg-panelSoft/55 p-3">
                    <div className="text-xs uppercase text-text/55">As of</div>
                    <div className="mt-1 text-sm text-text">{formatDateTime(weeklyReport.asOf)}</div>
                  </div>
                  <div className="rounded border border-borderSoft/70 bg-panelSoft/55 p-3">
                    <div className="text-xs uppercase text-text/55">Source</div>
                    <div className="mt-1 text-sm text-text">{weeklyProviderLabel(weeklyReport)}</div>
                  </div>
                  <div className="rounded border border-borderSoft/70 bg-panelSoft/55 p-3">
                    <div className="text-xs uppercase text-text/55">Model</div>
                    <div className="mt-1 font-mono text-sm text-text">{weeklyReport.model}</div>
                  </div>
                  <div className="rounded border border-borderSoft/70 bg-panelSoft/55 p-3">
                    <div className="text-xs uppercase text-text/55">Market tone</div>
                    <div className="mt-1 text-sm text-text">{weeklyReport.marketTone ?? "N/A"}</div>
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <TabButton active={tab === "report"} onClick={() => setTab("report")} icon={<FileText className="h-4 w-4" />}>Report</TabButton>
                <TabButton active={tab === "sources"} onClick={() => setTab("sources")} icon={<ExternalLink className="h-4 w-4" />}>Sources</TabButton>
                <TabButton active={tab === "quality"} onClick={() => setTab("quality")} icon={<Database className="h-4 w-4" />}>Data Quality</TabButton>
              </div>

              {tab === "report" && (
                <div className="max-h-[760px] overflow-auto rounded border border-borderSoft/70 bg-panel p-4 shadow-sm">
                  <MarkdownReport markdown={activeMarkdown ?? ""} />
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
