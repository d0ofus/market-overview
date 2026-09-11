import { execFileSync } from "node:child_process";
import { resolveEodRunnerCodeRevision } from "../src/eod-runner-revision";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { createEodD1Database, createEodAdmission } from "../src/eod-d1-rest";
import { runEodBatch } from "../src/eod-runner";
import type { Env } from "../src/types";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { assertEodCutover } from "../src/eod-rollout-service";
import { finalizeRecentEodUsage, collectEodRolloutMonitoring } from "../src/eod-rollout-monitor";
import { eodStorageWriterDisposition } from "../src/eod-storage-writer-guard";

function required(name:string):string {
  const value=process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
async function main() {
  const codeRevision = resolveEodRunnerCodeRevision({ actualRevision: execFileSync("git", ["rev-parse", "HEAD"],
    { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim(),
    productionRevision: process.env.EOD_PRODUCTION_CODE_REVISION, codeRevision: process.env.EOD_CODE_REVISION, githubSha: process.env.GITHUB_SHA });
  const runId=required("EOD_RUN_ID");
  if (!/^eod:(shadow|active):\d{4}-\d{2}-\d{2}:(daily|reconcile|backfill|maintenance)$/.test(runId)) throw new Error("Invalid run ID");
  const accountId=required("CLOUDFLARE_ACCOUNT_ID");
  const token=required("CLOUDFLARE_EOD_D1_TOKEN");
  const core=required("EOD_CORE_DATABASE_ID"),market=required("EOD_MARKET_DATABASE_ID"),ops=required("EOD_OPS_DATABASE_ID");
  const history=process.env.EOD_HISTORY_DATABASE_ID?.trim();
  const allowedDatabaseIds=[core,market,ops,...(history ? [history] : [])];
  const rawOps=createEodD1Database({accountId,token,databaseId:ops,allowedDatabaseIds});
  const admission=createEodAdmission(rawOps,runId,{ profile: resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE),reconcileAccountUsage:() => reconcileEodAccountUsage({profile:resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE),
    accountId,token:process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token,ops:rawOps,
  })});
  const database=(databaseId:string) => createEodD1Database({accountId,token,databaseId,allowedDatabaseIds,admission});
  const env:Env={ EOD_BUDGET_PROFILE:process.env.EOD_BUDGET_PROFILE,
    DB:database(core),MARKET_DATA_DB:database(market),OPS_DB:database(ops),
    MARKET_HISTORY_DB:history ? database(history) : undefined,
    MARKET_DATA_DB_REQUIRED:"true",OPS_DB_REQUIRED:"true",
    EOD_RUNNER_MODE:runId.includes(":active:") ? "active" : "shadow",
    EOD_CODE_REVISION:codeRevision,
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
    const ownership=await eodStorageWriterDisposition(env.OPS_DB!,market);
    if(ownership!=="canonical") {
      console.log(JSON.stringify({runId,status:"deferred",reason:ownership}));return;
    }
    await env.OPS_DB!.prepare("UPDATE eod_runs SET github_run_id=? WHERE id=?")
      .bind(process.env.GITHUB_RUN_ID ?? null,runId).run();
    try {
      await assertEodCutover(env,env.EOD_RUNNER_MODE==="active" ? codeRevision : "");
    } catch (error) {
      const message=error instanceof Error ? error.message.slice(0,500) : "eod-cutover-proof-failed";
      await failureDb.prepare(`UPDATE eod_runs SET status='retrying',stage='cutover',error_code='cutover-proof',error_message=?,
        next_attempt_at=?,updated_at=? WHERE id=? AND (lease_until IS NULL OR lease_until<=?)`)
        .bind(message,new Date(Date.now()+60*60_000).toISOString(),new Date().toISOString(),runId,new Date().toISOString()).run();
      throw error;
    }
    await finalizeRecentEodUsage({accountId,token:process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token,ops:env.OPS_DB!});
    const outcome=await runEodBatch(env,runId,failureDb);
    console.log(JSON.stringify({runId,status:outcome.status,publications:outcome.published.length}));
    if (outcome.status==="retrying") process.exitCode=1;
    await collectEodRolloutMonitoring(env).catch(()=>undefined);
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
