import type { ResearchProfileSettings, SearchTemplateVersionRecord } from "./types";
import type { PerplexitySearchQuery } from "./providers";

type SearchTemplateFamily = {
  key: string;
  label: string;
  queryTemplate: string;
  limit?: number;
  topic?: string;
};

function renderTemplate(template: string, vars: Record<string, string | number | null | undefined>) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => String(vars[key] ?? ""));
}

function familyLimit(limit: number | undefined, settings: ResearchProfileSettings) {
  return Math.max(1, Math.min(limit ?? settings.maxSearchResultsPerQuery, settings.maxSearchResultsPerQuery));
}

function trimTickerQueries(queries: PerplexitySearchQuery[], maxQueries: number): PerplexitySearchQuery[] {
  return queries.slice(0, Math.max(1, maxQueries));
}

export function buildTickerSearchQueries(input: {
  ticker: string;
  companyName: string | null;
  irDomain: string | null;
  template: SearchTemplateVersionRecord;
  settings: ResearchProfileSettings;
}): PerplexitySearchQuery[] {
  const templateJson = input.template.templateJson as {
    tickerFamilies?: SearchTemplateFamily[];
  };
  const families = Array.isArray(templateJson?.tickerFamilies) ? templateJson.tickerFamilies : [];
  const filtered = families.filter((family) => {
    if (family.key === "news") return input.settings.sourceFamilies.news;
    if (family.key === "earnings_transcript") return input.settings.sourceFamilies.earningsTranscripts;
    if (family.key === "investor_relations") return input.settings.sourceFamilies.investorRelations;
    if (family.key === "analyst_commentary") return input.settings.sourceFamilies.analystCommentary;
    return true;
  });
  const rendered = filtered.map((family) => ({
    key: family.key,
    label: family.label,
    query: renderTemplate(family.queryTemplate, {
      ticker: input.ticker,
      companyName: input.companyName ?? input.ticker,
      irDomain: input.irDomain ?? "",
      lookbackDays: input.settings.lookbackDays,
    }).replace(/\s+/g, " ").trim(),
    scopeKind: "ticker",
    sourceKind:
      family.key === "earnings_transcript" ? "earnings_transcript"
        : family.key === "investor_relations" ? "ir_page"
          : family.key === "analyst_commentary" ? "analyst_commentary"
            : "news",
    limit: familyLimit(family.limit, input.settings),
    ticker: input.ticker,
  }));
  return trimTickerQueries(rendered, input.settings.maxTickerQueries);
}

export function buildMarketSearchQueries(input: {
  template: SearchTemplateVersionRecord;
  settings: ResearchProfileSettings;
}): PerplexitySearchQuery[] {
  if (!input.settings.includeMacroContext) return [];
  const templateJson = input.template.templateJson as {
    macroFamilies?: SearchTemplateFamily[];
  };
  const families = Array.isArray(templateJson?.macroFamilies) ? templateJson.macroFamilies : [];
  return families.map((family) => ({
    key: family.key,
    label: family.label,
    query: renderTemplate(family.queryTemplate, {
      lookbackDays: input.settings.lookbackDays,
    }).replace(/\s+/g, " ").trim(),
    scopeKind: "market",
    sourceKind: family.key === "central_bank" ? "central_bank" : "macro_release",
    limit: familyLimit(family.limit, input.settings),
    ticker: null,
  }));
}
