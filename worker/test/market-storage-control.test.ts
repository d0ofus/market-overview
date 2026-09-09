import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { abortStorageMigration,authorizeStorageMigrationFreeze,claimStorageMigration,createStorageMigration,deferStorageMigration,
  heartbeatStorageMigration,loadStorageMigration,loadStorageMigrationCheckpoint,markStorageMigrationReady,pauseStorageMigration,
  recordStorageSourceCapture,resumeStorageMigration,saveStorageMigrationCheckpoint,storageMigrationBlocksEod,
  type StorageMigrationIdentity } from "../src/market-storage-control";
import { assertStorageSourceFrozen,assertStorageTargetEmpty,freezeStorageSource,prepareStorageSourceFence,releaseStorageSourceFence } from "../src/market-storage-fence";
import { coordinateStorageMigration } from "../src/market-storage-scheduler";
import { coordinateEod,dispatchEodRun,eodStatus,type EodRun } from "../src/eod-coordinator";
import type { Env } from "../src/types";
vi.mock("../src/market-calendar-cache",() => ({ensureMarketCalendarCoverage:vi.fn()}));
import { ensureMarketCalendarCoverage } from "../src/market-calendar-cache";

describe("durable market storage migration controls and source fencing",{timeout:30_000},() => {
  let source:ReturnType<typeof createSqliteD1>,ops:ReturnType<typeof createSqliteD1>;
  const now=new Date("2026-09-09T23:30:00Z"),later=new Date("2026-09-10T00:05:00Z");
  const identity:StorageMigrationIdentity={id:"market-storage:archive-first-v1",sessionDate:"2026-09-08",codeRevision:"a".repeat(40),
    sourceDatabaseId:"00000000-0000-4000-8000-000000000001",targetDatabaseId:"00000000-0000-4000-8000-000000000002",
    historyDatabaseId:"00000000-0000-4000-8000-000000000003"};
  let env:Env;
  const github=vi.fn<typeof fetch>();
  beforeEach(async () => {
    source=createSqliteD1();ops=createSqliteD1();source.migrate("market-data-migrations");ops.migrate("ops-migrations");
    await createStorageMigration(ops.db,identity,now);
    env={DB:source.db,MARKET_DATA_DB:source.db,OPS_DB:ops.db,EOD_RUNNER_MODE:"shadow",EOD_STORAGE_MIGRATION_ID:identity.id,
      EOD_GITHUB_TOKEN:"test-only",EOD_GITHUB_REPOSITORY:"test/repo"} as Env;
    github.mockReset().mockImplementation(async (_url,init) => init?.method==="POST" ? new Response(null,{status:204})
      : Response.json({total_count:0,workflow_runs:[]}));
    vi.stubGlobal("fetch",github);vi.mocked(ensureMarketCalendarCoverage).mockClear();
  },30_000);
  afterEach(() => {source.dispose();ops.dispose();vi.unstubAllGlobals();});
  const run=()=>loadStorageMigration(ops.db,identity.id);
  const install=async () => {
    const plan=await prepareStorageSourceFence(source.db);
    source.script(plan.statements.map((statement)=>statement.sql).join("\n"));
    await authorizeStorageMigrationFreeze(ops.db,identity.id,{sourceDatabaseId:identity.sourceDatabaseId,codeRevision:identity.codeRevision,
      schemaHash:plan.schemaHash,evidenceHash:"c".repeat(64)},now);
    return plan;
  };

  it("creates an inert idempotent identity and rejects source/target reuse or drift",async () => {
    expect(await createStorageMigration(ops.db,identity,now)).toMatchObject({status:"queued",freeze_authorized:0});
    expect(await source.db.prepare("SELECT status FROM market_storage_fence").first()).toEqual({status:"open"});
    await expect(createStorageMigration(ops.db,{...identity,targetDatabaseId:identity.sourceDatabaseId},now)).rejects.toThrow("database-identity-invalid");
    await expect(createStorageMigration(ops.db,{...identity,codeRevision:"b".repeat(40)},now)).rejects.toThrow("identity-conflict");
    expect(github).not.toHaveBeenCalled();
  });
  it("has one live copy owner and rejects expired-owner checkpoint writes",async () => {
    const claims=await Promise.all([claimStorageMigration(ops.db,identity.id,{now}),claimStorageMigration(ops.db,identity.id,{now})]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owner=claims.find(Boolean)!;
    await saveStorageMigrationCheckpoint(ops.db,identity.id,owner.leaseToken,{key:"bars:cursor",inputHash:"b".repeat(64),payload:{after:"MSFT"}},now);
    const resumed=await claimStorageMigration(ops.db,identity.id,{now:later});
    expect(resumed).not.toBeNull();
    await expect(heartbeatStorageMigration(ops.db,identity.id,owner.leaseToken,later)).rejects.toThrow("lease-lost");
    await expect(saveStorageMigrationCheckpoint(ops.db,identity.id,owner.leaseToken,{key:"bars:cursor",inputHash:"b".repeat(64),payload:{after:"WRONG"}},later)).rejects.toThrow("lease-lost");
    expect(await loadStorageMigrationCheckpoint(ops.db,identity.id,"bars:cursor")).toMatchObject({payload:{after:"MSFT"}});
  });
  it("persists capture and progress across quota resets while leaving the source frozen",async () => {
    const plan=await install();
    const captured=await freezeStorageSource(source.db,identity,plan.schemaHash,now);
    const owner=(await claimStorageMigration(ops.db,identity.id,{now}))!;
    await recordStorageSourceCapture(ops.db,identity.id,owner.leaseToken,captured,now);
    await saveStorageMigrationCheckpoint(ops.db,identity.id,owner.leaseToken,{key:"table:universes",inputHash:plan.schemaHash,payload:{rows:3}},now);
    await deferStorageMigration(ops.db,identity.id,owner.leaseToken,"storage-resource-budget",{quota:true,now});
    expect(await run()).toMatchObject({status:"retrying",next_attempt_at:later.toISOString(),source_revision:captured.revision});
    expect(await claimStorageMigration(ops.db,identity.id,{now})).toBeNull();
    expect(await claimStorageMigration(ops.db,identity.id,{now:later})).not.toBeNull();
    expect(await assertStorageSourceFrozen(source.db,identity,plan.schemaHash)).toEqual(captured);
    expect(await loadStorageMigrationCheckpoint(ops.db,identity.id,"table:universes")).toMatchObject({payload:{rows:3}});
  });
  it("requires the entire reviewed trigger set and captures writes immediately before freezing",async () => {
    const plan=await prepareStorageSourceFence(source.db);
    expect(plan.statements).toHaveLength(plan.tables.length*3);
    expect(plan.tables).toContain("alpaca_daily_bars");expect(plan.tables).toContain("overview_snapshot_pointer");
    expect(plan.tables).not.toContain("market_storage_fence");
    source.script(plan.statements[0].sql);
    await expect(freezeStorageSource(source.db,identity,plan.schemaHash,now)).rejects.toThrow("fence-incomplete");
    source.script(plan.statements.map((statement)=>statement.sql).join("\n"));
    await source.db.prepare("INSERT INTO universes(id,name) VALUES('before','Before freeze')").run();
    const capture=await freezeStorageSource(source.db,identity,plan.schemaHash,now);
    expect(capture.revision).toBeGreaterThan(0);
    expect(await source.db.prepare("SELECT name FROM universes WHERE id='before'").first()).toEqual({name:"Before freeze"});
    await expect(source.db.prepare("INSERT INTO universes(id,name) VALUES('after','After freeze')").run()).rejects.toThrow("market-storage-source-frozen");
    await expect(source.db.prepare("UPDATE universes SET name='Changed'").run()).rejects.toThrow("market-storage-source-frozen");
    await expect(source.db.prepare("DELETE FROM universes").run()).rejects.toThrow("market-storage-source-frozen");
    await expect(source.db.prepare("INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,volume) VALUES('sip','SPY','2026-09-08',1,1,1,1,1)").run()).rejects.toThrow("market-storage-source-frozen");
    expect(await assertStorageSourceFrozen(source.db,identity,plan.schemaHash)).toEqual(capture);
  });
  it("detects schema changes, wrong capture identity and tampered clocks before accepting a copy",async () => {
    const plan=await install();await freezeStorageSource(source.db,identity,plan.schemaHash,now);
    await expect(assertStorageSourceFrozen(source.db,{...identity,id:"market-storage:other"},plan.schemaHash)).rejects.toThrow("capture-changed");
    await source.db.prepare("UPDATE market_storage_fence SET revision=revision+1").run();
    await expect(assertStorageSourceFrozen(source.db,identity,plan.schemaHash)).rejects.toThrow("capture-changed");
    source.script("CREATE TABLE unexpected_table(id TEXT PRIMARY KEY);");
    await expect(assertStorageSourceFrozen(source.db,identity,plan.schemaHash)).rejects.toThrow("schema-changed");
  });
  it("checks exact target seed contents and rejects existing application data",async () => {
    const plan=await prepareStorageSourceFence(source.db);
    await source.db.prepare("UPDATE market_data_maintenance_state SET updated_at='2026-09-09 00:00:00'").run();
    const seeds=new Map<string,Array<Record<string,unknown>>>([
      ["eod_input_clock",[{id:"default",revision:0}]],
      ["market_data_maintenance_state",[{id:"default",last_run_date:null,updated_at:"2026-09-09 00:00:00"}]],
    ]);
    await assertStorageTargetEmpty(source.db,plan.tables,seeds);
    await source.db.prepare("UPDATE eod_input_clock SET revision=1").run();
    await expect(assertStorageTargetEmpty(source.db,plan.tables,seeds)).rejects.toThrow("seed-mismatch");
    await source.db.prepare("UPDATE eod_input_clock SET revision=0").run();
    await source.db.prepare("INSERT INTO universes(id,name) VALUES('existing','Preserve me')").run();
    await expect(assertStorageTargetEmpty(source.db,plan.tables,seeds)).rejects.toThrow("target-not-empty");
  });
  it("requires explicit freeze evidence and pauses copy-complete without further dispatch",async () => {
    const plan=await prepareStorageSourceFence(source.db);
    await authorizeStorageMigrationFreeze(ops.db,identity.id,{sourceDatabaseId:identity.sourceDatabaseId,codeRevision:identity.codeRevision,
      schemaHash:plan.schemaHash,evidenceHash:"c".repeat(64)},now);
    expect(await run()).toMatchObject({freeze_authorized:1,source_schema_hash:plan.schemaHash});
    const owner=(await claimStorageMigration(ops.db,identity.id,{now}))!;
    await pauseStorageMigration(ops.db,identity.id,owner.leaseToken,"storage-capacity-evidence-required",{stage:"copy-complete"},now);
    expect(await coordinateStorageMigration(env,later)).toBe(true);
    expect(github).not.toHaveBeenCalled();
    await resumeStorageMigration(ops.db,identity.id,identity.codeRevision,later);
    expect(await run()).toMatchObject({status:"queued",progress_json:'{"stage":"copy-complete"}',freeze_authorized:1});
  });
  it("does not mark a run ready without immutable capture evidence",async () => {
    const owner=(await claimStorageMigration(ops.db,identity.id,{now}))!;
    await expect(markStorageMigrationReady(ops.db,identity.id,owner.leaseToken,{valid:true},now)).rejects.toThrow("capture-missing");
  });
  it("allows explicit abort only without a live lease and preserves source data",async () => {
    const plan=await install();const captured=await freezeStorageSource(source.db,identity,plan.schemaHash,now);
    const owner=(await claimStorageMigration(ops.db,identity.id,{now}))!;
    await recordStorageSourceCapture(ops.db,identity.id,owner.leaseToken,captured,now);
    const confirmation={sourceDatabaseId:identity.sourceDatabaseId,sourceStillCanonical:true,targetNeverActivated:true} as const;
    await expect(abortStorageMigration(ops.db,source.db,identity.id,confirmation,now)).rejects.toThrow("live-lease");
    await abortStorageMigration(ops.db,source.db,identity.id,confirmation,later);
    await abortStorageMigration(ops.db,source.db,identity.id,confirmation,later);
    expect(await run()).toMatchObject({status:"aborted"});
    const revision=await source.db.prepare("SELECT revision FROM market_storage_fence WHERE id='default'").first("revision");
    await source.db.prepare("INSERT INTO universes(id,name) VALUES('resumed','Writes resumed')").run();
    expect(await source.db.prepare("SELECT revision FROM market_storage_fence WHERE id='default'").first("revision")).toBe(revision);
    expect(await storageMigrationBlocksEod(env)).toBe(false);
    await expect(releaseStorageSourceFence(source.db,identity,plan.schemaHash,{sourceStillCanonical:false,targetNeverActivated:true} as never)).rejects.toThrow("canonical-proof-required");
  });
  it("gives enabled migration priority without touching pending EOD runs or calendar providers",async () => {
    const owner=(await claimStorageMigration(ops.db,identity.id,{now}))!;
    await pauseStorageMigration(ops.db,identity.id,owner.leaseToken,"storage-preflight-required",{},now);
    await ops.db.prepare(`INSERT INTO eod_runs(id,session_date,purpose,mode,status,created_at,updated_at)
      VALUES('eod:shadow:2026-09-08:daily','2026-09-08','daily','shadow','retrying',?,?)`).bind(now.toISOString(),now.toISOString()).run();
    const before=await ops.db.prepare("SELECT * FROM eod_runs").first<EodRun>();
    await coordinateEod(env,now);await dispatchEodRun(env,before!,now);
    expect(await ops.db.prepare("SELECT * FROM eod_runs").first()).toEqual(before);
    expect(ensureMarketCalendarCoverage).not.toHaveBeenCalled();expect(github).not.toHaveBeenCalled();
  });
  it("dispatches once with durable identity and resumes an ambiguous accepted GitHub request",async () => {
    github.mockImplementation(async (_url,init) => {
      if (init?.method==="POST") {expect(JSON.parse(String(init.body))).toEqual({ref:"main",inputs:{migration_id:identity.id}});throw new Error("lost acknowledgement");}
      return Response.json({total_count:0,workflow_runs:[]});
    });
    await expect(coordinateStorageMigration(env,now)).rejects.toThrow("lost acknowledgement");
    github.mockImplementation(async () => Response.json({total_count:1,workflow_runs:[{id:42,status:"waiting",display_title:`Storage ${identity.id}`,head_branch:"main",event:"workflow_dispatch"}]}));
    await coordinateStorageMigration(env,later);
    expect(github.mock.calls.filter(([,init])=>init?.method==="POST")).toHaveLength(1);
    expect(await run()).toMatchObject({status:"dispatched",github_run_id:"42"});
  });
  it("lets a runner start during the dispatch acknowledgement race without losing its lease",async () => {
    let claimed:Awaited<ReturnType<typeof claimStorageMigration>>=null;
    github.mockImplementation(async (_url,init) => {
      if (init?.method==="POST") {claimed=await claimStorageMigration(ops.db,identity.id,{githubRunId:"42",now});return new Response(null,{status:204});}
      return Response.json({total_count:0,workflow_runs:[]});
    });
    await coordinateStorageMigration(env,now);
    expect(claimed).not.toBeNull();expect(await run()).toMatchObject({status:"running",github_run_id:"42"});
  });
  it("defers storage on known exhausted quota and resumes after the UTC reset",async () => {
    await ops.db.prepare("INSERT INTO eod_usage(usage_date,rows_written) VALUES('2026-09-09',50000)").run();
    await coordinateStorageMigration(env,now);
    expect(await run()).toMatchObject({status:"retrying",next_attempt_at:later.toISOString()});
    expect(github).not.toHaveBeenCalled();
    await coordinateStorageMigration(env,later);
    expect(github.mock.calls.filter(([,init])=>init?.method==="POST")).toHaveLength(1);
  });
  it("reports migration failures and UTC retry while normal EOD is disabled, without exposing copied payloads or database IDs",async () => {
    const owner=(await claimStorageMigration(ops.db,identity.id,{now}))!;
    await ops.db.prepare("UPDATE market_storage_migrations SET stage='archives',progress_json=? WHERE id=?")
      .bind(JSON.stringify({rows:42,privatePayload:"private-copy-content"}),identity.id).run();
    await deferStorageMigration(ops.db,identity.id,owner.leaseToken,"storage-resource-budget",{quota:true,now});
    const status=await eodStatus({...env,EOD_RUNNER_MODE:"disabled"},now);
    expect(status).toMatchObject({mode:"disabled",pipelineMode:"storage-migration",ready:false,
      storageMigration:{status:"retrying",stage:"archives",failedStage:"archives",errorCode:"storage-resource-budget",
        nextAttemptAt:later.toISOString(),blocksEod:true,copiedRows:null,archivedRows:42,sourceSnapshotCaptured:false}});
    expect(JSON.stringify(status)).not.toContain("private-copy-content");
    expect(JSON.stringify(status)).not.toContain(identity.sourceDatabaseId);
    expect(github).not.toHaveBeenCalled();
  });
});
