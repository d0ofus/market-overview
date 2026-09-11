import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { claimStorageMigration,loadStorageMigration,resumeStorageMigration,saveStorageMigrationCheckpoint } from "../src/market-storage-control";
import { loadStorageValidationPlan } from "../src/market-storage-population-plan";
import { prepareStorageHistoryIndexRecovery,applyStorageHistoryPointerIndexes,approveStorageHistoryIndexRecovery,loadStorageHistoryIndexAmendment,
  storageHistoryIndexRecoveryKey } from "../src/market-storage-history-index-recovery";
import { validateStorageHistoryIndexCodeTrees } from "../scripts/storage-history-index-code-contract";
import { createEodD1Database,estimateEodQueries,EOD_HISTORY_POINTER_INDEX_DDL,type EodSql } from "../src/eod-d1-rest";
import { storageHash } from "../src/market-storage-pages";
import * as eodRunner from "../src/eod-runner";
import { runStoragePipeline } from "../src/market-storage-pipeline";
import type { Env } from "../src/types";
import { approveStorageIndexLoaderContinuation,STORAGE_INDEX_LOADER_PREVIOUS_REVISION,
  type StorageIndexLoaderCodeContract } from "../src/market-storage-history-index-continuation";

import { createStorageIndexDatabases,seedStorageIndexRecovery,identity,next,accountId,from,migration,codeInput } from "./helpers/storage-index-recovery";

describe("history index code contract",()=>{
  it("retains all existing verification statements and rejects consumer or schema drift",()=>{
    expect(validateStorageHistoryIndexCodeTrees(codeInput()).protectedFileCount).toBe(4);
    expect(()=>validateStorageHistoryIndexCodeTrees({...codeInput(),newVerification:codeInput().newVerification.replace('original="same"','original="changed"')})).toThrow("original-verification");
    expect(()=>validateStorageHistoryIndexCodeTrees({...codeInput(),migrationSql:migration+"DELETE FROM market_history_blocks;"})).toThrow("exact-index-pair");
    expect(()=>validateStorageHistoryIndexCodeTrees({...codeInput(),after:codeInput().after.map(row=>row.path.endsWith("eod-runner.ts")?{...row,blob:"e".repeat(40)}:row)})).toThrow("consumer-dependency-changed");
  });
});

describe("first-bootstrap history index amendment",{timeout:90_000},()=>{
  let source:ReturnType<typeof createSqliteD1>,target:ReturnType<typeof createSqliteD1>,history:ReturnType<typeof createSqliteD1>,ops:ReturnType<typeof createSqliteD1>;
  beforeEach(()=>{({source,target,history,ops}=createStorageIndexDatabases());});
  afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();source.dispose();target.dispose();history.dispose();ops.dispose();});
  const fixture=(population=1,checkpointCount=4)=>seedStorageIndexRecovery({source,target,history,ops},{population,checkpointCount});
  const rows=async()=>({blocks:(await history.db.prepare("SELECT * FROM market_history_blocks ORDER BY id").all()).results,
    pointers:(await history.db.prepare("SELECT * FROM market_history_block_pointers ORDER BY feed,ticker,calendar_year").all()).results,
    repairs:(await target.db.prepare("SELECT * FROM eod_adjustment_repairs ORDER BY feed,ticker").all()).results});
  it("preserves the real partial write, pending repair, complete proof and old plan; resumes only the exact failure",async()=>{
    const f=await fixture(),before=await rows(),originalProof=await ops.db.prepare("SELECT * FROM market_storage_checkpoints WHERE checkpoint_key='consumer-parity:complete'").first();
    const baseline=await prepareStorageHistoryIndexRecovery(f.input),amendment=await applyStorageHistoryPointerIndexes(f.input);
    const batch=ops.db.batch.bind(ops.db),lost={prepare:ops.db.prepare.bind(ops.db),batch:async(statements:D1PreparedStatement[])=>{await batch(statements);throw new Error("lost-ack");}} as unknown as D1Database;
    await expect(approveStorageHistoryIndexRecovery({...f.input,ops:lost})).rejects.toThrow("lost-ack");
    const result=await approveStorageHistoryIndexRecovery(f.input);
    expect(amendment.revision).toBe(baseline.history.revision);expect(result.recovery.physical.historyBytes).toBeGreaterThan(baseline.physical.historyBytes);
    expect(await rows()).toEqual(before);expect(result.plan.capture).toEqual(f.plan.capture);expect(result.plan.inputs).toEqual(f.plan.inputs);
    expect(await ops.db.prepare("SELECT * FROM market_storage_checkpoints WHERE checkpoint_key='consumer-parity:complete'").first()).toEqual(originalProof);
    expect(await ops.db.prepare("SELECT status,error_code,next_attempt_at FROM eod_runs WHERE id=?").bind(f.eodId).first()).toEqual({status:"queued",error_code:null,next_attempt_at:null});
    expect(result.recovery.originalOwner.input_hash).toBe(f.plan.planHash);
    expect(await ops.db.prepare("SELECT input_hash FROM market_storage_checkpoints WHERE checkpoint_key='bootstrap:owner'").first<string>("input_hash")).toBe(result.plan.planHash);
    expect(await approveStorageHistoryIndexRecovery(f.input)).toEqual(result);
    const actualRun=(await loadStorageMigration(ops.db,identity.id))!,validationPlan=await loadStorageValidationPlan(ops.db,actualRun);
    expect(await loadStorageHistoryIndexAmendment(ops.db,actualRun,validationPlan)).toEqual(amendment);
    await expect(loadStorageHistoryIndexAmendment(ops.db,actualRun,{...validationPlan,unreviewed:true} as typeof validationPlan)).rejects.toThrow("amendment-integrity");
    await expect(loadStorageHistoryIndexAmendment(ops.db,actualRun,{...validationPlan,sourceSnapshotHash:"0".repeat(64)})).rejects.toThrow("amendment-integrity");
    const changedInputs={...validationPlan,bootstrapInputs:{...validationPlan.bootstrapInputs,tickers:["WRONG"]}};
    const changedSizing={...validationPlan,sizingHash:"invalid"},mismatchedSizing={...validationPlan,sizingHash:"0".repeat(64)};
    await expect(loadStorageHistoryIndexAmendment(ops.db,actualRun,changedInputs)).rejects.toThrow("derived-plan-mismatch");
    await expect(loadStorageHistoryIndexAmendment(ops.db,actualRun,changedSizing)).rejects.toThrow("derived-plan-mismatch");
    await expect(loadStorageHistoryIndexAmendment(ops.db,actualRun,mismatchedSizing)).rejects.toThrow("derived-plan-mismatch");
    const {planHash:_hash,...fields}=result.plan,nextFields={...fields,sessionDate:"2026-09-11",predecessorPlanHash:result.plan.planHash,
      inputs:{...fields.inputs,calendarDates:[...fields.inputs.calendarDates,"2026-09-11"]}};
    const successor={...nextFields,planHash:await storageHash(nextFields)};
    await ops.db.prepare("INSERT INTO eod_rollout_evidence VALUES(?,?,?)").bind(`storage-population-plan:${identity.id}:${successor.planHash}`,JSON.stringify(successor),f.input.now.toISOString()).run();
    expect(await loadStorageHistoryIndexAmendment(ops.db,(await loadStorageMigration(ops.db,identity.id))!,successor)).toEqual(amendment);
    const changed={...successor,tickers:["OTHER"]};
    await expect(loadStorageHistoryIndexAmendment(ops.db,(await loadStorageMigration(ops.db,identity.id))!,changed)).rejects.toThrow("lineage-mismatch");
    history.script("DROP INDEX idx_market_history_pointers_block_id;");
    await expect(approveStorageHistoryIndexRecovery(f.input)).rejects.toThrow("index-set-invalid");
  });
  it("resumes the real pipeline through the enriched plan, amendment and open fences before calling the price runner",async()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-09-11T13:00:00.000Z"));
    const f=await fixture();await prepareStorageHistoryIndexRecovery(f.input);await applyStorageHistoryPointerIndexes(f.input);
    const repaired=await approveStorageHistoryIndexRecovery(f.input),before=await rows();
    const evidence=await ops.db.prepare("SELECT checkpoint_key,input_hash,payload_json,updated_at FROM market_storage_checkpoints WHERE checkpoint_key IN ('verification:complete','consumer-parity:complete','bootstrap:owner') ORDER BY checkpoint_key").all();
    const sourceFence=await source.db.prepare("SELECT * FROM market_storage_fence WHERE id='default'").first();
    const historyFence=await history.db.prepare("SELECT * FROM market_storage_fence WHERE id='default'").first();
    // These are real calendar records; only the external price runner is mocked.
    // Keep fixture dates deterministic without replacing the exchange resolver.
    target.script(`INSERT INTO market_calendar_sessions(session_date,open_at,close_at,source) VALUES('2026-09-10','09:30','16:00','alpaca');
      INSERT INTO market_calendar_refresh_state(id,covered_start,covered_end,verified_at) VALUES('default','2026-01-01','2099-12-31','2026-09-11T13:00:00.000Z');`);
    await resumeStorageMigration(ops.db,identity.id,identity.codeRevision);
    const claimed=await claimStorageMigration(ops.db,identity.id,{executionRevision:next});expect(claimed).not.toBeNull();
    await saveStorageMigrationCheckpoint(ops.db,identity.id,claimed!.leaseToken,{key:"copy-complete",inputHash:repaired.plan.originalCopyCaptureHash,payload:{complete:true}});
    const priceBoundary=vi.spyOn(eodRunner,"runEodBatch").mockRejectedValue(new Error("test-price-runner-boundary"));
    const neverInstall=vi.fn(async()=>{throw new Error("test-unexpected-fence-install");});
    const bootstrapEnv={DB:{} as D1Database,MARKET_DATA_DB:target.db,MARKET_HISTORY_DB:f.input.history,OPS_DB:ops.db,
      EOD_RUNNER_MODE:"active",EOD_ARCHIVE_PRUNE_ENABLED:"false",EOD_CODE_REVISION:next} as Env;
    await expect(runStoragePipeline({source:source.db,target:target.db,history:f.input.history,ops:ops.db,
      run:claimed!.run,leaseToken:claimed!.leaseToken,bootstrapEnv,bootstrapFailureDb:ops.db,
      installSourceFence:neverInstall,installTargetFence:neverInstall,installHistoryFence:neverInstall})).rejects.toThrow("test-price-runner-boundary");
    expect(priceBoundary).toHaveBeenCalledOnce();
    expect(priceBoundary.mock.calls[0][1]).toBe(f.eodId);
    expect(priceBoundary.mock.calls[0][3]).toMatchObject({hotSessions:90,storageInputs:repaired.plan.inputs});
    expect(neverInstall).not.toHaveBeenCalled();expect(await rows()).toEqual(before);
    expect(await source.db.prepare("SELECT * FROM market_storage_fence WHERE id='default'").first()).toEqual(sourceFence);
    expect(await history.db.prepare("SELECT * FROM market_storage_fence WHERE id='default'").first()).toEqual(historyFence);
    expect((await ops.db.prepare("SELECT checkpoint_key,input_hash,payload_json,updated_at FROM market_storage_checkpoints WHERE checkpoint_key IN ('verification:complete','consumer-parity:complete','bootstrap:owner') ORDER BY checkpoint_key").all()).results).toEqual(evidence.results);
  });
  it("keeps a true quota error and feature checkpoint paused",async()=>{
    const f=await fixture();await prepareStorageHistoryIndexRecovery(f.input);await applyStorageHistoryPointerIndexes(f.input);
    await ops.db.prepare("UPDATE eod_runs SET error_message='d1-quota-exhausted' WHERE id=?").bind(f.eodId).run();
    await expect(approveStorageHistoryIndexRecovery(f.input)).rejects.toThrow("estimate-failure-required");
    expect(await ops.db.prepare("SELECT execution_revision FROM market_storage_migrations WHERE id=?").bind(identity.id).first<string>("execution_revision")).toBeNull();
    await ops.db.prepare("UPDATE eod_runs SET error_message=? WHERE id=?").bind("eod-d1-query-budget-estimate-exceeded; reads=25586/20; writes=2/8; statements=1; classes=delete-other",f.eodId).run();
    await ops.db.prepare("INSERT INTO eod_checkpoints VALUES(?,?,?,?,?)").bind(f.eodId,"features:0","f".repeat(64),"{}",f.input.now.toISOString()).run();
    await expect(approveStorageHistoryIndexRecovery(f.input)).rejects.toThrow("feature-checkpoint-present");
  });
  it("rejects an accepted revision even when its publication pointer is absent",async()=>{
    const f=await fixture();await target.db.prepare(`INSERT INTO eod_publications(id,scope,session_date,revision,input_hash,methodology_version,payload_json,status,created_at,accepted_at)
      VALUES('accepted-unpointed','breadth:sp500-core','2026-09-10',1,'hash','test','{}','accepted',?,?)`).bind(f.input.now.toISOString(),f.input.now.toISOString()).run();
    await expect(prepareStorageHistoryIndexRecovery(f.input)).rejects.toThrow("accepted-publication-present");
  });
  it.each(["checkpoint","eod-error","pointer","history-row"])("rejects a %s race without assigning old proof to the new executor",async race=>{
    const f=await fixture();await prepareStorageHistoryIndexRecovery(f.input);await applyStorageHistoryPointerIndexes(f.input);
    if(race==="history-row") {await history.db.prepare("UPDATE market_history_blocks SET verified_at='changed' WHERE id='old'").run();await expect(approveStorageHistoryIndexRecovery(f.input)).rejects.toThrow("history-rows-changed");return;}
    const batch=ops.db.batch.bind(ops.db),raced={prepare:ops.db.prepare.bind(ops.db),batch:async(statements:D1PreparedStatement[])=>{
      if(race==="checkpoint")await ops.db.prepare("UPDATE market_storage_checkpoints SET payload_json='{}' WHERE checkpoint_key='consumer-parity:complete'").run();
      if(race==="eod-error")await ops.db.prepare("UPDATE eod_runs SET error_message='d1-quota-exhausted' WHERE id=?").bind(f.eodId).run();
      if(race==="pointer")await ops.db.prepare("UPDATE eod_rollout_evidence SET evidence_json='{}' WHERE id=?").bind(`storage-population-current:${identity.id}`).run();
      return batch(statements);
    }} as unknown as D1Database;
    await expect(approveStorageHistoryIndexRecovery({...f.input,ops:raced})).rejects.toThrow();
    expect(await ops.db.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?").bind(storageHistoryIndexRecoveryKey(identity.id,next)).first()).toBeNull();
    expect(await ops.db.prepare("SELECT execution_revision FROM market_storage_migrations WHERE id=?").bind(identity.id).first<string>("execution_revision")).toBeNull();
  });
  // Two separately approved transitions and both replay paths exercise the
  // production-sized immutable records through real SQLite and the REST adapter.
  it("validates6,319 symbols and84 checkpoints through the fixed REST envelope",{timeout:180_000},async()=>{
    history.script(`CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name VARCHAR(255) UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
      INSERT INTO d1_migrations(name,applied_at) VALUES('0001_history.sql','2026-09-08 00:00:00'),('0002_market_storage_fence.sql','2026-09-08 00:00:00');`);
    const f=await fixture(6319,84),wire:EodSql[][]=[];
    const bridge=(database:ReturnType<typeof createSqliteD1>,id:string)=>createEodD1Database({accountId,token:"test",databaseId:id,allowedDatabaseIds:[id],reviewedDdl:EOD_HISTORY_POINTER_INDEX_DDL,
      admission:async queries=>{const expected=estimateEodQueries(queries);return async usage=>{expect(usage.rowsRead).toBeLessThanOrEqual(expected.reads);expect(usage.rowsWritten).toBeLessThanOrEqual(expected.writes);};},
      fetcher:async(_url,init)=>{const body=JSON.parse(String(init?.body)) as EodSql|{batch:EodSql[]},queries="batch" in body?body.batch:[body];
        if(queries.some(row=>/recovery-guard-rejected|continuation-guard-rejected/.test(row.sql)))wire.push(queries);
        return Response.json({success:true,result:await database.db.batch(queries.map(row=>database.db.prepare(row.sql).bind(...row.params)))});}});
    const input={...f.input,ops:bridge(ops,"10000000-0000-4000-8000-000000000004"),history:bridge(history,identity.historyDatabaseId)};
    await prepareStorageHistoryIndexRecovery(input);await applyStorageHistoryPointerIndexes(input);const result=await approveStorageHistoryIndexRecovery(input);
    expect(wire).toHaveLength(1);expect(wire[0]).toHaveLength(9);expect(new TextEncoder().encode(JSON.stringify({batch:wire[0]})).length).toBeLessThan(8_000_000);
    const actualRun=(await loadStorageMigration(ops.db,identity.id))!,validationPlan=await loadStorageValidationPlan(ops.db,actualRun);
    expect(validationPlan.planHash).toBe(result.plan.planHash);
    expect(await loadStorageHistoryIndexAmendment(ops.db,actualRun,validationPlan)).toEqual(result.recovery.amendment);
    // Match the real post-deploy state: indexes were installed atomically,
    // then Wrangler recorded only the reviewed migration (+1 tracked write).
    await history.db.prepare("INSERT INTO d1_migrations(name,applied_at) VALUES('0003_history_pointer_indexes.sql',?)").bind(f.input.now.toISOString()).run();
    await ops.db.prepare("UPDATE market_storage_migrations SET error_code='storage-history-index-recovery-amendment-integrity' WHERE id=?").bind(identity.id).run();
    const before=await rows(),oldEod=await ops.db.prepare("SELECT * FROM eod_runs WHERE id=?").bind(f.eodId).first();
    const oldProofs=(await ops.db.prepare("SELECT checkpoint_key,input_hash,payload_json,updated_at FROM market_storage_checkpoints WHERE checkpoint_key<>'bootstrap:owner' ORDER BY checkpoint_key").all()).results;
    const oldOwner=await ops.db.prepare("SELECT payload_json,updated_at FROM market_storage_checkpoints WHERE checkpoint_key='bootstrap:owner'").first();
    const newRevision="c".repeat(40),codeFields:Omit<StorageIndexLoaderCodeContract,"evidenceHash">={version:1,policy:"index-amendment-loader-normalization-v1",fromRevision:STORAGE_INDEX_LOADER_PREVIOUS_REVISION,
      codeRevision:newRevision,protectedFileCount:4,protectedManifestHash:"1".repeat(64),loaderValidationHash:"2".repeat(64),reviewedChangesHash:"3".repeat(64),
      beforeTreeHash:"4".repeat(64),afterTreeHash:"5".repeat(64)};
    const codeContract:StorageIndexLoaderCodeContract={...codeFields,evidenceHash:await storageHash(codeFields)};
    const continuationInput={...input,fromRevision:next,codeRevision:newRevision,expectedPlanHash:result.plan.planHash,codeContract,
      changedFiles:["worker/src/market-storage-history-index-recovery.ts"],diffHash:"6".repeat(64)};
    const batch=input.ops.batch.bind(input.ops),lost={prepare:input.ops.prepare.bind(input.ops),batch:async(statements:D1PreparedStatement[])=>{
      await batch(statements);throw new Error("continuation-lost-ack");
    }} as unknown as D1Database;
    await expect(approveStorageIndexLoaderContinuation({...continuationInput,ops:lost})).rejects.toThrow("continuation-lost-ack");
    const continued=await approveStorageIndexLoaderContinuation(continuationInput);
    expect(wire).toHaveLength(2);expect(wire[1]).toHaveLength(8);
    expect(new TextEncoder().encode(JSON.stringify({batch:wire[1]})).length).toBeLessThan(8_000_000);
    expect(continued.continuation.originalOwner.input_hash).toBe(result.plan.planHash);
    expect(continued.plan.capture).toEqual(result.plan.capture);expect(continued.plan.inputs).toEqual(result.plan.inputs);
    expect(continued.plan.predecessorPlanHash).toBe(result.plan.planHash);
    expect(await rows()).toEqual(before);
    expect(await ops.db.prepare("SELECT * FROM eod_runs WHERE id=?").bind(f.eodId).first()).toEqual(oldEod);
    expect((await ops.db.prepare("SELECT checkpoint_key,input_hash,payload_json,updated_at FROM market_storage_checkpoints WHERE checkpoint_key<>'bootstrap:owner' ORDER BY checkpoint_key").all()).results).toEqual(oldProofs);
    expect(await ops.db.prepare("SELECT payload_json,updated_at FROM market_storage_checkpoints WHERE checkpoint_key='bootstrap:owner'").first()).toEqual(oldOwner);
    const continuedRun=(await loadStorageMigration(ops.db,identity.id))!,continuedPlan=await loadStorageValidationPlan(ops.db,continuedRun);
    expect(await loadStorageHistoryIndexAmendment(ops.db,continuedRun,continuedPlan)).toEqual(result.recovery.amendment);
    expect(await approveStorageIndexLoaderContinuation(continuationInput)).toEqual(continued);
  });
});
vi.mock("../src/eod-rest-request-limiter",()=>({pacedEodRestFetch:(_account:string,_token:string,fetcher:typeof fetch,url:RequestInfo|URL,init:RequestInit|(()=>RequestInit))=>fetcher(url,typeof init==="function"?init():init)}));
