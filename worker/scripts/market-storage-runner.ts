import { execFileSync } from "node:child_process";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { claimStorageMigration, createStorageMigration, deferStorageMigration, loadStorageMigration,
  pauseStorageMigration, resumeStorageMigration } from "../src/market-storage-control";
import { runStorageCopy, STORAGE_BUSINESS_DDL, STORAGE_TARGET_DDL } from "../src/market-storage-copy";

function required(name:string):string {const value=process.env[name]?.trim();if(!value)throw new Error(`Missing ${name}`);return value;}
async function main():Promise<void> {
  const codeRevision=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8",windowsHide:true}).trim();
  if (!/^[a-f0-9]{40}$/.test(codeRevision)) throw new Error("storage-checkout-revision-invalid");
  const id=required("EOD_STORAGE_MIGRATION_ID"),accountId=required("CLOUDFLARE_ACCOUNT_ID"),token=required("CLOUDFLARE_EOD_D1_TOKEN");
  const source=required("EOD_MARKET_DATABASE_ID"),target=required("EOD_STORAGE_TARGET_DATABASE_ID"),
    history=required("EOD_HISTORY_DATABASE_ID"),ops=required("EOD_OPS_DATABASE_ID");
  if (new Set([source,target,history,ops]).size!==4) throw new Error("storage-database-identity-conflict");
  const allowedDatabaseIds=[source,target,history,ops];
  const rawOps=createEodD1Database({accountId,token,databaseId:ops,allowedDatabaseIds});
  const admission=createEodAdmission(rawOps,id,{writeCredit:500,reconcileAccountUsage:() => reconcileEodAccountUsage({
    accountId,token:process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token,ops:rawOps,
  })});
  const database=(databaseId:string,reviewedDdl?:readonly string[]) => createEodD1Database({accountId,token,databaseId,allowedDatabaseIds,admission,reviewedDdl});
  const meteredOps=database(ops),sourceDb=database(source);
  // Reserve the final status before transfer work. It remains writable when a
  // later page exhausts admission; errors are sanitized fixed categories.
  const terminal=await admission([{sql:"UPDATE market_storage_migrations SET status=? WHERE id=?",params:[]}]);
  let terminalUsed=false;
  const failureDb=createEodD1Database({accountId,token,databaseId:ops,allowedDatabaseIds,admission:async (queries) => {
    if (terminalUsed || queries.length!==1 || !/^UPDATE market_storage_migrations SET /i.test(queries[0].sql)) throw new Error("storage-terminal-control-already-used");
    terminalUsed=true;return terminal;
  }});
  try {
    const command=process.argv[2] ?? "run";
    if (command==="create") {
      const run=await createStorageMigration(meteredOps,{id,sourceDatabaseId:source,targetDatabaseId:target,historyDatabaseId:history,
        sessionDate:required("EOD_STORAGE_SESSION_DATE"),codeRevision});
      console.log(JSON.stringify({id:run.id,status:run.status,freezeAuthorized:false}));return;
    }
    const existing=await loadStorageMigration(meteredOps,id);
    if (!existing || existing.source_database_id!==source || existing.target_database_id!==target
      || existing.history_database_id!==history) throw new Error("storage-run-database-identity-conflict");
    if (command==="status") {
      console.log(JSON.stringify({id,status:existing.status,stage:existing.stage,nextRetry:existing.next_attempt_at,
        failedStage:existing.error_code,freezeAuthorized:existing.freeze_authorized===1,progress:JSON.parse(existing.progress_json)}));return;
    }
    if (command==="resume") {
      if(codeRevision!==existing.code_revision) throw new Error("storage-run-code-revision-mismatch");
      await resumeStorageMigration(meteredOps,id,existing.code_revision);console.log(JSON.stringify({id,status:"queued"}));return;
    }
    if (command!=="run") throw new Error("storage-command-unsupported");
    const claimed=await claimStorageMigration(meteredOps,id,{githubRunId:process.env.GITHUB_RUN_ID});
    if (!claimed) {console.log(JSON.stringify({id,status:"not-claimed"}));return;}
    if (codeRevision!==existing.code_revision) {
      await pauseStorageMigration(failureDb,id,claimed.leaseToken,"storage-run-code-revision-mismatch",{sourcePreserved:true});
      console.log(JSON.stringify({id,status:"awaiting-evidence",reason:"code-revision-mismatch"}));process.exitCode=1;return;
    }
    try {
      const status=await runStorageCopy({source:sourceDb,target:database(target,[...STORAGE_TARGET_DDL,...STORAGE_BUSINESS_DDL]),
        history:database(history),ops:meteredOps,run:claimed.run,leaseToken:claimed.leaseToken,
        installSourceFence:async (statements) => {
          // The plan is accepted only after runStorageCopy matched the entire
          // source schema to the checked-in manifest and authorization hash.
          const ddlSource=database(source,statements);
          for (let offset=0;offset<statements.length;offset+=20) {
            await ddlSource.batch(statements.slice(offset,offset+20).map((sql) => ddlSource.prepare(sql)));
          }
        }});
      console.log(JSON.stringify({id,status}));
    } catch (error:unknown) {
      const message=error instanceof Error ? error.message : "storage-copy-failed";
      const quota=/budget-exhausted|quota-exhausted|capacity-exceeded/.test(message);
      const transient=quota || /network-error|request-timeout|d1-http-(429|5\d\d)|d1-response-invalid-json: status=5\d\d|time-slice-complete/.test(message);
      if (transient) await deferStorageMigration(failureDb,id,claimed.leaseToken,quota ? "storage-quota-deferred" : "storage-resume-required",{quota});
      else await pauseStorageMigration(failureDb,id,claimed.leaseToken,
        /^[a-z0-9-]{1,100}$/.test(message) ? message : "storage-copy-verification-failed",{sourcePreserved:true});
      console.error(JSON.stringify({id,status:transient ? "retrying" : "awaiting-evidence",reason:quota ? "quota" : "copy-interrupted"}));
      process.exitCode=1;
    }
  } finally {
    try {if(!terminalUsed)await terminal({rowsRead:0,rowsWritten:0,sizeAfter:0});} finally {await admission.flush();}
  }
}
main().catch((error:unknown) => {console.error(error instanceof Error ? error.message.slice(0,300) : "storage-runner-failed");process.exitCode=1;});
