import type {
  AlertFilterInput,
  AlertLogRow,
  AlertTickerDayRow,
  AlertsSessionFilter,
  InboundEmailPayload,
  IngestAlertResult,
  NormalizedAlertFilters,
  ReconcileAlertsResult,
  TickerNewsRow,
} from "./alerts-types";
import type { Env } from "./types";
import { classifyAlertTimestamp, defaultTradingDayNow, subtractDaysIso } from "./alerts-time";
import { isLikelyExchangeCode, parseTradingViewAlertEmail } from "./alerts-parser";
import { fetchTickerNews } from "./alerts-news";

const DEFAULT_RETENTION_DAYS = 30;
const ALERT_TICKER_REPAIR_INTERVAL_MS = 5 * 60_000;
const ALERT_TICKER_REPAIR_LOOKBACK_DAYS = 30;
const ALERT_TICKER_REPAIR_SCAN_LIMIT = 150;
const ALERTS_TICKER_DAY_NEWS_BATCH_SIZE = 100;

const SESSION_VALUES: AlertsSessionFilter[] = ["all", "premarket", "regular", "after-hours"];
let lastAlertTickerRepairAt = 0;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

function addDaysIso(isoDate: string, days: number): string {
  const value = new Date(`${isoDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function simpleHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function safeString(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function toJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseStoredRawPayloadJson(rawPayloadJson: string | null): unknown {
  if (!rawPayloadJson) return null;
  try {
    return JSON.parse(rawPayloadJson);
  } catch {
    return rawPayloadJson;
  }
}

function getHeader(payload: InboundEmailPayload, key: string): string | null {
  const headers = payload.headers;
  if (!headers) return null;
  const lower = key.toLowerCase();
  for (const [name, raw] of Object.entries(headers)) {
    if (name.toLowerCase() !== lower) continue;
    if (Array.isArray(raw)) return safeString(raw[0] ?? "") || null;
    return safeString(raw ?? "") || null;
  }
  return null;
}

function normalizeMessageId(payload: InboundEmailPayload): string {
  const fromPayload = safeString(payload.messageId ?? "").replace(/[<>]/g, "");
  const fromHeader = safeString(getHeader(payload, "message-id") ?? "").replace(/[<>]/g, "");
  const picked = fromPayload || fromHeader;
  if (picked) return picked.slice(0, 320);

  const fallbackSeed = [
    safeString(payload.subject),
    safeString(payload.from),
    safeString(payload.receivedAt),
    safeString(payload.text).slice(0, 400),
    safeString(payload.html).slice(0, 400),
  ].join("|");
  return `generated-${simpleHash(fallbackSeed)}`;
}

export function buildAlertDedupeSeed(input: {
  messageId: string;
  ticker: string;
  tradingDay: string;
  marketSession: string;
  alertType: string | null;
  strategyName: string | null;
  messageBody: string;
  receivedAtUtc: string;
}): string {
  return [
    input.messageId,
    input.ticker.toUpperCase(),
    input.tradingDay,
    input.marketSession,
    input.alertType ?? "",
    input.strategyName ?? "",
    input.receivedAtUtc.slice(0, 16),
    input.messageBody.slice(0, 260),
  ].join("|");
}

async function loadEmailByMessageId(env: Env, messageId: string): Promise<{
  id: string;
  parseStatus: string | null;
  parsedAlertId: string | null;
  parsedTicker: string | null;
  parsedTradingDay: string | null;
} | null> {
  return env.DB.prepare(
    "SELECT id, parse_status as parseStatus, parsed_alert_id as parsedAlertId, parsed_ticker as parsedTicker, parsed_trading_day as parsedTradingDay FROM tv_alert_emails WHERE message_id = ? LIMIT 1",
  )
    .bind(messageId)
    .first<{
      id: string;
      parseStatus: string | null;
      parsedAlertId: string | null;
      parsedTicker: string | null;
      parsedTradingDay: string | null;
    }>();
}

async function ensureRawEmailStored(env: Env, payload: InboundEmailPayload): Promise<{
  emailId: string;
  messageId: string;
  inserted: boolean;
  existing: {
    parseStatus: string | null;
    parsedAlertId: string | null;
    parsedTicker: string | null;
    parsedTradingDay: string | null;
  } | null;
}> {
  const messageId = normalizeMessageId(payload);
  const emailId = crypto.randomUUID();
  const subject = safeString(payload.subject) || null;
  const from = safeString(payload.from) || getHeader(payload, "from") || null;
  const sourceMailbox = safeString(payload.sourceMailbox) || getHeader(payload, "to") || null;
  const receivedAtRaw = safeString(payload.receivedAt) || null;

  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO tv_alert_emails (id, message_id, source_mailbox, raw_email_subject, raw_email_from, raw_email_received_at, raw_headers_json, raw_text, raw_html, raw_payload_json, parse_status, parse_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, CURRENT_TIMESTAMP)",
  )
    .bind(
      emailId,
      messageId,
      sourceMailbox,
      subject,
      from,
      receivedAtRaw,
      toJson(payload.headers),
      payload.text ?? null,
      payload.html ?? null,
      toJson(payload.rawPayload),
    )
    .run();

  const inserted = (result.meta?.changes ?? 0) > 0;
  if (inserted) {
    return {
      emailId,
      messageId,
      inserted,
      existing: null,
    };
  }

  const existing = await loadEmailByMessageId(env, messageId);
  return {
    emailId: existing?.id ?? emailId,
    messageId,
    inserted: false,
    existing: existing
      ? {
          parseStatus: existing.parseStatus,
          parsedAlertId: existing.parsedAlertId,
          parsedTicker: existing.parsedTicker,
          parsedTradingDay: existing.parsedTradingDay,
        }
      : null,
  };
}

async function markEmailParseFailed(env: Env, emailId: string, error: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE tv_alert_emails SET parse_status = 'parse_failed', parse_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(error.slice(0, 1000), emailId)
    .run();
}

async function markEmailParsed(
  env: Env,
  emailId: string,
  alertId: string,
  ticker: string,
  tradingDay: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE tv_alert_emails SET parse_status = 'parsed', parse_error = NULL, parsed_alert_id = ?, parsed_ticker = ?, parsed_trading_day = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(alertId, ticker, tradingDay, emailId)
    .run();
}

async function upsertAlert(env: Env, input: {
  emailId: string;
  messageId: string;
  ticker: string;
  alertType: string | null;
  strategyName: string | null;
  rawPayload: string;
  rawEmailSubject: string | null;
  rawEmailFrom: string | null;
  rawEmailReceivedAt: string | null;
  receivedAtUtc: string;
  marketSession: "premarket" | "regular" | "after-hours";
  tradingDay: string;
}): Promise<{ alertId: string; inserted: boolean }> {
  const dedupeSeed = buildAlertDedupeSeed({
    messageId: input.messageId,
    ticker: input.ticker,
    tradingDay: input.tradingDay,
    marketSession: input.marketSession,
    alertType: input.alertType,
    strategyName: input.strategyName,
    messageBody: input.rawPayload,
    receivedAtUtc: input.receivedAtUtc,
  });
  const normalizedKey = `${input.ticker}|${input.tradingDay}|${simpleHash(dedupeSeed)}`;

  const alertId = crypto.randomUUID();
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO tv_alerts (id, email_id, ticker, alert_type, strategy_name, raw_payload, raw_email_subject, raw_email_from, raw_email_received_at, received_at, market_session, trading_day, source, normalized_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'email', ?, CURRENT_TIMESTAMP)",
  )
    .bind(
      alertId,
      input.emailId,
      input.ticker,
      input.alertType,
      input.strategyName,
      input.rawPayload,
      input.rawEmailSubject,
      input.rawEmailFrom,
      input.rawEmailReceivedAt,
      input.receivedAtUtc,
      input.marketSession,
      input.tradingDay,
      normalizedKey,
    )
    .run();

  const inserted = (result.meta?.changes ?? 0) > 0;
  if (inserted) return { alertId, inserted: true };

  const existing = await env.DB.prepare("SELECT id FROM tv_alerts WHERE normalized_key = ? LIMIT 1")
    .bind(normalizedKey)
    .first<{ id: string }>();
  return {
    alertId: existing?.id ?? alertId,
    inserted: false,
  };
}

async function enrichTickerNewsIfNeeded(env: Env, ticker: string, tradingDay: string): Promise<number> {
  const fetched = await fetchTickerNews(env, ticker, tradingDay, 3);
  if (fetched.rows.length === 0) return 0;

  let inserted = 0;
  for (const row of fetched.rows) {
    const result = await env.DB.prepare(
      "INSERT OR IGNORE INTO ticker_news (id, ticker, trading_day, headline, source, url, published_at, snippet, fetched_at, canonical_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
    )
      .bind(
        crypto.randomUUID(),
        row.ticker,
        row.tradingDay,
        row.headline,
        row.source,
        row.url,
        row.publishedAt,
        row.snippet,
        row.fetchedAt,
        row.canonicalKey,
      )
      .run();
    inserted += result.meta?.changes ?? 0;
  }

  return inserted;
}

async function repairMisparsedExchangeTickers(env: Env): Promise<void> {
  const now = Date.now();
  if (now - lastAlertTickerRepairAt < ALERT_TICKER_REPAIR_INTERVAL_MS) return;
  lastAlertTickerRepairAt = now;

  const cutoff = `${subtractDaysIso(defaultTradingDayNow(), ALERT_TICKER_REPAIR_LOOKBACK_DAYS - 1)}T00:00:00.000Z`;
  const rows = await env.DB.prepare(
    "SELECT a.id as alertId, a.email_id as emailId, a.ticker as alertTicker, a.alert_type as alertType, a.strategy_name as strategyName, a.raw_payload as rawPayload, a.received_at as receivedAt, a.market_session as marketSession, a.trading_day as tradingDay, e.message_id as messageId, e.raw_email_subject as subject, e.raw_email_from as emailFrom, e.raw_email_received_at as rawEmailReceivedAt, e.raw_text as rawText, e.raw_html as rawHtml, e.raw_payload_json as rawPayloadJson, e.parsed_ticker as parsedTicker FROM tv_alerts a LEFT JOIN tv_alert_emails e ON e.id = a.email_id WHERE a.received_at >= ? ORDER BY datetime(a.received_at) DESC LIMIT ?",
  )
    .bind(cutoff, ALERT_TICKER_REPAIR_SCAN_LIMIT)
    .all<{
      alertId: string;
      emailId: string | null;
      alertTicker: string;
      alertType: string | null;
      strategyName: string | null;
      rawPayload: string | null;
      receivedAt: string;
      marketSession: "premarket" | "regular" | "after-hours";
      tradingDay: string;
      messageId: string | null;
      subject: string | null;
      emailFrom: string | null;
      rawEmailReceivedAt: string | null;
      rawText: string | null;
      rawHtml: string | null;
      rawPayloadJson: string | null;
      parsedTicker: string | null;
    }>();

  for (const row of rows.results ?? []) {
    if (!isLikelyExchangeCode(row.alertTicker) && !isLikelyExchangeCode(row.parsedTicker)) continue;
    const reparsed = parseTradingViewAlertEmail({
      messageId: row.messageId,
      subject: row.subject,
      from: row.emailFrom,
      receivedAt: row.rawEmailReceivedAt ?? row.receivedAt,
      text: row.rawText,
      html: row.rawHtml,
      rawPayload: parseStoredRawPayloadJson(row.rawPayloadJson),
    });
    const nextTicker = reparsed?.ticker?.toUpperCase() ?? null;
    if (!nextTicker || isLikelyExchangeCode(nextTicker) || nextTicker === row.alertTicker) continue;

    const messageId = row.messageId ?? `repair-${row.alertId}`;
    const dedupeSeed = buildAlertDedupeSeed({
      messageId,
      ticker: nextTicker,
      tradingDay: row.tradingDay,
      marketSession: row.marketSession,
      alertType: row.alertType,
      strategyName: row.strategyName,
      messageBody: row.rawPayload ?? reparsed?.messageBody ?? "",
      receivedAtUtc: row.receivedAt,
    });
    const normalizedKey = `${nextTicker}|${row.tradingDay}|${simpleHash(dedupeSeed)}`;
    const conflicting = await env.DB.prepare("SELECT id FROM tv_alerts WHERE normalized_key = ? AND id <> ? LIMIT 1")
      .bind(normalizedKey, row.alertId)
      .first<{ id: string }>();

    if (conflicting?.id) {
      await env.DB.prepare("DELETE FROM tv_alerts WHERE id = ?").bind(row.alertId).run();
      if (row.emailId) {
        await env.DB.prepare(
          "UPDATE tv_alert_emails SET parsed_alert_id = ?, parsed_ticker = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
          .bind(conflicting.id, nextTicker, row.emailId)
          .run();
      }
      continue;
    }

    await env.DB.prepare(
      "UPDATE tv_alerts SET ticker = ?, normalized_key = ? WHERE id = ?",
    )
      .bind(nextTicker, normalizedKey, row.alertId)
      .run();

    if (row.emailId) {
      await env.DB.prepare(
        "UPDATE tv_alert_emails SET parsed_ticker = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
        .bind(nextTicker, row.emailId)
        .run();
    }

    await enrichTickerNewsIfNeeded(env, nextTicker, row.tradingDay);
  }
}

export async function ingestTradingViewAlertEmail(env: Env, payload: InboundEmailPayload): Promise<IngestAlertResult> {
  const rawEmail = await ensureRawEmailStored(env, payload);

  if (!rawEmail.inserted && rawEmail.existing?.parseStatus === "parsed") {
    return {
      emailId: rawEmail.emailId,
      alertId: rawEmail.existing.parsedAlertId,
      messageId: rawEmail.messageId,
      status: "duplicate",
      ticker: rawEmail.existing.parsedTicker,
      tradingDay: rawEmail.existing.parsedTradingDay,
      newsInserted: 0,
    };
  }

  const parsed = parseTradingViewAlertEmail(payload);
  if (!parsed) {
    const message = "Unable to extract ticker or alert metadata from email body/subject.";
    await markEmailParseFailed(env, rawEmail.emailId, message);
    return {
      emailId: rawEmail.emailId,
      alertId: null,
      messageId: rawEmail.messageId,
      status: "parse_failed",
      ticker: null,
      tradingDay: null,
      newsInserted: 0,
      error: message,
    };
  }

  const timestamp = classifyAlertTimestamp(payload.receivedAt ?? null);
  const alertResult = await upsertAlert(env, {
    emailId: rawEmail.emailId,
    messageId: rawEmail.messageId,
    ticker: parsed.ticker,
    alertType: parsed.alertType,
    strategyName: parsed.strategyName,
    rawPayload: parsed.messageBody,
    rawEmailSubject: safeString(payload.subject) || null,
    rawEmailFrom: safeString(payload.from) || getHeader(payload, "from") || null,
    rawEmailReceivedAt: safeString(payload.receivedAt) || null,
    receivedAtUtc: timestamp.receivedAtUtc,
    marketSession: timestamp.marketSession,
    tradingDay: timestamp.tradingDay,
  });

  await markEmailParsed(env, rawEmail.emailId, alertResult.alertId, parsed.ticker, timestamp.tradingDay);
  const newsInserted = await enrichTickerNewsIfNeeded(env, parsed.ticker, timestamp.tradingDay);

  return {
    emailId: rawEmail.emailId,
    alertId: alertResult.alertId,
    messageId: rawEmail.messageId,
    status: alertResult.inserted ? "ingested" : "duplicate",
    ticker: parsed.ticker,
    tradingDay: timestamp.tradingDay,
    newsInserted,
  };
}

export async function ingestTradingViewAlertEmailsBatch(env: Env, emails: InboundEmailPayload[]): Promise<{
  results: IngestAlertResult[];
  ingested: number;
  duplicates: number;
  parseFailures: number;
}> {
  const results: IngestAlertResult[] = [];
  let ingested = 0;
  let duplicates = 0;
  let parseFailures = 0;

  for (const email of emails) {
    try {
      const result = await ingestTradingViewAlertEmail(env, email);
      results.push(result);
      if (result.status === "ingested") ingested += 1;
      else if (result.status === "duplicate") duplicates += 1;
      else parseFailures += 1;
    } catch (error) {
      parseFailures += 1;
      results.push({
        emailId: "unknown",
        alertId: null,
        messageId: normalizeMessageId(email),
        status: "parse_failed",
        ticker: null,
        tradingDay: null,
        newsInserted: 0,
        error: error instanceof Error ? error.message : "ingestion failed",
      });
    }
  }

  return { results, ingested, duplicates, parseFailures };
}

export function normalizeAlertFilters(input: AlertFilterInput): NormalizedAlertFilters {
  const requestedEnd = toIsoDate(input.endDate ?? null);
  const endDate = requestedEnd ?? defaultTradingDayNow();
  const requestedStart = toIsoDate(input.startDate ?? null);
  const defaultStart = subtractDaysIso(endDate, DEFAULT_RETENTION_DAYS - 1);
  const startDate = requestedStart ?? defaultStart;
  const sorted = startDate <= endDate ? { startDate, endDate } : { startDate: endDate, endDate: startDate };

  const sessionRaw = safeString(input.session ?? "all").toLowerCase();
  const session = SESSION_VALUES.includes(sessionRaw as AlertsSessionFilter)
    ? (sessionRaw as AlertsSessionFilter)
    : "all";

  const limit = clamp(Number(input.limit ?? 300), 1, 3000);

  return {
    startDate: sorted.startDate,
    endDate: sorted.endDate,
    session,
    limit,
  };
}

export async function queryAlertsByFilters(env: Env, filterInput: AlertFilterInput): Promise<{
  filters: NormalizedAlertFilters;
  rows: AlertLogRow[];
}> {
  await repairMisparsedExchangeTickers(env);
  const filters = normalizeAlertFilters(filterInput);

  const rows = await env.DB.prepare(
    "SELECT id, ticker, alert_type as alertType, strategy_name as strategyName, raw_payload as rawPayload, raw_email_subject as rawEmailSubject, raw_email_from as rawEmailFrom, raw_email_received_at as rawEmailReceivedAt, received_at as receivedAt, market_session as marketSession, trading_day as tradingDay, source, created_at as createdAt FROM tv_alerts WHERE trading_day >= ? AND trading_day <= ? AND (? = 'all' OR market_session = ?) ORDER BY datetime(received_at) DESC LIMIT ?",
  )
    .bind(filters.startDate, filters.endDate, filters.session, filters.session, filters.limit)
    .all<AlertLogRow>();

  return {
    filters,
    rows: rows.results ?? [],
  };
}

async function loadNewsForTickerDays(env: Env, pairs: Array<{ ticker: string; tradingDay: string }>): Promise<Map<string, TickerNewsRow[]>> {
  const newsByKey = new Map<string, TickerNewsRow[]>();
  if (pairs.length === 0) return newsByKey;
  const requestedKeys = new Set(pairs.map((pair) => `${pair.ticker}|${pair.tradingDay}`));
  const tradingDays = Array.from(new Set(pairs.map((pair) => pair.tradingDay))).filter(Boolean);

  for (let index = 0; index < tradingDays.length; index += ALERTS_TICKER_DAY_NEWS_BATCH_SIZE) {
    const batchDays = tradingDays.slice(index, index + ALERTS_TICKER_DAY_NEWS_BATCH_SIZE);
    const placeholders = batchDays.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT id, ticker, trading_day as tradingDay, headline, source, url, published_at as publishedAt, snippet, fetched_at as fetchedAt FROM ticker_news WHERE trading_day IN (${placeholders}) ORDER BY trading_day DESC, ticker ASC, datetime(COALESCE(published_at, fetched_at)) DESC`,
    )
      .bind(...batchDays)
      .all<TickerNewsRow>();

    for (const row of rows.results ?? []) {
      const key = `${row.ticker}|${row.tradingDay}`;
      if (!requestedKeys.has(key)) continue;
      const current = newsByKey.get(key) ?? [];
      if (current.length >= 3) continue;
      current.push(row);
      newsByKey.set(key, current);
    }
  }

  return newsByKey;
}

export async function queryUniqueTickerDaysByFilters(env: Env, filterInput: AlertFilterInput): Promise<{
  filters: NormalizedAlertFilters;
  rows: AlertTickerDayRow[];
}> {
  await repairMisparsedExchangeTickers(env);
  const filters = normalizeAlertFilters(filterInput);

  const grouped = await env.DB.prepare(
    "SELECT t1.ticker as ticker, t1.trading_day as tradingDay, MAX(t1.received_at) as latestReceivedAt, COUNT(*) as alertCount, (SELECT t2.market_session FROM tv_alerts t2 WHERE t2.ticker = t1.ticker AND t2.trading_day = t1.trading_day ORDER BY datetime(t2.received_at) DESC LIMIT 1) as marketSession FROM tv_alerts t1 WHERE t1.trading_day >= ? AND t1.trading_day <= ? AND (? = 'all' OR t1.market_session = ?) GROUP BY t1.ticker, t1.trading_day ORDER BY datetime(latestReceivedAt) DESC LIMIT ?",
  )
    .bind(filters.startDate, filters.endDate, filters.session, filters.session, filters.limit)
    .all<{
      ticker: string;
      tradingDay: string;
      latestReceivedAt: string;
      alertCount: number;
      marketSession: "premarket" | "regular" | "after-hours";
    }>();

  const rows = grouped.results ?? [];
  const newsMap = await loadNewsForTickerDays(env, rows.map((row) => ({ ticker: row.ticker, tradingDay: row.tradingDay })));

  return {
    filters,
    rows: rows.map((row) => ({
      ticker: row.ticker,
      tradingDay: row.tradingDay,
      latestReceivedAt: row.latestReceivedAt,
      alertCount: row.alertCount,
      marketSession: row.marketSession,
      news: newsMap.get(`${row.ticker}|${row.tradingDay}`) ?? [],
    })),
  };
}

export async function cleanupOldAlertsData(env: Env, retentionDays = DEFAULT_RETENTION_DAYS): Promise<{
  deletedEmails: number;
  deletedAlerts: number;
  deletedNews: number;
}> {
  const window = `-${Math.max(1, retentionDays)} day`;
  const deleteAlerts = await env.DB.prepare("DELETE FROM tv_alerts WHERE datetime(received_at) < datetime('now', ?)")
    .bind(window)
    .run();
  const deleteNews = await env.DB.prepare(
    "DELETE FROM ticker_news WHERE date(trading_day) < date('now', ?) OR datetime(fetched_at) < datetime('now', ?)",
  )
    .bind(window, window)
    .run();
  await env.DB.prepare(
    "DELETE FROM ticker_news_fetch_cache WHERE date(trading_day) < date('now', ?) OR datetime(last_attempt_at) < datetime('now', ?)",
  )
    .bind(window, window)
    .run();
  const deleteEmails = await env.DB.prepare(
    "DELETE FROM tv_alert_emails WHERE datetime(COALESCE(raw_email_received_at, created_at)) < datetime('now', ?)",
  )
    .bind(window)
    .run();

  return {
    deletedEmails: deleteEmails.meta?.changes ?? 0,
    deletedAlerts: deleteAlerts.meta?.changes ?? 0,
    deletedNews: deleteNews.meta?.changes ?? 0,
  };
}

export interface AlertMailboxAdapter {
  readonly name: string;
  isConfigured(env: Env): boolean;
  pullPendingEmails(env: Env, maxEmails: number): Promise<InboundEmailPayload[]>;
}

class HttpMailboxSyncAdapter implements AlertMailboxAdapter {
  readonly name = "http-mailbox-sync";

  isConfigured(env: Env): boolean {
    return Boolean(env.ALERTS_MAILBOX_SYNC_URL);
  }

  async pullPendingEmails(env: Env, maxEmails: number): Promise<InboundEmailPayload[]> {
    const endpoint = env.ALERTS_MAILBOX_SYNC_URL;
    if (!endpoint) return [];

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.ALERTS_MAILBOX_SYNC_TOKEN ? { Authorization: `Bearer ${env.ALERTS_MAILBOX_SYNC_TOKEN}` } : {}),
      },
      body: JSON.stringify({ maxEmails }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`mailbox sync failed (${response.status}): ${body.slice(0, 140)}`);
    }

    const payload = (await response.json()) as { emails?: InboundEmailPayload[] };
    return Array.isArray(payload.emails) ? payload.emails : [];
  }
}

function configuredAdapters(env: Env): AlertMailboxAdapter[] {
  const adapters: AlertMailboxAdapter[] = [new HttpMailboxSyncAdapter()];
  return adapters.filter((adapter) => adapter.isConfigured(env));
}

export async function reconcileAlertsFromMailboxAdapters(env: Env, maxEmails = 20): Promise<ReconcileAlertsResult> {
  const adapters = configuredAdapters(env);
  let emailsPulled = 0;
  let alertsIngested = 0;
  let duplicates = 0;
  let parseFailures = 0;

  for (const adapter of adapters) {
    try {
      const pulled = await adapter.pullPendingEmails(env, maxEmails);
      emailsPulled += pulled.length;
      const batch = await ingestTradingViewAlertEmailsBatch(env, pulled);
      alertsIngested += batch.ingested;
      duplicates += batch.duplicates;
      parseFailures += batch.parseFailures;
    } catch (error) {
      console.error(`alerts mailbox adapter failed: ${adapter.name}`, error);
    }
  }

  return {
    adaptersChecked: adapters.length,
    emailsPulled,
    alertsIngested,
    duplicates,
    parseFailures,
  };
}
