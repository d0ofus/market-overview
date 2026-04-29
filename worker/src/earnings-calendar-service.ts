import type { Env } from "./types";
import {
  loadFundamentalIssuerMap,
  loadLatestCachedFundamentalPeriod,
  refreshTickerFundamentals,
} from "./fundamentals-service";
import { fetchRecentFilings, type SecFilingItem } from "./research/providers/sec-direct";

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const FINNHUB_EARNINGS_URL = "https://finnhub.io/api/v1/calendar/earnings";
const FMP_EARNINGS_URL = "https://financialmodelingprep.com/stable/earnings-calendar";
const DEFAULT_HORIZON = "3month";
const MAX_SYNC_BATCH_SIZE = 50;
const MS_PER_DAY = 86_400_000;

export type EarningsEventStatus =
  | "scheduled"
  | "reported_pending_sec"
  | "sec_ready"
  | "fundamentals_refreshed"
  | "provider_missing"
  | "sec_pending_timeout"
  | "unsupported_filer"
  | "refresh_error";

type EarningsProviderKey = "alpha_vantage" | "finnhub" | "fmp";

export type EarningsProviderEvent = {
  ticker: string;
  companyName: string | null;
  scheduledDate: string;
  timeHint: string | null;
  fiscalPeriod: string;
  epsEstimate: number | null;
  revenueEstimate: number | null;
  epsActual: number | null;
  revenueActual: number | null;
  provider: EarningsProviderKey;
  providerConfidence: number;
};

type EarningsEventRow = {
  id: string;
  ticker: string;
  cik: string;
  companyName: string;
  scheduledDate: string;
  timeHint: string | null;
  fiscalPeriod: string;
  epsActual: number | null;
  revenueActual: number | null;
  status: EarningsEventStatus;
  attempts: number | null;
  secForm: string | null;
  secAccession: string | null;
};

type ProviderSyncResult = {
  provider: EarningsProviderKey;
  rowsSeen: number;
  rowsEligible: number;
  status: "ok" | "skipped" | "error";
  error: string | null;
};

function fundamentalsDb(env: Env): D1Database | null {
  return env.FUNDAMENTALS_DB ?? null;
}

function normalizeTicker(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function normalizeFiscalPeriod(value: unknown): string {
  return normalizeDate(value) ?? String(value ?? "").trim();
}

function parseMaybeNumber(value: unknown): number | null {
  if (value == null) return null;
  const text = String(value).trim().replace(/,/g, "");
  if (!text || /^none|null|nan|-$/i.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimeHint(value: unknown): string | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (/\bbmo\b|before|pre[-\s]?market|morning/.test(text)) return "bmo";
  if (/\bamc\b|after|post[-\s]?market|evening/.test(text)) return "amc";
  if (text === "bmo" || text === "amc") return text;
  return text.slice(0, 24);
}

function simpleHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function eventId(ticker: string, scheduledDate: string, fiscalPeriod: string): string {
  return `earnings-${ticker}-${scheduledDate}-${simpleHash(fiscalPeriod || "unknown")}`;
}

function eventKey(event: EarningsProviderEvent): string {
  return `${event.ticker}|${event.scheduledDate}|${event.fiscalPeriod}`;
}

export function parseCsvRows(raw: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (char !== "\r") cell += char;
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const [headers = [], ...body] = rows.filter((cells) => cells.some((value) => value.trim()));
  return body.map((cells) => Object.fromEntries(headers.map((header, index) => [header.trim(), cells[index]?.trim() ?? ""])));
}

function pick(row: Record<string, unknown>, names: string[]): unknown {
  const entries = Object.entries(row);
  for (const name of names) {
    const match = entries.find(([key]) => key.toLowerCase().replace(/[^a-z0-9]/g, "") === name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (match) return match[1];
  }
  return null;
}

function alphaVantageJsonErrorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const message = pick(parsed, ["Information", "Note", "Error Message", "message"]);
    if (message) return String(message).trim().slice(0, 400);
  } catch {
    // Fall through to the generic parser message.
  }
  return "Alpha Vantage returned JSON instead of the expected earnings calendar CSV.";
}

export function parseAlphaVantageEarningsCalendarCsv(raw: string): EarningsProviderEvent[] {
  if (raw.trim().startsWith("{")) {
    throw new Error(`Alpha Vantage earnings calendar error: ${alphaVantageJsonErrorMessage(raw)}`);
  }
  return parseCsvRows(raw)
    .map<EarningsProviderEvent | null>((row) => {
      const ticker = normalizeTicker(pick(row, ["symbol", "ticker"]));
      const scheduledDate = normalizeDate(pick(row, ["reportDate", "date"]));
      if (!ticker || !scheduledDate) return null;
      return {
        ticker,
        companyName: String(pick(row, ["name", "companyName"]) ?? "").trim() || null,
        scheduledDate,
        timeHint: normalizeTimeHint(pick(row, ["time", "hour"])),
        fiscalPeriod: normalizeFiscalPeriod(pick(row, ["fiscalDateEnding", "fiscalPeriod", "period"])),
        epsEstimate: parseMaybeNumber(pick(row, ["estimate", "epsEstimate", "epsEstimated"])),
        revenueEstimate: parseMaybeNumber(pick(row, ["revenueEstimate", "revenueEstimated"])),
        epsActual: parseMaybeNumber(pick(row, ["epsActual", "actual"])),
        revenueActual: parseMaybeNumber(pick(row, ["revenueActual"])),
        provider: "alpha_vantage" as const,
        providerConfidence: 0.7,
      };
    })
    .filter((event): event is EarningsProviderEvent => event != null);
}

function parseFinnhubEarningsCalendar(json: unknown): EarningsProviderEvent[] {
  const rows = Array.isArray((json as { earningsCalendar?: unknown[] })?.earningsCalendar)
    ? (json as { earningsCalendar: unknown[] }).earningsCalendar
    : [];
  return rows
    .map<EarningsProviderEvent | null>((raw) => {
      const row = raw as Record<string, unknown>;
      const ticker = normalizeTicker(pick(row, ["symbol", "ticker"]));
      const scheduledDate = normalizeDate(pick(row, ["date", "reportDate"]));
      if (!ticker || !scheduledDate) return null;
      const year = String(pick(row, ["year"]) ?? "").trim();
      const quarter = String(pick(row, ["quarter"]) ?? "").trim();
      return {
        ticker,
        companyName: String(pick(row, ["name", "companyName"]) ?? "").trim() || null,
        scheduledDate,
        timeHint: normalizeTimeHint(pick(row, ["hour", "time"])),
        fiscalPeriod: [year, quarter ? `Q${quarter}` : ""].filter(Boolean).join(" ") || "",
        epsEstimate: parseMaybeNumber(pick(row, ["epsEstimate", "epsEstimated"])),
        revenueEstimate: parseMaybeNumber(pick(row, ["revenueEstimate", "revenueEstimated"])),
        epsActual: parseMaybeNumber(pick(row, ["epsActual"])),
        revenueActual: parseMaybeNumber(pick(row, ["revenueActual"])),
        provider: "finnhub" as const,
        providerConfidence: 0.8,
      };
    })
    .filter((event): event is EarningsProviderEvent => event != null);
}

function parseFmpEarningsCalendar(json: unknown): EarningsProviderEvent[] {
  const rows = Array.isArray(json) ? json : [];
  return rows
    .map<EarningsProviderEvent | null>((raw) => {
      const row = raw as Record<string, unknown>;
      const ticker = normalizeTicker(pick(row, ["symbol", "ticker"]));
      const scheduledDate = normalizeDate(pick(row, ["date", "reportDate"]));
      if (!ticker || !scheduledDate) return null;
      return {
        ticker,
        companyName: String(pick(row, ["name", "companyName"]) ?? "").trim() || null,
        scheduledDate,
        timeHint: normalizeTimeHint(pick(row, ["time", "hour"])),
        fiscalPeriod: normalizeFiscalPeriod(pick(row, ["fiscalDateEnding", "fiscalPeriod", "period"])),
        epsEstimate: parseMaybeNumber(pick(row, ["epsEstimated", "epsEstimate"])),
        revenueEstimate: parseMaybeNumber(pick(row, ["revenueEstimated", "revenueEstimate"])),
        epsActual: parseMaybeNumber(pick(row, ["eps", "epsActual"])),
        revenueActual: parseMaybeNumber(pick(row, ["revenue", "revenueActual"])),
        provider: "fmp" as const,
        providerConfidence: 0.8,
      };
    })
    .filter((event): event is EarningsProviderEvent => event != null);
}

export function dedupeProviderEvents(events: EarningsProviderEvent[]): EarningsProviderEvent[] {
  const byKey = new Map<string, EarningsProviderEvent>();
  for (const event of events) {
    const key = eventKey(event);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, event);
      continue;
    }
    const preferred = event.providerConfidence >= existing.providerConfidence ? event : existing;
    const fallback = preferred === event ? existing : event;
    byKey.set(key, {
      ...preferred,
      companyName: preferred.companyName ?? fallback.companyName,
      timeHint: preferred.timeHint ?? fallback.timeHint,
      epsEstimate: preferred.epsEstimate ?? fallback.epsEstimate,
      revenueEstimate: preferred.revenueEstimate ?? fallback.revenueEstimate,
      epsActual: preferred.epsActual ?? fallback.epsActual,
      revenueActual: preferred.revenueActual ?? fallback.revenueActual,
    });
  }
  return Array.from(byKey.values()).sort((left, right) => {
    if (left.scheduledDate !== right.scheduledDate) return left.scheduledDate.localeCompare(right.scheduledDate);
    return left.ticker.localeCompare(right.ticker);
  });
}

async function hasEarningsSchema(db: D1Database): Promise<boolean> {
  const row = await db.prepare(
    "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name IN ('earnings_events', 'earnings_calendar_syncs')",
  ).first<{ count: number }>();
  return Number(row?.count ?? 0) >= 2;
}

async function requireEarningsSchema(env: Env): Promise<D1Database> {
  const db = fundamentalsDb(env);
  if (!db) throw new Error("FUNDAMENTALS_DB binding is not configured.");
  if (!(await hasEarningsSchema(db))) {
    throw new Error("Earnings schema is missing. Apply worker/fundamentals-migrations/0002_earnings_events.sql.");
  }
  return db;
}

async function fetchText(url: string, label: string): Promise<string> {
  const response = await fetch(url, { headers: { Accept: "text/csv,text/plain,*/*" } });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${label} failed (${response.status}): ${body.slice(0, 180)}`);
  }
  return response.text();
}

async function fetchJson<T>(url: string, label: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${label} failed (${response.status}): ${body.slice(0, 180)}`);
  }
  return response.json() as Promise<T>;
}

async function fetchProviderEvents(env: Env, provider: EarningsProviderKey, horizon: string, now: Date): Promise<EarningsProviderEvent[] | null> {
  if (provider === "alpha_vantage") {
    if (!env.ALPHA_VANTAGE_API_KEY) return null;
    const url = `${ALPHA_VANTAGE_URL}?${new URLSearchParams({
      function: "EARNINGS_CALENDAR",
      horizon,
      datatype: "csv",
      apikey: env.ALPHA_VANTAGE_API_KEY,
    }).toString()}`;
    return parseAlphaVantageEarningsCalendarCsv(await fetchText(url, "Alpha Vantage earnings calendar"));
  }
  const from = now.toISOString().slice(0, 10);
  const to = isoDateMonthsAfter(now, 3);
  if (provider === "finnhub") {
    if (!env.FINNHUB_API_KEY) return null;
    const url = `${FINNHUB_EARNINGS_URL}?${new URLSearchParams({
      from,
      to,
      token: env.FINNHUB_API_KEY,
    }).toString()}`;
    return parseFinnhubEarningsCalendar(await fetchJson<unknown>(url, "Finnhub earnings calendar"));
  }
  if (!env.FMP_API_KEY) return null;
  const url = `${FMP_EARNINGS_URL}?${new URLSearchParams({
    from,
    to,
    apikey: env.FMP_API_KEY,
  }).toString()}`;
  return parseFmpEarningsCalendar(await fetchJson<unknown>(url, "FMP earnings calendar"));
}

function isoDateMonthsAfter(now: Date, months: number): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

async function loadSavedEquityUniverse(env: Env): Promise<Set<string>> {
  const rows = await env.DB.prepare(
    `SELECT ticker
     FROM symbols
     WHERE COALESCE(is_active, 1) = 1
       AND LOWER(COALESCE(asset_class, '')) IN ('equity', 'stock', 'us_equity')
       AND UPPER(COALESCE(exchange, '')) NOT LIKE '%OTC%'`,
  ).all<{ ticker: string }>();
  return new Set((rows.results ?? []).map((row) => normalizeTicker(row.ticker)).filter(Boolean));
}

async function recordSync(
  db: D1Database,
  provider: EarningsProviderKey,
  input: { status: "running" | "ok" | "skipped" | "error"; horizon: string; startedAt?: string; successAt?: string | null; error?: string | null; rowsSeen?: number; rowsUpserted?: number },
): Promise<void> {
  await db.prepare(
    `INSERT INTO earnings_calendar_syncs (
       provider, status, horizon, last_started_at, last_success_at, last_error, rows_seen, rows_upserted, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(provider) DO UPDATE SET
       status = excluded.status,
       horizon = excluded.horizon,
       last_started_at = COALESCE(excluded.last_started_at, earnings_calendar_syncs.last_started_at),
       last_success_at = CASE WHEN excluded.status = 'ok' THEN excluded.last_success_at ELSE earnings_calendar_syncs.last_success_at END,
       last_error = excluded.last_error,
       rows_seen = excluded.rows_seen,
       rows_upserted = excluded.rows_upserted,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(
    provider,
    input.status,
    input.horizon,
    input.startedAt ?? null,
    input.successAt ?? null,
    input.error ?? null,
    input.rowsSeen ?? 0,
    input.rowsUpserted ?? 0,
  ).run();
}

async function upsertEarningsEvents(db: D1Database, events: EarningsProviderEvent[], issuerMap: Map<string, { cik: string; companyName: string }>): Promise<number> {
  const now = new Date().toISOString();
  const statements = events.map((event) => {
    const issuer = issuerMap.get(event.ticker)!;
    const fiscalPeriod = event.fiscalPeriod || "";
    return db.prepare(
      `INSERT INTO earnings_events (
         id, ticker, cik, company_name, scheduled_date, time_hint, fiscal_period,
         eps_estimate, revenue_estimate, eps_actual, revenue_actual,
         provider, provider_confidence, status, last_provider_seen_at, next_check_at, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(ticker, scheduled_date, fiscal_period) DO UPDATE SET
         cik = excluded.cik,
         company_name = excluded.company_name,
         time_hint = COALESCE(excluded.time_hint, earnings_events.time_hint),
         eps_estimate = COALESCE(excluded.eps_estimate, earnings_events.eps_estimate),
         revenue_estimate = COALESCE(excluded.revenue_estimate, earnings_events.revenue_estimate),
         eps_actual = COALESCE(excluded.eps_actual, earnings_events.eps_actual),
         revenue_actual = COALESCE(excluded.revenue_actual, earnings_events.revenue_actual),
         provider = CASE
           WHEN excluded.provider_confidence >= earnings_events.provider_confidence THEN excluded.provider
           ELSE earnings_events.provider
         END,
         provider_confidence = MAX(excluded.provider_confidence, earnings_events.provider_confidence),
         status = CASE
           WHEN earnings_events.status IN ('fundamentals_refreshed', 'sec_pending_timeout', 'unsupported_filer') THEN earnings_events.status
           WHEN excluded.eps_actual IS NOT NULL OR excluded.revenue_actual IS NOT NULL THEN 'reported_pending_sec'
           ELSE earnings_events.status
         END,
         last_provider_seen_at = excluded.last_provider_seen_at,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(
      eventId(event.ticker, event.scheduledDate, fiscalPeriod),
      event.ticker,
      issuer.cik,
      event.companyName ?? issuer.companyName,
      event.scheduledDate,
      event.timeHint,
      fiscalPeriod,
      event.epsEstimate,
      event.revenueEstimate,
      event.epsActual,
      event.revenueActual,
      event.provider,
      event.providerConfidence,
      now,
    );
  });
  for (let index = 0; index < statements.length; index += MAX_SYNC_BATCH_SIZE) {
    const chunk = statements.slice(index, index + MAX_SYNC_BATCH_SIZE);
    if (chunk.length > 0) await db.batch(chunk);
  }
  return statements.length;
}

export async function syncEarningsCalendarFromProviders(
  env: Env,
  options: { horizon?: string; now?: Date } = {},
): Promise<{ ok: boolean; horizon: string; providers: ProviderSyncResult[]; rowsUpserted: number; warning: string | null }> {
  const db = await requireEarningsSchema(env);
  const horizon = options.horizon ?? DEFAULT_HORIZON;
  const now = options.now ?? new Date();
  const providers: EarningsProviderKey[] = ["alpha_vantage", "finnhub", "fmp"];
  const providerResults: ProviderSyncResult[] = [];
  const allEvents: EarningsProviderEvent[] = [];

  for (const provider of providers) {
    const startedAt = new Date().toISOString();
    await recordSync(db, provider, { status: "running", horizon, startedAt });
    try {
      const events = await fetchProviderEvents(env, provider, horizon, now);
      if (!events) {
        await recordSync(db, provider, { status: "skipped", horizon, error: "API key is not configured." });
        providerResults.push({ provider, rowsSeen: 0, rowsEligible: 0, status: "skipped", error: "API key is not configured." });
        continue;
      }
      allEvents.push(...events);
      providerResults.push({ provider, rowsSeen: events.length, rowsEligible: 0, status: "ok", error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provider sync failed.";
      await recordSync(db, provider, { status: "error", horizon, error: message });
      providerResults.push({ provider, rowsSeen: 0, rowsEligible: 0, status: "error", error: message });
    }
  }

  if (allEvents.length === 0) {
    return {
      ok: false,
      horizon,
      providers: providerResults,
      rowsUpserted: 0,
      warning: "No earnings calendar providers returned rows.",
    };
  }

  const issuerMap = await loadFundamentalIssuerMap(env);
  const universe = await loadSavedEquityUniverse(env);
  const eligible = dedupeProviderEvents(allEvents)
    .filter((event) => universe.has(event.ticker))
    .filter((event) => issuerMap.has(event.ticker));
  const upserted = await upsertEarningsEvents(db, eligible, issuerMap);

  for (const providerResult of providerResults) {
    if (providerResult.status !== "ok") continue;
    const providerEligible = eligible.filter((event) => event.provider === providerResult.provider).length;
    providerResult.rowsEligible = providerEligible;
    await recordSync(db, providerResult.provider, {
      status: "ok",
      horizon,
      successAt: new Date().toISOString(),
      rowsSeen: providerResult.rowsSeen,
      rowsUpserted: providerEligible,
    });
  }

  return {
    ok: true,
    horizon,
    providers: providerResults,
    rowsUpserted: upserted,
    warning: null,
  };
}

function easternDateParts(now: Date): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour") || 0),
    minute: Number(get("minute") || 0),
  };
}

export function hasEarningsReleaseWindowPassed(event: { scheduledDate: string; timeHint?: string | null }, now = new Date()): boolean {
  const eastern = easternDateParts(now);
  if (eastern.date > event.scheduledDate) return true;
  if (eastern.date < event.scheduledDate) return false;
  const minutes = eastern.hour * 60 + eastern.minute;
  const hint = normalizeTimeHint(event.timeHint);
  if (hint === "bmo") return minutes >= (9 * 60 + 30);
  return minutes >= (16 * 60 + 15);
}

function addHours(now: Date, hours: number): string {
  return new Date(now.getTime() + (hours * 60 * 60_000)).toISOString();
}

function daysSinceScheduled(scheduledDate: string, now: Date): number {
  const current = Date.parse(`${easternDateParts(now).date}T00:00:00Z`);
  const scheduled = Date.parse(`${scheduledDate}T00:00:00Z`);
  if (!Number.isFinite(current) || !Number.isFinite(scheduled)) return 0;
  return Math.max(0, Math.floor((current - scheduled) / MS_PER_DAY));
}

function isoDateDaysBefore(isoDate: string, days: number): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - days);
  return parsed.toISOString().slice(0, 10);
}

export function findRelevantEarningsFiling(filings: SecFilingItem[], scheduledDate: string): SecFilingItem | null {
  const minDate = isoDateDaysBefore(scheduledDate, 1);
  for (const filing of filings) {
    const filingDate = filing.filingDate ?? "";
    if (filingDate && filingDate < minDate) continue;
    const form = filing.form.toUpperCase();
    if (/^(10-Q|10-K|20-F|6-K)$/.test(form)) return filing;
    if (form === "8-K") {
      const text = `${filing.items ?? ""} ${filing.primaryDocDescription ?? ""} ${filing.primaryDocument ?? ""}`;
      if (/2\.02|results|earnings|financial/i.test(text)) return filing;
    }
  }
  return null;
}

function nextSecCheckAt(event: EarningsEventRow, now: Date): string {
  const days = daysSinceScheduled(event.scheduledDate, now);
  if (days > 7) return addHours(now, 24);
  return addHours(now, 4);
}

async function updateEvent(db: D1Database, id: string, assignments: Record<string, unknown>): Promise<void> {
  const entries = Object.entries(assignments);
  if (entries.length === 0) return;
  const setSql = entries.map(([key]) => `${key} = ?`).join(", ");
  await db.prepare(
    `UPDATE earnings_events SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).bind(...entries.map(([, value]) => value), id).run();
}

function refreshResultLooksFresh(result: { latestFiledAt: string | null; skipped?: boolean }, event: EarningsEventRow): boolean {
  if (result.skipped) return false;
  const latestFiledDate = normalizeDate(result.latestFiledAt);
  if (!latestFiledDate) return false;
  return latestFiledDate >= isoDateDaysBefore(event.scheduledDate, 1);
}

async function markRefreshSuccess(db: D1Database, event: EarningsEventRow, refreshedAt: string, result: { latestFiledAt: string | null; skipped?: boolean; rowsUpserted: number }): Promise<"fundamentals_refreshed" | "reported_pending_sec" | "unsupported_filer"> {
  if (result.rowsUpserted <= 0 && !result.skipped) {
    await updateEvent(db, event.id, {
      status: "unsupported_filer",
      fundamentals_refreshed_at: refreshedAt,
      next_check_at: null,
      last_error: "SEC companyfacts returned no supported revenue/net income rows.",
    });
    return "unsupported_filer";
  }
  if (!refreshResultLooksFresh(result, event)) {
    await updateEvent(db, event.id, {
      status: "reported_pending_sec",
      next_check_at: addHours(new Date(refreshedAt), 4),
      last_error: null,
    });
    return "reported_pending_sec";
  }
  await updateEvent(db, event.id, {
    status: "fundamentals_refreshed",
    fundamentals_refreshed_at: refreshedAt,
    next_check_at: null,
    last_error: null,
  });
  return "fundamentals_refreshed";
}

async function refreshFundamentalsForEvent(db: D1Database, env: Env, event: EarningsEventRow): Promise<{ status: EarningsEventStatus; rowsUpserted: number; error: string | null }> {
  try {
    const cached = await loadLatestCachedFundamentalPeriod(env, event.ticker);
    const result = await refreshTickerFundamentals(env, event.ticker, {
      maxRows: 16,
      onlyIfNewerThanPeriodEnd: cached?.periodEnd ?? null,
    });
    const status = await markRefreshSuccess(db, event, result.refreshedAt, result);
    return { status, rowsUpserted: result.rowsUpserted, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to refresh SEC fundamentals.";
    await updateEvent(db, event.id, {
      status: "refresh_error",
      attempts: Number(event.attempts ?? 0) + 1,
      last_error: message,
      next_check_at: addHours(new Date(), 12),
    });
    return { status: "refresh_error", rowsUpserted: 0, error: message };
  }
}

async function loadDueEvents(db: D1Database, now: Date, limit: number): Promise<EarningsEventRow[]> {
  const today = easternDateParts(now).date;
  const rows = await db.prepare(
    `SELECT
       id, ticker, cik, company_name as companyName, scheduled_date as scheduledDate,
       time_hint as timeHint, fiscal_period as fiscalPeriod, eps_actual as epsActual,
       revenue_actual as revenueActual, status, attempts, sec_form as secForm, sec_accession as secAccession
     FROM earnings_events
     WHERE status IN ('scheduled', 'reported_pending_sec', 'sec_ready', 'refresh_error')
       AND scheduled_date <= ?
       AND (next_check_at IS NULL OR datetime(next_check_at) <= datetime(?))
     ORDER BY
       CASE status
         WHEN 'sec_ready' THEN 0
         WHEN 'reported_pending_sec' THEN 1
         WHEN 'refresh_error' THEN 2
         ELSE 3
       END,
       scheduled_date ASC,
       ticker ASC
     LIMIT ?`,
  ).bind(today, now.toISOString(), limit).all<EarningsEventRow>();
  return rows.results ?? [];
}

async function processOneEvent(db: D1Database, env: Env, event: EarningsEventRow, now: Date): Promise<{ ticker: string; previousStatus: EarningsEventStatus; status: EarningsEventStatus | "waiting_window"; rowsUpserted: number; secForm: string | null; error: string | null }> {
  if (!hasEarningsReleaseWindowPassed(event, now)) {
    await updateEvent(db, event.id, { next_check_at: addHours(now, 1) });
    return { ticker: event.ticker, previousStatus: event.status, status: "waiting_window", rowsUpserted: 0, secForm: null, error: null };
  }

  const days = daysSinceScheduled(event.scheduledDate, now);
  if (days >= 45) {
    await updateEvent(db, event.id, {
      status: "sec_pending_timeout",
      next_check_at: null,
      last_error: "No SEC filing or refreshed companyfacts were detected within 45 days of the scheduled earnings date.",
    });
    return { ticker: event.ticker, previousStatus: event.status, status: "sec_pending_timeout", rowsUpserted: 0, secForm: null, error: null };
  }

  if (event.status !== "sec_ready") {
    await updateEvent(db, event.id, {
      status: "reported_pending_sec",
      last_sec_checked_at: now.toISOString(),
    });
    try {
      const filings = await fetchRecentFilings(event.cik, env, 12);
      const filing = findRelevantEarningsFiling(filings, event.scheduledDate);
      if (filing) {
        await updateEvent(db, event.id, {
          status: "sec_ready",
          sec_form: filing.form,
          sec_accession: filing.accessionNumber,
          release_confirmed_at: now.toISOString(),
          last_error: null,
        });
        const refreshed = await refreshFundamentalsForEvent(db, env, { ...event, status: "sec_ready", secForm: filing.form, secAccession: filing.accessionNumber });
        return { ticker: event.ticker, previousStatus: event.status, status: refreshed.status, rowsUpserted: refreshed.rowsUpserted, secForm: filing.form, error: refreshed.error };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "SEC filing check failed.";
      await updateEvent(db, event.id, {
        status: "reported_pending_sec",
        attempts: Number(event.attempts ?? 0) + 1,
        last_error: message,
        next_check_at: nextSecCheckAt(event, now),
      });
      return { ticker: event.ticker, previousStatus: event.status, status: "reported_pending_sec", rowsUpserted: 0, secForm: null, error: message };
    }
  }

  const hasProviderActuals = event.epsActual != null || event.revenueActual != null;
  if (event.status === "sec_ready" || hasProviderActuals || days >= 1) {
    const refreshed = await refreshFundamentalsForEvent(db, env, event);
    if (refreshed.status === "fundamentals_refreshed" || refreshed.status === "unsupported_filer" || refreshed.status === "refresh_error") {
      return { ticker: event.ticker, previousStatus: event.status, status: refreshed.status, rowsUpserted: refreshed.rowsUpserted, secForm: event.secForm, error: refreshed.error };
    }
  }

  await updateEvent(db, event.id, {
    status: "reported_pending_sec",
    next_check_at: nextSecCheckAt(event, now),
    last_error: null,
  });
  return { ticker: event.ticker, previousStatus: event.status, status: "reported_pending_sec", rowsUpserted: 0, secForm: null, error: null };
}

export async function processDueEarningsFundamentalRefreshes(
  env: Env,
  options: { limit?: number; now?: Date } = {},
): Promise<{ ok: boolean; attempted: number; rows: Array<{ ticker: string; previousStatus: string; status: string; rowsUpserted: number; secForm: string | null; error: string | null }> }> {
  const db = await requireEarningsSchema(env);
  const limit = Math.max(1, Math.min(10, Number(options.limit ?? 5)));
  const now = options.now ?? new Date();
  const events = await loadDueEvents(db, now, limit);
  const rows = [];
  for (const event of events) {
    rows.push(await processOneEvent(db, env, event, now));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: true, attempted: events.length, rows };
}

export async function maybeRunScheduledEarningsCalendarSync(env: Env, now = new Date()): Promise<null | Awaited<ReturnType<typeof syncEarningsCalendarFromProviders>>> {
  if (!env.ALPHA_VANTAGE_API_KEY && !env.FINNHUB_API_KEY && !env.FMP_API_KEY) return null;
  const db = fundamentalsDb(env);
  if (!db || !(await hasEarningsSchema(db))) return null;
  const latest = await db.prepare(
    "SELECT last_success_at as lastSuccessAt FROM earnings_calendar_syncs WHERE status = 'ok' ORDER BY datetime(last_success_at) DESC LIMIT 1",
  ).first<{ lastSuccessAt: string | null }>();
  const lastSuccessTime = latest?.lastSuccessAt ? Date.parse(latest.lastSuccessAt) : 0;
  if (Number.isFinite(lastSuccessTime) && now.getTime() - lastSuccessTime < 20 * 60 * 60_000) return null;
  return syncEarningsCalendarFromProviders(env, { now });
}

export async function loadEarningsRefreshStatus(env: Env): Promise<{
  schemaReady: boolean;
  counts: Record<string, number>;
  dueCount: number;
  syncs: Array<Record<string, unknown>>;
  upcoming: Array<Record<string, unknown>>;
  warning: string | null;
}> {
  const db = fundamentalsDb(env);
  if (!db) {
    return { schemaReady: false, counts: {}, dueCount: 0, syncs: [], upcoming: [], warning: "FUNDAMENTALS_DB binding is not configured." };
  }
  if (!(await hasEarningsSchema(db))) {
    return { schemaReady: false, counts: {}, dueCount: 0, syncs: [], upcoming: [], warning: "Earnings schema is missing. Apply worker/fundamentals-migrations/0002_earnings_events.sql." };
  }
  const now = new Date();
  const today = easternDateParts(now).date;
  const [countsResult, due, syncs, upcoming] = await Promise.all([
    db.prepare("SELECT status, COUNT(*) as count FROM earnings_events GROUP BY status ORDER BY status ASC").all<{ status: string; count: number }>(),
    db.prepare(
      `SELECT COUNT(*) as count
       FROM earnings_events
       WHERE status IN ('scheduled', 'reported_pending_sec', 'sec_ready', 'refresh_error')
         AND scheduled_date <= ?
         AND (next_check_at IS NULL OR datetime(next_check_at) <= datetime(?))`,
    ).bind(today, now.toISOString()).first<{ count: number }>(),
    db.prepare("SELECT provider, status, horizon, last_started_at as lastStartedAt, last_success_at as lastSuccessAt, last_error as lastError, rows_seen as rowsSeen, rows_upserted as rowsUpserted, updated_at as updatedAt FROM earnings_calendar_syncs ORDER BY provider ASC").all<Record<string, unknown>>(),
    db.prepare(
      `SELECT ticker, company_name as companyName, scheduled_date as scheduledDate, time_hint as timeHint, fiscal_period as fiscalPeriod, provider, status, next_check_at as nextCheckAt
       FROM earnings_events
       WHERE scheduled_date >= ?
       ORDER BY scheduled_date ASC, ticker ASC
       LIMIT 25`,
    ).bind(today).all<Record<string, unknown>>(),
  ]);
  return {
    schemaReady: true,
    counts: Object.fromEntries((countsResult.results ?? []).map((row) => [row.status, row.count])),
    dueCount: Number(due?.count ?? 0),
    syncs: syncs.results ?? [],
    upcoming: upcoming.results ?? [],
    warning: null,
  };
}
