import { getMarketDataDb,marketDataFeed } from "./market-data-db";
import { expectedEodSession } from "./eod-coordinator";
import type { Env } from "./types";

export async function getStoredHoldingStats(env:Env,tickers:string[]) {
  const unique=Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
  const map=new Map<string,{lastPrice:number|null;change1d:number|null;barDate:string|null;source:string|null}>();
  for (const ticker of unique) map.set(ticker,{lastPrice:null,change1d:null,barDate:null,source:null});
  if (!unique.length) return map;
  const completedSession=await expectedEodSession(env);
  if (!completedSession) return map;
  // Indexed seeks per security, not a full-history window scan. A JSON bound
  // parameter avoids D1's 100-parameter limit and prices every returned holding.
  const rows=await getMarketDataDb(env).prepare(`WITH requested AS (SELECT value AS ticker FROM json_each(?))
    SELECT r.ticker,b.date,b.c,b.source_provider as provider,b.adjustment,b.feed,
      (SELECT p.c FROM alpaca_daily_bars p WHERE p.feed=b.feed AND p.ticker=b.ticker
        AND p.source_provider=b.source_provider AND p.adjustment=b.adjustment
        AND p.date=(SELECT MAX(session_date) FROM market_calendar_sessions WHERE session_date<b.date)) AS previousClose,
      (SELECT MAX(session_date) FROM market_calendar_sessions WHERE session_date<b.date) AS previousDate
    FROM requested r LEFT JOIN alpaca_daily_bars b ON b.feed=? AND b.ticker=r.ticker
      AND b.date=(SELECT last.date FROM alpaca_daily_bars last
        JOIN market_calendar_sessions calendar ON calendar.session_date=last.date
        WHERE last.feed=? AND last.ticker=r.ticker AND last.date<=?
          AND last.adjustment='split' AND last.source_provider IN ('alpaca','yahoo') AND last.c>0
          AND NOT EXISTS (SELECT 1 FROM eod_adjustment_repairs repair
            WHERE repair.feed=last.feed AND repair.ticker=last.ticker AND repair.status='pending')
        ORDER BY last.date DESC LIMIT 1)`)
    .bind(JSON.stringify(unique),marketDataFeed(env),marketDataFeed(env),completedSession)
    .all<{ticker:string;date:string|null;c:number|null;provider:string|null;adjustment:string|null;feed:string|null;previousClose:number|null;previousDate:string|null}>();
  for (const row of rows.results) {
    const price=typeof row.c==="number" && Number.isFinite(row.c) && row.c>0 ? row.c : null;
    // The cached exchange calendar is authoritative, including exceptional
    // closures. Never substitute an earlier available bar for its predecessor.
    const exactPrevious=Boolean(row.date && row.previousDate && row.previousDate<row.date);
    const change=price!==null && exactPrevious && row.previousClose!=null && Number.isFinite(row.previousClose) && row.previousClose>0 ? (price/row.previousClose-1)*100 : null;
    map.set(row.ticker,{
      lastPrice:price,barDate:price!==null ? row.date : null,
      change1d:change!==null && Number.isFinite(change) ? change : null,
      source:price!==null && row.provider ? `${row.provider}:${row.feed}:${row.adjustment}` : null,
    });
  }
  return map;
}
