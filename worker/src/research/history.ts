import type { ResearchSnapshotComparison, ResearchSnapshotRecord, ResearchFactorRecord, StandardizedResearchCard } from "./types";

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function setDiff(current: string[], previous: string[]): string[] {
  const prev = new Set(previous.map((value) => value.trim().toLowerCase()));
  return current.filter((value) => !prev.has(value.trim().toLowerCase()));
}

function summarizeDelta(label: string, current: number | null | undefined, previous: number | null | undefined): string | null {
  if (current == null || previous == null) return null;
  const delta = Number((current - previous).toFixed(1));
  if (Math.abs(delta) < 0.1) return null;
  return `${label} ${delta > 0 ? "improved" : "weakened"} by ${Math.abs(delta).toFixed(1)} points.`;
}

export function buildSnapshotComparison(input: {
  currentSnapshot: ResearchSnapshotRecord;
  currentCard: StandardizedResearchCard;
  previousSnapshot?: ResearchSnapshotRecord | null;
  previousFactors?: ResearchFactorRecord[];
}): ResearchSnapshotComparison {
  const previousThesis = (input.previousSnapshot?.thesisJson ?? {}) as Record<string, any>;
  const previousCatalysts = asArray(previousThesis.catalysts).map((item: any) => String(item?.title ?? "").trim()).filter(Boolean);
  const previousRisks = asArray(previousThesis.risks).map((item: any) => String(item?.title ?? "").trim()).filter(Boolean);
  const previousContradictions = asArray(previousThesis.contradictions).map((item: any) => String(item ?? "").trim()).filter(Boolean);
  const currentCatalysts = input.currentCard.catalysts.map((item) => item.title);
  const currentRisks = input.currentCard.risks.map((item) => item.title);
  const currentContradictions = input.currentCard.contradictions;
  const newCatalysts = setDiff(currentCatalysts, previousCatalysts);
  const newRisks = setDiff(currentRisks, previousRisks);
  const resolvedRisks = setDiff(previousRisks, currentRisks);
  const contradictionsIntroduced = setDiff(currentContradictions, previousContradictions);
  const contradictionsResolved = setDiff(previousContradictions, currentContradictions);
  const previousConfidence = typeof input.previousSnapshot?.confidenceScore === "number" ? input.previousSnapshot.confidenceScore : null;
  const currentConfidence = typeof input.currentSnapshot.confidenceScore === "number" ? input.currentSnapshot.confidenceScore : null;
  const thesisEvolution = [
    summarizeDelta("Score", input.currentSnapshot.overallScore, input.previousSnapshot?.overallScore ?? null),
    summarizeDelta("Confidence", currentConfidence != null ? currentConfidence * 100 : null, previousConfidence != null ? previousConfidence * 100 : null),
    input.currentSnapshot.valuationLabel && input.previousSnapshot?.valuationLabel && input.currentSnapshot.valuationLabel !== input.previousSnapshot.valuationLabel
      ? `Valuation view shifted from ${input.previousSnapshot.valuationLabel} to ${input.currentSnapshot.valuationLabel}.`
      : null,
    input.currentSnapshot.earningsQualityLabel && input.previousSnapshot?.earningsQualityLabel && input.currentSnapshot.earningsQualityLabel !== input.previousSnapshot.earningsQualityLabel
      ? `Earnings quality moved from ${input.previousSnapshot.earningsQualityLabel} to ${input.currentSnapshot.earningsQualityLabel}.`
      : null,
  ].filter((value): value is string => Boolean(value));
  const summaryParts = [
    newCatalysts.length > 0 ? `${newCatalysts.length} new catalyst${newCatalysts.length === 1 ? "" : "s"} emerged.` : null,
    newRisks.length > 0 ? `${newRisks.length} new risk${newRisks.length === 1 ? "" : "s"} appeared.` : null,
    resolvedRisks.length > 0 ? `${resolvedRisks.length} prior risk${resolvedRisks.length === 1 ? "" : "s"} eased.` : null,
    contradictionsIntroduced.length > 0 ? `${contradictionsIntroduced.length} contradiction${contradictionsIntroduced.length === 1 ? "" : "s"} were introduced.` : null,
  ].filter(Boolean);
  return {
    ticker: input.currentSnapshot.ticker,
    currentSnapshotId: input.currentSnapshot.id,
    previousSnapshotId: input.previousSnapshot?.id ?? null,
    summary: summaryParts[0] ?? "No major thesis changes versus the previous snapshot.",
    thesisEvolution,
    newCatalysts,
    newRisks,
    resolvedRisks,
    contradictionsIntroduced,
    contradictionsResolved,
    scoreDelta: input.currentSnapshot.overallScore != null && input.previousSnapshot?.overallScore != null
      ? Number((input.currentSnapshot.overallScore - input.previousSnapshot.overallScore).toFixed(1))
      : null,
    confidenceDelta: currentConfidence != null && previousConfidence != null
      ? Number((currentConfidence - previousConfidence).toFixed(2))
      : null,
  };
}
