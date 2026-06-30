import { loadSnapshot } from "./eod";
import { getFedWatchSnapshot } from "./fedwatch-service";
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_PROVIDER,
  cachedBraveSearch,
  generateMarkdownWithGemini,
  normalizeSourceAuditRows,
  parseJsonArray,
  sanitizeInternalSourceMarkdownLinks,
  sourceCitationPolicyPrompt,
  type MarketReportDataQuality,
  type MarketReportSourceAudit,
} from "./market-report-common";
import { getUsMarketSessionContext, type UsMarketSessionContext } from "./market-calendar";
import { parseLocalTime, zonedParts } from "./refresh-timing";
import {
  loadCompiledScansSnapshotForCompilePreset,
  loadScanCompilePresetByName,
  refreshScanCompilePreset,
  type CompiledScansSnapshot,
  type CompiledScanUniqueTickerRow,
  type ScanCompilePresetRefreshResult,
} from "./scans-page-service";
import type { Env, SnapshotResponse } from "./types";

export type MarketCommentaryStatus = "ready" | "failed";
type MarketCommentaryGenerationTrigger = "manual" | "scheduled";

export type MarketCommentarySourceAudit = MarketReportSourceAudit;
export type MarketCommentaryDataQuality = MarketReportDataQuality;

export type MarketCommentaryReport = {
  id: string;
  sessionDate: string;
  asOf: string;
  generatedAt: string;
  marketSession: UsMarketSessionContext["status"];
  marketSessionLabel: string;
  dataBasis: UsMarketSessionContext["dataBasis"];
  provider: string;
  model: string;
  status: MarketCommentaryStatus;
  reportMarkdown: string;
  sourceAudit: MarketCommentarySourceAudit[];
  dataQuality: MarketCommentaryDataQuality[];
  error: string | null;
};

export type MarketCommentaryResponse = {
  status: "empty" | MarketCommentaryStatus;
  warning: string | null;
  report: MarketCommentaryReport | null;
};

type MarketCommentaryRow = {
  id: string;
  sessionDate: string;
  asOf: string;
  marketSession: UsMarketSessionContext["status"];
  marketSessionLabel: string;
  dataBasis: UsMarketSessionContext["dataBasis"];
  provider: string;
  model: string;
  status: MarketCommentaryStatus;
  reportMarkdown: string;
  sourceAuditJson: string;
  dataQualityJson: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

type MarketCommentaryScheduleDecision = {
  due: boolean;
  localDate: string | null;
  timezone: string;
  localTime: string;
};

type MarketEvidence = {
  session: UsMarketSessionContext;
  dashboardSummary: string;
  fedWatchSummary: string;
  searchSummary: string;
  compiledScanSummary: string;
  sourceAudit: MarketCommentarySourceAudit[];
  dataQuality: MarketCommentaryDataQuality[];
};

export type MarketCommentarySettings = {
  id: string;
  enabled: boolean;
  systemPromptTemplate: string;
  staticSources: MarketCommentarySourceAudit[];
  braveQueries: string[];
  scheduleEnabled: boolean;
  scheduleTimezone: string;
  scheduleLocalTime: string;
  scheduleDays: string[];
  createdAt: string | null;
  updatedAt: string | null;
};

type MarketCommentarySettingsRow = {
  id: string;
  enabled: number | null;
  systemPromptTemplate: string | null;
  staticSourcesJson: string | null;
  braveQueriesJson: string | null;
  scheduleEnabled: number | null;
  scheduleTimezone: string | null;
  scheduleLocalTime: string | null;
  scheduleDaysJson: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type MarketCommentarySettingsPatch = Omit<MarketCommentarySettings, "createdAt" | "updatedAt">;

const DEFAULT_RETENTION_DAYS = 30;
const REFRESH_GUARD_MS = 10 * 60_000;
const DEFAULT_SETTINGS_ID = "default";
const DEFAULT_COMMENTARY_SCHEDULE_TIMEZONE = "Australia/Melbourne";
const DEFAULT_COMMENTARY_SCHEDULE_TIME = "09:00";
const DEFAULT_COMMENTARY_SCHEDULE_DAYS = ["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MARKET_COMMENTARY_GEMINI_TIMEOUT_MS = 180_000;
const MARKET_COMMENTARY_MAX_OUTPUT_TOKENS = 16000;
const MARKET_COMMENTARY_MIN_MARKDOWN_LENGTH = 1200;
let marketCommentaryReportScheduleSchemaReady = false;
let marketCommentaryScheduleAttemptSchemaReady = false;
const WEEKDAY_LONG_BY_SHORT: Record<string, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};

export const DEFAULT_MARKET_COMMENTARY_STATIC_SOURCES: MarketCommentarySourceAudit[] = [
  {
    sourceName: "NYSE holiday calendar",
    url: "https://www.nyse.com/markets/hours-calendars",
    dataUsed: "US cash equity market holiday/session validation",
    timestamp: null,
  },
  {
    sourceName: "CBOE",
    url: "https://www.cboe.com/tradable_products/vix/",
    dataUsed: "VIX and volatility reference source for the report prompt",
    timestamp: null,
  },
  {
    sourceName: "U.S. Treasury",
    url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
    dataUsed: "Treasury yield reference source for the report prompt",
    timestamp: null,
  },
  {
    sourceName: "BLS",
    url: "https://www.bls.gov/bls/news-release/home.htm",
    dataUsed: "Official US labor and inflation release reference source",
    timestamp: null,
  },
  {
    sourceName: "BEA",
    url: "https://www.bea.gov/news/schedule",
    dataUsed: "Official US GDP, PCE, and income/spending release reference source",
    timestamp: null,
  },
  {
    sourceName: "Federal Reserve",
    url: "https://www.federalreserve.gov/newsevents.htm",
    dataUsed: "Federal Reserve speeches, policy, and calendar reference source",
    timestamp: null,
  },
];

export const DEFAULT_MARKET_COMMENTARY_BRAVE_QUERIES = [
  "US stock market today S&P 500 Nasdaq Dow Russell sector performance {latestCompletedSessionDate} Reuters CNBC MarketWatch",
  "US economic calendar Fed speakers Treasury auctions CPI PPI PCE GDP jobs ISM {latestCompletedSessionDate}",
  "CBOE VIX put call ratio market volatility today {latestCompletedSessionDate}",
  "US stocks earnings catalysts mega cap tech semiconductors banks energy today {latestCompletedSessionDate}",
];

export const DEFAULT_MARKET_COMMENTARY_PROMPT = `
You are an institutional-quality US market strategist, macro analyst, technical analyst, and swing-trading research assistant.

Produce a daily "US Market State of Play" report for a US equity swing trader with a typical holding period of 2 days to 6 weeks.

Hard rules:
- Use only the evidence packet and cited sources provided below.
- Do not fabricate unavailable data. If a metric is missing, write "N/A" and briefly explain where it was checked.
- Distinguish confirmed facts, interpretation, and trading implications.
- Every major factual claim must include a source name or source link.
- Focus on what changed versus the prior session where the evidence supports it.
- Do not provide personalized financial advice. Frame output as market commentary and risk analysis.
- Use exact dates and state whether the report is closing-data, intraday, pre-market, or closed-market based.
- If US cash equities are closed for a holiday/weekend, clearly say so and use the most recent completed trading session for closing data.
- Synthesize the evidence packet instead of enumerating every source. If a source, section, or scan row is not important to the session, omit it rather than reporting for completeness.
- Do not include sections or source summaries just because data exists. Focus the report on what changed, what matters, and what traders are likely paying attention to.

Report title:
"US Market State of Play - [DATE]"

Use this structure exactly:
1. EXECUTIVE SUMMARY
2. MARKET HEALTH SCORE
3. MAJOR INDEX SNAPSHOT
4. FIXED INCOME, DOLLAR & COMMODITIES
5. ECONOMIC DATA RELEASED TODAY
6. FED, CENTRAL BANKS & RATE EXPECTATIONS
7. FISCAL, POLICY, POLITICAL & GEOPOLITICAL RISKS
8. SECTOR & INDUSTRY PERFORMANCE
9. MARKET BREADTH & INTERNALS
10. PRICE ACTION & TECHNICAL ANALYSIS
11. VIX, VOLATILITY & OPTIONS
12. SENTIMENT & POSITIONING
13. EARNINGS & SINGLE-STOCK CATALYSTS
14. FORWARD CALENDAR
15. SWING TRADER PLAYBOOK
16. WHAT CHANGED VERSUS YESTERDAY
17. FINAL MARKET VIEW
18. SOURCE AUDIT

Style:
- Clean headings, short paragraphs, bullets, and markdown tables where useful.
- Use the symbols 🟢, 🔴, and 🟡 sparingly and consistently.
- Bold the most important takeaways.
- Keep it detailed but scannable.
- End section 17 with: "Bottom line: [one clear sentence summarizing the current market regime and trading posture]."
`.trim();

export const DEFAULT_MARKET_COMMENTARY_SETTINGS: MarketCommentarySettings = {
  id: DEFAULT_SETTINGS_ID,
  enabled: true,
  systemPromptTemplate: DEFAULT_MARKET_COMMENTARY_PROMPT,
  staticSources: DEFAULT_MARKET_COMMENTARY_STATIC_SOURCES,
  braveQueries: DEFAULT_MARKET_COMMENTARY_BRAVE_QUERIES,
  scheduleEnabled: true,
  scheduleTimezone: DEFAULT_COMMENTARY_SCHEDULE_TIMEZONE,
  scheduleLocalTime: DEFAULT_COMMENTARY_SCHEDULE_TIME,
  scheduleDays: DEFAULT_COMMENTARY_SCHEDULE_DAYS,
  createdAt: null,
  updatedAt: null,
};

function parseRetentionDays(env: Env): number {
  const raw = Number(env.MARKET_COMMENTARY_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  if (!Number.isFinite(raw)) return DEFAULT_RETENTION_DAYS;
  return Math.max(1, Math.min(365, Math.floor(raw)));
}

function boolFromDb(value: number | null | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return Number(value) === 1;
}

function isMarketCommentarySettingsSchemaMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.toLowerCase().includes("market_commentary_settings");
}

function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.toLowerCase().includes("duplicate column name");
}

async function addMarketCommentaryReportColumn(env: Env, sql: string): Promise<void> {
  try {
    await env.DB.prepare(sql).run();
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
  }
}

async function ensureMarketCommentaryReportScheduleSchema(env: Env): Promise<void> {
  if (marketCommentaryReportScheduleSchemaReady) return;
  await addMarketCommentaryReportColumn(
    env,
    "ALTER TABLE market_commentary_reports ADD COLUMN generation_trigger TEXT NOT NULL DEFAULT 'manual'",
  );
  await addMarketCommentaryReportColumn(
    env,
    "ALTER TABLE market_commentary_reports ADD COLUMN scheduled_local_date TEXT",
  );
  await addMarketCommentaryReportColumn(
    env,
    "ALTER TABLE market_commentary_reports ADD COLUMN scheduled_timezone TEXT",
  );
  await addMarketCommentaryReportColumn(
    env,
    "ALTER TABLE market_commentary_reports ADD COLUMN scheduled_local_time TEXT",
  );
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_market_commentary_scheduled_attempt ON market_commentary_reports (generation_trigger, scheduled_local_date, session_date, created_at DESC)",
  ).run();
  marketCommentaryReportScheduleSchemaReady = true;
}

type MarketCommentaryScheduleAttemptStatus = "skipped" | "running" | "ready" | "failed";

async function ensureMarketCommentaryScheduleAttemptSchema(env: Env): Promise<void> {
  if (marketCommentaryScheduleAttemptSchemaReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS market_commentary_schedule_attempts (
      id TEXT PRIMARY KEY,
      scheduled_local_date TEXT NOT NULL,
      session_date TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      report_id TEXT,
      scheduled_timezone TEXT,
      scheduled_local_time TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_market_commentary_schedule_attempts_latest ON market_commentary_schedule_attempts (scheduled_local_date, session_date, updated_at DESC)",
  ).run();
  marketCommentaryScheduleAttemptSchemaReady = true;
}

async function recordMarketCommentaryScheduleAttempt(
  env: Env,
  input: {
    scheduledLocalDate: string;
    sessionDate: string;
    status: MarketCommentaryScheduleAttemptStatus;
    reason?: string | null;
    reportId?: string | null;
    scheduledTimezone?: string | null;
    scheduledLocalTime?: string | null;
  },
): Promise<void> {
  try {
    await ensureMarketCommentaryScheduleAttemptSchema(env);
    await env.DB.prepare(
      `INSERT INTO market_commentary_schedule_attempts (
         id, scheduled_local_date, session_date, status, reason, report_id, scheduled_timezone, scheduled_local_time, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
      .bind(
        crypto.randomUUID(),
        input.scheduledLocalDate,
        input.sessionDate,
        input.status,
        input.reason ?? null,
        input.reportId ?? null,
        input.scheduledTimezone ?? null,
        input.scheduledLocalTime ?? null,
      )
      .run();
  } catch (error) {
    console.error("scheduled market commentary attempt log failed", error);
  }
}

function normalizeBraveQueries(rows: string[]): string[] {
  return rows.map((row) => String(row ?? "").trim()).filter(Boolean);
}

function normalizeScheduleDays(rows: string[]): string[] {
  const allowed = new Set(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
  return rows.map((row) => String(row ?? "").trim()).filter((row) => allowed.has(row));
}

function mapSettingsRow(row: MarketCommentarySettingsRow | null): MarketCommentarySettings {
  if (!row) return { ...DEFAULT_MARKET_COMMENTARY_SETTINGS };
  const staticSources = normalizeSourceAuditRows(parseJsonArray<MarketCommentarySourceAudit>(row.staticSourcesJson));
  const braveQueries = normalizeBraveQueries(parseJsonArray<string>(row.braveQueriesJson));
  const scheduleDays = normalizeScheduleDays(parseJsonArray<string>(row.scheduleDaysJson));
  return {
    id: row.id || DEFAULT_SETTINGS_ID,
    enabled: boolFromDb(row.enabled, DEFAULT_MARKET_COMMENTARY_SETTINGS.enabled),
    systemPromptTemplate: row.systemPromptTemplate?.trim() || DEFAULT_MARKET_COMMENTARY_PROMPT,
    staticSources: staticSources.length ? staticSources : DEFAULT_MARKET_COMMENTARY_STATIC_SOURCES,
    braveQueries: braveQueries.length ? braveQueries : DEFAULT_MARKET_COMMENTARY_BRAVE_QUERIES,
    scheduleEnabled: boolFromDb(row.scheduleEnabled, DEFAULT_MARKET_COMMENTARY_SETTINGS.scheduleEnabled),
    scheduleTimezone: row.scheduleTimezone?.trim() || DEFAULT_COMMENTARY_SCHEDULE_TIMEZONE,
    scheduleLocalTime: row.scheduleLocalTime?.trim() || DEFAULT_COMMENTARY_SCHEDULE_TIME,
    scheduleDays: scheduleDays.length ? scheduleDays : DEFAULT_COMMENTARY_SCHEDULE_DAYS,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

export async function loadMarketCommentarySettings(env: Env): Promise<MarketCommentarySettings> {
  try {
    const row = await env.DB.prepare(
      `SELECT
         id,
         enabled,
         system_prompt_template as systemPromptTemplate,
         static_sources_json as staticSourcesJson,
         brave_queries_json as braveQueriesJson,
         schedule_enabled as scheduleEnabled,
         schedule_timezone as scheduleTimezone,
         schedule_local_time as scheduleLocalTime,
         schedule_days_json as scheduleDaysJson,
         created_at as createdAt,
         updated_at as updatedAt
       FROM market_commentary_settings
       WHERE id = ?
       LIMIT 1`,
    )
      .bind(DEFAULT_SETTINGS_ID)
      .first<MarketCommentarySettingsRow>();
    return mapSettingsRow(row ?? null);
  } catch (error) {
    if (isMarketCommentarySettingsSchemaMissing(error)) {
      return { ...DEFAULT_MARKET_COMMENTARY_SETTINGS };
    }
    throw error;
  }
}

export async function updateMarketCommentarySettings(
  env: Env,
  input: MarketCommentarySettingsPatch,
): Promise<MarketCommentarySettings> {
  const normalized: MarketCommentarySettingsPatch = {
    id: input.id?.trim() || DEFAULT_SETTINGS_ID,
    enabled: Boolean(input.enabled),
    systemPromptTemplate: input.systemPromptTemplate.trim(),
    staticSources: normalizeSourceAuditRows(input.staticSources),
    braveQueries: normalizeBraveQueries(input.braveQueries),
    scheduleEnabled: Boolean(input.scheduleEnabled),
    scheduleTimezone: input.scheduleTimezone.trim(),
    scheduleLocalTime: input.scheduleLocalTime.trim(),
    scheduleDays: normalizeScheduleDays(input.scheduleDays),
  };
  await env.DB.prepare(
    `INSERT INTO market_commentary_settings
      (id, enabled, system_prompt_template, static_sources_json, brave_queries_json, schedule_enabled, schedule_timezone, schedule_local_time, schedule_days_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled,
       system_prompt_template = excluded.system_prompt_template,
       static_sources_json = excluded.static_sources_json,
       brave_queries_json = excluded.brave_queries_json,
       schedule_enabled = excluded.schedule_enabled,
       schedule_timezone = excluded.schedule_timezone,
       schedule_local_time = excluded.schedule_local_time,
       schedule_days_json = excluded.schedule_days_json,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      normalized.id,
      normalized.enabled ? 1 : 0,
      normalized.systemPromptTemplate,
      JSON.stringify(normalized.staticSources),
      JSON.stringify(normalized.braveQueries),
      normalized.scheduleEnabled ? 1 : 0,
      normalized.scheduleTimezone,
      normalized.scheduleLocalTime,
      JSON.stringify(normalized.scheduleDays),
    )
    .run();
  return await loadMarketCommentarySettings(env);
}

export async function resetMarketCommentarySettings(env: Env): Promise<MarketCommentarySettings> {
  return await updateMarketCommentarySettings(env, DEFAULT_MARKET_COMMENTARY_SETTINGS);
}

function normalizeRow(row: MarketCommentaryRow): MarketCommentaryReport {
  return {
    id: row.id,
    sessionDate: row.sessionDate,
    asOf: row.asOf,
    generatedAt: row.createdAt,
    marketSession: row.marketSession,
    marketSessionLabel: row.marketSessionLabel,
    dataBasis: row.dataBasis,
    provider: row.provider,
    model: row.model,
    status: row.status,
    reportMarkdown: row.reportMarkdown,
    sourceAudit: parseJsonArray<MarketCommentarySourceAudit>(row.sourceAuditJson),
    dataQuality: parseJsonArray<MarketCommentaryDataQuality>(row.dataQualityJson),
    error: row.errorMessage ?? null,
  };
}

export async function loadLatestMarketCommentary(env: Env): Promise<MarketCommentaryResponse> {
  const row = await env.DB.prepare(
    "SELECT id, session_date as sessionDate, as_of as asOf, market_session as marketSession, market_session_label as marketSessionLabel, data_basis as dataBasis, provider, model, status, report_markdown as reportMarkdown, source_audit_json as sourceAuditJson, data_quality_json as dataQualityJson, error_message as errorMessage, created_at as createdAt, updated_at as updatedAt FROM market_commentary_reports ORDER BY session_date DESC, created_at DESC LIMIT 1",
  ).first<MarketCommentaryRow>();

  if (!row) {
    return {
      status: "empty",
      warning: "No market commentary report has been generated yet.",
      report: null,
    };
  }

  return {
    status: row.status,
    warning: row.status === "failed" ? row.errorMessage : null,
    report: normalizeRow(row),
  };
}

export async function pruneMarketCommentaryReports(env: Env, retentionDays = parseRetentionDays(env), now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60_000).toISOString();
  const result = await env.DB.prepare("DELETE FROM market_commentary_reports WHERE created_at < ?").bind(cutoff).run();
  return Number(result.meta?.rows_written ?? 0);
}

async function loadRecentReportForSession(env: Env, sessionDate: string): Promise<MarketCommentaryReport | null> {
  const row = await env.DB.prepare(
    "SELECT id, session_date as sessionDate, as_of as asOf, market_session as marketSession, market_session_label as marketSessionLabel, data_basis as dataBasis, provider, model, status, report_markdown as reportMarkdown, source_audit_json as sourceAuditJson, data_quality_json as dataQualityJson, error_message as errorMessage, created_at as createdAt, updated_at as updatedAt FROM market_commentary_reports WHERE session_date = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(sessionDate).first<MarketCommentaryRow>();
  return row ? normalizeRow(row) : null;
}

async function loadReadyScheduledReportForAttempt(env: Env, scheduledLocalDate: string, sessionDate: string): Promise<MarketCommentaryReport | null> {
  await ensureMarketCommentaryReportScheduleSchema(env);
  const row = await env.DB.prepare(
    "SELECT id, session_date as sessionDate, as_of as asOf, market_session as marketSession, market_session_label as marketSessionLabel, data_basis as dataBasis, provider, model, status, report_markdown as reportMarkdown, source_audit_json as sourceAuditJson, data_quality_json as dataQualityJson, error_message as errorMessage, created_at as createdAt, updated_at as updatedAt FROM market_commentary_reports WHERE generation_trigger = 'scheduled' AND status = 'ready' AND scheduled_local_date = ? AND session_date = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(scheduledLocalDate, sessionDate).first<MarketCommentaryRow>();
  return row ? normalizeRow(row) : null;
}

function overviewSnapshotDateForSession(session: UsMarketSessionContext): string {
  return session.dataBasis === "pre_market" ? session.latestCompletedSessionDate : session.sessionDate;
}

async function overviewSnapshotReadyForSession(env: Env, sessionDate: string): Promise<boolean> {
  try {
    const snapshot = await loadSnapshot(env, "default", sessionDate, { allowComputeOnMissing: false });
    return snapshot.status !== "empty" && snapshot.asOfDate === sessionDate;
  } catch (error) {
    console.error("scheduled market commentary snapshot readiness check failed", error);
    return false;
  }
}

async function assertFreshOverviewSnapshotForSession(env: Env, sessionDate: string): Promise<SnapshotResponse> {
  const snapshot = await loadSnapshot(env, "default", sessionDate, { allowComputeOnMissing: false });
  if (snapshot.status === "empty") {
    throw new Error(`Overview snapshot for ${sessionDate} is not available; market commentary was not generated.`);
  }
  if (snapshot.freshnessStatus === "stale") {
    throw new Error(snapshot.freshnessWarning ?? `Overview market data is stale for ${sessionDate}; market commentary was not generated.`);
  }
  return snapshot;
}

async function insertMarketCommentaryReport(
  env: Env,
  input: Omit<MarketCommentaryReport, "id" | "generatedAt"> & {
    generationTrigger?: MarketCommentaryGenerationTrigger;
    scheduledLocalDate?: string | null;
    scheduledTimezone?: string | null;
    scheduledLocalTime?: string | null;
  },
  nowIso: string,
): Promise<MarketCommentaryReport> {
  const id = crypto.randomUUID();
  await ensureMarketCommentaryReportScheduleSchema(env);
  await env.DB.prepare(
    "INSERT INTO market_commentary_reports (id, session_date, as_of, market_session, market_session_label, data_basis, provider, model, status, report_markdown, source_audit_json, data_quality_json, error_message, generation_trigger, scheduled_local_date, scheduled_timezone, scheduled_local_time, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      input.sessionDate,
      input.asOf,
      input.marketSession,
      input.marketSessionLabel,
      input.dataBasis,
      input.provider,
      input.model,
      input.status,
      input.reportMarkdown,
      JSON.stringify(input.sourceAudit),
      JSON.stringify(input.dataQuality),
      input.error,
      input.generationTrigger ?? "manual",
      input.scheduledLocalDate ?? null,
      input.scheduledTimezone ?? null,
      input.scheduledLocalTime ?? null,
      nowIso,
      nowIso,
    )
    .run();

  return {
    id,
    generatedAt: nowIso,
    ...input,
  };
}

function summarizeDashboard(snapshot: SnapshotResponse | null, session: UsMarketSessionContext): string {
  if (!snapshot) {
    return "Dashboard snapshot: N/A. Existing app snapshot could not be loaded.";
  }

  const lines: string[] = [
    `Existing app snapshot as of ${snapshot.asOfDate}, generated ${snapshot.generatedAt}, provider ${snapshot.providerLabel}.`,
    `Current report session date: ${session.sessionDate}. Latest completed US session: ${session.latestCompletedSessionDate}.`,
  ];
  if (snapshot.freshnessStatus === "partial") {
    lines.push(
      `Data quality warning: snapshot coverage is partial (${snapshot.freshnessCurrentCount ?? 0}/${snapshot.freshnessEligibleCount ?? 0} tickers current). Treat only rows tagged current for ${session.sessionDate} as current-market evidence; stale or unknown rows are included only for audit context.`,
    );
  }

  for (const section of snapshot.sections.filter((s) => s.title.includes("Macro") || s.title.includes("Equities"))) {
    lines.push(`Section: ${section.title}`);
    for (const group of section.groups) {
      const rows = group.rows.slice(0, 12).map((row) => {
        const sma = [
          row.above20Sma == null ? "20SMA N/A" : row.above20Sma ? "above 20SMA" : "below 20SMA",
          row.above50Sma == null ? "50SMA N/A" : row.above50Sma ? "above 50SMA" : "below 50SMA",
          row.above200Sma == null ? "200SMA N/A" : row.above200Sma ? "above 200SMA" : "below 200SMA",
        ].join(", ");
        const rowDate = row.barDate ?? "unknown";
        const rowFreshness = row.barDate === session.sessionDate ? `current ${session.sessionDate}` : `stale/unknown bar ${rowDate}`;
        return `${row.ticker} (${row.displayName ?? row.ticker}): ${rowFreshness}, price ${row.price}, 1D ${row.change1d?.toFixed?.(2) ?? row.change1d}%, 1W ${row.change1w?.toFixed?.(2) ?? row.change1w}%, YTD ${row.ytd?.toFixed?.(2) ?? row.ytd}%, ${sma}`;
      });
      lines.push(`- ${group.title}: ${rows.length ? rows.join("; ") : "N/A"}`);
    }
  }

  return lines.join("\n");
}

async function summarizeFedWatch(env: Env, dataQuality: MarketCommentaryDataQuality[], sourceAudit: MarketCommentarySourceAudit[]): Promise<string> {
  try {
    const fedWatch = await getFedWatchSnapshot(env);
    if (!fedWatch.data) {
      dataQuality.push({
        metric: "FedWatch",
        status: fedWatch.status === "unavailable" ? "unavailable" : "stale",
        note: fedWatch.warning ?? "FedWatch data was unavailable from the configured provider.",
      });
      return `FedWatch: N/A. ${fedWatch.warning ?? "Configured provider returned no usable data."}`;
    }

    sourceAudit.push({
      sourceName: "RateProbability FedWatch snapshot",
      url: fedWatch.data.sourceUrl,
      dataUsed: "Fed funds path, current band, meeting probabilities, and comparison series",
      timestamp: fedWatch.data.generatedAt,
      note: fedWatch.warning,
    });
    dataQuality.push({
      metric: "FedWatch",
      status: fedWatch.status === "ok" ? "ok" : "stale",
      note: fedWatch.warning ?? "FedWatch snapshot loaded successfully.",
    });

    const rows = fedWatch.data.rows.slice(0, 4).map((row) =>
      `${row.meeting} (${row.meetingIso}): implied ${row.impliedRatePostMeeting.toFixed(2)}%, move probability ${row.probMovePct.toFixed(1)}%, change ${row.changeBps.toFixed(1)} bps`,
    );
    return [
      `FedWatch source ${fedWatch.data.sourceUrl}; generated ${fedWatch.data.generatedAt}; as-of ${fedWatch.data.asOf ?? "N/A"}.`,
      `Current Fed funds band: ${fedWatch.data.currentBand ?? "N/A"}; midpoint ${fedWatch.data.midpoint ?? "N/A"}; most recent EFFR ${fedWatch.data.mostRecentEffr ?? "N/A"}.`,
      rows.join("; "),
    ].join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : "FedWatch load failed.";
    dataQuality.push({ metric: "FedWatch", status: "unavailable", note: message });
    return `FedWatch: N/A. ${message}`;
  }
}

export function renderMarketCommentaryQueryTemplate(template: string, session: UsMarketSessionContext): string {
  return template
    .replaceAll("{nyDate}", session.nyDate)
    .replaceAll("{sessionDate}", session.sessionDate)
    .replaceAll("{latestCompletedSessionDate}", session.latestCompletedSessionDate)
    .replaceAll("{marketStatus}", session.status);
}

function searchQueriesFor(session: UsMarketSessionContext, settings: MarketCommentarySettings): string[] {
  return settings.braveQueries.map((query) => renderMarketCommentaryQueryTemplate(query, session));
}

async function summarizeSearch(env: Env, session: UsMarketSessionContext, settings: MarketCommentarySettings, dataQuality: MarketCommentaryDataQuality[], sourceAudit: MarketCommentarySourceAudit[]): Promise<string> {
  const apiKey = env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) {
    dataQuality.push({
      metric: "Fresh web/news search",
      status: "not_configured",
      note: "BRAVE_SEARCH_API_KEY is not configured; report will rely on existing app data and static official-source references.",
    });
    return "Fresh web/news search: N/A. BRAVE_SEARCH_API_KEY is not configured.";
  }

  try {
    const batches = await Promise.all(searchQueriesFor(session, settings).map(async (query) => ({
      query,
      results: await cachedBraveSearch(env, query, {
        caller: "daily_commentary",
        freshness: "pd",
        timeoutMs: env.BRAVE_SEARCH_TIMEOUT_MS,
        dateBucket: `daily:${session.nyDate}`,
        ttlSeconds: 86400,
      }),
    })));
    const lines: string[] = [];
    let resultCount = 0;
    for (const batch of batches) {
      lines.push(`Query: ${batch.query}`);
      for (const result of batch.results) {
        resultCount += 1;
        sourceAudit.push({
          sourceName: result.source ?? result.title,
          url: result.url,
          dataUsed: `Brave Search result for: ${batch.query}`,
          timestamp: result.publishedAt,
        });
        lines.push(`- ${result.title} (${result.source ?? "source N/A"}): ${result.description ?? "N/A"} URL: ${result.url}`);
      }
    }
    dataQuality.push({
      metric: "Fresh web/news search",
      status: resultCount > 0 ? "ok" : "unavailable",
      note: resultCount > 0 ? `Loaded ${resultCount} Brave Search results.` : "Brave Search returned no usable results.",
    });
    return lines.join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Brave Search failed.";
    dataQuality.push({ metric: "Fresh web/news search", status: "unavailable", note: message });
    return `Fresh web/news search: N/A. ${message}`;
  }
}

const DAILY_ABOVE_200_SMA_SCAN_NAME = "Daily - Above 200 SMA";

function formatMaybePercent(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "N/A" : `${value.toFixed(2)}%`;
}

function formatScanMover(row: CompiledScanUniqueTickerRow): string {
  const industry = [row.sector, row.industry].filter(Boolean).join(" / ") || "sector/industry N/A";
  const presets = row.presetNames.length > 0 ? row.presetNames.join(", ") : "preset N/A";
  const relativeVolume = row.latestRelativeVolume == null ? "rel vol N/A" : `rel vol ${row.latestRelativeVolume.toFixed(2)}x`;
  return `${row.ticker} (${row.name ?? row.ticker}): 1D ${formatMaybePercent(row.latestChange1d)}, ${industry}, occurrences ${row.occurrences}, ${relativeVolume}, presets ${presets}`;
}

function summarizeScanClusters(rows: CompiledScanUniqueTickerRow[]): string[] {
  const clusters = new Map<string, CompiledScanUniqueTickerRow[]>();
  for (const row of rows) {
    const key = [row.sector, row.industry].filter(Boolean).join(" / ") || "Unclassified";
    clusters.set(key, [...(clusters.get(key) ?? []), row]);
  }
  return Array.from(clusters.entries())
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([label, clusterRows]) => {
      const tickers = clusterRows
        .sort((left, right) => (right.latestChange1d ?? Number.NEGATIVE_INFINITY) - (left.latestChange1d ?? Number.NEGATIVE_INFINITY))
        .slice(0, 8)
        .map((row) => `${row.ticker}${row.latestChange1d == null ? "" : ` ${row.latestChange1d.toFixed(2)}%`}`)
        .join(", ");
      return `${label}: ${clusterRows.length} row${clusterRows.length === 1 ? "" : "s"} (${tickers})`;
    });
}

export function summarizeDailyAbove200SmaScanEvidence(
  result: Pick<ScanCompilePresetRefreshResult, "compilePresetId" | "compilePresetName" | "refreshedCount" | "failedCount" | "snapshot" | "memberResults">,
  options?: { usedFallback?: boolean; warning?: string | null },
): string {
  const rows = [...result.snapshot.rows].sort((left, right) => {
    if (right.occurrences !== left.occurrences) return right.occurrences - left.occurrences;
    return (right.latestChange1d ?? Number.NEGATIVE_INFINITY) - (left.latestChange1d ?? Number.NEGATIVE_INFINITY);
  });
  const notableMovers = rows.slice(0, 12).map(formatScanMover);
  const clusters = summarizeScanClusters(rows);
  const failedMembers = result.memberResults
    .filter((member) => member.status === "error" || member.status === "failed" || member.usedFallback)
    .map((member) => `${member.presetName}: ${member.status}${member.usedFallback ? " using fallback" : ""}${member.error ? ` (${member.error})` : ""}`);

  return [
    `Compiled scan: ${result.compilePresetName} (${result.compilePresetId}); generated ${result.snapshot.generatedAt}; rows ${result.snapshot.rows.length}; refreshed members ${result.refreshedCount}; failed members ${result.failedCount}.${options?.usedFallback ? " Used latest usable fallback snapshot." : ""}`,
    options?.warning ? `Refresh warning: ${options.warning}` : null,
    "Use this as trader-attention evidence: notable names in this scan may show which stocks/themes traders are focusing on this session.",
    "Do not infer catalysts from scan membership alone; link movers to broader market themes only when alerts/news/search/dashboard evidence supports it.",
    notableMovers.length > 0 ? `Notable individual movers: ${notableMovers.join("; ")}` : "Notable individual movers: N/A.",
    clusters.length > 0 ? `Sector/industry clusters: ${clusters.join("; ")}` : "Sector/industry clusters: N/A.",
    failedMembers.length > 0 ? `Member warnings: ${failedMembers.join("; ")}` : null,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

async function summarizeDailyAbove200SmaScan(env: Env, dataQuality: MarketCommentaryDataQuality[], sourceAudit: MarketCommentarySourceAudit[]): Promise<string> {
  let compilePresetId: string | null = null;
  try {
    const compilePreset = await loadScanCompilePresetByName(env, DAILY_ABOVE_200_SMA_SCAN_NAME);
    if (!compilePreset) {
      dataQuality.push({
        metric: DAILY_ABOVE_200_SMA_SCAN_NAME,
        status: "not_configured",
        note: `Compiled scan preset named "${DAILY_ABOVE_200_SMA_SCAN_NAME}" was not found; scan evidence omitted.`,
      });
      return `${DAILY_ABOVE_200_SMA_SCAN_NAME}: N/A. Compile preset not found.`;
    }
    compilePresetId = compilePreset.id;
    const result = await refreshScanCompilePreset(env, compilePreset.id);
    sourceAudit.push({
      sourceName: `/scans compiled preset: ${result.compilePresetName}`,
      url: null,
      dataUsed: "Refreshed compiled scan rows for breadth, leadership, and notable trader-attention movers",
      timestamp: result.snapshot.generatedAt,
      note: `Rows ${result.snapshot.rows.length}; refreshed members ${result.refreshedCount}; failed members ${result.failedCount}.`,
    });
    dataQuality.push({
      metric: DAILY_ABOVE_200_SMA_SCAN_NAME,
      status: result.failedCount > 0 ? "stale" : "ok",
      note: result.failedCount > 0
        ? `Refreshed with ${result.failedCount} member failure(s); latest usable fallback rows may be included.`
        : `Refreshed compiled scan successfully with ${result.snapshot.rows.length} unique rows.`,
    });
    return summarizeDailyAbove200SmaScanEvidence(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Compiled scan refresh failed.";
    if (compilePresetId) {
      try {
        const snapshot = await loadCompiledScansSnapshotForCompilePreset(env, compilePresetId);
        const fallbackResult: Pick<ScanCompilePresetRefreshResult, "compilePresetId" | "compilePresetName" | "refreshedCount" | "failedCount" | "snapshot" | "memberResults"> = {
          compilePresetId,
          compilePresetName: snapshot.compilePresetName ?? DAILY_ABOVE_200_SMA_SCAN_NAME,
          refreshedCount: 0,
          failedCount: snapshot.presetIds.length,
          snapshot: snapshot as CompiledScansSnapshot,
          memberResults: [],
        };
        sourceAudit.push({
          sourceName: `/scans compiled preset: ${fallbackResult.compilePresetName}`,
          url: null,
          dataUsed: "Fallback latest usable compiled scan rows after refresh failure",
          timestamp: snapshot.generatedAt,
          note: message,
        });
        dataQuality.push({
          metric: DAILY_ABOVE_200_SMA_SCAN_NAME,
          status: "stale",
          note: `Refresh failed; used latest usable compiled scan snapshot. ${message}`,
        });
        return summarizeDailyAbove200SmaScanEvidence(fallbackResult, { usedFallback: true, warning: message });
      } catch (fallbackError) {
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : "No fallback compiled scan snapshot available.";
        dataQuality.push({
          metric: DAILY_ABOVE_200_SMA_SCAN_NAME,
          status: "unavailable",
          note: `Refresh failed and fallback snapshot unavailable. ${message}; ${fallbackMessage}`,
        });
        return `${DAILY_ABOVE_200_SMA_SCAN_NAME}: N/A. ${message}; ${fallbackMessage}`;
      }
    }
    dataQuality.push({
      metric: DAILY_ABOVE_200_SMA_SCAN_NAME,
      status: "unavailable",
      note: message,
    });
    return `${DAILY_ABOVE_200_SMA_SCAN_NAME}: N/A. ${message}`;
  }
}

async function gatherMarketEvidence(env: Env, session: UsMarketSessionContext, settings: MarketCommentarySettings, snapshotOverride?: SnapshotResponse | null): Promise<MarketEvidence> {
  const sourceAudit = [...settings.staticSources];
  const dataQuality: MarketCommentaryDataQuality[] = [
    {
      metric: "US market session",
      status: "ok",
      note: session.closedReason ?? session.label,
    },
  ];

  let snapshot: SnapshotResponse | null = null;
  try {
    snapshot = snapshotOverride ?? await loadSnapshot(env, "default", session.sessionDate, { allowComputeOnMissing: false });
    sourceAudit.push({
      sourceName: "Market Command dashboard snapshot",
      url: null,
      dataUsed: "Cached index, ETF, sector, and technical snapshot from the existing application",
      timestamp: snapshot.generatedAt,
    });
    const snapshotStatus = snapshot.status === "empty" || snapshot.freshnessStatus === "stale"
      ? "stale"
      : snapshot.freshnessStatus === "partial"
        ? "stale"
        : "ok";
    dataQuality.push({
      metric: "Existing dashboard snapshot",
      status: snapshotStatus,
      note: snapshot.status === "empty"
        ? "Overview snapshot was unavailable."
        : snapshot.freshnessStatus === "partial"
          ? `Loaded partial snapshot as of ${snapshot.asOfDate}; ${snapshot.freshnessCurrentCount ?? 0}/${snapshot.freshnessEligibleCount ?? 0} tickers current. Current-market claims must use only rows with bar date ${session.sessionDate}. ${snapshot.freshnessWarning ?? ""}`.trim()
          : `Loaded snapshot as of ${snapshot.asOfDate}; freshness ${snapshot.freshnessStatus ?? "unknown"} (${snapshot.freshnessCurrentCount ?? 0}/${snapshot.freshnessEligibleCount ?? 0} tickers current).`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dashboard snapshot load failed.";
    dataQuality.push({ metric: "Existing dashboard snapshot", status: "unavailable", note: message });
  }

  const fedWatchSummary = await summarizeFedWatch(env, dataQuality, sourceAudit);
  const searchSummary = await summarizeSearch(env, session, settings, dataQuality, sourceAudit);
  const compiledScanSummary = await summarizeDailyAbove200SmaScan(env, dataQuality, sourceAudit);

  return {
    session,
    dashboardSummary: summarizeDashboard(snapshot, session),
    fedWatchSummary,
    searchSummary,
    compiledScanSummary,
    sourceAudit,
    dataQuality,
  };
}

function buildPrompt(evidence: MarketEvidence, settings: MarketCommentarySettings): string {
  const closedMarketInstruction = evidence.session.status === "closed"
    ? `US cash equity market closed today due to ${evidence.session.closedReason ?? "a non-trading day"}. Keep displaying the most recent completed trading session (${evidence.session.latestCompletedSessionDate}) for closing data.`
    : "US cash equity market is not holiday/weekend closed for the report timestamp.";

  return [
    settings.systemPromptTemplate,
    "",
    "RUN CONTEXT",
    `- Current timestamp: ${evidence.session.nowIso}`,
    `- New York date/time: ${evidence.session.nyDate} ${evidence.session.nyTime} ET`,
    `- Market session status: ${evidence.session.status}`,
    `- Data basis: ${evidence.session.dataBasis}`,
    `- Report session date: ${evidence.session.sessionDate}`,
    `- Latest completed trading session: ${evidence.session.latestCompletedSessionDate}`,
    `- Closed-market instruction: ${closedMarketInstruction}`,
    "",
    "EXISTING APP MARKET DATA",
    evidence.dashboardSummary,
    "",
    "FED / RATE EXPECTATIONS DATA",
    evidence.fedWatchSummary,
    "",
    "FRESH WEB / NEWS SEARCH RESULTS",
    evidence.searchSummary,
    "",
    "COMPILED SCAN EVIDENCE — DAILY ABOVE 200 SMA",
    "Use this as breadth/leadership evidence and as a source of notable individual movers attracting trader attention. Mention scan-derived individual tickers only when they are materially notable, and link them to market themes only when another evidence source supports the link. Omit low-importance scan facts.",
    evidence.compiledScanSummary,
    "",
    "DATA QUALITY NOTES",
    JSON.stringify(evidence.dataQuality, null, 2),
    "",
    sourceCitationPolicyPrompt(),
    "",
    "SOURCE AUDIT INPUTS",
    JSON.stringify(evidence.sourceAudit, null, 2),
  ].join("\n");
}

function assertCompleteMarketCommentaryMarkdown(markdown: string): void {
  const normalized = markdown.toLowerCase();
  const expectedSections = [
    "us market state of play",
    "executive summary",
    "major index",
    "market health",
    "final market view",
  ];
  const matchedSections = expectedSections.filter((section) => normalized.includes(section)).length;
  if (markdown.trim().length < MARKET_COMMENTARY_MIN_MARKDOWN_LENGTH || matchedSections < 3) {
    throw new Error(
      `Gemini returned incomplete market commentary (${markdown.trim().length} chars; matched ${matchedSections}/${expectedSections.length} expected sections).`,
    );
  }
}

function fallbackReport(session: UsMarketSessionContext, message: string): string {
  return [
    `# US Market State of Play - ${session.nyDate}`,
    "",
    `Commentary generation is unavailable: ${message}`,
    "",
    `Market session status: ${session.label}.`,
    "",
    "The rest of the Overview page is unaffected. Configure the Gemini/Brave provider settings or try refreshing again later.",
  ].join("\n");
}

function scheduledMarketCommentaryDecision(settings: MarketCommentarySettings, now = new Date()): MarketCommentaryScheduleDecision {
  const timezone = settings.scheduleTimezone;
  const localTime = settings.scheduleLocalTime;
  if (!settings.enabled || !settings.scheduleEnabled) {
    return { due: false, localDate: null, timezone, localTime };
  }
  const target = parseLocalTime(settings.scheduleLocalTime);
  if (!target) return { due: false, localDate: null, timezone, localTime };
  const local = zonedParts(now, settings.scheduleTimezone);
  const weekday = WEEKDAY_LONG_BY_SHORT[local.weekday] ?? local.weekday;
  if (!settings.scheduleDays.includes(weekday)) {
    return { due: false, localDate: local.localDate, timezone, localTime };
  }
  const targetMinutes = target.hour * 60 + target.minute;
  return {
    due: local.minutesOfDay >= targetMinutes,
    localDate: local.localDate,
    timezone,
    localTime,
  };
}

export function shouldRunScheduledMarketCommentary(settings: MarketCommentarySettings, now = new Date()): boolean {
  return scheduledMarketCommentaryDecision(settings, now).due;
}

export async function maybeRunScheduledMarketCommentary(env: Env, now = new Date()): Promise<MarketCommentaryResponse | null> {
  const settings = await loadMarketCommentarySettings(env);
  const decision = scheduledMarketCommentaryDecision(settings, now);
  if (!decision.due || !decision.localDate) return null;
  const session = getUsMarketSessionContext(now);
  await recordMarketCommentaryScheduleAttempt(env, {
    scheduledLocalDate: decision.localDate,
    sessionDate: session.sessionDate,
    status: "running",
    reason: "Scheduled report due; checking prerequisites.",
    scheduledTimezone: decision.timezone,
    scheduledLocalTime: decision.localTime,
  });
  const existingReadyReport = await loadReadyScheduledReportForAttempt(env, decision.localDate, session.sessionDate);
  if (existingReadyReport) {
    await recordMarketCommentaryScheduleAttempt(env, {
      scheduledLocalDate: decision.localDate,
      sessionDate: session.sessionDate,
      status: "skipped",
      reason: "Ready scheduled report already exists.",
      reportId: existingReadyReport.id,
      scheduledTimezone: decision.timezone,
      scheduledLocalTime: decision.localTime,
    });
    return {
      status: existingReadyReport.status,
      warning: `Scheduled commentary skipped; a scheduled attempt already exists for ${decision.localDate} / ${session.sessionDate}.`,
      report: existingReadyReport,
    };
  }
  const requiredSnapshotDate = overviewSnapshotDateForSession(session);
  if (!(await overviewSnapshotReadyForSession(env, requiredSnapshotDate))) {
    await recordMarketCommentaryScheduleAttempt(env, {
      scheduledLocalDate: decision.localDate,
      sessionDate: session.sessionDate,
      status: "skipped",
      reason: `Overview snapshot for ${requiredSnapshotDate} is not ready.`,
      scheduledTimezone: decision.timezone,
      scheduledLocalTime: decision.localTime,
    });
    return null;
  }
  try {
    const response = await refreshMarketCommentary(env, {
      now,
      force: true,
      trigger: "scheduled",
      settings,
      scheduledLocalDate: decision.localDate,
      scheduledTimezone: decision.timezone,
      scheduledLocalTime: decision.localTime,
    });
    await recordMarketCommentaryScheduleAttempt(env, {
      scheduledLocalDate: decision.localDate,
      sessionDate: session.sessionDate,
      status: response.status === "ready" ? "ready" : "failed",
      reason: response.warning,
      reportId: response.report?.id ?? null,
      scheduledTimezone: decision.timezone,
      scheduledLocalTime: decision.localTime,
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scheduled market commentary failed.";
    await recordMarketCommentaryScheduleAttempt(env, {
      scheduledLocalDate: decision.localDate,
      sessionDate: session.sessionDate,
      status: "failed",
      reason: message,
      scheduledTimezone: decision.timezone,
      scheduledLocalTime: decision.localTime,
    });
    throw error;
  }
}

export async function refreshMarketCommentary(env: Env, options?: {
  now?: Date;
  force?: boolean;
  trigger?: MarketCommentaryGenerationTrigger;
  settings?: MarketCommentarySettings;
  scheduledLocalDate?: string | null;
  scheduledTimezone?: string | null;
  scheduledLocalTime?: string | null;
}): Promise<MarketCommentaryResponse> {
  const now = options?.now ?? new Date();
  const nowIso = now.toISOString();
  const session = getUsMarketSessionContext(now);
  const model = env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const settings = options?.settings ?? await loadMarketCommentarySettings(env);

  if (!settings.enabled) {
    const latest = await loadLatestMarketCommentary(env);
    return {
      ...latest,
      warning: "Market commentary generation is disabled in admin settings.",
    };
  }

  const recent = await loadRecentReportForSession(env, session.sessionDate);
  if (!options?.force && recent && recent.status === "ready" && Date.parse(nowIso) - Date.parse(recent.generatedAt) < REFRESH_GUARD_MS) {
    return {
      status: recent.status,
      warning: `Using the latest commentary generated at ${recent.generatedAt}; refresh is guarded for 10 minutes to control LLM/search usage.`,
      report: recent,
    };
  }

  await pruneMarketCommentaryReports(env, parseRetentionDays(env), now);

  let evidence: MarketEvidence | null = null;
  try {
    const overviewSnapshot = await assertFreshOverviewSnapshotForSession(env, overviewSnapshotDateForSession(session));
    if (!env.GEMINI_API_KEY?.trim()) {
      throw new Error("GEMINI_API_KEY is not configured.");
    }
    evidence = await gatherMarketEvidence(env, session, settings, overviewSnapshot);
    const result = await generateMarkdownWithGemini(env, buildPrompt(evidence, settings), {
      maxOutputTokens: MARKET_COMMENTARY_MAX_OUTPUT_TOKENS,
      timeoutMs: env.MARKET_COMMENTARY_GEMINI_TIMEOUT_MS ?? MARKET_COMMENTARY_GEMINI_TIMEOUT_MS,
    });
    const reportMarkdown = sanitizeInternalSourceMarkdownLinks(result.text, evidence.sourceAudit);
    assertCompleteMarketCommentaryMarkdown(reportMarkdown);
    const report = await insertMarketCommentaryReport(env, {
      sessionDate: session.sessionDate,
      asOf: session.nowIso,
      marketSession: session.status,
      marketSessionLabel: session.label,
      dataBasis: session.dataBasis,
      provider: GEMINI_PROVIDER,
      model,
      status: "ready",
      reportMarkdown,
      sourceAudit: [...evidence.sourceAudit, ...result.sources],
      dataQuality: evidence.dataQuality,
      error: null,
      generationTrigger: options?.trigger ?? "manual",
      scheduledLocalDate: options?.trigger === "scheduled" ? options.scheduledLocalDate ?? null : null,
      scheduledTimezone: options?.trigger === "scheduled" ? options.scheduledTimezone ?? null : null,
      scheduledLocalTime: options?.trigger === "scheduled" ? options.scheduledLocalTime ?? null : null,
    }, nowIso);
    return { status: "ready", warning: null, report };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Market commentary generation failed.";
    const dataQuality = evidence?.dataQuality ?? [
      { metric: "Market commentary generation", status: "unavailable", note: message },
    ];
    if (!dataQuality.some((note) => note.metric === "Market commentary generation")) {
      dataQuality.push({ metric: "Market commentary generation", status: "unavailable", note: message });
    }
    const report = await insertMarketCommentaryReport(env, {
      sessionDate: session.sessionDate,
      asOf: session.nowIso,
      marketSession: session.status,
      marketSessionLabel: session.label,
      dataBasis: session.dataBasis,
      provider: GEMINI_PROVIDER,
      model,
      status: "failed",
      reportMarkdown: fallbackReport(session, message),
      sourceAudit: evidence?.sourceAudit ?? settings.staticSources,
      dataQuality,
      error: message,
      generationTrigger: options?.trigger ?? "manual",
      scheduledLocalDate: options?.trigger === "scheduled" ? options.scheduledLocalDate ?? null : null,
      scheduledTimezone: options?.trigger === "scheduled" ? options.scheduledTimezone ?? null : null,
      scheduledLocalTime: options?.trigger === "scheduled" ? options.scheduledLocalTime ?? null : null,
    }, nowIso);
    return { status: "failed", warning: message, report };
  }
}
