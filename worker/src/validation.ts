import { z } from "zod";

export const rankingWindowSchema = z.enum(["1D", "5D", "1W", "YTD", "52W"]);

export const columnsSchema = z.array(z.string()).min(1);

export const configPatchSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  timezone: z.string().min(1),
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
