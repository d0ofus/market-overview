import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { approveStorageExecutionTransition } from "../src/market-storage-execution";
import { loadStorageMigration, resumeStorageMigration, storageMigrationIdentity } from "../src/market-storage-control";
import { createStorageWorkflowQuiescence } from "../src/market-storage-github-revocation";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error("storage-execution-setting-missing"); return value; };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
async function main(): Promise<void> {
  const accountId = required("CLOUDFLARE_ACCOUNT_ID"), token = required("CLOUDFLARE_EOD_D1_TOKEN"), id = required("EOD_STORAGE_MIGRATION_ID");
  const source = required("EOD_STORAGE_SOURCE_DATABASE_ID"), target = required("EOD_STORAGE_TARGET_DATABASE_ID"), history = required("EOD_HISTORY_DATABASE_ID"), opsId = required("EOD_OPS_DATABASE_ID");
  const fromRevision = required("EOD_STORAGE_PREVIOUS_EXECUTION_REVISION"), repository = process.env.EOD_GITHUB_REPOSITORY ?? "d0ofus/market-overview";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(fromRevision)) throw new Error("storage-execution-identity-invalid");
  const command = (exe: string, args: string[]) => {
    try { return execFileSync(exe,args,{cwd:root,encoding:"utf8",windowsHide:true,timeout:30_000,maxBuffer:16_000_000,stdio:["ignore","pipe","pipe"]}); }
    catch { throw new Error("storage-execution-control-verification-failed"); }
  };
  const git = (...args: string[]) => command("git",args).trim();
  const gh = (path: string): Record<string, unknown> => object(JSON.parse(command("gh",["api",path]))) ?? {};
  const codeRevision = git("rev-parse","HEAD");
  const diff = command("git",["diff","--no-ext-diff","--binary",fromRevision,codeRevision,"--"]);
  const changedFiles = command("git",["diff","--name-only","--no-renames","-z",fromRevision,codeRevision,"--"]).split("\0").filter(Boolean);
  // Source/history DDL and encoding contracts cannot change during a retained
  // copy. New execution must finish fresh validation; old measurements stay old.
  const protectedPaths = ["worker/market-data-migrations/","worker/history-migrations/"];
  if (changedFiles.some((path) => protectedPaths.some((prefix) => path.startsWith(prefix)))) throw new Error("storage-execution-storage-schema-change");
  const assertReviewedCheckout = async () => {
    if (!/^[a-f0-9]{40}$/.test(codeRevision) || git("rev-parse","HEAD") !== codeRevision || git("branch","--show-current") !== "main"
      || git("status","--porcelain") || object(gh(`repos/${repository}/git/ref/heads/main`).object)?.sha !== codeRevision) throw new Error("storage-execution-clean-github-main-required");
    if (git("merge-base",fromRevision,codeRevision) !== fromRevision) throw new Error("storage-execution-ancestor-required");
  };
  const variables = () => {
    const body = gh(`repos/${repository}/environments/market-eod/variables?per_page=100`);
    if (!Array.isArray(body.variables) || body.total_count !== body.variables.length) throw new Error("storage-execution-github-variables-incomplete");
    return new Map(body.variables.map((row) => { const item = object(row); return [String(item?.name),String(item?.value)]; }));
  };
  await assertReviewedCheckout();
  const ids = [source,target,history,opsId];
  if (new Set(ids).size !== 4) throw new Error("storage-execution-database-identity-conflict");
  const profile = resolveEodBudgetProfile(process.env.EOD_BUDGET_PROFILE);
  const rawOps = createEodD1Database({accountId,token,databaseId:opsId,allowedDatabaseIds:ids});
  const admission = createEodAdmission(rawOps,`execution-transition:${id}`,{profile,writeCredit:200,
    reconcileAccountUsage:() => reconcileEodAccountUsage({accountId,token:process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token,ops:rawOps,profile})});
  const db = (databaseId: string) => createEodD1Database({accountId,token,databaseId,allowedDatabaseIds:ids,admission});
  const ops = db(opsId);
  try {
    const run = await loadStorageMigration(ops,id), vars = variables();
    if (!run || run.source_database_id !== source || run.target_database_id !== target || run.history_database_id !== history
      || vars.get("EOD_STORAGE_CODE_REVISION") !== run.code_revision || vars.get("EOD_STORAGE_TARGET_DATABASE_ID") !== target
      || vars.get("EOD_STORAGE_SOURCE_DATABASE_ID") !== source || vars.get("EOD_HISTORY_DATABASE_ID") !== history
      || vars.get("EOD_OPS_DATABASE_ID") !== opsId || vars.get("CLOUDFLARE_ACCOUNT_ID") !== accountId) throw new Error("storage-execution-durable-identity-conflict");
    // Only an explicit exact run ID may receive the zero-allocation exception.
    // Denial is global to that GitHub run, while the evidence records this
    // reviewed operator migration. GitHub exposes no inputs for a ghost run.
    const revokeRunId = process.env.EOD_STORAGE_REVOKE_UNALLOCATED_RUN_ID;
    if (revokeRunId !== undefined) {
      // The old checkout must already gate ingestion on its actual revision.
      // This supplements the reviewed ancestor/diff and immutable lineage: a
      // delayed old checkout cannot claim after the approval CAS changes it.
      const oldRunner = command("git",["show",`${fromRevision}:worker/scripts/market-storage-runner.ts`]);
      const oldControl = command("git",["show",`${fromRevision}:worker/src/market-storage-control.ts`]);
      if (!oldRunner.includes("await assertStorageExecutionRevision(meteredOps,existing,codeRevision)")
        || !oldRunner.includes("githubRunId:process.env.GITHUB_RUN_ID,executionRevision:codeRevision")
        || !oldControl.includes("COALESCE(execution_revision,code_revision)=?")) throw new Error("storage-execution-old-runner-revision-fence-required");
    }
    const assertNoWorkflowWriters = createStorageWorkflowQuiescence({ops,repository,migration:storageMigrationIdentity(run),
      fromRevision,codeRevision,revokeRunId,readGitHub:async path=>gh(path)});
    const record = await approveStorageExecutionTransition({ops,source:db(source),migrationId:id,fromRevision,codeRevision,
      changedFiles,diffHash:createHash("sha256").update(diff).digest("hex"),assertReviewedCheckout,assertNoWorkflowWriters});
    command("gh",["variable","set","EOD_STORAGE_EXECUTION_REVISION","--env","market-eod","--repo",repository,"--body",codeRevision]);
    if (variables().get("EOD_STORAGE_EXECUTION_REVISION") !== codeRevision) throw new Error("storage-execution-github-pin-unconfirmed");
    const latest = await loadStorageMigration(ops,id);
    if (latest?.status === "awaiting-evidence" && latest.error_code === "storage-execution-github-pin-required") await resumeStorageMigration(ops,id,run.code_revision);
    console.log(JSON.stringify({status:"execution-approved",migrationId:id,storageRevision:run.code_revision,executionRevision:codeRevision,
      evidenceHash:record.evidenceHash,checkpointsPreserved:record.checkpointCount,sourcePreserved:true,hotSessions:90}));
  } finally { await admission.flush(); }
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  console.error(JSON.stringify({status:"not-approved",reason:/^storage-execution-[a-z-]+$/.test(message) ? message : "storage-execution-verification-failed"}));
  process.exitCode = 1;
});
