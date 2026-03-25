"use client";

import type { ResearchRunResultsResponse, ResearchRunStatusResponse } from "@/lib/api";

type Props = {
  status: ResearchRunStatusResponse | null;
  results?: ResearchRunResultsResponse | null;
  compact?: boolean;
  stopping?: boolean;
  onStop?: () => void;
};

type StageState = "pending" | "active" | "completed" | "disabled" | "error";

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

function fmtValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Math.abs(value) >= 1000) return value.toLocaleString();
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return "-";
}

function stageTone(state: StageState) {
  if (state === "completed") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-100";
  if (state === "active") return "border-accent/40 bg-accent/10 text-slate-100";
  if (state === "error") return "border-red-500/30 bg-red-500/10 text-red-100";
  if (state === "disabled") return "border-borderSoft/50 bg-panelSoft/30 text-slate-500";
  return "border-borderSoft/60 bg-panelSoft/40 text-slate-300";
}

function badgeTone(kind: "live" | "fallback" | "model" | "neutral" | "success" | "error") {
  if (kind === "live") return "border-accent/40 bg-accent/10 text-accent";
  if (kind === "fallback") return "border-amber-500/30 bg-amber-500/10 text-amber-200";
  if (kind === "success") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (kind === "error") return "border-red-500/30 bg-red-500/10 text-red-200";
  if (kind === "model") return "border-sky-500/30 bg-sky-500/10 text-sky-200";
  return "border-borderSoft/60 bg-panelSoft/40 text-slate-300";
}

function normalizeModelLabel(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (value === "rules") return "Rules fallback";
  return value;
}

function summarizeUsage(usage: Record<string, unknown> | null | undefined) {
  if (!usage) return [];
  return Object.entries(usage)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .slice(0, 6);
}

function readWarningList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
}

function readActivityList(value: unknown): Array<{ at: string | null; level: string; message: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = item as { at?: unknown; level?: unknown; message?: unknown } | null | undefined;
      const message = typeof record?.message === "string" ? record.message.trim() : "";
      if (!message) return null;
      return {
        at: typeof record?.at === "string" && record.at.trim() ? record.at : null,
        level: record?.level === "warn" || record?.level === "error" ? String(record.level) : "info",
        message,
      };
    })
    .filter((item): item is { at: string | null; level: string; message: string } => Boolean(item));
}

function activityTone(level: string) {
  if (level === "error") return "border-red-500/20 bg-red-500/10 text-red-100";
  if (level === "warn") return "border-amber-500/20 bg-amber-500/10 text-amber-100/90";
  return "border-borderSoft/50 bg-panelSoft/35 text-slate-200";
}

function formatTickerStatus(status: string) {
  return status.replace(/_/g, " ");
}

export function ResearchRunStagePanel({ status, results, compact = false, stopping = false, onStop }: Props) {
  if (!status) return null;

  const tickers = status.tickers ?? [];
  const requested = Math.max(status.run.requestedTickerCount ?? tickers.length, tickers.length, 1);
  const completed = tickers.filter((row) => row.status === "completed").length;
  const failed = tickers.filter((row) => row.status === "failed").length;
  const retrieving = tickers.filter((row) => row.status === "retrieving").length;
  const extracting = tickers.filter((row) => row.status === "extracting").length;
  const rankingReady = tickers.filter((row) => row.status === "ranking_ready").length;
  const deepDiving = tickers.filter((row) => row.status === "deep_dive").length;
  const evidenceReady = tickers.filter((row) => typeof row.stageMetricsJson?.evidenceCount === "number" || row.status !== "queued").length;
  const extractedReady = tickers.filter((row) => Boolean(row.workingJson?.card)).length;
  const rankableTickers = tickers.filter((row) => row.status !== "failed" && Boolean(row.workingJson?.card)).length;
  const extractionModels = Array.from(new Set(
    tickers
      .map((row) => normalizeModelLabel(row.workingJson?.extractionModel))
      .filter((value): value is string => Boolean(value)),
  ));
  const deepDiveEnabled = status.run.rankingMode === "rank_and_deep_dive" && status.run.deepDiveTopN > 0;
  const deepDiveCompleted = tickers.filter((row) => Boolean(row.workingJson?.deepDive)).length;
  const rankingCount = results?.results?.length ?? 0;
  const rankingAvailable = rankingCount > 0;
  const runWarnings = readWarningList(results?.warnings ?? status.run.provenanceJson?.warnings);
  const runActivity = readActivityList(status.run.provenanceJson?.activity).slice().reverse().slice(0, 8);
  const extractionWarnings = tickers.flatMap((row) => readWarningList(row.workingJson?.warnings));
  const rankingWarnings = runWarnings.filter((warning) => /ranking/i.test(warning));
  const deepDiveWarnings = runWarnings.filter((warning) => /deep-dive/i.test(warning));
  const isTerminal = ["completed", "partial", "failed", "cancelled"].includes(status.run.status);
  const lastUpdated = status.run.heartbeatAt ?? status.run.updatedAt ?? status.run.createdAt;
  const lastUpdatedMs = lastUpdated ? new Date(lastUpdated).getTime() : Number.NaN;
  const isStalled = !isTerminal && Number.isFinite(lastUpdatedMs) && (Date.now() - lastUpdatedMs) > 180_000;
  const isLive = !isTerminal && !isStalled;
  const expectedRankingCount = Math.max(0, rankableTickers);
  const expectedDeepDiveCount = deepDiveEnabled ? Math.min(status.run.deepDiveTopN, expectedRankingCount) : 0;

  const retrievalState: StageState = evidenceReady === 0
    ? retrieving > 0 ? "active" : "pending"
    : evidenceReady >= requested ? "completed" : "active";
  const extractionState: StageState = extractedReady === 0
    ? extracting > 0 ? "active" : "pending"
    : extractedReady >= requested - failed ? "completed" : "active";
  const rankingState: StageState = expectedRankingCount > 0 && rankingCount >= expectedRankingCount
    ? "completed"
    : rankingReady > 0 || deepDiving > 0 || isLive
      ? "active"
      : (isTerminal || isStalled) && expectedRankingCount > rankingCount
        ? "error"
        : "pending";
  const deepDiveState: StageState = !deepDiveEnabled
    ? "disabled"
    : expectedDeepDiveCount > 0 && deepDiveCompleted >= expectedDeepDiveCount
      ? "completed"
      : deepDiving > 0 || isLive
        ? "active"
        : (isTerminal || isStalled) && expectedDeepDiveCount > deepDiveCompleted
          ? "error"
          : "pending";

  const usageRows = summarizeUsage(results?.providerUsage ?? status.run.providerUsageJson);

  const stages = [
    {
      key: "retrieval",
      label: "Retrieval",
      description: `${evidenceReady}/${requested} tickers gathered evidence`,
      detail: retrieving > 0 ? `${retrieving} currently retrieving` : "SEC + Perplexity evidence collection",
      state: retrievalState,
    },
    {
      key: "extraction",
      label: "Extraction",
      description: `${extractedReady}/${requested} tickers standardized`,
      detail: extractionWarnings[0] ?? extractionModels[0] ?? "Anthropic Haiku or rules fallback",
      state: extractionState,
    },
    {
      key: "ranking",
      label: "Ranking",
      description: `${rankingCount}/${expectedRankingCount} ranked result(s) stored`,
      detail: rankingWarnings[0] ?? (rankingState === "error" ? "Some extracted tickers never reached a persisted ranking result." : "Run-level synthesis and ordering"),
      state: rankingState,
    },
    {
      key: "deep-dive",
      label: "Deep Dive",
      description: !deepDiveEnabled ? "Disabled for this run" : `${deepDiveCompleted}/${expectedDeepDiveCount} deep dives stored`,
      detail: deepDiveEnabled ? (deepDiveWarnings[0] ?? (deepDiveState === "error" ? "Some ranked tickers never finished deep-dive persistence." : "Top ranked tickers receive final synthesis")) : "Switch ranking mode to enable",
      state: deepDiveState,
    },
  ];

  return (
    <div className={`rounded-xl border border-borderSoft/60 bg-panelSoft/45 ${compact ? "p-3" : "p-4"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Run Stages</div>
          <p className="mt-1 text-sm text-slate-300">
            {isStalled
              ? "This run has not reported progress recently and may be stalled."
              : isLive
                ? "This panel updates automatically while the run is in progress."
                : "Most recent run-stage summary."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {isLive && onStop ? (
            <button
              className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-1 font-semibold text-red-200 disabled:opacity-60"
              disabled={stopping}
              onClick={onStop}
              type="button"
            >
              {stopping ? "Stopping..." : "Stop Run"}
            </button>
          ) : null}
          <span className={`rounded-full border px-2 py-1 font-semibold ${badgeTone(isStalled ? "error" : isLive ? "live" : "neutral")}`}>
            {isStalled ? "Stalled" : isLive ? "Live" : status.run.status}
          </span>
          <span className={`rounded-full border px-2 py-1 ${badgeTone("neutral")}`}>
            {completed}/{requested} complete
          </span>
          <span className={`rounded-full border px-2 py-1 ${badgeTone(failed > 0 ? "error" : "neutral")}`}>
            {failed} failed
          </span>
          <span className={`rounded-full border px-2 py-1 ${badgeTone("neutral")}`}>
            Updated {formatTime(lastUpdated)}
          </span>
        </div>
      </div>

      <div className={`mt-4 grid gap-3 ${compact ? "md:grid-cols-2 xl:grid-cols-4" : "xl:grid-cols-4"}`}>
        {stages.map((stage) => (
          <div key={stage.key} className={`rounded-xl border p-3 ${stageTone(stage.state)}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold uppercase tracking-[0.14em]">{stage.label}</div>
              <div className="text-[11px] uppercase opacity-80">{stage.state}</div>
            </div>
            <div className="mt-2 text-sm font-semibold">{stage.description}</div>
            <div className="mt-1 text-xs opacity-85">{stage.detail}</div>
          </div>
        ))}
      </div>

      <div className={`mt-4 grid gap-3 ${compact ? "xl:grid-cols-[minmax(0,1.2fr),minmax(16rem,0.8fr)]" : "xl:grid-cols-[minmax(0,1.4fr),minmax(18rem,1fr)]"}`}>
        <div className="rounded-xl border border-borderSoft/60 bg-panel px-3 py-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Live Ticker Status</div>
              <div className="text-[11px] text-slate-500">
                {deepDiving > 0
                  ? `${deepDiving} generating deep dive`
                  : extracting > 0
                    ? `${extracting} extracting`
                    : retrieving > 0
                      ? `${retrieving} retrieving`
                      : rankingReady > 0
                        ? `${rankingReady} awaiting finalization`
                        : isStalled
                          ? "Run appears stalled"
                          : "No active ticker stage"}
              </div>
            </div>
          <div className="space-y-2">
            {tickers.map((row) => {
              const evidenceCount = typeof row.stageMetricsJson?.evidenceCount === "number" ? row.stageMetricsJson.evidenceCount : null;
              const warningCount = typeof row.stageMetricsJson?.warningCount === "number" ? row.stageMetricsJson.warningCount : null;
              const extractionModel = normalizeModelLabel(row.workingJson?.extractionModel);
              const hasDeepDive = Boolean(row.workingJson?.deepDive);
              const rowWarnings = readWarningList(row.workingJson?.warnings);
              const rowActivity = readActivityList(row.stageMetricsJson?.activity).slice().reverse().slice(0, 4);
              const currentStep = typeof row.stageMetricsJson?.currentStep === "string" ? row.stageMetricsJson.currentStep : null;
              const maxAttempts = typeof row.stageMetricsJson?.maxAttempts === "number" ? row.stageMetricsJson.maxAttempts : null;
              return (
                <div key={row.id} className="rounded-lg border border-borderSoft/50 bg-panelSoft/40 px-3 py-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-accent">{row.ticker}</div>
                      <div className="text-[11px] text-slate-500">{row.companyName ?? row.exchange ?? "Ticker queued"}</div>
                    </div>
                    <div className={`rounded-full border px-2 py-1 text-[11px] font-semibold uppercase ${badgeTone(
                      row.status === "failed" ? "error"
                        : row.status === "completed" ? "success"
                          : row.status === "extracting" || row.status === "retrieving" || row.status === "ranking_ready" || row.status === "deep_dive" ? "live"
                            : "neutral",
                    )}`}>
                      {formatTickerStatus(row.status)}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                    <span className={`rounded-full border px-2 py-1 ${badgeTone("neutral")}`}>
                      {row.attemptCount > 1 ? "Retry" : "Attempt"} {row.attemptCount}{maxAttempts ? `/${maxAttempts}` : ""}
                    </span>
                    {evidenceCount !== null ? (
                      <span className={`rounded-full border px-2 py-1 ${badgeTone("neutral")}`}>{evidenceCount} evidence</span>
                    ) : null}
                    {warningCount && warningCount > 0 ? (
                      <span className={`rounded-full border px-2 py-1 ${badgeTone("fallback")}`}>{warningCount} warning{warningCount === 1 ? "" : "s"}</span>
                    ) : null}
                    {extractionModel ? (
                      <span className={`rounded-full border px-2 py-1 ${badgeTone(extractionModel === "Rules fallback" ? "fallback" : "model")}`}>
                        Extract {extractionModel}
                      </span>
                    ) : null}
                    {hasDeepDive ? (
                      <span className={`rounded-full border px-2 py-1 ${badgeTone("success")}`}>Deep dive ready</span>
                    ) : null}
                  </div>
                  {currentStep ? (
                    <div className="mt-2 text-xs text-slate-300">{currentStep}</div>
                  ) : null}
                  {row.lastError ? (
                    <div className="mt-2 rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-2 text-xs text-red-100">
                      {row.lastError}
                    </div>
                  ) : null}
                  {rowWarnings.length > 0 ? (
                    <div className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-2">
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-200">LLM / Fallback Logs</div>
                      <div className="space-y-1 text-xs text-amber-100/90">
                        {rowWarnings.map((warning) => (
                          <div key={warning}>{warning}</div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {rowActivity.length > 0 ? (
                    <div className="mt-2 rounded-lg border border-borderSoft/50 bg-panel px-2.5 py-2">
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Activity</div>
                      <div className="space-y-1">
                        {rowActivity.map((entry, index) => (
                          <div key={`${row.id}-activity-${index}`} className={`rounded-md border px-2 py-1.5 text-xs ${activityTone(entry.level)}`}>
                            <div>{entry.message}</div>
                            {entry.at ? (
                              <div className="mt-1 text-[10px] opacity-70">{formatTime(entry.at)}</div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {tickers.length === 0 ? (
              <p className="text-sm text-slate-400">No ticker-level progress has been recorded for this run yet.</p>
            ) : null}
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-xl border border-borderSoft/60 bg-panel px-3 py-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Run Settings</div>
            <div className="grid gap-2 text-sm text-slate-300">
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Ranking mode</span>
                <span>{status.run.rankingMode}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Refresh mode</span>
                <span>{status.run.refreshMode}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Deep dive top N</span>
                <span>{status.run.deepDiveTopN}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Requested tickers</span>
                <span>{status.run.requestedTickerCount}</span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-borderSoft/60 bg-panel px-3 py-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Provider Usage</div>
            <div className="space-y-2">
              {usageRows.map(([key, value]) => (
                <div key={key} className="flex items-center justify-between gap-3 text-sm text-slate-300">
                  <span className="truncate text-slate-500">{key}</span>
                  <span>{fmtValue(value)}</span>
                </div>
              ))}
              {usageRows.length === 0 ? (
                <p className="text-sm text-slate-400">No provider usage has been recorded yet for this run.</p>
              ) : null}
            </div>
          </div>

          <div className="rounded-xl border border-borderSoft/60 bg-panel px-3 py-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">LLM / Fallback Logs</div>
            <div className="space-y-2">
              {runWarnings.map((warning) => (
                <div key={warning} className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-100/90">
                  {warning}
                </div>
              ))}
              {runWarnings.length === 0 ? (
                <p className="text-sm text-slate-400">No run-level LLM warnings have been recorded yet.</p>
              ) : null}
            </div>
          </div>

          <div className="rounded-xl border border-borderSoft/60 bg-panel px-3 py-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Activity Feed</div>
            <div className="space-y-2">
              {runActivity.map((entry, index) => (
                <div key={`run-activity-${index}`} className={`rounded-lg border px-2.5 py-2 text-xs ${activityTone(entry.level)}`}>
                  <div>{entry.message}</div>
                  {entry.at ? (
                    <div className="mt-1 text-[10px] opacity-70">{formatTime(entry.at)}</div>
                  ) : null}
                </div>
              ))}
              {runActivity.length === 0 ? (
                <p className="text-sm text-slate-400">No run-level activity has been recorded yet.</p>
              ) : null}
            </div>
          </div>

          {extractionModels.length > 0 ? (
            <div className="rounded-xl border border-borderSoft/60 bg-panel px-3 py-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Observed Models</div>
              <div className="flex flex-wrap gap-2">
                {extractionModels.map((model) => (
                  <span
                    key={model}
                    className={`rounded-full border px-2 py-1 text-[11px] ${badgeTone(model === "Rules fallback" ? "fallback" : "model")}`}
                  >
                    {model}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
