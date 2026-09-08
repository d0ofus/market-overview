import { getMarketDataDb } from "./market-data-db";
import { meteredFetch } from "./provider-usage";
import type { Env } from "./types";

export type StoredMarketSession = {
  sessionDate: string;
  openAt: string;
  closeAt: string;
};

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function validDate(date: unknown): date is string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}

function validTime(time: unknown): time is string {
  return typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
}

export function parseAlpacaCalendarRows(rows: unknown): StoredMarketSession[] {
  if (!Array.isArray(rows)) throw new Error("Alpaca calendar response is not an array.");
  const sessions = new Map<string, StoredMarketSession>();
  for (const value of rows) {
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const { date: sessionDate, open: openAt, close: closeAt } = row;
    if (!validDate(sessionDate) || !validTime(openAt) || !validTime(closeAt) || openAt >= closeAt
      || [0, 6].includes(new Date(`${sessionDate}T00:00:00Z`).getUTCDay())) {
      throw new Error("Alpaca calendar contains an invalid session date or trading interval.");
    }
    const previous = sessions.get(sessionDate);
    if (previous && (previous.openAt !== openAt || previous.closeAt !== closeAt)) {
      throw new Error(`Alpaca calendar contains conflicting sessions for ${sessionDate}.`);
    }
    sessions.set(sessionDate, { sessionDate, openAt, closeAt });
  }
  return Array.from(sessions.values()).sort((left, right) => left.sessionDate.localeCompare(right.sessionDate));
}

export async function loadStoredMarketSession(env: Env, sessionDate: string): Promise<StoredMarketSession | null> {
  return await getMarketDataDb(env).prepare(
    `SELECT session_date as sessionDate, open_at as openAt, close_at as closeAt
       FROM market_calendar_sessions WHERE session_date = ? LIMIT 1`,
  ).bind(sessionDate).first<StoredMarketSession>();
}

export async function ensureMarketCalendarCoverage(env: Env, anchorDate: string, requiredStart?:string): Promise<void> {
  if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET) return;
  if (!validDate(anchorDate) || (requiredStart !== undefined && !validDate(requiredStart))) throw new Error("Invalid requested calendar date.");
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const latestAnchor = [anchorDate, today].sort().at(-1)!;
  const neededStart = [addDays(anchorDate, -2200), addDays(today, -2200), ...(requiredStart ? [requiredStart] : [])].sort()[0]!;
  const neededEnd = addDays(latestAnchor, 140);
  const db = getMarketDataDb(env);
  const stored = await db.prepare(
    "SELECT covered_start as coveredStart,covered_end as coveredEnd,verified_at as verifiedAt FROM market_calendar_refresh_state WHERE id='default'",
  ).first<{coveredStart:string;coveredEnd:string;verifiedAt:string}>().catch((error: unknown) => {
    if (error instanceof Error && /no such table/.test(error.message)) return null;
    throw error;
  });
  const existing = stored && validDate(stored.coveredStart) && validDate(stored.coveredEnd)
    && stored.coveredStart <= stored.coveredEnd && Number.isFinite(Date.parse(stored.verifiedAt)) ? stored : null;
  const age = existing ? now.getTime() - Date.parse(existing.verifiedAt) : Infinity;
  if (existing && existing.coveredStart <= neededStart && existing.coveredEnd >= addDays(latestAnchor, 130)
    && age >= 0 && age < 7 * 86400_000) {
    const counts = await db.prepare(`SELECT SUM(CASE WHEN session_date<=? THEN 1 ELSE 0 END) AS historical,
      SUM(CASE WHEN session_date>? THEN 1 ELSE 0 END) AS future
      FROM market_calendar_sessions WHERE session_date>=? AND session_date<=?`)
      .bind(anchorDate,latestAnchor,existing.coveredStart,existing.coveredEnd).first<{historical:number;future:number}>();
    if (counts && counts.historical >= 1300 && counts.future >= 90) return;
  }
  // Historical repair must never shorten the current calendar proof. Refetch
  // the union, including today's future sessions, and preserve any older range.
  const start = existing && existing.coveredStart < neededStart ? existing.coveredStart : neededStart;
  const end = existing && existing.coveredEnd > neededEnd ? existing.coveredEnd : neededEnd;

  const baseUrl = (env.ALPACA_TRADING_BASE_URL ?? "https://api.alpaca.markets").replace(/\/$/, "");
  const response = await meteredFetch(env, `${baseUrl}/v2/calendar?start=${start}&end=${end}`, {
    headers: {
      "APCA-API-KEY-ID": env.ALPACA_API_KEY,
      "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET,
      Accept: "application/json",
    },
  }, {
    providerKey: "alpaca",
    endpointKey: "market-calendar",
    caller: "market-data-lane",
  }, 15_000);
  if (!response.ok) throw new Error(`Alpaca calendar fetch failed (${response.status}).`);
  const sessions = parseAlpacaCalendarRows(await response.json());
  if (sessions.filter((session) => session.sessionDate <= anchorDate).length < 1300
    || sessions.filter((session) => session.sessionDate > latestAnchor).length < 90
    || !sessions[0] || sessions[0].sessionDate > addDays(start,7)
    || sessions.at(-1)!.sessionDate < addDays(end,-7)
    || sessions.some((session) => session.sessionDate < start || session.sessionDate > end)
    || sessions.some((session,index) => index > 0 && session.sessionDate > addDays(sessions[index-1]!.sessionDate,7))) {
    throw new Error("Alpaca calendar lacks the required historical or 90-session future coverage.");
  }
  const verifiedAt = new Date().toISOString();
  const cached = await db.prepare("SELECT session_date AS date FROM market_calendar_sessions WHERE session_date>=? AND session_date<=?")
    .bind(start,end).all<{date:string}>();
  const officialDates = new Set(sessions.map((session) => session.sessionDate));
  const removedDates = cached.results.map((row) => row.date).filter((date) => !officialDates.has(date));
  for (let offset = 0; offset < sessions.length; offset += 400) await db.prepare(
    `INSERT INTO market_calendar_sessions (session_date, open_at, close_at, source, fetched_at)
     SELECT json_extract(value,'$.sessionDate'),json_extract(value,'$.openAt'),
       json_extract(value,'$.closeAt'),'alpaca-calendar',?
     FROM json_each(?) WHERE 1
     ON CONFLICT(session_date) DO UPDATE SET
       open_at = excluded.open_at,
       close_at = excluded.close_at,
       source = excluded.source,
       fetched_at = excluded.fetched_at
     WHERE market_calendar_sessions.open_at <> excluded.open_at
        OR market_calendar_sessions.close_at <> excluded.close_at`,
  ).bind(verifiedAt,JSON.stringify(sessions.slice(offset,offset+400))).run();
  // Absence is authoritative only after validating the whole refetched range.
  // Delete explicit obsolete dates in bounded statements; unrelated rows remain.
  for (let offset = 0; offset < removedDates.length; offset += 400) await db.prepare(
    "DELETE FROM market_calendar_sessions WHERE session_date IN (SELECT value FROM json_each(?))",
  ).bind(JSON.stringify(removedDates.slice(offset,offset+400))).run();
  await db.prepare(
    `INSERT INTO market_calendar_refresh_state(id,covered_start,covered_end,verified_at)
     VALUES('default',?,?,?) ON CONFLICT(id) DO UPDATE SET covered_start=MIN(covered_start,excluded.covered_start),
       covered_end=MAX(covered_end,excluded.covered_end),verified_at=MAX(verified_at,excluded.verified_at)`,
  ).bind(start,end,verifiedAt).run();
}
