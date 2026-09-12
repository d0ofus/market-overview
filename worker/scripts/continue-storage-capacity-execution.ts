import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname,resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadEodInputs } from "../src/eod-runner";
import { expectedEodSession } from "../src/eod-coordinator";
import { loadStorageValidationPlan } from "../src/market-storage-population-plan";
import { verifyStorageCapacityArtifacts } from "./storage-current-archive-context";
import type { Env } from "../src/types";
import { fileURLToPath } from "node:url";
import { createEodAdmission,createEodD1Database } from "../src/eod-d1-rest";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { loadStorageMigration,storageMigrationIdentity } from "../src/market-storage-control";
import { createStorageWorkflowQuiescence } from "../src/market-storage-github-revocation";
import { approveStorageCapacityExecution, resumeStorageCapacityExecution } from "../src/market-storage-capacity-execution";
import { collectStorageCapacityExecutionCodeContract } from "./storage-capacity-execution-code-contract";

// Exact completed R20 admission of the reviewed current-archive model. No price, provider, EOD-run, quota,
// history or old evidence mutations. Requires clean, reviewed, pushed main.
// Uses the ordinary EOD D1/account ledgers; no ADMIN or price-provider credential.
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const required=(name:string)=>{const value=process.env[name]?.trim();if(!value)throw new Error("storage-capacity-execution-setting-missing");return value;};
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:null;
async function main():Promise<void> {
  if(process.argv.length!==2)throw new Error("storage-capacity-execution-command-invalid");
  const accountId=required("CLOUDFLARE_ACCOUNT_ID"),token=required("CLOUDFLARE_EOD_D1_TOKEN"),id=required("EOD_STORAGE_MIGRATION_ID");
  const source=required("EOD_STORAGE_SOURCE_DATABASE_ID"),target=required("EOD_STORAGE_TARGET_DATABASE_ID"),history=required("EOD_HISTORY_DATABASE_ID"),opsId=required("EOD_OPS_DATABASE_ID");
  const fromRevision=required("EOD_STORAGE_PREVIOUS_EXECUTION_REVISION"),expectedPlanHash=required("EOD_STORAGE_PREVIOUS_PLAN_HASH");
  const core=required("EOD_CORE_DATABASE_ID"),analysisPath=resolve(required("EOD_STORAGE_FAILED_ANALYSIS_PATH")),sourcePath=resolve(required("EOD_STORAGE_SNAPSHOT_PATH"));
  const analysisText=readFileSync(analysisPath,"utf8");if(Buffer.byteLength(analysisText)>8_000_000)throw new Error("storage-capacity-execution-analysis-too-large");
  const failedAnalysis:unknown=JSON.parse(analysisText),failedAnalysisFileHash=createHash("sha256").update(analysisText).digest("hex");
  const repository=process.env.EOD_GITHUB_REPOSITORY ?? "d0ofus/market-overview",profile=resolveEodBudgetProfile(required("EOD_BUDGET_PROFILE"));
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository)||profile.name!=="paid")throw new Error("storage-capacity-execution-paid-profile-required");
  const command=(exe:string,args:string[])=>{
    try{return execFileSync(exe,args,{cwd:root,encoding:"utf8",windowsHide:true,timeout:30_000,maxBuffer:32_000_000,stdio:["ignore","pipe","pipe"]});}
    catch{throw new Error("storage-capacity-execution-control-verification-failed");}
  };
  const git=(...args:string[])=>command("git",args).trim(),gh=(path:string)=>object(JSON.parse(command("gh",["api",path]))) ?? {};
  const codeRevision=git("rev-parse","HEAD"),diff=command("git",["diff","--no-ext-diff","--binary",fromRevision,codeRevision,"--"]);
  const changedFiles=command("git",["diff","--name-only","--no-renames","-z",fromRevision,codeRevision,"--"]).split("\0").filter(Boolean);
  const assertReviewedCheckout=async()=>{
    if(!/^[a-f0-9]{40}$/.test(codeRevision)||git("rev-parse","HEAD")!==codeRevision||git("branch","--show-current")!=="main"||git("status","--porcelain")
      ||object(gh(`repos/${repository}/git/ref/heads/main`).object)?.sha!==codeRevision||git("merge-base",fromRevision,codeRevision)!==fromRevision)throw new Error("storage-capacity-execution-clean-github-main-required");
  };
  const variables=()=>{
    const body=gh(`repos/${repository}/environments/market-eod/variables?per_page=100`);
    if(!Array.isArray(body.variables)||body.total_count!==body.variables.length)throw new Error("storage-capacity-execution-github-variables-incomplete");
    return new Map(body.variables.map(value=>{const row=object(value);return [String(row?.name),String(row?.value)];}));
  };
  await assertReviewedCheckout();const codeContract=collectStorageCapacityExecutionCodeContract({root,fromRevision,codeRevision});
  const ids=[source,target,history,opsId,core];if(new Set(ids).size!==5)throw new Error("storage-capacity-execution-database-conflict");
  const rawOps=createEodD1Database({accountId,token,databaseId:opsId,allowedDatabaseIds:ids});
  const admission=createEodAdmission(rawOps,`capacity-execution:${id}`,{profile,writeCredit:200,
    reconcileAccountUsage:()=>reconcileEodAccountUsage({accountId,token:process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token,ops:rawOps,profile})});
  const db=(databaseId:string)=>createEodD1Database({accountId,token,databaseId,allowedDatabaseIds:ids,admission});
  const ops=db(opsId);
  try {
    const run=await loadStorageMigration(ops,id),vars=variables();
    if(!run||vars.get("EOD_STORAGE_MIGRATION_ID")!==id||run.source_database_id!==source||run.target_database_id!==target||run.history_database_id!==history
      ||vars.get("EOD_STORAGE_CODE_REVISION")!==run.code_revision||vars.get("EOD_STORAGE_SOURCE_DATABASE_ID")!==source||vars.get("EOD_STORAGE_TARGET_DATABASE_ID")!==target
      ||vars.get("EOD_HISTORY_DATABASE_ID")!==history||vars.get("EOD_OPS_DATABASE_ID")!==opsId||vars.get("EOD_CORE_DATABASE_ID")!==core||vars.get("CLOUDFLARE_ACCOUNT_ID")!==accountId
      ||vars.get("EOD_BUDGET_PROFILE")!=="paid"||![fromRevision,codeRevision].includes(vars.get("EOD_STORAGE_EXECUTION_REVISION")??""))throw new Error("storage-capacity-execution-durable-identity-conflict");
    const assertRevokedRunClaimFence=async()=>{
      const oldRunner=command("git",["show",`${fromRevision}:worker/scripts/market-storage-runner.ts`]),oldControl=command("git",["show",`${fromRevision}:worker/src/market-storage-control.ts`]);
      if(!oldRunner.includes("await assertStorageExecutionRevision(meteredOps,existing,codeRevision)")||!oldRunner.includes("githubRunId:process.env.GITHUB_RUN_ID,executionRevision:codeRevision")
        ||!oldControl.includes("COALESCE(execution_revision,code_revision)=?")||!oldControl.includes("storageGitHubRevocationKey(options.githubRunId)")
        ||!oldControl.includes("AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM eod_rollout_evidence WHERE id=?))")||!oldControl.includes("revocationKey,revocationKey"))throw new Error("storage-capacity-execution-revoked-run-fence-required");
    };
    const assertNoWorkflowWriters=createStorageWorkflowQuiescence({ops,repository,migration:storageMigrationIdentity(run),fromRevision,codeRevision,
      revokeRunId:process.env.EOD_STORAGE_REVOKE_UNALLOCATED_RUN_ID,readGitHub:async path=>gh(path),assertRevokedRunClaimFence});
    const measurePhysical=async()=>{
      const sizes:number[]=[];
      for(const databaseId of [target,history]) {
        const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`,
          {headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20_000)});
        if(!response.ok)throw new Error("storage-capacity-execution-capacity-read-failed");
        const body=object(await response.json()),result=object(body?.result);
        if(body?.success!==true||result?.uuid!==databaseId||typeof result.file_size!=="number"||!Number.isSafeInteger(result.file_size))throw new Error("storage-capacity-execution-capacity-identity-invalid");
        sizes.push(result.file_size);
      }
      return {targetBytes:sizes[0],historyBytes:sizes[1],measuredAt:new Date().toISOString()};
    };
    const env:Env={DB:db(core),MARKET_DATA_DB:db(target),MARKET_HISTORY_DB:db(history),OPS_DB:ops,EOD_CODE_REVISION:codeRevision,
      EOD_BUDGET_PROFILE:"paid",EOD_RUNNER_MODE:"active",EOD_READ_ENABLED:"true",EOD_ARCHIVE_PRUNE_ENABLED:"false",ALPACA_DAILY_FEED:"sip"};
    const original=await loadStorageValidationPlan(ops,run);
    const loadCurrentInputs=async()=>{const session=await expectedEodSession(env);if(!session)throw new Error("storage-capacity-execution-calendar-unavailable");return loadEodInputs(env,session);};
    const assertCapturedArtifact=(receipt:import("./eod-population-expansion-operator").StorageExpansionHistoryReceipt)=>
      verifyStorageCapacityArtifacts({receipt,sourceFile:sourcePath,analysisPath,expectedSourceSnapshotHash:original.sourceSnapshotHash});
    const input={ops,source:db(source),target:db(target),history:db(history),migrationId:id,fromRevision,codeRevision,expectedPlanHash,
      loadCurrentInputs,failedAnalysis,failedAnalysisFileHash,assertCapturedArtifact,
      changedFiles,diffHash:createHash("sha256").update(diff).digest("hex"),codeContract,assertReviewedCheckout,assertNoWorkflowWriters,measurePhysical};
    const result=await approveStorageCapacityExecution(input);
    command("gh",["variable","set","EOD_STORAGE_EXECUTION_REVISION","--env","market-eod","--repo",repository,"--body",codeRevision]);
    if(variables().get("EOD_STORAGE_EXECUTION_REVISION")!==codeRevision)throw new Error("storage-capacity-execution-github-pin-unconfirmed");
    const latest=await loadStorageMigration(ops,id);
    if(latest?.status==="awaiting-evidence"&&latest.error_code==="storage-execution-github-pin-required")await resumeStorageCapacityExecution(ops,id,codeRevision);
    console.log(JSON.stringify({status:"capacity-execution-continuation-approved",migrationId:id,executionRevision:codeRevision,validationPlanHash:result.plan.planHash,
      previousPlanHash:expectedPlanHash,continuationHash:result.continuation.evidenceHash,executionEvidenceHash:result.execution.evidenceHash,
      historyReceiptHash:result.continuation.historyReceipt.evidenceHash,failedAnalysisHash:result.continuation.failure.analysisHash,localSourceRows:result.continuation.failure.localSourceRows,verifiedCopySourceRows:result.continuation.failure.verifiedCopySourceRows,sourceCountMismatch:result.continuation.failure.sourceCountMismatch,legacyProjectedArchiveBytes:result.continuation.failure.projectedArchiveBytes,deltaEvidenceHash:result.continuation.deltaEvidenceHash,remainsPausedForSizing:latest?.status==="awaiting-evidence",predecessorAuditHash:result.continuation.predecessorAuditHash,featureCheckpointsPreserved:result.continuation.featureCheckpointCount,historyRevision:result.continuation.historyRevision,eodRunPreserved:true,hotSessions:90}));
  } finally {await admission.flush();}
}
main().catch((error:unknown)=>{
  const message=error instanceof Error ? error.message : "";
  const measured=/^eod-d1-query-budget-estimate-exceeded; reads=(\d+)\/(\d+); writes=(\d+)\/(\d+); statements=(\d+); classes=([a-z_,-]+)$/.exec(message);
  console.error(JSON.stringify({status:"capacity-execution-continuation-not-approved",reason:measured ? "eod-d1-query-budget-estimate-exceeded"
    : /^(storage-[a-z-]+|eod-(?:account|rolling|resource|daily|budget)[a-z-]*|d1-(?:request-timeout|network-error|response-result-count-or-shape-mismatch|usage-metadata-unavailable))$/.test(message)?message:"storage-capacity-execution-verification-failed",
    ...(measured?{rowsRead:Number(measured[1]),reservedReads:Number(measured[2]),rowsWritten:Number(measured[3]),reservedWrites:Number(measured[4]),statements:Number(measured[5]),classes:measured[6]}:{})}));process.exitCode=1;
});
