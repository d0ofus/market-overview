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
