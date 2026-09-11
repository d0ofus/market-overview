import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { STORAGE_TABLES, STORAGE_INDEXES, STORAGE_TRIGGERS } from "../src/market-storage-schema";
import { copyStorageArchiveBlock, storageBar } from "../src/market-storage-copy";
import { readStoragePage, storageHash, storageTable } from "../src/market-storage-pages";
import { authorizeStorageMigrationFreeze, claimStorageMigration, createStorageMigration, loadStorageMigration,
  loadStorageMigrationCheckpoint, recordStorageSourceCapture, saveStorageMigrationCheckpoint } from "../src/market-storage-control";
import { freezeStorageSource, prepareStorageSourceFence } from "../src/market-storage-fence";
import { assertStorageVerificationCapture, captureStorageHistoryBaseline, releaseStorageVerificationFence,
  runStorageVerification } from "../src/market-storage-verification";
import type { MarketHistoryBar } from "../src/market-history";

const identity={id:"market-storage:verification",sourceDatabaseId:"11111111-1111-1111-1111-111111111111",
  targetDatabaseId:"22222222-2222-2222-2222-222222222222",historyDatabaseId:"33333333-3333-3333-3333-333333333333",
  sessionDate:"2026-09-08",codeRevision:"a".repeat(40)};
const schema=STORAGE_TABLES.map((row) => row.sql+";").join("\n")+STORAGE_INDEXES.map((row) => row.sql+";").join("\n");
const triggers=STORAGE_TRIGGERS.map((row) => row.sql+";").join("\n");
const ledger="CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);"
  +"INSERT INTO d1_migrations VALUES(1,'0009_market_storage_fence.sql','2026-09-09 01:00:00');";
const sourcePrices="INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,fetched_at) VALUES"
  +"('sip','TEST','2025-12-31',10,10,10,10,'2026-09-09'),('sip','TEST','2026-09-08',11,11,11,11,'2026-09-09'),"
  +"('sip','TEST','2026-09-09',12,12,12,12,'2026-09-09');";
const targetPrices="INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c,fetched_at) VALUES('sip','TEST','2026-09-08',11,11,11,11,'2026-09-09');";
const oldBar=(date:string,c=9):MarketHistoryBar => ({feed:"sip",ticker:"TEST",date,o:c,h:c,l:c,c,volume:null,
  reportedVolume:null,reportedVolumeCollectedAt:null,sourceProvider:"alpaca",adjustment:"split",observedAt:null,fetchedAt:"old"});
function install(db:D1Database) {
  return async (statements:readonly string[]) => {
    for (let offset=0;offset<statements.length;offset+=20) await db.batch(statements.slice(offset,offset+20).map((sql) => db.prepare(sql)));
  };
}
async function fixture(options:{baseline?:boolean;archive?:boolean}={}) {
  const source=createSqliteD1(),target=createSqliteD1(),history=createSqliteD1(),ops=createSqliteD1();
  const dispose=() => {source.dispose();target.dispose();history.dispose();ops.dispose();};
  try {
    const common=readFileSync("market-data-migrations/0009_market_storage_fence.sql","utf8")+ledger
      +"INSERT INTO universes(id,name) VALUES('test','Retained'),('z','Tail');";
    source.script(schema+common+sourcePrices+triggers);target.script(schema+common+targetPrices+triggers);
    history.migrate("history-migrations");ops.script(readFileSync("ops-migrations/0010_market_storage_migrations.sql","utf8")
      +readFileSync("ops-migrations/0011_market_storage_execution.sql","utf8"));
    const prior=await copyStorageArchiveBlock(history.db,[oldBar("2026-01-02"),oldBar("2026-09-08")]);
    // Preserve a superseded immutable revision as well as current pointer rows.
    const priorActive=await copyStorageArchiveBlock(history.db,[oldBar("2026-01-02"),oldBar("2026-09-08",10)]);
    await createStorageMigration(ops.db,identity);
    const plan=await prepareStorageSourceFence(source.db);
    await authorizeStorageMigrationFreeze(ops.db,identity.id,{sourceDatabaseId:identity.sourceDatabaseId,codeRevision:identity.codeRevision,
      schemaHash:plan.schemaHash,evidenceHash:"b".repeat(64)});
    const claimed=(await claimStorageMigration(ops.db,identity.id))!;
    await install(source.db)(plan.statements.map((row) => row.sql));
    const capture=await freezeStorageSource(source.db,identity,plan.schemaHash);
    await recordStorageSourceCapture(ops.db,identity.id,claimed.leaseToken,capture);
    const run=(await loadStorageMigration(ops.db,identity.id))!;
    const context={source:source.db,target:target.db,history:history.db,ops:ops.db,run,leaseToken:claimed.leaseToken,
      installTargetFence:install(target.db),installHistoryFence:install(history.db)};
    if (options.baseline!==false) await captureStorageHistoryBaseline(context);
    if (options.archive!==false) {
      const rows=await readStoragePage(source.db,storageTable("alpaca_daily_bars"),null);
      for (const year of ["2025","2026"]) await copyStorageArchiveBlock(history.db,rows.filter((row) => String(row.date).startsWith(year)).map(storageBar));
    }
    await saveStorageMigrationCheckpoint(ops.db,identity.id,claimed.leaseToken,{key:"copy-complete",inputHash:await storageHash([identity,capture]),payload:{copied:true}});
    return {source,target,history,ops,context,prior,priorActive,dispose};
  } catch (error) {dispose();throw error;}
}

describe("independent whole-storage verification on real SQLite",{timeout:180_000},() => {
  it("resumes a bounded verification, proves exact tables/hot rows and retained old archive revisions, and never claims live acceptance",async () => {
    const f=await fixture();
    try {
      await expect(runStorageVerification({...f.context,deadlineMs:0})).rejects.toThrow("storage-verification-time-slice-complete");
      expect(await loadStorageMigrationCheckpoint(f.ops.db,identity.id,"verification:captures")).not.toBeNull();
      await expect(f.target.db.prepare("INSERT INTO d1_migrations(name) VALUES('concurrent.sql')").run()).rejects.toThrow("market-storage-source-frozen");
      await expect(f.history.db.prepare("DELETE FROM market_history_blocks WHERE id=?").bind(f.prior.id).run()).rejects.toThrow("market-storage-source-frozen");
      const evidence=await runStorageVerification(f.context);
      expect(evidence).toMatchObject({schemaVersion:1,verified:true,identity,prices:{sourceRows:3,hotRows:1},
        archive:{baselineBlockRows:2,baselinePointerRows:1,blockRows:4,pointerRows:2}});
      expect(evidence.tables).toHaveLength(STORAGE_TABLES.length);
      expect(evidence.tables.find((row) => row.name==="d1_migrations")?.rows).toBe(1);
      expect(evidence.remainingLiveGates).toContain("consumer-parity");
      expect((await loadStorageMigration(f.ops.db,identity.id))?.status).toBe("running");
      expect(await runStorageVerification(f.context)).toEqual(evidence);
      await releaseStorageVerificationFence(f.target.db,identity,evidence.targetCapture);
      await releaseStorageVerificationFence(f.target.db,identity,evidence.targetCapture);
      await f.target.db.prepare("UPDATE universes SET name='Bootstrap' WHERE id='test'").run();
      const revision=await f.target.db.prepare("SELECT revision FROM market_storage_fence").first<number>("revision");
      expect(revision).toBeGreaterThan(evidence.targetCapture.revision);
      await expect(assertStorageVerificationCapture(f.target.db,identity,evidence.targetCapture)).rejects.toThrow();
      await expect(runStorageVerification(f.context)).rejects.toThrow("storage-migration-source-capture-changed");
    } finally {f.dispose();}
  });
  it.each(["extra-tail","missing-row","altered-ledger"] as const)("rejects non-price mismatch in either direction: %s",async (kind) => {
    const f=await fixture();
    try {
      if (kind==="extra-tail") await f.target.db.prepare("INSERT INTO universes(id,name) VALUES('zz','Unexpected')").run();
      if (kind==="missing-row") await f.target.db.prepare("DELETE FROM universes WHERE id='z'").run();
      if (kind==="altered-ledger") await f.target.db.prepare("UPDATE d1_migrations SET name='wrong.sql'").run();
      await expect(runStorageVerification(f.context)).rejects.toThrow("storage-verification-table-mismatch");
      expect(await loadStorageMigrationCheckpoint(f.ops.db,identity.id,"verification:complete")).toBeNull();
    } finally {f.dispose();}
  });
  it("rejects an extra hot symbol even when every required latest row is present",async () => {
    const f=await fixture();
    try {
      // Trigger-free insertion emulates a corrupt copy, without changing another
      // copied table and masking the independent extra-price-row detection.
      f.target.script(STORAGE_TRIGGERS.map((row) => `DROP TRIGGER ${row.name};`).join("\n")
        +"INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c) VALUES('sip','ZZZ','2026-09-08',9,9,9,9);"+triggers);
      await expect(runStorageVerification(f.context)).rejects.toThrow("storage-verification-hot-extra-or-missing-rows");
    } finally {f.dispose();}
  });
  it("rejects a valid replacement archive which omitted an archive-only observation",async () => {
    const f=await fixture({archive:false});
    try {
      // A valid-but-incomplete new pointer must not be accepted just because
      // checksums and every source price still match.
      const rows=await readStoragePage(f.source.db,storageTable("alpaca_daily_bars"),null);
      await f.history.db.prepare("DELETE FROM market_history_block_pointers WHERE calendar_year=2026").run();
      for (const year of ["2025","2026"]) await copyStorageArchiveBlock(f.history.db,rows.filter((row) => String(row.date).startsWith(year)).map(storageBar));
      await expect(runStorageVerification(f.context)).rejects.toThrow("storage-verification-archive-only-observation-lost");
    } finally {f.dispose();}
  });
  it("rejects lost orphan immutable revisions",async () => {
    const f=await fixture();
    try {
      // This initial revision is no longer referenced by current/previous
      // pointers, but it was inventoried before copy and must still exist.
      await f.history.db.prepare("DELETE FROM market_history_blocks WHERE id=?").bind(f.prior.id).run();
      await expect(runStorageVerification(f.context)).rejects.toThrow("storage-verification-old-archive-revision-lost");
    } finally {f.dispose();}
  });
  it("requires a genuinely prior baseline and rejects a changed source capture before reading target data",async () => {
    const f=await fixture({baseline:false});
    try {
      await expect(runStorageVerification(f.context)).rejects.toThrow("storage-verification-prior-history-evidence-required");
      await expect(captureStorageHistoryBaseline(f.context)).rejects.toThrow("storage-history-baseline-was-not-captured-before-copy");
      await f.source.db.prepare("UPDATE market_storage_fence SET revision=revision+1").run();
      await expect(runStorageVerification(f.context)).rejects.toThrow("storage-migration-source-capture-changed");
    } finally {f.dispose();}
  });
  it("rejects archive payload corruption even when block metadata still looks valid",async () => {
    const f=await fixture();
    try {
      await f.history.db.prepare("UPDATE market_history_blocks SET payload_base64='invalid' WHERE id=?").bind(f.prior.id).run();
      await expect(runStorageVerification(f.context)).rejects.toThrow("Archive");
    } finally {f.dispose();}
  });
});
