import { z } from "zod";

export const rankingWindowSchema = z.enum(["1D", "5D", "1W", "YTD", "52W"]);

export const columnsSchema = z.array(z.string()).min(1);

export const configPatchSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  timezone: z.string().min(1),
  eodRunLocalTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  eodRunTimeLabel: z.string().min(1),
});

export const groupPatchSchema = z.object({
  title: z.string().min(1),
  rankingWindowDefault: rankingWindowSchema,
  showSparkline: z.boolean(),
  pinTop10: z.boolean(),
  columns: columnsSchema,
});

export const itemCreateSchema = z.object({
  ticker: z.string().min(1).transform((v) => v.toUpperCase()),
  displayName: z.string().nullable().optional(),
  tags: z.array(z.string()).optional().default([]),
});

export const itemPatchSchema = z.object({
  displayName: z.string().trim().max(240).nullable().optional(),
});

export const peerGroupTypeSchema = z.enum(["fundamental", "technical", "custom"]);

export const peerGroupCreateSchema = z.object({
  name: z.string().min(1),
  slug: z.string().nullable().optional(),
  groupType: peerGroupTypeSchema.optional().default("fundamental"),
  description: z.string().nullable().optional(),
  priority: z.number().int().optional().default(0),
  isActive: z.boolean().optional().default(true),
});

export const peerGroupPatchSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().nullable().optional(),
  groupType: peerGroupTypeSchema.optional(),
  description: z.string().nullable().optional(),
  priority: z.number().int().nullable().optional(),
  isActive: z.boolean().optional(),
});

export const peerMembershipCreateSchema = z.object({
  ticker: z.string().min(1).transform((v) => v.toUpperCase()),
  source: z.enum(["manual", "fmp_seed", "finnhub_seed", "system"]).optional().default("manual"),
  confidence: z.number().nullable().optional(),
});

export const peerSeedSchema = z.object({
  ticker: z.string().min(1).transform((v) => v.toUpperCase()),
});

export const peerBootstrapSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(10),
  offset: z.number().int().min(0).optional().default(0),
  q: z.string().trim().optional().default(""),
  onlyUnseeded: z.boolean().optional().default(true),
  providerMode: z.enum(["both", "finnhub", "fmp"]).optional().default("both"),
  enrichPeers: z.boolean().optional().default(false),
});

export const peerNormalizeSchema = z.object({
  limit: z.number().int().min(1).max(1000).optional().default(250),
});

const timezoneStringSchema = z.string().min(1);
const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);
const urlSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./i, "");
    return /tradingview\.com$/i.test(host);
  } catch {
    return false;
  }
}, "TradingView public watchlist URL is required.");

export const watchlistSetCreateSchema = z.object({
  name: z.string().min(1),
  slug: z.string().nullable().optional(),
  isActive: z.boolean().optional().default(true),
  compileDaily: z.boolean().optional().default(false),
  dailyCompileTimeLocal: localTimeSchema.nullable().optional(),
  dailyCompileTimezone: timezoneStringSchema.nullable().optional(),
});

export const watchlistSetPatchSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  compileDaily: z.boolean().optional(),
  dailyCompileTimeLocal: localTimeSchema.nullable().optional(),
  dailyCompileTimezone: timezoneStringSchema.nullable().optional(),
});

export const watchlistSourceCreateSchema = z.object({
  sourceName: z.string().trim().max(120).nullable().optional(),
  sourceUrl: urlSchema,
  sourceSections: z.string().trim().max(2000).nullable().optional(),
  isActive: z.boolean().optional().default(true),
});

export const watchlistSourcePatchSchema = z.object({
  sourceName: z.string().trim().max(120).nullable().optional(),
  sourceUrl: urlSchema.optional(),
  sourceSections: z.string().trim().max(2000).nullable().optional(),
  sortOrder: z.number().int().min(1).max(9999).optional(),
  isActive: z.boolean().optional(),
});

const scanRuleScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

const scanRuleFieldReferenceSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  const multiplierRaw = candidate.multiplier;
  let multiplier = multiplierRaw;
  if (typeof multiplierRaw === "string") {
    const parsed = Number(multiplierRaw.trim());
    multiplier = Number.isFinite(parsed) ? parsed : multiplierRaw;
  }
  return {
    ...candidate,
    field: typeof candidate.field === "string" ? candidate.field.trim() : candidate.field,
    multiplier,
  };
}, z.object({
  type: z.literal("field"),
  field: z.string().min(1, "Comparison field is required."),
  multiplier: z.number().finite().optional(),
}));

const scanRuleValueSchema = z.union([
  scanRuleScalarSchema,
  z.array(scanRuleScalarSchema),
  scanRuleFieldReferenceSchema,
]);

export const scanPresetRuleSchema = z.object({
  id: z.string().min(1),
  field: z.string().min(1),
  operator: z.enum(["gt", "gte", "lt", "lte", "eq", "neq", "in", "not_in"]),
  value: scanRuleValueSchema,
}).superRefine((rule, ctx) => {
  if (typeof rule.value === "object" && rule.value !== null && !Array.isArray(rule.value) && rule.value.type === "field") {
    if (rule.operator === "in" || rule.operator === "not_in") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operator"],
        message: "Field comparisons do not support 'in' or 'not in'.",
      });
    }
  }
});

export const scanPresetCreateSchema = z.object({
  name: z.string().min(1),
  isDefault: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
  rules: z.array(scanPresetRuleSchema).min(1),
  sortField: z.string().min(1).optional().default("change"),
  sortDirection: z.enum(["asc", "desc"]).optional().default("desc"),
  rowLimit: z.number().int().min(1).max(250).optional().default(100),
});

export const scanPresetPatchSchema = z.object({
  name: z.string().min(1).optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  rules: z.array(scanPresetRuleSchema).min(1).optional(),
  sortField: z.string().min(1).optional(),
  sortDirection: z.enum(["asc", "desc"]).optional(),
  rowLimit: z.number().int().min(1).max(250).optional(),
});

export const scanRefreshSchema = z.object({
  presetId: z.string().min(1).nullable().optional(),
});
