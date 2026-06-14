"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  FileJson,
  Flag,
  Loader2,
  RefreshCw,
  Send,
  ShieldAlert,
  SkipForward,
  StickyNote,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import {
  approveAllWatchlistReviewCandidates,
  createWatchlistReviewRun,
  exportApprovedWatchlistReviewChanges,
  getWatchlistReviewRun,
  getWatchlistReviewRuns,
  patchWatchlistReviewCandidate,
  readyToApplyWatchlistReviewRun,
  skipAllWatchlistReviewCandidates,
  type WatchlistReviewCandidate,
  type WatchlistReviewCandidateAction,
  type WatchlistReviewCandidateApplyStatus,
  type WatchlistReviewCandidateStatus,
  type WatchlistReviewFlag,
  type WatchlistReviewProposedFlag,
  type WatchlistReviewRecommendationType,
  type WatchlistReviewRunApplyStatus,
  type WatchlistReviewRun,
  type WatchlistReviewRunDetail,
} from "@/lib/api";

const BUTTON_CLASS = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-borderSoft/80 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800/60 disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-accent/40 bg-accent/15 px-2.5 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60";
const DANGER_BUTTON_CLASS = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-rose-500/50 bg-rose-500/10 px-2.5 py-1.5 text-xs font-medium text-rose-200 transition hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50";
const INPUT_CLASS = "w-full rounded-lg border border-borderSoft/80 bg-panelSoft/80 px-2.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60";
const SELECT_CLASS = "w-full rounded-lg border border-borderSoft/80 bg-panelSoft/80 px-2.5 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60";

type FilterState = {
  q: string;
  movement: "all" | WatchlistReviewRecommendationType;
  currentFlag: "all" | WatchlistReviewFlag;
  status: "all" | WatchlistReviewCandidateStatus;
  confidence: string;
  sectorTag: string;
  stale: "all" | "stale" | "fresh";
  destructive: "all" | "destructive" | "non_destructive";
};

type ConfirmState = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "default" | "danger";
  onConfirm: () => Promise<void> | void;
} | null;

const MOVEMENT_LABELS: Record<WatchlistReviewRecommendationType, string> = {
  RED_TO_BLUE: "Red to Blue",
  RED_TO_YELLOW: "Red to Yellow/Orange",
  BLUE_TO_RED: "Blue to Red",
  BLUE_TO_YELLOW: "Blue to Yellow/Orange",
  YELLOW_TO_BLUE: "Yellow/Orange to Blue",
  YELLOW_TO_RED: "Yellow/Orange to Red",
  ANY_TO_UNFLAG: "Any Flag to Unflag/Remove",
  KEEP_CURRENT: "Keep Current",
  MANUAL_REVIEW: "Manual Review",
};

const MOVEMENT_TITLES: Record<WatchlistReviewRecommendationType, string> = {
  RED_TO_BLUE: "Use when actionability faded but thesis remains valid.",
  RED_TO_YELLOW: "Use when setup is no longer actionable and unlikely this week.",
  BLUE_TO_RED: "Use when a Near-CP name becomes actionable near a meaningful pivot.",
  BLUE_TO_YELLOW: "Use sparingly when a Near-CP name drifts from setup quality.",
  YELLOW_TO_BLUE: "Use when a monitor name improves toward CP or reclaims support.",
  YELLOW_TO_RED: "Use when a monitor name becomes directly actionable.",
  ANY_TO_UNFLAG: "Strictest category; requires confirmed thesis or support invalidation.",
  KEEP_CURRENT: "Use when the current flag remains the best daily-review state.",
  MANUAL_REVIEW: "Use when chart context is too mixed for a clean automatic move.",
};

const METRIC_LABELS: Array<{ key: string; label: string; percent?: boolean; ratio?: boolean }> = [
  { key: "return_1d", label: "1D", percent: true },
  { key: "return_3d", label: "3D", percent: true },
  { key: "return_5d", label: "5D", percent: true },
  { key: "return_20d", label: "20D", percent: true },
  { key: "distance_to_10dma", label: "10DMA", percent: true },
  { key: "distance_to_20dma", label: "20DMA", percent: true },
  { key: "distance_to_50dma", label: "50DMA", percent: true },
  { key: "volume_ratio_20d", label: "Vol/20D", ratio: true },
  { key: "rs20_vs_spy", label: "RS20/SPY", percent: true },
  { key: "rs63_vs_spy", label: "RS63/SPY", percent: true },
  { key: "adr_extension", label: "ADR/Ext" },
  { key: "cp_notes", label: "CP/Support" },
  { key: "data_source", label: "Data" },
];

function pct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

function metricValue(metrics: Record<string, unknown>, key: string, options?: { percent?: boolean; ratio?: boolean }) {
  const value = metrics[key] ?? metrics[key.replace(/^return_/, "")] ?? metrics[key.replace("distance_to_", "dist_")];
  if (typeof value === "number" && Number.isFinite(value)) {
    if (options?.ratio) return `${value.toFixed(2)}x`;
    return options?.percent ? `${value.toFixed(1)}%` : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (typeof value === "string" && value.trim()) return value;
  return "-";
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function flagLabel(flag: WatchlistReviewFlag | WatchlistReviewProposedFlag) {
  if (flag === "red") return "Red";
  if (flag === "blue") return "Blue";
  if (flag === "yellow" || flag === "orange") return "Yellow/Orange";
  if (flag === "keep") return "Keep Current";
  if (flag === "unflag" || flag === "remove" || flag === "unflagged") return "Unflag/Remove";
  return "Unknown";
}

function flagClass(flag: WatchlistReviewFlag | WatchlistReviewProposedFlag) {
  if (flag === "red") return "border-rose-500/40 bg-rose-500/12 text-rose-200";
  if (flag === "blue") return "border-sky-400/40 bg-sky-500/12 text-sky-200";
  if (flag === "yellow" || flag === "orange") return "border-amber-400/40 bg-amber-500/12 text-amber-200";
  if (flag === "unflag" || flag === "remove" || flag === "unflagged") return "border-rose-400/50 bg-rose-500/15 text-rose-100";
  if (flag === "keep") return "border-slate-500/50 bg-slate-700/40 text-slate-200";
  return "border-slate-600/60 bg-panelSoft/60 text-slate-300";
}

function statusClass(status: WatchlistReviewCandidateStatus) {
  if (status === "approved") return "border-green-500/35 bg-green-500/10 text-green-300";
  if (status === "overridden") return "border-accent/35 bg-accent/10 text-accent";
  if (status === "skipped") return "border-slate-500/35 bg-slate-700/35 text-slate-300";
  if (status === "applied") return "border-violet-400/35 bg-violet-500/10 text-violet-200";
  return "border-amber-400/35 bg-amber-500/10 text-amber-200";
}

const RUN_APPLY_LABELS: Record<WatchlistReviewRunApplyStatus, string> = {
  not_queued: "Reviewing",
  approved_ready: "Approved ready",
  dispatching: "Dispatching",
  waiting_for_hermes: "Waiting for Hermes",
  claimed: "Hermes claimed",
  applying: "Applying in TradingView",
  applied: "Applied",
  partial_failed: "Partially failed",
  apply_failed: "Apply failed",
  cancelled: "Cancelled",
};

const CANDIDATE_APPLY_LABELS: Record<WatchlistReviewCandidateApplyStatus, string> = {
  not_queued: "not queued",
  queued_for_apply: "queued",
  applying: "applying",
  applied: "applied",
  apply_failed: "failed",
  skipped: "skipped",
};

function runApplyStatusClass(status: WatchlistReviewRunApplyStatus) {
  if (status === "applied") return "border-green-500/35 bg-green-500/10 text-green-300";
  if (status === "applying" || status === "claimed" || status === "waiting_for_hermes" || status === "dispatching") return "border-accent/35 bg-accent/10 text-accent";
  if (status === "partial_failed" || status === "apply_failed") return "border-rose-500/35 bg-rose-500/10 text-rose-200";
  if (status === "approved_ready") return "border-amber-400/35 bg-amber-500/10 text-amber-200";
  return "border-slate-600/60 bg-panelSoft/60 text-slate-300";
}

function candidateApplyStatusClass(status: WatchlistReviewCandidateApplyStatus) {
  if (status === "applied") return "border-green-500/35 bg-green-500/10 text-green-300";
  if (status === "applying" || status === "queued_for_apply") return "border-accent/35 bg-accent/10 text-accent";
  if (status === "apply_failed") return "border-rose-500/35 bg-rose-500/10 text-rose-200";
  return "border-slate-600/60 bg-panelSoft/60 text-slate-300";
}

function sourceLabel(value: string) {
  if (value === "data_only") return "data-only";
  if (value === "mini_chart") return "mini-chart";
  if (value === "full_chart_vision") return "full-chart vision";
  return "manual";
}

function sectorTags(candidate: WatchlistReviewCandidate) {
  const sector = typeof candidate.sectorContext?.sector === "string" ? candidate.sectorContext.sector : null;
  const tags = Array.isArray(candidate.sectorContext?.tags)
    ? candidate.sectorContext.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
    : [];
  return Array.from(new Set([sector, ...tags].filter((tag): tag is string => Boolean(tag))));
}

function isStale(candidate: WatchlistReviewCandidate) {
  return candidate.dataFreshness.is_stale === true || candidate.dataFreshness.isStale === true;
}

function approvedForExport(candidate: WatchlistReviewCandidate) {
  return candidate.status === "approved" || candidate.status === "overridden" || candidate.status === "applied";
}

function flagGroup(flag: WatchlistReviewFlag | WatchlistReviewProposedFlag) {
  if (flag === "red") return "red";
  if (flag === "blue") return "blue";
  if (flag === "yellow" || flag === "orange") return "yellow";
  if (flag === "unflag" || flag === "remove" || flag === "unflagged") return "unflag";
  if (flag === "keep") return "keep";
  if (flag === "manual_review") return "manual";
  return "unknown";
}

function candidateFinalFlag(candidate: WatchlistReviewCandidate) {
  return candidate.userOverrideFlag ?? candidate.proposedFlag;
}

function hasRealApplyChange(candidate: WatchlistReviewCandidate) {
  if (!approvedForExport(candidate)) return false;
  const proposed = candidateFinalFlag(candidate);
  const proposedGroup = flagGroup(proposed);
  if (proposedGroup === "keep" || proposedGroup === "manual" || proposedGroup === "unknown") return false;
  if (proposedGroup === "unflag" && flagGroup(candidate.currentFlag) === "unflag") return false;
  return flagGroup(candidate.currentFlag) !== proposedGroup;
}

function runDispatchStarted(run: WatchlistReviewRun | null) {
  return Boolean(run && run.applyStatus !== "not_queued" && run.applyStatus !== "apply_failed");
}

function runCanRetryWebhook(run: WatchlistReviewRun | null) {
  return Boolean(run && run.applyStatus === "approved_ready");
}

function runApplyActive(run: WatchlistReviewRun | null) {
  return Boolean(run && ["dispatching", "waiting_for_hermes", "claimed", "applying", "approved_ready"].includes(run.applyStatus));
}

function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function firstRunId(rows: WatchlistReviewRun[]) {
  return rows[0]?.id ?? null;
}

export function WatchlistReviewDashboard() {
  const [runs, setRuns] = useState<WatchlistReviewRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WatchlistReviewRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const [filters, setFilters] = useState<FilterState>({
    q: "",
    movement: "all",
    currentFlag: "all",
    status: "all",
    confidence: "0",
    sectorTag: "",
    stale: "all",
    destructive: "all",
  });
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [noteCandidate, setNoteCandidate] = useState<WatchlistReviewCandidate | null>(null);
  const [noteText, setNoteText] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  const loadRuns = async (preferredId?: string | null) => {
    setLoading(true);
    try {
      const res = await getWatchlistReviewRuns(25);
      const rows = res.rows ?? [];
      setRuns(rows);
      setSelectedRunId((current) => preferredId ?? current ?? firstRunId(rows));
      setMessage(null);
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to load review runs." });
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (runId: string) => {
    setDetailLoading(true);
    try {
      const res = await getWatchlistReviewRun(runId);
      setDetail(res);
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to load review run." });
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    void loadRuns();
  }, []);

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedRunId);
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId || !runApplyActive(detail?.run ?? null)) return;
    const id = window.setInterval(() => {
      void loadDetail(selectedRunId);
      void loadRuns(selectedRunId);
    }, 10_000);
    return () => window.clearInterval(id);
  }, [selectedRunId, detail?.run.applyStatus]);

  const candidates = detail?.candidates ?? [];
  const sectorOptions = useMemo(() => Array.from(new Set(candidates.flatMap(sectorTags))).sort(), [candidates]);
  const visibleCandidates = useMemo(() => {
    const minConfidence = Number(filters.confidence) || 0;
    const q = filters.q.trim().toUpperCase();
    return candidates.filter((candidate) => {
      if (q && !candidate.ticker.includes(q) && !(candidate.companyName ?? "").toUpperCase().includes(q)) return false;
      if (filters.movement !== "all" && candidate.recommendationType !== filters.movement) return false;
      if (filters.currentFlag !== "all" && candidate.currentFlag !== filters.currentFlag) return false;
      if (filters.status !== "all" && candidate.status !== filters.status) return false;
      if (candidate.confidence < minConfidence) return false;
      if (filters.sectorTag && !sectorTags(candidate).includes(filters.sectorTag)) return false;
      if (filters.stale === "stale" && !isStale(candidate)) return false;
      if (filters.stale === "fresh" && isStale(candidate)) return false;
      if (filters.destructive === "destructive" && !candidate.destructiveAction) return false;
      if (filters.destructive === "non_destructive" && candidate.destructiveAction) return false;
      return true;
    });
  }, [candidates, filters]);

  const visiblePending = visibleCandidates.filter((candidate) => candidate.status === "pending");
  const visibleApprovedDestructive = visibleCandidates.filter((candidate) => approvedForExport(candidate) && candidate.destructiveAction);
  const approvedDestructive = candidates.filter((candidate) => approvedForExport(candidate) && candidate.destructiveAction);
  const approvedApplyCandidates = candidates.filter(hasRealApplyChange);
  const approvedApplyDestructive = approvedApplyCandidates.filter((candidate) => candidate.destructiveAction || flagGroup(candidateFinalFlag(candidate)) === "unflag");
  const dispatchStarted = runDispatchStarted(detail?.run ?? null);
  const canRetryWebhook = runCanRetryWebhook(detail?.run ?? null);
  const canSendToHermes = Boolean(detail?.run)
    && approvedApplyCandidates.length > 0
    && approvedApplyDestructive.every((candidate) => candidate.destructiveConfirmed)
    && !dispatchStarted;

  const refreshSelected = async () => {
    if (selectedRunId) await loadDetail(selectedRunId);
    await loadRuns(selectedRunId);
  };

  const mutateCandidate = async (
    candidate: WatchlistReviewCandidate,
    action: WatchlistReviewCandidateAction,
    options?: { destructiveConfirmed?: boolean; userNote?: string | null; removalReason?: string | null },
  ) => {
    if (dispatchStarted) {
      setMessage({ tone: "danger", text: "This run has already been sent to Hermes, so review edits are locked." });
      return;
    }
    setSaving(true);
    try {
      await patchWatchlistReviewCandidate(candidate.id, {
        action,
        approvedBy: "authorized-user",
        destructiveConfirmed: options?.destructiveConfirmed,
        userNote: options?.userNote,
        removalReason: options?.removalReason,
      });
      await refreshSelected();
      setMessage({ tone: "success", text: `${candidate.ticker} updated.` });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to update candidate." });
    } finally {
      setSaving(false);
    }
  };

  const confirmDestructiveCandidate = (candidate: WatchlistReviewCandidate) => {
    setConfirm({
      title: `Unflag/Remove ${candidate.ticker}?`,
      description: "This is destructive. Confirm the chart invalidated support/thesis and that Hermes should export rollback history for this ticker.",
      confirmLabel: "Confirm Unflag/Remove",
      tone: "danger",
      onConfirm: async () => {
        setConfirm(null);
        await mutateCandidate(candidate, "unflag_remove", {
          destructiveConfirmed: true,
          removalReason: candidate.removalReason ?? "Confirmed support/thesis invalidation before export.",
        });
      },
    });
  };

  const confirmDestructiveApproval = (candidate: WatchlistReviewCandidate) => {
    setConfirm({
      title: `Approve Unflag/Remove for ${candidate.ticker}?`,
      description: "This approves a destructive recommendation. Confirm support/thesis invalidation before it is included in the Hermes apply export.",
      confirmLabel: "Approve Unflag/Remove",
      tone: "danger",
      onConfirm: async () => {
        setConfirm(null);
        await mutateCandidate(candidate, "approve", {
          destructiveConfirmed: true,
          removalReason: candidate.removalReason ?? "Confirmed destructive recommendation before export.",
        });
      },
    });
  };

  const runBatchApprove = async (destructiveConfirmed = false) => {
    if (!detail?.run) return;
    if (dispatchStarted) {
      setMessage({ tone: "danger", text: "This run has already been sent to Hermes, so batch review edits are locked." });
      return;
    }
    const ids = visiblePending.map((candidate) => candidate.id);
    if (ids.length === 0) return;
    const containsDestructive = visiblePending.some((candidate) => candidate.destructiveAction && !candidate.destructiveConfirmed);
    if (containsDestructive && !destructiveConfirmed) {
      setConfirm({
        title: "Approve visible destructive candidates?",
        description: "Visible pending candidates include Unflag/Remove recommendations. Confirm before batch approval.",
        confirmLabel: "Approve Visible",
        tone: "danger",
        onConfirm: async () => {
          setConfirm(null);
          await runBatchApprove(true);
        },
      });
      return;
    }
    setSaving(true);
    try {
      const res = await approveAllWatchlistReviewCandidates(detail.run.id, {
        candidateIds: ids,
        destructiveConfirmed,
        approvedBy: "authorized-user",
      });
      if (res.detail) setDetail(res.detail);
      await loadRuns(detail.run.id);
      setMessage({ tone: "success", text: `Approved ${res.updated} visible candidate${res.updated === 1 ? "" : "s"}.` });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Batch approve failed." });
    } finally {
      setSaving(false);
    }
  };

  const runBatchSkip = async () => {
    if (!detail?.run) return;
    if (dispatchStarted) {
      setMessage({ tone: "danger", text: "This run has already been sent to Hermes, so batch review edits are locked." });
      return;
    }
    const ids = visiblePending.map((candidate) => candidate.id);
    if (ids.length === 0) return;
    setSaving(true);
    try {
      const res = await skipAllWatchlistReviewCandidates(detail.run.id, {
        candidateIds: ids,
        approvedBy: "authorized-user",
      });
      if (res.detail) setDetail(res.detail);
      await loadRuns(detail.run.id);
      setMessage({ tone: "success", text: `Skipped ${res.updated} visible candidate${res.updated === 1 ? "" : "s"}.` });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Batch skip failed." });
    } finally {
      setSaving(false);
    }
  };

  const exportRun = async (destructiveConfirmed = false) => {
    if (!detail?.run) return;
    if (approvedDestructive.length > 0 && !destructiveConfirmed) {
      setConfirm({
        title: "Export Unflag/Remove approvals?",
        description: "Approved changes include destructive Unflag/Remove decisions. Confirm before producing the Hermes apply export.",
        confirmLabel: "Export Approved",
        tone: "danger",
        onConfirm: async () => {
          setConfirm(null);
          await exportRun(true);
        },
      });
      return;
    }
    setSaving(true);
    try {
      const res = await exportApprovedWatchlistReviewChanges(detail.run.id, { destructiveConfirmed, approvedBy: "authorized-user" });
      downloadText(res.exportPath, JSON.stringify(res.json, null, 2), "application/json;charset=utf-8");
      downloadText(res.exportPath.replace(/\.json$/, ".csv"), res.csv, "text/csv;charset=utf-8");
      await refreshSelected();
      setMessage({ tone: "success", text: res.message ?? `Exported ${res.approvedCount} approved decision${res.approvedCount === 1 ? "" : "s"}.` });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Export failed." });
    } finally {
      setSaving(false);
    }
  };

  const sendToHermes = async (destructiveConfirmed = false, retryWebhook = false) => {
    if (!detail?.run) return;
    if (!retryWebhook && (dispatchStarted || approvedApplyCandidates.length === 0 || (!destructiveConfirmed && approvedApplyDestructive.some((candidate) => !candidate.destructiveConfirmed)))) {
      setMessage({ tone: "danger", text: "Approve at least one real watchlist change and confirm destructive actions before sending to Hermes." });
      return;
    }
    if (!retryWebhook && approvedApplyDestructive.length > 0 && !destructiveConfirmed) {
      setConfirm({
        title: "Send Unflag/Remove approvals to Hermes?",
        description: "This freezes the approved set for Hermes MCP/CDP execution. Confirm all destructive Unflag/Remove candidates have support/thesis invalidation and rollback notes.",
        confirmLabel: "Send to Hermes",
        tone: "danger",
        onConfirm: async () => {
          setConfirm(null);
          await sendToHermes(true);
        },
      });
      return;
    }
    setSaving(true);
    try {
      const res = await readyToApplyWatchlistReviewRun(detail.run.id, {
        destructiveConfirmed,
        approvedBy: "authorized-user",
        retryWebhook,
      });
      await refreshSelected();
      const text = res.webhook.status === "sent"
        ? "Sent to Hermes. Waiting for apply status."
        : res.webhook.status === "already_pending"
          ? "This approved set is already waiting for Hermes."
          : "Approved set is ready. Hermes poller can pick it up.";
      setMessage({ tone: res.webhook.status === "failed" ? "info" : "success", text });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to send approved changes to Hermes." });
    } finally {
      setSaving(false);
    }
  };

  const submitImport = async () => {
    if (!importText.trim()) return;
    setSaving(true);
    try {
      const parsed = JSON.parse(importText) as { run?: Record<string, unknown>; candidates?: Array<Record<string, unknown>> };
      const res = await createWatchlistReviewRun({
        run: parsed.run ?? {},
        candidates: parsed.candidates ?? [],
      });
      setImportText("");
      setImportOpen(false);
      await loadRuns(res.run.id);
      setSelectedRunId(res.run.id);
      setDetail({ run: res.run, candidates: res.candidates, events: res.events });
      setMessage({ tone: "success", text: `Imported ${res.candidates.length} review candidates.` });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Import failed." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[22rem,minmax(0,1fr)]">
      <aside className="space-y-4">
        <section className="card p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-200">Review Runs</h3>
            <button className={BUTTON_CLASS} onClick={() => void loadRuns(selectedRunId)} type="button">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Loading runs...</div>
          ) : runs.length === 0 ? (
            <div className="rounded-lg border border-borderSoft/60 bg-panelSoft/40 px-3 py-2 text-sm text-slate-400">No review runs yet.</div>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <button
                  key={run.id}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition ${run.id === selectedRunId ? "border-accent/60 bg-accent/10" : "border-borderSoft/60 hover:bg-slate-900/30"}`}
                  onClick={() => setSelectedRunId(run.id)}
                  type="button"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-sm font-semibold text-accent">{run.sourceWatchlistName ?? run.id}</div>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] ${runApplyStatusClass(run.applyStatus)}`}>{RUN_APPLY_LABELS[run.applyStatus]}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-slate-400">
                    {run.candidateCount ?? 0} candidates / {run.approvedCount ?? 0} approved / {run.pendingCount ?? 0} pending
                  </div>
                  <div className="text-[11px] text-slate-500">{formatDateTime(run.createdAt)}</div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="card p-3">
          <button className={`${BUTTON_CLASS} w-full`} onClick={() => setImportOpen((current) => !current)} type="button">
            <Upload className="h-3.5 w-3.5" />
            Import Hermes JSON
          </button>
          {importOpen ? (
            <div className="mt-3 space-y-2">
              <textarea
                className={`${INPUT_CLASS} min-h-40 font-mono text-xs`}
                placeholder='{"run":{"id":"watchlist-review-2026-06-12"},"candidates":[...]}'
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
              />
              <button className={`${PRIMARY_BUTTON_CLASS} w-full`} disabled={saving || !importText.trim()} onClick={() => void submitImport()} type="button">
                <FileJson className="h-3.5 w-3.5" />
                Load Review Run
              </button>
            </div>
          ) : null}
        </section>

        <section className="card p-3">
          <h3 className="text-sm font-semibold text-slate-200">Rule Notes</h3>
          <div className="mt-3 space-y-2 text-xs text-slate-400">
            <p title="Do not use exact distance from 20D high as a primary factor.">Use price zones, shelves, support/resistance, and multi-touch pivots over random wick highs.</p>
            <p title="Sector/focus context can offset short moving-average weakness.">Strong sector/focus names can stay Blue when support remains valid.</p>
            <p title="Unflag/Remove is the strictest category.">Unflag/Remove requires confirmed thesis or support invalidation and rollback history.</p>
          </div>
        </section>
      </aside>

      <section className="space-y-4">
        <div className="card p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-slate-200">{detail?.run.sourceWatchlistName ?? detail?.run.id ?? "Watchlist Review"}</h3>
                {detail?.run ? (
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] ${runApplyStatusClass(detail.run.applyStatus)}`}>
                    {RUN_APPLY_LABELS[detail.run.applyStatus]}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-slate-400">
                {detail?.run.watchlistSetId || detail?.run.watchlistRunId
                  ? `Compiler link ${detail.run.watchlistSetId ?? "-"} / ${detail.run.watchlistRunId ?? "-"}`
                  : "Hermes/TradingView MCP approval workspace"}
                {detail?.run.prepId ? ` | Prep ${detail.run.prepId}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link className={BUTTON_CLASS} href="/watchlist-compiler">
                <FileJson className="h-3.5 w-3.5" />
                Compiler
              </Link>
              <button className={PRIMARY_BUTTON_CLASS} disabled={saving || dispatchStarted || visiblePending.length === 0} onClick={() => void runBatchApprove()} type="button">
                <Check className="h-3.5 w-3.5" />
                Approve all visible
              </button>
              <button className={BUTTON_CLASS} disabled={saving || dispatchStarted || visiblePending.length === 0} onClick={() => void runBatchSkip()} type="button">
                <SkipForward className="h-3.5 w-3.5" />
                Skip all visible
              </button>
              <button className={BUTTON_CLASS} disabled={saving || !detail || !candidates.some(approvedForExport)} onClick={() => void exportRun()} type="button">
                <Download className="h-3.5 w-3.5" />
                Export approved
              </button>
              <button className={PRIMARY_BUTTON_CLASS} disabled={saving || !canSendToHermes} onClick={() => void sendToHermes()} type="button">
                <Send className="h-3.5 w-3.5" />
                Send approved changes to Hermes
              </button>
              {canRetryWebhook ? (
                <button className={BUTTON_CLASS} disabled={saving} onClick={() => void sendToHermes(false, true)} type="button">
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry Hermes webhook
                </button>
              ) : null}
            </div>
          </div>
          {message ? (
            <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
              message.tone === "danger"
                ? "border-rose-500/30 bg-rose-500/10 text-rose-200"
                : message.tone === "success"
                  ? "border-green-500/30 bg-green-500/10 text-green-300"
                  : "border-accent/30 bg-accent/10 text-accent"
            }`}>
              {message.text}
            </div>
          ) : null}
        </div>

        <SummaryRow run={detail?.run ?? null} candidates={candidates} />

        <div className="sticky top-0 z-20 rounded-xl border border-borderSoft/80 bg-panel/95 p-3 backdrop-blur-xl">
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[minmax(8rem,1.2fr),10rem,11rem,10rem,8rem,11rem,9rem,10rem]">
            <input className={INPUT_CLASS} placeholder="Ticker or company" value={filters.q} onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))} />
            <select className={SELECT_CLASS} value={filters.movement} onChange={(event) => setFilters((current) => ({ ...current, movement: event.target.value as FilterState["movement"] }))}>
              <option value="all">All moves</option>
              {Object.entries(MOVEMENT_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <select className={SELECT_CLASS} value={filters.currentFlag} onChange={(event) => setFilters((current) => ({ ...current, currentFlag: event.target.value as FilterState["currentFlag"] }))}>
              <option value="all">All current</option>
              <option value="red">Red</option>
              <option value="blue">Blue</option>
              <option value="yellow">Yellow</option>
              <option value="orange">Orange</option>
              <option value="unflagged">Unflagged</option>
              <option value="unknown">Unknown</option>
            </select>
            <select className={SELECT_CLASS} value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value as FilterState["status"] }))}>
              <option value="all">All status</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="skipped">Skipped</option>
              <option value="overridden">Overridden</option>
              <option value="applied">Applied</option>
            </select>
            <input className={INPUT_CLASS} min={0} max={1} step={0.05} type="number" value={filters.confidence} onChange={(event) => setFilters((current) => ({ ...current, confidence: event.target.value }))} aria-label="Minimum confidence" />
            <select className={SELECT_CLASS} value={filters.sectorTag} onChange={(event) => setFilters((current) => ({ ...current, sectorTag: event.target.value }))}>
              <option value="">All sectors/tags</option>
              {sectorOptions.map((sector) => <option key={sector} value={sector}>{sector}</option>)}
            </select>
            <select className={SELECT_CLASS} value={filters.stale} onChange={(event) => setFilters((current) => ({ ...current, stale: event.target.value as FilterState["stale"] }))}>
              <option value="all">All freshness</option>
              <option value="stale">Stale only</option>
              <option value="fresh">Fresh only</option>
            </select>
            <select className={SELECT_CLASS} value={filters.destructive} onChange={(event) => setFilters((current) => ({ ...current, destructive: event.target.value as FilterState["destructive"] }))}>
              <option value="all">All actions</option>
              <option value="destructive">Unflag only</option>
              <option value="non_destructive">Non-destructive</option>
            </select>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>{visibleCandidates.length} visible / {visiblePending.length} pending visible</span>
            {visibleApprovedDestructive.length > 0 ? (
              <span className="inline-flex items-center gap-1 text-rose-200"><AlertTriangle className="h-3.5 w-3.5" />{visibleApprovedDestructive.length} approved destructive visible</span>
            ) : null}
          </div>
        </div>

        {detailLoading ? (
          <div className="card flex items-center gap-2 p-4 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Loading candidates...</div>
        ) : visibleCandidates.length === 0 ? (
          <div className="card p-4 text-sm text-slate-400">No candidates match the current filters.</div>
        ) : (
          <div className="space-y-3">
            {visibleCandidates.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                saving={saving}
                actionsDisabled={dispatchStarted}
                onAction={(action) => {
                  if (action === "unflag_remove") {
                    confirmDestructiveCandidate(candidate);
                    return;
                  }
                  if (action === "approve" && candidate.destructiveAction && !candidate.destructiveConfirmed) {
                    confirmDestructiveApproval(candidate);
                    return;
                  }
                  void mutateCandidate(candidate, action);
                }}
                onNote={() => {
                  setNoteCandidate(candidate);
                  setNoteText(candidate.userNote ?? "");
                }}
              />
            ))}
          </div>
        )}
      </section>

      {noteCandidate ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm" onClick={() => setNoteCandidate(null)}>
          <div className="card w-full max-w-xl p-4" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-slate-100">Note for {noteCandidate.ticker}</h3>
                <p className="text-xs text-slate-400">Stored with the candidate and included in approved exports.</p>
              </div>
              <button className={BUTTON_CLASS} onClick={() => setNoteCandidate(null)} type="button"><X className="h-3.5 w-3.5" /></button>
            </div>
            <textarea className={`${INPUT_CLASS} mt-4 min-h-36`} value={noteText} onChange={(event) => setNoteText(event.target.value)} />
            <div className="mt-3 flex justify-end gap-2">
              <button className={BUTTON_CLASS} onClick={() => setNoteCandidate(null)} type="button">Cancel</button>
              <button
                className={PRIMARY_BUTTON_CLASS}
                disabled={saving}
                onClick={async () => {
                  const candidate = noteCandidate;
                  setNoteCandidate(null);
                  await mutateCandidate(candidate, "note", { userNote: noteText });
                }}
                type="button"
              >
                <StickyNote className="h-3.5 w-3.5" />
                Save Note
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title ?? ""}
        description={confirm?.description ?? ""}
        confirmLabel={confirm?.confirmLabel}
        tone={confirm?.tone}
        busy={saving}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void confirm?.onConfirm()}
      />
    </div>
  );
}

function SummaryRow({ run, candidates }: { run: WatchlistReviewRun | null; candidates: WatchlistReviewCandidate[] }) {
  const approved = candidates.filter(approvedForExport).length;
  const skipped = candidates.filter((candidate) => candidate.status === "skipped").length;
  const pending = candidates.filter((candidate) => candidate.status === "pending").length;
  const destructive = candidates.filter((candidate) => candidate.destructiveAction).length;
  return (
    <div className="grid gap-3 md:grid-cols-4 xl:grid-cols-9">
      <StatCard label="Scanned" value={String(run?.totalTickersScanned ?? "-")} helper="source tickers" />
      <StatCard label="Candidates" value={String(candidates.length)} helper="in run" />
      <StatCard label="Pending" value={String(pending)} helper="needs review" />
      <StatCard label="Approved" value={String(approved)} helper="export-ready" />
      <StatCard label="Skipped" value={String(skipped)} helper="no change" />
      <StatCard label="Unflag" value={String(destructive)} helper="requires confirm" />
      <StatCard label="Hermes" value={run ? RUN_APPLY_LABELS[run.applyStatus] : "-"} helper={run?.activeApplyDispatchId ? `rev ${run.approvalRevision}` : "not sent"} />
      <StatCard label="Blue to Red" value={String(run?.summaryCounts.blue_to_red ?? 0)} helper="promotions" />
      <StatCard label="Keep" value={String(run?.summaryCounts.keep_current ?? 0)} helper="current flag" />
    </div>
  );
}

function CandidateCard({ candidate, saving, actionsDisabled, onAction, onNote }: {
  candidate: WatchlistReviewCandidate;
  saving: boolean;
  actionsDisabled: boolean;
  onAction: (action: WatchlistReviewCandidateAction) => void;
  onNote: () => void;
}) {
  const tags = sectorTags(candidate);
  const latestBar = typeof candidate.dataFreshness.latest_bar_date === "string" ? candidate.dataFreshness.latest_bar_date : null;
  const expectedBar = typeof candidate.dataFreshness.expected_latest_session === "string" ? candidate.dataFreshness.expected_latest_session : null;
  return (
    <article className={`card p-3 ${candidate.destructiveAction ? "border-rose-500/35" : ""}`}>
      <div className="grid gap-3 2xl:grid-cols-[11rem,minmax(0,1fr),18rem]">
        <div className="space-y-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xl font-semibold text-slate-100">{candidate.ticker}</h3>
              <span className={`rounded-full border px-2 py-0.5 text-xs ${statusClass(candidate.status)}`}>{candidate.status}</span>
              {candidate.applyStatus !== "not_queued" ? (
                <span className={`rounded-full border px-2 py-0.5 text-xs ${candidateApplyStatusClass(candidate.applyStatus)}`}>
                  {CANDIDATE_APPLY_LABELS[candidate.applyStatus]}
                </span>
              ) : null}
            </div>
            <div className="mt-1 line-clamp-2 text-xs text-slate-400">{candidate.companyName ?? "No company name"}</div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full border px-2 py-0.5 text-[11px] ${flagClass(candidate.currentFlag)}`} title="Current TradingView flag">{flagLabel(candidate.currentFlag)}</span>
            <span className="text-xs text-slate-500">to</span>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] ${flagClass(candidate.proposedFlag)}`} title="Proposed action">{flagLabel(candidate.proposedFlag)}</span>
          </div>
          <div className="rounded-lg border border-borderSoft/60 bg-panelSoft/35 px-3 py-2">
            <div className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Confidence</div>
            <div className="mt-1 font-mono text-lg text-slate-100">{pct(candidate.confidence)}</div>
          </div>
        </div>

        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-borderSoft/70 bg-panelSoft/50 px-2.5 py-1 text-xs text-slate-300" title={MOVEMENT_TITLES[candidate.recommendationType]}>
              {MOVEMENT_LABELS[candidate.recommendationType]}
            </span>
            <span className="rounded-full border border-borderSoft/70 bg-panelSoft/50 px-2.5 py-1 text-xs text-slate-300">{sourceLabel(candidate.analysisSource)}</span>
            {isStale(candidate) ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-200">
                <AlertTriangle className="h-3.5 w-3.5" />
                stale {latestBar ?? "-"} / expected {expectedBar ?? "-"}
              </span>
            ) : null}
            {candidate.destructiveAction ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-rose-400/40 bg-rose-500/10 px-2.5 py-1 text-xs text-rose-200">
                <ShieldAlert className="h-3.5 w-3.5" />
                confirmation required
              </span>
            ) : null}
          </div>

          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {METRIC_LABELS.map((metric) => (
              <Metric key={metric.key} label={metric.label} value={metricValue(candidate.metrics, metric.key, metric)} />
            ))}
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr),15rem]">
            <div className="space-y-1.5">
              {candidate.reasons.length === 0 ? (
                <div className="rounded-lg border border-borderSoft/60 bg-panelSoft/35 px-3 py-2 text-xs text-slate-500">No reason bullets supplied.</div>
              ) : candidate.reasons.map((reason) => (
                <div key={reason} className="rounded-lg border border-borderSoft/60 bg-panelSoft/35 px-3 py-2 text-xs text-slate-300">{reason}</div>
              ))}
            </div>
            <div className="rounded-lg border border-borderSoft/60 bg-panelSoft/35 px-3 py-2 text-xs text-slate-400">
              <div className="font-semibold text-slate-200">Context</div>
              <div className="mt-1">{tags.length ? tags.join(" / ") : "-"}</div>
              <div className="mt-2">Latest bar: <span className="font-mono text-slate-200">{latestBar ?? "-"}</span></div>
              <div>Source: <span className="font-mono text-slate-200">{typeof candidate.dataFreshness.source === "string" ? candidate.dataFreshness.source : "-"}</span></div>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="aspect-[16/10] overflow-hidden rounded-lg border border-borderSoft/70 bg-slate-950/50">
            {candidate.chartImageUrl ? (
              <img className="h-full w-full object-cover" src={candidate.chartImageUrl} alt={`${candidate.ticker} chart snapshot`} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-slate-500">
                <Flag className="h-5 w-5 text-slate-500" />
                Chart snapshot placeholder
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button className={PRIMARY_BUTTON_CLASS} disabled={saving || actionsDisabled || candidate.status === "applied"} onClick={() => onAction("approve")} type="button"><Check className="h-3.5 w-3.5" />Approve</button>
            <button className={BUTTON_CLASS} disabled={saving || actionsDisabled || candidate.status === "applied"} onClick={() => onAction("skip")} type="button"><SkipForward className="h-3.5 w-3.5" />Skip</button>
            <button className={BUTTON_CLASS} disabled={saving || actionsDisabled || candidate.status === "applied"} onClick={() => onAction("keep_current")} type="button">Keep Current</button>
            <button className={BUTTON_CLASS} disabled={saving || actionsDisabled || candidate.status === "applied"} onClick={() => onAction("move_red")} type="button">Move Red</button>
            <button className={BUTTON_CLASS} disabled={saving || actionsDisabled || candidate.status === "applied"} onClick={() => onAction("move_blue")} type="button">Move Blue</button>
            <button className={BUTTON_CLASS} disabled={saving || actionsDisabled || candidate.status === "applied"} onClick={() => onAction("move_yellow_orange")} type="button">Move Yellow/Orange</button>
            <button className={DANGER_BUTTON_CLASS} disabled={saving || actionsDisabled || candidate.status === "applied"} onClick={() => onAction("unflag_remove")} type="button"><Trash2 className="h-3.5 w-3.5" />Unflag/Remove</button>
            <button className={BUTTON_CLASS} disabled={saving || actionsDisabled} onClick={onNote} type="button"><StickyNote className="h-3.5 w-3.5" />Add Note</button>
          </div>
          {candidate.applyError ? <div className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{candidate.applyError}</div> : null}
          {candidate.userNote ? <div className="rounded-lg border border-accent/20 bg-accent/10 px-3 py-2 text-xs text-slate-200">{candidate.userNote}</div> : null}
        </div>
      </div>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-borderSoft/70 bg-panelSoft/35 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-slate-500">{label}</div>
      <div className="mt-1 truncate font-mono text-xs text-slate-100" title={value}>{value}</div>
    </div>
  );
}

function StatCard({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <div className="card px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-slate-100">{value}</div>
      <div className="text-[11px] text-slate-400">{helper}</div>
    </div>
  );
}
