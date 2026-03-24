import type {
  ResearchFactorCard,
  ResearchFactorDirection,
  ResearchPriorityBucket,
  ResearchProfileSettings,
  StandardizedResearchCard,
} from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function factorDirection(score: number): ResearchFactorDirection {
  if (score >= 70) return "positive";
  if (score <= 35) return "negative";
  if (score >= 45 && score <= 60) return "mixed";
  return "neutral";
}

export function defaultFactorWeights(rubric: Record<string, unknown> | null | undefined): Record<string, number> {
  const weights = (rubric?.weights && typeof rubric.weights === "object") ? rubric.weights as Record<string, unknown> : {};
  return {
    valuation: typeof weights.valuation === "number" ? weights.valuation : 0.14,
    earnings_quality: typeof weights.earnings_quality === "number" ? weights.earnings_quality : 0.18,
    catalyst_quality: typeof weights.catalyst_quality === "number" ? weights.catalyst_quality : 0.22,
    catalyst_freshness: typeof weights.catalyst_freshness === "number" ? weights.catalyst_freshness : 0.18,
    risk: typeof weights.risk === "number" ? weights.risk : 0.18,
    contradictions: typeof weights.contradictions === "number" ? weights.contradictions : 0.10,
  };
}

export function computeFactorCards(card: StandardizedResearchCard, rubric: Record<string, unknown> | null | undefined): ResearchFactorCard[] {
  const weights = defaultFactorWeights(rubric);
  const candidates = [
    { key: "valuation", rawScore: card.valuationScore, summary: card.valuation.summary, evidenceIds: card.topEvidenceIds.slice(0, 2) },
    { key: "earnings_quality", rawScore: card.earningsQualityScore, summary: card.earningsQuality.summary, evidenceIds: card.topEvidenceIds.slice(0, 2) },
    { key: "catalyst_quality", rawScore: card.catalystQualityScore, summary: card.catalysts[0]?.summary ?? "No strong catalyst identified.", evidenceIds: card.catalysts.flatMap((item) => item.evidenceIds).slice(0, 3) },
    { key: "catalyst_freshness", rawScore: card.catalystFreshnessScore, summary: `Catalyst freshness is ${card.catalystFreshnessLabel}.`, evidenceIds: card.catalysts.flatMap((item) => item.evidenceIds).slice(0, 3) },
    { key: "risk", rawScore: card.riskScore, summary: card.risks[0]?.summary ?? "Risk posture is manageable.", evidenceIds: card.risks.flatMap((item) => item.evidenceIds).slice(0, 3) },
    { key: "contradictions", rawScore: card.contradictionScore, summary: card.contradictions[0] ?? "No major contradictions flagged.", evidenceIds: card.topEvidenceIds.slice(0, 2) },
  ];
  return candidates.map((candidate) => ({
    key: candidate.key,
    score: clamp(candidate.rawScore, 0, 100),
    direction: factorDirection(candidate.rawScore),
    confidenceScore: clamp(card.confidenceScore, 0, 1),
    weightApplied: weights[candidate.key] ?? 0,
    summary: candidate.summary,
    evidenceIds: candidate.evidenceIds,
  }));
}

export function computeAttentionScore(factors: ResearchFactorCard[]): number {
  const weighted = factors.reduce((sum, factor) => sum + (factor.score * factor.weightApplied), 0);
  const normalizedWeight = factors.reduce((sum, factor) => sum + factor.weightApplied, 0) || 1;
  return clamp(Number((weighted / normalizedWeight).toFixed(1)), 0, 100);
}

export function derivePriorityBucket(score: number): ResearchPriorityBucket {
  if (score >= 75) return "high";
  if (score >= 55) return "medium";
  return "monitor";
}

export function normalizeRankingLimit(requested: number | null | undefined, settings: ResearchProfileSettings): number {
  const cap = settings.maxTickersPerRun;
  if (!requested || !Number.isFinite(requested)) return cap;
  return Math.max(1, Math.min(Math.floor(requested), cap));
}
