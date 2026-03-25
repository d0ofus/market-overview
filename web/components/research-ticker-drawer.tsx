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
  baselineSnapshotId: string | null;
  onBaselineChange: (value: string | null) => void;
  onClose: () => void;
};

export function ResearchTickerDrawer({ open, result, detail, history, compare, baselineSnapshotId, onBaselineChange, onClose }: Props) {
  if (!open || !result) return null;
  const thesis = detail?.snapshot?.thesisJson ?? null;
  const deepDive = thesis?.deepDive && typeof thesis.deepDive === "object" ? thesis.deepDive as Record<string, any> : null;
  const modelOutput = detail?.snapshot?.modelOutputJson ?? null;
  const modelLabels = [
    typeof modelOutput?.extractionModel === "string" ? `Extract ${modelOutput.extractionModel === "rules" ? "Rules fallback" : modelOutput.extractionModel}` : null,
    typeof modelOutput?.rankingModel === "string" ? `Rank ${modelOutput.rankingModel === "rules" ? "Rules fallback" : modelOutput.rankingModel}` : null,
    typeof modelOutput?.deepDiveModel === "string" ? `Deep Dive ${modelOutput.deepDiveModel === "rules" ? "Rules fallback" : modelOutput.deepDiveModel}` : null,
  ].filter((value): value is string => Boolean(value));

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
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Deep Dive</div>
              {deepDive ? (
                <div className="space-y-3 text-sm text-slate-300">
                  <p>{String(deepDive.summary ?? "No deep-dive summary stored yet.")}</p>
                  <div>
                    <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-slate-500">Bull Case</div>
                    <p>{String(deepDive.bullCase ?? "-")}</p>
                  </div>
                  <div>
                    <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-slate-500">Bear Case</div>
                    <p>{String(deepDive.bearCase ?? "-")}</p>
                  </div>
                  <div>
                    <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-slate-500">Watch Items</div>
                    <div className="flex flex-wrap gap-2">
                      {Array.isArray(deepDive.watchItems) && deepDive.watchItems.length > 0 ? deepDive.watchItems.map((item: unknown, index: number) => (
                        <span key={`${String(item)}-${index}`} className="rounded-full border border-borderSoft/60 bg-panel px-2 py-1 text-[11px] text-slate-300">
                          {String(item)}
                        </span>
                      )) : <span className="text-xs text-slate-500">No watch items stored.</span>}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-400">No deep dive was stored for this snapshot.</p>
              )}
            </div>

            <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Models Used</div>
              <div className="flex flex-wrap gap-2">
                {modelLabels.map((label) => (
                  <span key={label} className={`rounded-full border px-2 py-1 text-[11px] ${label.includes("Rules fallback") ? "border-amber-500/30 bg-amber-500/10 text-amber-200" : "border-sky-500/30 bg-sky-500/10 text-sky-200"}`}>
                    {label}
                  </span>
                ))}
                {modelLabels.length === 0 ? <span className="text-xs text-slate-500">No model metadata stored for this snapshot.</span> : null}
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

          <ResearchHistoryPanel history={history} compare={compare} selectedBaselineId={baselineSnapshotId} onBaselineChange={onBaselineChange} />
        </div>
      </div>
    </div>
  );
}
