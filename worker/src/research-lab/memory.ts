import { validateResearchLabMemorySummary, validateResearchLabOutputDelta } from "./schemas";
import type {
  ResearchLabMemorySummary,
  ResearchLabOutputDelta,
  ResearchLabOutputRecord,
  ResearchLabSynthesis,
} from "./types";

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function buildResearchLabMemorySummary(synthesis: ResearchLabSynthesis): ResearchLabMemorySummary {
  return validateResearchLabMemorySummary({
    opinion: synthesis.opinion,
    overallSummary: synthesis.overallSummary,
    pricedInLabel: synthesis.pricedInView.label,
    confidenceLabel: synthesis.confidence.label,
    topCatalysts: synthesis.catalysts.slice(0, 3).map((item) => item.title),
    topRisks: synthesis.risks.slice(0, 3).map((item) => item.title),
    evidenceIds: synthesis.evidenceIds.slice(0, 8),
  });
}

export function buildResearchLabOutputDelta(
  current: ResearchLabSynthesis,
  previous: ResearchLabOutputRecord | null,
): ResearchLabOutputDelta | null {
  if (!previous) return null;
  const prior = previous.synthesisJson;
  const currentCatalysts = unique(current.catalysts.map((item) => item.title));
  const priorCatalysts = unique(prior.catalysts.map((item) => item.title));
  const currentRisks = unique(current.risks.map((item) => item.title));
  const priorRisks = unique(prior.risks.map((item) => item.title));
  const newCatalysts = currentCatalysts.filter((value) => !priorCatalysts.includes(value));
  const resolvedCatalysts = priorCatalysts.filter((value) => !currentCatalysts.includes(value));
  const newRisks = currentRisks.filter((value) => !priorRisks.includes(value));
  const resolvedRisks = priorRisks.filter((value) => !currentRisks.includes(value));
  const opinionChanged = current.opinion !== prior.opinion;
  const confidenceChanged = current.confidence.label !== prior.confidence.label;
  const pricedInChanged = current.pricedInView.label !== prior.pricedInView.label;
  const summaryParts = [
    opinionChanged ? `Opinion changed from ${prior.opinion} to ${current.opinion}.` : "",
    newCatalysts.length > 0 ? `New catalysts: ${newCatalysts.join(", ")}.` : "",
    resolvedCatalysts.length > 0 ? `Resolved catalysts: ${resolvedCatalysts.join(", ")}.` : "",
    newRisks.length > 0 ? `New risks: ${newRisks.join(", ")}.` : "",
    resolvedRisks.length > 0 ? `Resolved risks: ${resolvedRisks.join(", ")}.` : "",
    confidenceChanged ? `Confidence changed from ${prior.confidence.label} to ${current.confidence.label}.` : "",
    pricedInChanged ? `Priced-in view changed from ${prior.pricedInView.label} to ${current.pricedInView.label}.` : "",
  ].filter(Boolean);

  return validateResearchLabOutputDelta({
    opinionChanged,
    previousOpinion: prior.opinion,
    currentOpinion: current.opinion,
    newCatalysts,
    resolvedCatalysts,
    newRisks,
    resolvedRisks,
    confidenceChanged,
    previousConfidenceLabel: prior.confidence.label,
    currentConfidenceLabel: current.confidence.label,
    pricedInChanged,
    previousPricedInLabel: prior.pricedInView.label,
    currentPricedInLabel: current.pricedInView.label,
    summary: summaryParts.length > 0 ? summaryParts.join(" ") : null,
  });
}
