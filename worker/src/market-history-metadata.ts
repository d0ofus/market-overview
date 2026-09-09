import { getMarketDataDb } from "./market-data-db";
import type { Env } from "./types";

/** Latest-date refresh planning needs archive manifests, not every historical
 * bar. Exact on-date existence must still use the verified range reader. */
export async function loadMarketHistoryLatestDates(env: Env, tickers: string[], feed: string): Promise<Map<string, string | null>> {
  const dates = new Map<string, string | null>();
  const unique = [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))];
  // Metadata-only batches use one JSON parameter. A 6,000-symbol catalog needs
  // twelve D1 requests rather than exceeding the 50-query Worker limit.
  for (let offset = 0; offset < unique.length; offset += 1_000) {
    const requested = JSON.stringify(unique.slice(offset, offset + 1_000));
    const hot = await getMarketDataDb(env).prepare(`SELECT CAST(value AS TEXT) AS ticker,
      (SELECT date FROM alpaca_daily_bars WHERE feed=? AND ticker=requested.value ORDER BY date DESC LIMIT 1) AS lastDate
      FROM json_each(?) requested`).bind(feed, requested).all<{ ticker: string; lastDate: string | null }>();
    for (const row of hot.results ?? []) dates.set(row.ticker, row.lastDate);
    if (!env.MARKET_HISTORY_DB) continue;
    const archived = await env.MARKET_HISTORY_DB.prepare(`SELECT pointer.ticker, MAX(block.last_date) AS lastDate,
      SUM(CASE WHEN block.id IS NULL OR block.verified_at IS NULL THEN 1 ELSE 0 END) AS unverified,
      SUM(CASE WHEN block.feed IS NOT pointer.feed OR block.ticker IS NOT pointer.ticker
        OR block.calendar_year IS NOT pointer.calendar_year
        OR block.schema_version IS NOT 1 OR block.codec IS NOT 'gzip-json-v1'
        THEN 1 ELSE 0 END) AS invalid
      FROM market_history_block_pointers pointer LEFT JOIN market_history_blocks block ON block.id=pointer.block_id
      WHERE pointer.feed=? AND pointer.ticker IN (SELECT value FROM json_each(?)) GROUP BY pointer.ticker`)
      .bind(feed, requested).all<{ ticker: string; lastDate: string | null; unverified: number; invalid: number }>();
    for (const row of archived.results ?? []) {
      if (row.unverified) throw new Error(`market-history-unverified-latest-date:${row.ticker}`);
      if (row.invalid) throw new Error(`market-history-invalid-latest-date:${row.ticker}`);
      if (row.lastDate && row.lastDate > (dates.get(row.ticker) ?? "")) dates.set(row.ticker, row.lastDate);
    }
  }
  return dates;
}
