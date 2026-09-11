import { eodBudgetWindow, resolveEodBudgetProfile, type EodBudgetProfile } from "./eod-budget-profile";

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

/** Read one explicitly dated account-wide bucket. Historical collection must
 * retain its real sample time rather than impersonating a previous day's clock. */
export async function fetchEodAccountUsage(input:{accountId:string;token:string;usageDate:string;fetcher?:typeof fetch}) {
  const date=input.usageDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date) throw new Error("eod-account-usage-invalid-date");
  const query=`query EodAccountUsage($accountTag: string!, $start: Date!, $end: Date!) {
    viewer { accounts(filter: {accountTag: $accountTag}) {
      d1AnalyticsAdaptiveGroups(limit: 1000, filter: {date_geq: $start, date_leq: $end}) {
        sum { rowsRead rowsWritten }
      }
    } }
  }`;
  const response=await (input.fetcher ?? fetch)("https://api.cloudflare.com/client/v4/graphql",{
    method:"POST",headers:{Authorization:`Bearer ${input.token}`,"Content-Type":"application/json"},
    body:JSON.stringify({query,variables:{accountTag:input.accountId,start:date,end:date}}),signal:AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("eod-account-usage-unavailable");
  }
  return parseUsage(await response.json());
}

export async function fetchEodAccountUsageWindow(input:{accountId:string;token:string;fetcher?:typeof fetch;now?:Date}) {
  const window=eodBudgetWindow(input.now);
  const response=await (input.fetcher ?? fetch)("https://api.cloudflare.com/client/v4/graphql",{
    method:"POST",headers:{Authorization:`Bearer ${input.token}`,"Content-Type":"application/json"},signal:AbortSignal.timeout(15_000),
    body:JSON.stringify({query:`query EodAccountUsageWindow($accountTag: string!, $start: Date!, $end: Date!) {
      viewer { accounts(filter: {accountTag: $accountTag}) {
        d1AnalyticsAdaptiveGroups(limit: 1000, filter: {date_geq: $start, date_leq: $end}) {
          dimensions { date } sum { rowsRead rowsWritten }
        }
      } }
    }`,variables:{accountTag:input.accountId,start:window.start,end:window.end}}),
  });
  if (!response.ok) {await response.body?.cancel().catch(()=>undefined);throw new Error("eod-account-window-unavailable");}
  const body:unknown=await response.json();
  // Validate the complete account envelope first. A wholly empty window is
  // unknown; omitted dates within a successful nonempty grouped range are zero
  // activity, subsequently bounded by each day's preserved local high-water.
  parseUsage(body);
  const groups=record((record(record(record(body)?.data)?.viewer)?.accounts as unknown[])[0])!.d1AnalyticsAdaptiveGroups as unknown[];
  const days=new Map<string,{rowsRead:number;rowsWritten:number}>();
  for (let index=0;index<31;index++) days.set(new Date(Date.parse(`${window.start}T00:00:00Z`)+index*86_400_000).toISOString().slice(0,10),{rowsRead:0,rowsWritten:0});
  const seen=new Set<string>();
  for (const group of groups) {
    const date=record(record(group)?.dimensions)?.date, sum=record(record(group)?.sum)!;
    if (typeof date!=="string" || !days.has(date) || seen.has(date)) throw new Error("eod-account-window-invalid");
    seen.add(date);days.set(date,{rowsRead:Math.ceil(sum.rowsRead as number),rowsWritten:Math.ceil(sum.rowsWritten as number)});
  }
  return days;
}

export async function reconcileEodAccountUsage(input:{accountId:string;token:string;ops:D1Database;fetcher?:typeof fetch;now?:Date;profile?:EodBudgetProfile}) {
  const now=input.now ?? new Date();
  const date=now.toISOString().slice(0,10);
  const profile=resolveEodBudgetProfile(input.profile?.name);
  if (profile.rolling31) {
    let days:Map<string,{rowsRead:number;rowsWritten:number}>;
    try { days=await fetchEodAccountUsageWindow({...input,now}); }
    catch {
      await input.ops.prepare("UPDATE eod_account_usage SET error='eod-account-window-unavailable' WHERE usage_date=? AND sampled_at<=?")
        .bind(date,now.toISOString()).run().catch(()=>undefined);
      throw new Error("eod-account-window-unavailable");
    }
    const values=JSON.stringify([...days].map(([usageDate,usage])=>({usageDate,...usage})));
    // Publish the complete bounded window atomically. A runner and heartbeat
    // may collect concurrently; neither exposes an intermediate unavailable
    // marker or overwrites a newer successful sample's date/error status.
    await input.ops.batch([
      input.ops.prepare(`INSERT INTO eod_account_usage(usage_date,rows_read,rows_written,sampled_at)
        SELECT json_extract(value,'$.usageDate'),json_extract(value,'$.rowsRead'),json_extract(value,'$.rowsWritten'),?
        FROM json_each(?) WHERE 1
        ON CONFLICT(usage_date) DO UPDATE SET rows_read=MAX(rows_read,excluded.rows_read),rows_written=MAX(rows_written,excluded.rows_written),
        sampled_at=MAX(sampled_at,excluded.sampled_at),
        error=CASE WHEN excluded.sampled_at>=sampled_at THEN NULL ELSE error END`).bind(now.toISOString(),values),
      input.ops.prepare(`INSERT INTO market_data_daily_usage(usage_date,bars_written,rows_read,rows_written,updated_at)
        SELECT json_extract(value,'$.usageDate'),0,
          json_extract(value,'$.rowsRead')+CASE WHEN json_extract(value,'$.usageDate')=? THEN 256 ELSE 0 END,
          json_extract(value,'$.rowsWritten')+CASE WHEN json_extract(value,'$.usageDate')=? THEN 256 ELSE 0 END,?
        FROM json_each(?) WHERE 1
        ON CONFLICT(usage_date) DO UPDATE SET
          rows_read=MAX(rows_read,excluded.rows_read-CASE WHEN excluded.usage_date=? THEN 256 ELSE 0 END)+CASE WHEN excluded.usage_date=? THEN 256 ELSE 0 END,
          rows_written=MAX(rows_written,excluded.rows_written-CASE WHEN excluded.usage_date=? THEN 256 ELSE 0 END)+CASE WHEN excluded.usage_date=? THEN 256 ELSE 0 END,
          updated_at=MAX(updated_at,excluded.updated_at)`)
        .bind(date,date,now.toISOString(),values,date,date,date,date),
      input.ops.prepare(`INSERT INTO eod_usage(usage_date,rows_read,rows_written) VALUES(?,256,256)
        ON CONFLICT(usage_date) DO UPDATE SET rows_read=rows_read+256,rows_written=rows_written+256`).bind(date),
    ]);
    return days.get(date)!;
  }
  let usage: { rowsRead:number; rowsWritten:number };
  try {
    usage=await fetchEodAccountUsage({...input,usageDate:date});
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
