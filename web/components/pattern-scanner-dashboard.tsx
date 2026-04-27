"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  BarChart3,
  Check,
  CircleDashed,
  Download,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Settings2,
  SkipForward,
  Trash2,
  X,
} from "lucide-react";
import {
  createPatternLabel,
  createPatternLabelsBulk,
  createPatternRun,
  deletePatternLabel,
  getAdminWorkerSchedule,
  getPatternChart,
  getPatternAnalysis,
  getPatternExportUrl,
  getPatternFeatureIdeas,
  getPatternFeatures,
  getPatternLabels,
  getPatternLatest,
  getPatternRuns,
  updateAdminWorkerSchedule,
  updatePatternFeature,
  updatePatternLabel,
  type PatternChartData,
  type PatternAnalysisResponse,
  type PatternCandidate,
  type PatternFeatureIdeasResponse,
  type PatternFeatureRegistryRow,
  type PatternLabel,
  type PatternLabelValue,
  type PatternSelectionMode,
  type PatternRun,
  type WorkerScheduleSettings,
} from "@/lib/api";
import { Sparkline } from "./sparkline";
import { PatternTrainingChart, type PatternChartSelection } from "./pattern-training-chart";

type TabKey = "candidates" | "training" | "runs" | "analysis" | "ideas" | "settings";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "candidates", label: "Candidates" },
  { key: "training", label: "Training Set" },
  { key: "runs", label: "Runs" },
  { key: "analysis", label: "Analysis" },
  { key: "ideas", label: "Feature Ideas" },
  { key: "settings", label: "Settings" },
];

const BUTTON_CLASS = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-borderSoft/80 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800/60 disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-accent/40 bg-accent/15 px-2.5 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60";
const DANGER_BUTTON_CLASS = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-500/40 px-2.5 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50";
const INPUT_CLASS = "mt-1 w-full rounded-lg border border-borderSoft/80 bg-panelSoft/80 px-2.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60";
const SELECT_CLASS = "mt-1 w-full rounded-lg border border-borderSoft/80 bg-panelSoft/80 px-2.5 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60";

function pct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

function num(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(digits);
}

function metaString(candidate: PatternCandidate, key: string) {
  const value = candidate.sourceMetadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function metaNumber(candidate: PatternCandidate, key: string) {
  const value = candidate.sourceMetadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function shapeValues(candidate: PatternCandidate, key: string) {
  return (candidate.shapeJson[key] ?? []).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function tagsFromText(value: string) {
  return value.split(/[,\n;]/).map((tag) => tag.trim()).filter(Boolean);
}

function defaultSetupDate() {
  return new Date().toISOString().slice(0, 10);
}

export function PatternScannerDashboard() {
  const profileId = "default";
  const [activeTab, setActiveTab] = useState<TabKey>("candidates");
  const [candidates, setCandidates] = useState<PatternCandidate[]>([]);
  const [labels, setLabels] = useState<PatternLabel[]>([]);
  const [runs, setRuns] = useState<PatternRun[]>([]);
  const [features, setFeatures] = useState<PatternFeatureRegistryRow[]>([]);
  const [analysis, setAnalysis] = useState<PatternAnalysisResponse | null>(null);
  const [ideas, setIdeas] = useState<PatternFeatureIdeasResponse | null>(null);
  const [workerSchedule, setWorkerSchedule] = useState<WorkerScheduleSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const [seed, setSeed] = useState({
    ticker: "",
    setupDate: defaultSetupDate(),
    label: "approved" as PatternLabelValue,
    tags: "",
    notes: "",
    patternStartDate: "",
    patternEndDate: "",
    selectedBarCount: 0,
    selectionMode: "fixed_window" as PatternSelectionMode,
  });
  const [seedChart, setSeedChart] = useState<PatternChartData | null>(null);
  const [seedChartLoading, setSeedChartLoading] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [runDate, setRunDate] = useState(defaultSetupDate());

  const activeRun = useMemo(() => runs.find((run) => run.status === "queued" || run.status === "running") ?? null, [runs]);

  const load = async () => {
    setLoading(true);
    try {
      const [latestRes, labelsRes, runsRes, analysisRes, featuresRes, ideasRes, scheduleRes] = await Promise.all([
        getPatternLatest(profileId, 100),
        getPatternLabels(profileId),
        getPatternRuns(profileId, 25),
        getPatternAnalysis(profileId),
        getPatternFeatures(),
        getPatternFeatureIdeas(),
        getAdminWorkerSchedule().catch(() => null),
      ]);
      setCandidates(latestRes.rows);
      setLabels(labelsRes.rows);
      setRuns(runsRes.rows);
      setAnalysis(analysisRes);
      setFeatures(featuresRes.rows);
      setIdeas(ideasRes);
      setWorkerSchedule(scheduleRes);
      setMessage(null);
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to load pattern scanner." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!activeRun) return;
    const id = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(id);
  }, [activeRun?.id]);

  const addLabel = async (payload: {
    ticker: string;
    setupDate: string;
    label: PatternLabelValue;
    tags?: string[];
    notes?: string | null;
    runId?: string | null;
    candidateId?: string | null;
    patternStartDate?: string | null;
    patternEndDate?: string | null;
    selectedBarCount?: number | null;
    selectionMode?: PatternSelectionMode;
  }) => {
    setSaving(true);
    try {
      await createPatternLabel({
        profileId,
        ticker: payload.ticker,
        setupDate: payload.setupDate,
        label: payload.label,
        tags: payload.tags ?? [],
        notes: payload.notes ?? null,
        source: payload.candidateId ? "candidate_review" : "manual",
        runId: payload.runId ?? null,
        candidateId: payload.candidateId ?? null,
        patternStartDate: payload.patternStartDate ?? null,
        patternEndDate: payload.patternEndDate ?? payload.setupDate,
        selectedBarCount: payload.selectedBarCount ?? null,
        selectionMode: payload.selectionMode ?? (payload.patternStartDate ? "chart_range" : "fixed_window"),
      });
      setMessage({ tone: "success", text: `${payload.ticker.toUpperCase()} ${payload.label}.` });
      await load();
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to save feedback." });
    } finally {
      setSaving(false);
    }
  };

  const submitSeed = async () => {
    if (!seed.ticker.trim() || !seed.patternStartDate || !seed.patternEndDate || seed.selectedBarCount <= 0) return;
    await addLabel({
      ticker: seed.ticker,
      setupDate: seed.patternEndDate || seed.setupDate,
      label: seed.label,
      tags: tagsFromText(seed.tags),
      notes: seed.notes.trim() || null,
      patternStartDate: seed.patternStartDate,
      patternEndDate: seed.patternEndDate || seed.setupDate,
      selectedBarCount: seed.selectedBarCount,
      selectionMode: "chart_range",
    });
    setSeed((current) => ({ ...current, ticker: "", notes: "", patternStartDate: "", patternEndDate: "", selectedBarCount: 0, selectionMode: "fixed_window" }));
    setSeedChart(null);
  };

  const loadSeedChart = async () => {
    if (!seed.ticker.trim() || !seed.setupDate) return;
    setSeedChartLoading(true);
    try {
      const chart = await getPatternChart({ profileId, ticker: seed.ticker, endDate: seed.setupDate, contextBars: 260 });
      setSeedChart(chart);
      const endDate = chart.availableEndDate ?? seed.setupDate;
      const startIndex = Math.max(0, chart.bars.length - 40);
      const startDate = chart.bars[startIndex]?.date ?? chart.availableStartDate ?? "";
      setSeed((current) => ({
        ...current,
        patternStartDate: startDate,
        patternEndDate: endDate,
        selectedBarCount: chart.bars.filter((bar) => bar.date >= startDate && bar.date <= endDate).length,
        selectionMode: "chart_range",
      }));
      setMessage(null);
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to load pattern chart." });
    } finally {
      setSeedChartLoading(false);
    }
  };

  const applyChartSelection = (selection: PatternChartSelection) => {
    setSeed((current) => ({
      ...current,
      setupDate: selection.endDate,
      patternStartDate: selection.startDate,
      patternEndDate: selection.endDate,
      selectedBarCount: selection.barCount,
      selectionMode: selection.selectionMode,
    }));
  };

  const submitBulk = async () => {
    if (!bulkText.trim()) return;
    setSaving(true);
    try {
      const result = await createPatternLabelsBulk({ profileId, csvText: bulkText });
      setMessage({
        tone: result.errors.length ? "info" : "success",
        text: `Created ${result.created.length} labels${result.errors.length ? ` with ${result.errors.length} errors` : ""}.`,
      });
      setBulkText("");
      await load();
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Bulk seed failed." });
    } finally {
      setSaving(false);
    }
  };

  const startRun = async (force = false) => {
    setSaving(true);
    try {
      const result = await createPatternRun({ profileId, tradingDate: runDate || undefined, force });
      setMessage({ tone: "success", text: `Pattern run ${result.run.status} for ${result.run.tradingDate}.` });
      await load();
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to start pattern run." });
    } finally {
      setSaving(false);
    }
  };

  const archiveLabel = async (label: PatternLabel) => {
    setSaving(true);
    try {
      await updatePatternLabel(label.id, { status: label.status === "active" ? "archived" : "active" });
      await load();
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to update label." });
    } finally {
      setSaving(false);
    }
  };

  const removeLabel = async (label: PatternLabel) => {
    setSaving(true);
    try {
      await deletePatternLabel(label.id);
      await load();
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to delete label." });
    } finally {
      setSaving(false);
    }
  };

  const toggleFeature = async (feature: PatternFeatureRegistryRow) => {
    setSaving(true);
    try {
      await updatePatternFeature(feature.featureKey, { enabled: !feature.enabled });
      await load();
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to update feature." });
    } finally {
      setSaving(false);
    }
  };

  const saveWorkerSchedule = async () => {
    if (!workerSchedule) return;
    setSaving(true);
    try {
      const result = await updateAdminWorkerSchedule({
        id: workerSchedule.id,
        rsBackgroundEnabled: workerSchedule.rsBackgroundEnabled,
        rsBackgroundBatchSize: workerSchedule.rsBackgroundBatchSize,
        rsBackgroundMaxBatchesPerTick: workerSchedule.rsBackgroundMaxBatchesPerTick,
        rsBackgroundTimeBudgetMs: workerSchedule.rsBackgroundTimeBudgetMs,
        rsManualCacheReuseEnabled: workerSchedule.rsManualCacheReuseEnabled,
        rsSharedConfigSnapshotFanoutEnabled: workerSchedule.rsSharedConfigSnapshotFanoutEnabled,
        postCloseBarsEnabled: workerSchedule.postCloseBarsEnabled,
        postCloseBarsOffsetMinutes: workerSchedule.postCloseBarsOffsetMinutes,
        postCloseBarsBatchSize: workerSchedule.postCloseBarsBatchSize,
        postCloseBarsMaxBatchesPerTick: workerSchedule.postCloseBarsMaxBatchesPerTick,
        patternScanEnabled: workerSchedule.patternScanEnabled,
        patternScanOffsetMinutes: workerSchedule.patternScanOffsetMinutes,
        patternScanBatchSize: workerSchedule.patternScanBatchSize,
        patternScanMaxBatchesPerTick: workerSchedule.patternScanMaxBatchesPerTick,
      });
      setWorkerSchedule(result.settings);
      setMessage({ tone: "success", text: "Saved pattern scanner schedule." });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to save schedule." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="card p-2">
        <div className="flex flex-wrap gap-2">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              className={`rounded-xl px-3 py-2 text-sm transition ${activeTab === tab.key ? "bg-accent/20 text-accent" : "text-slate-300 hover:bg-panelSoft/70"}`}
              onClick={() => setActiveTab(tab.key)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
          <button className={`${BUTTON_CLASS} ml-auto`} onClick={() => void load()} type="button">
            <RefreshCw className="h-3.5 w-3.5" />
            Reload
          </button>
        </div>
      </div>

      {message ? (
        <div className={`rounded-xl border px-4 py-3 text-sm ${
          message.tone === "danger"
            ? "border-danger/30 bg-danger/10 text-red-200"
            : message.tone === "success"
              ? "border-success/30 bg-success/10 text-green-200"
              : "border-info/30 bg-info/10 text-sky-200"
        }`}>
          {message.text}
        </div>
      ) : null}

      {loading ? (
        <div className="card flex min-h-56 items-center justify-center p-8 text-sm text-slate-400">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading pattern scanner
        </div>
      ) : null}

      {!loading && activeTab === "candidates" ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr),20rem]">
          <div className="space-y-3">
            {candidates.length === 0 ? (
              <div className="card p-6 text-sm text-slate-400">No candidates yet.</div>
            ) : candidates.slice(0, 40).map((candidate) => (
              <CandidateCard
                key={`${candidate.runId}-${candidate.ticker}`}
                candidate={candidate}
                saving={saving}
                onFeedback={(label) => addLabel({
                  ticker: candidate.ticker,
                  setupDate: candidate.tradingDate ?? metaString(candidate, "setupDate") ?? defaultSetupDate(),
                  label,
                  runId: candidate.runId,
                  candidateId: candidate.id,
                  patternStartDate: metaString(candidate, "matchedPatternStartDate") ?? metaString(candidate, "patternStartDate"),
                  patternEndDate: metaString(candidate, "matchedPatternEndDate") ?? candidate.tradingDate ?? metaString(candidate, "patternEndDate") ?? metaString(candidate, "setupDate") ?? defaultSetupDate(),
                  selectedBarCount: metaNumber(candidate, "matchedPatternBars") ?? metaNumber(candidate, "selectedBarCount"),
                  selectionMode: "fixed_window",
                })}
              />
            ))}
          </div>
          <div className="card h-fit p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <BarChart3 className="h-4 w-4 text-accent" />
              Latest Snapshot
            </div>
            <div className="mt-4 grid gap-3">
              <Metric label="Candidates" value={candidates.length.toString()} />
              <Metric label="Top Score" value={candidates[0] ? pct(candidates[0].score) : "-"} />
              <Metric label="Active Approvals" value={String(analysis?.approvalCount ?? 0)} />
              <Metric label="Active Rejections" value={String(analysis?.rejectionCount ?? 0)} />
            </div>
            <a className={`${PRIMARY_BUTTON_CLASS} mt-4 w-full`} href={getPatternExportUrl(profileId)}>
              <Download className="h-3.5 w-3.5" />
              Export Tickers
            </a>
          </div>
        </div>
      ) : null}

      {!loading && activeTab === "training" ? (
        <div className="grid gap-4 xl:grid-cols-[24rem,minmax(0,1fr)]">
          <div className="space-y-4">
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-slate-100">Seed Example</h3>
              <div className="mt-4 grid gap-3">
                <label className="text-xs text-slate-300">
                  Ticker
                  <input className={INPUT_CLASS} value={seed.ticker} onChange={(event) => {
                    setSeed((current) => ({ ...current, ticker: event.target.value.toUpperCase(), patternStartDate: "", patternEndDate: "", selectedBarCount: 0 }));
                    setSeedChart(null);
                  }} onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    if (!seedChartLoading && seed.ticker.trim() && seed.setupDate) void loadSeedChart();
                  }} />
                </label>
                <label className="text-xs text-slate-300">
                  Setup/end date
                  <input className={INPUT_CLASS} type="date" value={seed.setupDate} onChange={(event) => {
                    setSeed((current) => ({ ...current, setupDate: event.target.value, patternStartDate: "", patternEndDate: "", selectedBarCount: 0 }));
                    setSeedChart(null);
                  }} />
                </label>
                <button className={BUTTON_CLASS} disabled={seedChartLoading || !seed.ticker.trim() || !seed.setupDate} onClick={() => void loadSeedChart()} type="button">
                  {seedChartLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BarChart3 className="h-3.5 w-3.5" />}
                  Load Chart
                </button>
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="text-xs text-slate-300">
                    Pattern start
                    <input className={INPUT_CLASS} type="date" value={seed.patternStartDate} onChange={(event) => {
                      const startDate = event.target.value;
                      setSeed((current) => ({
                        ...current,
                        patternStartDate: startDate,
                        selectedBarCount: seedChart ? seedChart.bars.filter((bar) => bar.date >= startDate && bar.date <= (current.patternEndDate || current.setupDate)).length : current.selectedBarCount,
                        selectionMode: "chart_range",
                      }));
                    }} />
                  </label>
                  <label className="text-xs text-slate-300">
                    Pattern end
                    <input className={INPUT_CLASS} type="date" value={seed.patternEndDate} onChange={(event) => {
                      const endDate = event.target.value;
                      setSeed((current) => ({
                        ...current,
                        setupDate: endDate,
                        patternEndDate: endDate,
                        selectedBarCount: seedChart ? seedChart.bars.filter((bar) => bar.date >= current.patternStartDate && bar.date <= endDate).length : current.selectedBarCount,
                        selectionMode: "chart_range",
                      }));
                    }} />
                  </label>
                  <label className="text-xs text-slate-300">
                    Bars
                    <input className={INPUT_CLASS} value={seed.selectedBarCount ? String(seed.selectedBarCount) : ""} readOnly />
                  </label>
                </div>
                {seed.selectedBarCount > 0 && seed.selectedBarCount < 20 ? (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                    Short window selected: {seed.selectedBarCount} bars.
                  </div>
                ) : null}
                <label className="text-xs text-slate-300">
                  Label
                  <select className={SELECT_CLASS} value={seed.label} onChange={(event) => setSeed((current) => ({ ...current, label: event.target.value as PatternLabelValue }))}>
                    <option value="approved">Approve</option>
                    <option value="rejected">Reject</option>
                    <option value="skipped">Skip</option>
                  </select>
                </label>
                <label className="text-xs text-slate-300">
                  Tags
                  <input className={INPUT_CLASS} value={seed.tags} onChange={(event) => setSeed((current) => ({ ...current, tags: event.target.value }))} />
                </label>
                <label className="text-xs text-slate-300">
                  Notes
                  <textarea className={`${INPUT_CLASS} min-h-20`} value={seed.notes} onChange={(event) => setSeed((current) => ({ ...current, notes: event.target.value }))} />
                </label>
                <button className={PRIMARY_BUTTON_CLASS} disabled={saving || !seed.ticker.trim() || !seed.patternStartDate || !seed.patternEndDate || seed.selectedBarCount < 10} onClick={() => void submitSeed()} type="button">
                  <Save className="h-3.5 w-3.5" />
                  Save Example
                </button>
              </div>
            </div>
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-slate-100">Bulk CSV</h3>
              <textarea
                className={`${INPUT_CLASS} min-h-36 font-mono text-xs`}
                value={bulkText}
                onChange={(event) => setBulkText(event.target.value)}
                placeholder="ticker,setupDate,label,tags,notes"
              />
              <button className={`${PRIMARY_BUTTON_CLASS} mt-3 w-full`} disabled={saving || !bulkText.trim()} onClick={() => void submitBulk()} type="button">
                <Save className="h-3.5 w-3.5" />
                Import Labels
              </button>
            </div>
          </div>
          <div className="space-y-4">
            {seedChart ? (
              <div className="card p-4">
                <PatternTrainingChart
                  data={seedChart}
                  height={500}
                  selection={seed.patternStartDate && seed.patternEndDate ? {
                    startDate: seed.patternStartDate,
                    endDate: seed.patternEndDate,
                    barCount: seed.selectedBarCount,
                    selectionMode: "chart_range",
                  } : null}
                  onSelectionChange={applyChartSelection}
                />
              </div>
            ) : (
              <div className="card flex min-h-[24rem] items-center justify-center p-8 text-sm text-slate-500">
                No chart loaded.
              </div>
            )}
            <div className="card overflow-hidden">
              <div className="border-b border-borderSoft/70 px-4 py-3 text-sm font-semibold text-slate-100">Training Labels</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-panelSoft/60 text-xs uppercase tracking-[0.12em] text-slate-400">
                    <tr>
                      <th className="px-3 py-2 text-left">Ticker</th>
                      <th className="px-3 py-2 text-left">Setup</th>
                      <th className="px-3 py-2 text-left">Pattern</th>
                      <th className="px-3 py-2 text-right">Bars</th>
                      <th className="px-3 py-2 text-left">Label</th>
                      <th className="px-3 py-2 text-left">Status</th>
                      <th className="px-3 py-2 text-left">Tags</th>
                      <th className="px-3 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {labels.map((label) => (
                      <tr key={label.id} className="border-t border-borderSoft/50">
                        <td className="px-3 py-2 font-semibold text-slate-100">{label.ticker}</td>
                        <td className="px-3 py-2 text-slate-300">{label.setupDate}</td>
                        <td className="px-3 py-2 text-slate-300">{label.patternStartDate ? `${label.patternStartDate} to ${label.patternEndDate ?? label.setupDate}` : "-"}</td>
                        <td className="px-3 py-2 text-right font-mono text-slate-300">{label.selectedBarCount ?? label.patternWindowBars}</td>
                        <td className="px-3 py-2"><LabelPill label={label.label} /></td>
                        <td className="px-3 py-2 text-slate-300">{label.status}</td>
                        <td className="px-3 py-2 text-slate-400">{label.tags.join(", ") || "-"}</td>
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-2">
                            <button className={BUTTON_CLASS} disabled={saving} onClick={() => void archiveLabel(label)} type="button">
                              <Archive className="h-3.5 w-3.5" />
                              {label.status === "active" ? "Archive" : "Restore"}
                            </button>
                            <button className={DANGER_BUTTON_CLASS} disabled={saving} onClick={() => void removeLabel(label)} type="button">
                              <Trash2 className="h-3.5 w-3.5" />
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {!loading && activeTab === "runs" ? (
        <div className="grid gap-4 xl:grid-cols-[20rem,minmax(0,1fr)]">
          <div className="card p-4">
            <h3 className="text-sm font-semibold text-slate-100">Manual Run</h3>
            <label className="mt-4 block text-xs text-slate-300">
              Trading date
              <input className={INPUT_CLASS} type="date" value={runDate} onChange={(event) => setRunDate(event.target.value)} />
            </label>
            <div className="mt-4 grid gap-2">
              <button className={PRIMARY_BUTTON_CLASS} disabled={saving} onClick={() => void startRun(false)} type="button">
                <Play className="h-3.5 w-3.5" />
                Start Run
              </button>
              <button className={BUTTON_CLASS} disabled={saving} onClick={() => void startRun(true)} type="button">
                <RefreshCw className="h-3.5 w-3.5" />
                Rebuild Date
              </button>
            </div>
          </div>
          <div className="grid gap-3">
            {runs.map((run) => (
              <div key={run.id} className="card p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-mono text-xs text-slate-500">{run.id}</div>
                    <div className="mt-1 text-sm font-semibold text-slate-100">{run.tradingDate}</div>
                  </div>
                  <RunStatus run={run} />
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-4">
                  <Metric label="Total" value={run.totalCount.toString()} />
                  <Metric label="Processed" value={run.processedCount.toString()} />
                  <Metric label="Matched" value={run.matchedCount.toString()} />
                  <Metric label="Cursor" value={run.cursorOffset.toString()} />
                </div>
                {run.error ? <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-red-200">{run.error}</div> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!loading && activeTab === "analysis" ? (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-4">
            <StatCard label="Model" value={analysis?.activeModel?.modelType ?? "fallback"} helper={analysis?.activeModel?.id ?? "No active model"} />
            <StatCard label="Approvals" value={String(analysis?.approvalCount ?? 0)} helper="Active training examples" />
            <StatCard label="Rejections" value={String(analysis?.rejectionCount ?? 0)} helper="Active training examples" />
            <StatCard label="Validation" value={pct(analysis?.validationMetrics.chronologicalAccuracy)} helper="Chronological accuracy" />
          </div>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr),24rem]">
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-slate-100">Feature Averages</h3>
              <div className="mt-4 grid gap-3">
                {Object.entries(analysis?.featureSummary.scalarStats ?? {}).slice(0, 14).map(([key, stats]) => (
                  <div key={key} className="rounded-xl border border-borderSoft/70 bg-panelSoft/45 p-3">
                    <div className="flex justify-between gap-3 text-sm">
                      <span className="font-medium text-slate-200">{key}</span>
                      <span className={stats.delta != null && stats.delta >= 0 ? "text-green-300" : "text-red-300"}>{num(stats.delta, 3)}</span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-400">
                      <span>Approved {num(stats.approvedAvg, 3)}</span>
                      <span>Rejected {num(stats.rejectedAvg, 3)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-4">
              <div className="card p-4">
                <h3 className="text-sm font-semibold text-slate-100">Top Weighted Features</h3>
                <div className="mt-3 space-y-2">
                  {(analysis?.featureSummary.topWeightedFeatures ?? []).slice(0, 10).map((feature) => (
                    <div key={feature.featureKey} className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate text-slate-300">{feature.featureKey}</span>
                      <span className="font-mono text-xs text-accent">{num(feature.weight, 2)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="card p-4">
                <h3 className="text-sm font-semibold text-slate-100">ML Readiness</h3>
                <div className="mt-3 space-y-2 text-sm text-slate-300">
                  <Metric label="Balanced labels" value={String(analysis?.mlReadiness.balancedLabels ?? 0)} />
                  {(analysis?.mlReadiness.guidance ?? []).map((line) => (
                    <div key={line} className="rounded-lg border border-borderSoft/60 bg-panelSoft/40 px-3 py-2 text-xs text-slate-400">{line}</div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {!loading && activeTab === "ideas" ? (
        <div className="grid gap-4 lg:grid-cols-3">
          {(ideas?.rows ?? []).map((idea) => (
            <div key={idea.title} className="card p-4">
              <div className="text-sm font-semibold text-slate-100">{idea.title}</div>
              <p className="mt-2 text-sm text-slate-400">{idea.description}</p>
              <div className="mt-4 rounded-full border border-borderSoft/70 px-3 py-1 text-xs text-slate-400">{idea.status}</div>
            </div>
          ))}
        </div>
      ) : null}

      {!loading && activeTab === "settings" ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr),24rem]">
          <div className="card p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Settings2 className="h-4 w-4 text-accent" />
              Feature Registry
            </div>
            <div className="mt-4 grid gap-2">
              {features.map((feature) => (
                <button
                  key={feature.featureKey}
                  className="flex items-center justify-between gap-3 rounded-xl border border-borderSoft/70 bg-panelSoft/45 px-3 py-2 text-left text-sm transition hover:bg-panelSoft"
                  disabled={saving}
                  onClick={() => void toggleFeature(feature)}
                  type="button"
                >
                  <span>
                    <span className="block font-medium text-slate-200">{feature.displayName}</span>
                    <span className="block text-xs text-slate-500">{feature.family} · {feature.featureKey}</span>
                  </span>
                  <span className={feature.enabled ? "text-green-300" : "text-slate-500"}>{feature.enabled ? "Enabled" : "Disabled"}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="card p-4">
            <h3 className="text-sm font-semibold text-slate-100">Schedule</h3>
            {workerSchedule ? (
              <div className="mt-4 grid gap-3">
                <button
                  className={workerSchedule.patternScanEnabled ? PRIMARY_BUTTON_CLASS : BUTTON_CLASS}
                  onClick={() => setWorkerSchedule((current) => current ? { ...current, patternScanEnabled: !current.patternScanEnabled } : current)}
                  type="button"
                >
                  {workerSchedule.patternScanEnabled ? <Check className="h-3.5 w-3.5" /> : <CircleDashed className="h-3.5 w-3.5" />}
                  {workerSchedule.patternScanEnabled ? "Enabled" : "Disabled"}
                </button>
                <label className="text-xs text-slate-300">
                  Start offset after US close (min)
                  <input
                    className={INPUT_CLASS}
                    min={0}
                    max={360}
                    type="number"
                    value={workerSchedule.patternScanOffsetMinutes}
                    onChange={(event) => setWorkerSchedule((current) => current ? { ...current, patternScanOffsetMinutes: Number(event.target.value || current.patternScanOffsetMinutes) } : current)}
                  />
                </label>
                <label className="text-xs text-slate-300">
                  Tickers per batch
                  <input
                    className={INPUT_CLASS}
                    min={1}
                    max={500}
                    type="number"
                    value={workerSchedule.patternScanBatchSize}
                    onChange={(event) => setWorkerSchedule((current) => current ? { ...current, patternScanBatchSize: Number(event.target.value || current.patternScanBatchSize) } : current)}
                  />
                </label>
                <label className="text-xs text-slate-300">
                  Max batches per tick
                  <input
                    className={INPUT_CLASS}
                    min={1}
                    max={20}
                    type="number"
                    value={workerSchedule.patternScanMaxBatchesPerTick}
                    onChange={(event) => setWorkerSchedule((current) => current ? { ...current, patternScanMaxBatchesPerTick: Number(event.target.value || current.patternScanMaxBatchesPerTick) } : current)}
                  />
                </label>
                <button className={`${PRIMARY_BUTTON_CLASS} mt-2`} disabled={saving} onClick={() => void saveWorkerSchedule()} type="button">
                  <Save className="h-3.5 w-3.5" />
                  Save Schedule
                </button>
              </div>
            ) : (
              <div className="mt-4 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-amber-200">
                Worker schedule is unavailable.
              </div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function CandidateCard({ candidate, saving, onFeedback }: {
  candidate: PatternCandidate;
  saving: boolean;
  onFeedback: (label: PatternLabelValue) => void | Promise<void>;
}) {
  const selectedPricePath = shapeValues(candidate, "selected_price_path_64");
  const selectedRsPath = shapeValues(candidate, "selected_rs_path_64");
  const pricePath = selectedPricePath.length ? selectedPricePath : shapeValues(candidate, "price_path_40d");
  const rsPath = selectedRsPath.length ? selectedRsPath : shapeValues(candidate, "relative_strength_path_60d");
  const matchedStart = metaString(candidate, "matchedPatternStartDate") ?? metaString(candidate, "patternStartDate");
  const matchedEnd = metaString(candidate, "matchedPatternEndDate") ?? metaString(candidate, "patternEndDate") ?? candidate.tradingDate;
  const matchedBars = metaNumber(candidate, "matchedPatternBars") ?? metaNumber(candidate, "selectedBarCount");
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-slate-100">{candidate.ticker}</h3>
            <span className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs text-accent">{pct(candidate.score)}</span>
            <span className="rounded-full border border-borderSoft/70 px-2 py-0.5 text-xs text-slate-400">{candidate.reasons.mode}</span>
          </div>
          <div className="mt-1 text-sm text-slate-400">
            {[metaString(candidate, "name"), metaString(candidate, "sector"), metaString(candidate, "industry")].filter(Boolean).join(" · ") || "Pattern candidate"}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={PRIMARY_BUTTON_CLASS} disabled={saving} onClick={() => void onFeedback("approved")} type="button">
            <Check className="h-3.5 w-3.5" />
            Approve
          </button>
          <button className={DANGER_BUTTON_CLASS} disabled={saving} onClick={() => void onFeedback("rejected")} type="button">
            <X className="h-3.5 w-3.5" />
            Reject
          </button>
          <button className={BUTTON_CLASS} disabled={saving} onClick={() => void onFeedback("skipped")} type="button">
            <SkipForward className="h-3.5 w-3.5" />
            Skip
          </button>
        </div>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <Metric label="Approved Sim" value={pct(candidate.reasons.approvedSimilarity)} />
        <Metric label="Rejected Sim" value={pct(candidate.reasons.rejectedSimilarity)} />
        <Metric label="Heuristic" value={pct(candidate.reasons.heuristicScore)} />
        <Metric label="Dollar Vol" value={num(metaNumber(candidate, "avgDollarVolume20d") ?? metaNumber(candidate, "universeAvgDollarVolume20d"), 1)} />
      </div>
      {matchedStart || matchedEnd || matchedBars ? (
        <div className="mt-3 rounded-lg border border-borderSoft/60 bg-panelSoft/35 px-3 py-2 text-xs text-slate-400">
          Matched window <span className="font-mono text-slate-200">{matchedStart ?? "-"} to {matchedEnd ?? "-"}</span>
          <span className="ml-2 font-mono text-slate-200">{matchedBars ? `${matchedBars} bars` : ""}</span>
        </div>
      ) : null}
      <div className="mt-4 grid gap-4 lg:grid-cols-[12rem,12rem,minmax(0,1fr)]">
        <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/45 p-3">
          <div className="text-xs text-slate-500">Selected price</div>
          <div className="mt-2 h-10"><Sparkline values={pricePath} width={150} height={36} /></div>
        </div>
        <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/45 p-3">
          <div className="text-xs text-slate-500">Selected RS</div>
          <div className="mt-2 h-10"><Sparkline values={rsPath} width={150} height={36} /></div>
        </div>
        <div className="grid gap-2">
          {candidate.reasons.summary.map((line) => (
            <div key={line} className="rounded-lg border border-borderSoft/60 bg-panelSoft/35 px-3 py-2 text-xs text-slate-400">{line}</div>
          ))}
        </div>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <ContributionList title="Positive" rows={candidate.reasons.positiveContributions} tone="positive" />
        <ContributionList title="Negative" rows={candidate.reasons.negativeContributions} tone="negative" />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <NearestList title="Closest Approved" rows={candidate.nearestApproved} />
        <NearestList title="Closest Rejected" rows={candidate.nearestRejected} />
      </div>
    </div>
  );
}

function ContributionList({ title, rows, tone }: { title: string; rows: PatternCandidate["reasons"]["positiveContributions"]; tone: "positive" | "negative" }) {
  return (
    <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 p-3">
      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{title}</div>
      <div className="mt-2 space-y-1">
        {rows.length === 0 ? <div className="text-xs text-slate-500">-</div> : rows.map((row) => (
          <div key={row.featureKey} className="flex justify-between gap-3 text-xs">
            <span className="truncate text-slate-300">{row.label}</span>
            <span className={tone === "positive" ? "text-green-300" : "text-red-300"}>{num(row.contribution, 3)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NearestList({ title, rows }: { title: string; rows: PatternCandidate["nearestApproved"] }) {
  return (
    <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 p-3">
      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{title}</div>
      <div className="mt-2 space-y-1">
        {rows.length === 0 ? <div className="text-xs text-slate-500">No examples yet</div> : rows.map((row) => (
          <div key={row.labelId} className="flex justify-between gap-3 text-xs">
            <span className="text-slate-300">{row.ticker} · {row.setupDate}</span>
            <span className="text-accent">{pct(row.similarity)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LabelPill({ label }: { label: PatternLabelValue }) {
  const classes = label === "approved"
    ? "border-green-500/30 bg-green-500/10 text-green-300"
    : label === "rejected"
      ? "border-red-500/30 bg-red-500/10 text-red-300"
      : "border-slate-500/30 bg-slate-500/10 text-slate-300";
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${classes}`}>{label}</span>;
}

function RunStatus({ run }: { run: PatternRun }) {
  const tone = run.status === "completed" ? "text-green-300" : run.status === "failed" ? "text-red-300" : "text-accent";
  const Icon = run.status === "failed" ? AlertTriangle : run.status === "completed" ? Check : Loader2;
  return (
    <div className={`inline-flex items-center gap-1.5 rounded-full border border-borderSoft/70 bg-panelSoft/50 px-3 py-1 text-xs ${tone}`}>
      <Icon className={`h-3.5 w-3.5 ${run.status === "queued" || run.status === "running" ? "animate-spin" : ""}`} />
      {run.status} · {run.phase}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.12em] text-slate-500">{label}</div>
      <div className="mt-1 font-mono text-sm text-slate-100">{value}</div>
    </div>
  );
}

function StatCard({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-slate-100">{value}</div>
      <div className="mt-1 text-xs text-slate-400">{helper}</div>
    </div>
  );
}
