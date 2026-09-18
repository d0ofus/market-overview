import { execFileSync } from "node:child_process";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { dailyReleaseSchema, dailySchemaHash, loadDailyRelease, readDailyEvidence, sampleDailyStorage, writeDailyEvidence,
  assertDailyReleaseBindings, type DailyRelease } from "../src/eod-daily-release";
import { loadStorageMigration, storageMigrationIdentity } from "../src/market-storage-control";
import { verifyStorageConsumerBatch, type StorageConsumerEvidence } from "../src/market-storage-acceptance";
import type { StorageVerificationEvidence } from "../src/market-storage-verification";
import { eodHash } from "../src/eod-publication-service";
import { EOD_METRICS_VERSION } from "../src/eod-metrics";
import { EOD_PUBLICATION_SCOPES } from "../src/eod-publication-scopes";
import { EOD_CATALOG_SCOPE, type EodCatalogPayload } from "../src/eod-catalog-service";
import { decodeEodPayload, type EodStoredPayload } from "../src/eod-publication-codec";
import { MARKET_HISTORY_REQUIRED_CONSUMERS } from "../src/eod-history-maintenance";
import { eodStoragePolicy } from "../src/eod-storage-policy";
import { enqueueEodRun, expectedEodSession } from "../src/eod-coordinator";
import { collectEodCurrentHealth } from "../src/eod-current-health";
import type { Env } from "../src/types";
import { loadMarketHistory, marketHistoryBarsMateriallyEqual } from "../src/market-history";

const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`eod-release-missing:${name}`); return value; };
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore","pipe","pipe"] }).trim();
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
async function main() {
  const command = process.argv[2];
  if (!["check", "prepare", "activate", "record", "enqueue-maintenance"].includes(command)) throw new Error("eod-release-command-required");
  const revision = git("rev-parse","HEAD");
  if (command !== "check" && (git("branch","--show-current") !== "main" || git("status","--porcelain"))) throw new Error("eod-release-clean-main-required");
  const accountId = required("CLOUDFLARE_ACCOUNT_ID"), token = required("CLOUDFLARE_EOD_D1_TOKEN");
  const bindings = { core: required("EOD_CORE_DATABASE_ID"), market: required("EOD_STORAGE_TARGET_DATABASE_ID"),
    history: required("EOD_HISTORY_DATABASE_ID"), ops: required("EOD_OPS_DATABASE_ID"), source: required("EOD_STORAGE_SOURCE_DATABASE_ID") };
  const allowedDatabaseIds = Object.values(bindings);
  if (new Set(allowedDatabaseIds).size !== 5) throw new Error("eod-release-database-identity-conflict");
  const rawOps = createEodD1Database({accountId,token,databaseId:bindings.ops,allowedDatabaseIds});
  const admission = createEodAdmission(rawOps, `daily-release:${revision}`, {profile:resolveEodBudgetProfile("paid"),
    reconcileAccountUsage:()=>reconcileEodAccountUsage({accountId,token:process.env.CLOUDFLARE_EOD_ANALYTICS_TOKEN || required("CLOUDFLARE_API_TOKEN"),ops:rawOps,profile:resolveEodBudgetProfile("paid")})});
  const database = (databaseId:string)=>createEodD1Database({accountId,token,databaseId,allowedDatabaseIds,admission});
  const ops=database(bindings.ops),market=database(bindings.market),history=database(bindings.history),source=database(bindings.source);
  const migrationId=required("EOD_STORAGE_MIGRATION_ID");
  const env:Env={DB:database(bindings.core),MARKET_DATA_DB:market,MARKET_HISTORY_DB:history,OPS_DB:ops,
    EOD_BUDGET_PROFILE:"paid",EOD_CODE_REVISION:revision,EOD_RUNNER_MODE:"active",EOD_READ_ENABLED:"true",
    EOD_ARCHIVE_PRUNE_ENABLED:"true",EOD_STORAGE_MIGRATION_ID:migrationId,ALPACA_DAILY_FEED:"sip",ALPACA_DAILY_ADJUSTMENT:"split"};
  const cf = async (path:string) => {
    const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}`,{headers:{Authorization:`Bearer ${required("CLOUDFLARE_API_TOKEN")}`},signal:AbortSignal.timeout(20_000)});
    if (!response.ok) throw new Error(`eod-release-control-http-${response.status}`);
    const data=await response.json() as {success:boolean;result:unknown};
    if (!data.success) throw new Error("eod-release-control-failed");
    return data.result;
  };
  try {
    const migration=await loadStorageMigration(ops,migrationId);
    if (!migration || migration.target_database_id!==bindings.market || migration.source_database_id!==bindings.source
      || migration.history_database_id!==bindings.history || (migration.lease_until && migration.lease_until>new Date().toISOString())) throw new Error("eod-release-migration-conflict");
    const sourceFence=await source.prepare("SELECT * FROM market_storage_fence WHERE id='default'").first<Record<string,unknown>>();
    if (sourceFence?.status!=="frozen" || sourceFence.migration_id!==migrationId || sourceFence.revision!==migration.source_revision
      || sourceFence.schema_hash!==migration.source_schema_hash) throw new Error("eod-release-source-fence-changed");
    let release=await loadDailyRelease(env);
    if (command==="check" || command==="prepare") {
      const checkpoints=await ops.prepare(`SELECT checkpoint_key,payload_json,updated_at FROM market_storage_checkpoints
        WHERE migration_id=? AND checkpoint_key IN ('verification:complete','consumer-parity:complete','bootstrap:complete')`)
        .bind(migrationId).all<{checkpoint_key:string;payload_json:string;updated_at:string}>();
      const proofs=new Map(checkpoints.results.map(row=>[row.checkpoint_key,JSON.parse(row.payload_json)]));
      const copy=proofs.get("verification:complete") as StorageVerificationEvidence | undefined;
      const consumers=proofs.get("consumer-parity:complete") as StorageConsumerEvidence | undefined;
      if (!copy?.verified || !consumers || copy.identity.id!==migrationId || copy.identity.targetDatabaseId!==bindings.market
        || copy.identity.sourceDatabaseId!==bindings.source || copy.sourceCapture.revision!==migration.source_revision
        || copy.sourceCapture.schemaHash!==migration.source_schema_hash || consumers.nextTicker!==consumers.tickerCount
        || consumers.identity.id!==migrationId || consumers.tickerCount<1) throw new Error("eod-release-copy-evidence-required");
      const {evidenceHash,...unsignedConsumers}=consumers;
      if (await eodHash(unsignedConsumers)!==evidenceHash || MARKET_HISTORY_REQUIRED_CONSUMERS.some(name=>consumers.checks[name].tickers!==consumers.tickerCount)) throw new Error("eod-release-reader-evidence-invalid");
      const bootstrap=object(proofs.get("bootstrap:complete"));
      const run=await ops.prepare("SELECT status,session_date,input_json,progress_json FROM eod_runs WHERE id=?")
        .bind(String(bootstrap.runId)).first<{status:string;session_date:string;input_json:string;progress_json:string}>();
      if (run?.status!=="completed" || bootstrap.targetDatabaseId!==bindings.market) throw new Error("eod-release-bootstrap-incomplete");
      const inputs=JSON.parse(run.input_json) as {tickers:string[]};
      const publications=await market.prepare(`SELECT id,scope,session_date,payload_json AS payload,payload_codec AS payloadCodec,
        payload_base64 AS payloadBase64,payload_checksum AS checksum,methodology_version AS methodologyVersion
        FROM eod_publications WHERE session_date=? AND status='accepted' AND scope IN (SELECT value FROM json_each(?))
        ORDER BY scope,revision DESC`).bind(run.session_date,JSON.stringify(EOD_PUBLICATION_SCOPES))
        .all<EodStoredPayload & {id:string;scope:string;session_date:string;checksum:string;methodologyVersion:string}>();
      const selected=EOD_PUBLICATION_SCOPES.map(scope=>publications.results.find(row=>row.scope===scope));
      for (const row of selected) if (!row || row.methodologyVersion!==EOD_METRICS_VERSION || await eodHash(await decodeEodPayload(row))!==row.checksum) throw new Error("eod-release-publication-integrity");
      const catalog=await market.prepare("SELECT payload_json,payload_checksum FROM eod_publications WHERE scope=? AND session_date=? AND status='accepted' ORDER BY revision DESC LIMIT 1")
        .bind(EOD_CATALOG_SCOPE,run.session_date).first<{payload_json:string;payload_checksum:string}>();
      const catalogPayload=JSON.parse(catalog?.payload_json ?? "null") as EodCatalogPayload;
      if (!catalogPayload?.rows || catalogPayload.rows.length!==inputs.tickers.length
        || await eodHash(catalogPayload)!==catalog?.payload_checksum) throw new Error("eod-release-full-catalog-required");
      // This is an immutable, explicitly dated snapshot. Current corrections
      // can supersede its input revisions without invalidating copied storage.
      // Final recording still requires a current six-scope publication and
      // completed input watermark; retention checks the current catalog too.
      const checkTickers=["SPY","QQQ","IWM","DIA","AAPL","MSFT","NVDA","BRK.B"].filter(ticker=>inputs.tickers.includes(ticker));
      const calendar=(await market.prepare("SELECT session_date FROM market_calendar_sessions WHERE session_date<=? ORDER BY session_date")
        .bind(copy.identity.sessionDate).all<{session_date:string}>()).results.map(row=>row.session_date);
      const currentClock=await market.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<number>("revision");
      const assertCapture=async()=>{
        const current=await market.prepare("SELECT revision FROM eod_input_clock WHERE id='default'").first<number>("revision");
        if (current!==currentClock) throw new Error("eod-release-inputs-changed-during-validation");
      };
      // Original full-copy parity remains dated in sourceEvidence. Subsequent
      // tracked provider corrections legitimately differ from that snapshot.
      // Check observation preservation separately, then verify today's range
      // readers against today's complete retained series (without fetching).
      const preservation=[];
      for (const ticker of checkTickers) {
        const [before,after]=await Promise.all([
          loadMarketHistory({...env,MARKET_DATA_DB:source},{tickers:[ticker],feed:"sip",endDate:copy.identity.sessionDate}),
          loadMarketHistory(env,{tickers:[ticker],feed:"sip",endDate:copy.identity.sessionDate}),
        ]);
        const retained=new Map(after.map(row=>[row.date,row]));
        if (before.some(row=>!retained.has(row.date))) throw new Error(`eod-release-observation-lost:${ticker}`);
        const corrected=before.filter(row=>!marketHistoryBarsMateriallyEqual(row,retained.get(row.date)!));
        if (corrected.length) {
          const repair=await market.prepare(`SELECT r.status,v.last_correction_revision AS revision FROM eod_adjustment_repairs r
            JOIN eod_input_revisions v ON v.feed=r.feed AND v.ticker=r.ticker WHERE r.feed='sip' AND r.ticker=?`)
            .bind(ticker).first<{status:string;revision:number}>();
          if (repair?.status!=="complete" || repair.revision<1) throw new Error(`eod-release-untracked-correction:${ticker}`);
        }
        preservation.push({ticker,sourceObservations:before.length,retainedObservations:after.length,
          trackedCorrectionDates:corrected.map(row=>row.date)});
      }
      const sample=await verifyStorageConsumerBatch({sourceEnv:env,targetEnv:env,
        capture:{identity:copy.identity,captureHash:copy.captureHash,sourceCapture:copy.sourceCapture,targetCapture:copy.targetCapture,historyCapture:copy.historyCapture},
        tickers:checkTickers,calendarDates:calendar,maxTickers:10,assertCapture});
      if (!sample.evidence) throw new Error("eod-release-reader-sample-incomplete");
      const storage=await sampleDailyStorage({accountId,token,ops});
      const limits=eodStoragePolicy("paid");
      if (storage.accountBytes>=limits.accountOptionalStopBytes || [bindings.market,bindings.history].some(id=>{
        const bytes=storage.databases.find(row=>row.id===id)?.bytes;return bytes===undefined || bytes+8_000_000>=limits.databaseTargetBytes;
      })) throw new Error("eod-release-capacity-insufficient");
      const validation={readerSample:sample.evidence,readerSampleKind:"current-retained-range-parity",preservation,storage,sourceFence,checkedAt:new Date().toISOString()};
      const proof:DailyRelease=dailyReleaseSchema.parse({version:2,policy:"paid-daily-v2",budgetProfile:"paid",codeRevision:revision,
        methodologyVersion:EOD_METRICS_VERSION,approvedAt:new Date().toISOString(),migrationId,hotSessions:90,bindings,
        schemas:{market:await dailySchemaHash(market),history:await dailySchemaHash(history)},
        sourceEvidence:await Promise.all(checkpoints.results.map(async row=>({key:row.checkpoint_key,hash:await eodHash(JSON.parse(row.payload_json)),recordedAt:row.updated_at}))),
        readers:{contractVersion:1,checkedAt:sample.evidence.completedAt,consumers:[...MARKET_HISTORY_REQUIRED_CONSUMERS],parityPassed:true,codeRevision:revision},
        publicationSession:run.session_date,publicationIds:selected.map(row=>row!.id),sharedTickerCount:inputs.tickers.length,validationHash:await eodHash(validation)});
      await assertDailyReleaseBindings(env,proof);
      if (command==="prepare") {
        if (release) throw new Error("eod-release-already-prepared");
        await writeDailyEvidence(ops,`daily-release-validation:${revision}`,validation);
        await writeDailyEvidence(ops,`daily-release:${revision}`,{proof,proofHash:await eodHash(proof)});
      }
      console.log(JSON.stringify({status:command==="prepare"?"prepared":"checked",revision,publicationSession:proof.publicationSession,
        sharedTickers:proof.sharedTickerCount,readerSample:checkTickers.length,accountBytes:storage.accountBytes,hotSessions:90}));
      return;
    }
    if (!release) throw new Error("eod-release-approval-required");
    await assertDailyReleaseBindings(env,release);
    const worker=process.env.EOD_WORKER_NAME || "market-command-worker";
    const settings=object(await cf(`workers/scripts/${worker}/settings`));
    const deployed=Array.isArray(settings.bindings)?settings.bindings.map(object):[];
    const binding=(name:string)=>deployed.find(row=>row.name===name);
    if (binding("MARKET_DATA_DB")?.id!==bindings.market || binding("MARKET_HISTORY_DB")?.id!==bindings.history
      || binding("DB")?.id!==bindings.core || binding("OPS_DB")?.id!==bindings.ops
      || binding("EOD_CODE_REVISION")?.text!==revision || binding("EOD_RUNNER_MODE")?.text!=="active"
      || binding("EOD_READ_ENABLED")?.text!=="true" || binding("EOD_ARCHIVE_PRUNE_ENABLED")?.text!=="true"
      || binding("EOD_BUDGET_PROFILE")?.text!=="paid") throw new Error("eod-release-production-config-mismatch");
    const vars=JSON.parse(execFileSync("gh",["api",`repos/${process.env.EOD_GITHUB_REPOSITORY || "d0ofus/market-overview"}/environments/market-eod/variables?per_page=100`],{encoding:"utf8",windowsHide:true})).variables as Array<{name:string;value:string}>;
    for (const [name,value] of Object.entries({EOD_PRODUCTION_CODE_REVISION:revision,EOD_MARKET_DATABASE_ID:bindings.market,EOD_HISTORY_DATABASE_ID:bindings.history,
      EOD_CORE_DATABASE_ID:bindings.core,EOD_OPS_DATABASE_ID:bindings.ops,EOD_RUNNER_MODE:"active",EOD_BUDGET_PROFILE:"paid",EOD_ARCHIVE_PRUNE_ENABLED:"true"})) {
      if (vars.find(row=>row.name===name)?.value!==value) throw new Error(`eod-release-github-config-mismatch:${name}`);
    }
    const deployments=object(await cf(`workers/scripts/${worker}/deployments`));
    const latest=object((deployments.deployments as unknown[])[0]),versions=latest.versions as Array<{version_id:string;percentage:number}>;
    if (!Array.isArray(versions) || versions.length!==1 || versions[0].percentage!==100) throw new Error("eod-release-deployment-not-uniform");
    const now=new Date().toISOString();
    if (command === "enqueue-maintenance") {
      const health=await collectEodCurrentHealth(env);
      if (health.status!=="passed" || !health.expectedSession) throw new Error("eod-release-current-delivery-required-before-maintenance");
      const run=await enqueueEodRun(env,health.expectedSession,"maintenance");
      console.log(JSON.stringify({status:"queued",runId:run.id}));
      return;
    }
    if (command==="activate") {
      await ops.batch([
        ops.prepare(`UPDATE market_storage_migrations SET status='completed',stage='daily-operation',completed_at=?,updated_at=?,
          next_attempt_at=NULL,error_code=NULL,dispatch_token=NULL,progress_json=json_set(progress_json,'$.dailyReleaseRevision',?,'$.publicBindingChanged',json('true'))
          WHERE id=? AND target_database_id=? AND status IN ('awaiting-evidence','awaiting-cutover') AND (lease_until IS NULL OR lease_until<=?)`)
          .bind(now,now,revision,migrationId,bindings.market,now),
        ops.prepare(`INSERT INTO eod_rollout_evidence(id,evidence_json,updated_at) VALUES('monitoring:public-activation',?,?)
          ON CONFLICT(id) DO UPDATE SET evidence_json=json_set(eod_rollout_evidence.evidence_json,'$.codeRevision',?),updated_at=excluded.updated_at
          WHERE json_extract(eod_rollout_evidence.evidence_json,'$.marketDatabaseId')=?`)
          .bind(JSON.stringify({version:1,activatedAt:now,codeRevision:revision,marketDatabaseId:bindings.market}),now,revision,bindings.market),
      ]);
      if ((await loadStorageMigration(ops,migrationId))?.status!=="completed") throw new Error("eod-release-migration-activation-failed");
      const session=await expectedEodSession(env);
      if (!session) throw new Error("eod-release-current-session-unavailable");
      const queued=await enqueueEodRun(env,session,"daily");
      await writeDailyEvidence(ops,"recovery:local-controller",{version:1,status:"running",stage:"daily-delivery",
        reason:"durable-github-stage-in-progress",nextAttemptAt:null,updatedAt:now,codeRevision:revision});
      console.log(JSON.stringify({status:"activated",revision,runId:queued.id,workerVersion:versions[0].version_id}));
      return;
    }
    const health=await collectEodCurrentHealth(env);
    const maintenance=await readDailyEvidence<{completedAt?:string;deletedRows?:number}>(ops,"history-retention:state");
    if (health.status!=="passed" || !maintenance?.completedAt) throw new Error(`eod-release-production-verification-pending:${health.reasons.join(",")};retention=${Boolean(maintenance?.completedAt)}`);
    await writeDailyEvidence(ops,"recovery:production-configuration",{version:1,codeRevision:revision,activationCodeRevision:revision,
      recordedAt:now,marketDatabaseId:bindings.market,migrationId,workerVersion:versions[0].version_id});
    await writeDailyEvidence(ops,"recovery:local-controller",{version:1,status:"completed",stage:"daily-operation",reason:"",
      nextAttemptAt:null,updatedAt:now,codeRevision:revision});
    await writeDailyEvidence(ops,`daily-release-production:${revision}`,{checkedAt:now,health,maintenance,workerVersion:versions[0].version_id,bindings});
    console.log(JSON.stringify({status:"recorded",revision,session:health.expectedSession,retiredRows:maintenance.deletedRows}));
  } finally { await admission.flush(); }
}
main().catch(error=>{console.error(error instanceof Error?error.message.slice(0,500):"eod-release-failed");process.exitCode=1;});
