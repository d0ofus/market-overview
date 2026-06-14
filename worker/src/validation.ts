import { z } from "zod";
export {
  promptVersionCreateSchema,
  researchCompareQuerySchema,
  researchProfileCreateSchema,
  researchProfilePatchSchema,
  researchProfileVersionCreateSchema,
  researchRunCreateSchema,
  rubricVersionCreateSchema,
  searchTemplateVersionCreateSchema,
} from "./research/validation";
export {
  researchLabProfileCreateSchema,
  researchLabProfilePatchSchema,
  researchLabProfileVersionCreateSchema,
} from "./research-lab/validation";

export const rankingWindowSchema = z.enum(["1D", "5D", "1W", "YTD", "52W"]);

export const columnsSchema = z.array(z.string()).min(1);

export const configPatchSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  timezone: z.string().min(1),
  eodRunLocalTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  eodRunTimeLabel: z.string().min(1),
});

export const adminWorkerSchedulePatchSchema = z.object({
  id: z.string().min(1).default("default"),
  rsBackgroundEnabled: z.boolean(),
  rsBackgroundBatchSize: z.number().int().min(1).max(500),
  rsBackgroundMaxBatchesPerTick: z.number().int().min(1).max(100),
  rsBackgroundTimeBudgetMs: z.number().int().min(1_000).max(30_000),
  rsManualCacheReuseEnabled: z.boolean().default(true),
  rsSharedConfigSnapshotFanoutEnabled: z.boolean().default(true),
  postCloseBarsEnabled: z.boolean(),
  postCloseBarsOffsetMinutes: z.number().int().min(0).max(240),
  postCloseBarsBatchSize: z.number().int().min(20).max(2_000),
  postCloseBarsMaxBatchesPerTick: z.number().int().min(1).max(20),
  patternScanEnabled: z.boolean().default(false),
  patternScanOffsetMinutes: z.number().int().min(0).max(360).default(75),
  patternScanBatchSize: z.number().int().min(1).max(500).default(40),
  patternScanMaxBatchesPerTick: z.number().int().min(1).max(20).default(4),
});

const marketCommentaryWeekdaySchema = z.enum([
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]);

function isSupportedTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export const marketCommentarySourceSchema = z.object({
  sourceName: z.string().trim().min(1).max(160),
  url: z.string().trim().url().max(500).nullable().optional(),
  dataUsed: z.string().trim().min(1).max(500),
  timestamp: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export const marketCommentarySettingsPatchSchema = z.object({
  id: z.string().trim().min(1).default("default"),
  enabled: z.boolean(),
  systemPromptTemplate: z.string().trim().min(500).max(50_000),
  staticSources: z.array(marketCommentarySourceSchema).min(1).max(30),
  braveQueries: z.array(z.string().trim().min(10).max(500)).min(1).max(12),
  scheduleEnabled: z.boolean(),
  scheduleTimezone: z.string().trim().min(1).max(80).refine(isSupportedTimezone, "Unsupported schedule timezone."),
  scheduleLocalTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  scheduleDays: z.array(marketCommentaryWeekdaySchema).min(1).max(7),
});

const patternLabelValueSchema = z.enum(["approved", "rejected", "skipped"]);
const patternLabelStatusSchema = z.enum(["active", "archived", "deleted"]);
const patternSelectionModeSchema = z.enum(["chart_range", "fixed_window"]);
const patternDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const patternTagsSchema = z.array(z.string().trim().min(1).max(40)).max(20).optional().default([]);

const patternLabelCreateBaseSchema = z.object({
  profileId: z.string().trim().min(1).optional().default("default"),
  ticker: z.string().trim().min(1).max(20).transform((value) => value.toUpperCase()),
  setupDate: patternDateSchema,
  label: patternLabelValueSchema,
  status: patternLabelStatusSchema.optional(),
  source: z.string().trim().min(1).max(80).optional().default("manual"),
  contextWindowBars: z.number().int().min(60).max(520).optional().default(260),
  patternWindowBars: z.number().int().min(20).max(120).optional().default(40),
  patternStartDate: patternDateSchema.nullable().optional(),
  patternEndDate: patternDateSchema.nullable().optional(),
  selectedBarCount: z.number().int().min(1).max(520).nullable().optional(),
  selectionMode: patternSelectionModeSchema.optional().default("fixed_window"),
  tags: patternTagsSchema,
  notes: z.string().trim().max(2000).nullable().optional(),
  runId: z.string().trim().min(1).nullable().optional(),
  candidateId: z.string().trim().min(1).nullable().optional(),
});

export const patternLabelCreateSchema = patternLabelCreateBaseSchema.superRefine((value, ctx) => {
  const endDate = value.patternEndDate ?? value.setupDate;
  if (value.patternStartDate && value.patternStartDate > endDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["patternStartDate"], message: "patternStartDate must be on or before patternEndDate/setupDate." });
  }
});

export const patternLabelBulkSchema = z.object({
  profileId: z.string().trim().min(1).optional().default("default"),
  csvText: z.string().trim().max(200_000).optional(),
  labels: z.array(patternLabelCreateBaseSchema.omit({ profileId: true })).max(500).optional(),
  contextWindowBars: z.number().int().min(60).max(520).optional().default(260),
  patternWindowBars: z.number().int().min(20).max(120).optional().default(40),
}).refine((value) => Boolean(value.csvText || value.labels?.length), {
  message: "Provide csvText or labels.",
});

export const patternLabelPatchSchema = z.object({
  ticker: z.string().trim().min(1).max(20).transform((value) => value.toUpperCase()).optional(),
  setupDate: patternDateSchema.optional(),
  label: patternLabelValueSchema.optional(),
  status: patternLabelStatusSchema.optional(),
  contextWindowBars: z.number().int().min(60).max(520).optional(),
  patternWindowBars: z.number().int().min(20).max(120).optional(),
  patternStartDate: patternDateSchema.nullable().optional(),
  patternEndDate: patternDateSchema.nullable().optional(),
  selectedBarCount: z.number().int().min(1).max(520).nullable().optional(),
  selectionMode: patternSelectionModeSchema.optional(),
  tags: patternTagsSchema,
  notes: z.string().trim().max(2000).nullable().optional(),
}).superRefine((value, ctx) => {
  const endDate = value.patternEndDate ?? value.setupDate;
  if (value.patternStartDate && endDate && value.patternStartDate > endDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["patternStartDate"], message: "patternStartDate must be on or before patternEndDate/setupDate." });
  }
});

export const patternRunCreateSchema = z.object({
  profileId: z.string().trim().min(1).optional().default("default"),
  tradingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  force: z.boolean().optional().default(false),
  autoContinue: z.boolean().optional().default(true),
});

const patternCandidatePatternLengthsSchema = z.array(z.number().int().min(10).max(160)).min(1).max(12);

export const patternProfilePatchSchema = z.object({
  profileId: z.string().trim().min(1).optional().default("default"),
  minPrice: z.number().min(0).max(10_000).optional(),
  minDollarVolume20d: z.number().min(0).max(10_000_000_000).optional(),
  minBars: z.number().int().min(60).max(2_000).optional(),
  candidateLimit: z.number().int().min(1).max(500).optional(),
  matchScoreThreshold: z.number().min(0).max(1).optional(),
  contextWindowBars: z.number().int().min(60).max(520).optional(),
  candidatePatternLengths: patternCandidatePatternLengthsSchema.optional(),
}).refine((value) => Object.keys(value).some((key) => key !== "profileId"), {
  message: "Provide at least one pattern profile setting to update.",
});

export const patternCandidatesQuerySchema = z.object({
  profileId: z.string().trim().min(1).optional().default("default"),
  scope: z.enum(["matched", "all"]).optional().default("matched"),
  reviewed: z.enum(["exclude", "include"]).optional().default("exclude"),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  runId: z.string().trim().min(1).nullable().optional(),
});

export const patternFeaturePatchSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

export const watchlistReviewRunCreateSchema = z.object({
  run: z.record(z.unknown()).optional().default({}),
  candidates: z.array(z.record(z.unknown())).max(1000).optional().default([]),
  prepId: z.string().trim().min(1).max(160).nullable().optional(),
  watchlistSetId: z.string().trim().min(1).max(160).nullable().optional(),
  watchlistRunId: z.string().trim().min(1).max(160).nullable().optional(),
}).refine((value) => value.candidates.length > 0, {
  message: "Provide at least one watchlist review candidate.",
});

export const watchlistReviewCandidatePatchSchema = z.object({
  action: z.enum([
    "approve",
    "skip",
    "keep_current",
    "move_red",
    "move_blue",
    "move_yellow_orange",
    "unflag_remove",
    "note",
  ]),
  userNote: z.string().trim().max(2000).nullable().optional(),
  removalReason: z.string().trim().max(1000).nullable().optional(),
  destructiveConfirmed: z.boolean().optional().default(false),
  approvedBy: z.string().trim().min(1).max(120).nullable().optional(),
});

export const watchlistReviewBatchSchema = z.object({
  candidateIds: z.array(z.string().trim().min(1).max(180)).max(500).optional(),
  destructiveConfirmed: z.boolean().optional().default(false),
  approvedBy: z.string().trim().min(1).max(120).nullable().optional(),
});

export const watchlistReviewExportSchema = z.object({
  destructiveConfirmed: z.boolean().optional().default(false),
  approvedBy: z.string().trim().min(1).max(120).nullable().optional(),
});

export const watchlistReviewReadyToApplySchema = watchlistReviewExportSchema.extend({
  retryWebhook: z.boolean().optional().default(false),
});

export const watchlistReviewApplyStatusSchema = z.object({
  runId: z.string().trim().min(1).max(180).optional(),
  dispatchId: z.string().trim().min(1).max(180).nullable().optional(),
  claimOwner: z.string().trim().min(1).max(180).nullable().optional(),
  approvalRevision: z.number().int().min(0),
  checksum: z.string().trim().min(16).max(160),
  idempotencyKey: z.string().trim().min(16).max(400),
  status: z.enum(["claimed", "applying", "applied", "failed", "partial_failed"]),
  startedAt: z.string().trim().max(120).nullable().optional(),
  completedAt: z.string().trim().max(120).nullable().optional(),
  summary: z.record(z.unknown()).nullable().optional(),
  results: z.array(z.object({
    candidateId: z.string().trim().min(1).max(180).nullable().optional(),
    ticker: z.string().trim().min(1).max(40).nullable().optional(),
    requestedAction: z.string().trim().max(120).nullable().optional(),
    status: z.enum(["applied", "failed", "skipped"]),
    message: z.string().trim().max(1000).nullable().optional(),
  })).max(1000).optional(),
  rollbackArtifact: z.record(z.unknown()).nullable().optional(),
  error: z.string().trim().max(1000).nullable().optional(),
});

const watchlistReviewPrepSymbolSchema = z.string()
  .trim()
  .min(1)
  .max(40)
  .transform((value) => value.toUpperCase());

export const watchlistReviewPrepCreateSchema = z.object({
  source: z.string().trim().min(1).max(80).default("watchlist-compiler"),
  sourceSetId: z.string().trim().min(1).max(160).nullable().optional(),
  sourceSetName: z.string().trim().min(1).max(240).nullable().optional(),
  watchlistName: z.string().trim().min(1).max(240).nullable().optional(),
  watchlistRunId: z.string().trim().min(1).max(160).nullable().optional(),
  symbols: z.array(watchlistReviewPrepSymbolSchema).min(1).max(1000),
  lookbackBars: z.number().int().min(60).max(520).optional().default(260),
  refreshIfStale: z.boolean().optional().default(true),
  providerPreference: z.literal("app-default").optional(),
});

export const watchlistReviewDispatchClaimSchema = z.object({
  claimOwner: z.string().trim().min(1).max(180),
  leaseSeconds: z.number().int().min(60).max(3600).optional().default(600),
  approvalRevision: z.number().int().min(0),
  checksum: z.string().trim().min(16).max(160),
  idempotencyKey: z.string().trim().min(16).max(400),
});

export const watchlistReviewDispatchConfirmationRequestedSchema = z.object({
  claimOwner: z.string().trim().min(1).max(180),
  leaseSeconds: z.number().int().min(60).max(3600).optional().default(600),
  channel: z.literal("telegram").optional().default("telegram"),
  summary: z.record(z.unknown()).optional().default({}),
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
  tickers: z.array(z.string().min(1).transform((v) => v.toUpperCase())).max(100).optional().default([]),
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

export const adminSymbolAddSchema = z.object({
  ticker: z.string().min(1).transform((v) => v.toUpperCase()),
});

export const adminSymbolCatalogSyncSchema = z.object({});

export const adminSymbolCatalogScheduleSchema = z.object({
  enabled: z.boolean(),
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
  factorConfig: z.unknown().optional(),
});

export const watchlistSetPatchSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  compileDaily: z.boolean().optional(),
  dailyCompileTimeLocal: localTimeSchema.nullable().optional(),
  dailyCompileTimezone: timezoneStringSchema.nullable().optional(),
  factorConfig: z.unknown().optional(),
});

export const watchlistFactorConfigPatchSchema = z.object({
  factorConfig: z.unknown(),
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

const scanTypeSchema = z.enum(["tradingview", "relative-strength", "vcp"]);
const rsMaTypeSchema = z.enum(["SMA", "EMA"]);
const rsOutputModeSchema = z.enum(["all", "rs_new_high_only", "rs_new_high_before_price_only", "both"]);
const benchmarkTickerSchema = z.preprocess(
  (value) => value === null ? undefined : value,
  z.string().trim().min(1).max(20).optional().transform((value) => value?.toUpperCase()),
);

const scanPresetBaseFieldsSchema = z.object({
  name: z.string().min(1),
  scanType: scanTypeSchema.optional().default("tradingview"),
  isDefault: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
  rules: z.array(scanPresetRuleSchema).optional().default([]),
  prefilterRules: z.array(scanPresetRuleSchema).optional().default([]),
  benchmarkTicker: benchmarkTickerSchema,
  verticalOffset: z.number().finite().min(0.25).max(500).optional().default(30),
  rsMaLength: z.number().int().min(1).max(250).optional().default(21),
  rsMaType: rsMaTypeSchema.optional().default("EMA"),
  newHighLookback: z.number().int().min(1).max(520).optional().default(252),
  outputMode: rsOutputModeSchema.optional().default("all"),
  vcpDailyPivotLookback: z.number().int().min(5).max(520).optional().default(100),
  vcpWeeklyHighLookback: z.number().int().min(5).max(260).optional().default(100),
  vcpPivotAgeBars: z.number().int().min(1).max(120).optional().default(10),
  vcpDailyNearPct: z.number().finite().min(0.1).max(50).optional().default(7),
  vcpWeeklyNearPct: z.number().finite().min(0.1).max(80).optional().default(20),
  sortField: z.string().min(1).optional().default("change"),
  sortDirection: z.enum(["asc", "desc"]).optional().default("desc"),
  rowLimit: z.number().int().min(1).max(250).optional().default(100),
});

const scanPresetCreateValidatedSchema = scanPresetBaseFieldsSchema.superRefine((value, ctx) => {
  if (value.scanType === "relative-strength" || value.scanType === "vcp") {
    if (value.prefilterRules.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prefilterRules"],
        message: "Add at least one prefilter rule before saving this scan preset.",
      });
    }
    return;
  }
  if (value.rules.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rules"],
      message: "Add at least one scan rule before saving.",
    });
  }
});

export const scanPresetCreateSchema = scanPresetCreateValidatedSchema;

export const scanPresetPatchSchema = scanPresetBaseFieldsSchema.partial().superRefine((value, ctx) => {
  if ((value.scanType === "relative-strength" || value.scanType === "vcp") && value.prefilterRules && value.prefilterRules.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["prefilterRules"],
      message: "Add at least one prefilter rule before saving this scan preset.",
    });
  }
  if ((value.scanType === undefined || value.scanType === "tradingview") && value.rules && value.rules.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rules"],
      message: "Add at least one scan rule before saving.",
    });
  }
});

const scanCompilePresetIdsSchema = z.array(z.string().min(1)).min(1, "Choose at least one scan preset.");

export const scanCompilePresetCreateSchema = z.object({
  name: z.string().min(1),
  scanPresetIds: scanCompilePresetIdsSchema,
});

export const scanCompilePresetPatchSchema = z.object({
  name: z.string().min(1).optional(),
  scanPresetIds: scanCompilePresetIdsSchema.optional(),
});

export const scanRefreshSchema = z.object({
  presetId: z.string().min(1).nullable().optional(),
});

export const scannerCacheRsCacheBackfillSchema = z.object({
  table: z.enum([
    "rs_ratio_cache",
    "relative_strength_latest_cache",
    "relative_strength_config_state",
    "all",
  ]).optional().default("all"),
  cursor: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(1000).optional().default(250),
});

export const correlationLookbackSchema = z.enum(["60D", "120D", "252D", "2Y", "5Y"]);
export const correlationRollingWindowSchema = z.enum(["20D", "60D", "120D"]);

const correlationTickerTokenSchema = z.string().regex(/^[A-Z.\-^]{1,20}$/, "Tickers must be comma-separated symbols like AAPL, MSFT, SPY.");

const parseCorrelationTickers = (value: string): string[] =>
  Array.from(new Set(
    value
      .split(/[,\s;\n\r\t]+/)
      .map((token) => token.trim().toUpperCase())
      .filter(Boolean),
  ));

export const correlationTickersCsvSchema = z.string().transform((value, ctx) => {
  const tickers = parseCorrelationTickers(value);
  if (tickers.length < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Enter at least 2 tickers.",
    });
    return z.NEVER;
  }
  if (tickers.length > 10) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Correlation analysis supports up to 10 tickers per run.",
    });
    return z.NEVER;
  }
  const invalid = tickers.find((ticker) => !correlationTickerTokenSchema.safeParse(ticker).success);
  if (invalid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unsupported ticker format: ${invalid}`,
    });
    return z.NEVER;
  }
  return tickers;
});

function lookbackSupportsRollingWindow(lookback: z.infer<typeof correlationLookbackSchema>, rollingWindow: z.infer<typeof correlationRollingWindowSchema>): boolean {
  const lookbackPeriods = {
    "60D": 60,
    "120D": 120,
    "252D": 252,
    "2Y": 504,
    "5Y": 1260,
  } as const;
  const rollingPeriods = {
    "20D": 20,
    "60D": 60,
    "120D": 120,
  } as const;
  return rollingPeriods[rollingWindow] <= lookbackPeriods[lookback];
}

export const correlationMatrixQuerySchema = z.object({
  tickers: correlationTickersCsvSchema,
  lookback: correlationLookbackSchema.optional().default("252D"),
});

export const correlationPairQuerySchema = z.object({
  left: z.string().trim().transform((value) => value.toUpperCase()).pipe(correlationTickerTokenSchema),
  right: z.string().trim().transform((value) => value.toUpperCase()).pipe(correlationTickerTokenSchema),
  lookback: correlationLookbackSchema.optional().default("252D"),
  rollingWindow: correlationRollingWindowSchema.optional().default("60D"),
}).superRefine((value, ctx) => {
  if (value.left === value.right) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["right"],
      message: "Choose 2 different tickers.",
    });
  }
  if (!lookbackSupportsRollingWindow(value.lookback, value.rollingWindow)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rollingWindow"],
      message: "Rolling window cannot be larger than the selected lookback.",
    });
  }
});
