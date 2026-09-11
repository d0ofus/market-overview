import { assertReviewedStorageSchema, storageBar } from "./market-storage-copy";
import { STORAGE_TABLES } from "./market-storage-schema";
import { canonicalStorageRows, createStoragePriceYearReader, quoteStorageIdentifier, readStoragePage, storageHash, storageRowKey, STORAGE_TABLE_PAGE_ROWS,
  storageTable, type StorageCell, type StorageRow, type StorageTable } from "./market-storage-pages";
import { assertStorageSourceFrozen, freezeStorageSource, prepareStorageSourceFence } from "./market-storage-fence";
import { heartbeatStorageMigration, loadStorageMigrationCheckpoint, progressStorageMigration,
  saveStorageMigrationCheckpoint, storageMigrationIdentity, type StorageMigrationIdentity, type StorageMigrationRun } from "./market-storage-control";
import { decodeMarketHistoryBlock, marketHistoryBarsEqual, type MarketHistoryBar, type MarketHistoryBlock } from "./market-history";

export type StorageVerificationCapture = {schemaHash:string;revision:number};
export type StorageVerificationEvidence = {
  schemaVersion:1;verified:true;identity:StorageMigrationIdentity;captureHash:string;
  sourceCapture:StorageVerificationCapture;targetCapture:StorageVerificationCapture;historyCapture:StorageVerificationCapture;
  tables:Array<{name:string;rows:number;hash:string}>;
  prices:{sourceRows:number;hotRows:number;hash:string};
  archive:{pointerRows:number;blockRows:number;hash:string;baselinePointerRows:number;baselineBlockRows:number;baselineHash:string};
  verifiedAt:string;remainingLiveGates:string[];
};
type Installer = (statements:readonly string[]) => Promise<void>;
type Context = {ops:D1Database;run:StorageMigrationRun;leaseToken:string;deadlineMs?:number};
type Cursor = {after:StorageCell[]|null;rows:number;hash:string;done:boolean;pages:number};
type Pointer = StorageRow & {feed:string;ticker:string;calendar_year:number;block_id:string;previous_block_id:string|null};
type Baseline = {
  schemaVersion:1;identity:StorageMigrationIdentity;capture:StorageVerificationCapture;captureHash:string;
  blockRows:number;blockPages:number;pointerRows:number;pointerPages:number;hash:string;
};
const DDL_LABEL = " /* storage-reviewed-ddl */";
const LEDGER:StorageTable = {name:"d1_migrations",columns:["id","name","applied_at"],key:["id"],sql:""};
const POINTERS:StorageTable = {name:"market_history_block_pointers",columns:["feed","ticker","calendar_year","block_id","previous_block_id","updated_at"],
  key:["feed","ticker","calendar_year"],sql:`CREATE TABLE market_history_block_pointers (
    feed TEXT NOT NULL,ticker TEXT NOT NULL,calendar_year INTEGER NOT NULL,
    block_id TEXT NOT NULL REFERENCES market_history_blocks(id),previous_block_id TEXT REFERENCES market_history_blocks(id),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY (feed,ticker,calendar_year)) STRICT, WITHOUT ROWID`};
const BLOCKS:StorageTable = {name:"market_history_blocks",columns:["id","feed","ticker","calendar_year","schema_version","codec","checksum","row_count",
  "first_date","last_date","uncompressed_bytes","created_at"],key:["id"],sql:`CREATE TABLE market_history_blocks (
    id TEXT PRIMARY KEY,feed TEXT NOT NULL,ticker TEXT NOT NULL,calendar_year INTEGER NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),codec TEXT NOT NULL CHECK (codec = 'gzip-json-v1'),
    checksum TEXT NOT NULL,row_count INTEGER NOT NULL CHECK (row_count > 0),first_date TEXT NOT NULL,last_date TEXT NOT NULL,
    uncompressed_bytes INTEGER NOT NULL CHECK (uncompressed_bytes > 0),payload_base64 TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,verified_at TEXT) STRICT, WITHOUT ROWID`};
const BLOCK_COLUMNS = `b.id,b.feed,b.ticker,b.calendar_year AS calendarYear,b.schema_version AS schemaVersion,b.codec,
  b.checksum,b.row_count AS rowCount,b.first_date AS firstDate,b.last_date AS lastDate,b.uncompressed_bytes AS uncompressedBytes,
  b.payload_base64 AS payloadBase64,b.verified_at AS verifiedAt`;
const normalizeSql = (sql:string) => sql.replace(/\bIF NOT EXISTS\b/gi,"").replace(/\s+/g,"").replace(/;$/,"");

/** History schema is code reviewed too: callbacks cannot accept extra remote
 * tables/triggers and thereby install arbitrary trigger bodies as approved DDL. */
export async function assertReviewedStorageHistorySchema(history:D1Database):Promise<void> {
  const expected = new Map([
    [BLOCKS.name,normalizeSql(BLOCKS.sql)],[POINTERS.name,normalizeSql(POINTERS.sql)],
    ["idx_market_history_blocks_security_year",normalizeSql("CREATE INDEX idx_market_history_blocks_security_year ON market_history_blocks (feed,ticker,calendar_year)")],
  ]);
  const rows=await history.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all<{name:string;sql:string}>();
  for (const row of rows.results) {
    if (row.name.startsWith("sqlite_") || row.name.startsWith("_cf_") || row.name.startsWith("market_storage_guard_")
      || row.name==="market_storage_fence" || row.name==="d1_migrations") continue;
    if (expected.get(row.name)!==normalizeSql(row.sql)) throw new Error("storage-history-schema-not-reviewed");
    expected.delete(row.name);
  }
  if (expected.size) throw new Error("storage-history-schema-incomplete");
}

/** Read-only checks are deliberately reusable by later consumer/cutover gates. */
export async function assertStorageVerificationCapture(db:D1Database,identity:StorageMigrationIdentity,capture:StorageVerificationCapture):Promise<void> {
  const actual=await assertStorageSourceFrozen(db,identity,capture.schemaHash);
  if (actual.revision!==capture.revision) throw new Error("storage-verification-capture-changed");
}

/** Guards keep counting revisions after this release. This is a transition to
 * controlled copy/bootstrap, not source rollback or an assertion of cutover. */
export async function releaseStorageVerificationFence(db:D1Database,identity:StorageMigrationIdentity,capture:StorageVerificationCapture):Promise<void> {
  const existing=await db.prepare(`SELECT status,revision,migration_id,code_revision,schema_hash,snapshot_revision,released_at
    FROM market_storage_fence WHERE id='default'`).first<StorageRow>();
  if (existing?.status==="open" && existing.migration_id===identity.id && existing.code_revision===identity.codeRevision
    && existing.schema_hash===capture.schemaHash && existing.snapshot_revision===capture.revision && existing.released_at===null
    && Number(existing.revision)>=capture.revision) {
    const plan=await prepareStorageSourceFence(db);
    if (plan.schemaHash!==capture.schemaHash) throw new Error("storage-verification-release-schema-changed");
    const guards=await db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name LIKE 'market_storage_guard_%'")
      .all<{sql:string}>();
    const expected=new Set(plan.statements.map((statement) => normalizeSql(statement.sql)));
    if (guards.results.length!==expected.size || guards.results.some((guard) => !expected.has(normalizeSql(guard.sql)))) {
      throw new Error("storage-verification-release-tracking-incomplete");
    }
    return;
  }
  await assertStorageVerificationCapture(db,identity,capture);
  const result=await db.prepare(`UPDATE market_storage_fence SET status='open',released_at=NULL
    WHERE id='default' AND status='frozen' AND migration_id=? AND code_revision=? AND schema_hash=? AND revision=? AND snapshot_revision=?`)
    .bind(identity.id,identity.codeRevision,capture.schemaHash,capture.revision,capture.revision).run();
  if (result.meta.changes!==1) throw new Error("storage-verification-release-conflict");
}

export async function freezeStorageVerificationTarget(db:D1Database,identity:StorageMigrationIdentity,install:Installer,
  kind:"market"|"history"):Promise<StorageVerificationCapture> {
  if (kind==="market") await assertReviewedStorageSchema(db); else await assertReviewedStorageHistorySchema(db);
  const plan=await prepareStorageSourceFence(db);
  await install(plan.statements.map((statement) => statement.sql+DDL_LABEL));
  return freezeStorageSource(db,identity,plan.schemaHash);
}

function runtime(context:Context) {
  const started=Date.now();let heartbeat=0;
  return async () => {
    if (Date.now()-started>=(context.deadlineMs ?? 65*60_000)) throw new Error("storage-verification-time-slice-complete");
    if (Date.now()-heartbeat>=45_000) {
      await heartbeatStorageMigration(context.ops,context.run.id,context.leaseToken);heartbeat=Date.now();
    }
  };
}
function checkpoints(context:Context,inputHash:string) {
  return {
    save:(key:string,payload:unknown) => saveStorageMigrationCheckpoint(context.ops,context.run.id,context.leaseToken,{key,inputHash,payload}),
    async load<T>(key:string):Promise<T|null> {
      const value=await loadStorageMigrationCheckpoint(context.ops,context.run.id,key);
      if (!value) return null;
      if (value.inputHash!==inputHash) throw new Error("storage-verification-checkpoint-capture-mismatch");
      return value.payload as T;
    },
  };
}
async function emptyCursor():Promise<Cursor> {return {after:null,rows:0,hash:await storageHash([]),done:false,pages:0};}
async function advance(table:StorageTable,cursor:Cursor,rows:StorageRow[],limit:number):Promise<Cursor> {
  return {after:rows.length ? storageRowKey(table,rows.at(-1)!) : cursor.after,rows:cursor.rows+rows.length,
    hash:await storageHash([cursor.hash,canonicalStorageRows(table,rows)]),done:rows.length<limit,pages:cursor.pages+1};
}
async function loadBlock(history:D1Database,id:string,active=false):Promise<{block:MarketHistoryBlock;bars:MarketHistoryBar[]}> {
  const block=await history.prepare(`SELECT ${BLOCK_COLUMNS} FROM market_history_blocks b WHERE b.id=? /* storage-archive-point-read */`).bind(id).first<MarketHistoryBlock>();
  if (!block || (active && !block.verifiedAt)) throw new Error("storage-verification-archive-block-missing-or-unverified");
  return {block,bars:await decodeMarketHistoryBlock(block)};
}
async function loadPointer(history:D1Database,feed:StorageCell,ticker:StorageCell,year:StorageCell):Promise<Pointer> {
  const pointer=await history.prepare(`SELECT feed,ticker,calendar_year,block_id,previous_block_id,updated_at FROM market_history_block_pointers
    WHERE feed=? AND ticker=? AND calendar_year=? /* storage-archive-point-read */`).bind(feed,ticker,year).first<Pointer>();
  if (!pointer) throw new Error("storage-verification-archive-pointer-missing");
  return pointer;
}
async function activeBlock(history:D1Database,pointer:Pointer):Promise<{block:MarketHistoryBlock;bars:MarketHistoryBar[]}> {
  const current=await loadBlock(history,pointer.block_id,true);
  if (current.block.feed!==pointer.feed || current.block.ticker!==pointer.ticker || current.block.calendarYear!==pointer.calendar_year) {
    throw new Error("storage-verification-archive-pointer-identity-mismatch");
  }
  if (pointer.previous_block_id) {
    const previous=await loadBlock(history,pointer.previous_block_id);
    if (previous.block.feed!==pointer.feed || previous.block.ticker!==pointer.ticker || previous.block.calendarYear!==pointer.calendar_year) {
      throw new Error("storage-verification-previous-pointer-identity-mismatch");
    }
  }
  return current;
}
async function loadBlocks(history:D1Database,ids:readonly string[]):Promise<Map<string,{block:MarketHistoryBlock;bars:MarketHistoryBar[]}>> {
  const unique=[...new Set(ids)],loaded=new Map<string,{block:MarketHistoryBlock;bars:MarketHistoryBar[]}>();
  for(let offset=0;offset<unique.length;offset+=8) {
    const selected=unique.slice(offset,offset+8);
    const results=await history.batch<MarketHistoryBlock>(selected.map((id)=>history.prepare(
      `SELECT ${BLOCK_COLUMNS} FROM market_history_blocks b WHERE b.id=? /* storage-archive-point-read */`).bind(id)));
    for(let index=0;index<selected.length;index++) {
      const block=results[index].results[0];
      if(!block || block.id!==selected[index])throw new Error("storage-verification-archive-block-missing-or-unverified");
      loaded.set(block.id,{block,bars:await decodeMarketHistoryBlock(block)});
    }
  }
  return loaded;
}
async function activeBlocks(history:D1Database,pointers:Pointer[]):Promise<Array<{block:MarketHistoryBlock;bars:MarketHistoryBar[]}>> {
  if(pointers.length>8)throw new Error("storage-verification-archive-batch-too-large");
  const loaded=await loadBlocks(history,pointers.flatMap((pointer)=>pointer.previous_block_id
    ? [pointer.block_id,pointer.previous_block_id] : [pointer.block_id]));
  return pointers.map((pointer)=>{
    const current=loaded.get(pointer.block_id)!;
    if(!current.block.verifiedAt)throw new Error("storage-verification-archive-block-missing-or-unverified");
    if(current.block.feed!==pointer.feed || current.block.ticker!==pointer.ticker || current.block.calendarYear!==pointer.calendar_year) {
      throw new Error("storage-verification-archive-pointer-identity-mismatch");
    }
    const previous=pointer.previous_block_id ? loaded.get(pointer.previous_block_id)!.block : null;
    if(previous && (previous.feed!==pointer.feed || previous.ticker!==pointer.ticker || previous.calendarYear!==pointer.calendar_year)) {
      throw new Error("storage-verification-previous-pointer-identity-mismatch");
    }
    return current;
  });
}
async function verifyArchivePage(history:D1Database,table:StorageTable,rows:StorageRow[],check:()=>Promise<void>):Promise<void> {
  for(let offset=0;offset<rows.length;offset+=8) {
    await check();
    const selected=rows.slice(offset,offset+8);
    if(table===BLOCKS)await loadBlocks(history,selected.map((row)=>String(row.id)));
    else await activeBlocks(history,selected as Pointer[]);
  }
}
async function sourceYear(source:D1Database,feed:StorageCell,ticker:StorageCell,year:StorageCell):Promise<StorageRow[]> {
  const table=storageTable("alpaca_daily_bars");
  const rows=await source.prepare(`SELECT ${table.columns.map(quoteStorageIdentifier).join(",")} FROM alpaca_daily_bars
    WHERE feed=? AND ticker=? AND date>=? AND date<=? ORDER BY date LIMIT 367 /* storage-verification-year */`)
    .bind(feed,ticker,`${year}-01-01`,`${year}-12-31`).all<StorageRow>();
  if (rows.results.length>366) throw new Error("storage-verification-year-bound-exceeded");
  return rows.results;
}

/** Captured BEFORE copy changes any history pointer. Both current pointers and
 * all immutable revisions (including orphan revisions) are inventoried. Missing
 * this evidence cannot be repaired by declaring the post-copy history baseline. */
export async function captureStorageHistoryBaseline(context:Context & {history:D1Database;installHistoryFence:Installer}):Promise<Baseline> {
  if (context.run.freeze_authorized!==1 || !context.run.freeze_evidence_hash || !context.run.source_schema_hash) {
    throw new Error("storage-history-baseline-preflight-required");
  }
  const identity=storageMigrationIdentity(context.run),identityHash=await storageHash([identity,"history-baseline-v1"]);
  const state=checkpoints(context,identityHash),check=runtime(context);
  const completed=await state.load<Baseline>("history-baseline:complete");
  if (completed) {
    // Resume an interruption between recording completion and releasing the
    // fence, but do not release a newer final-verification capture.
    const current=await context.history.prepare("SELECT status,snapshot_revision FROM market_storage_fence WHERE id='default'").first<StorageRow>();
    if (current?.status==="frozen" && current.snapshot_revision===completed.capture.revision
      && !await loadStorageMigrationCheckpoint(context.ops,context.run.id,"verification:captures")) {
      await releaseStorageVerificationFence(context.history,identity,completed.capture);
    }
    return completed;
  }
  if (await loadStorageMigrationCheckpoint(context.ops,context.run.id,"target-schema")
    || await loadStorageMigrationCheckpoint(context.ops,context.run.id,"archives")
    || await loadStorageMigrationCheckpoint(context.ops,context.run.id,"copy-complete")) throw new Error("storage-history-baseline-was-not-captured-before-copy");
  let capture=await state.load<StorageVerificationCapture>("history-baseline:capture");
  if (!capture) {
    capture=await freezeStorageVerificationTarget(context.history,identity,context.installHistoryFence,"history");
    await state.save("history-baseline:capture",capture);
  }
  await assertStorageVerificationCapture(context.history,identity,capture);
  const captureHash=await storageHash([identity,capture,"history-baseline-v1"]),pages=checkpoints(context,captureHash);
  const summaries:Cursor[]=[];
  for (const table of [BLOCKS,POINTERS]) {
    const label=table===BLOCKS ? "blocks" : "pointers";
    let cursor=await pages.load<Cursor>(`history-baseline:${label}:cursor`) ?? await emptyCursor();
    while (!cursor.done) {
      await check();
      const rows=await readStoragePage(context.history,table,cursor.after,50);
      await verifyArchivePage(context.history,table,rows,check);
      await pages.save(`history-baseline:${label}:page:${cursor.pages}`,rows);
      cursor=await advance(table,cursor,rows,50);
      await pages.save(`history-baseline:${label}:cursor`,cursor);
      await progressStorageMigration(context.ops,context.run.id,context.leaseToken,"history-baseline",{table:label,rows:cursor.rows});
    }
    summaries.push(cursor);
  }
  await assertStorageVerificationCapture(context.history,identity,capture);
  const baseline:Baseline={schemaVersion:1,identity,capture,captureHash,blockRows:summaries[0].rows,blockPages:summaries[0].pages,
    pointerRows:summaries[1].rows,pointerPages:summaries[1].pages,hash:await storageHash(summaries.map(({rows,hash}) => ({rows,hash})))};
  await state.save("history-baseline:complete",baseline);
  await releaseStorageVerificationFence(context.history,identity,capture);
  return baseline;
}

/** Independent verification reads source and destination anew; copy progress
 * counters are never accepted as proof. Stable guards make checkpoints valid
 * across quota reset, process interruption and multi-day verification. */
export async function runStorageVerification(context:Context & {
  source:D1Database;target:D1Database;history:D1Database;installTargetFence:Installer;installHistoryFence:Installer;
}):Promise<StorageVerificationEvidence> {
  const {source,target,history,run}=context,identity=storageMigrationIdentity(run),check=runtime(context);
  if (!run.source_schema_hash || run.source_revision===null || run.freeze_authorized!==1 || !run.freeze_evidence_hash) {
    throw new Error("storage-verification-source-capture-required");
  }
  await assertReviewedStorageSchema(source);await assertReviewedStorageSchema(target);await assertReviewedStorageHistorySchema(history);
  const sourceCapture={schemaHash:run.source_schema_hash,revision:run.source_revision};
  await assertStorageVerificationCapture(source,identity,sourceCapture);
  const copy=await loadStorageMigrationCheckpoint(context.ops,run.id,"copy-complete");
  if (!copy || copy.inputHash!==await storageHash([identity,sourceCapture])) throw new Error("storage-verification-copy-capture-required");
  const baselineState=checkpoints(context,await storageHash([identity,"history-baseline-v1"]));
  const baseline=await baselineState.load<Baseline>("history-baseline:complete");
  if (!baseline) throw new Error("storage-verification-prior-history-evidence-required");
  const captureState=checkpoints(context,await storageHash([identity,sourceCapture,"verification-v1"]));
  let captures=await captureState.load<{target:StorageVerificationCapture;history:StorageVerificationCapture}>("verification:captures");
  if (!captures) {
    const targetCapture=await freezeStorageVerificationTarget(target,identity,context.installTargetFence,"market");
    const historyCapture=await freezeStorageVerificationTarget(history,identity,context.installHistoryFence,"history");
    captures={target:targetCapture,history:historyCapture};await captureState.save("verification:captures",captures);
  }
  const assertCaptures=async () => {
    await assertStorageVerificationCapture(source,identity,sourceCapture);
    await assertStorageVerificationCapture(target,identity,captures.target);
    await assertStorageVerificationCapture(history,identity,captures.history);
  };
  await assertCaptures();
  const captureHash=await storageHash([identity,sourceCapture,captures.target,captures.history,baseline.hash,"verification-v1"]);
  const state=checkpoints(context,captureHash);
  const done=await state.load<StorageVerificationEvidence>("verification:complete");
  if (done) return done;
  const tables:StorageVerificationEvidence["tables"]=[];
  for (const table of [...STORAGE_TABLES.filter((table) => table.name!=="alpaca_daily_bars"),LEDGER]) {
    let cursor=await state.load<Cursor>(`verification:table:${table.name}`) ?? await emptyCursor();
    while (!cursor.done) {
      await check();
      const [left,right]=await Promise.all([readStoragePage(source,table,cursor.after,STORAGE_TABLE_PAGE_ROWS),readStoragePage(target,table,cursor.after,STORAGE_TABLE_PAGE_ROWS)]);
      if (canonicalStorageRows(table,left)!==canonicalStorageRows(table,right)) throw new Error(`storage-verification-table-mismatch-${table.name.replaceAll("_","-")}`);
      cursor=await advance(table,cursor,left,STORAGE_TABLE_PAGE_ROWS);await state.save(`verification:table:${table.name}`,cursor);
    }
    tables.push({name:table.name,rows:cursor.rows,hash:cursor.hash});
    await progressStorageMigration(context.ops,run.id,context.leaseToken,"verification-tables",{table:table.name,rows:cursor.rows});
  }
  const priceTable=storageTable("alpaca_daily_bars");
  type PriceCursor=Cursor & {latest:StorageRow|null;hotRows:number;hotHash:string};
  let prices=await state.load<PriceCursor>("verification:prices") ?? {...await emptyCursor(),latest:null,hotRows:0,hotHash:await storageHash([])};
  const readYears=createStoragePriceYearReader(source,prices.after);
  while (!prices.done) {
    await check();
    const {groups,next}=await readYears();
    if(!groups.length) {prices.done=true;await state.save("verification:prices",prices);break;}
    const pointerRows=await history.batch<Pointer>(groups.map((rows)=>history.prepare(`SELECT feed,ticker,calendar_year,block_id,previous_block_id,updated_at
      FROM market_history_block_pointers WHERE feed=? AND ticker=? AND calendar_year=? /* storage-archive-point-read */`)
      .bind(rows[0].feed,rows[0].ticker,Number(String(rows[0].date).slice(0,4)))));
    if(pointerRows.some((result)=>result.results.length!==1))throw new Error("storage-verification-archive-pointer-missing");
    const archivedGroups=await activeBlocks(history,pointerRows.map((result)=>result.results[0]));
    const seeds:StorageRow[]=[];
    for(let index=0;index<groups.length;index++) {
      const rows=groups[index],last=rows.at(-1)!,following=groups[index+1]?.[0] ?? next;
      const archived=new Map(archivedGroups[index].bars.map((bar)=>[bar.date,bar]));
      for(const row of rows)if(!archived.has(String(row.date)) || !marketHistoryBarsEqual(storageBar(row),archived.get(String(row.date))!)) {
        throw new Error("storage-verification-source-price-not-preserved");
      }
      let latest=rows.filter((row)=>String(row.date)<=run.session_date).at(-1) ?? prices.latest;
      let hotRows=prices.hotRows,hotHash=prices.hotHash;
      if(!following || following.feed!==last.feed || following.ticker!==last.ticker) {
        if(latest) {seeds.push(latest);hotRows++;hotHash=await storageHash([hotHash,canonicalStorageRows(priceTable,[latest])]);}
        latest=null;
      }
      prices={...prices,after:storageRowKey(priceTable,last),rows:prices.rows+rows.length,
        hash:await storageHash([prices.hash,canonicalStorageRows(priceTable,rows)]),done:!following,pages:prices.pages+1,latest,hotRows,hotHash};
    }
    if(seeds.length) {
      const results=await target.batch<StorageRow>(seeds.map((seed)=>target.prepare(`SELECT ${priceTable.columns.map(quoteStorageIdentifier).join(",")} FROM alpaca_daily_bars
        WHERE feed=? AND ticker=? ORDER BY date LIMIT 2 /* storage-copy-page */`).bind(seed.feed,seed.ticker)));
      if(results.some((result,index)=>canonicalStorageRows(priceTable,result.results)!==canonicalStorageRows(priceTable,[seeds[index]]))) {
        throw new Error("storage-verification-hot-seed-mismatch");
      }
    }
    await state.save("verification:prices",prices);
    await progressStorageMigration(context.ops,run.id,context.leaseToken,"verification-prices",{rows:prices.rows,hotRows:prices.hotRows});
  }
  // Independent destination walk detects extra securities, future rows or
  // duplicate feed windows that a source-driven existence check would miss.
  let hot=await state.load<Cursor>("verification:hot") ?? await emptyCursor();
  while (!hot.done) {
    await check();const rows=await readStoragePage(target,priceTable,hot.after,100);
    let hash=hot.hash;
    for (const row of rows) hash=await storageHash([hash,canonicalStorageRows(priceTable,[row])]);
    hot={...await advance(priceTable,hot,rows,100),hash};await state.save("verification:hot",hot);
  }
  if (hot.rows!==prices.hotRows || hot.hash!==prices.hotHash) throw new Error("storage-verification-hot-extra-or-missing-rows");
  const archiveSummaries:Cursor[]=[];
  for (const table of [BLOCKS,POINTERS]) {
    const label=table===BLOCKS ? "blocks" : "pointers";
    let cursor=await state.load<Cursor>(`verification:archive:${label}`) ?? await emptyCursor();
    while (!cursor.done) {
      await check();const rows=await readStoragePage(history,table,cursor.after,50);
      await verifyArchivePage(history,table,rows,check);
      cursor=await advance(table,cursor,rows,50);await state.save(`verification:archive:${label}`,cursor);
      await progressStorageMigration(context.ops,run.id,context.leaseToken,"verification-archives",{table:label,rows:cursor.rows});
    }
    archiveSummaries.push(cursor);
  }
  // A new valid archive is not enough: every pre-copy immutable revision must
  // still exist, and dates that only existed in the old active block must still
  // be reachable from today's active pointer. Source observations win conflicts.
  const baselinePages=checkpoints(context,baseline.captureHash);
  const checkedBaselineSummaries:Array<{rows:number;hash:string}>=[];
  for (const table of [BLOCKS,POINTERS]) {
    const label=table===BLOCKS ? "blocks" : "pointers",count=table===BLOCKS ? baseline.blockPages : baseline.pointerPages;
    let checked=await state.load<{page:number;rows:number;hash:string}>(`verification:baseline:${label}`)
      ?? {page:0,rows:0,hash:await storageHash([])};
    while (checked.page<count) {
      await check();
      const rows=await baselinePages.load<StorageRow[]>(`history-baseline:${label}:page:${checked.page}`);
      if (!rows) throw new Error("storage-verification-baseline-page-missing");
      for (const row of rows) {
        await check();
        if (table===BLOCKS) {
          const current=await history.prepare(`SELECT ${BLOCKS.columns.map(quoteStorageIdentifier).join(",")} FROM market_history_blocks WHERE id=? /* storage-archive-point-read */`)
            .bind(row.id).first<StorageRow>();
          if (!current || canonicalStorageRows(BLOCKS,[current])!==canonicalStorageRows(BLOCKS,[row])) throw new Error("storage-verification-old-archive-revision-lost");
        } else {
          const old=await loadBlock(history,String(row.block_id)),pointer=await loadPointer(history,row.feed,row.ticker,row.calendar_year);
          const current=await activeBlock(history,pointer),currentByDate=new Map(current.bars.map((bar) => [bar.date,bar]));
          const sourceDates=new Set((await sourceYear(source,row.feed,row.ticker,row.calendar_year)).map((bar) => String(bar.date)));
          for (const bar of old.bars) if (!sourceDates.has(bar.date)
            && (!currentByDate.has(bar.date) || !marketHistoryBarsEqual(bar,currentByDate.get(bar.date)!))) {
            throw new Error("storage-verification-archive-only-observation-lost");
          }
        }
      }
      checked={page:checked.page+1,rows:checked.rows+rows.length,hash:await storageHash([checked.hash,canonicalStorageRows(table,rows)])};
      await state.save(`verification:baseline:${label}`,checked);
    }
    const expected=await baselinePages.load<Cursor>(`history-baseline:${label}:cursor`);
    if (!expected || checked.rows!==expected.rows || checked.hash!==expected.hash
      || checked.rows!==(table===BLOCKS ? baseline.blockRows : baseline.pointerRows)) throw new Error("storage-verification-baseline-manifest-mismatch");
    checkedBaselineSummaries.push({rows:checked.rows,hash:checked.hash});
  }
  if (baseline.hash!==await storageHash(checkedBaselineSummaries)) throw new Error("storage-verification-baseline-hash-mismatch");
  await assertCaptures();
  const evidence:StorageVerificationEvidence={schemaVersion:1,verified:true,identity,captureHash,sourceCapture,targetCapture:captures.target,historyCapture:captures.history,
    tables,prices:{sourceRows:prices.rows,hotRows:prices.hotRows,hash:await storageHash([prices.hash,prices.hotHash])},
    archive:{blockRows:archiveSummaries[0].rows,pointerRows:archiveSummaries[1].rows,hash:await storageHash(archiveSummaries.map(({rows,hash}) => ({rows,hash}))),
      baselineBlockRows:baseline.blockRows,baselinePointerRows:baseline.pointerRows,baselineHash:baseline.hash},
    verifiedAt:new Date().toISOString(),remainingLiveGates:["full-universe-capacity","consumer-parity","latest-session-publications","billed-usage","binding-cutover"]};
  await state.save("verification:complete",evidence);
  await progressStorageMigration(context.ops,run.id,context.leaseToken,"verification-complete",{captureHash,sourceRows:prices.rows,
    hotRows:prices.hotRows,verified:true,remainingLiveGates:evidence.remainingLiveGates});
  return evidence;
}
