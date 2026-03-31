import type { Env } from "../types";
import { runResearchLabPerplexityQuery } from "./providers";
import type {
  ResearchLabEvidenceKind,
  ResearchLabEvidenceProfileRecord,
  ResearchLabEvidenceRecord,
  ResearchLabTickerIdentity,
} from "./types";

type EvidenceProfileFamily = {
  key: ResearchLabEvidenceKind;
  label: string;
  queryTemplate: string;
  sourceKind: "news" | "earnings_transcript" | "ir_page" | "analyst_commentary" | "macro_release" | "media";
  limit?: number;
};

type EvidenceProfileConfig = {
  lookbackDays?: number;
  maxItemsPerQuery?: number;
  maxItemsForPrompt?: number;
  families?: EvidenceProfileFamily[];
};

function renderTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => String(vars[key] ?? ""));
}

export function buildResearchLabGatherQueries(
  identity: ResearchLabTickerIdentity,
  evidenceProfile: ResearchLabEvidenceProfileRecord,
): EvidenceProfileFamily[] {
  const config = (evidenceProfile.queryConfigJson ?? {}) as EvidenceProfileConfig;
  return Array.isArray(config.families) ? config.families : [];
}

function buildEvidenceRecord(input: {
  runId: string;
  runItemId: string;
  ticker: string;
  kind: ResearchLabEvidenceKind;
  queryLabel: string;
  item: {
    title: string;
    url: string | null;
    summary: string;
    excerpt?: string | null;
    bullets?: string[] | null;
    publishedAt: string | null;
    sourceDomain: string | null;
  };
  rawPayload: Record<string, unknown> | null;
}): ResearchLabEvidenceRecord {
  const contentHash = [
    input.item.url ?? "",
    input.item.title.trim(),
    input.item.summary.trim(),
    input.item.publishedAt ?? "",
  ].join("|");
  return {
    id: crypto.randomUUID(),
    runId: input.runId,
    runItemId: input.runItemId,
    ticker: input.ticker,
    providerKey: "perplexity",
    evidenceKind: input.kind,
    queryLabel: input.queryLabel,
    canonicalUrl: input.item.url,
    sourceDomain: input.item.sourceDomain,
    title: input.item.title.trim(),
    publishedAt: input.item.publishedAt,
    summary: input.item.summary.trim(),
    excerpt: input.item.excerpt?.trim() || null,
    bullets: Array.isArray(input.item.bullets) ? input.item.bullets.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 4) : [],
    contentHash,
    providerPayloadJson: input.rawPayload,
    createdAt: new Date().toISOString(),
  };
}

export async function gatherResearchLabEvidence(env: Env, input: {
  runId: string;
  runItemId: string;
  identity: ResearchLabTickerIdentity;
  evidenceProfile: ResearchLabEvidenceProfileRecord;
}): Promise<{
  evidence: ResearchLabEvidenceRecord[];
  usage: Record<string, unknown> | null;
  model: string | null;
  promptEvidenceLimit: number;
}> {
  const config = (input.evidenceProfile.queryConfigJson ?? {}) as EvidenceProfileConfig;
  const lookbackDays = Math.max(3, Number(config.lookbackDays ?? 21));
  const maxItemsPerQuery = Math.max(1, Number(config.maxItemsPerQuery ?? 3));
  const promptEvidenceLimit = Math.max(6, Number(config.maxItemsForPrompt ?? 12));
  const families = buildResearchLabGatherQueries(input.identity, input.evidenceProfile);
  const evidence: ResearchLabEvidenceRecord[] = [];
  const seenKeys = new Set<string>();
  let usage: Record<string, unknown> | null = null;
  let model: string | null = null;

  for (const family of families) {
    const result = await runResearchLabPerplexityQuery(env, {
      key: family.key,
      label: family.label,
      query: renderTemplate(family.queryTemplate, {
        ticker: input.identity.ticker,
        companyName: input.identity.companyName ?? input.identity.ticker,
        irDomain: input.identity.irDomain ?? "",
        lookbackDays,
      }).replace(/\s+/g, " ").trim(),
      ticker: input.identity.ticker,
      limit: Math.max(1, Math.min(family.limit ?? maxItemsPerQuery, maxItemsPerQuery)),
      sourceKind: family.sourceKind,
    });

    if (result.raw && typeof result.raw === "object") {
      model = typeof (result.raw as { model?: unknown }).model === "string"
        ? String((result.raw as { model?: unknown }).model)
        : model;
    }

    if (result.usage && typeof result.usage === "object") {
      usage = {
        ...(usage ?? {}),
        ...Object.fromEntries(Object.entries(result.usage).map(([key, value]) => {
          const previous = usage && typeof usage[key] === "number" ? Number(usage[key]) : 0;
          return [key, typeof value === "number" ? previous + value : value];
        })),
      };
    }

    for (const item of result.items) {
      const record = buildEvidenceRecord({
        runId: input.runId,
        runItemId: input.runItemId,
        ticker: input.identity.ticker,
        kind: family.key,
        queryLabel: family.label,
        item,
        rawPayload: result.raw,
      });
      if (!record.summary) continue;
      const dedupeKey = record.canonicalUrl?.trim() || record.contentHash;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      evidence.push(record);
    }
  }

  if (evidence.length === 0) {
    throw new Error("Perplexity returned no usable evidence.");
  }

  return {
    evidence,
    usage,
    model: model ?? env.PERPLEXITY_MODEL?.trim() ?? "sonar-pro",
    promptEvidenceLimit,
  };
}
