"use client";

import type {
  ResearchLabProfileDetail,
  ResearchLabRunListRow,
  ResearchLabRunResultsResponse,
  ResearchLabRunStatusResponse,
} from "@/lib/research-lab-api";

type Props = {
  profiles: ResearchLabProfileDetail[];
  selectedProfileId: string | null;
  onProfileChange: (value: string) => void;
  sourceBasis: "compiled" | "unique";
  onSourceBasisChange: (value: "compiled" | "unique") => void;
  maxTickers: number;
  onMaxTickersChange: (value: number) => void;
  selectedCount: number;
  visibleCount: number;
  isRunning: boolean;
  onRun: () => void;
  runs: ResearchLabRunListRow[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  selectedRunStatus: ResearchLabRunStatusResponse | null;
  selectedRunResults: ResearchLabRunResultsResponse | null;
  stoppingRun?: boolean;
  onStopRun?: () => void;
  manualTickerInput: string;
  onManualTickerInputChange: (value: string) => void;
  onRunManual: () => void;
};

function runBadge(status: string) {
  if (status === "completed") return "text-pos";
  if (status === "partial") return "text-amber-400";
  if (status === "failed") return "text-neg";
  if (status === "cancelled") return "text-slate-400";
  return "text-accent";
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
  }).format(parsed);
}

export function WatchlistResearchPanel(props: Props) {
  const selectedRunIsLive = Boolean(
    props.selectedRunStatus
    && (props.selectedRunStatus.run.status === "queued" || props.selectedRunStatus.run.status === "running"),
  );
  const selectedRunCompleted = props.selectedRunResults?.items.filter((row) => row.item.status === "completed").length ?? 0;

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">Research Lab</h3>
          <p className="text-xs text-slate-400">
            Run the research-lab evidence and synthesis flow against tickers from this watchlist set.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectedRunIsLive && props.onStopRun ? (
            <button
              className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm font-semibold text-red-200 disabled:opacity-60"
              disabled={props.stoppingRun}
              onClick={props.onStopRun}
              type="button"
            >
              {props.stoppingRun ? "Stopping..." : "Stop Run"}
            </button>
          ) : null}
          <button
            className="rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent disabled:opacity-50"
            disabled={props.isRunning || props.visibleCount === 0}
            onClick={props.onRun}
            type="button"
          >
            {props.isRunning ? "Research Running..." : `Run Research (${props.selectedCount > 0 ? props.selectedCount : Math.min(props.visibleCount, props.maxTickers)})`}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <label className="text-xs text-slate-300">
          Profile
          <select
            className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm"
            value={props.selectedProfileId ?? ""}
            onChange={(event) => props.onProfileChange(event.target.value)}
          >
            {props.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}{profile.isDefault ? " (Default)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-300">
          Source Basis
          <select
            className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm"
            value={props.sourceBasis}
            onChange={(event) => props.onSourceBasisChange(event.target.value as "compiled" | "unique")}
          >
            <option value="unique">Unique Tickers</option>
            <option value="compiled">Compiled Rows</option>
          </select>
        </label>
        <label className="text-xs text-slate-300">
          Max Tickers
          <input
            className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm"
            min={1}
            max={20}
            type="number"
            value={props.maxTickers}
            onChange={(event) => props.onMaxTickersChange(Number(event.target.value || 1))}
          />
        </label>
      </div>

      <div className="mt-3 rounded-xl border border-borderSoft/60 bg-panelSoft/50 p-3 text-xs text-slate-400">
        {props.selectedCount > 0
          ? `${props.selectedCount} ticker${props.selectedCount === 1 ? "" : "s"} selected for the next run.`
          : `No explicit selection yet. The next run will use up to ${Math.min(props.visibleCount, props.maxTickers)} visible ticker${Math.min(props.visibleCount, props.maxTickers) === 1 ? "" : "s"}.`}
      </div>

      {props.selectedRunStatus ? (
        <div className="mt-4 rounded-xl border border-borderSoft/60 bg-panelSoft/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-200">
                {props.selectedRunStatus.profile?.name ?? "Research Lab Run"}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {props.selectedRunStatus.profileVersion ? `v${props.selectedRunStatus.profileVersion.versionNumber}` : "Unversioned"} ·
                {" "}{selectedRunCompleted}/{props.selectedRunStatus.run.requestedTickerCount} completed
              </div>
            </div>
            <div className={`text-xs font-semibold uppercase ${runBadge(props.selectedRunStatus.run.status)}`}>
              {props.selectedRunStatus.run.status}
            </div>
          </div>
          {props.selectedRunStatus.run.errorSummary ? (
            <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {props.selectedRunStatus.run.errorSummary}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 rounded-xl border border-borderSoft/60 bg-panelSoft/40 p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Manual Ticker Entry</div>
        <textarea
          className="min-h-24 w-full rounded border border-borderSoft bg-panel px-3 py-2 text-sm text-slate-200"
          placeholder={"Paste tickers here, separated by commas, spaces, or new lines\nNVDA, AMD, TSM"}
          value={props.manualTickerInput}
          onChange={(event) => props.onManualTickerInputChange(event.target.value)}
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500">This uses the same active research-lab profile, but it does not depend on the watchlist output tables.</p>
          <button
            className="rounded border border-borderSoft px-3 py-1.5 text-sm text-slate-300 disabled:opacity-50"
            disabled={props.isRunning || props.manualTickerInput.trim().length === 0}
            onClick={props.onRunManual}
            type="button"
          >
            Run Manual Tickers
          </button>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Recent Research Runs</h4>
          <span className="text-[11px] text-slate-500">{props.runs.length} shown</span>
        </div>
        <div className="space-y-2">
          {props.runs.map((row) => (
            <button
              key={row.run.id}
              className={`w-full rounded-xl border px-3 py-2 text-left ${props.selectedRunId === row.run.id ? "border-accent/60 bg-accent/10" : "border-borderSoft/60 bg-panelSoft/40 hover:bg-panelSoft/70"}`}
              onClick={() => props.onSelectRun(row.run.id)}
              type="button"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-slate-200">{row.profileName ?? "Research Lab Run"}</div>
                <div className={`text-xs font-semibold uppercase ${runBadge(row.run.status)}`}>{row.run.status}</div>
              </div>
              <div className="mt-1 text-xs text-slate-400">
                {formatTime(row.run.createdAt)} · {row.run.completedTickerCount}/{row.run.requestedTickerCount} complete
              </div>
            </button>
          ))}
          {props.runs.length === 0 ? <p className="text-xs text-slate-400">No research-lab runs for this watchlist set yet.</p> : null}
        </div>
      </div>
    </section>
  );
}
