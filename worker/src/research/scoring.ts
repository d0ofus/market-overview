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

const BASELINE_WEIGHTS: Record<string, number> = {
  market_pricing_mismatch: 0.16,
  earnings_quality: 0.14,
  catalyst_strength: 0.12,
  catalyst_durability: 0.10,
  valuation_attractiveness: 0.10,
  risk_severity_inverse: 0.10,
  contradiction_burden_inverse: 0.08,
  thematic_strength: 0.07,
  setup_quality: 0.07,
  evidence_quality_confidence: 0.06,
  peer_earnings_quality: 0.02,
  peer_growth_outlook: 0.02,
  peer_historical_execution: 0.02,
  peer_price_leadership: 0.02,
  peer_fundamental_leadership: 0.02,
};

export function defaultFactorWeights(rubric: Record<string, unknown> | null | undefined): Record<string, number> {
  const weights = (rubric?.weights && typeof rubric.weights === "object") ? rubric.weights as Record<string, unknown> : {};
  return Object.fromEntries(
    Object.entries(BASELINE_WEIGHTS).map(([key, value]) => [key, typeof weights[key] === "number" ? Number(weights[key]) : value]),
  );
}

function average(values: number[]): number {
  if (values.length === 0) return 50;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function mapPricingAssessment(label: StandardizedResearchCard["marketPricing"]["pricedInAssessment"]): number {
  switch (label) {
    case "underappreciated": return 85;
    case "partially_priced_in": return 72;
    case "mostly_priced_in": return 48;
    case "fully_priced_in": return 25;
    default: return 45;
  }
}

function mapValuationLabel(label: StandardizedResearchCard["valuationView"]["label"]): number {
  switch (label) {
    case "attractive":
    case "cheap":
      return 82;
    case "somewhat_cheap":
    case "fair":
      return 64;
    case "full":
    case "somewhat_expensive":
      return 42;
    case "stretched":
    case "expensive":
      return 26;
    default:
      return 50;
  }
}

function mapThematicLabel(label: StandardizedResearchCard["thematicFit"]["label"]): number {
  switch (label) {
    case "strong": return 80;
    case "average": return 56;
    case "weak": return 32;
    default: return 45;
  }
}

function mapSetupLabel(label: StandardizedResearchCard["setupQuality"]["label"]): number {
  switch (label) {
    case "high": return 80;
    case "medium": return 58;
    case "low": return 34;
    default: return 45;
  }
}

function mapPeerRelativeLabel(label: string): number {
  switch (label) {
    case "leader": return 84;
    case "strong_contender":
    case "above_average":
    case "improving":
      return 70;
    case "average":
    case "neutral":
    case "fair":
      return 55;
    case "below_average":
    case "weakening":
    case "somewhat_expensive":
      return 40;
    case "laggard":
    case "weak":
    case "expensive":
      return 24;
    case "cheap":
    case "somewhat_cheap":
      return 75;
    default:
      return 50;
  }
}

function peerFactorsActive(card: StandardizedResearchCard): boolean {
  return card.peerComparison.available && (card.peerComparison.confidence === "high" || card.peerComparison.confidence === "medium");
}

export function computeFactorCards(card: StandardizedResearchCard, rubric: Record<string, unknown> | null | undefined): ResearchFactorCard[] {
  const weights = defaultFactorWeights(rubric);
  const peerActive = peerFactorsActive(card);
  const rawCandidates = [
    {
      key: "market_pricing_mismatch",
      rawScore: mapPricingAssessment(card.marketPricing.pricedInAssessment),
      summary: card.marketPricing.whyUpsideDownsideMayStillRemain,
      evidenceIds: card.marketPricing.evidenceIds,
      enabled: true,
    },
    {
      key: "earnings_quality",
      rawScore: clamp(card.earningsQualityScore, 0, 100),
      summary: card.earningsQuality.summary,
      evidenceIds: card.earningsQualityDetailed.evidenceIds,
      enabled: true,
    },
    {
      key: "catalyst_strength",
      rawScore: average(card.catalystAssessment.map((item) => item.strength === "high" ? 85 : item.strength === "medium_high" ? 72 : item.strength === "medium" ? 58 : item.strength === "low" ? 34 : 45)),
      summary: card.catalystAssessment[0]?.summary ?? "No strong catalyst identified.",
      evidenceIds: card.catalystAssessment.flatMap((item) => item.evidenceIds).slice(0, 5),
      enabled: true,
    },
    {
      key: "catalyst_durability",
      rawScore: average(card.catalystAssessment.map((item) => item.durability === "high" ? 82 : item.durability === "medium_high" ? 70 : item.durability === "medium" ? 56 : item.durability === "low" ? 35 : 45)),
      summary: card.catalystAssessment[0] ? `Durability is assessed as ${card.catalystAssessment[0].durability}.` : "Catalyst durability is unclear.",
      evidenceIds: card.catalystAssessment.flatMap((item) => item.evidenceIds).slice(0, 5),
      enabled: true,
    },
    {
      key: "valuation_attractiveness",
      rawScore: mapValuationLabel(card.valuationView.label),
      summary: card.valuationView.summary,
      evidenceIds: card.valuationView.evidenceIds,
      enabled: true,
    },
    {
      key: "risk_severity_inverse",
      rawScore: clamp(card.riskScore, 0, 100),
      summary: card.riskAssessment[0]?.summary ?? "Risk posture is manageable.",
      evidenceIds: card.riskAssessment.flatMap((item) => item.evidenceIds).slice(0, 5),
      enabled: true,
    },
    {
      key: "contradiction_burden_inverse",
      rawScore: clamp(card.contradictionScore, 0, 100),
      summary: card.contradictionsDetailed[0]?.tension ?? "No major contradictions flagged.",
      evidenceIds: card.contradictionsDetailed.flatMap((item) => item.evidenceIds).slice(0, 5),
      enabled: true,
    },
    {
      key: "thematic_strength",
      rawScore: mapThematicLabel(card.thematicFit.label),
      summary: card.thematicFit.adoptionSignal,
      evidenceIds: card.thematicFit.evidenceIds,
      enabled: true,
    },
    {
      key: "setup_quality",
      rawScore: mapSetupLabel(card.setupQuality.label),
      summary: card.setupQuality.summary,
      evidenceIds: card.setupQuality.evidenceIds,
      enabled: true,
    },
    {
      key: "evidence_quality_confidence",
      rawScore: clamp(card.confidenceScore * 100, 0, 100),
      summary: `Confidence is ${card.confidenceLabel} based on evidence quality, recency, and consistency.`,
      evidenceIds: card.topEvidenceIds.slice(0, 5),
      enabled: true,
    },
    {
      key: "peer_earnings_quality",
      rawScore: mapPeerRelativeLabel(card.peerComparison.earningsQualityRelative),
      summary: `Peer-relative earnings quality is ${card.peerComparison.earningsQualityRelative}.`,
      evidenceIds: card.peerComparison.evidenceIds,
      enabled: peerActive,
    },
    {
      key: "peer_growth_outlook",
      rawScore: mapPeerRelativeLabel(card.peerComparison.growthOutlookRelative),
      summary: `Peer-relative growth outlook is ${card.peerComparison.growthOutlookRelative}.`,
      evidenceIds: card.peerComparison.evidenceIds,
      enabled: peerActive,
    },
    {
      key: "peer_historical_execution",
      rawScore: mapPeerRelativeLabel(card.peerComparison.historicalExecutionRelative),
      summary: `Peer-relative historical execution is ${card.peerComparison.historicalExecutionRelative}.`,
      evidenceIds: card.peerComparison.evidenceIds,
      enabled: peerActive,
    },
    {
      key: "peer_price_leadership",
      rawScore: mapPeerRelativeLabel(card.peerComparison.priceLeadershipRelative),
      summary: `Peer-relative price leadership is ${card.peerComparison.priceLeadershipRelative}.`,
      evidenceIds: card.peerComparison.evidenceIds,
      enabled: peerActive,
    },
    {
      key: "peer_fundamental_leadership",
      rawScore: mapPeerRelativeLabel(card.peerComparison.fundamentalLeadershipRelative),
      summary: `Peer-relative fundamental leadership is ${card.peerComparison.fundamentalLeadershipRelative}.`,
      evidenceIds: card.peerComparison.evidenceIds,
      enabled: peerActive,
    },
  ];
  const activeWeightTotal = rawCandidates.reduce((sum, candidate) => sum + (candidate.enabled ? (weights[candidate.key] ?? 0) : 0), 0) || 1;
  return rawCandidates
    .filter((candidate) => candidate.enabled)
    .map((candidate) => ({
      key: candidate.key,
      score: clamp(candidate.rawScore, 0, 100),
      direction: factorDirection(candidate.rawScore),
      confidenceScore: clamp(card.confidenceScore, 0, 1),
      weightApplied: (weights[candidate.key] ?? 0) / activeWeightTotal,
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
