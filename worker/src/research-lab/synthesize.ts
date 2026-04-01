import type { Env } from "../types";
import { validateResearchLabSynthesis } from "./schemas";
import {
  RESEARCH_LAB_ANTHROPIC_MAX_TOKENS,
  RESEARCH_LAB_SYNTHESIS_MAX_PROMPT_CHARS,
} from "./constants";
import { callResearchLabSonnetJson } from "./providers";
import type {
  ResearchLabEvidenceFamilyPacket,
  ResearchLabEvidenceKind,
  ResearchLabEvidenceRecord,
  ResearchLabOutputRecord,
  ResearchLabPromptConfigRecord,
  ResearchLabSynthesis,
  ResearchLabTickerIdentity,
} from "./types";

type PromptConfigJson = {
  maxEvidenceItems?: number;
  maxItemsPerFamily?: number;
  additionalInstructions?: string | null;
};

type PromptPayloadShape = {
  maxEvidenceItems: number;
  maxItemsPerFamily: number;
  summaryChars: number;
  excerptChars: number;
  includePriorMemory: boolean;
  includePriorDelta: boolean;
};

const FAMILY_LABELS: Record<ResearchLabEvidenceKind, string> = {
  key_metrics: "Key Metrics",
  news_catalysts: "News & Catalysts",
  investor_relations: "Investor Relations",
  transcripts: "Transcripts",
  analyst_media: "Analyst / Media",
  macro_relevance: "Macro Relevance",
};

function normalizeSnippet(value: string | null | undefined, maxChars: number): string | null {
  if (!value || maxChars <= 0) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, maxChars);
}

function summarizeEvidenceForPrompt(
  evidence: ResearchLabEvidenceRecord[],
  promptConfig: ResearchLabPromptConfigRecord,
  hardLimit: number,
  shape: PromptPayloadShape,
): ResearchLabEvidenceFamilyPacket[] {
  const config = (promptConfig.synthesisConfigJson ?? {}) as PromptConfigJson;
  const maxEvidenceItems = Math.max(4, Math.min(Number(config.maxEvidenceItems ?? shape.maxEvidenceItems), shape.maxEvidenceItems, hardLimit));
  const maxItemsPerFamily = Math.max(1, Math.min(Number(config.maxItemsPerFamily ?? shape.maxItemsPerFamily), shape.maxItemsPerFamily, 4));
  const grouped = new Map<ResearchLabEvidenceKind, ResearchLabEvidenceRecord[]>();
  for (const record of evidence) {
    const rows = grouped.get(record.evidenceKind) ?? [];
    rows.push(record);
    grouped.set(record.evidenceKind, rows);
  }

  const packets: ResearchLabEvidenceFamilyPacket[] = [];
  let totalIncluded = 0;
  for (const kind of Object.keys(FAMILY_LABELS) as ResearchLabEvidenceKind[]) {
    const rows = (grouped.get(kind) ?? [])
      .sort((left, right) => {
        const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : 0;
        const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : 0;
        return rightTime - leftTime;
      })
      .slice(0, maxItemsPerFamily)
      .slice(0, Math.max(0, maxEvidenceItems - totalIncluded));

    if (rows.length === 0) continue;
    totalIncluded += rows.length;
    packets.push({
      kind,
      label: FAMILY_LABELS[kind],
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        summary: normalizeSnippet(row.summary, shape.summaryChars) ?? "",
        excerpt: normalizeSnippet(row.excerpt, shape.excerptChars),
        publishedAt: row.publishedAt,
        sourceDomain: row.sourceDomain,
        canonicalUrl: null,
      })),
    });
  }
  return packets;
}

function compactPriorMemorySummary(summary: ResearchLabOutputRecord["memorySummaryJson"] | null): ResearchLabOutputRecord["memorySummaryJson"] | null {
  if (!summary) return null;
  return {
    ...summary,
    overallSummary: normalizeSnippet(summary.overallSummary, 240) ?? summary.overallSummary,
    topCatalysts: summary.topCatalysts.slice(0, 3).map((item) => normalizeSnippet(item, 90) ?? item).filter(Boolean),
    topRisks: summary.topRisks.slice(0, 3).map((item) => normalizeSnippet(item, 90) ?? item).filter(Boolean),
    evidenceIds: summary.evidenceIds.slice(0, 6),
  };
}

function buildSynthesisPromptUser(input: {
  identity: ResearchLabTickerIdentity;
  evidence: ResearchLabEvidenceRecord[];
  promptConfig: ResearchLabPromptConfigRecord;
  evidencePromptLimit: number;
  priorOutput: ResearchLabOutputRecord | null;
}) {
  const shapes: PromptPayloadShape[] = [
    {
      maxEvidenceItems: Math.min(input.evidencePromptLimit, 8),
      maxItemsPerFamily: 2,
      summaryChars: 220,
      excerptChars: 120,
      includePriorMemory: true,
      includePriorDelta: true,
    },
    {
      maxEvidenceItems: Math.min(input.evidencePromptLimit, 6),
      maxItemsPerFamily: 2,
      summaryChars: 180,
      excerptChars: 0,
      includePriorMemory: true,
      includePriorDelta: true,
    },
    {
      maxEvidenceItems: Math.min(input.evidencePromptLimit, 5),
      maxItemsPerFamily: 1,
      summaryChars: 140,
      excerptChars: 0,
      includePriorMemory: true,
      includePriorDelta: false,
    },
  ];

  let selectedUser = "";
  for (const shape of shapes) {
    const user = JSON.stringify({
      ticker: input.identity.ticker,
      companyName: input.identity.companyName,
      outputContract: {
        ticker: "ticker",
        companyName: "string|null",
        opinion: "positive|mixed|negative|unclear",
        overallSummary: "string",
        whyNow: "string",
        valuationView: { label: "cheap|fair|expensive|unclear", summary: "string" },
        earningsQualityView: { label: "strong|mixed|weak|unclear", summary: "string" },
        pricedInView: { label: "underappreciated|partially_priced_in|mostly_priced_in|fully_priced_in|unclear", summary: "string" },
        catalysts: [{ title: "string", summary: "string", direction: "positive|negative|mixed", timeframe: "string", evidenceIds: ["evidence-id"] }],
        risks: [{ title: "string", summary: "string", severity: "high|medium|low", evidenceIds: ["evidence-id"] }],
        contradictions: [{ title: "string", summary: "string", evidenceIds: ["evidence-id"] }],
        confidence: { label: "high|medium|low", score: "0..1", summary: "string" },
        monitoringPoints: ["string"],
        priorComparison: "object|null",
        evidenceIds: ["evidence-id"],
      },
      evidenceFamilies: summarizeEvidenceForPrompt(
        input.evidence,
        input.promptConfig,
        input.evidencePromptLimit,
        shape,
      ),
      priorMemorySummary: shape.includePriorMemory ? compactPriorMemorySummary(input.priorOutput?.memorySummaryJson ?? null) : null,
      priorDeltaSummary: shape.includePriorDelta
        ? normalizeSnippet(input.priorOutput?.deltaJson?.summary ?? null, 220)
        : null,
    });
    selectedUser = user;
    if (user.length <= RESEARCH_LAB_SYNTHESIS_MAX_PROMPT_CHARS) {
      return user;
    }
  }
  return selectedUser;
}

export async function synthesizeResearchLabOutput(env: Env, input: {
  identity: ResearchLabTickerIdentity;
  evidence: ResearchLabEvidenceRecord[];
  promptConfig: ResearchLabPromptConfigRecord;
  evidencePromptLimit: number;
  priorOutput: ResearchLabOutputRecord | null;
}): Promise<{ synthesis: ResearchLabSynthesis; usage: Record<string, unknown> | null; model: string }> {
  const additionalInstructions = typeof (input.promptConfig.synthesisConfigJson as PromptConfigJson | null | undefined)?.additionalInstructions === "string"
    ? String((input.promptConfig.synthesisConfigJson as PromptConfigJson).additionalInstructions)
    : "";
  const userPrompt = buildSynthesisPromptUser(input);

  const response = await callResearchLabSonnetJson<ResearchLabSynthesis>(env, {
    promptConfig: {
      ...input.promptConfig,
      systemPrompt: [
        input.promptConfig.systemPrompt,
        "Return strict JSON only.",
        "Do not use markdown fences.",
        "Ground every material claim in the provided evidence ids.",
        "If evidence is weak, say so explicitly instead of guessing.",
        additionalInstructions,
      ].filter(Boolean).join(" "),
    },
    user: userPrompt,
    maxTokens: RESEARCH_LAB_ANTHROPIC_MAX_TOKENS,
  });

  const synthesis = validateResearchLabSynthesis({
    ...response.data,
    ticker: input.identity.ticker,
    companyName: input.identity.companyName,
  }, input.evidence.map((item) => item.id));

  return {
    synthesis,
    usage: response.usage,
    model: response.model,
  };
}
