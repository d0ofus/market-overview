import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { approveStorageExecutionTransition, assertStorageExecutionRevision, resolveStorageExecutionIdentity, storageExecutionKey } from "../src/market-storage-execution";
import { authorizeStorageMigrationFreeze, claimStorageMigration, createStorageMigration, loadStorageMigration,
  loadStorageMigrationCheckpoint, pauseStorageMigration, recordStorageSourceCapture, resumeStorageMigration,
  saveStorageMigrationCheckpoint, storageExecutionIdentity, storageMigrationIdentity, type StorageMigrationIdentity } from "../src/market-storage-control";
import { freezeStorageSource, prepareStorageSourceFence } from "../src/market-storage-fence";
import { storageHash } from "../src/market-storage-pages";

describe("execution revision transitions preserve populated migration evidence", { timeout: 30_000 }, () => {
  let source: ReturnType<typeof createSqliteD1>, ops: ReturnType<typeof createSqliteD1>;
  const origin = "a".repeat(40), next = "b".repeat(40);
  const identity: StorageMigrationIdentity = { id: "market-storage:2026-09-08:aaaaaaaaaaaa", sessionDate: "2026-09-08", codeRevision: origin,
    sourceDatabaseId: "00000000-0000-4000-8000-000000000001", targetDatabaseId: "00000000-0000-4000-8000-000000000002",
    historyDatabaseId: "00000000-0000-4000-8000-000000000003" };
  beforeEach(async () => {
    source = createSqliteD1(); ops = createSqliteD1(); source.migrate("market-data-migrations"); ops.migrate("ops-migrations");
    await createStorageMigration(ops.db,identity);
    const plan = await prepareStorageSourceFence(source.db);
    source.script(plan.statements.map((statement) => statement.sql).join("\n"));
    const evidence = { identity, sourceSchemaHash: plan.schemaHash, hotSessions: 90 }, hash = await storageHash(evidence);
    await ops.db.prepare("INSERT INTO eod_rollout_evidence VALUES(?,?,?)")
      .bind(`storage-preflight:${identity.id}`,JSON.stringify({hash,evidence}),new Date().toISOString()).run();
    await authorizeStorageMigrationFreeze(ops.db,identity.id,{sourceDatabaseId:identity.sourceDatabaseId,codeRevision:origin,schemaHash:plan.schemaHash,evidenceHash:hash});
    const capture = await freezeStorageSource(source.db,identity,plan.schemaHash), owner = (await claimStorageMigration(ops.db,identity.id))!;
    await recordStorageSourceCapture(ops.db,identity.id,owner.leaseToken,capture);
    await saveStorageMigrationCheckpoint(ops.db,identity.id,owner.leaseToken,{key:"archives",inputHash:await storageHash([identity,capture]),
      payload:{after:["sip","AAPL","2025-12-31"],rows:5000,hash:"c".repeat(64),done:false}});
    await pauseStorageMigration(ops.db,identity.id,owner.leaseToken,"storage-resume-required",{archivedRows:5000});
  });
  afterEach(() => { source.dispose(); ops.dispose(); });
  const input = () => ({ ops:ops.db,source:source.db,migrationId:identity.id,fromRevision:origin,codeRevision:next,
    changedFiles:["worker/src/eod-budget-profile.ts"],diffHash:"d".repeat(64),assertReviewedCheckout:vi.fn(async () => undefined),
    assertNoWorkflowWriters:vi.fn(async () => undefined) });
  it("approves new execution without rehashing checkpoints or changing frozen source identity", async () => {
    const before = await loadStorageMigrationCheckpoint(ops.db,identity.id,"archives"), config = input();
    const record = await approveStorageExecutionTransition(config), run = (await loadStorageMigration(ops.db,identity.id))!;
    expect(record.checkpointCount).toBe(1); expect(config.assertReviewedCheckout).toHaveBeenCalledTimes(2);
    expect(config.assertNoWorkflowWriters).toHaveBeenCalledTimes(2);
    expect(storageMigrationIdentity(run)).toEqual(identity);
    expect(storageExecutionIdentity(run)).toEqual({...identity,codeRevision:next});
    expect(run).toMatchObject({status:"awaiting-evidence",execution_revision:next,execution_evidence_hash:record.evidenceHash,
      error_code:"storage-execution-github-pin-required",progress_json:'{"archivedRows":5000}'});
    expect(await loadStorageMigrationCheckpoint(ops.db,identity.id,"archives")).toEqual(before);
    expect(await source.db.prepare("SELECT status,code_revision,revision,snapshot_revision FROM market_storage_fence").first())
      .toMatchObject({status:"frozen",code_revision:origin,revision:0,snapshot_revision:0});
    expect(await assertStorageExecutionRevision(ops.db,run,next)).toEqual(record);
    expect(await resolveStorageExecutionIdentity(ops.db,identity,next)).toEqual({identity:{...identity,codeRevision:next},record});
    expect(await approveStorageExecutionTransition(config)).toEqual(record);
    await expect(assertStorageExecutionRevision(ops.db,run,origin)).rejects.toThrow("revision-not-approved");
    await resumeStorageMigration(ops.db,identity.id,origin);
    expect(await claimStorageMigration(ops.db,identity.id,{executionRevision:origin})).toBeNull();
    expect(await claimStorageMigration(ops.db,identity.id,{executionRevision:next})).not.toBeNull();
  });
  it("rejects a live copy owner and an active GitHub writer", async () => {
    const config = input(); config.assertNoWorkflowWriters.mockRejectedValue(new Error("workflow-active"));
    await expect(approveStorageExecutionTransition(config)).rejects.toThrow("workflow-active");
    await resumeStorageMigration(ops.db,identity.id,origin); await claimStorageMigration(ops.db,identity.id);
    await expect(approveStorageExecutionTransition(input())).rejects.toThrow("live-writer");
    expect((await loadStorageMigration(ops.db,identity.id))?.execution_revision).toBeNull();
  });
  it("rejects source unfreezing and refuses to reuse completed consumer/bootstrap proof under new code", async () => {
    source.script("UPDATE market_storage_fence SET status='open' WHERE id='default';");
    await expect(approveStorageExecutionTransition(input())).rejects.toThrow("source-capture-changed");
    source.script("UPDATE market_storage_fence SET status='frozen' WHERE id='default';");
    await ops.db.prepare("INSERT INTO market_storage_checkpoints VALUES(?,?,?,?,?)")
      .bind(identity.id,"consumer-parity:complete","e".repeat(64),"{}",new Date().toISOString()).run();
    await expect(approveStorageExecutionTransition(input())).rejects.toThrow("late-transition-requires-new-validation");
  });
  it("cannot accept a forged lineage hash or mismatched original identity", async () => {
    await approveStorageExecutionTransition(input());
    const run = (await loadStorageMigration(ops.db,identity.id))!;
    await ops.db.prepare("UPDATE eod_rollout_evidence SET evidence_json=json_set(evidence_json,'$.sourceCapture.revision',99) WHERE id=?")
      .bind(storageExecutionKey(identity.id,next)).run();
    await expect(assertStorageExecutionRevision(ops.db,run,next)).rejects.toThrow("record-integrity");
    await expect(resolveStorageExecutionIdentity(ops.db,{...identity,targetDatabaseId:identity.sourceDatabaseId},next)).rejects.toThrow("storage-identity-mismatch");
  });
});
