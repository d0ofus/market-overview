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

type KeyDriversModuleConfig = {
  enabled?: boolean;
  maxDrivers?: number;
  requirePriceRelationship?: boolean;
  priceWindow?: string;
};

type PromptConfigJson = {
  maxEvidenceItems?: number;
  maxItemsPerFamily?: number;
  additionalInstructions?: string | null;
  modules?: {
    keyDrivers?: KeyDriversModuleConfig | null;
  } | null;
};

type PromptPayloadShape = {
  maxEvidenceItems: number;
  maxItemsPerFamily: number;
  summaryChars: number;
  excerptChars: number;
  includePriorMemory: boolean;
  includePriorDelta: boolean;
};

type PromptEvidenceItem = {
  ref: string;
  canonicalId: string;
  title: string;
  summary: string;
  excerpt?: string;
  publishedAt?: string;
  sourceDomain?: string;
};

type PromptEvidenceFamilyPacket = Omit<ResearchLabEvidenceFamilyPacket, "items"> & {
  items: PromptEvidenceItem[];
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

function withDefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== ""),
  ) as T;
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

function getPromptModulesConfig(promptConfig: ResearchLabPromptConfigRecord): {
  keyDrivers: Required<KeyDriversModuleConfig>;
} {
  const raw = ((promptConfig.synthesisConfigJson ?? {}) as PromptConfigJson).modules?.keyDrivers ?? {};
  return {
    keyDrivers: {
      enabled: Boolean(raw?.enabled),
      maxDrivers: Math.max(1, Math.min(Number(raw?.maxDrivers ?? 3), 8)),
      requirePriceRelationship: raw?.requirePriceRelationship !== false,
      priceWindow: typeof raw?.priceWindow === "string" && raw.priceWindow.trim().length > 0
        ? raw.priceWindow.trim()
        : "90d",
    },
  };
}

function summarizeEvidenceForPrompt(
  evidence: ResearchLabEvidenceRecord[],
  promptConfig: ResearchLabPromptConfigRecord,
  hardLimit: number,
  shape: PromptPayloadShape,
): { packets: PromptEvidenceFamilyPacket[]; aliasMap: Map<string, string> } {
  const config = (promptConfig.synthesisConfigJson ?? {}) as PromptConfigJson;
  const maxEvidenceItems = Math.max(4, Math.min(Number(config.maxEvidenceItems ?? shape.maxEvidenceItems), shape.maxEvidenceItems, hardLimit));
  const maxItemsPerFamily = Math.max(1, Math.min(Number(config.maxItemsPerFamily ?? shape.maxItemsPerFamily), shape.maxItemsPerFamily, 4));
  const grouped = new Map<ResearchLabEvidenceKind, ResearchLabEvidenceRecord[]>();
  for (const record of evidence) {
    const rows = grouped.get(record.evidenceKind) ?? [];
    rows.push(record);
    grouped.set(record.evidenceKind, rows);
  }

  const packets: PromptEvidenceFamilyPacket[] = [];
  const aliasMap = new Map<string, string>();
  let totalIncluded = 0;
  let aliasCounter = 0;

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
      items: rows.map((row) => {
        aliasCounter += 1;
        const alias = `e${aliasCounter}`;
        aliasMap.set(alias, row.id);
        return withDefined({
          ref: alias,
          canonicalId: row.id,
          title: row.title,
          summary: normalizeSnippet(row.summary, shape.summaryChars) ?? "",
          excerpt: normalizeSnippet(row.excerpt, shape.excerptChars) ?? undefined,
          publishedAt: row.publishedAt ?? undefined,
          sourceDomain: row.sourceDomain ?? undefined,
        });
      }),
    });
  }

  return { packets, aliasMap };
}

function buildSectionSpec(promptConfig: ResearchLabPromptConfigRecord): string {
  const modules = getPromptModulesConfig(promptConfig);
  const sections = [
    "ticker:string",
    "companyName:string|null",
    "opinion:positive|mixed|negative|unclear",
    "overallSummary:string",
    "whyNow:string",
    "valuationView{label:cheap|fair|expensive|unclear,summary:string}",
    "earningsQualityView{label:strong|mixed|weak|unclear,summary:string}",
    "pricedInView{label:underappreciated|partially_priced_in|mostly_priced_in|fully_priced_in|unclear,summary:string}",
    "catalysts[{title,summary,direction,timeframe,evidenceIds[]}]",
    "risks[{title,summary,severity,evidenceIds[]}]",
    "contradictions[{title,summary,evidenceIds[]}]",
    "confidence{label:high|medium|low,score:0..1,summary:string}",
    "monitoringPoints[string]",
    "priorComparison{summary,changed}|null",
  ];
  if (modules.keyDrivers.enabled) {
    sections.push("modules{keyDrivers{summary,drivers[{title,whyItMatters,direction,timeframe,priceRelationship,confidence,evidenceIds[]}]}}");
  }
  sections.push("evidenceIds[string]");
  return sections.join("; ");
}

function buildModuleInstructions(promptConfig: ResearchLabPromptConfigRecord): string[] {
  const modules = getPromptModulesConfig(promptConfig);
  const instructions: string[] = [];
  if (modules.keyDrivers.enabled) {
    instructions.push(
      `Include modules.keyDrivers with up to ${modules.keyDrivers.maxDrivers} stock-specific drivers.`,
      `Each driver must explain why it matters, direction, timeframe, and the observed price relationship over roughly ${modules.keyDrivers.priceWindow}.`,
    );
    if (modules.keyDrivers.requirePriceRelationship) {
      instructions.push("Do not omit priceRelationship; say explicitly when the linkage is weak or inconclusive.");
    }
  }
  return instructions;
}

function buildSynthesisPromptUser(input: {
  identity: ResearchLabTickerIdentity;
  evidence: ResearchLabEvidenceRecord[];
  promptConfig: ResearchLabPromptConfigRecord;
  evidencePromptLimit: number;
  priorOutput: ResearchLabOutputRecord | null;
}): { user: string; aliasMap: Map<string, string> } {
  const modules = getPromptModulesConfig(input.promptConfig);
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
  let selectedAliases = new Map<string, string>();

  for (const shape of shapes) {
    const { packets, aliasMap } = summarizeEvidenceForPrompt(
      input.evidence,
      input.promptConfig,
      input.evidencePromptLimit,
      shape,
    );
    const user = JSON.stringify(withDefined({
      ticker: input.identity.ticker,
      companyName: input.identity.companyName ?? undefined,
      requestedSections: withDefined({
        base: [
          "opinion",
          "overallSummary",
          "whyNow",
          "valuationView",
          "earningsQualityView",
          "pricedInView",
          "catalysts",
          "risks",
          "contradictions",
          "confidence",
          "monitoringPoints",
          "priorComparison",
          "evidenceIds",
        ],
        modules: modules.keyDrivers.enabled
          ? {
            keyDrivers: {
              maxDrivers: modules.keyDrivers.maxDrivers,
              requirePriceRelationship: modules.keyDrivers.requirePriceRelationship,
              priceWindow: modules.keyDrivers.priceWindow,
            },
          }
          : undefined,
      }),
      evidenceFamilies: packets.map((packet) => ({
        kind: packet.kind,
        label: packet.label,
        items: packet.items.map((item) => withDefined({
          ref: item.ref,
          title: item.title,
          summary: item.summary,
          excerpt: item.excerpt,
          publishedAt: item.publishedAt,
          sourceDomain: item.sourceDomain,
        })),
      })),
      priorMemorySummary: shape.includePriorMemory ? compactPriorMemorySummary(input.priorOutput?.memorySummaryJson ?? null) ?? undefined : undefined,
      priorDeltaSummary: shape.includePriorDelta
        ? normalizeSnippet(input.priorOutput?.deltaJson?.summary ?? null, 220) ?? undefined
        : undefined,
    }));
    selectedUser = user;
    selectedAliases = aliasMap;
    if (user.length <= RESEARCH_LAB_SYNTHESIS_MAX_PROMPT_CHARS) {
      return { user, aliasMap };
    }
  }
  return { user: selectedUser, aliasMap: selectedAliases };
}

function remapEvidenceIds(ids: string[], aliasMap: Map<string, string>, availableEvidenceIds: Set<string>): string[] {
  const mapped = ids
    .map((id) => aliasMap.get(id) ?? id)
    .filter((id) => availableEvidenceIds.has(id));
  return Array.from(new Set(mapped));
}

function remapSynthesisEvidenceIds(
  synthesis: ResearchLabSynthesis,
  aliasMap: Map<string, string>,
  availableEvidenceIds: Set<string>,
): ResearchLabSynthesis {
  return {
    ...synthesis,
    catalysts: synthesis.catalysts.map((item) => ({
      ...item,
      evidenceIds: remapEvidenceIds(item.evidenceIds, aliasMap, availableEvidenceIds),
    })),
    risks: synthesis.risks.map((item) => ({
      ...item,
      evidenceIds: remapEvidenceIds(item.evidenceIds, aliasMap, availableEvidenceIds),
    })),
    contradictions: synthesis.contradictions.map((item) => ({
      ...item,
      evidenceIds: remapEvidenceIds(item.evidenceIds, aliasMap, availableEvidenceIds),
    })),
    modules: synthesis.modules?.keyDrivers
      ? {
        ...synthesis.modules,
        keyDrivers: {
          ...synthesis.modules.keyDrivers,
          drivers: synthesis.modules.keyDrivers.drivers.map((item) => ({
            ...item,
            evidenceIds: remapEvidenceIds(item.evidenceIds, aliasMap, availableEvidenceIds),
          })),
        },
      }
      : synthesis.modules ?? null,
    evidenceIds: remapEvidenceIds(synthesis.evidenceIds, aliasMap, availableEvidenceIds),
  };
}

export async function synthesizeResearchLabOutput(env: Env, input: {
  identity: ResearchLabTickerIdentity;
  evidence: ResearchLabEvidenceRecord[];
  promptConfig: ResearchLabPromptConfigRecord;
  evidencePromptLimit: number;
  priorOutput: ResearchLabOutputRecord | null;
}): Promise<{ synthesis: ResearchLabSynthesis; usage: Record<string, unknown> | null; model: string }> {
  const config = (input.promptConfig.synthesisConfigJson ?? {}) as PromptConfigJson;
  const additionalInstructions = typeof config.additionalInstructions === "string"
    ? config.additionalInstructions.trim()
    : "";
  const promptInput = buildSynthesisPromptUser(input);

  const response = await callResearchLabSonnetJson<ResearchLabSynthesis>(env, {
    promptConfig: {
      ...input.promptConfig,
      systemPrompt: [
        input.promptConfig.systemPrompt,
        "Return strict JSON only with no markdown fences.",
        `JSON shape: ${buildSectionSpec(input.promptConfig)}.`,
        "Use the provided short evidence refs exactly as given, then include only supported refs in evidenceIds fields.",
        "Ground every material claim in evidence refs and say explicitly when evidence is weak, mixed, or inconclusive.",
        ...buildModuleInstructions(input.promptConfig),
        additionalInstructions,
      ].filter(Boolean).join(" "),
    },
    user: promptInput.user,
    maxTokens: RESEARCH_LAB_ANTHROPIC_MAX_TOKENS,
  });

  const availableEvidenceIds = new Set(input.evidence.map((item) => item.id));
  const remapped = remapSynthesisEvidenceIds(response.data, promptInput.aliasMap, availableEvidenceIds);
  const synthesis = validateResearchLabSynthesis({
    ...remapped,
    ticker: input.identity.ticker,
    companyName: input.identity.companyName,
  }, availableEvidenceIds);

  return {
    synthesis,
    usage: response.usage,
    model: response.model,
  };
}
