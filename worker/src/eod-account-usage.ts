/** Account-wide analytics includes databases and workflows outside EOD. It can
 * lag live queries, so admission also keeps a conservative local high-water mark. */
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseUsage(body: unknown): { rowsRead: number; rowsWritten: number } {
  const envelope=record(body);
  if (!envelope || (envelope.errors != null && (!Array.isArray(envelope.errors) || envelope.errors.length))) {
    throw new Error("eod-account-usage-unavailable");
  }
  const accounts=record(record(envelope.data)?.viewer)?.accounts;
  if (!Array.isArray(accounts) || accounts.length!==1) throw new Error("eod-account-usage-unavailable");
  const groups=record(accounts[0])?.d1AnalyticsAdaptiveGroups;
  // Empty analytics can mean delayed/unavailable telemetry. Only an explicit
  // numeric zero is a usable zero, and reaching the page limit is incomplete.
  if (!Array.isArray(groups) || groups.length===0 || groups.length>=1000) throw new Error("eod-account-usage-unavailable");
  const usage={rowsRead:0,rowsWritten:0};
  for (const group of groups) {
    const sum=record(record(group)?.sum);
    for (const field of ["rowsRead","rowsWritten"] as const) {
      const value=sum?.[field];
      if (typeof value!=="number" || !Number.isFinite(value) || value<0 || value>Number.MAX_SAFE_INTEGER) {
        throw new Error("eod-account-usage-invalid");
      }
      // Adaptive analytics may return an estimate; round upward for admission
      // and for D1's integer counters, never silently discard fractional usage.
      usage[field]+=Math.ceil(value);
      if (!Number.isSafeInteger(usage[field])) throw new Error("eod-account-usage-invalid");
    }
  }
  return usage;
}

export async function reconcileEodAccountUsage(input:{accountId:string;token:string;ops:D1Database;fetcher?:typeof fetch;now?:Date}) {
  const now=input.now ?? new Date();
  const date=now.toISOString().slice(0,10);
  const query=`query EodAccountUsage($accountTag: string!, $start: Date!, $end: Date!) {
    viewer { accounts(filter: {accountTag: $accountTag}) {
      d1AnalyticsAdaptiveGroups(limit: 1000, filter: {date_geq: $start, date_leq: $end}) {
        sum { rowsRead rowsWritten }
      }
    } }
  }`;
  let usage: { rowsRead:number; rowsWritten:number };
  try {
    const response=await (input.fetcher ?? fetch)("https://api.cloudflare.com/client/v4/graphql",{
      method:"POST",headers:{Authorization:`Bearer ${input.token}`,"Content-Type":"application/json"},
      body:JSON.stringify({query,variables:{accountTag:input.accountId,start:date,end:date}}),signal:AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("eod-account-usage-unavailable");
    }
    usage=parseUsage(await response.json());
  } catch (error) {
    const code=error instanceof Error && error.message==="eod-account-usage-invalid"
      ? "eod-account-usage-invalid" : "eod-account-usage-unavailable";
    // Preserve a prior measured sample and its timestamp. If none exists, leave
    // it absent so status/admission cannot mistake an unknown allowance for zero.
    await input.ops.prepare("UPDATE eod_account_usage SET error=? WHERE usage_date=?")
      .bind(code,date).run().catch(() => undefined);
    throw new Error(code);
  }
  await input.ops.batch([
    input.ops.prepare(`INSERT INTO eod_account_usage(usage_date,rows_read,rows_written,sampled_at) VALUES(?,?,?,?)
      ON CONFLICT(usage_date) DO UPDATE SET rows_read=MAX(rows_read,excluded.rows_read),
        rows_written=MAX(rows_written,excluded.rows_written),sampled_at=excluded.sampled_at,error=NULL`)
      .bind(date,usage.rowsRead,usage.rowsWritten,now.toISOString()),
    input.ops.prepare(`INSERT INTO market_data_daily_usage(usage_date,bars_written,rows_read,rows_written,updated_at)
      VALUES(?,0,?,?,?) ON CONFLICT(usage_date) DO UPDATE SET rows_read=MAX(rows_read,excluded.rows_read),
        rows_written=MAX(rows_written,excluded.rows_written),updated_at=excluded.updated_at`)
      .bind(date,usage.rowsRead+10,usage.rowsWritten+8,now.toISOString()),
  ]);
  return usage;
}
