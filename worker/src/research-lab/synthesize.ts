import type { Env } from "../types";
import { validateResearchLabSynthesis } from "./schemas";
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

const FAMILY_LABELS: Record<ResearchLabEvidenceKind, string> = {
  key_metrics: "Key Metrics",
  news_catalysts: "News & Catalysts",
  investor_relations: "Investor Relations",
  transcripts: "Transcripts",
  analyst_media: "Analyst / Media",
  macro_relevance: "Macro Relevance",
};

function summarizeEvidenceForPrompt(
  evidence: ResearchLabEvidenceRecord[],
  promptConfig: ResearchLabPromptConfigRecord,
  hardLimit: number,
): ResearchLabEvidenceFamilyPacket[] {
  const config = (promptConfig.synthesisConfigJson ?? {}) as PromptConfigJson;
  const maxEvidenceItems = Math.max(6, Math.min(Number(config.maxEvidenceItems ?? hardLimit), hardLimit));
  const maxItemsPerFamily = Math.max(1, Math.min(Number(config.maxItemsPerFamily ?? 2), 4));
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
        summary: row.summary.slice(0, 320),
        excerpt: row.excerpt?.slice(0, 220) ?? null,
        publishedAt: row.publishedAt,
        sourceDomain: row.sourceDomain,
        canonicalUrl: row.canonicalUrl,
      })),
    });
  }
  return packets;
}

export async function synthesizeResearchLabOutput(env: Env, input: {
  identity: ResearchLabTickerIdentity;
  evidence: ResearchLabEvidenceRecord[];
  promptConfig: ResearchLabPromptConfigRecord;
  evidencePromptLimit: number;
  priorOutput: ResearchLabOutputRecord | null;
}): Promise<{ synthesis: ResearchLabSynthesis; usage: Record<string, unknown> | null; model: string }> {
  const evidencePackets = summarizeEvidenceForPrompt(input.evidence, input.promptConfig, input.evidencePromptLimit);
  const additionalInstructions = typeof (input.promptConfig.synthesisConfigJson as PromptConfigJson | null | undefined)?.additionalInstructions === "string"
    ? String((input.promptConfig.synthesisConfigJson as PromptConfigJson).additionalInstructions)
    : "";

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
    user: JSON.stringify({
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
        priorComparison: { summary: "string", changed: "boolean" } | null,
        evidenceIds: ["evidence-id"],
      },
      evidenceFamilies: evidencePackets,
      priorMemorySummary: input.priorOutput?.memorySummaryJson ?? null,
      priorDeltaSummary: input.priorOutput?.deltaJson?.summary ?? null,
    }),
    maxTokens: 2200,
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
