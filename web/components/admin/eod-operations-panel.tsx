"use client";

import { useCallback, useEffect, useState } from "react";
import { getEodPublicationStatus, type EodPublicationStatus } from "@/lib/api";
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
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getEodPublicationStatus({ signal: AbortSignal.timeout(10_000) }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "EOD status unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const visibleRefresh = () => { if (document.visibilityState === "visible") void refresh(); };
    visibleRefresh();
    const interval = window.setInterval(visibleRefresh, 60_000);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibleRefresh);
    };
  }, [refresh]);

  return (
    <AdminCard title="EOD Publications" description="GitHub batch delivery for Overview and Breadth, targeted within two hours of the actual US exchange close. Visible status refreshes every minute."
      actions={<button className="rounded-xl border border-borderSoft/80 px-3 py-2 text-sm disabled:opacity-50" disabled={loading} onClick={() => void refresh()} type="button">{loading ? "Checking..." : "Check Status"}</button>}>
      <div className="space-y-4">
        {error ? <InlineAlert tone="danger">Status check failed: {error}{data ? " The last successful status is retained below." : ""}</InlineAlert> : null}
        {!data ? <p className="text-sm text-slate-400">{loading ? "Loading EOD status..." : "No EOD status available."}</p> : <>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <span>Mode: <strong>{data.mode}</strong></span>
            <span>Delivery: <strong className={data.ready ? "text-emerald-400" : "text-amber-300"}>{data.ready ? "All scopes current" : data.mode === "disabled" ? "Disabled" : "Pending"}</strong></span>
            <span>Expected session: <strong>{data.expectedSession ?? "Unavailable"}</strong></span>
            <span>Last complete session: <strong>{data.lastSuccessfulSession ?? "Unavailable"}</strong></span>
          </div>
          {data.missingScopes?.length ? <InlineAlert tone="info">Awaiting current publications: {data.missingScopes.join(", ")}</InlineAlert> : null}
          {data.inputCorrectionsPending === true ? <InlineAlert tone="info">Stored inputs changed after the completed publication run. Corrected publications are pending (input revision {count(data.inputRevision)}; published run revision {count(data.completedInputRevision)}).</InlineAlert> : null}
          {data.inputCorrectionsPending === null ? <InlineAlert tone="info">Input correction status is unknown; the latest input clock or completed-run watermark is unavailable.</InlineAlert> : null}
          {data.capacity?.warning ? <InlineAlert tone="danger">{data.capacity.warning}</InlineAlert> : null}
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
  );
}
