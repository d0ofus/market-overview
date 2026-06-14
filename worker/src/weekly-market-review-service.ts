import { loadSnapshot } from "./eod";
import { getFedWatchSnapshot } from "./fedwatch-service";
import { getUsMarketSessionContext, isUsMarketTradingDay } from "./market-calendar";
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_PROVIDER,
  generateMarkdownWithGemini,
  normalizeSourceAuditRows,
  parseJsonArray,
  parseJsonObject,
  summarizeBraveSearch,
  type MarketReportDataQuality,
  type MarketReportSourceAudit,
} from "./market-report-common";
import { listOverviewFocusItems } from "./overview-focus-service";
import { parseLocalTime, zonedParts } from "./refresh-timing";
import type { Env, SnapshotResponse } from "./types";
import {
  weeklyMarketReviewGenerateSchema,
  weeklyMarketReviewPublishSchema,
} from "./validation";

export type WeeklyMarketReviewGenerationProvider = "hermes_gpt" | "gemini_fallback";
export type WeeklyMarketReviewGenerationMode = "external_publish" | "scheduled_fallback" | "manual_retry";
export type WeeklyMarketReviewStatus = "ready" | "failed";

export type WeeklyMarketReviewKeyTicker = {
  ticker: string;
  companyName?: string | null;
  theme?: string | null;
  impact?: string | null;
  watch?: string | null;
};

export type WeeklyMarketReviewReport = {
  id: string;
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  asOf: string;
  provider: string;
  model: string;
  generationProvider: WeeklyMarketReviewGenerationProvider;
  generationMode: WeeklyMarketReviewGenerationMode;
  status: WeeklyMarketReviewStatus;
  title: string;
  marketTone: string | null;
  reviewMarkdown: string;
  sections: Record<string, unknown>;
  keyTickers: WeeklyMarketReviewKeyTicker[];
  sourceAudit: MarketReportSourceAudit[];
  dataQuality: MarketReportDataQuality[];
  sourceSnapshot: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WeeklyMarketReviewResponse = {
  status: "empty" | WeeklyMarketReviewStatus;
  warning: string | null;
  report: WeeklyMarketReviewReport | null;
};

export type WeeklyMarketReviewGenerateResponse = WeeklyMarketReviewResponse & {
  ok: boolean;
};

export type WeeklyMarketReviewScheduleResult = WeeklyMarketReviewGenerateResponse | null;

type WeeklyMarketReviewWeek = {
  weekStart: string;
  weekEnd: string;
};

type WeeklyMarketReviewRow = {
  id: string;
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  asOf: string;
  provider: string;
  model: string;
  generationProvider: WeeklyMarketReviewGenerationProvider;
  generationMode: WeeklyMarketReviewGenerationMode;
  status: WeeklyMarketReviewStatus;
  title: string;
  marketTone: string | null;
  reviewMarkdown: string;
  sectionsJson: string;
  keyTickersJson: string;
  sourceAuditJson: string;
  dataQualityJson: string;
  sourceSnapshotJson: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

type StoredWeeklyMarketReviewInput = Omit<WeeklyMarketReviewReport, "createdAt" | "updatedAt">;

type WeeklyEvidence = {
  week: WeeklyMarketReviewWeek;
  nowIso: string;
  dashboardSummary: string;
  recentDailyCommentarySummary: string;
  overviewFocusSummary: string;
  sectorFocusSummary: string;
  gappersSummary: string;
  fedWatchSummary: string;
  searchSummary: string;
  sourceAudit: MarketReportSourceAudit[];
  dataQuality: MarketReportDataQuality[];
  sourceSnapshot: Record<string, unknown>;
};

const WEEKLY_REPORT_SELECT = `
  id,
  week_start as weekStart,
  week_end as weekEnd,
  generated_at as generatedAt,
  as_of as asOf,
  provider,
  model,
  generation_provider as generationProvider,
  generation_mode as generationMode,
  status,
  title,
  market_tone as marketTone,
  review_markdown as reviewMarkdown,
  sections_json as sectionsJson,
  key_tickers_json as keyTickersJson,
  source_audit_json as sourceAuditJson,
  data_quality_json as dataQualityJson,
  source_snapshot_json as sourceSnapshotJson,
  error_message as errorMessage,
  created_at as createdAt,
  updated_at as updatedAt
`;

const DEFAULT_WEEKLY_REVIEW_SCHEDULE_TIMEZONE = "Australia/Melbourne";
const DEFAULT_WEEKLY_REVIEW_SCHEDULE_DAY = "Saturday";
const DEFAULT_WEEKLY_REVIEW_SCHEDULE_TIME = "11:00";
const DEFAULT_WEEKLY_REVIEW_HERMES_GRACE_MINUTES = 180;
const WEEKDAY_LONG_BY_SHORT: Record<string, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};
const WEEKDAY_INDEX_BY_LONG: Record<string, number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

const WEEKLY_STATIC_SOURCES: MarketReportSourceAudit[] = [
  {
    sourceName: "NYSE holiday calendar",
    url: "https://www.nyse.com/markets/hours-calendars",
    dataUsed: "US cash equity market holiday/session validation",
    timestamp: null,
  },
  {
    sourceName: "Market Overview app",
    url: null,
    dataUsed: "Dashboard, overview focus, sector tracker, market commentary, and stored mover snapshots",
    timestamp: null,
  },
  {
    sourceName: "CBOE",
    url: "https://www.cboe.com/tradable_products/vix/",
    dataUsed: "Volatility reference source for weekly review context",
    timestamp: null,
  },
  {
    sourceName: "U.S. Treasury",
    url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
    dataUsed: "Treasury yield reference source for weekly macro context",
    timestamp: null,
  },
  {
    sourceName: "Federal Reserve",
    url: "https://www.federalreserve.gov/newsevents.htm",
    dataUsed: "Federal Reserve speeches, policy, and calendar reference source",
    timestamp: null,
  },
];

const WEEKLY_SEARCH_QUERIES = [
  "US stock market weekly sector performance S&P 500 Nasdaq Russell Reuters CNBC MarketWatch {weekEnd}",
  "US market weekly review sector rotation semiconductors industrials small caps {weekEnd}",
  "US economic calendar next week CPI PPI PCE FOMC Fed speakers Treasury auctions {weekEnd}",
  "top US stock movers this week earnings guidance analyst upgrades downgrades {weekEnd}",
];

function addDaysIso(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mondayForIsoDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  const day = date.getUTCDay();
  const delta = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - delta);
  return date.toISOString().slice(0, 10);
}

function lastUsTradingDayInCalendarWeek(weekStart: string): string | null {
  for (let offset = 4; offset >= 0; offset -= 1) {
    const candidate = addDaysIso(weekStart, offset);
    if (isUsMarketTradingDay(candidate)) return candidate;
  }
  return null;
}

function previousCompletedWeekBefore(weekStart: string): WeeklyMarketReviewWeek {
  let cursor = addDaysIso(weekStart, -7);
  for (let attempts = 0; attempts < 12; attempts += 1) {
    const weekEnd = lastUsTradingDayInCalendarWeek(cursor);
    if (weekEnd) return { weekStart: cursor, weekEnd };
    cursor = addDaysIso(cursor, -7);
  }
  throw new Error("Unable to determine a completed US market week.");
}

export function resolveWeeklyMarketReviewWeek(now = new Date()): WeeklyMarketReviewWeek {
  const session = getUsMarketSessionContext(now);
  const currentWeekStart = mondayForIsoDate(session.nyDate);
  const currentWeekEnd = lastUsTradingDayInCalendarWeek(currentWeekStart);
  if (currentWeekEnd && session.latestCompletedSessionDate >= currentWeekEnd) {
    return { weekStart: currentWeekStart, weekEnd: currentWeekEnd };
  }
  return previousCompletedWeekBefore(currentWeekStart);
}

function weeklyScheduleDecision(env: Env, now = new Date()): { due: boolean; localDate: string; timezone: string; localTime: string; graceMinutes: number } {
  const timezone = env.WEEKLY_MARKET_REVIEW_SCHEDULE_TIMEZONE?.trim() || DEFAULT_WEEKLY_REVIEW_SCHEDULE_TIMEZONE;
  const localTime = env.WEEKLY_MARKET_REVIEW_SCHEDULE_TIME?.trim() || DEFAULT_WEEKLY_REVIEW_SCHEDULE_TIME;
  const scheduleDay = env.WEEKLY_MARKET_REVIEW_SCHEDULE_DAY?.trim() || DEFAULT_WEEKLY_REVIEW_SCHEDULE_DAY;
  const graceMinutes = Math.max(0, Math.floor(Number(env.WEEKLY_MARKET_REVIEW_HERMES_GRACE_MINUTES ?? DEFAULT_WEEKLY_REVIEW_HERMES_GRACE_MINUTES)));
  const target = parseLocalTime(localTime) ?? parseLocalTime(DEFAULT_WEEKLY_REVIEW_SCHEDULE_TIME)!;
  const local = zonedParts(now, timezone);
  const localDay = WEEKDAY_LONG_BY_SHORT[local.weekday] ?? local.weekday;
  const localDayIndex = WEEKDAY_INDEX_BY_LONG[localDay] ?? 0;
  const targetDayIndex = WEEKDAY_INDEX_BY_LONG[scheduleDay] ?? WEEKDAY_INDEX_BY_LONG[DEFAULT_WEEKLY_REVIEW_SCHEDULE_DAY];
  const daysSinceTarget = (localDayIndex - targetDayIndex + 7) % 7;
  const targetMinutes = target.hour * 60 + target.minute + graceMinutes;
  const due = daysSinceTarget > 0 || local.minutesOfDay >= targetMinutes;
  return { due, localDate: local.localDate, timezone, localTime, graceMinutes };
}

function normalizeReportRow(row: WeeklyMarketReviewRow): WeeklyMarketReviewReport {
  return {
    id: row.id,
    weekStart: row.weekStart,
    weekEnd: row.weekEnd,
    generatedAt: row.generatedAt,
    asOf: row.asOf,
    provider: row.provider,
    model: row.model,
    generationProvider: row.generationProvider,
    generationMode: row.generationMode,
    status: row.status,
    title: row.title,
    marketTone: row.marketTone ?? null,
    reviewMarkdown: row.reviewMarkdown,
    sections: parseJsonObject<Record<string, unknown>>(row.sectionsJson),
    keyTickers: parseJsonArray<WeeklyMarketReviewKeyTicker>(row.keyTickersJson),
    sourceAudit: normalizeSourceAuditRows(parseJsonArray<MarketReportSourceAudit>(row.sourceAuditJson)),
    dataQuality: parseJsonArray<MarketReportDataQuality>(row.dataQualityJson),
    sourceSnapshot: parseJsonObject<Record<string, unknown>>(row.sourceSnapshotJson),
    error: row.errorMessage ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadPreferredReadyReviewForWeek(env: Env, weekEnd: string): Promise<WeeklyMarketReviewReport | null> {
  const row = await env.DB.prepare(
    `SELECT ${WEEKLY_REPORT_SELECT}
     FROM weekly_market_reviews
     WHERE week_end = ? AND status = 'ready'
     ORDER BY CASE generation_provider WHEN 'hermes_gpt' THEN 0 ELSE 1 END, datetime(generated_at) DESC, datetime(created_at) DESC
     LIMIT 1`,
  )
    .bind(weekEnd)
    .first<WeeklyMarketReviewRow>();
  return row ? normalizeReportRow(row) : null;
}

async function loadLatestReviewForWeek(env: Env, weekEnd: string): Promise<WeeklyMarketReviewReport | null> {
  const row = await env.DB.prepare(
    `SELECT ${WEEKLY_REPORT_SELECT}
     FROM weekly_market_reviews
     WHERE week_end = ?
     ORDER BY CASE status WHEN 'ready' THEN 0 ELSE 1 END, CASE generation_provider WHEN 'hermes_gpt' THEN 0 ELSE 1 END, datetime(generated_at) DESC, datetime(created_at) DESC
     LIMIT 1`,
  )
    .bind(weekEnd)
    .first<WeeklyMarketReviewRow>();
  return row ? normalizeReportRow(row) : null;
}

async function loadScheduledFallbackAttemptForWeek(env: Env, weekEnd: string): Promise<WeeklyMarketReviewReport | null> {
  const row = await env.DB.prepare(
    `SELECT ${WEEKLY_REPORT_SELECT}
     FROM weekly_market_reviews
     WHERE week_end = ? AND generation_provider = 'gemini_fallback' AND generation_mode = 'scheduled_fallback'
     ORDER BY datetime(generated_at) DESC, datetime(created_at) DESC
     LIMIT 1`,
  )
    .bind(weekEnd)
    .first<WeeklyMarketReviewRow>();
  return row ? normalizeReportRow(row) : null;
}

async function storeWeeklyMarketReview(env: Env, input: StoredWeeklyMarketReviewInput, nowIso = new Date().toISOString()): Promise<WeeklyMarketReviewReport> {
  await env.DB.prepare(
    `INSERT INTO weekly_market_reviews
       (id, week_start, week_end, generated_at, as_of, provider, model, generation_provider, generation_mode, status, title, market_tone, review_markdown, sections_json, key_tickers_json, source_audit_json, data_quality_json, source_snapshot_json, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       week_start = excluded.week_start,
       week_end = excluded.week_end,
       generated_at = excluded.generated_at,
       as_of = excluded.as_of,
       provider = excluded.provider,
       model = excluded.model,
       generation_provider = excluded.generation_provider,
       generation_mode = excluded.generation_mode,
       status = excluded.status,
       title = excluded.title,
       market_tone = excluded.market_tone,
       review_markdown = excluded.review_markdown,
       sections_json = excluded.sections_json,
       key_tickers_json = excluded.key_tickers_json,
       source_audit_json = excluded.source_audit_json,
       data_quality_json = excluded.data_quality_json,
       source_snapshot_json = excluded.source_snapshot_json,
       error_message = excluded.error_message,
       updated_at = excluded.updated_at`,
  )
    .bind(
      input.id,
      input.weekStart,
      input.weekEnd,
      input.generatedAt,
      input.asOf,
      input.provider,
      input.model,
      input.generationProvider,
      input.generationMode,
      input.status,
      input.title,
      input.marketTone,
      input.reviewMarkdown,
      JSON.stringify(input.sections ?? {}),
      JSON.stringify(input.keyTickers ?? []),
      JSON.stringify(input.sourceAudit ?? []),
      JSON.stringify(input.dataQuality ?? []),
      JSON.stringify(input.sourceSnapshot ?? {}),
      input.error,
      nowIso,
      nowIso,
    )
    .run();

  const stored = await loadWeeklyMarketReviewById(env, input.id);
  if (!stored) throw new Error("Failed to store weekly market review.");
  return stored;
}

export async function loadLatestWeeklyMarketReview(env: Env, now = new Date()): Promise<WeeklyMarketReviewResponse> {
  const week = resolveWeeklyMarketReviewWeek(now);
  const preferred = await loadPreferredReadyReviewForWeek(env, week.weekEnd);
  if (preferred) return { status: "ready", warning: null, report: preferred };

  const latest = await loadLatestReviewForWeek(env, week.weekEnd);
  if (latest?.status === "failed") {
    return {
      status: "failed",
      warning: latest.error ?? `Weekly market review generation failed for week ending ${week.weekEnd}.`,
      report: latest,
    };
  }

  return {
    status: "empty",
    warning: `No weekly market review has been generated for the latest completed week (${week.weekStart} to ${week.weekEnd}).`,
    report: null,
  };
}

export async function listWeeklyMarketReviews(env: Env, limitInput = 20): Promise<WeeklyMarketReviewReport[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(limitInput || 20)));
  const rows = await env.DB.prepare(
    `SELECT ${WEEKLY_REPORT_SELECT}
     FROM weekly_market_reviews
     ORDER BY week_end DESC, CASE generation_provider WHEN 'hermes_gpt' THEN 0 ELSE 1 END, datetime(generated_at) DESC, datetime(created_at) DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all<WeeklyMarketReviewRow>();
  return (rows.results ?? []).map(normalizeReportRow);
}

export async function loadWeeklyMarketReviewById(env: Env, id: string): Promise<WeeklyMarketReviewReport | null> {
  const row = await env.DB.prepare(
    `SELECT ${WEEKLY_REPORT_SELECT}
     FROM weekly_market_reviews
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(id)
    .first<WeeklyMarketReviewRow>();
  return row ? normalizeReportRow(row) : null;
}

export async function publishWeeklyMarketReview(env: Env, payload: unknown): Promise<WeeklyMarketReviewReport> {
  const parsed = weeklyMarketReviewPublishSchema.parse(payload);
  return await storeWeeklyMarketReview(env, {
    id: parsed.id,
    weekStart: parsed.weekStart,
    weekEnd: parsed.weekEnd,
    generatedAt: parsed.generatedAt,
    asOf: parsed.asOf,
    provider: parsed.provider,
    model: parsed.model,
    generationProvider: "hermes_gpt",
    generationMode: "external_publish",
    status: parsed.status,
    title: parsed.title,
    marketTone: parsed.marketTone ?? null,
    reviewMarkdown: parsed.reviewMarkdown,
    sections: parsed.sections,
    keyTickers: parsed.keyTickers,
    sourceAudit: parsed.sourceAudit,
    dataQuality: parsed.dataQuality,
    sourceSnapshot: parsed.sourceSnapshot,
    error: parsed.error ?? null,
  }, new Date().toISOString());
}

function renderWeeklySearchQueries(week: WeeklyMarketReviewWeek): string[] {
  return WEEKLY_SEARCH_QUERIES.map((query) =>
    query
      .replaceAll("{weekStart}", week.weekStart)
      .replaceAll("{weekEnd}", week.weekEnd),
  );
}

function summarizeDashboard(snapshot: SnapshotResponse | null, week: WeeklyMarketReviewWeek): string {
  if (!snapshot || snapshot.status === "empty") return "Dashboard snapshot: N/A. No overview snapshot was available.";
  const lines = [
    `Dashboard snapshot generated ${snapshot.generatedAt}; as-of ${snapshot.asOfDate}; freshness ${snapshot.freshnessStatus ?? "unknown"}.`,
    `Target weekly window: ${week.weekStart} to ${week.weekEnd}. Use 1W/5D changes as weekly evidence where available.`,
  ];
  for (const section of snapshot.sections.filter((entry) => entry.title.includes("Macro") || entry.title.includes("Equities"))) {
    lines.push(`Section: ${section.title}`);
    for (const group of section.groups) {
      const groupRelevant =
        group.title.includes("Index")
        || group.title.includes("Sector")
        || group.title.includes("Thematic")
        || group.title.includes("Industry")
        || group.title.includes("Macro")
        || group.title.includes("Commodities")
        || group.title.includes("Rates");
      if (!groupRelevant) continue;
      const rows = group.rows.slice(0, 15).map((row) => {
        const barDate = row.barDate ?? "unknown";
        return `${row.ticker} (${row.displayName ?? row.ticker}): bar ${barDate}, price ${row.price}, 1D ${row.change1d?.toFixed?.(2) ?? row.change1d}%, 1W ${row.change1w?.toFixed?.(2) ?? row.change1w}%, 5D ${row.change5d?.toFixed?.(2) ?? row.change5d}%, YTD ${row.ytd?.toFixed?.(2) ?? row.ytd}%`;
      });
      lines.push(`- ${group.title}: ${rows.length ? rows.join("; ") : "N/A"}`);
    }
  }
  return lines.join("\n");
}

async function summarizeRecentDailyCommentary(env: Env, sourceAudit: MarketReportSourceAudit[], dataQuality: MarketReportDataQuality[]): Promise<string> {
  try {
    const rows = await env.DB.prepare(
      `SELECT session_date as sessionDate, generated_at as generatedAt, market_session_label as marketSessionLabel, report_markdown as reportMarkdown
       FROM market_commentary_reports
       WHERE status = 'ready'
       ORDER BY session_date DESC, datetime(generated_at) DESC
       LIMIT 5`,
    ).all<{ sessionDate: string; generatedAt: string; marketSessionLabel: string; reportMarkdown: string }>();
    const reports = rows.results ?? [];
    if (reports.length === 0) {
      dataQuality.push({ metric: "Recent daily commentary", status: "unavailable", note: "No ready daily commentary reports were available." });
      return "Recent daily commentary: N/A.";
    }
    sourceAudit.push({
      sourceName: "Market Overview daily commentary",
      url: null,
      dataUsed: "Recent generated daily market commentary reports",
      timestamp: reports[0]?.generatedAt ?? null,
    });
    dataQuality.push({ metric: "Recent daily commentary", status: "ok", note: `Loaded ${reports.length} recent daily commentary reports.` });
    return reports.map((row) => {
      const excerpt = row.reportMarkdown.replace(/\s+/g, " ").slice(0, 1400);
      return `Daily report ${row.sessionDate} (${row.marketSessionLabel}, generated ${row.generatedAt}): ${excerpt}`;
    }).join("\n\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Daily commentary load failed.";
    dataQuality.push({ metric: "Recent daily commentary", status: "unavailable", note: message });
    return `Recent daily commentary: N/A. ${message}`;
  }
}

async function summarizeOverviewFocus(env: Env, sourceAudit: MarketReportSourceAudit[], dataQuality: MarketReportDataQuality[]): Promise<string> {
  try {
    const rows = await listOverviewFocusItems(env, "default");
    sourceAudit.push({
      sourceName: "Market Overview current focus",
      url: null,
      dataUsed: "Current Focus items from the Overview page",
      timestamp: rows[0]?.updatedAt ?? null,
    });
    dataQuality.push({
      metric: "Overview focus",
      status: rows.length > 0 ? "ok" : "unavailable",
      note: rows.length > 0 ? `Loaded ${rows.length} focus items.` : "No current focus items were configured.",
    });
    return rows.length ? rows.map((row) => `- ${row.text}`).join("\n") : "Overview focus: N/A.";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Overview focus load failed.";
    dataQuality.push({ metric: "Overview focus", status: "unavailable", note: message });
    return `Overview focus: N/A. ${message}`;
  }
}

async function summarizeSectorFocus(env: Env, sourceAudit: MarketReportSourceAudit[], dataQuality: MarketReportDataQuality[]): Promise<string> {
  try {
    const [focusRows, entryRows] = await Promise.all([
      env.DB.prepare(
        `SELECT sector_name as sectorName, comment_text as commentText, updated_at as updatedAt
         FROM sector_focus_narratives
         ORDER BY sort_order ASC, sector_name ASC
         LIMIT 12`,
      ).all<{ sectorName: string; commentText: string; updatedAt: string }>(),
      env.DB.prepare(
        `SELECT entry.sector_name as sectorName, entry.event_date as eventDate, entry.trend_score as trendScore, entry.notes as notes,
                GROUP_CONCAT(symbol.ticker) as tickers
         FROM sector_tracker_entries entry
         LEFT JOIN sector_tracker_entry_symbols symbol ON symbol.entry_id = entry.id
         GROUP BY entry.id
         ORDER BY entry.event_date DESC, entry.created_at DESC
         LIMIT 12`,
      ).all<{ sectorName: string; eventDate: string; trendScore: number; notes: string | null; tickers: string | null }>(),
    ]);
    const focus = focusRows.results ?? [];
    const entries = entryRows.results ?? [];
    sourceAudit.push({
      sourceName: "Market Overview sector tracker",
      url: null,
      dataUsed: "Sector focus narratives and recent sector tracker entries",
      timestamp: focus[0]?.updatedAt ?? entries[0]?.eventDate ?? null,
    });
    dataQuality.push({
      metric: "Sector focus data",
      status: focus.length || entries.length ? "ok" : "unavailable",
      note: `Loaded ${focus.length} focus narratives and ${entries.length} recent sector tracker entries.`,
    });
    return [
      "Focus narratives:",
      focus.length ? focus.map((row) => `- ${row.sectorName}: ${row.commentText || "No comment."}`).join("\n") : "N/A",
      "",
      "Recent sector tracker entries:",
      entries.length
        ? entries.map((row) => `- ${row.eventDate} ${row.sectorName} score ${row.trendScore}: ${row.notes ?? "No notes."} Tickers: ${row.tickers ?? "N/A"}`).join("\n")
        : "N/A",
    ].join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sector focus load failed.";
    dataQuality.push({ metric: "Sector focus data", status: "unavailable", note: message });
    return `Sector focus data: N/A. ${message}`;
  }
}

async function summarizeStoredGappers(env: Env, sourceAudit: MarketReportSourceAudit[], dataQuality: MarketReportDataQuality[]): Promise<string> {
  try {
    const snapshot = await env.DB.prepare(
      "SELECT id, generated_at as generatedAt, row_count as rowCount, status, error FROM gappers_snapshots ORDER BY datetime(generated_at) DESC LIMIT 1",
    ).first<{ id: string; generatedAt: string; rowCount: number; status: string; error: string | null }>();
    if (!snapshot) {
      dataQuality.push({ metric: "Stored gappers snapshot", status: "unavailable", note: "No stored gappers snapshot was available." });
      return "Stored gappers/top movers: N/A.";
    }
    const rows = await env.DB.prepare(
      `SELECT ticker, name, sector, industry, gap_pct as gapPct, price, premarket_volume as premarketVolume, composite_score as compositeScore
       FROM gappers_rows
       WHERE snapshot_id = ?
       ORDER BY gap_pct DESC, ticker ASC
       LIMIT 12`,
    ).bind(snapshot.id).all<{ ticker: string; name: string | null; sector: string | null; industry: string | null; gapPct: number; price: number; premarketVolume: number; compositeScore: number | null }>();
    const movers = rows.results ?? [];
    sourceAudit.push({
      sourceName: "Market Overview stored gappers snapshot",
      url: null,
      dataUsed: "Stored app snapshot of notable premarket movers; no new TradingView or watchlist analysis was invoked",
      timestamp: snapshot.generatedAt,
      note: snapshot.error,
    });
    dataQuality.push({
      metric: "Stored gappers snapshot",
      status: movers.length > 0 ? "ok" : "unavailable",
      note: movers.length > 0 ? `Loaded ${movers.length} rows from stored snapshot ${snapshot.id}.` : `Stored snapshot ${snapshot.id} had no rows.`,
    });
    return movers.length
      ? movers.map((row) => `- ${row.ticker} (${row.name ?? "N/A"}): gap ${row.gapPct?.toFixed?.(2) ?? row.gapPct}%, price ${row.price}, sector ${row.sector ?? "N/A"}, industry ${row.industry ?? "N/A"}, premarket volume ${row.premarketVolume ?? "N/A"}`).join("\n")
      : "Stored gappers/top movers: N/A.";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stored gappers load failed.";
    dataQuality.push({ metric: "Stored gappers snapshot", status: "unavailable", note: message });
    return `Stored gappers/top movers: N/A. ${message}`;
  }
}

async function summarizeFedWatch(env: Env, sourceAudit: MarketReportSourceAudit[], dataQuality: MarketReportDataQuality[]): Promise<string> {
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
    const rows = fedWatch.data.rows.slice(0, 6).map((row) =>
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

async function gatherWeeklyEvidence(env: Env, week: WeeklyMarketReviewWeek, now: Date): Promise<WeeklyEvidence> {
  const nowIso = now.toISOString();
  const sourceAudit = [...WEEKLY_STATIC_SOURCES];
  const dataQuality: MarketReportDataQuality[] = [
    {
      metric: "Weekly market window",
      status: "ok",
      note: `Target completed US market week is ${week.weekStart} to ${week.weekEnd}.`,
    },
  ];
  let snapshot: SnapshotResponse | null = null;
  try {
    snapshot = await loadSnapshot(env, "default", week.weekEnd, { allowComputeOnMissing: false });
    sourceAudit.push({
      sourceName: "Market Overview dashboard snapshot",
      url: null,
      dataUsed: "Cached index, ETF, sector, breadth, and technical snapshot from the existing application",
      timestamp: snapshot.generatedAt,
    });
    dataQuality.push({
      metric: "Existing dashboard snapshot",
      status: snapshot.status === "empty" || snapshot.freshnessStatus === "stale" || snapshot.freshnessStatus === "partial" ? "stale" : "ok",
      note: snapshot.status === "empty"
        ? "Overview snapshot was unavailable."
        : `Loaded snapshot as of ${snapshot.asOfDate}; freshness ${snapshot.freshnessStatus ?? "unknown"} (${snapshot.freshnessCurrentCount ?? 0}/${snapshot.freshnessEligibleCount ?? 0} tickers current). ${snapshot.freshnessWarning ?? ""}`.trim(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dashboard snapshot load failed.";
    dataQuality.push({ metric: "Existing dashboard snapshot", status: "unavailable", note: message });
  }

  const [
    recentDailyCommentarySummary,
    overviewFocusSummary,
    sectorFocusSummary,
    gappersSummary,
    fedWatchSummary,
    searchSummary,
  ] = await Promise.all([
    summarizeRecentDailyCommentary(env, sourceAudit, dataQuality),
    summarizeOverviewFocus(env, sourceAudit, dataQuality),
    summarizeSectorFocus(env, sourceAudit, dataQuality),
    summarizeStoredGappers(env, sourceAudit, dataQuality),
    summarizeFedWatch(env, sourceAudit, dataQuality),
    summarizeBraveSearch(env, renderWeeklySearchQueries(week), dataQuality, sourceAudit, {
      metric: "Weekly web/news search",
      freshness: "pw",
      dataUsedPrefix: "Weekly Brave Search result for",
    }),
  ]);

  return {
    week,
    nowIso,
    dashboardSummary: summarizeDashboard(snapshot, week),
    recentDailyCommentarySummary,
    overviewFocusSummary,
    sectorFocusSummary,
    gappersSummary,
    fedWatchSummary,
    searchSummary,
    sourceAudit,
    dataQuality,
    sourceSnapshot: {
      latestMarketDate: week.weekEnd,
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      dashboardStatus: snapshot?.status ?? "unavailable",
      dashboardAsOfDate: snapshot?.asOfDate ?? null,
      dashboardGeneratedAt: snapshot?.generatedAt ?? null,
      sources: ["market-overview", "daily-commentary", "overview-focus", "sector-tracker", "fedwatch", "brave-search", "gemini"],
      tradingViewExcluded: "No TradingView MCP, chart screenshots, watchlist flags, or watchlist review candidates are used.",
    },
  };
}

function buildWeeklyPrompt(evidence: WeeklyEvidence): string {
  return [
    "You are an institutional-quality US market strategist writing a broad weekly market review for the Market Overview app.",
    "",
    "Hard rules:",
    "- Use only the evidence packet and cited sources provided below.",
    "- Do not invent prices, dates, market moves, or news. If data is stale or missing, say so in Data Freshness / Source Notes.",
    "- Do not include TradingView MCP data, chart screenshot analysis, watchlist flags, watchlist review candidates, or watchlist recommendations.",
    "- Focus on broad market commentary: sectors, industries/themes, key movers, macro/news impact, and what to watch next week.",
    "- This is market commentary and risk analysis, not personalized financial advice.",
    "- Use markdown with the exact section headings listed below.",
    "",
    `Review week: ${evidence.week.weekStart} to ${evidence.week.weekEnd}`,
    `Generated at: ${evidence.nowIso}`,
    "",
    "Required markdown sections:",
    "## Executive Summary",
    "## Market Tone & Breadth",
    "## Sector Leadership",
    "## Industry / Theme Movers",
    "## Key Stock Movers & Read-throughs",
    "## News and Macro Impact",
    "## What To Watch Next Week",
    "## Risks / Invalidation",
    "## Data Freshness / Source Notes",
    "",
    "EXISTING APP MARKET DATA",
    evidence.dashboardSummary,
    "",
    "RECENT DAILY MARKET COMMENTARY",
    evidence.recentDailyCommentarySummary,
    "",
    "OVERVIEW CURRENT FOCUS",
    evidence.overviewFocusSummary,
    "",
    "SECTOR / THEME FOCUS DATA",
    evidence.sectorFocusSummary,
    "",
    "STORED KEY MOVER SNAPSHOT",
    evidence.gappersSummary,
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

function weeklyFallbackMarkdown(week: WeeklyMarketReviewWeek, message: string): string {
  return [
    `# Weekly Market Review - ${week.weekStart} to ${week.weekEnd}`,
    "",
    `Weekly review generation is unavailable: ${message}`,
    "",
    "The daily US Market State of Play and the rest of the Overview page are unaffected.",
    "",
    "## Data Freshness / Source Notes",
    "",
    "Configure the Gemini/Brave provider settings or retry after the scheduled pipeline has completed.",
  ].join("\n");
}

function fallbackReviewId(week: WeeklyMarketReviewWeek, mode: WeeklyMarketReviewGenerationMode, nowIso: string): string {
  return `weekly-market-review-${week.weekStart}-${week.weekEnd}-${mode}-${nowIso.replace(/[^0-9]/g, "").slice(0, 14)}`;
}

export async function generateWeeklyMarketReview(env: Env, options?: { force?: boolean; mode?: "scheduled_fallback" | "manual_retry"; now?: Date }): Promise<WeeklyMarketReviewGenerateResponse> {
  const parsed = weeklyMarketReviewGenerateSchema.parse({
    force: options?.force ?? false,
    mode: options?.mode ?? "scheduled_fallback",
  });
  const now = options?.now ?? new Date();
  const nowIso = now.toISOString();
  const week = resolveWeeklyMarketReviewWeek(now);

  if (!parsed.force) {
    const existing = await loadPreferredReadyReviewForWeek(env, week.weekEnd);
    if (existing) {
      return {
        ok: true,
        status: "ready",
        warning: existing.generationProvider === "hermes_gpt"
          ? "Using the current Hermes / GPT weekly market review."
          : "Using the current Gemini fallback weekly market review.",
        report: existing,
      };
    }
  }

  let evidence: WeeklyEvidence | null = null;
  try {
    if (!env.GEMINI_API_KEY?.trim()) {
      throw new Error("GEMINI_API_KEY is not configured.");
    }
    evidence = await gatherWeeklyEvidence(env, week, now);
    const result = await generateMarkdownWithGemini(env, buildWeeklyPrompt(evidence), { maxOutputTokens: 24000 });
    const report = await storeWeeklyMarketReview(env, {
      id: fallbackReviewId(week, parsed.mode, nowIso),
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      generatedAt: nowIso,
      asOf: nowIso,
      provider: result.provider,
      model: result.model,
      generationProvider: "gemini_fallback",
      generationMode: parsed.mode,
      status: "ready",
      title: `Weekly Market Review - ${week.weekStart} to ${week.weekEnd}`,
      marketTone: null,
      reviewMarkdown: result.text,
      sections: {},
      keyTickers: [],
      sourceAudit: [...evidence.sourceAudit, ...result.sources],
      dataQuality: evidence.dataQuality,
      sourceSnapshot: evidence.sourceSnapshot,
      error: null,
    }, nowIso);
    return { ok: true, status: "ready", warning: null, report };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Weekly market review generation failed.";
    const dataQuality = evidence?.dataQuality ?? [];
    if (!dataQuality.some((note) => note.metric === "Weekly review generation")) {
      dataQuality.push({ metric: "Weekly review generation", status: "unavailable", note: message });
    }
    const report = await storeWeeklyMarketReview(env, {
      id: fallbackReviewId(week, parsed.mode, nowIso),
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      generatedAt: nowIso,
      asOf: nowIso,
      provider: GEMINI_PROVIDER,
      model: env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
      generationProvider: "gemini_fallback",
      generationMode: parsed.mode,
      status: "failed",
      title: `Weekly Market Review - ${week.weekStart} to ${week.weekEnd}`,
      marketTone: null,
      reviewMarkdown: weeklyFallbackMarkdown(week, message),
      sections: {},
      keyTickers: [],
      sourceAudit: evidence?.sourceAudit ?? WEEKLY_STATIC_SOURCES,
      dataQuality,
      sourceSnapshot: evidence?.sourceSnapshot ?? {
        latestMarketDate: week.weekEnd,
        weekStart: week.weekStart,
        weekEnd: week.weekEnd,
        sources: ["market-overview", "gemini"],
      },
      error: message,
    }, nowIso);
    return { ok: false, status: "failed", warning: message, report };
  }
}

export async function maybeRunScheduledWeeklyMarketReview(env: Env, now = new Date()): Promise<WeeklyMarketReviewScheduleResult> {
  const decision = weeklyScheduleDecision(env, now);
  if (!decision.due) return null;
  const week = resolveWeeklyMarketReviewWeek(now);
  const existing = await loadPreferredReadyReviewForWeek(env, week.weekEnd);
  if (existing) {
    return {
      ok: true,
      status: "ready",
      warning: `Scheduled weekly review skipped; a ready ${existing.generationProvider === "hermes_gpt" ? "Hermes / GPT" : "Gemini fallback"} review already exists for week ending ${week.weekEnd}.`,
      report: existing,
    };
  }
  const scheduledAttempt = await loadScheduledFallbackAttemptForWeek(env, week.weekEnd);
  if (scheduledAttempt) {
    return {
      ok: scheduledAttempt.status === "ready",
      status: scheduledAttempt.status,
      warning: `Scheduled weekly review skipped; a scheduled fallback attempt already exists for week ending ${week.weekEnd}.`,
      report: scheduledAttempt,
    };
  }
  return await generateWeeklyMarketReview(env, { force: false, mode: "scheduled_fallback", now });
}
