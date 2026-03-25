import type { ResearchProfileSettings } from "./types";

export const RESEARCH_SCHEMA_VERSION = "v1";
export const DEFAULT_RESEARCH_PROFILE_ID = "research-profile-swing-core";
export const DEFAULT_RESEARCH_SLICE_TICKERS = 2;
export const DEFAULT_RESEARCH_RUN_LIST_LIMIT = 10;
export const RESEARCH_HEARTBEAT_STALE_MS = 150_000;
export const RESEARCH_EXECUTION_STALE_SECONDS = Math.ceil(RESEARCH_HEARTBEAT_STALE_MS / 1000);
export const RESEARCH_MAX_TICKER_ATTEMPTS = 3;
export const RESEARCH_SEARCH_CACHE_TTL_MS = 24 * 60 * 60_000;
export const RESEARCH_MAX_HISTORY_ROWS = 12;

export const DEFAULT_RESEARCH_SETTINGS: ResearchProfileSettings = {
  lookbackDays: 14,
  includeMacroContext: true,
  maxTickerQueries: 4,
  maxEvidenceItemsPerTicker: 12,
  maxSearchResultsPerQuery: 4,
  maxTickersPerRun: 20,
  deepDiveTopN: 3,
  comparisonEnabled: true,
  sourceFamilies: {
    sec: true,
    news: true,
    earningsTranscripts: true,
    investorRelations: true,
    analystCommentary: true,
  },
};

export const DEFAULT_RESEARCH_WARNING = "Research completed with fallback-only or partial evidence coverage.";
