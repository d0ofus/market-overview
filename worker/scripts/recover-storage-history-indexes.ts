import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEodAdmission,createEodD1Database,EOD_HISTORY_POINTER_INDEX_DDL } from "../src/eod-d1-rest";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { loadStorageMigration,resumeStorageMigration,storageMigrationIdentity } from "../src/market-storage-control";
import { createStorageWorkflowQuiescence } from "../src/market-storage-github-revocation";
import { prepareStorageHistoryIndexRecovery,applyStorageHistoryPointerIndexes,approveStorageHistoryIndexRecovery } from "../src/market-storage-history-index-recovery";
import { collectStorageHistoryIndexCodeContract } from "./storage-history-index-code-contract";

// Explicit operator protocol: prepare -> apply -> approve. No original proof or
// history ledger date is rewritten. Run only from clean, reviewed, pushed main.
// Uses the ordinary EOD D1/account ledgers; no ADMIN or price-provider credential.
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const required=(name:string)=>{const value=process.env[name]?.trim();if(!value)throw new Error("storage-history-index-recovery-setting-missing");return value;};
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:null;
async function main():Promise<void> {
  const stage=process.argv[2];if(!["prepare","apply","approve"].includes(stage)||process.argv.length!==3)throw new Error("storage-history-index-recovery-command-invalid");
  const accountId=required("CLOUDFLARE_ACCOUNT_ID"),token=required("CLOUDFLARE_EOD_D1_TOKEN"),id=required("EOD_STORAGE_MIGRATION_ID");
  const source=required("EOD_STORAGE_SOURCE_DATABASE_ID"),target=required("EOD_STORAGE_TARGET_DATABASE_ID"),history=required("EOD_HISTORY_DATABASE_ID"),opsId=required("EOD_OPS_DATABASE_ID");
  const fromRevision=required("EOD_STORAGE_PREVIOUS_EXECUTION_REVISION"),expectedPlanHash=required("EOD_STORAGE_PREVIOUS_PLAN_HASH");
  const repository=process.env.EOD_GITHUB_REPOSITORY ?? "d0ofus/market-overview",profile=resolveEodBudgetProfile(required("EOD_BUDGET_PROFILE"));
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository)||profile.name!=="paid")throw new Error("storage-history-index-recovery-paid-profile-required");
  const command=(exe:string,args:string[])=>{
    try{return execFileSync(exe,args,{cwd:root,encoding:"utf8",windowsHide:true,timeout:30_000,maxBuffer:32_000_000,stdio:["ignore","pipe","pipe"]});}
    catch{throw new Error("storage-history-index-recovery-control-verification-failed");}
  };
  const git=(...args:string[])=>command("git",args).trim(),gh=(path:string)=>object(JSON.parse(command("gh",["api",path]))) ?? {};
  const codeRevision=git("rev-parse","HEAD"),diff=command("git",["diff","--no-ext-diff","--binary",fromRevision,codeRevision,"--"]);
  const changedFiles=command("git",["diff","--name-only","--no-renames","-z",fromRevision,codeRevision,"--"]).split("\0").filter(Boolean);
  const assertReviewedCheckout=async()=>{
    if(!/^[a-f0-9]{40}$/.test(codeRevision)||git("rev-parse","HEAD")!==codeRevision||git("branch","--show-current")!=="main"||git("status","--porcelain")
      ||object(gh(`repos/${repository}/git/ref/heads/main`).object)?.sha!==codeRevision||git("merge-base",fromRevision,codeRevision)!==fromRevision)throw new Error("storage-history-index-recovery-clean-github-main-required");
  };
  const variables=()=>{
    const body=gh(`repos/${repository}/environments/market-eod/variables?per_page=100`);
    if(!Array.isArray(body.variables)||body.total_count!==body.variables.length)throw new Error("storage-history-index-recovery-github-variables-incomplete");
    return new Map(body.variables.map(value=>{const row=object(value);return [String(row?.name),String(row?.value)];}));
  };
  await assertReviewedCheckout();const codeContract=collectStorageHistoryIndexCodeContract({root,fromRevision,codeRevision});
  const ids=[source,target,history,opsId];if(new Set(ids).size!==4)throw new Error("storage-history-index-recovery-database-conflict");
  const rawOps=createEodD1Database({accountId,token,databaseId:opsId,allowedDatabaseIds:ids});
  const admission=createEodAdmission(rawOps,`history-index-recovery:${id}`,{profile,writeCredit:200,
    reconcileAccountUsage:()=>reconcileEodAccountUsage({accountId,token:process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token,ops:rawOps,profile})});
  const db=(databaseId:string)=>createEodD1Database({accountId,token,databaseId,allowedDatabaseIds:ids,admission,
    ...(databaseId===history ? {reviewedDdl:EOD_HISTORY_POINTER_INDEX_DDL} : {})});
  const ops=db(opsId);
  try {
    const run=await loadStorageMigration(ops,id),vars=variables();
    if(!run||run.source_database_id!==source||run.target_database_id!==target||run.history_database_id!==history
      ||vars.get("EOD_STORAGE_CODE_REVISION")!==run.code_revision||vars.get("EOD_STORAGE_SOURCE_DATABASE_ID")!==source||vars.get("EOD_STORAGE_TARGET_DATABASE_ID")!==target
      ||vars.get("EOD_HISTORY_DATABASE_ID")!==history||vars.get("EOD_OPS_DATABASE_ID")!==opsId||vars.get("CLOUDFLARE_ACCOUNT_ID")!==accountId
      ||vars.get("EOD_BUDGET_PROFILE")!=="paid"||![fromRevision,codeRevision].includes(vars.get("EOD_STORAGE_EXECUTION_REVISION")??""))throw new Error("storage-history-index-recovery-durable-identity-conflict");
    const assertRevokedRunClaimFence=async()=>{
      const oldRunner=command("git",["show",`${fromRevision}:worker/scripts/market-storage-runner.ts`]),oldControl=command("git",["show",`${fromRevision}:worker/src/market-storage-control.ts`]);
      if(!oldRunner.includes("await assertStorageExecutionRevision(meteredOps,existing,codeRevision)")||!oldRunner.includes("githubRunId:process.env.GITHUB_RUN_ID,executionRevision:codeRevision")
        ||!oldControl.includes("COALESCE(execution_revision,code_revision)=?")||!oldControl.includes("storageGitHubRevocationKey(options.githubRunId)")
        ||!oldControl.includes("AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM eod_rollout_evidence WHERE id=?))")||!oldControl.includes("revocationKey,revocationKey"))throw new Error("storage-history-index-recovery-revoked-run-fence-required");
    };
    const assertNoWorkflowWriters=createStorageWorkflowQuiescence({ops,repository,migration:storageMigrationIdentity(run),fromRevision,codeRevision,
      revokeRunId:process.env.EOD_STORAGE_REVOKE_UNALLOCATED_RUN_ID,readGitHub:async path=>gh(path),assertRevokedRunClaimFence});
    const measurePhysical=async()=>{
      const sizes:number[]=[];
      for(const databaseId of [target,history]) {
        const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`,
          {headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20_000)});
        if(!response.ok)throw new Error("storage-history-index-recovery-capacity-read-failed");
        const body=object(await response.json()),result=object(body?.result);
        if(body?.success!==true||result?.uuid!==databaseId||typeof result.file_size!=="number"||!Number.isSafeInteger(result.file_size))throw new Error("storage-history-index-recovery-capacity-identity-invalid");
        sizes.push(result.file_size);
      }
      return {targetBytes:sizes[0],historyBytes:sizes[1],measuredAt:new Date().toISOString()};
    };
    const input={ops,source:db(source),target:db(target),history:db(history),migrationId:id,fromRevision,codeRevision,expectedPlanHash,
      changedFiles,diffHash:createHash("sha256").update(diff).digest("hex"),codeContract,assertReviewedCheckout,assertNoWorkflowWriters,measurePhysical};
    if(stage==="prepare") {
      const result=await prepareStorageHistoryIndexRecovery(input);
      console.log(JSON.stringify({status:"index-recovery-prepared",migrationId:id,evidenceHash:result.evidenceHash,historyRevision:result.history.revision,physical:result.physical}));
    } else if(stage==="apply") {
      const result=await applyStorageHistoryPointerIndexes(input);
      console.log(JSON.stringify({status:"reviewed-indexes-applied",migrationId:id,historyRevision:result.revision,schemaHash:result.schemaHash,indexManifestHash:result.indexManifestHash}));
    } else {
      const result=await approveStorageHistoryIndexRecovery(input);
      command("gh",["variable","set","EOD_STORAGE_EXECUTION_REVISION","--env","market-eod","--repo",repository,"--body",codeRevision]);
      if(variables().get("EOD_STORAGE_EXECUTION_REVISION")!==codeRevision)throw new Error("storage-history-index-recovery-github-pin-unconfirmed");
      const latest=await loadStorageMigration(ops,id);
      if(latest?.status==="awaiting-evidence"&&latest.error_code==="storage-execution-github-pin-required")await resumeStorageMigration(ops,id,run.code_revision);
      console.log(JSON.stringify({status:"index-recovery-approved",migrationId:id,executionRevision:codeRevision,validationPlanHash:result.plan.planHash,
        previousPlanHash:expectedPlanHash,amendmentHash:result.recovery.evidenceHash,executionEvidenceHash:result.execution.evidenceHash,
        originalEvidencePreserved:true,historyRevision:result.recovery.amendment.revision,hotSessions:90}));
    }
  } finally {await admission.flush();}
}
main().catch((error:unknown)=>{
  const message=error instanceof Error ? error.message : "";
  console.error(JSON.stringify({status:"index-recovery-not-approved",reason:/^(storage-[a-z-]+|eod-(?:account|rolling|resource|daily|budget)[a-z-]*)$/.test(message)?message:"storage-history-index-recovery-verification-failed"}));process.exitCode=1;
});
