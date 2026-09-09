import { STORAGE_INDEXES, STORAGE_TABLES, STORAGE_TRIGGERS } from "./market-storage-schema";
import { canonicalStorageRows, copyStorageRows, quoteStorageIdentifier, readStoragePage, storageHash, storageRowKey,
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

/** Unlike an ingestion recheck, relocation preserves the exact frozen hot
 * observation, including timestamps, while retaining archive-only dates. */
export async function copyStorageArchiveBlock(history:D1Database,incoming:MarketHistoryBar[]):Promise<{id:string;rows:number;checksum:string}> {
  const candidate=await encodeMarketHistoryBlock(incoming);
  const old=await history.prepare(`SELECT ${BLOCK_COLUMNS} FROM market_history_block_pointers p
    JOIN market_history_blocks b ON b.id=p.block_id WHERE p.feed=? AND p.ticker=? AND p.calendar_year=?`)
    .bind(candidate.feed,candidate.ticker,candidate.calendarYear).first<MarketHistoryBlock>();
  const merged=new Map<string,MarketHistoryBar>();
  if (old) for (const bar of await decodeMarketHistoryBlock(old)) merged.set(bar.date,bar);
  for (const bar of incoming) merged.set(bar.date,bar);
  const block=await encodeMarketHistoryBlock([...merged.values()]);
  if (old?.id!==block.id) {
    await history.prepare(`INSERT INTO market_history_blocks
      (id,feed,ticker,calendar_year,schema_version,codec,checksum,row_count,first_date,last_date,uncompressed_bytes,payload_base64)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(block.id,block.feed,block.ticker,block.calendarYear,block.schemaVersion,block.codec,block.checksum,
        block.rowCount,block.firstDate,block.lastDate,block.uncompressedBytes,block.payloadBase64).run();
  }
  const stored=await history.prepare(`SELECT ${BLOCK_COLUMNS} FROM market_history_blocks b WHERE b.id=?`).bind(block.id).first<MarketHistoryBlock>();
  if (!stored || stored.checksum!==block.checksum) throw new Error("storage-archive-readback-missing");
  const decoded=await decodeMarketHistoryBlock(stored);
  const actual=new Map(decoded.map((bar) => [bar.date,bar]));
  if (decoded.length!==merged.size || [...merged.values()].some((bar) => !actual.has(bar.date) || !marketHistoryBarsEqual(bar,actual.get(bar.date)!))) {
    throw new Error("storage-archive-readback-mismatch");
  }
  if (old?.id!==block.id) {
    const now=new Date().toISOString();
    const result=await history.batch([
      history.prepare("UPDATE market_history_blocks SET verified_at=? WHERE id=? AND checksum=?").bind(now,block.id,block.checksum),
      history.prepare(`INSERT INTO market_history_block_pointers(feed,ticker,calendar_year,block_id,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(feed,ticker,calendar_year) DO UPDATE SET
        previous_block_id=market_history_block_pointers.block_id,block_id=excluded.block_id,updated_at=excluded.updated_at
        WHERE market_history_block_pointers.block_id=?`).bind(block.feed,block.ticker,block.calendarYear,block.id,now,old?.id ?? null),
    ]);
    if (result[1].meta.changes!==1) throw new Error("storage-archive-concurrent-change");
  }
  const active=await history.prepare("SELECT block_id FROM market_history_block_pointers WHERE feed=? AND ticker=? AND calendar_year=?")
    .bind(block.feed,block.ticker,block.calendarYear).first<string>("block_id");
  if (active!==block.id) throw new Error("storage-archive-concurrent-change");
  // No source deletion and no removal of preexisting archive revisions.
  return {id:block.id,rows:block.rowCount,checksum:block.checksum};
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
type CopyContext={source:D1Database;target:D1Database;history:D1Database;ops:D1Database;run:StorageMigrationRun;leaseToken:string;
  /** Complete fixed DDL is sent through the reviewed adapter allowlist. */
  installSourceFence:(statements:readonly string[]) => Promise<void>;deadlineMs?:number};

/** Resumable copy only. Public bindings, publication ownership and source
 * deletion are deliberately separate deployment actions requiring evidence. */
export async function runStorageCopy(context:CopyContext):Promise<"awaiting-evidence"> {
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
  let pendingArchiveBlocks=0;
  while (!archive.done) {
    await check();
    const first=(await readStoragePage(source,bars,archive.after,1))[0];
    if (!first) {archive.done=true;await checkpoint("archives",archive);break;}
    const year=String(first.date).slice(0,4);
    const page=await source.prepare(`SELECT ${bars.columns.map(quoteStorageIdentifier).join(",")} FROM alpaca_daily_bars
      WHERE feed=? AND ticker=? AND date>=? AND date<=? ORDER BY date LIMIT 367`)
      .bind(first.feed,first.ticker,`${year}-01-01`,`${year}-12-31`).all<StorageRow>();
    if (!page.results.length || page.results.length>366) throw new Error("storage-year-observations-invalid");
    const result=await copyStorageArchiveBlock(history,page.results.map(storageBar));
    const last=page.results.at(-1)!,after=storageRowKey(bars,last);
    const next=(await readStoragePage(source,bars,after,1))[0];
    let latestSeed=page.results.filter((row) => String(row.date)<=run.session_date).at(-1) ?? archive.latestSeed ?? null;
    if (!next || next.feed!==last.feed || next.ticker!==last.ticker) {
      if (latestSeed) await copyStorageRows(target,bars,[latestSeed]);
      latestSeed=null;
    }
    archive={after,latestSeed,rows:archive.rows+page.results.length,
      hash:await storageHash([archive.hash,result.id,canonicalStorageRows(bars,page.results)]),done:!next};
    pendingArchiveBlocks++;
    if (archive.done || pendingArchiveBlocks>=10) {
      await checkpoint("archives",archive);pendingArchiveBlocks=0;
      await progressStorageMigration(ops,run.id,leaseToken,"archives",{rows:archive.rows,lastFeed:last.feed,lastTicker:last.ticker,lastYear:year});
    }
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
  }
  // Installing business triggers last preserves the exact copied revision
  // clock/catalog relationship. No seed INSERT can invalidate frozen evidence.
  await target.batch(STORAGE_BUSINESS_DDL.map((sql) => target.prepare(sql)));
  await assertReviewedStorageSchema(target);
  await assertStorageSourceFrozen(source,identity,plan.schemaHash);
  await checkpoint("copy-complete",{archivedRows:archive.rows,archiveHash:archive.hash});
  await pauseStorageMigration(ops,run.id,leaseToken,"storage-final-verification-required",{
    copied:true,archivedRows:archive.rows,sourceFrozen:true,sourcePreserved:true,
    remaining:["whole-target-verification","full-universe-capacity","consumer-parity","binding-cutover"],
  });
  return "awaiting-evidence";
}
