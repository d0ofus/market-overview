import type { Env } from "../types";
import { getModelResearchProvider } from "./providers";
import { summarizeEvidence } from "./evidence";
import type { PromptVersionRecord, ResearchEvidenceRecord, StandardizedResearchCard } from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function inferOpinion(score: number): "positive" | "mixed" | "negative" | "unclear" {
  if (score >= 68) return "positive";
  if (score <= 38) return "negative";
  if (score > 0) return "mixed";
  return "unclear";
}

function inferFreshness(records: ResearchEvidenceRecord[]): "fresh" | "recent" | "stale" | "unclear" {
  const newest = records
    .map((record) => Date.parse(record.publishedAt ?? record.retrievedAt))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left)[0];
  if (!Number.isFinite(newest)) return "unclear";
  const ageDays = (Date.now() - newest) / 86400_000;
  if (ageDays <= 3) return "fresh";
  if (ageDays <= 14) return "recent";
  return "stale";
}

export function fallbackExtractResearchCard(input: {
  ticker: string;
  companyName: string | null;
  evidence: ResearchEvidenceRecord[];
}): StandardizedResearchCard {
  const secFacts = input.evidence.filter((record) => record.sourceKind === "sec_facts");
  const searchNews = input.evidence.filter((record) => record.sourceKind !== "sec_facts" && record.sourceKind !== "sec_submission");
  const catalysts = searchNews.slice(0, 3).map((record) => ({
    title: record.title,
    summary: record.snippet?.summary ?? "",
    freshness: inferFreshness([record]),
    direction: "positive" as const,
    evidenceIds: [record.id],
  }));
  const risks = [
    ...(searchNews.length === 0 ? [{
      title: "Limited fresh public evidence",
      summary: "Fresh web evidence was limited on this run, which lowers confidence.",
      severity: "medium" as const,
      evidenceIds: [],
    }] : []),
    ...(secFacts.length === 0 ? [{
      title: "Limited structured SEC facts",
      summary: "No structured SEC company facts were available for the latest filing window.",
      severity: "medium" as const,
      evidenceIds: [],
    }] : []),
  ].slice(0, 3);
  const freshness = inferFreshness(input.evidence);
  const valuationScore = secFacts.length > 0 ? 58 : 45;
  const earningsQualityScore = secFacts.length >= 2 ? 61 : 47;
  const catalystQualityScore = searchNews.length >= 3 ? 68 : searchNews.length > 0 ? 56 : 38;
  const catalystFreshnessScore = freshness === "fresh" ? 78 : freshness === "recent" ? 64 : freshness === "stale" ? 38 : 30;
  const riskScore = risks.length === 0 ? 72 : risks.length === 1 ? 57 : 44;
  const contradictionScore = 75;
  const topEvidenceIds = input.evidence.slice(0, 5).map((record) => record.id);
  return {
    ticker: input.ticker,
    companyName: input.companyName,
    summary: searchNews[0]?.snippet?.summary
      || secFacts[0]?.snippet?.summary
      || `${input.ticker} has limited evidence coverage in this run; review the citations before acting.`,
    valuation: {
      label: inferOpinion(valuationScore),
      summary: secFacts.length > 0
        ? "Recent SEC facts give a baseline for valuation work, but pricing context remains incomplete."
        : "Valuation view is uncertain because structured financial evidence is thin.",
    },
    earningsQuality: {
      label: inferOpinion(earningsQualityScore),
      summary: secFacts.length >= 2
        ? "Structured SEC facts provide enough signal for an initial earnings-quality read."
        : "Earnings-quality assessment is tentative because the fact set is sparse.",
    },
    catalysts,
    risks,
    contradictions: [],
    confidenceScore: clamp((topEvidenceIds.length / 8), 0.25, 0.82),
    confidenceLabel: topEvidenceIds.length >= 5 ? "medium" : "low",
    catalystFreshnessLabel: freshness,
    riskLabel: risks.length === 0 ? "low" : risks.length === 1 ? "moderate" : "high",
    factorCards: [],
    topEvidenceIds,
    valuationScore,
    earningsQualityScore,
    catalystQualityScore,
    catalystFreshnessScore,
    riskScore,
    contradictionScore,
    model: "rules",
    reasoningBullets: [
      `${input.evidence.length} evidence item(s) were normalized for this ticker.`,
      `${secFacts.length} structured SEC fact item(s) were available.`,
      `${searchNews.length} public-web evidence item(s) were available.`,
    ],
  };
}

export async function extractResearchCard(env: Env, input: {
  ticker: string;
  companyName: string | null;
  evidence: ResearchEvidenceRecord[];
  prompt: PromptVersionRecord;
}): Promise<{ card: StandardizedResearchCard; usage: Record<string, unknown> | null; model: string }> {
  if (!env.ANTHROPIC_API_KEY) {
    const card = fallbackExtractResearchCard(input);
    return { card, usage: null, model: card.model };
  }
  const modelProvider = getModelResearchProvider(env);
  const evidence = summarizeEvidence(input.evidence, 14);
  const response = await modelProvider.callJson<StandardizedResearchCard>(env, {
    model: env.ANTHROPIC_HAIKU_MODEL?.trim() || input.prompt.modelFamily,
    system: [
      input.prompt.templateText ?? "Standardize evidence into a swing-trading research card.",
      "Return strict JSON only.",
      "Ground every claim in the supplied evidence. Do not invent facts.",
      "Use concise prose.",
    ].join(" "),
    user: JSON.stringify({
      ticker: input.ticker,
      companyName: input.companyName,
      evidence,
      outputContract: {
        summary: "string",
        valuation: { label: "positive|mixed|negative|unclear", summary: "string" },
        earningsQuality: { label: "positive|mixed|negative|unclear", summary: "string" },
        catalysts: [{ title: "string", summary: "string", freshness: "fresh|recent|stale|unclear", direction: "positive|negative|mixed", evidenceIds: ["evidence-id"] }],
        risks: [{ title: "string", summary: "string", severity: "high|medium|low", evidenceIds: ["evidence-id"] }],
        contradictions: ["string"],
        confidenceScore: "0..1",
        confidenceLabel: "high|medium|low",
        catalystFreshnessLabel: "fresh|recent|stale|unclear",
        riskLabel: "low|moderate|high",
        topEvidenceIds: ["evidence-id"],
        valuationScore: "0..100",
        earningsQualityScore: "0..100",
        catalystQualityScore: "0..100",
        catalystFreshnessScore: "0..100",
        riskScore: "0..100",
        contradictionScore: "0..100",
        reasoningBullets: ["string"],
      },
    }),
    maxTokens: 2200,
  });
  const card = {
    ...fallbackExtractResearchCard(input),
    ...response.data,
    ticker: input.ticker,
    companyName: input.companyName,
    model: response.model,
  };
  return { card, usage: response.usage, model: response.model };
}
