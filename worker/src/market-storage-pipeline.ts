import { runStorageCopy, type StorageCopyProgress } from "./market-storage-copy";
import { captureStorageHistoryBaseline, runStorageVerification, assertStorageVerificationCapture,
  releaseStorageVerificationFence, releaseStorageHistoryVerificationFence, freezeStorageVerificationTarget, type StorageVerificationEvidence } from "./market-storage-verification";
import { verifyStorageConsumerBatch, validateStorageConsumerEvidence, type StorageConsumerCheckpoint,
  type StorageConsumerEvidence } from "./market-storage-acceptance";
import { loadStoragePlanConsumerProof } from "./market-storage-consumer-composite";
import { loadStorageMigrationCheckpoint, pauseStorageMigration, progressStorageMigration, queueStorageMigrationStage,
  saveStorageMigrationCheckpoint, storageMigrationIdentity, heartbeatStorageMigration, type StorageMigrationRun } from "./market-storage-control";
import { storageHash } from "./market-storage-pages";
import { expectedEodSession, enqueueEodRun, type EodRun } from "./eod-coordinator";
import { runEodBatch, loadEodInputs } from "./eod-runner";
import { ensureMarketCalendarCoverage } from "./market-calendar-cache";
import { refreshBreadthUniverseMemberships } from "./eod";
import { assessEodMembershipEvidence } from "./eod-membership-evidence";
import { loadStoragePopulationPlan, loadStorageValidationPlan, storeStoragePopulationPlan } from "./market-storage-population-plan";
import { requeueStorageBootstrapCorrection } from "./market-storage-bootstrap-correction";
import { loadStorageHistoryIndexAmendment } from "./market-storage-history-index-recovery";
import type { Env } from "./types";

type Installer = (statements: readonly string[]) => Promise<void>;
export type StoragePreflightRecord = { hash: string; evidence: {
  sourceSchemaHash: string; sourceSnapshotHash: string; tickerHash: string; identity: ReturnType<typeof storageMigrationIdentity>;
  productionAcceptance: false; hotSessions: 260 | 90;
}; tickers: string[]; calendarDates: string[] };
export async function loadStoragePreflight(ops: D1Database, run: StorageMigrationRun): Promise<StoragePreflightRecord> {
  const row = await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
    .bind(`storage-preflight:${run.id}`).first<{ evidence_json: string }>();
  if (!row) throw new Error("storage-preflight-record-required");
  const value = JSON.parse(row.evidence_json) as StoragePreflightRecord;
  if (value.hash !== run.freeze_evidence_hash || await storageHash(value.evidence) !== value.hash
    || await storageHash(value.evidence.identity) !== await storageHash(storageMigrationIdentity(run))
    || value.evidence.sourceSchemaHash !== run.source_schema_hash || value.evidence.productionAcceptance !== false
    || !Array.isArray(value.tickers) || !Array.isArray(value.calendarDates)
    || await storageHash([...value.tickers].sort()) !== value.evidence.tickerHash) throw new Error("storage-preflight-record-integrity");
  return value;
}

/** A workflow executes one resumable stage. The final acceptance/deployment
 * transition is separate and requires real measurements; it never runs simply
 * because copying has completed. All connections are admitted by the CLI. */
export async function runStoragePipeline(input: {
  source: D1Database; target: D1Database; history: D1Database; ops: D1Database;
  run: StorageMigrationRun; leaseToken: string; installSourceFence: Installer;
  installTargetFence: Installer; installHistoryFence: Installer;
  bootstrapEnv?: Env; bootstrapFailureDb?: D1Database; deadlineMs?: number;
  onCopyProgress?:(progress:StorageCopyProgress)=>void;
}): Promise<string> {
  const { run, ops, leaseToken } = input, identity = storageMigrationIdentity(run);
  const started=Date.now(),duration=input.deadlineMs ?? 65*60_000;
  if (!Number.isFinite(duration) || duration<0 || duration>65*60_000) throw new Error("storage-pipeline-invalid-time-slice");
  const remaining=() => {
    const left=duration-(Date.now()-started);
    if (left<=0) throw new Error("storage-run-time-slice-complete");
    return left;
  };
  if (run.freeze_authorized !== 1) {
    await pauseStorageMigration(ops, run.id, leaseToken, "storage-capacity-preflight-required", { sourceFrozen: false });
    return "awaiting-evidence";
  }
  const preflight = await loadStoragePreflight(ops, run);
  const load = (key: string) => loadStorageMigrationCheckpoint(ops, run.id, key);
  const save = (key: string, inputHash: string, payload: unknown) =>
    saveStorageMigrationCheckpoint(ops, run.id, leaseToken, { key, inputHash, payload });
  const queueNext = async (reason: string, progress: unknown) => {
    await queueStorageMigrationStage(ops,run.id,leaseToken,reason,progress);
    return "queued";
  };
  if (!await load("copy-complete")) {
    await captureStorageHistoryBaseline({...input,deadlineMs:remaining()});
    const outcome=await runStorageCopy({...input,deadlineMs:remaining(),retainLeaseOnComplete:true});
    if (outcome!=="copy-complete") return "awaiting-evidence";
    return queueNext("storage-final-verification-required",{copied:true,sourcePreserved:true});
  }
  const verified = await load("verification:complete");
  if (!verified) {
    const evidence = await runStorageVerification({...input,deadlineMs:remaining()});
    return queueNext("storage-consumer-verification-required", { verified: true, captureHash: evidence.captureHash });
  }
  const original = verified.payload as StorageVerificationEvidence;
  if (original.schemaVersion !== 1 || original.verified !== true || verified.inputHash !== original.captureHash
    || await storageHash(original.identity) !== await storageHash(identity)
    || original.sourceCapture.schemaHash!==run.source_schema_hash || original.sourceCapture.revision!==run.source_revision) {
    throw new Error("storage-verification-evidence-integrity");
  }
  // Target/history captures prove the original exact copy. They intentionally
  // become historical evidence after private bootstrap writes; the immutable
  // original source must still match its capture on every resumed stage.
  await assertStorageVerificationCapture(input.source,identity,original.sourceCapture);
  if (!input.bootstrapEnv || !input.bootstrapFailureDb) {
    await pauseStorageMigration(ops, run.id, leaseToken, "storage-bootstrap-bindings-required", { copied: true });
    return "awaiting-evidence";
  }
  const env = input.bootstrapEnv;
  if (env.MARKET_DATA_DB !== input.target || env.MARKET_HISTORY_DB !== input.history || env.OPS_DB !== ops
    || env.DB===input.source || env.EOD_RUNNER_MODE !== "active" || env.EOD_ARCHIVE_PRUNE_ENABLED !== "false") throw new Error("storage-bootstrap-binding-conflict");
  let population = await loadStoragePopulationPlan(ops,run);
  const existingOwner = await load("bootstrap:owner");
  const latestSession = await expectedEodSession(env);
  if (!population || (!existingOwner && latestSession && population.sessionDate < latestSession)) {
    // Only the independently verified private target receives calendar and
    // membership updates. A repeated preparation safely refreezes interrupted
    // target-only writes; the source and original whole-copy proof never move.
    await progressStorageMigration(ops,run.id,leaseToken,"population-inputs",{originalCopyCaptureHash:original.captureHash});
    const before = await freezeStorageVerificationTarget(input.target,identity,input.installTargetFence,"market");
    await releaseStorageVerificationFence(input.target,identity,before);
    let preparedInputs:Awaited<ReturnType<typeof loadEodInputs>>;
    try {
      await ensureMarketCalendarCoverage(env,latestSession ?? run.session_date);
      const session=await expectedEodSession(env);
      if (!session) throw new Error("storage-bootstrap-calendar-unavailable");
      await refreshBreadthUniverseMemberships(env);
      preparedInputs=await loadEodInputs(env,session);
      if (preparedInputs.memberships.length!==5 || preparedInputs.memberships.some(row =>
        !assessEodMembershipEvidence(row,session,preparedInputs.calendarDates).publishable)) {
        throw new Error("storage-population-verified-memberships-required");
      }
    } finally {
      await freezeStorageVerificationTarget(input.target,identity,input.installTargetFence,"market");
    }
    const targetCapture=await freezeStorageVerificationTarget(input.target,identity,input.installTargetFence,"market");
    await assertStorageVerificationCapture(input.history,identity,original.historyCapture);
    const captureFields={identity,sourceCapture:original.sourceCapture,targetCapture,historyCapture:original.historyCapture};
    const nextCapture={...captureFields,captureHash:await storageHash(captureFields)};
    population=await storeStoragePopulationPlan(ops,run,{inputs:preparedInputs!,capture:nextCapture,
      originalCopyCaptureHash:original.captureHash,leaseToken});
  }
  let plan:Awaited<ReturnType<typeof loadStorageValidationPlan>>;
  try {plan=await loadStorageValidationPlan(ops,run);} catch(error) {
    if (!(error instanceof Error) || error.message!=="storage-population-sizing-required") throw error;
    await pauseStorageMigration(ops,run.id,leaseToken,"storage-population-sizing-required",{
      planHash:population.planHash,sessionDate:population.sessionDate,tickerCount:population.tickers.length,
      originalTickerCount:preflight.tickers.length,sourcePreserved:true,publicBindingChanged:false,
    });
    return "awaiting-evidence";
  }
  const capture=plan.capture;
  const sourceEnv = { DB: input.source, MARKET_DATA_DB: input.source, MARKET_HISTORY_DB: input.history,
    ALPACA_DAILY_FEED: "sip", ALPACA_DAILY_ADJUSTMENT: "split" } as Env;
  const targetEnv = { ...sourceEnv, DB: input.target, MARKET_DATA_DB: input.target };
  const assertCapture = async () => {
    await assertStorageVerificationCapture(input.source, identity, capture.sourceCapture);
    await assertStorageVerificationCapture(input.target, identity, capture.targetCapture);
    await assertStorageVerificationCapture(input.history, identity, capture.historyCapture);
  };
  let consumers = await load("consumer-parity:complete");
  if (consumers && consumers.inputHash!==capture.captureHash) {
    await save(`consumer-parity:history:${consumers.inputHash}`,consumers.inputHash,consumers.payload);
    consumers=null;
  }
  if (!consumers) {
    const saved = await load("consumer-parity:cursor");
    if (saved && saved.inputHash !== capture.captureHash) await save(`consumer-parity:cursor-history:${saved.inputHash}`,saved.inputHash,saved.payload);
    let checkpoint = saved?.inputHash===capture.captureHash ? saved.payload as StorageConsumerCheckpoint : undefined;
    while (remaining()>0) {
      await heartbeatStorageMigration(ops, run.id, leaseToken);
      const result = await verifyStorageConsumerBatch({ sourceEnv, targetEnv, capture,
        tickers: plan.tickers, calendarDates: plan.calendarDates, checkpoint, maxTickers: 10, assertCapture });
      checkpoint = result.checkpoint;
      await save("consumer-parity:cursor", capture.captureHash, checkpoint);
      await progressStorageMigration(ops, run.id, leaseToken, "consumer-parity", {
        processed: checkpoint.nextTicker, total: checkpoint.tickerCount, history: checkpoint.history,
      });
      if (result.evidence) {
        await save("consumer-parity:complete", capture.captureHash, result.evidence);
        return queueNext("storage-private-bootstrap-required", { consumerParity: true, processed: checkpoint.nextTicker });
      }
    }
    throw new Error("storage-run-time-slice-complete");
  }
  if (consumers.inputHash !== capture.captureHash) throw new Error("storage-consumer-capture-mismatch");
  if (plan.populationExpansionHash) await loadStoragePlanConsumerProof(ops, run, plan);
  else await validateStorageConsumerEvidence(consumers.payload as StorageConsumerEvidence, capture, plan.tickers);
  const bootstrap = await load("bootstrap:owner");
  const expected = await expectedEodSession(env);
  if (!expected) throw new Error("storage-bootstrap-calendar-unavailable");
  type Owner={runId:string;sessionDate:string;targetDatabaseId:string};
  let owner=bootstrap?.payload as Owner|undefined;
  if (bootstrap && ((bootstrap.inputHash!==plan.planHash && bootstrap.inputHash!==plan.predecessorPlanHash) || owner?.targetDatabaseId!==run.target_database_id
    || !/^\d{4}-\d{2}-\d{2}$/.test(owner.sessionDate) || owner.sessionDate<run.session_date || owner.sessionDate>expected
    || owner.runId!==`eod:active:${owner.sessionDate}:daily`)) {
    throw new Error("storage-bootstrap-owner-conflict");
  }
  const claimOwner=async ():Promise<Owner> => {
    const runId=`eod:active:${expected}:daily`;
    const existing=await ops.prepare("SELECT id FROM eod_runs WHERE id=?").bind(runId).first();
    if (existing) throw new Error("storage-bootstrap-existing-active-run");
    const next={runId,sessionDate:expected,targetDatabaseId:run.target_database_id};
    await save("bootstrap:owner",plan.planHash,next);
    return next;
  };
  if (owner && owner.sessionDate<expected) {
    const completed=await ops.prepare("SELECT status,session_date,mode,purpose FROM eod_runs WHERE id=?").bind(owner.runId)
      .first<Pick<EodRun,"status"|"session_date"|"mode"|"purpose">>();
    // Never abandon unfinished ingestion because the date changed. Once its
    // actual run completes, retain its dated identity and claim today's work.
    if (completed?.status==="completed") {
      if (completed.session_date!==owner.sessionDate || completed.mode!=="active" || completed.purpose!=="daily") {
        throw new Error("storage-bootstrap-completed-owner-conflict");
      }
      await save(`bootstrap-history:${owner.sessionDate}`,bootstrap!.inputHash,owner);
      if (plan.sessionDate<expected) {
        await ensureMarketCalendarCoverage(env,expected);
        await refreshBreadthUniverseMemberships(env);
        const nextInputs=await loadEodInputs(env,expected);
        if (nextInputs.memberships.length!==5 || nextInputs.memberships.some(row =>
          !assessEodMembershipEvidence(row,expected,nextInputs.calendarDates).publishable)) {
          throw new Error("storage-population-verified-memberships-required");
        }
        if (await storageHash([...nextInputs.tickers].sort())!==await storageHash(plan.tickers)) {
          const added = nextInputs.tickers.filter(ticker => !plan.tickers.includes(ticker));
          if (!plan.populationExpansionHash && added.length > 0 && added.length <= 100
            && plan.tickers.every(ticker => nextInputs.tickers.includes(ticker))
            && await storageHash(nextInputs.config) === await storageHash(plan.inputs.config)) {
            await pauseStorageMigration(ops, run.id, leaseToken, "storage-population-expansion-required", {
              previousPlanHash: plan.planHash, completedSession: owner.sessionDate, expectedSession: expected,
              previousTickerCount: plan.tickers.length, nextTickerCount: nextInputs.tickers.length,
              addedTickers: [...added].sort(), nextInputsHash: await storageHash(nextInputs),
              sourcePreserved: true, publicBindingChanged: false,
            });
            return "awaiting-evidence";
          }
          throw new Error("storage-population-live-recapture-required");
        }
        await storeStoragePopulationPlan(ops,run,{inputs:nextInputs,capture:plan.capture,
          originalCopyCaptureHash:plan.originalCopyCaptureHash,predecessorPlanHash:plan.planHash,leaseToken});
        plan=await loadStorageValidationPlan(ops,run);
      }
      owner=await claimOwner();
    }
  }
  if (!owner) {
    if (plan.sessionDate!==expected) throw new Error("storage-population-session-replan-required");
    await assertCapture();
    owner=await claimOwner();
  }
  // Persist the checked transition before either release. A process failure
  // between the two releases can then resume using the same captured identity.
  // Source stays frozen; no public Worker binding changes here.
  const historyIndexAmendment = await loadStorageHistoryIndexAmendment(ops, run, plan);
  if (historyIndexAmendment) {
    await releaseStorageHistoryVerificationFence(input.history, identity, capture.historyCapture, historyIndexAmendment);
  } else {
    await releaseStorageVerificationFence(input.history, identity, capture.historyCapture);
  }
  await releaseStorageVerificationFence(input.target, identity, capture.targetCapture);
  remaining();
  let eodRun = await enqueueEodRun(env, owner.sessionDate, "daily");
  if (eodRun.id !== owner.runId) throw new Error("storage-bootstrap-run-identity-conflict");
  eodRun=await requeueStorageBootstrapCorrection(env,{migrationId:run.id,migrationLeaseToken:leaseToken,
    planHash:plan.planHash,targetDatabaseId:run.target_database_id,runId:owner.runId,
    sessionDate:owner.sessionDate,plannedInputs:plan.bootstrapInputs});
  if (eodRun.next_attempt_at && Date.parse(eodRun.next_attempt_at) > Date.now()) throw new Error("storage-bootstrap-retry-not-due");
  await progressStorageMigration(ops, run.id, leaseToken, "bootstrap", { runId: owner.runId, sessionDate: owner.sessionDate });
  let leaseLost=false,heartbeatTask:Promise<void>|null=null;
  const heartbeat = setInterval(() => {
    if (heartbeatTask) return;
    heartbeatTask=heartbeatStorageMigration(ops,run.id,leaseToken).catch(() => {leaseLost=true;}).finally(() => {heartbeatTask=null;});
  }, 60_000);
  try {
    const assertContinue=() => {if(leaseLost)throw new Error("storage-migration-lease-lost");remaining();};
    assertContinue();
    const outcome = eodRun.status === "completed" ? { status: "completed" } : await runEodBatch(env, owner.runId, input.bootstrapFailureDb,{assertContinue,hotSessions:90,storageInputs:plan.bootstrapInputs});
    clearInterval(heartbeat);
    if (heartbeatTask) await heartbeatTask;
    if (leaseLost) throw new Error("storage-migration-lease-lost");
    if (outcome.status !== "completed") {
      const current = await ops.prepare("SELECT next_attempt_at,error_code FROM eod_runs WHERE id=?").bind(owner.runId)
        .first<Pick<EodRun, "next_attempt_at" | "error_code">>();
      throw new Error(/quota|budget/.test(current?.error_code ?? "") ? "storage-bootstrap-budget-exhausted" : "storage-bootstrap-incomplete");
    }
    const persisted=await ops.prepare("SELECT status,session_date,mode,purpose FROM eod_runs WHERE id=?").bind(owner.runId)
      .first<Pick<EodRun,"status"|"session_date"|"mode"|"purpose">>();
    if (persisted?.status!=="completed" || persisted.session_date!==owner.sessionDate || persisted.mode!=="active" || persisted.purpose!=="daily") {
      throw new Error("storage-bootstrap-completion-not-persisted");
    }
    await save(`bootstrap-history:${owner.sessionDate}`,plan.planHash,owner);
    const latestExpected=await expectedEodSession(env);
    if (!latestExpected) throw new Error("storage-bootstrap-calendar-unavailable");
    if (owner.sessionDate<latestExpected) return queueNext("storage-latest-bootstrap-required",{
      completedSession:owner.sessionDate,expectedSession:latestExpected,publicBindingChanged:false,
    });
    if (owner.sessionDate!==latestExpected) throw new Error("storage-bootstrap-future-owner");
    await save("bootstrap:complete", plan.planHash, owner);
    await pauseStorageMigration(ops, run.id, leaseToken, "storage-final-acceptance-required", {
      ...owner, publicBindingChanged: false, expectedSession: expected,
      remaining: ["latest-session-check", "measured-publication-growth", "live-capacity-and-runtime", "public-binding-cutover"],
    });
    return "awaiting-evidence";
  } finally {clearInterval(heartbeat);if(heartbeatTask)await heartbeatTask;}
}
