import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import { STORAGE_INDEXES,STORAGE_TABLES,STORAGE_TRIGGERS } from "../src/market-storage-schema";
import { assertReviewedStorageSchema,copyStorageArchiveBlock,runStorageCopy,STORAGE_TARGET_DDL } from "../src/market-storage-copy";
import { canonicalStorageRows,copyStorageRows,readStoragePage,storageTable,storageHash,storageRowKey } from "../src/market-storage-pages";
import { authorizeStorageMigrationFreeze,claimStorageMigration,createStorageMigration,deferStorageMigration,loadStorageMigration,loadStorageMigrationCheckpoint,resumeStorageMigration,saveStorageMigrationCheckpoint } from "../src/market-storage-control";
import { estimateEodQueries } from "../src/eod-d1-rest";
import { prepareStorageSourceFence } from "../src/market-storage-fence";
import { loadMarketHistory,loadVerifiedArchivedMarketHistory,type MarketHistoryBar } from "../src/market-history";
import type { Env } from "../src/types";

const identity={id:"market-storage:test",sourceDatabaseId:"11111111-1111-1111-1111-111111111111",
  targetDatabaseId:"22222222-2222-2222-2222-222222222222",historyDatabaseId:"33333333-3333-3333-3333-333333333333",
  sessionDate:"2026-09-08",codeRevision:"a".repeat(40)};
const schema=STORAGE_TABLES.map((row) => row.sql+";").join("\n")+STORAGE_INDEXES.map((row) => row.sql+";").join("\n");
const bar=(date:string,close=10):MarketHistoryBar => ({feed:"sip",ticker:"TEST",date,o:close,h:close,l:close,c:close,
  volume:null,reportedVolume:null,reportedVolumeCollectedAt:null,sourceProvider:"alpaca",adjustment:"split",observedAt:null,fetchedAt:"2026-09-09"});

describe("reviewed market storage copy on real schema",{timeout:30_000},() => {
  it("copies and replays 250 complete rows, verifies the final row, and detects an extra destination key",async()=>{
    const target=createSqliteD1();
    try {
      target.script(schema);
      const table=storageTable("overview_provider_catalog_cache");
      const rows=Array.from({length:250},(_,i)=>({provider_key:`p${String(i*2).padStart(4,"0")}`,catalog_date:"2026-09-08",symbols_json:`["T${i}"]`,fetched_at:"2026-09-09"}));
      const batches=vi.spyOn(target.db,"batch");
      await copyStorageRows(target.db,table,rows);await copyStorageRows(target.db,table,rows);
      expect(batches.mock.calls).toHaveLength(2);expect(batches.mock.calls[0][0]).toHaveLength(2);
      const statements=batches.mock.calls[0][0] as unknown as Array<{sql:string;params:unknown[]}>;
      expect(statements[1].sql).toContain("LIMIT 251");
      expect(estimateEodQueries(statements)).toEqual({reads:4032,writes:2016});
      expect(canonicalStorageRows(table,await readStoragePage(target.db,table,null))).toBe(canonicalStorageRows(table,rows));
      await target.db.prepare("UPDATE overview_provider_catalog_cache SET symbols_json='wrong' WHERE provider_key='p0498'").run();
      await expect(copyStorageRows(target.db,table,rows)).rejects.toThrow("storage-target-readback-mismatch");
      await target.db.prepare("UPDATE overview_provider_catalog_cache SET symbols_json=? WHERE provider_key='p0498'").bind(rows[249].symbols_json).run();
      await target.db.prepare("INSERT INTO overview_provider_catalog_cache VALUES('p0251','2026-09-08','extra','2026-09-09')").run();
      await expect(copyStorageRows(target.db,table,rows)).rejects.toThrow("storage-target-readback-mismatch");
      await expect(copyStorageRows(target.db,table,[...rows,rows[0]])).rejects.toThrow("storage-copy-invalid-batch");
      expect(()=>estimateEodQueries([{sql:statements[0].sql,params:[JSON.stringify(Array(251).fill([]))]}])).toThrow("storage-copy-invalid-batch");
    } finally {target.dispose();vi.restoreAllMocks();}
  });
  it("uses complete composite keys and rejects modified destination rows on retry",async () => {
    const source=createSqliteD1(),target=createSqliteD1();
    try {
      source.script(schema);target.script(schema);
      const table=storageTable("universe_symbols");
      await source.db.batch([source.db.prepare("INSERT INTO universe_symbols VALUES('a','B')"),
        source.db.prepare("INSERT INTO universe_symbols VALUES('a','C')"),source.db.prepare("INSERT INTO universe_symbols VALUES('b','A')")]);
      const rows=await readStoragePage(source.db,table,["a","B"]);
      expect(rows.map((row) => [row.universe_id,row.ticker])).toEqual([["a","C"],["b","A"]]);
      await copyStorageRows(target.db,table,rows);await copyStorageRows(target.db,table,rows);
      expect(canonicalStorageRows(table,await readStoragePage(target.db,table,null))).toBe(canonicalStorageRows(table,rows));
      const prices=storageTable("alpaca_daily_bars");
      await source.db.prepare("INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c) VALUES('sip','TEST','2026-09-08',10,10,10,10)").run();
      const priceRows=await readStoragePage(source.db,prices,null);
      await copyStorageRows(target.db,prices,priceRows);
      await target.db.prepare("UPDATE alpaca_daily_bars SET c=11").run();
      await expect(copyStorageRows(target.db,prices,priceRows)).rejects.toThrow("storage-target-readback-mismatch");
    } finally {source.dispose();target.dispose();}
  });
  it("retains archived-only dates and exact source timestamps, with checksum read-back",async () => {
    const history=createSqliteD1(),source=createSqliteD1();
    try {
      history.migrate("history-migrations");source.script(schema);
      await copyStorageArchiveBlock(history.db,[bar("2026-01-02"),{...bar("2026-09-08"),fetchedAt:"old"}]);
      const next=await copyStorageArchiveBlock(history.db,[bar("2026-09-08")]);
      expect(await copyStorageArchiveBlock(history.db,[bar("2026-09-08")])).toEqual(next);
      const env={DB:source.db,MARKET_DATA_DB:source.db,MARKET_HISTORY_DB:history.db} as Env;
      const rows=await loadVerifiedArchivedMarketHistory(env,{tickers:["TEST"],feed:"sip"});
      expect(rows.map((row) => row.date)).toEqual(["2026-01-02","2026-09-08"]);
      expect(rows[1].fetchedAt).toBe("2026-09-09");
      expect(rows[1].volume).toBeNull();
      await history.db.prepare("UPDATE market_history_blocks SET checksum='bad' WHERE id=?").bind(next.id).run();
      await expect(copyStorageArchiveBlock(history.db,[bar("2026-09-08")])).rejects.toThrow();
    } finally {history.dispose();source.dispose();}
  });
  it("subdivides valid large rows before the D1 value limit without changing row identity",async () => {
    const target=createSqliteD1();
    try {
      target.script(schema);
      const table=storageTable("overview_provider_catalog_cache"),payload="x".repeat(950_000);
      const rows=[{provider_key:"a",catalog_date:"2026-09-08",symbols_json:payload,fetched_at:"2026-09-09"},
        {provider_key:"b",catalog_date:"2026-09-08",symbols_json:payload,fetched_at:"2026-09-09"}];
      await copyStorageRows(target.db,table,rows);
      expect(canonicalStorageRows(table,await readStoragePage(target.db,table,null))).toBe(canonicalStorageRows(table,rows));
    } finally {target.dispose();}
  },30_000);
  it("requires preflight, preserves every source row and revision, and stops before cutover",async () => {
    const source=createSqliteD1(),target=createSqliteD1(),history=createSqliteD1(),ops=createSqliteD1();
    try {
      source.script(schema+STORAGE_TRIGGERS.map((row) => row.sql+";").join("\n")
        +readFileSync("market-data-migrations/0009_market_storage_fence.sql","utf8")
        +"CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);"
        +"INSERT INTO d1_migrations(name) VALUES('0009_market_storage_fence.sql');");
      history.migrate("history-migrations");ops.script(readFileSync("ops-migrations/0010_market_storage_migrations.sql","utf8")
        +readFileSync("ops-migrations/0011_market_storage_execution.sql","utf8"));
      await source.db.prepare("INSERT INTO eod_input_clock VALUES('default',0)").run();
      await source.db.batch([source.db.prepare("INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c) VALUES('sip','TEST','2025-12-31',10,10,10,10)"),
        source.db.prepare("INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c) VALUES('sip','TEST','2026-09-08',11,11,11,11)"),
        source.db.prepare("INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c) VALUES('sip','TEST','2026-09-09',12,12,12,12)"),
        source.db.prepare("INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c) VALUES('iex','TEST','2026-09-08',9,9,9,9)"),
        source.db.prepare("INSERT INTO universes(id,name) VALUES('test','Retained Universe')")]);
      const supportTable=storageTable("overview_provider_catalog_cache");
      const supportRows=Array.from({length:601},(_,i)=>({provider_key:`p${String(i).padStart(4,"0")}`,catalog_date:"2026-09-08",symbols_json:`["T${i}"]`,fetched_at:"2026-09-09"}));
      for(let offset=0;offset<supportRows.length;offset+=250) await copyStorageRows(source.db,supportTable,supportRows.slice(offset,offset+250));
      const revisions=await source.db.prepare("SELECT * FROM eod_input_revisions ORDER BY feed,ticker").all();
      const clock=await source.db.prepare("SELECT revision FROM eod_input_clock").first();
      await createStorageMigration(ops.db,identity);
      const run1=await claimStorageMigration(ops.db,identity.id);
      const context={source:source.db,target:target.db,history:history.db,ops:ops.db,
        installSourceFence:async (statements:readonly string[]) => {
          for(let offset=0;offset<statements.length;offset+=20) await source.db.batch(statements.slice(offset,offset+20).map((sql) => source.db.prepare(sql)));
        }};
      await runStorageCopy({...context,run:run1!.run,leaseToken:run1!.leaseToken});
      expect((await loadStorageMigration(ops.db,identity.id))?.status).toBe("awaiting-evidence");
      expect(await source.db.prepare("SELECT status FROM market_storage_fence").first("status")).toBe("open");
      const plan=await prepareStorageSourceFence(source.db);
      await authorizeStorageMigrationFreeze(ops.db,identity.id,{sourceDatabaseId:identity.sourceDatabaseId,codeRevision:identity.codeRevision,
        schemaHash:plan.schemaHash,evidenceHash:"b".repeat(64)});
      await resumeStorageMigration(ops.db,identity.id,identity.codeRevision);
      const run2=await claimStorageMigration(ops.db,identity.id);
      await expect(runStorageCopy({...context,run:run2!.run,leaseToken:run2!.leaseToken,deadlineMs:0})).rejects.toThrow("storage-run-time-slice-complete");
      await deferStorageMigration(ops.db,identity.id,run2!.leaseToken,"storage-resume-required",{now:new Date(Date.now()-16*60_000)});
      const resumed=await claimStorageMigration(ops.db,identity.id);
      let archiveBatches=0;
      const interruptedHistory={...history.db,batch:async <T>(statements:D1PreparedStatement[]) => {
        const results=await history.db.batch<T>(statements);
        if(++archiveBatches===3)throw new Error("d1-network-error");
        return results;
      }} as D1Database;
      await expect(runStorageCopy({...context,history:interruptedHistory,run:resumed!.run,leaseToken:resumed!.leaseToken}))
        .rejects.toThrow("d1-network-error");
      expect(await loadStorageMigrationCheckpoint(ops.db,identity.id,"archives")).toBeNull();
      expect(await history.db.prepare("SELECT COUNT(*) AS count FROM market_history_block_pointers").first("count")).toBe(3);
      await deferStorageMigration(ops.db,identity.id,resumed!.leaseToken,"d1-network-error",{now:new Date(Date.now()-16*60_000)});
      const replay=await claimStorageMigration(ops.db,identity.id);
      // Emulate a durable old 100-row checkpoint against this exact capture.
      const oldPage=supportRows.slice(0,100),oldHash=await storageHash([await storageHash([]),canonicalStorageRows(supportTable,oldPage)]);
      const capture=await source.db.prepare("SELECT schema_hash AS schemaHash,snapshot_revision AS revision FROM market_storage_fence WHERE id='default'").first();
      await copyStorageRows(target.db,supportTable,oldPage);
      await saveStorageMigrationCheckpoint(ops.db,identity.id,replay!.leaseToken,{key:`table:${supportTable.name}`,inputHash:await storageHash([identity,capture]),
        payload:{after:storageRowKey(supportTable,oldPage.at(-1)!),rows:100,hash:oldHash,done:false}});
      const realNow=Date.now.bind(Date);let elapsed=0;
      vi.spyOn(Date,"now").mockImplementation(()=>realNow()+elapsed);
      const tableProgress:number[]=[];
      const delayedTarget={...target.db,batch:async<T>(statements:D1PreparedStatement[])=>{
        const result=await target.db.batch<T>(statements);
        if((statements[0] as unknown as {sql:string}).sql.includes('INSERT INTO "overview_provider_catalog_cache"')) elapsed+=31_000;
        return result;
      }} as D1Database;
      await runStorageCopy({...context,target:delayedTarget,run:replay!.run,leaseToken:replay!.leaseToken,
        onCopyProgress:progress=>{if(progress.checkpoint===`table:${supportTable.name}`)tableProgress.push(progress.rows);}});
      vi.restoreAllMocks();
      expect(tableProgress).toEqual([350,600,601]);
      let mixedHash=oldHash;
      for(let offset=100;offset<supportRows.length;offset+=250) mixedHash=await storageHash([mixedHash,canonicalStorageRows(supportTable,supportRows.slice(offset,offset+250))]);
      expect(await loadStorageMigrationCheckpoint(ops.db,identity.id,`table:${supportTable.name}`)).toMatchObject({payload:{rows:601,hash:mixedHash,done:true,after:["p0600","2026-09-08"]}});
      expect(await target.db.prepare("SELECT COUNT(*) AS count FROM overview_provider_catalog_cache").first("count")).toBe(601);
      const state=await loadStorageMigration(ops.db,identity.id);
      expect(state?.status).toBe("awaiting-evidence");expect(state?.error_code).toBe("storage-final-verification-required");
      expect((await source.db.prepare("SELECT COUNT(*) AS count FROM alpaca_daily_bars").first("count"))).toBe(4);
      expect((await target.db.prepare("SELECT COUNT(*) AS count FROM alpaca_daily_bars").first("count"))).toBe(2);
      expect((await target.db.prepare("SELECT * FROM eod_input_revisions ORDER BY feed,ticker").all()).results).toEqual(revisions.results);
      expect(await target.db.prepare("SELECT revision FROM eod_input_clock").first()).toEqual(clock);
      expect(await target.db.prepare("SELECT name FROM d1_migrations").first("name")).toBe("0009_market_storage_fence.sql");
      expect(await target.db.prepare("SELECT status FROM market_storage_fence").first("status")).toBe("open");
      const env={DB:target.db,MARKET_DATA_DB:target.db,MARKET_HISTORY_DB:history.db} as Env;
      expect((await loadMarketHistory(env,{tickers:["TEST"],feed:"sip"})).map((row) => row.date)).toEqual(["2025-12-31","2026-09-08","2026-09-09"]);
      expect(await target.db.prepare("SELECT date FROM alpaca_daily_bars WHERE feed='sip'").first("date")).toBe("2026-09-08");
      await expect(source.db.prepare("UPDATE universes SET name='Lost'").run()).rejects.toThrow("market-storage-source-frozen");
      await assertReviewedStorageSchema(target.db);
      // The stage engine can retain the live lease and atomically queue its
      // successor; the direct/operator copy mode above still pauses by default.
      await resumeStorageMigration(ops.db,identity.id,identity.codeRevision);
      const staged=(await claimStorageMigration(ops.db,identity.id))!;
      expect(await runStorageCopy({...context,run:staged.run,leaseToken:staged.leaseToken,retainLeaseOnComplete:true})).toBe("copy-complete");
      expect((await loadStorageMigration(ops.db,identity.id))?.status).toBe("running");
    } finally {vi.restoreAllMocks();source.dispose();target.dispose();history.dispose();ops.dispose();}
  },180_000);
});
