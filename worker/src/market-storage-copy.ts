import { STORAGE_INDEXES, STORAGE_TABLES, STORAGE_TRIGGERS } from "./market-storage-schema";
import { canonicalStorageRows, copyStorageRows, createStoragePriceYearReader, readStoragePage, storageHash, storageRowKey,
  storageTable, type StorageCell, type StorageRow } from "./market-storage-pages";
import { decodeMarketHistoryBlock, encodeMarketHistoryBlock, marketHistoryBarsEqual, type MarketHistoryBar, type MarketHistoryBlock } from "./market-history";
import { assertStorageSourceFrozen, assertStorageTargetEmpty, freezeStorageSource, prepareStorageSourceFence } from "./market-storage-fence";
import { heartbeatStorageMigration, loadStorageMigrationCheckpoint, pauseStorageMigration, progressStorageMigration,
  recordStorageSourceCapture, saveStorageMigrationCheckpoint, storageMigrationIdentity, type StorageMigrationRun } from "./market-storage-control";

const DDL_LABEL=" /* storage-reviewed-ddl */";
const MIGRATION_LEDGER={name:"d1_migrations",columns:["id","name","applied_at"],key:["id"],
  sql:"CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)"};
const TARGET_FENCE_SQL=`CREATE TABLE IF NOT EXISTS market_storage_fence (
  id TEXT PRIMARY KEY CHECK(id='default'),status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','frozen')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),migration_id TEXT,code_revision TEXT,schema_hash TEXT,
  snapshot_revision INTEGER,frozen_at TEXT,released_at TEXT) STRICT, WITHOUT ROWID`;
export const STORAGE_TARGET_DDL:readonly string[]=[
  MIGRATION_LEDGER.sql+DDL_LABEL,TARGET_FENCE_SQL+DDL_LABEL,
  ...STORAGE_TABLES.map((table) => table.sql.replace(/^CREATE TABLE /,"CREATE TABLE IF NOT EXISTS ")+DDL_LABEL),
  ...STORAGE_INDEXES.map((index) => index.sql.replace(/^CREATE INDEX /,"CREATE INDEX IF NOT EXISTS ")+DDL_LABEL),
];
export const STORAGE_BUSINESS_DDL:readonly string[]=STORAGE_TRIGGERS.map((trigger) =>
  trigger.sql.replace(/^CREATE TRIGGER /,"CREATE TRIGGER IF NOT EXISTS ")+DDL_LABEL);
const BLOCK_COLUMNS=`b.id,b.feed,b.ticker,b.calendar_year AS calendarYear,b.schema_version AS schemaVersion,b.codec,
  b.checksum,b.row_count AS rowCount,b.first_date AS firstDate,b.last_date AS lastDate,b.uncompressed_bytes AS uncompressedBytes,
  b.payload_base64 AS payloadBase64,b.verified_at AS verifiedAt`;

export const STORAGE_ARCHIVE_BATCH_BLOCKS = 16;
type ArchiveCopyResult = {id:string;rows:number;checksum:string};

/** Unlike an ingestion recheck, relocation preserves the exact frozen hot
 * observation, including timestamps, while retaining archive-only dates.
 * Independent security/year blocks share transport round trips, not identity
 * or validation: every immutable block is read back and every pointer uses CAS.
 * A partial promotion leaves no cursor advanced; replay revalidates all blocks. */
export async function copyStorageArchiveBlocks(history:D1Database,incoming:MarketHistoryBar[][]):Promise<ArchiveCopyResult[]> {
  if (!incoming.length || incoming.length>STORAGE_ARCHIVE_BATCH_BLOCKS
    || incoming.some((bars) => !bars.length || bars.length>366)) throw new Error("storage-archive-invalid-batch");
  const candidates=[];
  for (const bars of incoming) candidates.push(await encodeMarketHistoryBlock(bars));
  const keys=candidates.map((block) => JSON.stringify([block.feed,block.ticker,block.calendarYear]));
  if (new Set(keys).size!==keys.length) throw new Error("storage-archive-duplicate-year");
  const oldRows=await history.batch<MarketHistoryBlock>(candidates.map((candidate) => history.prepare(
    `SELECT ${BLOCK_COLUMNS} FROM market_history_block_pointers p
      JOIN market_history_blocks b ON b.id=p.block_id WHERE p.feed=? AND p.ticker=? AND p.calendar_year=? /* storage-archive-point-read */`)
    .bind(candidate.feed,candidate.ticker,candidate.calendarYear)));
  const prepared=[];
  for (let index=0;index<candidates.length;index++) {
    const old=oldRows[index].results[0],candidate=candidates[index];
    if (old && (old.feed!==candidate.feed || old.ticker!==candidate.ticker || old.calendarYear!==candidate.calendarYear)) {
      throw new Error("storage-archive-pointer-identity-mismatch");
    }
    const merged=new Map<string,MarketHistoryBar>();
    if (old) for (const bar of await decodeMarketHistoryBlock(old)) merged.set(bar.date,bar);
    for (const bar of incoming[index]) merged.set(bar.date,bar);
    const block=old ? await encodeMarketHistoryBlock([...merged.values()]) : candidate;
    prepared.push({old,merged,block});
  }
  // The REST envelope includes escaped payload JSON. Split before reaching its
  // 8 MB transport ceiling, retaining the single-value 2 MB adapter check.
  const payloadBytes=prepared.reduce((sum,{block}) => sum+new TextEncoder().encode(JSON.stringify(block)).length,0);
  if (payloadBytes>4_000_000) {
    if (incoming.length===1) throw new Error("storage-archive-block-exceeds-batch-limit");
    const middle=Math.floor(incoming.length/2);
    return [...await copyStorageArchiveBlocks(history,incoming.slice(0,middle)),
      ...await copyStorageArchiveBlocks(history,incoming.slice(middle))];
  }
  const writes:D1PreparedStatement[]=[],readIndexes:number[]=[];
  for (const {old,block} of prepared) {
    if (old?.id!==block.id) writes.push(history.prepare(`INSERT INTO market_history_blocks
      (id,feed,ticker,calendar_year,schema_version,codec,checksum,row_count,first_date,last_date,uncompressed_bytes,payload_base64)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(block.id,block.feed,block.ticker,block.calendarYear,block.schemaVersion,block.codec,block.checksum,
        block.rowCount,block.firstDate,block.lastDate,block.uncompressedBytes,block.payloadBase64));
    readIndexes.push(writes.length);
    writes.push(history.prepare(`SELECT ${BLOCK_COLUMNS} FROM market_history_blocks b WHERE b.id=? /* storage-archive-point-read */`).bind(block.id));
  }
  const storedRows=await history.batch<MarketHistoryBlock>(writes);
  for (let index=0;index<prepared.length;index++) {
    const {block,merged}=prepared[index],stored=storedRows[readIndexes[index]].results[0];
    if (!stored || stored.checksum!==block.checksum) throw new Error("storage-archive-readback-missing");
    const decoded=await decodeMarketHistoryBlock(stored),actual=new Map(decoded.map((bar) => [bar.date,bar]));
    if (decoded.length!==merged.size || [...merged.values()].some((bar) => !actual.has(bar.date)
      || !marketHistoryBarsEqual(bar,actual.get(bar.date)!))) throw new Error("storage-archive-readback-mismatch");
  }
  const changed=prepared.filter(({old,block}) => old?.id!==block.id);
  if (changed.length) {
    const now=new Date().toISOString();
    const promoted=await history.batch<{block_id:string}>(changed.flatMap(({old,block}) => [
      history.prepare("UPDATE market_history_blocks SET verified_at=? WHERE id=? AND checksum=?").bind(now,block.id,block.checksum),
      history.prepare(`INSERT INTO market_history_block_pointers(feed,ticker,calendar_year,block_id,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(feed,ticker,calendar_year) DO UPDATE SET
        previous_block_id=market_history_block_pointers.block_id,block_id=excluded.block_id,updated_at=excluded.updated_at
        WHERE market_history_block_pointers.block_id=? RETURNING block_id`).bind(block.feed,block.ticker,block.calendarYear,block.id,now,old?.id ?? null),
    ]));
    // D1 changes includes guard writes even on a rejected UPSERT; RETURNING is
    // the ownership proof. No checkpoint may advance after a lost comparison.
    if (changed.some(({block},index) => promoted[index*2+1].results.length!==1
      || promoted[index*2+1].results[0].block_id!==block.id)) throw new Error("storage-archive-concurrent-change");
  }
  const active=await history.batch<{block_id:string}>(prepared.map(({block}) => history.prepare(
    "SELECT block_id FROM market_history_block_pointers WHERE feed=? AND ticker=? AND calendar_year=? /* storage-archive-point-read */")
    .bind(block.feed,block.ticker,block.calendarYear)));
  if (prepared.some(({block},index) => active[index].results[0]?.block_id!==block.id)) throw new Error("storage-archive-concurrent-change");
  return prepared.map(({block}) => ({id:block.id,rows:block.rowCount,checksum:block.checksum}));
}

export async function copyStorageArchiveBlock(history:D1Database,incoming:MarketHistoryBar[]):Promise<ArchiveCopyResult> {
  return (await copyStorageArchiveBlocks(history,[incoming]))[0];
}
export function storageBar(row:StorageRow):MarketHistoryBar {
  return {feed:String(row.feed),ticker:String(row.ticker),date:String(row.date),o:Number(row.o),h:Number(row.h),l:Number(row.l),c:Number(row.c),
    volume:row.volume===null ? null : Number(row.volume),reportedVolume:row.reported_volume===null ? null : Number(row.reported_volume),
    reportedVolumeCollectedAt:row.reported_volume_collected_at as string|null,sourceProvider:String(row.source_provider),adjustment:String(row.adjustment),
    observedAt:row.observed_at as string|null,fetchedAt:row.fetched_at as string|null};
}
const normalizeSql=(sql:string) => sql.replace(/\bIF NOT EXISTS\b/gi,"").replace(/\/\* storage-reviewed-ddl \*\//g,"").replace(/\s+/g," ").trim().replace(/;$/,"");
/** Pin schema to a reviewed manifest. Never execute arbitrary schema returned
 * from a remote database, including a new trigger added after review. */
export async function assertReviewedStorageSchema(db:D1Database,options:{allowMissingTriggers?:boolean}={}):Promise<void> {
  const actual=await db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all<{type:string;name:string;sql:string}>();
  const expected=new Map<string,string>([...STORAGE_TABLES,...STORAGE_INDEXES,...STORAGE_TRIGGERS].map((row) => [row.name,normalizeSql(row.sql)]));
  const seen=new Set<string>();
  for (const row of actual.results) {
    if (row.name.startsWith("sqlite_") || row.name.startsWith("_cf_") || row.name==="d1_migrations"
      || row.name==="market_storage_fence" || row.name.startsWith("market_storage_guard_")) continue;
    if (!expected.has(row.name) || expected.get(row.name)!==normalizeSql(row.sql)) throw new Error("storage-schema-not-reviewed");
    seen.add(row.name);
  }
  for (const row of [...STORAGE_TABLES,...STORAGE_INDEXES,...(options.allowMissingTriggers ? [] : STORAGE_TRIGGERS)]) {
    if (!seen.has(row.name)) throw new Error("storage-schema-incomplete");
  }
}
type Cursor={after:StorageCell[]|null;rows:number;hash:string;done:boolean;latestSeed?:StorageRow|null};
export type StorageCopyProgress={stage:"archives"|"tables";checkpoint:string;rows:number;archivedRows:number;elapsedMs:number};
type CopyContext={source:D1Database;target:D1Database;history:D1Database;ops:D1Database;run:StorageMigrationRun;leaseToken:string;
  /** Complete fixed DDL is sent through the reviewed adapter allowlist. */
  installSourceFence:(statements:readonly string[]) => Promise<void>;deadlineMs?:number;
  /** The stage orchestrator atomically releases ownership into its next queue. */
  retainLeaseOnComplete?:boolean;
  onCopyProgress?:(progress:StorageCopyProgress)=>void};

/** Resumable copy only. Public bindings, publication ownership and source
 * deletion are deliberately separate deployment actions requiring evidence. */
export async function runStorageCopy(context:CopyContext):Promise<"awaiting-evidence"|"copy-complete"> {
  const {source,target,history,ops,run,leaseToken}=context,identity=storageMigrationIdentity(run);
  const started=Date.now(),deadline=context.deadlineMs ?? 65*60_000;
  let lastHeartbeat=0;
  const check=async () => {
    if (Date.now()-started>=deadline) throw new Error("storage-run-time-slice-complete");
    if (Date.now()-lastHeartbeat>=45_000) {
      await heartbeatStorageMigration(ops,run.id,leaseToken);lastHeartbeat=Date.now();
    }
  };
  await assertReviewedStorageSchema(source);
  const plan=await prepareStorageSourceFence(source);
  if (run.freeze_authorized!==1 || !run.freeze_evidence_hash || run.source_schema_hash!==plan.schemaHash) {
    await pauseStorageMigration(ops,run.id,leaseToken,"storage-capacity-preflight-required",{schemaHash:plan.schemaHash,sourceFrozen:false});
    return "awaiting-evidence";
  }
  await progressStorageMigration(ops,run.id,leaseToken,"source-fence",{sourceFrozen:run.source_revision!==null});
  const sourceDdl=plan.statements.map((statement) => statement.sql+DDL_LABEL);
  await context.installSourceFence(sourceDdl);
  const capture=await freezeStorageSource(source,identity,plan.schemaHash);
  await recordStorageSourceCapture(ops,run.id,leaseToken,capture);
  const inputHash=await storageHash([identity,capture]);
  const checkpoint=async (key:string,payload:unknown) => saveStorageMigrationCheckpoint(ops,run.id,leaseToken,{key,inputHash,payload});
  const restore=async <T>(key:string):Promise<T|null> => {
    const stored=await loadStorageMigrationCheckpoint(ops,run.id,key);
    if (!stored) return null;
    if (stored.inputHash!==inputHash) throw new Error("storage-checkpoint-capture-mismatch");
    return stored.payload as T;
  };
  if (!await restore("target-schema")) {
    await progressStorageMigration(ops,run.id,leaseToken,"target-schema",{sourceFrozen:true});
    // Only idempotent empty-schema initialization is replayed after interruption.
    for (let offset=0;offset<STORAGE_TARGET_DDL.length;offset+=20) {
      await target.batch(STORAGE_TARGET_DDL.slice(offset,offset+20).map((sql) => target.prepare(sql)));
    }
    await assertReviewedStorageSchema(target,{allowMissingTriggers:true});
    const prematureTriggers=await target.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' LIMIT 1").first();
    if (prematureTriggers) throw new Error("storage-target-triggers-before-copy");
    await assertStorageTargetEmpty(target,STORAGE_TABLES.map((table) => table.name));
    if (await target.prepare("SELECT 1 FROM d1_migrations LIMIT 1").first()) throw new Error("storage-target-migration-ledger-not-empty");
    await target.prepare("INSERT INTO market_storage_fence(id) VALUES('default') ON CONFLICT(id) DO NOTHING").run();
    await checkpoint("target-schema",{initialized:true});
  }
  const bars=storageTable("alpaca_daily_bars");
  let archive=await restore<Cursor>("archives") ?? {after:null,rows:0,hash:await storageHash([]),done:false};
  if (archive.rows>0) context.onCopyProgress?.({stage:"archives",checkpoint:"archives",rows:archive.rows,
    archivedRows:archive.rows,elapsedMs:Date.now()-started});
  const readYears=createStoragePriceYearReader(source,archive.after);
  while (!archive.done) {
    await check();
    const {groups:pages,next}=await readYears(STORAGE_ARCHIVE_BATCH_BLOCKS);
    if (!pages.length) {archive.done=true;await checkpoint("archives",archive);break;}
    const seeds:StorageRow[]=[];
    let latestSeed=archive.latestSeed ?? null;
    for(let index=0;index<pages.length;index++) {
      const rows=pages[index],last=rows.at(-1)!,following=pages[index+1]?.[0] ?? next;
      latestSeed=rows.filter((row) => String(row.date)<=run.session_date).at(-1) ?? latestSeed;
      if (!following || following.feed!==last.feed || following.ticker!==last.ticker) {
        if (latestSeed) seeds.push(latestSeed);
        latestSeed=null;
      }
    }
    await check();
    const results=await copyStorageArchiveBlocks(history,pages.map((rows) => rows.map(storageBar)));
    await copyStorageRows(target,bars,seeds);
    // Preserve the original ordered hash chain, including resumes from the old
    // ten-block checkpoints. Only transport grouping and flush frequency change.
    for (let index=0;index<pages.length;index++) archive={...archive,rows:archive.rows+pages[index].length,
      hash:await storageHash([archive.hash,results[index].id,canonicalStorageRows(bars,pages[index])])};
    const last=pages.at(-1)!.at(-1)!;
    archive={...archive,after:storageRowKey(bars,last),latestSeed,done:!next};
    await checkpoint("archives",archive);
    await progressStorageMigration(ops,run.id,leaseToken,"archives",{rows:archive.rows,lastFeed:last.feed,lastTicker:last.ticker,lastYear:String(last.date).slice(0,4)});
    context.onCopyProgress?.({stage:"archives",checkpoint:"archives",rows:archive.rows,archivedRows:archive.rows,elapsedMs:Date.now()-started});
  }
  for (const table of [...STORAGE_TABLES.filter((table) => table.name!==bars.name),MIGRATION_LEDGER]) {
    let cursor=await restore<Cursor>(`table:${table.name}`) ?? {after:null,rows:0,hash:await storageHash([]),done:false};
    while (!cursor.done) {
      await check();
      const rows=await readStoragePage(source,table,cursor.after,100);
      await copyStorageRows(target,table,rows);
      cursor={after:rows.length ? storageRowKey(table,rows.at(-1)!) : cursor.after,rows:cursor.rows+rows.length,
        hash:await storageHash([cursor.hash,canonicalStorageRows(table,rows)]),done:rows.length<100};
      await checkpoint(`table:${table.name}`,cursor);
    }
    await progressStorageMigration(ops,run.id,leaseToken,"tables",{table:table.name,rows:cursor.rows,archivedRows:archive.rows});
    context.onCopyProgress?.({stage:"tables",checkpoint:`table:${table.name}`,rows:cursor.rows,archivedRows:archive.rows,elapsedMs:Date.now()-started});
  }
  // Installing business triggers last preserves the exact copied revision
  // clock/catalog relationship. No seed INSERT can invalidate frozen evidence.
  await target.batch(STORAGE_BUSINESS_DDL.map((sql) => target.prepare(sql)));
  await assertReviewedStorageSchema(target);
  await assertStorageSourceFrozen(source,identity,plan.schemaHash);
  await checkpoint("copy-complete",{archivedRows:archive.rows,archiveHash:archive.hash});
  const completion={
    copied:true,archivedRows:archive.rows,sourceFrozen:true,sourcePreserved:true,
    remaining:["whole-target-verification","full-universe-capacity","consumer-parity","binding-cutover"],
  };
  if (context.retainLeaseOnComplete) await progressStorageMigration(ops,run.id,leaseToken,"copy-complete",completion);
  else await pauseStorageMigration(ops,run.id,leaseToken,"storage-final-verification-required",completion);
  return context.retainLeaseOnComplete ? "copy-complete" : "awaiting-evidence";
}
