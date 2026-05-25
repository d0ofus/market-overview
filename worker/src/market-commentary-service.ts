import { loadSnapshot } from "./eod";
import { getFedWatchSnapshot } from "./fedwatch-service";
import { getUsMarketSessionContext, type UsMarketSessionContext } from "./market-calendar";
import { parseLocalTime, zonedParts } from "./refresh-timing";
import type { Env, SnapshotResponse } from "./types";

export type MarketCommentaryStatus = "ready" | "failed";

export type MarketCommentarySourceAudit = {
  sourceName: string;
  url: string | null;
  dataUsed: string;
  timestamp: string | null;
  note?: string | null;
};

export type MarketCommentaryDataQuality = {
  metric: string;
  status: "ok" | "stale" | "unavailable" | "not_configured";
  note: string;
};

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

type BraveSearchResult = {
  title: string;
  url: string;
  description: string | null;
  source: string | null;
  publishedAt: string | null;
};

type MarketEvidence = {
  session: UsMarketSessionContext;
  dashboardSummary: string;
  fedWatchSummary: string;
  searchSummary: string;
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

const GEMINI_PROVIDER = "gemini";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
const DEFAULT_RETENTION_DAYS = 30;
const REFRESH_GUARD_MS = 10 * 60_000;
const DEFAULT_SETTINGS_ID = "default";
const DEFAULT_COMMENTARY_SCHEDULE_TIMEZONE = "Australia/Melbourne";
const DEFAULT_COMMENTARY_SCHEDULE_TIME = "09:00";
const DEFAULT_COMMENTARY_SCHEDULE_DAYS = ["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
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
  "US stock market today S&P 500 Nasdaq Dow Russell sector performance {nyDate} Reuters CNBC MarketWatch",
  "US economic calendar today Fed speakers Treasury auctions CPI PPI PCE GDP jobs ISM {nyDate}",
  "CBOE VIX put call ratio market volatility today {nyDate}",
  "US stocks earnings catalysts mega cap tech semiconductors banks energy today {nyDate}",
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

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function boolFromDb(value: number | null | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return Number(value) === 1;
}

function isMarketCommentarySettingsSchemaMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.toLowerCase().includes("market_commentary_settings");
}

function normalizeSourceAuditRows(rows: MarketCommentarySourceAudit[]): MarketCommentarySourceAudit[] {
  return rows
    .map((row) => ({
      sourceName: String(row.sourceName ?? "").trim(),
      url: row.url == null || String(row.url).trim() === "" ? null : String(row.url).trim(),
      dataUsed: String(row.dataUsed ?? "").trim(),
      timestamp: row.timestamp == null || String(row.timestamp).trim() === "" ? null : String(row.timestamp).trim(),
      note: row.note == null || String(row.note).trim() === "" ? null : String(row.note).trim(),
    }))
    .filter((row) => row.sourceName && row.dataUsed);
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

async function loadReadyReportForSession(env: Env, sessionDate: string): Promise<MarketCommentaryReport | null> {
  const row = await env.DB.prepare(
    "SELECT id, session_date as sessionDate, as_of as asOf, market_session as marketSession, market_session_label as marketSessionLabel, data_basis as dataBasis, provider, model, status, report_markdown as reportMarkdown, source_audit_json as sourceAuditJson, data_quality_json as dataQualityJson, error_message as errorMessage, created_at as createdAt, updated_at as updatedAt FROM market_commentary_reports WHERE session_date = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1",
  ).bind(sessionDate).first<MarketCommentaryRow>();
  return row ? normalizeRow(row) : null;
}

async function insertMarketCommentaryReport(
  env: Env,
  input: Omit<MarketCommentaryReport, "id" | "generatedAt">,
  nowIso: string,
): Promise<MarketCommentaryReport> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO market_commentary_reports (id, session_date, as_of, market_session, market_session_label, data_basis, provider, model, status, report_markdown, source_audit_json, data_quality_json, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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

  for (const section of snapshot.sections.filter((s) => s.title.includes("Macro") || s.title.includes("Equities"))) {
    lines.push(`Section: ${section.title}`);
    for (const group of section.groups) {
      const rows = group.rows.slice(0, 12).map((row) => {
        const sma = [
          row.above20Sma == null ? "20SMA N/A" : row.above20Sma ? "above 20SMA" : "below 20SMA",
          row.above50Sma == null ? "50SMA N/A" : row.above50Sma ? "above 50SMA" : "below 50SMA",
          row.above200Sma == null ? "200SMA N/A" : row.above200Sma ? "above 200SMA" : "below 200SMA",
        ].join(", ");
        return `${row.ticker} (${row.displayName ?? row.ticker}): price ${row.price}, 1D ${row.change1d?.toFixed?.(2) ?? row.change1d}%, 1W ${row.change1w?.toFixed?.(2) ?? row.change1w}%, YTD ${row.ytd?.toFixed?.(2) ?? row.ytd}%, ${sma}`;
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

async function braveSearch(apiKey: string, query: string): Promise<BraveSearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "5");
  url.searchParams.set("country", "us");
  url.searchParams.set("search_lang", "en");
  url.searchParams.set("freshness", "pd");
  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });
  if (!response.ok) {
    throw new Error(`Brave Search failed with HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
        profile?: { name?: string };
        age?: string;
      }>;
    };
  };
  return (payload.web?.results ?? [])
    .filter((result) => result.url && result.title)
    .map((result) => ({
      title: String(result.title),
      url: String(result.url),
      description: result.description ? String(result.description).replace(/<[^>]+>/g, "") : null,
      source: result.profile?.name ? String(result.profile.name) : null,
      publishedAt: result.age ? String(result.age) : null,
    }));
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
    const batches = await Promise.all(searchQueriesFor(session, settings).map(async (query) => ({ query, results: await braveSearch(apiKey, query) })));
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

async function gatherMarketEvidence(env: Env, session: UsMarketSessionContext, settings: MarketCommentarySettings): Promise<MarketEvidence> {
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
    snapshot = await loadSnapshot(env);
    sourceAudit.push({
      sourceName: "Market Command dashboard snapshot",
      url: null,
      dataUsed: "Cached index, ETF, sector, and technical snapshot from the existing application",
      timestamp: snapshot.generatedAt,
    });
    dataQuality.push({ metric: "Existing dashboard snapshot", status: "ok", note: `Loaded snapshot as of ${snapshot.asOfDate}.` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dashboard snapshot load failed.";
    dataQuality.push({ metric: "Existing dashboard snapshot", status: "unavailable", note: message });
  }

  const fedWatchSummary = await summarizeFedWatch(env, dataQuality, sourceAudit);
  const searchSummary = await summarizeSearch(env, session, settings, dataQuality, sourceAudit);

  return {
    session,
    dashboardSummary: summarizeDashboard(snapshot, session),
    fedWatchSummary,
    searchSummary,
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
    "DATA QUALITY NOTES",
    JSON.stringify(evidence.dataQuality, null, 2),
    "",
    "SOURCE AUDIT INPUTS",
    JSON.stringify(evidence.sourceAudit, null, 2),
  ].join("\n");
}

async function generateWithGemini(env: Env, prompt: string): Promise<{ text: string; sources: MarketCommentarySourceAudit[] }> {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");

  const model = env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const groundingEnabled = env.GEMINI_SEARCH_GROUNDING_ENABLED?.trim().toLowerCase() === "true";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ...(groundingEnabled ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 24000,
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gemini request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }

  const payload = await response.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: {
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      };
    }>;
  };
  const candidate = payload.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("").trim() ?? "";
  if (!text) throw new Error("Gemini returned an empty report.");

  const sources = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((chunk): MarketCommentarySourceAudit | null => {
      const uri = chunk.web?.uri;
      if (!uri) return null;
      return {
        sourceName: chunk.web?.title ?? "Gemini Google Search grounding",
        url: uri,
        dataUsed: "Gemini grounding citation",
        timestamp: null,
      };
    })
    .filter((source): source is MarketCommentarySourceAudit => Boolean(source));

  return { text, sources };
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

export function shouldRunScheduledMarketCommentary(settings: MarketCommentarySettings, now = new Date()): boolean {
  if (!settings.enabled || !settings.scheduleEnabled) return false;
  const target = parseLocalTime(settings.scheduleLocalTime);
  if (!target) return false;
  const local = zonedParts(now, settings.scheduleTimezone);
  const weekday = WEEKDAY_LONG_BY_SHORT[local.weekday] ?? local.weekday;
  if (!settings.scheduleDays.includes(weekday)) return false;
  const targetMinutes = target.hour * 60 + target.minute;
  return local.minutesOfDay >= targetMinutes && local.minutesOfDay < targetMinutes + 15;
}

export async function maybeRunScheduledMarketCommentary(env: Env, now = new Date()): Promise<MarketCommentaryResponse | null> {
  const settings = await loadMarketCommentarySettings(env);
  if (!shouldRunScheduledMarketCommentary(settings, now)) return null;
  const session = getUsMarketSessionContext(now);
  const existingReady = await loadReadyReportForSession(env, session.sessionDate);
  if (existingReady) {
    return {
      status: "ready",
      warning: `Scheduled commentary skipped; a ready report already exists for ${session.sessionDate}.`,
      report: existingReady,
    };
  }
  return await refreshMarketCommentary(env, { now, force: true, trigger: "scheduled", settings });
}

export async function refreshMarketCommentary(env: Env, options?: { now?: Date; force?: boolean; trigger?: "manual" | "scheduled"; settings?: MarketCommentarySettings }): Promise<MarketCommentaryResponse> {
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
  if (!options?.force && recent && Date.parse(nowIso) - Date.parse(recent.generatedAt) < REFRESH_GUARD_MS) {
    return {
      status: recent.status,
      warning: `Using the latest commentary generated at ${recent.generatedAt}; refresh is guarded for 10 minutes to control LLM/search usage.`,
      report: recent,
    };
  }

  await pruneMarketCommentaryReports(env, parseRetentionDays(env), now);

  let evidence: MarketEvidence | null = null;
  try {
    if (!env.GEMINI_API_KEY?.trim()) {
      throw new Error("GEMINI_API_KEY is not configured.");
    }
    evidence = await gatherMarketEvidence(env, session, settings);
    const result = await generateWithGemini(env, buildPrompt(evidence, settings));
    const report = await insertMarketCommentaryReport(env, {
      sessionDate: session.sessionDate,
      asOf: session.nowIso,
      marketSession: session.status,
      marketSessionLabel: session.label,
      dataBasis: session.dataBasis,
      provider: GEMINI_PROVIDER,
      model,
      status: "ready",
      reportMarkdown: result.text,
      sourceAudit: [...evidence.sourceAudit, ...result.sources],
      dataQuality: evidence.dataQuality,
      error: null,
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
    }, nowIso);
    return { status: "failed", warning: message, report };
  }
}
