import { getMarketDataDb, marketDataFeed, recordMarketDataD1Usage } from "./market-data-db";
import { isUsMarketTradingDay } from "./market-calendar";
import type { Env } from "./types";

const COVERAGE_QUERY_CHUNK_SIZE = 80;

export type BarCoverageStatus = "complete" | "short-history" | "gaps" | "missing";

export type BarCoverage = {
  ticker: string;
  feed: string;
  requestedStart: string;
  observedStart: string | null;
  observedEnd: string | null;
  observedSessions: number;
  expectedSessions: number;
  missingSessions: number;
  status: BarCoverageStatus;
};

function normalizeTickers(tickers: string[]): string[] {
  return Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
}

function nextIsoDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function countExpectedUsMarketSessions(startDate: string, endDate: string): number {
  if (startDate > endDate) return 0;
  let count = 0;
  for (let cursor = startDate; cursor <= endDate; cursor = nextIsoDate(cursor)) {
    if (isUsMarketTradingDay(cursor)) count += 1;
  }
  return count;
}

export function coverageSatisfiesHistory(coverage: BarCoverage | undefined): boolean {
  if (coverage?.status === "complete") return true;
  // A full-range provider request may legitimately begin after requestedStart
  // for a newly listed symbol. Never let a lone current bar certify history.
  return coverage?.status === "short-history" && coverage.observedSessions >= 2;
}

export async function verifyMarketBarCoverage(
  env: Env,
  input: {
    tickers: string[];
    requestedStart: string;
    throughDate: string;
    feed?: string;
  },
): Promise<Map<string, BarCoverage>> {
  const tickers = normalizeTickers(input.tickers);
  const feed = input.feed ?? marketDataFeed(env);
  const db = getMarketDataDb(env);
  const coverageByTicker = new Map<string, BarCoverage>();
  let rowsRead = 0;

  for (let offset = 0; offset < tickers.length; offset += COVERAGE_QUERY_CHUNK_SIZE) {
    const chunk = tickers.slice(offset, offset + COVERAGE_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db.prepare(
      `SELECT ticker,
              MIN(date) as observedStart,
              MAX(date) as observedEnd,
              COUNT(*) as observedSessions
         FROM alpaca_daily_bars
        WHERE feed = ?
          AND ticker IN (${placeholders})
          AND date >= ?
          AND date <= ?
        GROUP BY ticker`,
    ).bind(feed, ...chunk, input.requestedStart, input.throughDate).all<{
      ticker: string;
      observedStart: string | null;
      observedEnd: string | null;
      observedSessions: number | string | null;
    }>();
    rowsRead += Number(result.meta?.rows_read ?? 0);
    const rows = new Map((result.results ?? []).map((row) => [row.ticker.toUpperCase(), row]));

    for (const ticker of chunk) {
      const row = rows.get(ticker);
      const observedStart = row?.observedStart ?? null;
      const observedEnd = row?.observedEnd ?? null;
      const observedSessions = Math.max(0, Number(row?.observedSessions ?? 0));
      const expectedSessions = countExpectedUsMarketSessions(input.requestedStart, input.throughDate);
      const expectedObservedSessions = observedStart
        ? countExpectedUsMarketSessions(observedStart, input.throughDate)
        : expectedSessions;
      const missingSessions = Math.max(0, expectedSessions - observedSessions);
      const internalMissingSessions = Math.max(0, expectedObservedSessions - observedSessions);
      let status: BarCoverageStatus = "complete";
      if (!observedStart || !observedEnd || observedEnd < input.throughDate) status = "missing";
      else if (internalMissingSessions > 0) status = "gaps";
      else if (observedStart > input.requestedStart) status = "short-history";

      coverageByTicker.set(ticker, {
        ticker,
        feed,
        requestedStart: input.requestedStart,
        observedStart,
        observedEnd,
        observedSessions,
        expectedSessions,
        missingSessions,
        status,
      });
    }
  }

  const statements = Array.from(coverageByTicker.values()).map((coverage) => db.prepare(
    `INSERT INTO bar_coverage
       (feed, ticker, requested_start, observed_start, observed_end, observed_sessions,
        expected_sessions, missing_sessions, status, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(feed, ticker) DO UPDATE SET
       requested_start = excluded.requested_start,
       observed_start = excluded.observed_start,
       observed_end = excluded.observed_end,
       observed_sessions = excluded.observed_sessions,
       expected_sessions = excluded.expected_sessions,
       missing_sessions = excluded.missing_sessions,
       status = excluded.status,
       verified_at = CURRENT_TIMESTAMP`,
  ).bind(
    coverage.feed,
    coverage.ticker,
    coverage.requestedStart,
    coverage.observedStart,
    coverage.observedEnd,
    coverage.observedSessions,
    coverage.expectedSessions,
    coverage.missingSessions,
    coverage.status,
  ));

  let rowsWritten = 0;
  for (let offset = 0; offset < statements.length; offset += 100) {
    const results = await db.batch(statements.slice(offset, offset + 100));
    rowsWritten += results.reduce(
      (sum, result) => sum + Number(result.meta?.rows_written ?? result.meta?.changes ?? 0),
      0,
    );
  }
  await recordMarketDataD1Usage(env, { rowsRead, rowsWritten });
  return coverageByTicker;
}
