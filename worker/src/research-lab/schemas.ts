import { z } from "zod";
import {
  RESEARCH_LAB_DEFAULT_EVIDENCE_PROFILE_ID,
  RESEARCH_LAB_DEFAULT_PROMPT_CONFIG_ID,
  RESEARCH_LAB_MAX_TICKERS_PER_RUN,
} from "./constants";
import type { ResearchLabMemorySummary, ResearchLabOutputDelta, ResearchLabRunCreateRequest, ResearchLabSynthesis } from "./types";

const tickerTokenSchema = z.string().trim().min(1).transform((value) => value.toUpperCase()).refine(
  (value) => /^[A-Z.\-]{1,12}$/.test(value),
  "Tickers must be valid US equity-style symbols.",
);

export function parseResearchLabTickerInput(input: string): string[] {
  return Array.from(new Set(
    input
      .split(/[\s,;\n\r\t]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => tickerTokenSchema.parse(part)),
  ));
}

export const researchLabRunCreateSchema = z.object({
  tickers: z.array(tickerTokenSchema).min(1).max(RESEARCH_LAB_MAX_TICKERS_PER_RUN),
  promptConfigId: z.string().trim().min(1).nullable().optional().default(RESEARCH_LAB_DEFAULT_PROMPT_CONFIG_ID),
  evidenceProfileId: z.string().trim().min(1).nullable().optional().default(RESEARCH_LAB_DEFAULT_EVIDENCE_PROFILE_ID),
});

const evidenceIdsSchema = z.array(z.string().min(1)).default([]);
const priorComparisonSchema = z.preprocess((value) => {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return value;
  const candidate = value as { summary?: unknown; changed?: unknown };
  if (typeof candidate.summary !== "string" || typeof candidate.changed !== "boolean") {
    return null;
  }
  return value;
}, z.object({
  summary: z.string().min(1),
  changed: z.boolean(),
}).nullable().default(null));

export const researchLabSynthesisSchema = z.object({
  ticker: tickerTokenSchema,
  companyName: z.string().nullable(),
  opinion: z.enum(["positive", "mixed", "negative", "unclear"]),
  overallSummary: z.string().min(1),
  whyNow: z.string().min(1),
  valuationView: z.object({
    label: z.enum(["cheap", "fair", "expensive", "unclear"]),
    summary: z.string().min(1),
  }),
  earningsQualityView: z.object({
    label: z.enum(["strong", "mixed", "weak", "unclear"]),
    summary: z.string().min(1),
  }),
  pricedInView: z.object({
    label: z.enum(["underappreciated", "partially_priced_in", "mostly_priced_in", "fully_priced_in", "unclear"]),
    summary: z.string().min(1),
  }),
  catalysts: z.array(z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    direction: z.enum(["positive", "negative", "mixed"]),
    timeframe: z.string().min(1),
    evidenceIds: evidenceIdsSchema,
  })).default([]),
  risks: z.array(z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    severity: z.enum(["high", "medium", "low"]),
    evidenceIds: evidenceIdsSchema,
  })).default([]),
  contradictions: z.array(z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    evidenceIds: evidenceIdsSchema,
  })).default([]),
  confidence: z.object({
    label: z.enum(["high", "medium", "low"]),
    score: z.number().min(0).max(1),
    summary: z.string().min(1),
  }),
  monitoringPoints: z.array(z.string().min(1)).default([]),
  priorComparison: priorComparisonSchema,
  evidenceIds: evidenceIdsSchema,
});

export const researchLabMemorySummarySchema = z.object({
  opinion: z.enum(["positive", "mixed", "negative", "unclear"]),
  overallSummary: z.string().min(1),
  pricedInLabel: z.enum(["underappreciated", "partially_priced_in", "mostly_priced_in", "fully_priced_in", "unclear"]),
  confidenceLabel: z.enum(["high", "medium", "low"]),
  topCatalysts: z.array(z.string().min(1)).default([]),
  topRisks: z.array(z.string().min(1)).default([]),
  evidenceIds: evidenceIdsSchema,
});

export const researchLabOutputDeltaSchema = z.object({
  opinionChanged: z.boolean(),
  previousOpinion: z.enum(["positive", "mixed", "negative", "unclear"]).nullable(),
  currentOpinion: z.enum(["positive", "mixed", "negative", "unclear"]),
  newCatalysts: z.array(z.string().min(1)).default([]),
  resolvedCatalysts: z.array(z.string().min(1)).default([]),
  newRisks: z.array(z.string().min(1)).default([]),
  resolvedRisks: z.array(z.string().min(1)).default([]),
  confidenceChanged: z.boolean(),
  previousConfidenceLabel: z.enum(["high", "medium", "low"]).nullable(),
  currentConfidenceLabel: z.enum(["high", "medium", "low"]),
  pricedInChanged: z.boolean(),
  previousPricedInLabel: z.enum(["underappreciated", "partially_priced_in", "mostly_priced_in", "fully_priced_in", "unclear"]).nullable(),
  currentPricedInLabel: z.enum(["underappreciated", "partially_priced_in", "mostly_priced_in", "fully_priced_in", "unclear"]),
  summary: z.string().nullable(),
});

export function validateResearchLabRunCreate(input: unknown): ResearchLabRunCreateRequest {
  return researchLabRunCreateSchema.parse(input);
}

export function validateResearchLabSynthesis(raw: unknown, availableEvidenceIds: Iterable<string>): ResearchLabSynthesis {
  const parsed = researchLabSynthesisSchema.parse(raw);
  const available = new Set(availableEvidenceIds);
  const filterEvidenceIds = (ids: string[]) => ids.filter((id) => available.has(id));
  parsed.evidenceIds = filterEvidenceIds(parsed.evidenceIds);
  parsed.catalysts = parsed.catalysts.map((item) => ({ ...item, evidenceIds: filterEvidenceIds(item.evidenceIds) }));
  parsed.risks = parsed.risks.map((item) => ({ ...item, evidenceIds: filterEvidenceIds(item.evidenceIds) }));
  parsed.contradictions = parsed.contradictions.map((item) => ({ ...item, evidenceIds: filterEvidenceIds(item.evidenceIds) }));
  return parsed as ResearchLabSynthesis;
}

export function validateResearchLabMemorySummary(raw: unknown): ResearchLabMemorySummary {
  return researchLabMemorySummarySchema.parse(raw) as ResearchLabMemorySummary;
}

export function validateResearchLabOutputDelta(raw: unknown): ResearchLabOutputDelta {
  return researchLabOutputDeltaSchema.parse(raw) as ResearchLabOutputDelta;
}
