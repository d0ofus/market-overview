"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Play, RefreshCw } from "lucide-react";
import { apiUrl } from "@/lib/api";
import {
  cancelResearchLabRun,
  createResearchLabRun,
  getResearchLabRunResults,
  getResearchLabRuns,
  getResearchLabRunStatus,
  type ResearchLabRunEventRecord,
  type ResearchLabRunItemResult,
  type ResearchLabRunListRow,
  type ResearchLabRunResultsResponse,
  type ResearchLabRunStatusResponse,
} from "@/lib/research-lab-api";

function parseTickerInput(input: string) {
  return Array.from(new Set(
    input
      .split(/[\s,;\n\r\t]+/)
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean)
      .filter((value) => /^[A-Z.\-]{1,12}$/.test(value)),
  ));
}

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

export function ResearchLabDashboard() {
  const [tickerInput, setTickerInput] = useState("");
  const [runs, setRuns] = useState<ResearchLabRunListRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<ResearchLabRunStatusResponse | null>(null);
  const [results, setResults] = useState<ResearchLabRunResultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  const selectedRun = useMemo(
    () => runs.find((row) => row.run.id === selectedRunId)?.run ?? status?.run ?? null,
    [runs, selectedRunId, status],
  );

  const applyPayload = (statusPayload: ResearchLabRunStatusResponse, resultsPayload: ResearchLabRunResultsResponse) => {
    setStatus(statusPayload);
    setResults(resultsPayload);
    setRuns((current) => {
      const row: ResearchLabRunListRow = {
        run: statusPayload.run,
        promptConfigName: statusPayload.promptConfig?.name ?? null,
        evidenceProfileName: statusPayload.evidenceProfile?.name ?? null,
      };
      const index = current.findIndex((entry) => entry.run.id === row.run.id);
      if (index >= 0) {
        const next = [...current];
        next[index] = row;
        return next;
      }
      return [row, ...current].slice(0, 10);
    });
  };

  const loadRuns = async (preferredRunId?: string | null) => {
    setLoading(true);
    try {
      const response = await getResearchLabRuns(10);
      const rows = response.rows ?? [];
      setRuns(rows);
      const nextRunId = preferredRunId ?? selectedRunId ?? rows[0]?.run.id ?? null;
      setSelectedRunId(nextRunId);
      if (nextRunId) {
        const [statusPayload, resultsPayload] = await Promise.all([
          getResearchLabRunStatus(nextRunId),
          getResearchLabRunResults(nextRunId),
        ]);
        applyPayload(statusPayload, resultsPayload);
      } else {
        setStatus(null);
        setResults(null);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load research lab runs.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRuns();
  }, []);

  useEffect(() => {
    if (!selectedRunId) return;
    let cancelled = false;
    (async () => {
      try {
        const [statusPayload, resultsPayload] = await Promise.all([
          getResearchLabRunStatus(selectedRunId),
          getResearchLabRunResults(selectedRunId),
        ]);
        if (cancelled) return;
        applyPayload(statusPayload, resultsPayload);
      } catch (error) {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : "Failed to load research lab run.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId || !selectedRun || !["queued", "running"].includes(selectedRun.status)) return;
    const eventSource = new EventSource(apiUrl(`/api/research-lab/runs/${encodeURIComponent(selectedRunId)}/stream`));
    setStreamError(null);

    eventSource.addEventListener("update", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          status: ResearchLabRunStatusResponse;
          results: ResearchLabRunResultsResponse;
        };
        applyPayload(payload.status, payload.results);
      } catch (error) {
        setStreamError(error instanceof Error ? error.message : "Failed to parse stream update.");
      }
    });
    eventSource.addEventListener("error", (event) => {
      const raw = (event as MessageEvent<string>).data;
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { error?: string };
          setStreamError(parsed.error ?? "Research lab stream failed.");
        } catch {
          setStreamError("Research lab stream failed.");
        }
      }
    });
    eventSource.addEventListener("done", () => {
      eventSource.close();
      void loadRuns(selectedRunId);
    });

    return () => {
      eventSource.close();
    };
  }, [selectedRunId, selectedRun?.status]);

  const globalEvents = useMemo(
    () => sortEvents(status?.events ?? []),
    [status?.events],
  );

  const startRun = async () => {
    const tickers = parseTickerInput(tickerInput);
    if (tickers.length === 0) {
      setMessage("Enter at least one valid US ticker.");
      return;
    }
    setStarting(true);
    setMessage(null);
    try {
      const response = await createResearchLabRun({ tickers });
      setSelectedRunId(response.run.id);
      setTickerInput(tickers.join(", "));
      await loadRuns(response.run.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to start research lab run.");
    } finally {
      setStarting(false);
    }
  };

  const stopRun = async () => {
    if (!selectedRunId) return;
    setCancelling(true);
    setMessage(null);
    try {
      await cancelResearchLabRun(selectedRunId);
      await loadRuns(selectedRunId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to cancel research lab run.");
    } finally {
      setCancelling(false);
    }
  };

  const itemResults = useMemo(
    () => results?.items ?? [],
    [results?.items],
  );

  return (
    <div className="space-y-6">
      <section className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
        <div className="rounded-3xl border border-borderSoft/70 bg-panel/90 p-5 shadow-soft">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-accent/80">Research Lab</p>
              <h3 className="mt-2 text-2xl font-semibold text-text">Run isolated stock research</h3>
              <p className="mt-2 max-w-2xl text-sm text-slate-400">
                Enter comma-separated US equity tickers to run a fresh Perplexity gather followed by Claude Sonnet synthesis.
                This lab path records every stage, persists evidence and outputs, and fails explicitly when a provider response is unusable.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadRuns(selectedRunId)}
              className="inline-flex items-center gap-2 rounded-xl border border-borderSoft/80 bg-panelSoft/80 px-3 py-2 text-sm text-slate-200 transition hover:border-accent/40 hover:text-text"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
          <div className="mt-5 flex flex-col gap-3">
            <label className="text-xs uppercase tracking-[0.24em] text-slate-500">Tickers</label>
            <input
              value={tickerInput}
              onChange={(event) => setTickerInput(event.target.value)}
              placeholder="AAPL, MSFT, NVDA"
              className="h-12 rounded-2xl border border-borderSoft/80 bg-panelSoft/70 px-4 text-sm text-text outline-none transition focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
            />
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void startRun()}
                disabled={starting}
                className="inline-flex items-center gap-2 rounded-2xl bg-accent px-4 py-2 text-sm font-medium text-slate-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Start Run
              </button>
              {selectedRun && ["queued", "running"].includes(selectedRun.status) ? (
                <button
                  type="button"
                  onClick={() => void stopRun()}
                  disabled={cancelling}
                  className="inline-flex items-center gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-2 text-sm font-medium text-rose-100 transition hover:border-rose-300/50 hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" />}
                  Stop Run
                </button>
              ) : null}
              <p className="text-xs text-slate-500">
                Sequential processing, no fallback output, schema-validated synthesis only.
              </p>
            </div>
            {message ? (
              <div className="rounded-2xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                {message}
              </div>
            ) : null}
            {streamError ? (
              <div className="rounded-2xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                {streamError}
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-3xl border border-borderSoft/70 bg-panel/90 p-5 shadow-soft">
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Recent Runs</p>
          <div className="mt-4 space-y-3">
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading runs...
              </div>
            ) : runs.length === 0 ? (
              <p className="text-sm text-slate-400">No research lab runs yet.</p>
            ) : runs.map((row) => (
              <button
                key={row.run.id}
                type="button"
                onClick={() => setSelectedRunId(row.run.id)}
                className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                  row.run.id === selectedRunId
                    ? "border-accent/40 bg-accent/10"
                    : "border-borderSoft/70 bg-panelSoft/60 hover:border-accent/20"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-text">
                      {Array.isArray(row.run.inputJson?.tickers)
                        ? (row.run.inputJson?.tickers as string[]).join(", ")
                        : row.run.id}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">{formatTime(row.run.createdAt)}</div>
                  </div>
                  <span className={`rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] ${statusTone(row.run.status)}`}>
                    {row.run.status}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </section>

      {selectedRun ? (
        <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-3xl border border-borderSoft/70 bg-panel/90 p-5 shadow-soft">
            <div className="flex flex-wrap items-center gap-3">
              <span className={`rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.18em] ${statusTone(selectedRun.status)}`}>
                {selectedRun.status}
              </span>
              <span className="text-sm text-slate-400">Run {selectedRun.id.slice(0, 8)}</span>
              <span className="text-sm text-slate-500">Started {formatTime(selectedRun.startedAt ?? selectedRun.createdAt)}</span>
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/60 p-4">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Requested</p>
                <p className="mt-2 text-2xl font-semibold text-text">{selectedRun.requestedTickerCount}</p>
              </div>
              <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/60 p-4">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Completed</p>
                <p className="mt-2 text-2xl font-semibold text-emerald-200">{selectedRun.completedTickerCount}</p>
              </div>
              <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/60 p-4">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Failed</p>
                <p className="mt-2 text-2xl font-semibold text-rose-200">{selectedRun.failedTickerCount}</p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/60 p-4 text-sm text-slate-300">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Prompt</p>
                <p className="mt-2">{status?.promptConfig?.name ?? "-"}</p>
                <p className="mt-1 text-xs text-slate-500">{status?.promptConfig?.modelFamily ?? "-"}</p>
              </div>
              <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/60 p-4 text-sm text-slate-300">
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Evidence Profile</p>
                <p className="mt-2">{status?.evidenceProfile?.name ?? "-"}</p>
                <p className="mt-1 text-xs text-slate-500">{status?.evidenceProfile?.configFamily ?? "-"}</p>
              </div>
            </div>
            {selectedRun.errorSummary ? (
              <div className="mt-4 rounded-2xl border border-rose-400/25 bg-rose-500/10 p-4 text-sm text-rose-100">
                {selectedRun.errorSummary}
              </div>
            ) : null}
          </div>

          <div className="rounded-3xl border border-borderSoft/70 bg-panel/90 p-5 shadow-soft">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Run Event Feed</p>
            <div className="mt-4 max-h-[420px] space-y-3 overflow-auto pr-2">
              {globalEvents.length === 0 ? (
                <p className="text-sm text-slate-400">No events yet.</p>
              ) : globalEvents.map((event) => (
                <div key={event.id} className="rounded-2xl border border-borderSoft/70 bg-panelSoft/60 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm text-text">{event.message}</p>
                      <p className="mt-1 text-xs text-slate-500">{event.ticker ?? "run"} · {event.eventType}</p>
                    </div>
                    <span className="text-xs text-slate-500">{formatTime(event.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      <section className="space-y-4">
        {itemResults.length === 0 && selectedRun ? (
          <div className="rounded-3xl border border-borderSoft/70 bg-panel/90 p-6 text-sm text-slate-400 shadow-soft">
            Waiting for ticker artifacts.
          </div>
        ) : null}
        {itemResults.map((itemResult) => (
          <TickerResultCard key={itemResult.item.id} itemResult={itemResult} />
        ))}
      </section>
    </div>
  );
}

function TickerResultCard({ itemResult }: { itemResult: ResearchLabRunItemResult }) {
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
            Synth: {itemResult.item.synthModel ?? "-"} ({formatNumber(itemResult.item.synthLatencyMs)} ms)
          </p>
          {usageSummary ? <p className="mt-1 text-xs text-slate-500">{usageSummary}</p> : null}
        </div>
        {itemResult.item.lastError ? (
          <div className="inline-flex items-center gap-2 rounded-2xl border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
            <AlertTriangle className="h-4 w-4" />
            {itemResult.item.lastError}
          </div>
        ) : null}
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
