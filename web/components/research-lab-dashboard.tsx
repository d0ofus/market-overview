"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Play, RefreshCw } from "lucide-react";
import { apiUrl } from "@/lib/api";
import { ResearchLabResultCard } from "./research-lab-result-card";
import {
  cancelResearchLabRun,
  createResearchLabRun,
  getResearchLabProfiles,
  getResearchLabRunResults,
  getResearchLabRuns,
  getResearchLabRunStatus,
  pumpResearchLabRun,
  type ResearchLabProfileDetail,
  type ResearchLabRunEventRecord,
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

function statusTone(status: string) {
  if (status === "completed") return "border-emerald-400/30 bg-emerald-500/10 text-emerald-200";
  if (status === "failed" || status.endsWith("_failed")) return "border-rose-400/30 bg-rose-500/10 text-rose-200";
  if (status === "running" || status === "gathering" || status === "synthesizing" || status === "persisting" || status === "memory_loading") {
    return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  }
  return "border-borderSoft/80 bg-panelSoft/70 text-slate-300";
}

function sortEvents(events: ResearchLabRunEventRecord[]) {
  return [...events].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

function buildOptimisticProfileState(profile: ResearchLabProfileDetail | null) {
  if (!profile?.currentVersion) {
    return {
      profile: profile ?? null,
      profileVersion: null,
      promptConfig: null,
      evidenceProfile: null,
    };
  }

  return {
    profile,
    profileVersion: profile.currentVersion,
    promptConfig: {
      id: profile.currentVersion.id,
      name: `${profile.name} (${profile.currentVersion.label})`,
      description: profile.description,
      configFamily: `profile:${profile.id}`,
      modelFamily: profile.currentVersion.modelFamily,
      systemPrompt: profile.currentVersion.systemPrompt,
      schemaVersion: profile.currentVersion.schemaVersion,
      isDefault: profile.isDefault,
      profileId: profile.id,
      profileVersionId: profile.currentVersion.id,
      createdAt: profile.currentVersion.createdAt,
      updatedAt: profile.updatedAt,
      synthesisConfigJson: {
        ...(profile.currentVersion.synthesisConfigJson ?? {}),
        modules: profile.currentVersion.modulesConfigJson ?? {},
      },
    },
    evidenceProfile: {
      id: profile.currentVersion.id,
      name: `${profile.name} Evidence (${profile.currentVersion.label})`,
      description: profile.description,
      configFamily: `profile:${profile.id}`,
      isDefault: profile.isDefault,
      queryConfigJson: profile.currentVersion.evidenceConfigJson ?? {},
      createdAt: profile.currentVersion.createdAt,
      updatedAt: profile.updatedAt,
    },
  };
}

export function ResearchLabDashboard() {
  const [tickerInput, setTickerInput] = useState("");
  const [profiles, setProfiles] = useState<ResearchLabProfileDetail[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
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
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  );

  const applyStatusPayload = (statusPayload: ResearchLabRunStatusResponse) => {
    setStatus(statusPayload);
    setRuns((current) => {
      const row: ResearchLabRunListRow = {
        run: statusPayload.run,
        profileName: statusPayload.profile?.name ?? null,
        profileVersionNumber: statusPayload.profileVersion?.versionNumber ?? null,
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

  const applyResultsPayload = (resultsPayload: ResearchLabRunResultsResponse) => {
    setResults(resultsPayload);
  };

  const loadRunResults = async (runId: string) => {
    const resultsPayload = await getResearchLabRunResults(runId);
    setResults((current) => (current?.run.id === runId || selectedRunId === runId || !current ? resultsPayload : current));
  };

  const loadRunDetail = async (runId: string) => {
    const statusPayload = await getResearchLabRunStatus(runId);
    applyStatusPayload(statusPayload);
    void loadRunResults(runId).catch((error) => {
      setMessage(error instanceof Error ? error.message : "Failed to load research lab results.");
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
        await loadRunDetail(nextRunId);
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

  const loadProfiles = async (preferredProfileId?: string | null) => {
    try {
      const response = await getResearchLabProfiles();
      const rows = response.rows ?? [];
      setProfiles(rows);
      const currentSelection = preferredProfileId ?? selectedProfileId;
      const nextProfileId = preferredProfileId
        ?? rows.find((profile) => profile.id === currentSelection)?.id
        ?? rows.find((profile) => profile.isDefault)?.id
        ?? rows[0]?.id
        ?? null;
      setSelectedProfileId(nextProfileId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load research lab profiles.");
    }
  };

  useEffect(() => {
    void loadRuns();
    void loadProfiles();
  }, []);

  useEffect(() => {
    if (!selectedRunId) return;
    setResults((current) => (current?.run.id === selectedRunId ? current : null));
    let cancelled = false;
    (async () => {
      try {
        const statusPayload = await getResearchLabRunStatus(selectedRunId);
        if (cancelled) return;
        applyStatusPayload(statusPayload);
        void getResearchLabRunResults(selectedRunId).then((resultsPayload) => {
          if (cancelled) return;
          applyResultsPayload(resultsPayload);
        }).catch((error) => {
          if (!cancelled) {
            setMessage(error instanceof Error ? error.message : "Failed to load research lab results.");
          }
        });
      } catch (error) {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : "Failed to load research lab run.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId || !selectedRun || !["queued", "running"].includes(selectedRun.status)) return;
    const eventSource = new EventSource(apiUrl(`/api/research-lab/runs/${encodeURIComponent(selectedRunId)}/stream`));
    const kickProgress = () => {
      void pumpResearchLabRun(selectedRunId).catch((error) => {
        setStreamError(error instanceof Error ? error.message : "Failed to advance research lab run.");
      });
    };
    kickProgress();
    const intervalId = window.setInterval(kickProgress, 4_000);
    setStreamError(null);

    eventSource.addEventListener("update", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          status: ResearchLabRunStatusResponse;
          results: ResearchLabRunResultsResponse;
        };
        applyStatusPayload(payload.status);
        applyResultsPayload(payload.results);
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
      window.clearInterval(intervalId);
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
      const runProfile = selectedProfile;
      const optimisticProfileState = buildOptimisticProfileState(runProfile);
      const response = await createResearchLabRun({
        tickers,
        profileId: selectedProfileId,
      });
      void pumpResearchLabRun(response.run.id);
      setRuns((current) => [{
        run: response.run,
        profileName: runProfile?.name ?? null,
        profileVersionNumber: runProfile?.currentVersion?.versionNumber ?? null,
        promptConfigName: runProfile?.currentVersion ? `${runProfile.name} (${runProfile.currentVersion.label})` : null,
        evidenceProfileName: runProfile?.currentVersion ? `${runProfile.name} Evidence (${runProfile.currentVersion.label})` : null,
      }, ...current.filter((entry) => entry.run.id !== response.run.id)].slice(0, 10));
      setStatus({
        run: response.run,
        items: [],
        events: [],
        profile: optimisticProfileState.profile,
        profileVersion: optimisticProfileState.profileVersion,
        promptConfig: optimisticProfileState.promptConfig,
        evidenceProfile: optimisticProfileState.evidenceProfile,
      });
      setResults({
        run: response.run,
        items: [],
        profile: optimisticProfileState.profile,
        profileVersion: optimisticProfileState.profileVersion,
        promptConfig: optimisticProfileState.promptConfig,
        evidenceProfile: optimisticProfileState.evidenceProfile,
      });
      setSelectedRunId(response.run.id);
      setTickerInput(tickers.join(", "));
      void loadRuns(response.run.id);
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
              onClick={() => {
                void loadRuns(selectedRunId);
                void loadProfiles(selectedProfileId);
              }}
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
            <label className="text-xs uppercase tracking-[0.24em] text-slate-500">
              Profile
              <select
                value={selectedProfileId ?? ""}
                onChange={(event) => setSelectedProfileId(event.target.value || null)}
                className="mt-2 h-12 w-full rounded-2xl border border-borderSoft/80 bg-panelSoft/70 px-4 text-sm text-text outline-none transition focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}{profile.isDefault ? " (Default)" : ""}
                  </option>
                ))}
              </select>
            </label>
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
                  {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : "Stop Run"}
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
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Profile</p>
                <p className="mt-2">{status?.profile?.name ?? "-"}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {status?.profileVersion ? `v${status.profileVersion.versionNumber} · ${status.profileVersion.modelFamily}` : "-"}
                </p>
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
          <ResearchLabResultCard key={itemResult.item.id} itemResult={itemResult} />
        ))}
      </section>
    </div>
  );
}
