import { resolveEodBudgetProfile } from "./eod-budget-profile";
import { loadStorageMigration, type StorageMigrationRun } from "./market-storage-control";
import type { Env } from "./types";

type GithubRun={id:number;status:string;display_title?:string;head_branch?:string;event?:string};
async function github(env:Env,path:string,init:RequestInit={}):Promise<Response> {
  if (!env.EOD_GITHUB_TOKEN) throw new Error("storage-migration-github-token-required");
  const response=await fetch(`https://api.github.com${path}`,{...init,headers:{Authorization:`Bearer ${env.EOD_GITHUB_TOKEN}`,
    Accept:"application/vnd.github+json","User-Agent":"market-overview-storage-migration","Content-Type":"application/json"},
    signal:AbortSignal.timeout(10_000)});
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(`storage-github-http-${response.status}`); }
  return response;
}
async function activeRun(env:Env,repository:string,workflow:string,run:StorageMigrationRun):Promise<GithubRun|null> {
  if (run.github_run_id && /^\d+$/.test(run.github_run_id)) {
    try {
      const known=await (await github(env,`/repos/${repository}/actions/runs/${run.github_run_id}`)).json() as GithubRun;
      if (!Number.isSafeInteger(known.id) || typeof known.status!=="string") throw new Error("storage-github-invalid-run");
      if (known.status!=="completed") return known;
    } catch (error) {
      if (!(error instanceof Error) || error.message!=="storage-github-http-404") throw error;
    }
  }
  const pages=await Promise.all(["queued","in_progress","waiting","pending","requested"].map(async(status) => {
    const params=new URLSearchParams({status,event:"workflow_dispatch",branch:"main",per_page:"100"});
    const response=await github(env,`/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?${params}`);
    const data=await response.json() as {total_count:number;workflow_runs:GithubRun[]};
    if (!Array.isArray(data.workflow_runs) || !Number.isSafeInteger(data.total_count) || data.total_count<0
      || data.total_count>data.workflow_runs.length || response.headers.get("Link")?.includes('rel="next"')) throw new Error("storage-github-incomplete-list");
    return data.workflow_runs;
  }));
  return pages.flat().find((item) => Number.isSafeInteger(item.id) && item.display_title===`Storage ${run.id}`
    && item.head_branch==="main" && item.event==="workflow_dispatch" && item.status!=="completed") ?? null;
}
/** Returns true while migration owns the market lane, including waiting for
 * explicit cutover. Regular EOD run records remain intact for later resumption. */
export async function coordinateStorageMigration(env:Env,now=new Date()):Promise<boolean> {
  if (!env.EOD_STORAGE_MIGRATION_ID) return false;
  const ops=env.OPS_DB;
  if (!ops) throw new Error("storage-migration-ops-required");
  const run=await loadStorageMigration(ops,env.EOD_STORAGE_MIGRATION_ID);
  if (!run) throw new Error("storage-migration-run-missing");
  if (["completed","aborted"].includes(run.status)) return false;
  const timestamp=now.toISOString();
  if (["awaiting-evidence","awaiting-cutover","aborting"].includes(run.status) || (run.lease_until && run.lease_until>timestamp)
    || (run.next_attempt_at && run.next_attempt_at>timestamp)) return true;
  const usage=await ops.prepare(`SELECT e.rows_read AS reads,e.rows_written AS writes,e.reserved_reads AS reservedReads,e.reserved_writes AS reservedWrites,
    a.rows_read AS accountReads,a.rows_written AS accountWrites FROM (SELECT ? AS usage_date) day
    LEFT JOIN eod_usage e ON e.usage_date=day.usage_date LEFT JOIN market_data_daily_usage a ON a.usage_date=day.usage_date`)
    .bind(timestamp.slice(0,10)).first<{reads:number|null;writes:number|null;reservedReads:number|null;reservedWrites:number|null;accountReads:number|null;accountWrites:number|null}>();
  const profile=resolveEodBudgetProfile(env.EOD_BUDGET_PROFILE);
  const value=(number:number|null|undefined) => typeof number==="number" && Number.isFinite(number) && number>=0 ? number : 0;
  if (value(usage?.reads)+value(usage?.reservedReads)+100>profile.eodDaily.reads || value(usage?.writes)+value(usage?.reservedWrites)+64>profile.eodDaily.writes
    || value(usage?.accountReads)+value(usage?.reservedReads)+100>profile.accountDaily.reads || value(usage?.accountWrites)+value(usage?.reservedWrites)+64>profile.accountDaily.writes) {
    await ops.prepare(`UPDATE market_storage_migrations SET status='retrying',error_code='storage-resource-budget',next_attempt_at=?,updated_at=?
      WHERE id=? AND status IN ('queued','dispatching','dispatched','running','retrying') AND (lease_until IS NULL OR lease_until<=?)
      AND (next_attempt_at IS NULL OR next_attempt_at<=?)`)
      .bind(new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1,0,5)).toISOString(),timestamp,run.id,timestamp,timestamp).run();
    return true;
  }
  const repository=env.EOD_GITHUB_REPOSITORY ?? "d0ofus/market-overview";
  const workflow=env.EOD_STORAGE_GITHUB_WORKFLOW ?? "eod-storage-migration.yml";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[\w.-]+\.ya?ml$/.test(workflow)) throw new Error("storage-github-target-invalid");
  const token=crypto.randomUUID(),next=new Date(now.getTime()+15*60_000).toISOString();
  const claim=await ops.prepare(`UPDATE market_storage_migrations SET status='dispatching',dispatch_token=?,next_attempt_at=?,updated_at=?
    WHERE id=? AND status IN ('queued','dispatching','dispatched','running','retrying')
    AND (lease_until IS NULL OR lease_until<=?) AND (next_attempt_at IS NULL OR next_attempt_at<=?)`)
    .bind(token,next,timestamp,run.id,timestamp,timestamp).run();
  if (!claim.meta.changes) return true;
  try {
    const current=await loadStorageMigration(ops,run.id);
    if (!current) throw new Error("storage-migration-run-missing");
    const active=await activeRun(env,repository,workflow,current);
    if (active) {
      await ops.prepare(`UPDATE market_storage_migrations SET status='dispatched',github_run_id=?,dispatch_token=NULL,updated_at=?
        WHERE id=? AND dispatch_token=? AND (lease_until IS NULL OR lease_until<=?)`)
        .bind(String(active.id),timestamp,run.id,token,timestamp).run();
      return true;
    }
    const sending=await ops.prepare(`UPDATE market_storage_migrations SET dispatch_requested_at=?,github_run_id=NULL
      WHERE id=? AND dispatch_token=? AND (lease_until IS NULL OR lease_until<=?)`)
      .bind(timestamp,run.id,token,timestamp).run();
    if (!sending.meta.changes) return true;
    await github(env,`/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,{
      method:"POST",body:JSON.stringify({ref:"main",inputs:{migration_id:run.id}})});
    await ops.prepare(`UPDATE market_storage_migrations SET status=CASE WHEN status='dispatching' THEN 'dispatched' ELSE status END,
      attempt=attempt+1,dispatch_token=NULL,updated_at=? WHERE id=? AND dispatch_token=?`).bind(timestamp,run.id,token).run();
  } catch (error) {
    await ops.prepare(`UPDATE market_storage_migrations SET status='retrying',dispatch_token=NULL,error_code='storage-dispatch-failed',updated_at=?
      WHERE id=? AND dispatch_token=? AND (lease_until IS NULL OR lease_until<=?)`).bind(timestamp,run.id,token,timestamp).run();
    throw error;
  }
  return true;
}
