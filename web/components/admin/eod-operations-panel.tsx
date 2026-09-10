"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getEodPublicationStatus, getEodRecoveryStatus, type EodPublicationStatus, type EodRecoveryStatus } from "@/lib/api";
import { buildEodRecoveryView } from "@/lib/eod-recovery-status";
import { AdminCard } from "./admin-card";
import { InlineAlert } from "./inline-alert";

function count(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "Unavailable";
}

function timestamp(value: string | null | undefined): string {
  return value ? value.replace("T", " ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC") : "Unavailable";
}

export function EodOperationsPanel() {
  const [data, setData] = useState<EodPublicationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<EodRecoveryStatus | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const checking = useRef(false);
  const refresh = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    setLoading(true);
    try {
      const [publicationResult, recoveryResult] = await Promise.allSettled([
        getEodPublicationStatus({ signal: AbortSignal.timeout(10_000) }),
        getEodRecoveryStatus({ signal: AbortSignal.timeout(10_000) }),
      ]);
      if (publicationResult.status === "fulfilled") {
        setData(publicationResult.value); setError(null);
      } else setError(publicationResult.reason instanceof Error ? publicationResult.reason.message : "EOD status unavailable.");
      if (recoveryResult.status === "fulfilled") {
        setRecovery(recoveryResult.value); setRecoveryError(null);
      } else setRecoveryError(recoveryResult.reason instanceof Error ? recoveryResult.reason.message : "Recovery status unavailable.");
    } finally {
      checking.current = false;
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const visibleRefresh = () => { if (document.visibilityState === "visible") void refresh(); };
    visibleRefresh();
    const interval = window.setInterval(visibleRefresh, 60_000);
    document.addEventListener("visibilitychange", visibleRefresh);
    window.addEventListener("focus", visibleRefresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibleRefresh);
      window.removeEventListener("focus", visibleRefresh);
    };
  }, [refresh]);
  const summary = buildEodRecoveryView({ recovery, publications: data, recoveryError, publicationError: error });
  const currentMonitoring = summary.monitoringCount !== null;
  const deliveryCurrent = Boolean(data?.ready && !error);
  const statusLabel = summary.status === "paused" && summary.reportFreshness !== "current" ? "Paused (last known)"
    : summary.status[0].toUpperCase() + summary.status.slice(1);
  const checkButton = <button className="rounded-xl border border-borderSoft/80 px-3 py-2 text-sm disabled:opacity-50" disabled={loading}
    onClick={() => void refresh()} type="button">{loading ? "Checking..." : "Check Status"}</button>;

  return (
    <div className="space-y-4">
    <AdminCard title="EOD recovery" description="Recovery, verified production configuration and three trading sessions of monitored delivery. Status refreshes every minute while visible." actions={checkButton}>
      <div className="space-y-4" aria-live="polite">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`rounded-full border px-3 py-1 text-sm font-semibold ${summary.status === "complete" ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300"
            : summary.status === "paused" ? "border-rose-400/30 bg-rose-500/10 text-rose-300"
              : "border-amber-400/30 bg-amber-500/10 text-amber-200"}`}>{statusLabel}</span>
          <span className="text-sm text-slate-400">Stage: <strong className="font-medium text-text">{summary.stage}</strong></span>
        </div>
        {summary.blocker ? <InlineAlert tone={summary.status === "paused" ? "warning" : "info"} title={summary.status === "paused" ? "Needs attention" : "What remains"}>{summary.blocker}</InlineAlert>
          : <p className="text-sm text-emerald-300">Recovery cutover, configuration recording and the three-session monitoring gate are complete.</p>}
        {recoveryError ? <p className="text-xs text-amber-300">Recovery check failed: {recoveryError}{recovery ? " Last-known report retained." : ""}</p> : null}
        {error ? <p className="text-xs text-amber-300">Publication check failed; delivery and monitoring completion are unverified. Recovery-controller progress is checked independently.</p> : null}
        <div className="grid gap-3 md:grid-cols-3">
          {summary.milestones.map((milestone) => <div key={milestone.label} className={`rounded-xl border p-3 text-sm ${milestone.status === "complete" ? "border-emerald-400/20" : "border-borderSoft/70"}`}>
            <div className="flex items-start justify-between gap-3"><p className="font-semibold">{milestone.label}</p>
              <span className={`text-xs capitalize ${milestone.status === "complete" ? "text-emerald-300" : milestone.status === "blocked" ? "text-rose-300" : "text-slate-400"}`}>{milestone.status}</span></div>
            <p className="mt-2 text-xs text-slate-400">{milestone.detail}</p>
          </div>)}
        </div>
        <p className="text-xs text-slate-400">Trading-day usage settles after an additional UTC day; no weekend run is required.</p>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="text-slate-400">Next recovery retry</dt><dd className="mt-1">{summary.nextRetry ? timestamp(summary.nextRetry) : summary.status === "complete" ? "Recovery finished" : "No retry reported"}</dd></div>
          <div><dt className="text-slate-400">Recovery computer needed</dt><dd className="mt-1"><span className="capitalize">{summary.computerNeeded}</span><p className="mt-1 text-xs text-slate-400">{summary.computerDetail}</p></dd></div>
          <div><dt className="text-slate-400">Last controller report</dt><dd className={`mt-1 ${summary.reportFreshness === "outdated" ? "text-amber-300" : ""}`}>{timestamp(summary.lastReportAt)} <span className="text-xs">({summary.reportFreshness})</span></dd></div>
          <div><dt className="text-slate-400">Last recovery status check</dt><dd className="mt-1">{timestamp(summary.lastCheckedAt)}</dd></div>
        </dl>
        {recovery?.configuration.recordedAt ? <p className="text-xs text-slate-500">Configuration record: {timestamp(recovery.configuration.recordedAt)}. Monitoring progress is a separate check.</p> : null}
      </div>
    </AdminCard>
    <AdminCard title="EOD Publications" description="GitHub batch delivery for Overview and Breadth, targeted within two hours of the actual US exchange close. Visible status refreshes every minute."
      actions={checkButton}>
      <div className="space-y-4">
        {error ? <InlineAlert tone="danger">Status check failed: {error}{data ? " The last successful status is retained below." : ""}</InlineAlert> : null}
        {!data ? <p className="text-sm text-slate-400">{loading ? "Loading EOD status..." : "No EOD status available."}</p> : <>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <span>Mode: <strong>{data.pipelineMode ?? data.mode}</strong></span>
            <span>Delivery: <strong className={deliveryCurrent ? "text-emerald-400" : "text-amber-300"}>{error ? "Last-known status; unverified" : data.ready ? "All scopes current" : data.mode === "disabled" ? "Disabled" : "Pending"}</strong></span>
            <span>Expected session: <strong>{data.expectedSession ?? "Unavailable"}</strong></span>
            <span>Last complete session: <strong>{data.lastSuccessfulSession ?? "Unavailable"}</strong></span>
          </div>
          {data.storageMigration ? <div className="rounded-xl border border-borderSoft/70 p-3 text-sm">
            <p className="font-semibold">Storage migration: {data.storageMigration.status}</p>
            <p className="mt-1 text-slate-400">Stage: {data.storageMigration.failedStage ?? data.storageMigration.stage} · Session: {data.storageMigration.sessionDate}</p>
            <p className="text-slate-400">Archived rows: {count(data.storageMigration.archivedRows)} · Current table rows copied: {count(data.storageMigration.copiedRows)}</p>
            <p className="text-slate-400">{data.storageMigration.sourceSnapshotCaptured ? "Source capture recorded; cutover requires verification." : "Preflight in progress; source capture not yet recorded."}</p>
            {data.storageMigration.errorCode ? <p className="text-amber-300">{data.storageMigration.errorCode}</p> : null}
            <p className="text-slate-400">{data.storageMigration.nextAttemptAt ? `Next retry: ${timestamp(data.storageMigration.nextAttemptAt)}` : "No automatic retry scheduled."} Updated: {timestamp(data.storageMigration.updatedAt)}</p>
          </div> : null}
          <div className="rounded-xl border border-borderSoft/70 p-3 text-sm">
            <p className="font-semibold">Monitored delivery: {currentMonitoring ? `${data.monitoring!.consecutivePassedSessions}/3 consecutive trading sessions` : "Awaiting current three-session evidence"}</p>
            <p className="mt-1 text-slate-400">{summary.milestones[2].status === "complete" ? "Delivery and finalized usage checks passed. Configuration recording is verified separately above." : "Three consecutive trading sessions must pass delivery and finalized usage checks. Weekends and exchange holidays do not count."}</p>
            {data.monitoring ? <>
              <p className={data.monitoring.stale || error || !currentMonitoring ? "text-amber-300" : "text-slate-400"}>Checked: {timestamp(data.monitoring.checkedAt)}{data.monitoring.stale || error ? " (outdated or unavailable)" : !currentMonitoring ? " (previous monitoring policy; cannot complete the current gate)" : ""}</p>
              {data.monitoring.reasons.length ? <p className="text-amber-300">{data.monitoring.reasons.join(", ")}</p> : null}
              {currentMonitoring && data.monitoring.usageFinalizationCutoff ? <p className="mt-1 text-xs text-slate-400">Finalized trading-session window through {data.monitoring.usageFinalizationCutoff}. Newer deliveries are tracked separately while usage settles.</p> : null}
              <details className="mt-2 text-xs text-slate-400"><summary className="cursor-pointer">Session and finalized UTC usage checks</summary>
                {data.monitoring.newerSessions?.length ? <div className="my-2 rounded-lg border border-borderSoft/60 p-2">
                  <p className="font-medium">Newer trading sessions — usage may still be settling</p>
                  {data.monitoring.newerSessions.map((session) => <p className={`mt-1 ${session.status === "failed" ? "text-amber-300" : ""}`} key={session.sessionDate}>{session.sessionDate}: {session.status} · First complete public delivery {timestamp(session.firstCompletePublicationAt)}{session.reasons.length ? ` · ${session.reasons.join(", ")}` : ""}</p>)}
                </div> : null}
                {data.monitoring.sessions.map((session) => <p className="mt-1" key={session.sessionDate}>{session.sessionDate}: {session.status} · Deadline {timestamp(session.deadlineAt)} · First complete public delivery {timestamp(session.firstCompletePublicationAt)}{session.reasons.length ? ` · ${session.reasons.join(", ")}` : ""}</p>)}
                {data.monitoring.usageDays.map((day) => <p className="mt-1" key={day.usageDate}>UTC {day.usageDate}: {day.status}{day.requiredForRetirement === false ? " · Informational; outside the trading-session gate" : ""}{day.reasons.length ? ` · ${day.reasons.join(", ")}` : ""}</p>)}
              </details>
            </> : <p className="text-xs text-slate-500">The daily monitoring job records actual publication times and finalized account usage. Missing evidence does not count as a passed session.</p>}
          </div>
          {data.missingScopes?.length ? <InlineAlert tone="info">Awaiting current publications: {data.missingScopes.join(", ")}</InlineAlert> : null}
          {data.inputCorrectionsPending === true ? <InlineAlert tone="info">Stored inputs changed after the completed publication run. Corrected publications are pending (input revision {count(data.inputRevision)}; published run revision {count(data.completedInputRevision)}).</InlineAlert> : null}
          {data.inputCorrectionsPending === null ? <InlineAlert tone="info">Input correction status is unknown; the latest input clock or completed-run watermark is unavailable.</InlineAlert> : null}
          {data.capacity?.warning ? <InlineAlert tone="danger">{data.capacity.warning}</InlineAlert> : null}
          {data.storageCapacity ? <div className="rounded-xl border border-borderSoft/70 p-3 text-sm">
            <p className="font-semibold">Measured storage: {data.storageCapacity.status}</p>
            <p className="text-slate-400">Recent history: {data.storageCapacity.hotSessions} sessions. Archived history remains available.</p>
            <p className="text-slate-400">Market bytes: {count(data.storageCapacity.marketPhysicalBytes)}; archive bytes: {count(data.storageCapacity.archivePhysicalBytes)}</p>
            <p className="text-slate-400">Forecast covers {data.storageCapacity.forecastSessions} sessions through {data.storageCapacity.forecastLastSession}; expires {timestamp(data.storageCapacity.horizonExpiresAt)}.</p>
            <p className="text-slate-400">Checked: {timestamp(data.storageCapacity.checkedAt)}</p>
            {data.storageCapacity.error ? <p className="text-amber-300">{data.storageCapacity.error}</p> : null}
          </div> : null}
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-borderSoft/70 p-3 text-sm">
              <p className="font-semibold">Tracked EOD usage · {data.quota?.usageDate ?? "Unavailable"}</p>
              <p className="mt-1 text-slate-400">Reads {count(data.quota?.rowsRead)} · Writes {count(data.quota?.rowsWritten)}</p>
              <p className="text-slate-400">Reserved reads {count(data.quota?.reservedReads)} · Reserved writes {count(data.quota?.reservedWrites)}</p>
              <p className={data.quota?.status === "blocked" ? "text-amber-300" : "text-slate-400"}>Quota state: {data.quota?.status ?? "unknown"} · UTC reset {timestamp(data.quota?.resetAt)}</p>
              {data.quota?.nextAttemptAt ? <p className="text-slate-400">Next quota retry: {timestamp(data.quota.nextAttemptAt)}</p> : null}
            </div>
            <div className="rounded-xl border border-borderSoft/70 p-3 text-sm">
              <p className="font-semibold">Cloudflare account usage · {data.accountUsage?.usage_date ?? "Unavailable"}</p>
              <p className="mt-1 text-slate-400">Reads {count(data.accountUsage?.rows_read)} · Writes {count(data.accountUsage?.rows_written)}</p>
              <p className="text-slate-400">Sampled: {timestamp(data.accountUsage?.sampled_at)}</p>
              <p className="text-xs text-slate-500">Account totals include other workflows. Tracked EOD counters alone cannot establish account quota availability.</p>
              {data.accountUsage?.error ? <p className="text-amber-300">{data.accountUsage.error}</p> : null}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-400"><tr><th className="p-2">Session / Purpose</th><th className="p-2">Status / Stage</th><th className="p-2">Attempt / Retry</th><th className="p-2">Delivery Deadline</th><th className="p-2">Issue</th></tr></thead>
              <tbody>{data.runs.map((run, index) => <tr key={run.id ?? `${run.session_date}-${index}`} className="border-t border-borderSoft/60 align-top">
                <td className="p-2 whitespace-nowrap">{run.session_date}<div className="text-slate-500">{run.purpose ?? "daily"} · {run.mode ?? data.mode}</div>{run.historyTickers?.length ? <div className="max-w-xs whitespace-normal text-slate-500">{run.historySessions ?? "Requested"} sessions: {run.historyTickers.join(", ")}</div> : null}</td>
                <td className="p-2">{run.status}<div className="text-slate-500">{run.failedStage ? `Failed stage: ${run.failedStage}` : run.stage ?? "Unavailable"}</div></td>
                <td className="p-2">{run.attempt ?? "Unavailable"}<div className="text-slate-500">{run.next_attempt_at ? timestamp(run.next_attempt_at) : "No retry scheduled"}</div></td>
                <td className="p-2">{run.deadlineAppliesToDelivery === false ? "Not a delivery run" : timestamp(run.deadline_at)}{run.deadline_missed ? <div className="text-amber-300">Missed: {run.deadlineMissingScopes?.join(", ") || "See issue"}</div> : null}</td>
                <td className="max-w-lg break-words p-2 text-slate-400">{run.error_code ?? "None recorded"}{run.error_message ? <div>{run.error_message}</div> : null}{run.providerErrors && Object.keys(run.providerErrors).length ? <details><summary className="cursor-pointer">Provider details ({Object.keys(run.providerErrors).length})</summary>{Object.entries(run.providerErrors).map(([key, value]) => <div key={key}>{key}: {value}</div>)}</details> : null}</td>
              </tr>)}</tbody>
            </table>
            {!data.runs.length ? <p className="py-3 text-sm text-slate-400">No recorded EOD runs.</p> : null}
          </div>
          {data.publications.length ? <details className="text-xs text-slate-400"><summary className="cursor-pointer">Published scopes ({data.publications.length})</summary><div className="mt-2 grid gap-1">{data.publications.map((publication) => <div key={publication.scope}>{publication.scope} · {publication.session_date} · {timestamp(publication.published_at)} <span className="break-all text-slate-500">{publication.publication_id}</span></div>)}</div></details> : null}
        </>}
      </div>
    </AdminCard>
    </div>
  );
}
