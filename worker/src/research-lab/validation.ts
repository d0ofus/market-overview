import { z } from "zod";

const labModuleDriverSettingsSchema = z.object({
  enabled: z.boolean().optional().default(false),
  maxDrivers: z.number().int().min(1).max(8).optional().default(3),
  requirePriceRelationship: z.boolean().optional().default(true),
  priceWindow: z.string().trim().min(1).max(40).optional().default("90d"),
});

export const researchLabModulesConfigSchema = z.object({
  keyDrivers: labModuleDriverSettingsSchema.optional().default({
    enabled: false,
    maxDrivers: 3,
    requirePriceRelationship: true,
    priceWindow: "90d",
  }),
});

export const researchLabProfileCreateSchema = z.object({
  slug: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  isActive: z.boolean().optional().default(true),
  isDefault: z.boolean().optional().default(false),
});

export const researchLabProfilePatchSchema = z.object({
  slug: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  currentVersionId: z.string().trim().min(1).nullable().optional(),
});

export const researchLabProfileVersionCreateSchema = z.object({
  label: z.string().trim().min(1).max(120),
  modelFamily: z.string().trim().min(1).max(80),
  systemPrompt: z.string().trim().min(1).max(40000),
  schemaVersion: z.string().trim().min(1).max(20).optional().default("v1"),
  evidenceConfigJson: z.record(z.unknown()),
  synthesisConfigJson: z.record(z.unknown()),
  modulesConfigJson: z.record(z.unknown()).optional().default({}),
  activate: z.boolean().optional().default(true),
});
