import { createEodD1Database, createEodAdmission } from "../src/eod-d1-rest";
import { runEodBatch } from "../src/eod-runner";
import type { Env } from "../src/types";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { assertEodCutover } from "../src/eod-rollout-service";

function required(name:string):string {
  const value=process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
async function main() {
  const runId=required("EOD_RUN_ID");
  if (!/^eod:(shadow|active):\d{4}-\d{2}-\d{2}:(daily|reconcile|backfill|maintenance)$/.test(runId)) throw new Error("Invalid run ID");
  const accountId=required("CLOUDFLARE_ACCOUNT_ID");
  const token=required("CLOUDFLARE_EOD_D1_TOKEN");
  const core=required("EOD_CORE_DATABASE_ID"),market=required("EOD_MARKET_DATABASE_ID"),ops=required("EOD_OPS_DATABASE_ID");
  const history=process.env.EOD_HISTORY_DATABASE_ID?.trim();
  const allowedDatabaseIds=[core,market,ops,...(history ? [history] : [])];
  const rawOps=createEodD1Database({accountId,token,databaseId:ops,allowedDatabaseIds});
  const admission=createEodAdmission(rawOps,runId,{reconcileAccountUsage:() => reconcileEodAccountUsage({
    accountId,token:process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token,ops:rawOps,
  })});
  const database=(databaseId:string) => createEodD1Database({accountId,token,databaseId,allowedDatabaseIds,admission});
  const env:Env={
    DB:database(core),MARKET_DATA_DB:database(market),OPS_DB:database(ops),
    MARKET_HISTORY_DB:history ? database(history) : undefined,
    MARKET_DATA_DB_REQUIRED:"true",OPS_DB_REQUIRED:"true",
    EOD_RUNNER_MODE:runId.includes(":active:") ? "active" : "shadow",
    EOD_CODE_REVISION:process.env.GITHUB_SHA,
    EOD_READ_ENABLED:"true",
    EOD_ARCHIVE_PRUNE_ENABLED:process.env.EOD_ARCHIVE_PRUNE_ENABLED ?? "false",
    ALPACA_API_KEY:required("ALPACA_API_KEY"),ALPACA_API_SECRET:required("ALPACA_API_SECRET"),
    ALPACA_DAILY_FEED:"sip",ALPACA_DAILY_ADJUSTMENT:"split",
    ALPACA_REQUESTS_PER_MINUTE_HARD:"160",YAHOO_REQUESTS_PER_DAY_HARD:"250",
  };
  // Reserve one small, indexed terminal status write before admitting the heavy
  // work. Quota exhaustion must still be reportable, and its cost is accounted.
  const terminalSettlement=await admission([{sql:"UPDATE eod_runs SET status=? WHERE id=?",params:[]}]);
  let terminalUsed=false;
  const failureDb=createEodD1Database({accountId,token,databaseId:ops,allowedDatabaseIds,admission:async (queries) => {
    if (terminalUsed || queries.length!==1 || !/^UPDATE eod_runs SET /i.test(queries[0].sql)) throw new Error("eod-terminal-control-already-used");
    terminalUsed=true;
    return terminalSettlement;
  }});
  try {
    await env.OPS_DB!.prepare("UPDATE eod_runs SET github_run_id=? WHERE id=?")
      .bind(process.env.GITHUB_RUN_ID ?? null,runId).run();
    try {
      await assertEodCutover(env,env.EOD_RUNNER_MODE==="active" ? required("GITHUB_SHA") : "");
    } catch (error) {
      const message=error instanceof Error ? error.message.slice(0,500) : "eod-cutover-proof-failed";
      await failureDb.prepare(`UPDATE eod_runs SET status='retrying',stage='cutover',error_code='cutover-proof',error_message=?,
        next_attempt_at=?,updated_at=? WHERE id=? AND (lease_until IS NULL OR lease_until<=?)`)
        .bind(message,new Date(Date.now()+60*60_000).toISOString(),new Date().toISOString(),runId,new Date().toISOString()).run();
      throw error;
    }
    const outcome=await runEodBatch(env,runId,failureDb);
    console.log(JSON.stringify({runId,status:outcome.status,publications:outcome.published.length}));
    if (outcome.status==="retrying") process.exitCode=1;
  } finally {
    try {
      if (!terminalUsed) await terminalSettlement({rowsRead:0,rowsWritten:0,sizeAfter:0});
    } finally {
      await admission.flush();
    }
  }
}
main().catch((error:unknown) => {
  // Provider bodies, SQL parameters and credentials are deliberately absent.
  const message=error instanceof Error ? error.message : "Runner failed";
  console.error(message.slice(0,500));
  process.exitCode=1;
});
