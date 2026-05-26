import { parseLocalTime, zonedParts } from "./refresh-timing";
import type { Env } from "./types";

export const CRON_TIMEZONE_OPTIONS = [
  { label: "Melbourne", value: "Australia/Melbourne" },
  { label: "Sydney", value: "Australia/Sydney" },
  { label: "Singapore", value: "Asia/Singapore" },
  { label: "New York", value: "America/New_York" },
] as const;

export const WEEKDAY_OPTIONS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export type CronJobFieldType = "boolean" | "number" | "time" | "timezone" | "weekdays" | "select";
export type CronJobValue = boolean | number | string | string[] | null;
export type CronJobValues = Record<string, CronJobValue>;

export type CronJobField = {
  key: string;
  label: string;
  type: CronJobFieldType;
  helper?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ label: string; value: string }>;
};

export type AdminCronJob = {
  key: string;
  label: string;
  category: string;
  description: string;
  kind: "local-time" | "window" | "interval" | "runtime" | "watchlist-set";
  cadence: string;
  fixedCronExpression: string;
  values: CronJobValues;
  fields: CronJobField[];
  meta?: Record<string, unknown>;
};

export type CentralCronJobDefinition = {
  key: string;
  label: string;
  category: string;
  description: string;
  kind: AdminCronJob["kind"];
  defaults: CronJobValues;
  fields: CronJobField[];
  cadence: (values: CronJobValues) => string;
};

type CronJobSettingsRow = {
  key: string;
  valuesJson: string | null;
};

const ENABLED_FIELD: CronJobField = {
  key: "enabled",
  label: "Enabled",
  type: "boolean",
};

const TIMEZONE_FIELD: CronJobField = {
  key: "timezone",
  label: "Timezone",
  type: "timezone",
  options: [...CRON_TIMEZONE_OPTIONS],
};

const LOCAL_TIME_FIELD: CronJobField = {
  key: "localTime",
  label: "Local time",
  type: "time",
};

const DAYS_FIELD: CronJobField = {
  key: "days",
  label: "Days",
  type: "weekdays",
};

const INTERVAL_FIELD: CronJobField = {
  key: "intervalMinutes",
  label: "Minimum interval (minutes)",
  type: "number",
  min: 15,
  max: 10_080,
  step: 15,
};

const BATCH_LIMIT_FIELD: CronJobField = {
  key: "batchLimit",
  label: "Batch limit",
  type: "number",
  min: 1,
  max: 100,
  step: 1,
};

const RETENTION_FIELD: CronJobField = {
  key: "retentionDays",
  label: "Retention days",
  type: "number",
  min: 1,
  max: 365,
  step: 1,
};

const WINDOW_START_FIELD: CronJobField = {
  key: "windowStartLocal",
  label: "Window start",
  type: "time",
};

const WINDOW_END_FIELD: CronJobField = {
  key: "windowEndLocal",
  label: "Window end",
  type: "time",
};

const DEFAULT_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const;
const DEFAULT_ALL_DAYS = [...WEEKDAY_OPTIONS];

function minutesLabel(value: unknown): string {
  const minutes = Math.max(1, Number(value ?? 0) || 0);
  if (minutes % (24 * 60) === 0) return `Every ${minutes / (24 * 60)} day${minutes === 24 * 60 ? "" : "s"}`;
  if (minutes % 60 === 0) return `Every ${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `Every ${minutes} minutes`;
}

function localTimeCadence(values: CronJobValues): string {
  const days = Array.isArray(values.days) ? values.days.join(", ") : "selected days";
  return `${values.localTime} ${values.timezone} on ${days}`;
}

export const CENTRAL_CRON_JOB_DEFINITIONS: CentralCronJobDefinition[] = [
  {
    key: "overview-eod",
    label: "Overview EOD Refresh",
    category: "Market/Data",
    description: "Runs the dashboard snapshot refresh after the configured local time for the previous US session.",
    kind: "local-time",
    defaults: { enabled: true },
    fields: [ENABLED_FIELD, TIMEZONE_FIELD, LOCAL_TIME_FIELD],
    cadence: (values) => `${values.localTime} ${values.timezone} (previous US close)`,
  },
  {
    key: "earnings-calendar",
    label: "Earnings Calendar Sync",
    category: "Earnings/Fundamentals",
    description: "Refreshes upcoming earnings events from configured providers.",
    kind: "interval",
    defaults: { enabled: true, intervalMinutes: 1_200 },
    fields: [ENABLED_FIELD, INTERVAL_FIELD],
    cadence: (values) => minutesLabel(values.intervalMinutes),
  },
  {
    key: "earnings-surprises",
    label: "Earnings Surprise Sync",
    category: "Earnings/Fundamentals",
    description: "Syncs provider-reported earnings surprises during the post-market overnight window.",
    kind: "window",
    defaults: {
      enabled: true,
      timezone: "America/New_York",
      windowStartLocal: "21:00",
      windowEndLocal: "05:59",
      intervalMinutes: 1_200,
    },
    fields: [ENABLED_FIELD, TIMEZONE_FIELD, WINDOW_START_FIELD, WINDOW_END_FIELD, INTERVAL_FIELD],
    cadence: (values) => `${values.windowStartLocal}-${values.windowEndLocal} ${values.timezone}; ${minutesLabel(values.intervalMinutes).toLowerCase()}`,
  },
  {
    key: "earnings-gaps",
    label: "Earnings Gap Scan",
    category: "Earnings/Fundamentals",
    description: "Runs the daily earnings gap scan after the selected local time.",
    kind: "local-time",
    defaults: { enabled: true, timezone: "America/New_York", localTime: "20:00", days: [...DEFAULT_WEEKDAYS] },
    fields: [ENABLED_FIELD, TIMEZONE_FIELD, LOCAL_TIME_FIELD, DAYS_FIELD],
    cadence: localTimeCadence,
  },
  {
    key: "earnings-fundamentals-refresh",
    label: "Due Earnings Fundamentals",
    category: "Earnings/Fundamentals",
    description: "Processes earnings events whose SEC/companyfacts refresh is due.",
    kind: "runtime",
    defaults: { enabled: true, batchLimit: 5 },
    fields: [ENABLED_FIELD, { ...BATCH_LIMIT_FIELD, max: 10 }],
    cadence: (values) => `Every heartbeat when due; up to ${values.batchLimit} events`,
  },
  {
    key: "fundamentals-seed-queue",
    label: "Fundamentals Seed Queue",
    category: "Earnings/Fundamentals",
    description: "Processes queued SEC fundamentals seed work.",
    kind: "runtime",
    defaults: { enabled: true, batchLimit: 10 },
    fields: [ENABLED_FIELD, { ...BATCH_LIMIT_FIELD, max: 10 }],
    cadence: (values) => `Every heartbeat when due; up to ${values.batchLimit} tickers`,
  },
  {
    key: "etf-constituent-slice",
    label: "ETF Constituent Slice",
    category: "Market/Data",
    description: "Refreshes a small stale slice of ETF constituent data per worker tick.",
    kind: "runtime",
    defaults: { enabled: true, staleDays: 14, batchLimit: 5 },
    fields: [
      ENABLED_FIELD,
      { key: "staleDays", label: "Stale after days", type: "number", min: 1, max: 90, step: 1 },
      { ...BATCH_LIMIT_FIELD, max: 25 },
    ],
    cadence: (values) => `Every heartbeat; ${values.batchLimit} stale ETFs after ${values.staleDays} days`,
  },
  {
    key: "research-queue",
    label: "Research Queue Advancement",
    category: "Queue/Maintenance",
    description: "Advances queued research runs in small slices.",
    kind: "runtime",
    defaults: { enabled: true, batchLimit: 2 },
    fields: [ENABLED_FIELD, { ...BATCH_LIMIT_FIELD, max: 10 }],
    cadence: (values) => `Every heartbeat; up to ${values.batchLimit} runs`,
  },
  {
    key: "alerts-housekeeping",
    label: "Alerts Cleanup/Reconcile",
    category: "Queue/Maintenance",
    description: "Prunes old TradingView alert records and optionally reconciles mailbox adapters.",
    kind: "interval",
    defaults: { enabled: true, intervalMinutes: 360, retentionDays: 30, reconcileEnabled: false },
    fields: [
      ENABLED_FIELD,
      INTERVAL_FIELD,
      RETENTION_FIELD,
      { key: "reconcileEnabled", label: "Run mailbox reconcile", type: "boolean" },
    ],
    cadence: (values) => `${minutesLabel(values.intervalMinutes)}; keep ${values.retentionDays} days`,
  },
  {
    key: "social-alerts-housekeeping",
    label: "Social Alerts Cleanup",
    category: "Queue/Maintenance",
    description: "Prunes old social alert scrape logs and orphaned post links.",
    kind: "interval",
    defaults: { enabled: true, intervalMinutes: 360, retentionDays: 10 },
    fields: [ENABLED_FIELD, INTERVAL_FIELD, { ...RETENTION_FIELD, max: 30 }],
    cadence: (values) => `${minutesLabel(values.intervalMinutes)}; keep ${values.retentionDays} days`,
  },
  {
    key: "scanning-housekeeping",
    label: "Scanning Cleanup",
    category: "Queue/Maintenance",
    description: "Prunes short-lived scanning runs and rows.",
    kind: "interval",
    defaults: { enabled: true, intervalMinutes: 360, retentionDays: 1 },
    fields: [ENABLED_FIELD, INTERVAL_FIELD, { ...RETENTION_FIELD, max: 30 }],
    cadence: (values) => `${minutesLabel(values.intervalMinutes)}; keep ${values.retentionDays} day${Number(values.retentionDays) === 1 ? "" : "s"}`,
  },
  {
    key: "scans-page-housekeeping",
    label: "Scans Page Cleanup",
    category: "Queue/Maintenance",
    description: "Prunes old scans-page refresh jobs and snapshots.",
    kind: "interval",
    defaults: { enabled: true, intervalMinutes: 360, retentionDays: 7 },
    fields: [ENABLED_FIELD, INTERVAL_FIELD, { ...RETENTION_FIELD, max: 90 }],
    cadence: (values) => `${minutesLabel(values.intervalMinutes)}; keep ${values.retentionDays} days`,
  },
  {
    key: "gappers-housekeeping",
    label: "Gappers Cleanup",
    category: "Queue/Maintenance",
    description: "Prunes short-lived gappers snapshots and rows.",
    kind: "interval",
    defaults: { enabled: true, intervalMinutes: 360, retentionDays: 1 },
    fields: [ENABLED_FIELD, INTERVAL_FIELD, { ...RETENTION_FIELD, max: 30 }],
    cadence: (values) => `${minutesLabel(values.intervalMinutes)}; keep ${values.retentionDays} day${Number(values.retentionDays) === 1 ? "" : "s"}`,
  },
];

export function centralCronDefinitionByKey(key: string): CentralCronJobDefinition | null {
  return CENTRAL_CRON_JOB_DEFINITIONS.find((definition) => definition.key === key) ?? null;
}

function parseJsonObject(raw: string | null | undefined): CronJobValues {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as CronJobValues : {};
  } catch {
    return {};
  }
}

function isMissingCronTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.toLowerCase().includes("cron_job_settings");
}

async function ensureCronJobSettingsTable(env: Env): Promise<void> {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS cron_job_settings (key TEXT PRIMARY KEY, values_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  ).run();
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(text)) return true;
    if (["false", "0", "no", "off"].includes(text)) return false;
  }
  return fallback;
}

function coerceNumber(value: unknown, field: CronJobField, fallback: number): number {
  const parsed = Number(value);
  const base = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  const min = field.min ?? Number.MIN_SAFE_INTEGER;
  const max = field.max ?? Number.MAX_SAFE_INTEGER;
  return Math.max(min, Math.min(max, base));
}

function isValidTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value.trim());
}

function isSupportedTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeWeekdays(value: unknown, fallback: string[]): string[] {
  const allowed = new Set<string>(WEEKDAY_OPTIONS);
  const raw = Array.isArray(value) ? value : [];
  const normalized = raw.map((item) => String(item ?? "").trim()).filter((item) => allowed.has(item));
  return normalized.length ? Array.from(new Set(normalized)) : fallback;
}

function normalizeValues(definition: CentralCronJobDefinition, raw: CronJobValues): CronJobValues {
  const out: CronJobValues = { ...definition.defaults };
  for (const field of definition.fields) {
    const fallback = definition.defaults[field.key];
    const value = raw[field.key];
    if (field.type === "boolean") out[field.key] = coerceBoolean(value, Boolean(fallback));
    if (field.type === "number") out[field.key] = coerceNumber(value, field, Number(fallback ?? 0));
    if (field.type === "time") out[field.key] = isValidTime(value) ? value.trim() : String(fallback ?? "00:00");
    if (field.type === "timezone") out[field.key] = isSupportedTimezone(value) ? value.trim() : String(fallback ?? "Australia/Melbourne");
    if (field.type === "weekdays") out[field.key] = normalizeWeekdays(value, Array.isArray(fallback) ? fallback.map(String) : [...DEFAULT_ALL_DAYS]);
    if (field.type === "select") out[field.key] = typeof value === "string" && value.trim() ? value.trim() : String(fallback ?? "");
  }
  return out;
}

export function mergeCentralCronValues(key: string, raw: CronJobValues): CronJobValues {
  const definition = centralCronDefinitionByKey(key);
  if (!definition) throw new Error(`Unknown cron job: ${key}`);
  return normalizeValues(definition, { ...definition.defaults, ...raw });
}

export async function loadCentralCronJobSettings(env: Env, key: string): Promise<CronJobValues> {
  const definition = centralCronDefinitionByKey(key);
  if (!definition) throw new Error(`Unknown cron job: ${key}`);
  try {
    await ensureCronJobSettingsTable(env);
    const row = await env.DB.prepare("SELECT key, values_json as valuesJson FROM cron_job_settings WHERE key = ? LIMIT 1")
      .bind(key)
      .first<CronJobSettingsRow>();
    return normalizeValues(definition, { ...definition.defaults, ...parseJsonObject(row?.valuesJson) });
  } catch (error) {
    if (isMissingCronTableError(error)) return normalizeValues(definition, definition.defaults);
    throw error;
  }
}

export async function loadCentralCronJobSettingsMap(env: Env): Promise<Map<string, CronJobValues>> {
  const definitions = CENTRAL_CRON_JOB_DEFINITIONS;
  const out = new Map<string, CronJobValues>();
  definitions.forEach((definition) => out.set(definition.key, normalizeValues(definition, definition.defaults)));
  try {
    await ensureCronJobSettingsTable(env);
    const placeholders = definitions.map(() => "?").join(", ");
    const rows = await env.DB.prepare(`SELECT key, values_json as valuesJson FROM cron_job_settings WHERE key IN (${placeholders})`)
      .bind(...definitions.map((definition) => definition.key))
      .all<CronJobSettingsRow>();
    for (const row of rows.results ?? []) {
      const definition = centralCronDefinitionByKey(row.key);
      if (!definition) continue;
      out.set(row.key, normalizeValues(definition, { ...definition.defaults, ...parseJsonObject(row.valuesJson) }));
    }
  } catch (error) {
    if (!isMissingCronTableError(error)) throw error;
  }
  return out;
}

export async function updateCentralCronJobSettings(env: Env, key: string, patch: CronJobValues): Promise<CronJobValues> {
  const current = await loadCentralCronJobSettings(env, key);
  const next = mergeCentralCronValues(key, { ...current, ...patch });
  await ensureCronJobSettingsTable(env);
  await env.DB.prepare(
    "INSERT INTO cron_job_settings (key, values_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET values_json = excluded.values_json, updated_at = CURRENT_TIMESTAMP",
  )
    .bind(key, JSON.stringify(next))
    .run();
  return next;
}

export function centralCronJobToAdminJob(definition: CentralCronJobDefinition, values: CronJobValues, fixedCronExpression: string): AdminCronJob {
  return {
    key: definition.key,
    label: definition.label,
    category: definition.category,
    description: definition.description,
    kind: definition.kind,
    cadence: definition.cadence(values),
    fixedCronExpression,
    values,
    fields: definition.fields,
  };
}

function weekdayLong(shortOrLong: string): string {
  const map: Record<string, string> = {
    Mon: "Monday",
    Tue: "Tuesday",
    Wed: "Wednesday",
    Thu: "Thursday",
    Fri: "Friday",
    Sat: "Saturday",
    Sun: "Sunday",
  };
  return map[shortOrLong] ?? shortOrLong;
}

function valuesEnabled(values: CronJobValues): boolean {
  return coerceBoolean(values.enabled, true);
}

export function cronNumber(values: CronJobValues, key: string, fallback: number): number {
  const value = Number(values[key] ?? fallback);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function cronString(values: CronJobValues, key: string, fallback: string): string {
  const value = values[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function isCentralCronEnabled(values: CronJobValues): boolean {
  return valuesEnabled(values);
}

export function hasCentralCronIntervalElapsed(lastIso: string | null | undefined, values: CronJobValues, fallbackMinutes: number, now = new Date()): boolean {
  if (!valuesEnabled(values)) return false;
  if (!lastIso) return true;
  const last = Date.parse(lastIso);
  if (!Number.isFinite(last)) return true;
  const intervalMinutes = Math.max(1, cronNumber(values, "intervalMinutes", fallbackMinutes));
  return now.getTime() - last >= intervalMinutes * 60_000;
}

export function shouldRunCentralCronLocalTime(now: Date, values: CronJobValues, fallback: { timezone: string; localTime: string; days?: string[] }): boolean {
  if (!valuesEnabled(values)) return false;
  const timezone = cronString(values, "timezone", fallback.timezone);
  const localTime = cronString(values, "localTime", fallback.localTime);
  const target = parseLocalTime(localTime);
  if (!target) return false;
  const local = zonedParts(now, timezone);
  const allowedDays = normalizeWeekdays(values.days, fallback.days ?? [...DEFAULT_ALL_DAYS]);
  if (!allowedDays.includes(weekdayLong(local.weekday))) return false;
  const targetMinutes = target.hour * 60 + target.minute;
  return local.minutesOfDay >= targetMinutes && local.minutesOfDay < targetMinutes + 15;
}

export function isCentralCronWindowOpen(now: Date, values: CronJobValues, fallback: { timezone: string; start: string; end: string; days?: string[] }): boolean {
  if (!valuesEnabled(values)) return false;
  const timezone = cronString(values, "timezone", fallback.timezone);
  const start = parseLocalTime(cronString(values, "windowStartLocal", fallback.start));
  const end = parseLocalTime(cronString(values, "windowEndLocal", fallback.end));
  if (!start || !end) return false;
  const local = zonedParts(now, timezone);
  const allowedDays = normalizeWeekdays(values.days, fallback.days ?? [...DEFAULT_ALL_DAYS]);
  if (!allowedDays.includes(weekdayLong(local.weekday))) return false;
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;
  if (startMinutes <= endMinutes) {
    return local.minutesOfDay >= startMinutes && local.minutesOfDay <= endMinutes;
  }
  return local.minutesOfDay >= startMinutes || local.minutesOfDay <= endMinutes;
}
