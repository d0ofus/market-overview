import type { Env } from "../../types";
import { callAnthropicJson } from "./anthropic";
import { searchPerplexity, type PerplexitySearchQuery } from "./perplexity-search";
import { fetchRecentFilings, fetchStructuredFacts, resolveIssuer } from "./sec-direct";

export type SecResearchProvider = {
  resolveIssuer: typeof resolveIssuer;
  fetchRecentFilings: typeof fetchRecentFilings;
  fetchStructuredFacts: typeof fetchStructuredFacts;
};

export type SearchResearchProvider = {
  search: typeof searchPerplexity;
};

export type ModelResearchProvider = {
  callJson: typeof callAnthropicJson;
};

export function getSecResearchProvider(_env: Env): SecResearchProvider {
  return {
    resolveIssuer,
    fetchRecentFilings,
    fetchStructuredFacts,
  };
}

export function getSearchResearchProvider(_env: Env): SearchResearchProvider {
  return {
    search: searchPerplexity,
  };
}

export function getModelResearchProvider(_env: Env): ModelResearchProvider {
  return {
    callJson: callAnthropicJson,
  };
}

export type { PerplexitySearchQuery };
