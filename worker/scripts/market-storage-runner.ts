import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { claimStorageMigration, createStorageMigration, deferStorageMigration, loadStorageMigration,
  pauseStorageMigration, resumeStorageMigration, authorizeStorageMigrationFreeze, storageMigrationIdentity,
  loadStorageMigrationCheckpoint, markStorageMigrationReady, completeStorageMigration } from "../src/market-storage-control";
import { STORAGE_BUSINESS_DDL, STORAGE_TARGET_DDL } from "../src/market-storage-copy";
import { runStoragePipeline, loadStoragePreflight } from "../src/market-storage-pipeline";
import { prepareStoragePreflight } from "../src/market-storage-preflight";
import { prepareStorageSourceFence, assertStorageSourceFrozen } from "../src/market-storage-fence";
import { storageHash } from "../src/market-storage-pages";
import { verifyStorageAcceptedPublications, collectStoragePublicationGrowthSamples, type StorageAcceptanceCapture, type StorageConsumerEvidence } from "../src/market-storage-acceptance";
import { buildStorageCutoverEvidence, storeStorageCutoverProof } from "../src/market-storage-cutover-evidence";
import { storeStorageHistoryMaintenanceApproval } from "../src/eod-storage-history-capacity";
import { refreshHistoryMaintenanceEvidence } from "../src/eod-history-capacity";
import { collectRuntimeEvidence, validateRuntimeEvidence, type RuntimeEvidence } from "../src/eod-runtime-evidence";
import { verifyStoragePublicBindings } from "../src/market-storage-activation";
import { assertEodCutover } from "../src/eod-rollout-service";
import { expectedEodSession } from "../src/eod-coordinator";
import { finalizeRecentEodUsage, collectEodRolloutMonitoring } from "../src/eod-rollout-monitor";
import type { Env } from "../src/types";

function required(name:string):string {const value=process.env[name]?.trim();if(!value)throw new Error(`Missing ${name}`);return value;}
function file(name:string):unknown { const text=readFileSync(required(name),"utf8");if(Buffer.byteLength(text)>2_000_000)throw new Error("storage-evidence-file-too-large");return JSON.parse(text); }
function githubVariables():Map<string,string> {
  const repository=process.env.EOD_GITHUB_REPOSITORY ?? "d0ofus/market-overview";
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository))throw new Error("storage-github-repository-invalid");
  const body=JSON.parse(execFileSync("gh",["api",`repos/${repository}/environments/market-eod/variables?per_page=100`],
    {encoding:"utf8",windowsHide:true,maxBuffer:1_000_000})) as {total_count:number;variables:Array<{name:string;value:string}>};
  if(!Array.isArray(body.variables) || body.total_count!==body.variables.length)throw new Error("storage-github-variables-incomplete");
  return new Map(body.variables.map(row=>[row.name,row.value]));
}
async function main():Promise<void> {
  const codeRevision=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8",windowsHide:true}).trim();
  if (!/^[a-f0-9]{40}$/.test(codeRevision)) throw new Error("storage-checkout-revision-invalid");
  const id=required("EOD_STORAGE_MIGRATION_ID"),accountId=required("CLOUDFLARE_ACCOUNT_ID"),token=required("CLOUDFLARE_EOD_D1_TOKEN");
  const source=process.env.EOD_STORAGE_SOURCE_DATABASE_ID?.trim() || required("EOD_MARKET_DATABASE_ID"),target=required("EOD_STORAGE_TARGET_DATABASE_ID"),
    history=required("EOD_HISTORY_DATABASE_ID"),ops=required("EOD_OPS_DATABASE_ID");
  if (new Set([source,target,history,ops]).size!==4) throw new Error("storage-database-identity-conflict");
  const core=process.env.EOD_CORE_DATABASE_ID?.trim();
  if(core && [source,target,history,ops].includes(core)) throw new Error("storage-core-database-identity-conflict");
  const allowedDatabaseIds=[source,target,history,ops,...(core ? [core] : [])];
  const rawOps=createEodD1Database({accountId,token,databaseId:ops,allowedDatabaseIds});
  const admission=createEodAdmission(rawOps,id,{writeCredit:500,reconcileAccountUsage:() => reconcileEodAccountUsage({
    accountId,token:process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token,ops:rawOps,
  })});
  const database=(databaseId:string,reviewedDdl?:readonly string[]) => createEodD1Database({accountId,token,databaseId,allowedDatabaseIds,admission,reviewedDdl});
  const meteredOps=database(ops),sourceDb=database(source),targetDb=database(target,[...STORAGE_TARGET_DDL,...STORAGE_BUSINESS_DDL]),historyDb=database(history);
  const env:Env={DB:core ? database(core) : targetDb,MARKET_DATA_DB:targetDb,MARKET_HISTORY_DB:historyDb,OPS_DB:meteredOps,
    EOD_CODE_REVISION:codeRevision,EOD_RUNNER_MODE:"active",EOD_READ_ENABLED:"true",EOD_ARCHIVE_PRUNE_ENABLED:"false",
    ALPACA_API_KEY:process.env.ALPACA_API_KEY,ALPACA_API_SECRET:process.env.ALPACA_API_SECRET,
    ALPACA_DAILY_FEED:"sip",ALPACA_DAILY_ADJUSTMENT:"split",ALPACA_REQUESTS_PER_MINUTE_HARD:"160",YAHOO_REQUESTS_PER_DAY_HARD:"250"};
  const installer=(databaseId:string) => async (statements:readonly string[]) => {
    const reviewed=database(databaseId,statements);
    for(let offset=0;offset<statements.length;offset+=20)await reviewed.batch(statements.slice(offset,offset+20).map((sql)=>reviewed.prepare(sql)));
  };
  // Reserve the final status before transfer work. It remains writable when a
  // later page exhausts admission; errors are sanitized fixed categories.
  const terminal=await admission([{sql:"UPDATE market_storage_migrations SET status=? WHERE id=?",params:[]}]);
  let terminalUsed=false;
  const failureDb=createEodD1Database({accountId,token,databaseId:ops,allowedDatabaseIds,admission:async (queries) => {
    if (terminalUsed || queries.length!==1 || !/^UPDATE market_storage_migrations SET /i.test(queries[0].sql)) throw new Error("storage-terminal-control-already-used");
    terminalUsed=true;return terminal;
  }});
  const bootstrapTerminal=await admission([{sql:"UPDATE eod_runs SET status=? WHERE id=?",params:[]}]);
  let bootstrapTerminalUsed=false;
  const bootstrapFailureDb=createEodD1Database({accountId,token,databaseId:ops,allowedDatabaseIds,admission:async (queries) => {
    if(bootstrapTerminalUsed || queries.length!==1 || !/^UPDATE eod_runs SET /i.test(queries[0].sql))throw new Error("storage-bootstrap-terminal-control-already-used");
    bootstrapTerminalUsed=true;return bootstrapTerminal;
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
    const assertOriginalCapture=async () => {
      if(!existing.source_schema_hash || existing.source_revision===null)throw new Error("storage-source-capture-required");
      const actual=await assertStorageSourceFrozen(sourceDb,storageMigrationIdentity(existing),existing.source_schema_hash);
      if(actual.revision!==existing.source_revision)throw new Error("storage-source-capture-changed");
    };
    const collectAuthenticatedRuntime=async () => {
      const requested=file("EOD_STORAGE_RUNTIME_EVIDENCE_PATH") as RuntimeEvidence;
      if(requested?.identity?.codeRevision!==codeRevision || requested.identity.targetDatabaseId!==target
        || requested.identity.historyDatabaseId!==history || requested.identity.opsDatabaseId!==ops
        || !core || requested.identity.coreDatabaseId!==core
        || !Number.isFinite(requested.window?.to) || requested.window.to>Date.now()
        || Date.now()-requested.window.to>86_400_000)throw new Error("storage-runtime-evidence-identity-or-age-mismatch");
      await validateRuntimeEvidence(requested,requested.identity);
      // Authenticate the recorded window again; a local JSON hash is not remote
      // attestation. Missing or truncated logs must leave acceptance pending.
      const runtime=await collectRuntimeEvidence({accountId,token:process.env.CLOUDFLARE_API_TOKEN || token,
        identity:requested.identity,from:requested.window.from,to:requested.window.to});
      await validateRuntimeEvidence(runtime,requested.identity);
      return runtime;
    };
    const buildProof=async (runId:string,tickers:string[],expected:string,sourceSnapshotSha256:string) => {
      const capture=await loadStorageMigrationCheckpoint(meteredOps,id,"verification:complete");
      const consumers=await loadStorageMigrationCheckpoint(meteredOps,id,"consumer-parity:complete");
      if(!capture || !consumers || capture.inputHash!==consumers.inputHash)throw new Error("storage-reader-verification-required");
      const captured=capture.payload as StorageAcceptanceCapture;
      if(capture.inputHash!==captured.captureHash || captured.sourceCapture.schemaHash!==existing.source_schema_hash
        || captured.sourceCapture.revision!==existing.source_revision)throw new Error("storage-reader-source-capture-mismatch");
      const runtime=await collectAuthenticatedRuntime(),analysis=file("EOD_STORAGE_ANALYSIS_PATH");
      const built=await buildStorageCutoverEvidence({env,identity:storageMigrationIdentity(existing),runId,tickers,expectedSession:expected,
        capture:captured,consumers:consumers.payload as StorageConsumerEvidence,
        analysis,publicationGrowth:file("EOD_STORAGE_PUBLICATION_GROWTH_PATH"),sourceSnapshotSha256,
        runtime,runtimeIdentity:runtime.identity,assertSourceCapture:assertOriginalCapture});
      return {...built,runtime,analysis,capture,consumers};
    };
    if (command==="status") {
      console.log(JSON.stringify({id,status:existing.status,stage:existing.stage,nextRetry:existing.next_attempt_at,
        failedStage:existing.error_code,freezeAuthorized:existing.freeze_authorized===1,progress:JSON.parse(existing.progress_json)}));return;
    }
    if(command==="sample-publications" || command==="build-cutover-evidence" || command==="complete") {
      if(existing.code_revision!==codeRevision)throw new Error("storage-run-code-revision-mismatch");
      await assertOriginalCapture();
      if(command==="complete" && existing.status!=="awaiting-cutover")throw new Error("storage-activation-not-ready");
      const preflight=await loadStoragePreflight(meteredOps,existing);
      const bootstrap=await loadStorageMigrationCheckpoint(meteredOps,id,"bootstrap:complete");
      const owner=bootstrap?.payload as {runId:string;targetDatabaseId:string}|undefined;
      if(!owner || owner.targetDatabaseId!==target)throw new Error("storage-completed-bootstrap-required");
      const currentOwner=await loadStorageMigrationCheckpoint(meteredOps,id,"bootstrap:owner");
      if(await storageHash(currentOwner?.payload)!==await storageHash(owner))throw new Error("storage-completed-bootstrap-owner-mismatch");
      const expected=await expectedEodSession(env);
      if(!expected)throw new Error("storage-acceptance-calendar-unavailable");
      if(command==="build-cutover-evidence") {
        const built=await buildProof(owner.runId,preflight.tickers,expected,preflight.evidence.sourceSnapshotHash);
        const output=required("EOD_STORAGE_CUTOVER_EVIDENCE_PATH");
        writeFileSync(output,JSON.stringify(built.proof,null,2)+"\n");
        writeFileSync(`${output}.provenance.json`,JSON.stringify(built.provenance,null,2)+"\n");
        console.log(JSON.stringify({id,status:"cutover-evidence-built",session:expected,scopes:built.proof.scopes.length,
          tickers:built.proof.sharedTickers.count,hotSessions:built.capacity.hotSessions,
          forecastSessions:built.capacity.forecastSessions,proofHash:built.provenance.proofHash,publicCutover:false}));return;
      }
      const publications=await verifyStorageAcceptedPublications({env,identity:storageMigrationIdentity(existing),
        runId:owner.runId,tickers:preflight.tickers,expectedSession:expected});
      if(command==="sample-publications") {
        const samples=await collectStoragePublicationGrowthSamples(env,publications,preflight.evidence.sourceSchemaHash);
        writeFileSync(required("EOD_STORAGE_PUBLICATION_SAMPLES_PATH"),JSON.stringify(samples));
        console.log(JSON.stringify({id,status:"publication-samples-collected",session:expected,scopes:publications.scopes.length}));return;
      }
      const approved=await assertEodCutover(env,codeRevision);
      const accepted=JSON.parse(existing.progress_json) as {publications?:{runId:string;scopes:Array<{id:string}>}};
      if(!approved || accepted.publications?.runId!==owner.runId || accepted.publications.scopes.length!==publications.scopes.length
        || accepted.publications.scopes.some(scope=>!publications.scopes.some(row=>row.id===scope.id))) {
        throw new Error("storage-activation-publications-changed");
      }
      const variables=githubVariables();
      const binding=await verifyStoragePublicBindings({accountId,token:process.env.CLOUDFLARE_API_TOKEN || token,
        workerName:process.env.EOD_WORKER_NAME ?? "market-command-worker",identity:storageMigrationIdentity(existing),opsDatabaseId:ops,
        githubMarketDatabaseId:variables.get("EOD_MARKET_DATABASE_ID") ?? "",githubRunnerMode:variables.get("EOD_RUNNER_MODE") ?? ""});
      const activation={version:1,activatedAt:binding.observedAt,codeRevision,marketDatabaseId:target};
      // Keep the actual first observed public activation on replay. It is not
      // backdated to private target publication or an earlier accepted payload.
      await meteredOps.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES('monitoring:public-activation',?,?) ON CONFLICT(id) DO NOTHING")
        .bind(JSON.stringify(activation),binding.observedAt).run();
      const recorded=await meteredOps.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id='monitoring:public-activation'").first<string>("evidence_json");
      if(!recorded || JSON.parse(recorded).marketDatabaseId!==target || JSON.parse(recorded).codeRevision!==codeRevision)throw new Error("storage-activation-existing-record-conflict");
      await completeStorageMigration(meteredOps,id,{targetDatabaseId:target,codeRevision,cutoverEvidenceHash:await storageHash({binding,publications})});
      await collectEodRolloutMonitoring(env);
      console.log(JSON.stringify({id,status:"completed",session:expected,monitoring:"ten-trading-sessions-required"}));return;
    }
    if(command==="authorize") {
      if(codeRevision!==existing.code_revision)throw new Error("storage-run-code-revision-mismatch");
      const snapshotSource=file("EOD_STORAGE_SNAPSHOT_IDENTITY_PATH") as {accountId:string;sourceDatabaseId:string;runId:string};
      const frozen=file("EOD_STORAGE_FROZEN_INPUT_PATH") as {tickers:string[];calendarDates:string[]};
      const schema=await prepareStorageSourceFence(sourceDb);
      const prepared=await prepareStoragePreflight({analysis:file("EOD_STORAGE_ANALYSIS_PATH"),identity:storageMigrationIdentity(existing),
        snapshotSource,accountId,sourceSchemaHash:schema.schemaHash,tickers:frozen.tickers});
      if(!Array.isArray(frozen.calendarDates) || frozen.calendarDates.at(-1)!==existing.session_date)throw new Error("storage-preflight-calendar-invalid");
      let record={...prepared,tickers:frozen.tickers,calendarDates:frozen.calendarDates};
      const evidenceId=`storage-preflight:${id}`;
      const previous=await meteredOps.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(evidenceId).first<string>("evidence_json");
      if(previous) {
        const prior=JSON.parse(previous) as typeof record;
        // preparedAt belongs to the first successful write, not each retry.
        if(await storageHash(prior.evidence)!==prior.hash || prior.evidence.analysisHash!==record.evidence.analysisHash
          || prior.evidence.sourceSchemaHash!==record.evidence.sourceSchemaHash
          || await storageHash(prior.evidence.identity)!==await storageHash(record.evidence.identity)
          || await storageHash(prior.tickers)!==await storageHash(record.tickers)
          || await storageHash(prior.calendarDates)!==await storageHash(record.calendarDates))throw new Error("storage-preflight-existing-evidence-conflict");
        record=prior;
      }
      await meteredOps.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING")
        .bind(evidenceId,JSON.stringify(record),new Date().toISOString()).run();
      const stored=await meteredOps.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(evidenceId).first<string>("evidence_json");
      if(!stored || JSON.parse(stored).hash!==record.hash)throw new Error("storage-preflight-existing-evidence-conflict");
      await authorizeStorageMigrationFreeze(meteredOps,id,{sourceDatabaseId:source,codeRevision,schemaHash:schema.schemaHash,evidenceHash:record.hash});
      if(existing.status==="awaiting-evidence")await resumeStorageMigration(meteredOps,id,codeRevision);
      console.log(JSON.stringify({id,status:"authorized-for-relocation",hotSessions:prepared.evidence.hotSessions,publicCutover:false}));return;
    }
    if(command==="reconstruct") {
      if(codeRevision!==existing.code_revision || !await loadStorageMigrationCheckpoint(meteredOps,id,"consumer-parity:complete"))throw new Error("storage-verified-bootstrap-required");
      const result=await meteredOps.prepare("UPDATE market_storage_migrations SET status='queued',stage='bootstrap',error_code=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND status IN ('awaiting-evidence','awaiting-cutover') AND (lease_until IS NULL OR lease_until<=?)")
        .bind(new Date().toISOString(),new Date().toISOString(),id,new Date().toISOString()).run();
      if(!result.meta.changes)throw new Error("storage-reconstruct-transition-conflict");
      console.log(JSON.stringify({id,status:"queued",purpose:"latest-private-bootstrap"}));return;
    }
    if (command==="resume") {
      if(codeRevision!==existing.code_revision) throw new Error("storage-run-code-revision-mismatch");
      await resumeStorageMigration(meteredOps,id,existing.code_revision);console.log(JSON.stringify({id,status:"queued"}));return;
    }
    if (!["run","accept"].includes(command)) throw new Error("storage-command-unsupported");
    if(command==="accept" && existing.status==="awaiting-evidence")await resumeStorageMigration(meteredOps,id,codeRevision);
    const claimed=await claimStorageMigration(meteredOps,id,{githubRunId:process.env.GITHUB_RUN_ID});
    if (!claimed) {console.log(JSON.stringify({id,status:"not-claimed"}));return;}
    if (codeRevision!==existing.code_revision) {
      await pauseStorageMigration(failureDb,id,claimed.leaseToken,"storage-run-code-revision-mismatch",{sourcePreserved:true});
      console.log(JSON.stringify({id,status:"awaiting-evidence",reason:"code-revision-mismatch"}));process.exitCode=1;return;
    }
    try {
      if(command==="accept") {
        await assertOriginalCapture();
        const preflight=await loadStoragePreflight(meteredOps,claimed.run);
        const bootstrap=await loadStorageMigrationCheckpoint(meteredOps,id,"bootstrap:complete");
        const owner=bootstrap?.payload as {runId:string;targetDatabaseId:string}|undefined;
        if(!owner || owner.targetDatabaseId!==target)throw new Error("storage-completed-bootstrap-required");
        const currentOwner=await loadStorageMigrationCheckpoint(meteredOps,id,"bootstrap:owner");
        if(await storageHash(currentOwner?.payload)!==await storageHash(owner))throw new Error("storage-completed-bootstrap-owner-mismatch");
        const expected=await expectedEodSession(env);
        if(!expected)throw new Error("storage-acceptance-calendar-unavailable");
        // Rebuild at acceptance: a reviewed artifact cannot override fresh
        // publications, measured capacity, runtime logs or account reservations.
        const {proof,provenance,publications,capacity,runtime,analysis,capture,consumers}=
          await buildProof(owner.runId,preflight.tickers,expected,preflight.evidence.sourceSnapshotHash);
        await meteredOps.prepare("INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES('cutover',?,?) ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,updated_at=excluded.updated_at")
          .bind(JSON.stringify(proof),new Date().toISOString()).run();
        await assertEodCutover(env,codeRevision);
        await storeStorageHistoryMaintenanceApproval(env,{capacity,analysis,publications,tickers:preflight.tickers,
          capture:capture.payload as StorageAcceptanceCapture,consumers:consumers.payload as StorageConsumerEvidence});
        await refreshHistoryMaintenanceEvidence(env,{tickers:preflight.tickers,codeRevision});
        const storageProof=await storeStorageCutoverProof(meteredOps,{identity:storageMigrationIdentity(claimed.run),proof,provenance});
        const evidence={version:1,publications,capacity,runtimeEvidenceHash:runtime.evidenceHash,cutoverProofHash:storageProof.record.proofHash,
          storageCutoverProofId:storageProof.id,
          cutoverProvenance:provenance,publicBindingChanged:false};
        await markStorageMigrationReady(meteredOps,id,claimed.leaseToken,evidence);
        console.log(JSON.stringify({id,status:"awaiting-cutover",session:expected,hotSessions:capacity.hotSessions}));return;
      }
      await finalizeRecentEodUsage({accountId,token:process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || token,ops:meteredOps});
      const status=await runStoragePipeline({source:sourceDb,target:targetDb,history:historyDb,ops:meteredOps,
        run:claimed.run,leaseToken:claimed.leaseToken,installSourceFence:installer(source),installTargetFence:installer(target),installHistoryFence:installer(history),
        bootstrapEnv:core && env.ALPACA_API_KEY && env.ALPACA_API_SECRET ? env : undefined,bootstrapFailureDb});
      console.log(JSON.stringify({id,status}));
      await collectEodRolloutMonitoring(env).catch(()=>undefined);
    } catch (error:unknown) {
      const message=error instanceof Error ? error.message : "storage-copy-failed";
      const quota=/budget-exhausted|quota-exhausted|capacity-exceeded/.test(message);
      const transient=quota || /network-error|request-timeout|d1-http-(429|5\d\d)|d1-response-invalid-json: status=5\d\d|time-slice-complete|bootstrap-incomplete|bootstrap-retry-not-due/.test(message);
      if (transient) await deferStorageMigration(failureDb,id,claimed.leaseToken,quota ? "storage-quota-deferred" : "storage-resume-required",{quota});
      else await pauseStorageMigration(failureDb,id,claimed.leaseToken,
        /^[a-z0-9-]{1,100}$/.test(message) ? message : "storage-copy-verification-failed",{sourcePreserved:true});
      console.error(JSON.stringify({id,status:transient ? "retrying" : "awaiting-evidence",reason:quota ? "quota" : "copy-interrupted"}));
      process.exitCode=1;
    }
  } finally {
    try {if(!terminalUsed)await terminal({rowsRead:0,rowsWritten:0,sizeAfter:0});
      if(!bootstrapTerminalUsed)await bootstrapTerminal({rowsRead:0,rowsWritten:0,sizeAfter:0});} finally {await admission.flush();}
  }
}
main().catch((error:unknown) => {console.error(error instanceof Error ? error.message.slice(0,300) : "storage-runner-failed");process.exitCode=1;});
