"use client";

import type { ResearchProfileRow, ResearchRefreshMode, ResearchRankingMode, ResearchRunListRow } from "@/lib/api";

type Props = {
  profiles: ResearchProfileRow[];
  selectedProfileId: string | null;
  onProfileChange: (value: string) => void;
  sourceBasis: "compiled" | "unique";
  onSourceBasisChange: (value: "compiled" | "unique") => void;
  refreshMode: ResearchRefreshMode;
  onRefreshModeChange: (value: ResearchRefreshMode) => void;
  rankingMode: ResearchRankingMode;
  onRankingModeChange: (value: ResearchRankingMode) => void;
  maxTickers: number;
  onMaxTickersChange: (value: number) => void;
  deepDiveTopN: number;
  onDeepDiveTopNChange: (value: number) => void;
  selectedCount: number;
  visibleCount: number;
  isRunning: boolean;
  onRun: () => void;
  runs: ResearchRunListRow[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
};

function runBadge(status: string) {
  if (status === "completed") return "text-pos";
  if (status === "partial") return "text-amber-400";
  if (status === "failed") return "text-neg";
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
  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">AI Research</h3>
          <p className="text-xs text-slate-400">
            Run evidence-first research on selected or visible tickers from this watchlist set.
          </p>
        </div>
        <button
          className="rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent disabled:opacity-50"
          disabled={props.isRunning || props.visibleCount === 0}
          onClick={props.onRun}
          type="button"
        >
          {props.isRunning ? "Research Running..." : `Run Research (${props.selectedCount > 0 ? props.selectedCount : Math.min(props.visibleCount, props.maxTickers)})`}
        </button>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-5">
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
          Refresh Mode
          <select
            className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm"
            value={props.refreshMode}
            onChange={(event) => props.onRefreshModeChange(event.target.value as ResearchRefreshMode)}
          >
            <option value="reuse_fresh_search_cache">Reuse Fresh Search Cache</option>
            <option value="force_fresh">Force Fresh Retrieval</option>
          </select>
        </label>
        <label className="text-xs text-slate-300">
          Ranking Mode
          <select
            className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm"
            value={props.rankingMode}
            onChange={(event) => props.onRankingModeChange(event.target.value as ResearchRankingMode)}
          >
            <option value="rank_only">Rank Only</option>
            <option value="rank_and_deep_dive">Rank + Deep Dive</option>
          </select>
        </label>
        <label className="text-xs text-slate-300">
          Max Tickers
          <input
            className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm"
            min={1}
            max={100}
            type="number"
            value={props.maxTickers}
            onChange={(event) => props.onMaxTickersChange(Number(event.target.value || 1))}
          />
        </label>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr),12rem]">
        <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/50 p-3 text-xs text-slate-400">
          {props.selectedCount > 0
            ? `${props.selectedCount} ticker${props.selectedCount === 1 ? "" : "s"} selected for the next run.`
            : `No explicit selection yet. The next run will use up to ${Math.min(props.visibleCount, props.maxTickers)} visible ticker${Math.min(props.visibleCount, props.maxTickers) === 1 ? "" : "s"}.`}
        </div>
        <label className="text-xs text-slate-300">
          Deep Dive Top N
          <input
            className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm"
            min={0}
            max={20}
            type="number"
            value={props.deepDiveTopN}
            onChange={(event) => props.onDeepDiveTopNChange(Number(event.target.value || 0))}
          />
        </label>
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
                <div className="text-sm font-semibold text-slate-200">{row.profileName ?? "Research Run"}</div>
                <div className={`text-xs font-semibold uppercase ${runBadge(row.run.status)}`}>{row.run.status}</div>
              </div>
              <div className="mt-1 text-xs text-slate-400">
                {formatTime(row.run.createdAt)} · {row.run.completedTickerCount}/{row.run.requestedTickerCount} complete
              </div>
            </button>
          ))}
          {props.runs.length === 0 && <p className="text-xs text-slate-400">No research runs for this watchlist set yet.</p>}
        </div>
      </div>
    </section>
  );
}
