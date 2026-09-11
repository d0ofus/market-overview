import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { loadStorageMigration, storageMigrationIdentity } from "../src/market-storage-control";
import { createStorageWorkflowQuiescence } from "../src/market-storage-github-revocation";
import { withdrawStoragePopulationPlan } from "../src/market-storage-population-withdrawal";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const required=(name:string)=>{const value=process.env[name]?.trim();if(!value)throw new Error("storage-population-withdrawal-setting-missing");return value;};
const object=(value:unknown):Record<string,unknown>|null=>value!==null && typeof value==="object" && !Array.isArray(value) ? value as Record<string,unknown> : null;
async function main() {
  const accountId=required("CLOUDFLARE_ACCOUNT_ID"),token=required("CLOUDFLARE_EOD_D1_TOKEN"),migrationId=required("EOD_STORAGE_MIGRATION_ID");
  const source=required("EOD_STORAGE_SOURCE_DATABASE_ID"),target=required("EOD_STORAGE_TARGET_DATABASE_ID"),history=required("EOD_HISTORY_DATABASE_ID"),opsId=required("EOD_OPS_DATABASE_ID");
  const executionRevision=required("EOD_STORAGE_PREVIOUS_EXECUTION_REVISION"),expectedPlanHash=required("EOD_STORAGE_WITHDRAW_PLAN_HASH");
  const repository=process.env.EOD_GITHUB_REPOSITORY ?? "d0ofus/market-overview";
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(executionRevision)
    || !/^[a-f0-9]{64}$/.test(expectedPlanHash))throw new Error("storage-population-withdrawal-identity-invalid");
  const command=(exe:string,args:string[])=>{
    try{return execFileSync(exe,args,{cwd:root,encoding:"utf8",windowsHide:true,timeout:30_000,maxBuffer:8_000_000,stdio:["ignore","pipe","pipe"]});}
    catch{throw new Error("storage-population-withdrawal-control-verification-failed");}
  };
  const git=(...args:string[])=>command("git",args).trim();
  const gh=(path:string)=>object(JSON.parse(command("gh",["api",path]))) ?? {};
  const withdrawalRevision=git("rev-parse","HEAD");
  const assertReviewedCheckout=async()=>{
    if(!/^[a-f0-9]{40}$/.test(withdrawalRevision) || git("rev-parse","HEAD")!==withdrawalRevision
      || git("branch","--show-current")!=="main" || git("status","--porcelain")
      || object(gh(`repos/${repository}/git/ref/heads/main`).object)?.sha!==withdrawalRevision
      || git("merge-base",executionRevision,withdrawalRevision)!==executionRevision)throw new Error("storage-population-withdrawal-reviewed-main-required");
    const changed=command("git",["diff","--name-only","--no-renames","-z",executionRevision,withdrawalRevision,"--"]).split("\0");
    if(changed.some(path=>path.startsWith("worker/market-data-migrations/") || path.startsWith("worker/history-migrations/")))throw new Error("storage-population-withdrawal-storage-schema-change");
  };
  await assertReviewedCheckout();
  const allowed=[source,target,history,opsId];if(new Set(allowed).size!==4)throw new Error("storage-population-withdrawal-database-conflict");
  const rawOps=createEodD1Database({accountId,token,databaseId:opsId,allowedDatabaseIds:allowed});
  const profile=resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE);
  const admission=createEodAdmission(rawOps,`population-withdrawal:${migrationId}`,{profile,writeCredit:200,
    reconcileAccountUsage:()=>reconcileEodAccountUsage({accountId,token:process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token,ops:rawOps,profile})});
  const database=(databaseId:string)=>createEodD1Database({accountId,token,databaseId,allowedDatabaseIds:allowed,admission});
  const ops=database(opsId);
  try {
    const run=await loadStorageMigration(ops,migrationId),body=gh(`repos/${repository}/environments/market-eod/variables?per_page=100`);
    if(!Array.isArray(body.variables) || body.total_count!==body.variables.length)throw new Error("storage-population-withdrawal-variables-incomplete");
    const vars=new Map(body.variables.map(value=>{const row=object(value);return [String(row?.name),String(row?.value)];}));
    if(!run || run.source_database_id!==source || run.target_database_id!==target || run.history_database_id!==history
      || vars.get("EOD_STORAGE_CODE_REVISION")!==run.code_revision || vars.get("EOD_STORAGE_EXECUTION_REVISION")!==executionRevision
      || vars.get("EOD_STORAGE_SOURCE_DATABASE_ID")!==source || vars.get("EOD_STORAGE_TARGET_DATABASE_ID")!==target
      || vars.get("EOD_HISTORY_DATABASE_ID")!==history || vars.get("EOD_OPS_DATABASE_ID")!==opsId
      || vars.get("CLOUDFLARE_ACCOUNT_ID")!==accountId)throw new Error("storage-population-withdrawal-durable-identity-conflict");
    const assertRevokedRunClaimFence=async()=>{
      const runner=command("git",["show",`${executionRevision}:worker/scripts/market-storage-runner.ts`]);
      const control=command("git",["show",`${executionRevision}:worker/src/market-storage-control.ts`]);
      if(!runner.includes("await assertStorageExecutionRevision(meteredOps,existing,codeRevision)")
        || !runner.includes("githubRunId:process.env.GITHUB_RUN_ID,executionRevision:codeRevision")
        || !control.includes("COALESCE(execution_revision,code_revision)=?")
        || !control.includes("storageGitHubRevocationKey(options.githubRunId)")
        || !control.includes("AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM eod_rollout_evidence WHERE id=?))")
        || !control.includes("revocationKey,revocationKey"))throw new Error("storage-population-withdrawal-current-executor-fence-required");
    };
    // Only previously durable run revocations are reusable here. This command
    // neither creates a new exception nor edits GitHub workflow state/pins.
    const assertNoWorkflowWriters=createStorageWorkflowQuiescence({ops,repository,migration:storageMigrationIdentity(run),
      fromRevision:executionRevision,codeRevision:withdrawalRevision,readGitHub:async path=>gh(path),assertRevokedRunClaimFence});
    const result=await withdrawStoragePopulationPlan({ops,source:database(source),target:database(target),history:database(history),
      migrationId,expectedPlanHash,executionRevision,withdrawalRevision,assertReviewedCheckout,assertNoWorkflowWriters});
    console.log(JSON.stringify({status:result.status,migrationId,planHash:result.record.planHash,evidenceHash:result.record.evidenceHash,
      sourcePreserved:true,immutableEvidencePreserved:true}));
  } finally {await admission.flush();}
}
main().catch((error:unknown)=>{
  const message=error instanceof Error ? error.message : "";
  console.error(JSON.stringify({status:"not-withdrawn",reason:/^storage-(population-withdrawal|execution|population)-[a-z-]+$/.test(message)
    ? message : "storage-population-withdrawal-verification-failed"}));process.exitCode=1;
});
