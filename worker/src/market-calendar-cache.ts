import { getMarketDataDb } from "./market-data-db";
import { meteredFetch } from "./provider-usage";
import type { Env } from "./types";

type AlpacaCalendarRow = {
  date?: string;
  open?: string;
  close?: string;
};

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

export function parseAlpacaCalendarRows(rows: AlpacaCalendarRow[]): StoredMarketSession[] {
  return rows.flatMap((row) => {
    const sessionDate = String(row.date ?? "").trim();
    const openAt = String(row.open ?? "").trim();
    const closeAt = String(row.close ?? "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(sessionDate) && /^\d{2}:\d{2}$/.test(openAt) && /^\d{2}:\d{2}$/.test(closeAt)
      ? [{ sessionDate, openAt, closeAt }]
      : [];
  });
}

export async function loadStoredMarketSession(env: Env, sessionDate: string): Promise<StoredMarketSession | null> {
  return await getMarketDataDb(env).prepare(
    `SELECT session_date as sessionDate, open_at as openAt, close_at as closeAt
       FROM market_calendar_sessions WHERE session_date = ? LIMIT 1`,
  ).bind(sessionDate).first<StoredMarketSession>();
}

export async function ensureMarketCalendarCoverage(env: Env, anchorDate: string): Promise<void> {
  if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET) return;
  const start = addDays(anchorDate, -14);
  const end = addDays(anchorDate, 45);
  const existing = await getMarketDataDb(env).prepare(
    `SELECT MAX(session_date) as maxSessionDate, MAX(fetched_at) as fetchedAt
       FROM market_calendar_sessions
      WHERE session_date >= ? AND session_date <= ?`,
  ).bind(start, end).first<{ maxSessionDate: string | null; fetchedAt: string | null }>();
  const fetchedAt = existing?.fetchedAt ? Date.parse(existing.fetchedAt) : 0;
  if (existing?.maxSessionDate && existing.maxSessionDate >= end && Date.now() - fetchedAt < 7 * 86400_000) return;

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
  const sessions = parseAlpacaCalendarRows(await response.json() as AlpacaCalendarRow[]);
  if (sessions.length === 0) throw new Error("Alpaca calendar returned no valid sessions.");
  const statements = sessions.map((session) => getMarketDataDb(env).prepare(
    `INSERT INTO market_calendar_sessions (session_date, open_at, close_at, source, fetched_at)
     VALUES (?, ?, ?, 'alpaca-calendar', CURRENT_TIMESTAMP)
     ON CONFLICT(session_date) DO UPDATE SET
       open_at = excluded.open_at,
       close_at = excluded.close_at,
       source = excluded.source,
       fetched_at = CURRENT_TIMESTAMP
     WHERE market_calendar_sessions.open_at <> excluded.open_at
        OR market_calendar_sessions.close_at <> excluded.close_at`,
  ).bind(session.sessionDate, session.openAt, session.closeAt));
  for (let offset = 0; offset < statements.length; offset += 100) {
    await getMarketDataDb(env).batch(statements.slice(offset, offset + 100));
  }
}
