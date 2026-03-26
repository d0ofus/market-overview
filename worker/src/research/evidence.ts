import type {
  ResearchEvidenceInput,
  ResearchEvidenceRecord,
  ResearchEvidenceScopeKind,
  ResearchEvidenceSourceKind,
  ResearchEvidenceTopic,
  ResearchEvidenceTopicSummary,
  ResearchProfileSettings,
  ResearchSourceTrustClass,
  TopicEvidencePacket,
} from "./types";
import type { SecFilingItem, SecStructuredFact } from "./providers/sec-direct";
import type { PerplexitySearchItem } from "./providers/perplexity-search";

function sha1(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

export function buildEvidenceCacheKey(parts: Array<string | number | null | undefined>): string {
  return sha1(parts.map((part) => String(part ?? "")).join("|"));
}

export function normalizeEvidenceInput(input: Omit<ResearchEvidenceInput, "contentHash" | "cacheKey"> & {
  cacheParts: Array<string | number | null | undefined>;
  contentParts: Array<string | number | null | undefined>;
}): ResearchEvidenceInput {
  return {
    ...input,
    contentHash: buildEvidenceCacheKey(input.contentParts),
    cacheKey: buildEvidenceCacheKey(input.cacheParts),
  };
}

export function secFilingsToEvidence(ticker: string, cik: string, filings: SecFilingItem[]): ResearchEvidenceInput[] {
  return filings.map((filing) => normalizeEvidenceInput({
    id: crypto.randomUUID(),
    providerKey: "sec_direct",
    sourceKind: "sec_submission",
    scopeKind: "ticker",
    ticker,
    secCik: cik,
    canonicalUrl: filing.accessionNumber
      ? `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${filing.accessionNumber.replace(/-/g, "")}/${filing.primaryDocument ?? ""}`
      : null,
    sourceDomain: "sec.gov",
    title: `${filing.form} filing`,
    publishedAt: filing.filingDate,
    retrievedAt: new Date().toISOString(),
    artifactSizeBytes: null,
    r2Key: null,
    snippet: {
      summary: [filing.primaryDocDescription, filing.items].filter(Boolean).join(" | ") || `${filing.form} filed on ${filing.filingDate ?? "unknown date"}.`,
      excerpt: filing.primaryDocDescription ?? filing.items ?? null,
    },
    metadata: {
      accessionNumber: filing.accessionNumber,
      form: filing.form,
      reportDate: filing.reportDate,
      primaryDocument: filing.primaryDocument,
      items: filing.items,
    },
    providerPayload: null,
    cacheParts: ["sec_submission", ticker, filing.accessionNumber, filing.filingDate],
    contentParts: [ticker, filing.accessionNumber, filing.form, filing.primaryDocDescription, filing.items],
  }));
}

export function secFactsToEvidence(ticker: string, cik: string, facts: SecStructuredFact[]): ResearchEvidenceInput[] {
  return facts.map((fact) => normalizeEvidenceInput({
    id: crypto.randomUUID(),
    providerKey: "sec_direct",
    sourceKind: "sec_facts",
    scopeKind: "ticker",
    ticker,
    secCik: cik,
    canonicalUrl: `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
    sourceDomain: "sec.gov",
    title: `SEC fact: ${fact.label}`,
    publishedAt: fact.filedAt,
    retrievedAt: new Date().toISOString(),
    artifactSizeBytes: null,
    r2Key: null,
    snippet: {
      summary: `${fact.label}: ${fact.value.toLocaleString()} ${fact.unit}${fact.periodEnd ? ` (period end ${fact.periodEnd})` : ""}`,
      bullets: [fact.form, fact.fiscalPeriod, fact.periodEnd].filter((item): item is string => Boolean(item)),
    },
    metadata: {
      factKey: fact.key,
      label: fact.label,
      unit: fact.unit,
      value: fact.value,
      form: fact.form,
      fiscalYear: fact.fiscalYear,
      fiscalPeriod: fact.fiscalPeriod,
      periodEnd: fact.periodEnd,
    },
    providerPayload: null,
    cacheParts: ["sec_facts", ticker, fact.key, fact.filedAt, fact.value],
    contentParts: [ticker, fact.key, fact.value, fact.filedAt, fact.periodEnd],
  }));
}

function searchItemTitle(item: PerplexitySearchItem): string {
  return item.title || item.summary.slice(0, 100) || "Search result";
}

export function searchItemsToEvidence(items: PerplexitySearchItem[]): ResearchEvidenceInput[] {
  return items.map((item) => normalizeEvidenceInput({
    id: crypto.randomUUID(),
    providerKey: "perplexity_search",
    sourceKind: item.sourceKind as ResearchEvidenceSourceKind,
    scopeKind: item.scopeKind as ResearchEvidenceScopeKind,
    ticker: item.ticker ?? null,
    secCik: null,
    canonicalUrl: item.url,
    sourceDomain: item.sourceDomain,
    title: searchItemTitle(item),
    publishedAt: item.publishedAt,
    retrievedAt: new Date().toISOString(),
    artifactSizeBytes: null,
    r2Key: null,
    snippet: {
      summary: item.summary,
      excerpt: item.excerpt ?? null,
      bullets: Array.isArray(item.bullets) ? item.bullets.filter(Boolean) : undefined,
    },
    metadata: null,
    providerPayload: null,
    cacheParts: ["search", item.ticker, item.sourceKind, item.url, item.publishedAt],
    contentParts: [item.title, item.url, item.summary, item.publishedAt, item.excerpt],
  }));
}

export function sourceKindToTrustClass(sourceKind: ResearchEvidenceSourceKind): ResearchSourceTrustClass {
  if (sourceKind === "sec_submission" || sourceKind === "sec_facts") return "filing";
  if (sourceKind === "earnings_transcript" || sourceKind === "ir_page") return "official";
  if (sourceKind === "news" || sourceKind === "macro_release" || sourceKind === "central_bank") return "news";
  if (sourceKind === "analyst_commentary") return "analyst";
  return "low_trust";
}

export function sourceKindToTrustTier(sourceKind: ResearchEvidenceSourceKind): 1 | 2 | 3 | 4 | 5 {
  if (sourceKind === "sec_submission" || sourceKind === "sec_facts") return 5;
  if (sourceKind === "earnings_transcript" || sourceKind === "ir_page") return 4;
  if (sourceKind === "news" || sourceKind === "macro_release" || sourceKind === "central_bank") return 3;
  if (sourceKind === "analyst_commentary") return 2;
  return 1;
}

function evidenceRecencyDays(record: ResearchEvidenceRecord): number | null {
  const ts = Date.parse(record.publishedAt ?? record.retrievedAt);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.round((Date.now() - ts) / 86400_000));
}

export function inferEvidenceTopic(record: ResearchEvidenceRecord): ResearchEvidenceTopic {
  const title = `${record.title} ${record.snippet?.summary ?? ""}`.toLowerCase();
  if (record.scopeKind === "market" || record.scopeKind === "macro") return "macro_context";
  if (record.sourceKind === "sec_facts") {
    if (/revenue|margin|cash|income|eps|operating|free cash|share/i.test(title)) return "earnings_quality";
    return "valuation";
  }
  if (/peer|competitor|rival|versus|vs\./i.test(title)) return "peer_comparison";
  if (/valuation|multiple|p\/e|ev\/|cheap|expensive|stretched|full/i.test(title)) return "valuation";
  if (/priced in|expectation|consensus|embedded|estimate/i.test(title)) return "market_pricing";
  if (/theme|tailwind|adoption|secular|ai|cloud|electrification/i.test(title)) return "thematic_fit";
  if (/risk|headwind|challenge|regulatory|litigation|weakness/i.test(title)) return "risks";
  if (/earnings|guide|guidance|beat|miss|margin|cash flow|revenue/i.test(title)) return "earnings_quality";
  if (/launch|product|catalyst|approval|contract|pipeline|capex|demand/i.test(title)) return "catalysts";
  if (/contradiction|despite|however|but/i.test(title)) return "contradictions";
  return "general";
}

const TOPIC_LABELS: Record<ResearchEvidenceTopic, string> = {
  thesis: "Thesis",
  market_pricing: "Market Pricing",
  earnings_quality: "Earnings Quality",
  catalysts: "Catalysts",
  risks: "Risks",
  contradictions: "Contradictions",
  valuation: "Valuation",
  thematic_fit: "Thematic Fit",
  setup_quality: "Setup Quality",
  peer_comparison: "Peer Comparison",
  macro_context: "Macro Context",
  general: "General",
};

function topicPriority(topic: ResearchEvidenceTopic): number {
  return [
    "market_pricing",
    "earnings_quality",
    "valuation",
    "catalysts",
    "risks",
    "peer_comparison",
    "thematic_fit",
    "contradictions",
    "macro_context",
    "general",
    "setup_quality",
    "thesis",
  ].indexOf(topic);
}

function evidenceSortScore(record: ResearchEvidenceRecord): number {
  const trust = sourceKindToTrustTier(record.sourceKind) * 1000;
  const published = Date.parse(record.publishedAt ?? record.retrievedAt ?? "") || 0;
  return trust + published;
}

export function summarizeEvidence(records: ResearchEvidenceRecord[], maxItems: number): Array<{
  id: string;
  title: string;
  sourceKind: ResearchEvidenceSourceKind;
  publishedAt: string | null;
  summary: string;
  excerpt: string | null;
  url: string | null;
}> {
  return records
    .slice()
    .sort((left, right) => evidenceSortScore(right) - evidenceSortScore(left))
    .slice(0, maxItems)
    .map((record) => ({
      id: record.id,
      title: record.title,
      sourceKind: record.sourceKind,
      publishedAt: record.publishedAt,
      summary: record.snippet?.summary ?? "",
      excerpt: record.snippet?.excerpt ?? null,
      url: record.canonicalUrl,
    }));
}

export function buildTopicEvidencePackets(
  records: ResearchEvidenceRecord[],
  settings: ResearchProfileSettings,
): TopicEvidencePacket[] {
  const byTopic = new Map<ResearchEvidenceTopic, ResearchEvidenceRecord[]>();
  for (const record of records) {
    const topic = inferEvidenceTopic(record);
    const current = byTopic.get(topic) ?? [];
    current.push(record);
    byTopic.set(topic, current);
  }
  return Array.from(byTopic.entries())
    .sort((left, right) => topicPriority(left[0]) - topicPriority(right[0]))
    .map(([topic, topicRecords]) => {
      const sorted = topicRecords
        .slice()
        .sort((left, right) => evidenceSortScore(right) - evidenceSortScore(left))
        .slice(0, settings.maxTopicEvidenceItems ?? 4);
      const sourceClassBreakdown = sorted.reduce<Record<string, number>>((acc, record) => {
        const sourceClass = sourceKindToTrustClass(record.sourceKind);
        acc[sourceClass] = (acc[sourceClass] ?? 0) + 1;
        return acc;
      }, {});
      const confidenceScore = computeTopicEvidenceConfidence(sorted);
      return {
        topic,
        label: TOPIC_LABELS[topic],
        items: sorted.map((record) => ({
          id: record.id,
          title: record.title,
          summary: record.snippet?.summary ?? "",
          excerpt: record.snippet?.excerpt ?? null,
          bullets: (record.snippet?.bullets ?? []).slice(0, settings.maxEvidenceExcerptsPerTopic ?? 2),
          url: record.canonicalUrl,
          sourceKind: record.sourceKind,
          sourceDomain: record.sourceDomain,
          sourceClass: sourceKindToTrustClass(record.sourceKind),
          trustTier: sourceKindToTrustTier(record.sourceKind),
          isOfficialSource: sourceKindToTrustTier(record.sourceKind) >= 4,
          publishedAt: record.publishedAt,
          recencyDays: evidenceRecencyDays(record),
        })),
        evidenceIds: sorted.map((record) => record.id),
        sourceClassBreakdown,
        confidenceScore,
      } satisfies TopicEvidencePacket;
    });
}

export function computeTopicEvidenceConfidence(records: ResearchEvidenceRecord[]): number {
  if (records.length === 0) return 0;
  const trustWeighted = records.reduce((sum, record) => sum + sourceKindToTrustTier(record.sourceKind), 0) / records.length;
  const recentCount = records.filter((record) => {
    const age = evidenceRecencyDays(record);
    return age != null && age <= 30;
  }).length;
  const recencyBonus = recentCount / records.length;
  return Number(Math.max(0, Math.min(1, ((trustWeighted / 5) * 0.75) + (recencyBonus * 0.25))).toFixed(2));
}

export function summarizeEvidenceTopics(packets: TopicEvidencePacket[]): ResearchEvidenceTopicSummary[] {
  return packets.map((packet) => ({
    topic: packet.topic,
    confidenceScore: packet.confidenceScore,
    trustWeightedCoverage: Number((packet.items.reduce((sum, item) => sum + item.trustTier, 0) / Math.max(packet.items.length, 1) * 20).toFixed(1)),
    evidenceCount: packet.items.length,
  }));
}
