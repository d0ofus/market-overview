"use client";

import { X } from "lucide-react";
import type { ResearchRunStatusResponse } from "@/lib/api";

type Props = {
  open: boolean;
  status: ResearchRunStatusResponse | null;
  onClose: () => void;
};

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

export function ResearchRunDrawer({ open, status, onClose }: Props) {
  if (!open || !status) return null;

  const failedTickers = status.tickers.filter((row) => row.status === "failed" || row.lastError);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-950/45 backdrop-blur-sm">
      <div className="h-full w-full max-w-2xl overflow-auto border-l border-borderSoft bg-panel p-4 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold text-slate-100">Research Run Details</div>
            <div className="mt-1 text-sm text-slate-400">
              {status.profile?.name ?? "Research Run"} · {status.run.status.toUpperCase()}
            </div>
          </div>
          <button className="rounded border border-borderSoft/60 p-2 text-slate-300 hover:bg-panelSoft/70" onClick={onClose} type="button">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-3">
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Started</div>
            <div className="mt-1 text-sm font-semibold text-slate-100">{formatTime(status.run.startedAt ?? status.run.createdAt)}</div>
          </div>
          <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-3">
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Progress</div>
            <div className="mt-1 text-sm font-semibold text-slate-100">
              {status.run.completedTickerCount}/{status.run.requestedTickerCount} complete
            </div>
          </div>
          <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-3">
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Failed</div>
            <div className="mt-1 text-sm font-semibold text-slate-100">{status.run.failedTickerCount}</div>
          </div>
        </div>

        {status.run.errorSummary ? (
          <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-red-200">Run Summary</div>
            <p className="mt-2 text-sm text-red-100">{status.run.errorSummary}</p>
          </div>
        ) : null}

        <div className="mt-4 rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Ticker Diagnostics</div>
          <div className="space-y-3">
            {failedTickers.map((row) => (
              <div key={row.id} className="rounded-xl border border-borderSoft/60 bg-panel px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-accent">{row.ticker}</div>
                    <div className="text-xs text-slate-500">{row.companyName ?? "Unknown company"}</div>
                  </div>
                  <div className="text-xs font-semibold uppercase text-red-300">{row.status}</div>
                </div>
                <div className="mt-2 text-xs text-slate-400">
                  Attempt {row.attemptCount} · {row.exchange ?? "Unknown exchange"} · CIK {row.secCik ?? "-"}
                </div>
                <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-100">
                  {row.lastError ?? "No detailed failure message was stored for this ticker."}
                </div>
              </div>
            ))}
            {failedTickers.length === 0 && (
              <p className="text-sm text-slate-400">No failed ticker diagnostics were recorded for this run.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
