"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type {
  ResearchSnapshotCompareResponse,
  ResearchSnapshotDetailResponse,
  ResearchSnapshotRow,
  ResearchTickerResult,
} from "@/lib/api";
import { ResearchHistoryPanel } from "./research-history-panel";
import { TradingViewWidget } from "./tradingview-widget";

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
  const modalRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open || !result) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    modalRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, result, onClose]);

  if (!open || !result) return null;
  const thesis = (detail?.snapshot?.thesisJson ?? null) as Record<string, any> | null;
  const deepDive = thesis?.deepDive && typeof thesis.deepDive === "object" ? thesis.deepDive as Record<string, any> : null;
  const thesisOverview = thesis?.thesisOverview as Record<string, any> | undefined;
  const marketPricing = thesis?.marketPricing as Record<string, any> | undefined;
  const earningsQualityDetailed = thesis?.earningsQualityDetailed as Record<string, any> | undefined;
  const valuationView = thesis?.valuationView as Record<string, any> | undefined;
  const thematicFit = thesis?.thematicFit as Record<string, any> | undefined;
  const setupQuality = thesis?.setupQuality as Record<string, any> | undefined;
  const peerComparison = thesis?.peerComparison as Record<string, any> | undefined;
  const overallConclusion = thesis?.overallConclusion as Record<string, any> | undefined;
  const modelOutput = detail?.snapshot?.modelOutputJson ?? null;
  const modelLabels = [
    typeof modelOutput?.extractionModel === "string" ? `Extract ${modelOutput.extractionModel === "rules" ? "Rules fallback" : modelOutput.extractionModel}` : null,
    typeof modelOutput?.rankingModel === "string" ? `Rank ${modelOutput.rankingModel === "rules" ? "Rules fallback" : modelOutput.rankingModel}` : null,
    typeof modelOutput?.deepDiveModel === "string" ? `Deep Dive ${modelOutput.deepDiveModel === "rules" ? "Rules fallback" : modelOutput.deepDiveModel}` : null,
  ].filter((value): value is string => Boolean(value));
  const hasRulesFallback = modelLabels.some((label) => label.includes("Rules fallback"));

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={modalRef}
        className="max-h-[90vh] w-full max-w-6xl overflow-auto rounded-2xl border border-borderSoft bg-panel p-4 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${result.ticker} research report`}
        tabIndex={-1}
      >
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

        <div className="mt-4">
          <TradingViewWidget ticker={result.ticker} chartOnly showStatusLine initialRange="3M" fillContainer className="!p-2" />
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.45fr),minmax(20rem,0.95fr)]">
          <div className="space-y-4">
            <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Thesis Overview</div>
              <p className="text-sm text-slate-300">{String(thesisOverview?.oneParagraph ?? result.summary)}</p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-slate-500">Why Now</div>
                  <p className="text-xs text-slate-400">{String(thesisOverview?.whyNow ?? "-")}</p>
                </div>
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-slate-500">What Would Change The View</div>
                  <p className="text-xs text-slate-400">{String(thesisOverview?.whatWouldChangeMyMind ?? "-")}</p>
                </div>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Priced In View</div>
                <div className="text-sm text-slate-300">{String(marketPricing?.pricedInAssessment ?? result.pricedInAssessmentLabel ?? "-")}</div>
                <p className="mt-2 text-xs text-slate-400">{String(marketPricing?.whatExpectationsSeemEmbedded ?? "-")}</p>
                <p className="mt-2 text-xs text-slate-400">{String(marketPricing?.whyUpsideDownsideMayStillRemain ?? "-")}</p>
              </div>
              <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Setup Quality</div>
                <div className="text-sm text-slate-300">{String(setupQuality?.label ?? result.setupQualityLabel ?? "-")}</div>
                <p className="mt-2 text-xs text-slate-400">{String(setupQuality?.summary ?? "-")}</p>
                <p className="mt-2 text-xs text-slate-400">{String(setupQuality?.whatNeedsToHappenNext ?? "-")}</p>
              </div>
            </div>

            <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Catalysts</div>
              <div className="space-y-2">
                {(Array.isArray(thesis?.catalystAssessment) ? thesis.catalystAssessment : result.catalysts).map((item: any) => (
                  <div key={item.title} className="rounded-lg border border-borderSoft/40 px-3 py-2">
                    <div className="text-sm font-semibold text-slate-200">{item.title}</div>
                    <div className="text-xs text-slate-400">{item.summary}</div>
                  </div>
                ))}
                {(!Array.isArray(thesis?.catalystAssessment) || thesis.catalystAssessment.length === 0) && result.catalysts.length === 0 && <p className="text-xs text-slate-400">No major catalysts were recorded.</p>}
              </div>
            </div>

            <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Risks</div>
              <div className="space-y-2">
                {(Array.isArray(thesis?.riskAssessment) ? thesis.riskAssessment : result.risks).map((item: any) => (
                  <div key={item.title} className="rounded-lg border border-borderSoft/40 px-3 py-2">
                    <div className="text-sm font-semibold text-slate-200">{item.title}</div>
                    <div className="text-xs text-slate-400">{item.summary}</div>
                  </div>
                ))}
                {(!Array.isArray(thesis?.riskAssessment) || thesis.riskAssessment.length === 0) && result.risks.length === 0 && <p className="text-xs text-slate-400">No dominant risks were recorded.</p>}
              </div>
            </div>

            <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Contradictions</div>
              <div className="space-y-2">
                {Array.isArray(thesis?.contradictionsDetailed) && thesis.contradictionsDetailed.length > 0 ? thesis.contradictionsDetailed.map((item: any, index: number) => (
                  <div key={`${item?.tension ?? "contradiction"}-${index}`} className="rounded-lg border border-borderSoft/40 px-3 py-2">
                    <div className="text-sm font-semibold text-slate-200">{String(item?.tension ?? "-")}</div>
                    <div className="text-xs text-slate-400">{String(item?.whyItMatters ?? "-")}</div>
                  </div>
                )) : <p className="text-xs text-slate-400">No explicit contradictions were stored.</p>}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Earnings Quality</div>
                <div className="space-y-2 text-xs text-slate-400">
                  <p>{String(earningsQualityDetailed?.revenueQuality ?? "-")}</p>
                  <p>{String(earningsQualityDetailed?.marginQuality ?? "-")}</p>
                  <p>{String(earningsQualityDetailed?.cashFlowQuality ?? "-")}</p>
                  <p>{String(earningsQualityDetailed?.guideQuality ?? "-")}</p>
                </div>
              </div>
              <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Valuation & Theme</div>
                <p className="text-xs text-slate-400">{String(valuationView?.summary ?? "-")}</p>
                <p className="mt-2 text-xs text-slate-400">{String(thematicFit?.themeName ?? "-")} · {String(thematicFit?.label ?? result.thematicFitLabel ?? "-")}</p>
                <p className="mt-2 text-xs text-slate-400">{String(thematicFit?.adoptionSignal ?? "-")}</p>
              </div>
            </div>

            <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Peer Comparison</div>
              {peerComparison?.available ? (
                <div className="space-y-2 text-xs text-slate-400">
                  <p>{String(peerComparison.peerGroupName ?? "Peer group")} · {String(peerComparison.confidence ?? "-")} confidence</p>
                  <p>{Array.isArray(peerComparison.closestPeers) ? peerComparison.closestPeers.join(", ") : "-"}</p>
                  <p>{String(peerComparison.whyTheseAreClosestPeers ?? "-")}</p>
                  <p>{String(peerComparison.strategicPositionRelative ?? "-")}</p>
                </div>
              ) : (
                <p className="text-xs text-slate-400">{String(peerComparison?.reasonUnavailable ?? "Peer comparison unavailable.")}</p>
              )}
            </div>

            <div className="rounded-xl border border-borderSoft/60 bg-panelSoft/45 p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Overall Conclusion</div>
              <p className="text-sm text-slate-300">{String(overallConclusion?.thesis ?? result.overallConclusion ?? "-")}</p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-slate-500">Bull Case</div>
                  <p className="text-xs text-slate-400">{String(overallConclusion?.bestBullArgument ?? "-")}</p>
                </div>
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-slate-500">Bear Case</div>
                  <p className="text-xs text-slate-400">{String(overallConclusion?.bestBearArgument ?? "-")}</p>
                </div>
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
              {hasRulesFallback ? (
                <p className="mt-3 text-xs text-amber-200/90">
                  <code>Rules fallback</code> means that stage fell back to the app&apos;s deterministic scoring and template logic instead of using the LLM response, usually because the model call timed out, failed, or returned unusable output.
                </p>
              ) : null}
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
