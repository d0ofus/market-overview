import type { ResearchEvidenceInput, ResearchEvidenceRecord, ResearchEvidenceSourceKind, ResearchEvidenceScopeKind } from "./types";
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
    },
    metadata: null,
    providerPayload: null,
    cacheParts: ["search", item.ticker, item.sourceKind, item.url, item.publishedAt],
    contentParts: [item.title, item.url, item.summary, item.publishedAt],
  }));
}

export function summarizeEvidence(records: ResearchEvidenceRecord[], maxItems: number): Array<{
  id: string;
  title: string;
  sourceKind: ResearchEvidenceSourceKind;
  publishedAt: string | null;
  summary: string;
  url: string | null;
}> {
  return records
    .slice()
    .sort((left, right) => Date.parse(right.publishedAt ?? right.retrievedAt ?? "") - Date.parse(left.publishedAt ?? left.retrievedAt ?? ""))
    .slice(0, maxItems)
    .map((record) => ({
      id: record.id,
      title: record.title,
      sourceKind: record.sourceKind,
      publishedAt: record.publishedAt,
      summary: record.snippet?.summary ?? "",
      url: record.canonicalUrl,
    }));
}
