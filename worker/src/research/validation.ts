import { z } from "zod";

const profileSettingsSchema = z.object({
  lookbackDays: z.number().int().min(1).max(90),
  includeMacroContext: z.boolean(),
  maxTickerQueries: z.number().int().min(1).max(12),
  maxEvidenceItemsPerTicker: z.number().int().min(4).max(40),
  maxSearchResultsPerQuery: z.number().int().min(1).max(10),
  maxTickersPerRun: z.number().int().min(1).max(100),
  deepDiveTopN: z.number().int().min(0).max(20),
  comparisonEnabled: z.boolean(),
  sourceFamilies: z.object({
    sec: z.boolean(),
    news: z.boolean(),
    earningsTranscripts: z.boolean(),
    investorRelations: z.boolean(),
    analystCommentary: z.boolean(),
  }),
});

export const researchRunCreateSchema = z.object({
  sourceType: z.enum(["watchlist_set", "manual"]).default("watchlist_set"),
  sourceId: z.string().nullable().optional(),
  sourceLabel: z.string().nullable().optional(),
  watchlistRunId: z.string().nullable().optional(),
  sourceBasis: z.enum(["compiled", "unique"]).optional().default("unique"),
  tickers: z.array(z.string().min(1).transform((value) => value.trim().toUpperCase())).optional(),
  selectedTickers: z.array(z.string().min(1).transform((value) => value.trim().toUpperCase())).optional(),
  profileId: z.string().nullable().optional(),
  maxTickers: z.number().int().min(1).max(100).nullable().optional(),
  refreshMode: z.enum(["reuse_fresh_search_cache", "force_fresh"]).optional().default("reuse_fresh_search_cache"),
  rankingMode: z.enum(["rank_only", "rank_and_deep_dive"]).optional().default("rank_only"),
  deepDiveTopN: z.number().int().min(0).max(20).nullable().optional(),
});

export const researchCompareQuerySchema = z.object({
  baselineSnapshotId: z.string().nullable().optional(),
});

export const researchProfileCreateSchema = z.object({
  slug: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  isActive: z.boolean().optional().default(true),
  isDefault: z.boolean().optional().default(false),
});

export const researchProfilePatchSchema = z.object({
  slug: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  currentVersionId: z.string().nullable().optional(),
});

export const researchProfileVersionCreateSchema = z.object({
  promptVersionIdHaiku: z.string().min(1),
  promptVersionIdSonnetRank: z.string().min(1),
  promptVersionIdSonnetDeepDive: z.string().min(1),
  rubricVersionId: z.string().min(1),
  searchTemplateVersionId: z.string().min(1),
  settings: profileSettingsSchema,
  activate: z.boolean().optional().default(true),
});

export const promptVersionCreateSchema = z.object({
  promptKind: z.enum(["haiku_extract", "sonnet_rank", "sonnet_deep_dive"]),
  label: z.string().trim().min(1).max(120),
  providerKey: z.string().trim().min(1).max(40).default("anthropic"),
  modelFamily: z.string().trim().min(1).max(80),
  schemaVersion: z.string().trim().min(1).max(20).default("v1"),
  templateText: z.string().trim().min(1).max(20000).nullable().optional(),
  templateJson: z.record(z.any()).nullable().optional(),
});

export const rubricVersionCreateSchema = z.object({
  label: z.string().trim().min(1).max(120),
  schemaVersion: z.string().trim().min(1).max(20).default("v1"),
  rubricJson: z.record(z.any()),
});

export const searchTemplateVersionCreateSchema = z.object({
  label: z.string().trim().min(1).max(120),
  schemaVersion: z.string().trim().min(1).max(20).default("v1"),
  templateJson: z.record(z.any()),
});
