"use client";

import { X } from "lucide-react";
import type {
  ResearchSnapshotCompareResponse,
  ResearchSnapshotDetailResponse,
  ResearchSnapshotRow,
  ResearchTickerResult,
} from "@/lib/api";
import { ResearchHistoryPanel } from "./research-history-panel";

type Props = {
  open: boolean;
  result: ResearchTickerResult | null;
  detail: ResearchSnapshotDetailResponse | null;
  history: ResearchSnapshotRow[];
  compare: ResearchSnapshotCompareResponse | null;
  onClose: () => void;
};

export function ResearchTickerDrawer({ open, result, detail, history, compare, onClose }: Props) {
  if (!open || !result) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-950/45 backdrop-blur-sm">
      <div className="h-full w-full max-w-3xl overflow-auto border-l border-borderSoft bg-panel p-4 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold text-accent">{result.ticker}</div>
            <div className="text-sm text-slate-400">{result.companyName ?? "-"}</div>
          </div>
          <button className="rounded border border-borderSoft/60 p-2 text-slate-300 hover:bg-panelSoft/70" onClick={onClose} type="button">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-3">
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Score</div>
            <div className="mt-1 text-2xl font-semibold text-slate-100">{typeof result.overallScore === "number" ? result.overallScore.toFixed(1) : "-"}</div>
          </div>
          <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-3">
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Confidence</div>
            <div className="mt-1 text-2xl font-semibold text-slate-100">{result.confidenceLabel ?? "-"}</div>
          </div>
          <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-3">
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Contradictions</div>
            <div className="mt-1 text-2xl font-semibold text-slate-100">{result.contradictionFlag ? "Flagged" : "None"}</div>
          </div>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.35fr),minmax(18rem,1fr)]">
          <div className="space-y-4">
            <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Thesis</div>
              <p className="text-sm text-slate-300">{result.summary}</p>
            </div>

            <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Catalysts</div>
              <div className="space-y-2">
                {result.catalysts.map((item) => (
                  <div key={item.title} className="rounded-lg border border-borderSoft/40 px-3 py-2">
                    <div className="text-sm font-semibold text-slate-200">{item.title}</div>
                    <div className="text-xs text-slate-400">{item.summary}</div>
                  </div>
                ))}
                {result.catalysts.length === 0 && <p className="text-xs text-slate-400">No major catalysts were recorded.</p>}
              </div>
            </div>

            <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Risks</div>
              <div className="space-y-2">
                {result.risks.map((item) => (
                  <div key={item.title} className="rounded-lg border border-borderSoft/40 px-3 py-2">
                    <div className="text-sm font-semibold text-slate-200">{item.title}</div>
                    <div className="text-xs text-slate-400">{item.summary}</div>
                  </div>
                ))}
                {result.risks.length === 0 && <p className="text-xs text-slate-400">No dominant risks were recorded.</p>}
              </div>
            </div>

            <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Evidence & Citations</div>
              <div className="space-y-2">
                {(detail?.evidence ?? []).map((item) => (
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
                {(detail?.evidence ?? []).length === 0 && <p className="text-xs text-slate-400">Evidence is still loading or was unavailable for this run.</p>}
              </div>
            </div>
          </div>

          <ResearchHistoryPanel history={history} compare={compare} />
        </div>
      </div>
    </div>
  );
}
