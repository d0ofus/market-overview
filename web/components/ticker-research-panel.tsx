"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createAdminResearchRun,
  getResearchProfiles,
  getResearchRunResults,
  getResearchRunStatus,
  getResearchSnapshot,
  getResearchSnapshotCompare,
  getTickerResearchHistory,
  type ResearchProfileRow,
  type ResearchRefreshMode,
  type ResearchRankingMode,
  type ResearchRunResultsResponse,
  type ResearchRunStatusResponse,
  type ResearchSnapshotCompareResponse,
  type ResearchSnapshotDetailResponse,
  type ResearchSnapshotRow,
} from "@/lib/api";
import { ResearchHistoryPanel } from "./research-history-panel";

type Props = {
  ticker: string;
};

function fmtScore(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "-";
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

export function TickerResearchPanel({ ticker }: Props) {
  const [profiles, setProfiles] = useState<ResearchProfileRow[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [history, setHistory] = useState<ResearchSnapshotRow[]>([]);
  const [latestDetail, setLatestDetail] = useState<ResearchSnapshotDetailResponse | null>(null);
  const [compare, setCompare] = useState<ResearchSnapshotCompareResponse | null>(null);
  const [baselineSnapshotId, setBaselineSnapshotId] = useState<string | null>(null);
  const [refreshMode, setRefreshMode] = useState<ResearchRefreshMode>("reuse_fresh_search_cache");
  const [rankingMode, setRankingMode] = useState<ResearchRankingMode>("rank_only");
  const [deepDiveTopN, setDeepDiveTopN] = useState(1);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunStatus, setActiveRunStatus] = useState<ResearchRunStatusResponse | null>(null);
  const [activeRunResults, setActiveRunResults] = useState<ResearchRunResultsResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const latestSnapshot = history[0] ?? null;

  const loadHistory = async (profileId?: string | null) => {
    const historyRes = await getTickerResearchHistory(ticker, profileId ?? undefined);
    const rows = historyRes.rows ?? [];
    setHistory(rows);
    const nextLatest = rows[0] ?? null;
    if (nextLatest) {
      const [detailRes, compareRes] = await Promise.all([
        getResearchSnapshot(nextLatest.id),
        getResearchSnapshotCompare(nextLatest.id, baselineSnapshotId),
      ]);
      setLatestDetail(detailRes);
      setCompare(compareRes);
    } else {
      setLatestDetail(null);
      setCompare(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const profilesRes = await getResearchProfiles();
        if (cancelled) return;
        const rows = profilesRes.rows ?? [];
        setProfiles(rows);
        const profileId = rows.find((row) => row.isDefault)?.id ?? rows[0]?.id ?? null;
        setSelectedProfileId(profileId);
        await loadHistory(profileId);
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Failed to load ticker research.");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  useEffect(() => {
    if (!selectedProfileId) return;
    void loadHistory(selectedProfileId);
  }, [selectedProfileId]);

  useEffect(() => {
    if (!latestSnapshot) return;
    let cancelled = false;
    const loadCompare = async () => {
      try {
        const compareRes = await getResearchSnapshotCompare(latestSnapshot.id, baselineSnapshotId);
        if (!cancelled) setCompare(compareRes);
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Failed to refresh comparison.");
      }
    };
    void loadCompare();
    return () => {
      cancelled = true;
    };
  }, [latestSnapshot?.id, baselineSnapshotId]);

  useEffect(() => {
    if (!activeRunId || !running) return;
    let cancelled = false;
    const loadRun = async () => {
      try {
        const [statusRes, resultsRes] = await Promise.all([
          getResearchRunStatus(activeRunId),
          getResearchRunResults(activeRunId),
        ]);
        if (cancelled) return;
        setActiveRunStatus(statusRes);
        setActiveRunResults(resultsRes);
        const isRunning = statusRes.run.status === "queued" || statusRes.run.status === "running";
        setRunning(isRunning);
        if (!isRunning) {
          await loadHistory(selectedProfileId);
        }
      } catch (error) {
        if (!cancelled) {
          setRunning(false);
          setMessage(error instanceof Error ? error.message : "Failed to poll research run.");
        }
      }
    };
    void loadRun();
    const timer = window.setInterval(() => {
      void loadRun();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeRunId, running, selectedProfileId, ticker]);

  const latestThesis = useMemo(() => latestDetail?.snapshot?.thesisJson ?? null, [latestDetail]);

  return (
    <section className="space-y-4">
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-200">AI Research</h3>
            <p className="text-xs text-slate-400">
              Run the same evidence-first research pipeline for {ticker} and compare how the thesis changes over time.
            </p>
          </div>
          <button
            className="rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent disabled:opacity-50"
            disabled={running || !selectedProfileId}
            onClick={async () => {
              try {
                setRunning(true);
                setMessage(null);
                const run = await createAdminResearchRun({
                  sourceType: "manual",
                  sourceLabel: `Ticker ${ticker}`,
                  tickers: [ticker],
                  profileId: selectedProfileId,
                  refreshMode,
                  rankingMode,
                  deepDiveTopN: rankingMode === "rank_and_deep_dive" ? Math.max(1, deepDiveTopN) : 0,
                });
                setActiveRunId(run.run.id);
                setMessage(`Research run started for ${ticker}.`);
              } catch (error) {
                setRunning(false);
                setMessage(error instanceof Error ? error.message : "Failed to start ticker research.");
              }
            }}
            type="button"
          >
            {running ? "Research Running..." : "Run Research"}
          </button>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <label className="text-xs text-slate-300">
            Profile
            <select
              className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm"
              value={selectedProfileId ?? ""}
              onChange={(event) => setSelectedProfileId(event.target.value)}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}{profile.isDefault ? " (Default)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-300">
            Refresh Mode
            <select
              className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm"
              value={refreshMode}
              onChange={(event) => setRefreshMode(event.target.value as ResearchRefreshMode)}
            >
              <option value="reuse_fresh_search_cache">Reuse Fresh Search Cache</option>
              <option value="force_fresh">Force Fresh Retrieval</option>
            </select>
          </label>
          <label className="text-xs text-slate-300">
            Ranking Mode
            <select
              className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm"
              value={rankingMode}
              onChange={(event) => setRankingMode(event.target.value as ResearchRankingMode)}
            >
              <option value="rank_only">Rank Only</option>
              <option value="rank_and_deep_dive">Rank + Deep Dive</option>
            </select>
          </label>
          <label className="text-xs text-slate-300">
            Deep Dive Top N
            <input
              className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm"
              min={0}
              max={5}
              type="number"
              value={deepDiveTopN}
              onChange={(event) => setDeepDiveTopN(Number(event.target.value || 0))}
            />
          </label>
        </div>

        {message && <p className="mt-3 text-xs text-slate-400">{message}</p>}
        {activeRunStatus && (
          <div className="mt-3 rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-3 text-xs text-slate-400">
            Latest run status: <span className="font-semibold text-slate-200">{activeRunStatus.run.status}</span>
            {" · "}
            {activeRunStatus.run.completedTickerCount}/{activeRunStatus.run.requestedTickerCount} complete
            {activeRunResults?.results?.[0]?.summary ? (
              <>
                {" · "}
                <span className="text-slate-300">{activeRunResults.results[0].summary}</span>
              </>
            ) : null}
          </div>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr),minmax(18rem,1fr)]">
        <div className="space-y-4">
          <div className="card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-slate-200">Latest Snapshot</h4>
              <span className="text-xs text-slate-500">{latestSnapshot ? formatTime(latestSnapshot.createdAt) : "No history yet"}</span>
            </div>
            {latestSnapshot ? (
              <>
                <div className="grid gap-3 md:grid-cols-4">
                  <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Score</div>
                    <div className="mt-1 text-2xl font-semibold text-slate-100">{fmtScore(latestSnapshot.overallScore)}</div>
                  </div>
                  <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Confidence</div>
                    <div className="mt-1 text-2xl font-semibold text-slate-100">{latestSnapshot.confidenceLabel ?? "-"}</div>
                  </div>
                  <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Valuation</div>
                    <div className="mt-1 text-2xl font-semibold text-slate-100">{latestSnapshot.valuationLabel ?? "-"}</div>
                  </div>
                  <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Earnings</div>
                    <div className="mt-1 text-2xl font-semibold text-slate-100">{latestSnapshot.earningsQualityLabel ?? "-"}</div>
                  </div>
                </div>

                <div className="mt-4 rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Thesis</div>
                  <p className="text-sm text-slate-300">{String(latestThesis?.summary ?? "No thesis summary stored yet.")}</p>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Catalysts</div>
                    <div className="space-y-2">
                      {Array.isArray(latestThesis?.catalysts) && latestThesis.catalysts.length > 0 ? latestThesis.catalysts.map((item: any, index: number) => (
                        <div key={`${item?.title ?? "catalyst"}-${index}`} className="rounded-lg border border-borderSoft/40 px-3 py-2">
                          <div className="text-sm font-semibold text-slate-200">{String(item?.title ?? "-")}</div>
                          <div className="text-xs text-slate-400">{String(item?.summary ?? "-")}</div>
                        </div>
                      )) : <p className="text-xs text-slate-400">No catalysts stored yet.</p>}
                    </div>
                  </div>
                  <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Risks</div>
                    <div className="space-y-2">
                      {Array.isArray(latestThesis?.risks) && latestThesis.risks.length > 0 ? latestThesis.risks.map((item: any, index: number) => (
                        <div key={`${item?.title ?? "risk"}-${index}`} className="rounded-lg border border-borderSoft/40 px-3 py-2">
                          <div className="text-sm font-semibold text-slate-200">{String(item?.title ?? "-")}</div>
                          <div className="text-xs text-slate-400">{String(item?.summary ?? "-")}</div>
                        </div>
                      )) : <p className="text-xs text-slate-400">No risks stored yet.</p>}
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Evidence</div>
                  <div className="space-y-2">
                    {(latestDetail?.evidence ?? []).slice(0, 8).map((item) => (
                      <a
                        key={item.id}
                        className="block rounded-lg border border-borderSoft/40 px-3 py-2 hover:bg-panelSoft/60"
                        href={item.canonicalUrl ?? undefined}
                        rel="noreferrer"
                        target={item.canonicalUrl ? "_blank" : undefined}
                      >
                        <div className="text-sm font-semibold text-slate-200">{item.title}</div>
                        <div className="text-xs text-slate-400">{item.sourceDomain ?? item.providerKey} · {item.publishedAt ?? item.retrievedAt}</div>
                        <div className="mt-1 text-xs text-slate-400">{item.snippet?.summary ?? "-"}</div>
                      </a>
                    ))}
                    {(latestDetail?.evidence ?? []).length === 0 && <p className="text-xs text-slate-400">No evidence stored for this ticker yet.</p>}
                  </div>
                </div>
              </>
            ) : (
              <p className="text-sm text-slate-400">No research snapshot exists yet for this ticker. Run the pipeline above to create one.</p>
            )}
          </div>
        </div>

        <ResearchHistoryPanel
          history={history}
          compare={compare}
          selectedBaselineId={baselineSnapshotId}
          onBaselineChange={setBaselineSnapshotId}
        />
      </div>
    </section>
  );
}
