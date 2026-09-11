import { closedEtfTickers } from "./etf-holdings-quality";

export const ETF_HOLDINGS_REFRESH_DAYS = 7;
const DAY_MS = 86_400_000;

/** Attempts rotate fairly across the watched population. Provider errors do
 * not outrank older healthy work, and a retained full snapshot keeps its age. */
export async function loadDueEtfRefreshTickers(db:D1Database,options:{staleDays?:number;batchLimit?:number;now?:Date}={}):Promise<string[]> {
  const now=options.now ?? new Date();
  const staleDays=Math.max(1,Math.min(90,Math.trunc(options.staleDays ?? ETF_HOLDINGS_REFRESH_DAYS)));
  const limit=Math.max(1,Math.min(25,Math.trunc(options.batchLimit ?? 5)));
  if(!Number.isFinite(now.getTime()) || !Number.isFinite(staleDays) || !Number.isFinite(limit)) throw new Error("etf-refresh-schedule-invalid");
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);
  const part=(type:string)=>parts.find(row=>row.type===type)?.value ?? "";
  const today=`${part("year")}-${part("month")}-${part("day")}`;
  const query=async(metadata:boolean)=>db.prepare(`WITH cached AS (
      SELECT etf_ticker,COUNT(*) AS actualCount,
        CASE WHEN COUNT(date(as_of_date))=COUNT(*) AND COUNT(DISTINCT date(as_of_date))=1
          THEN MIN(date(as_of_date)) ELSE NULL END AS sourceDate
      FROM etf_constituents GROUP BY etf_ticker
    ), candidates AS (
      SELECT w.ticker,julianday(s.last_synced_at) AS attemptedAt,
        julianday(${metadata ? "COALESCE(s.last_full_synced_at,s.last_synced_at)" : "s.last_synced_at"}) AS fullAt,
        cs.sourceDate,COALESCE(cs.actualCount,0) AS actualCount,
        CASE WHEN s.status IN ('error','partial') ${metadata ? "OR s.coverage='partial' OR s.source_tier='partial'" : ""}
          OR COALESCE(cs.actualCount,0)=0 THEN 1 ELSE 0 END AS incomplete
      FROM (SELECT DISTINCT ticker FROM etf_watchlists) w
      LEFT JOIN etf_constituent_sync_status s ON s.etf_ticker=w.ticker
      LEFT JOIN cached cs ON cs.etf_ticker=w.ticker
      WHERE w.ticker NOT IN (SELECT value FROM json_each(?))
    ) SELECT ticker FROM candidates WHERE
      (incomplete=1 AND (attemptedAt IS NULL OR attemptedAt<=julianday(?)))
      OR (incomplete=0 AND (attemptedAt IS NULL OR attemptedAt<=julianday(?))
        AND (fullAt IS NULL OR fullAt<=julianday(?) OR sourceDate IS NULL
          OR julianday(sourceDate)<=julianday(?) OR sourceDate>?))
    ORDER BY COALESCE(attemptedAt,0) ASC,ticker ASC LIMIT ?`)
    .bind(JSON.stringify(closedEtfTickers(now)),new Date(now.getTime()-6*3_600_000).toISOString(),
      new Date(now.getTime()-DAY_MS).toISOString(),new Date(now.getTime()-staleDays*DAY_MS).toISOString(),
      new Date(now.getTime()-staleDays*DAY_MS).toISOString(),today,limit).all<{ticker:string}>();
  let result:D1Result<{ticker:string}>;
  try {result=await query(true);} catch(error) {
    // Only an older Core schema gets the compatibility query. Quota, timeout,
    // corruption and connectivity failures are not retried as another scan.
    if(!(error instanceof Error) || !/no such column:\s*(?:s\.)?(?:coverage|source_tier|last_full_synced_at)\b/i.test(error.message)) throw error;
    result=await query(false);
  }
  return result.results.map(row=>row.ticker);
}
