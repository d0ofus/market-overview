import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { freezeStorageSource, prepareStorageSourceFence } from "../src/market-storage-fence";
import { assertReviewedStorageHistorySchema, inspectStorageHistoryPointerIndexSchema,
  releaseStorageHistoryVerificationFence, releaseStorageVerificationFence, STORAGE_HISTORY_POINTER_INDEXES } from "../src/market-storage-verification";

const identity={id:"market-storage:index-amendment",sourceDatabaseId:"11111111-1111-4111-8111-111111111111",
  targetDatabaseId:"22222222-2222-4222-8222-222222222222",historyDatabaseId:"33333333-3333-4333-8333-333333333333",
  sessionDate:"2026-09-08",codeRevision:"a".repeat(40)};
const options={historyDatabaseId:identity.historyDatabaseId,policy:"legacy" as const};
async function fixture(options:{fenceSuffix?:string}={}) {
  const history=createSqliteD1();
  try {
    history.script(readFileSync("history-migrations/0001_history.sql","utf8")
      +readFileSync("history-migrations/0002_market_storage_fence.sql","utf8")
        .replace(") STRICT, WITHOUT ROWID;",`) STRICT, WITHOUT ROWID${options.fenceSuffix ?? ""};`)
      +`INSERT INTO market_history_blocks(id,feed,ticker,calendar_year,schema_version,codec,checksum,row_count,
        first_date,last_date,uncompressed_bytes,payload_base64)
        VALUES('block','sip','TEST',2026,1,'gzip-json-v1','checksum',1,'2026-09-08','2026-09-08',100,'retained');
        INSERT INTO market_history_block_pointers(feed,ticker,calendar_year,block_id) VALUES('sip','TEST',2026,'block');`);
    const plan=await prepareStorageSourceFence(history.db);
    await history.db.batch(plan.statements.map(row=>history.db.prepare(row.sql)));
    const capture=await freezeStorageSource(history.db,identity,plan.schemaHash);
    await releaseStorageVerificationFence(history.db,identity,capture);
    const install=()=>history.script(STORAGE_HISTORY_POINTER_INDEXES.map(row=>row.sql+";").join("\n"));
    return {history,capture,install,dispose:history.dispose};
  } catch(error) {history.dispose();throw error;}
}

describe("explicit additive history pointer-index amendment",{timeout:30_000},()=>{
  it("accepts the exact retained historical transport suffix without rewriting the fence SQL or capture",async()=>{
    const f=await fixture({fenceSuffix:" /* storage-reviewed-ddl */"});
    try {
      const before=await f.history.db.prepare("SELECT sql FROM sqlite_schema WHERE name='market_storage_fence'").first<string>("sql");
      expect(before).toMatch(/\) STRICT, WITHOUT ROWID \/\* storage-reviewed-ddl \*\/$/);
      const captureBefore=await f.history.db.prepare("SELECT * FROM market_storage_fence").all();
      const legacy=await inspectStorageHistoryPointerIndexSchema(f.history.db,identity,f.capture,options);
      expect(legacy.schemaHash).toBe(f.capture.schemaHash);
      f.install();
      const amendment=await inspectStorageHistoryPointerIndexSchema(f.history.db,identity,f.capture,{...options,policy:"indexed"});
      await releaseStorageHistoryVerificationFence(f.history.db,identity,f.capture,amendment);
      expect(await f.history.db.prepare("SELECT sql FROM sqlite_schema WHERE name='market_storage_fence'").first<string>("sql")).toBe(before);
      expect((await f.history.db.prepare("SELECT * FROM market_storage_fence").all()).results).toEqual(captureBefore.results);
    } finally {f.dispose();}
  });
  it.each([" /* arbitrary */"," /* storage-reviewed-ddl-extra */"," /* storage-reviewed-ddl */ /* arbitrary */"])
    ("rejects unreviewed fence suffix %s",async(fenceSuffix)=>{
      const f=await fixture({fenceSuffix});
      try {
        await expect(inspectStorageHistoryPointerIndexSchema(f.history.db,identity,f.capture,options))
          .rejects.toThrow("storage-history-fence-schema-not-reviewed");
      } finally {f.dispose();}
    });
  it("preserves the original capture and rows, allows later tracked bootstrap writes, and uses atomic read-only inspection",async()=>{
    const f=await fixture();
    try {
      const before=await inspectStorageHistoryPointerIndexSchema(f.history.db,identity,f.capture,options);
      expect(before.schemaHash).toBe(f.capture.schemaHash);
      const fenceBefore=await f.history.db.prepare("SELECT * FROM market_storage_fence").all();
      const rowsBefore=await f.history.db.prepare("SELECT * FROM market_history_blocks").all();
      f.install();
      const amendment=await inspectStorageHistoryPointerIndexSchema(f.history.db,identity,f.capture,{...options,policy:"indexed"});
      expect(amendment.schemaHash).not.toBe(before.schemaHash);
      expect(amendment).toMatchObject({legacySchemaHash:before.schemaHash,snapshotRevision:before.snapshotRevision,revision:before.revision});
      await expect(releaseStorageVerificationFence(f.history.db,identity,f.capture)).rejects.toThrow("storage-verification-release-schema-changed");
      const prepare=vi.spyOn(f.history.db,"prepare"),batch=vi.spyOn(f.history.db,"batch");
      await releaseStorageHistoryVerificationFence(f.history.db,identity,f.capture,amendment);
      expect(batch).toHaveBeenCalledTimes(1);
      expect(prepare.mock.calls).toHaveLength(2);
      expect(prepare.mock.calls.every(([sql])=>sql.startsWith("SELECT"))).toBe(true);
      prepare.mockRestore();batch.mockRestore();
      expect((await f.history.db.prepare("SELECT * FROM market_storage_fence").all()).results).toEqual(fenceBefore.results);
      expect((await f.history.db.prepare("SELECT * FROM market_history_blocks").all()).results).toEqual(rowsBefore.results);
      await f.history.db.prepare("UPDATE market_history_blocks SET verified_at='2026-09-11' WHERE id='block'").run();
      await expect(releaseStorageHistoryVerificationFence(f.history.db,identity,f.capture,amendment)).resolves.toBeUndefined();
      expect((await inspectStorageHistoryPointerIndexSchema(f.history.db,identity,f.capture,{...options,policy:"indexed"})).revision)
        .toBeGreaterThan(amendment.revision);
      await expect(assertReviewedStorageHistorySchema(f.history.db,"indexed")).resolves.toBeUndefined();
      await expect(assertReviewedStorageHistorySchema(f.history.db,"legacy")).rejects.toThrow("pointer-index-set-invalid");
    } finally {f.dispose();}
  });
  it("requires the exact complete pair and preserves explicit legacy/indexed schema policies",async()=>{
    const f=await fixture();
    try {
      await expect(assertReviewedStorageHistorySchema(f.history.db,"legacy")).resolves.toBeUndefined();
      await expect(assertReviewedStorageHistorySchema(f.history.db,"indexed")).rejects.toThrow("pointer-index-set-invalid");
      f.history.script(STORAGE_HISTORY_POINTER_INDEXES[0].sql+";");
      await expect(assertReviewedStorageHistorySchema(f.history.db)).rejects.toThrow("pointer-index-set-invalid");
      await expect(inspectStorageHistoryPointerIndexSchema(f.history.db,identity,f.capture,{...options,policy:"indexed"}))
        .rejects.toThrow("pointer-index-set-invalid");
    } finally {f.dispose();}
  });
  it.each([
    ["wrong-columns", "DROP INDEX idx_market_history_pointers_block_id; CREATE INDEX idx_market_history_pointers_block_id ON market_history_block_pointers(ticker);"],
    ["extra-index", "CREATE INDEX unexpected_index ON market_history_block_pointers(ticker);"],
    ["internal-prefix-index", "CREATE INDEX _cf_unreviewed ON market_history_block_pointers(ticker);"],
    ["guard-prefix-index", "CREATE INDEX market_storage_guard_unreviewed ON market_history_block_pointers(ticker);"],
    ["extra-table", "CREATE TABLE unexpected_table(id TEXT PRIMARY KEY);"],
    ["extra-trigger", "CREATE TRIGGER unexpected_trigger AFTER UPDATE ON market_history_blocks BEGIN SELECT 1; END;"],
    ["changed-table", "ALTER TABLE market_history_blocks ADD COLUMN unexpected TEXT;"],
    ["changed-fence-definition", "ALTER TABLE market_storage_fence ADD COLUMN unexpected TEXT;"],
  ])("rejects %s even after both expected indexes exist",async(_kind,mutation)=>{
    const f=await fixture();
    try {
      f.install();f.history.script(mutation);
      await expect(inspectStorageHistoryPointerIndexSchema(f.history.db,identity,f.capture,{...options,policy:"indexed"})).rejects.toThrow();
    } finally {f.dispose();}
  });
  it("rejects altered capture identity, a rollback-released fence, and frozen state",async()=>{
    const f=await fixture();
    try {
      f.install();
      for(const historyDatabaseId of [identity.sourceDatabaseId,identity.targetDatabaseId]) {
        await expect(inspectStorageHistoryPointerIndexSchema(f.history.db,identity,f.capture,{historyDatabaseId,policy:"indexed"}))
          .rejects.toThrow("database-identity-conflict");
      }
      await expect(inspectStorageHistoryPointerIndexSchema(f.history.db,{...identity,codeRevision:"b".repeat(40)},f.capture,{...options,policy:"indexed"}))
        .rejects.toThrow("open-capture-mismatch");
      await expect(inspectStorageHistoryPointerIndexSchema(f.history.db,identity,{...f.capture,revision:f.capture.revision+1},{...options,policy:"indexed"}))
        .rejects.toThrow("open-capture-mismatch");
      f.history.script("UPDATE market_storage_fence SET released_at='2026-09-11';");
      await expect(inspectStorageHistoryPointerIndexSchema(f.history.db,identity,f.capture,{...options,policy:"indexed"})).rejects.toThrow("open-capture-mismatch");
      f.history.script("UPDATE market_storage_fence SET released_at=NULL,status='frozen';");
      await expect(inspectStorageHistoryPointerIndexSchema(f.history.db,identity,f.capture,{...options,policy:"indexed"})).rejects.toThrow("open-capture-mismatch");
    } finally {f.dispose();}
  });
  it("rejects mismatched/stale amendment hashes or a revision newer than the live archive",async()=>{
    const f=await fixture();
    try {
      f.install();
      const amendment=await inspectStorageHistoryPointerIndexSchema(f.history.db,identity,f.capture,{...options,policy:"indexed"});
      for(const change of [{schemaHash:"b".repeat(64)},{legacySchemaHash:"b".repeat(64)},
        {indexManifestHash:"b".repeat(64)},{snapshotRevision:amendment.snapshotRevision+1},{revision:amendment.revision+1}]) {
        await expect(releaseStorageHistoryVerificationFence(f.history.db,identity,f.capture,{...amendment,...change}))
          .rejects.toThrow("amendment-mismatch");
      }
    } finally {f.dispose();}
  });
  it.each(["missing","altered-literal","disabled-counter"] as const)("rejects %s tracking guards",async(kind)=>{
    const f=await fixture();
    try {
      f.install();
      const name="market_storage_guard_market_history_blocks_update";
      const prior=await f.history.db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").bind(name).first<string>("sql");
      f.history.script(`DROP TRIGGER ${name};`+(kind==="missing" ? "" : kind==="altered-literal"
        ? prior!.replaceAll("'frozen'","'fro zen'")+";" : prior!.replace("revision=revision+1","revision=revision+0")+";"));
      await expect(inspectStorageHistoryPointerIndexSchema(f.history.db,identity,f.capture,{...options,policy:"indexed"}))
        .rejects.toThrow("tracking-guards-changed");
    } finally {f.dispose();}
  });
});
