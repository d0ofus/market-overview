"use client";

import type { ResearchSnapshotCompareResponse, ResearchSnapshotRow } from "@/lib/api";

type Props = {
  history: ResearchSnapshotRow[];
  compare: ResearchSnapshotCompareResponse | null;
  selectedBaselineId: string | null;
  onBaselineChange: (value: string | null) => void;
};

function formatDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

export function ResearchHistoryPanel({ history, compare, selectedBaselineId, onBaselineChange }: Props) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Snapshot History</div>
          <select
            className="rounded border border-borderSoft bg-panel px-2 py-1 text-[11px] text-slate-300"
            value={selectedBaselineId ?? ""}
            onChange={(event) => onBaselineChange(event.target.value || null)}
          >
            <option value="">Auto Previous</option>
            {history.map((row) => (
              <option key={row.id} value={row.id}>
                {formatDate(row.createdAt)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          {history.map((row) => (
            <div key={row.id} className="rounded-lg border border-borderSoft/40 px-3 py-2 text-xs text-slate-300">
              <div className="flex items-center justify-between gap-2">
                <span>{formatDate(row.createdAt)}</span>
                <span>{typeof row.overallScore === "number" ? row.overallScore.toFixed(1) : "-"}</span>
              </div>
            </div>
          ))}
          {history.length === 0 && <p className="text-xs text-slate-400">No history yet for this ticker.</p>}
        </div>
      </div>
      {compare && (
        <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">What Changed</div>
          <p className="text-sm text-slate-300">{compare.summary}</p>
          {compare.thesisEvolution.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-slate-400">
              {compare.thesisEvolution.map((item) => (
                <li key={item}>• {item}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
