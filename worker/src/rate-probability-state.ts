/** Optional rate probabilities have an independent, durable circuit breaker.
 * The existing provider backoff table lives in Core, never the price archive. */
const PROVIDER = "rateprobability", INSTRUMENT = "FEDFUNDS";
const HOUR = 3_600_000;
type Row = { reason: string; failureCount: number; nextAttemptAt: string; lastAttemptAt: string; lastSuccessAt: string | null; error: string | null };
export type RateProbabilityState = {
  status: "idle" | "refreshing" | "cooldown" | "ready" | "unavailable";
  lastAttemptAt: string | null; lastSuccessAt: string | null; nextAttemptAt: string | null;
  failureCount: number; error: string | null;
};
export class RateProbabilityError extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly cooldownMs = 0) { super(code); }
}
export async function loadRateProbabilityState(db: D1Database, now = new Date()): Promise<RateProbabilityState> {
  const row = await db.prepare(`SELECT reason,failure_count AS failureCount,no_data_until AS nextAttemptAt,
    last_attempt_at AS lastAttemptAt,last_success_at AS lastSuccessAt,last_error AS error
    FROM provider_symbol_backoff WHERE provider_key=? AND ticker=?`).bind(PROVIDER,INSTRUMENT).first<Row>();
  if (!row) return { status:"idle",lastAttemptAt:null,lastSuccessAt:null,nextAttemptAt:null,failureCount:0,error:null };
  const active=Date.parse(row.nextAttemptAt)>now.getTime();
  return { status:row.reason.startsWith("refreshing:") && active ? "refreshing" : row.error ? "cooldown" : "ready",
    lastAttemptAt:row.lastAttemptAt,lastSuccessAt:row.lastSuccessAt,nextAttemptAt:row.nextAttemptAt,
    failureCount:row.failureCount,error:row.error };
}
export async function claimRateProbabilityRefresh(db:D1Database,now=new Date()):Promise<{token:string;failureCount:number}|null> {
  const token=`refreshing:${crypto.randomUUID()}`, stamp=now.toISOString();
  const result=await db.prepare(`INSERT INTO provider_symbol_backoff(provider_key,ticker,reason,failure_count,no_data_until,last_attempt_at,last_error)
    VALUES(?,?,?,0,?,?,NULL) ON CONFLICT(provider_key,ticker) DO UPDATE SET reason=excluded.reason,
      no_data_until=excluded.no_data_until,last_attempt_at=excluded.last_attempt_at
    WHERE provider_symbol_backoff.no_data_until<=? RETURNING failure_count AS failureCount`)
    .bind(PROVIDER,INSTRUMENT,token,new Date(now.getTime()+120_000).toISOString(),stamp,stamp).all<{failureCount:number}>();
  return result.results.length===1 ? {token,failureCount:result.results[0].failureCount} : null;
}
export async function finishRateProbabilityRefresh(db:D1Database,claim:{token:string;failureCount:number},failure:RateProbabilityError|null,now=new Date()):Promise<void> {
  const failures=failure ? Math.min(claim.failureCount+1,100) : 0;
  const delay=failure ? Math.max(failure.cooldownMs,Math.min(6*HOUR,30*60_000*2**Math.min(failures-1,4))) : HOUR;
  const result=await db.prepare(`UPDATE provider_symbol_backoff SET reason=?,failure_count=?,no_data_until=?,
    last_success_at=CASE WHEN ? IS NULL THEN ? ELSE last_success_at END,last_error=?
    WHERE provider_key=? AND ticker=? AND reason=? RETURNING ticker`)
    .bind(failure ? "cooldown" : "ready",failures,new Date(now.getTime()+Math.min(24*HOUR,delay)).toISOString(),failure?.code ?? null,
      now.toISOString(),failure?.code ?? null,PROVIDER,INSTRUMENT,claim.token).all<{ticker:string}>();
  if(result.results.length!==1) throw new Error("rateprobability-refresh-lease-lost");
}
