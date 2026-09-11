import { vi } from "vitest";
import { createSqliteD1 } from "./sqlite-d1";
import { authorizeStorageMigrationFreeze,claimStorageMigration,createStorageMigration,loadStorageMigration,pauseStorageMigration,
  progressStorageMigration,recordStorageSourceCapture,saveStorageMigrationCheckpoint } from "../../src/market-storage-control";
import { freezeStorageSource,prepareStorageSourceFence } from "../../src/market-storage-fence";
import { captureStorageHistoryBaseline, releaseStorageVerificationFence } from "../../src/market-storage-verification";
import { prepareStoragePreflight } from "../../src/market-storage-preflight";
import { approveStoragePopulationSizing,storeStoragePopulationPlan } from "../../src/market-storage-population-plan";
import { STORAGE_HISTORY_INDEX_RECOVERY_FROM_REVISION } from "../../src/market-storage-history-index-recovery";
import { STORAGE_INDEX_LOADER_PREVIOUS_REVISION } from "../../src/market-storage-history-index-continuation";
import { validateStorageHistoryIndexCodeTrees } from "../../scripts/storage-history-index-code-contract";
import { STORAGE_CONSUMER_CONTRACTS } from "../../src/market-storage-acceptance";
import { MARKET_HISTORY_READER_CONTRACT_VERSION } from "../../src/eod-history-maintenance";
import { EOD_HISTORY_POINTER_INDEX_DDL } from "../../src/eod-d1-rest";
import { storageHash } from "../../src/market-storage-pages";
import { encodeMarketHistoryBlock } from "../../src/market-history";
import { EOD_METRICS_VERSION } from "../../src/eod-metrics";
import type { FrozenInputs } from "../../src/eod-runner";

export const next=STORAGE_INDEX_LOADER_PREVIOUS_REVISION,accountId="c".repeat(32),from=STORAGE_HISTORY_INDEX_RECOVERY_FROM_REVISION;
export const identity={id:"market-storage:history-index-test",sourceDatabaseId:"10000000-0000-4000-8000-000000000001",
  targetDatabaseId:"10000000-0000-4000-8000-000000000002",historyDatabaseId:"10000000-0000-4000-8000-000000000003",sessionDate:"2026-09-08",codeRevision:from};
const tree=["worker/src/eod-runner.ts","worker/src/market-history.ts","worker/src/market-storage-acceptance.ts","package-lock.json","worker/src/market-storage-verification.ts"]
  .map((path,index)=>({path,mode:"100644",blob:String(index+1).repeat(40)}));
export const migration="CREATE INDEX IF NOT EXISTS idx_market_history_pointers_block_id ON market_history_block_pointers(block_id);\nCREATE INDEX IF NOT EXISTS idx_market_history_pointers_previous_block_id ON market_history_block_pointers(previous_block_id);";
export const codeInput=()=>({fromRevision:from,codeRevision:next,before:tree,after:[...tree,{path:"worker/history-migrations/0003_history_pointer_indexes.sql",mode:"100644",blob:"f".repeat(40)}],
  migrationSql:migration,oldVerification:'const original="same"; export function read() {return original;}',newVerification:'const original="same"; export function read() {return original;} export function added() {return 1;}'});
export function createStorageIndexDatabases() {
    const source=createSqliteD1(),target=createSqliteD1(),history=createSqliteD1(),ops=createSqliteD1();
    source.migrate("market-data-migrations");target.migrate("market-data-migrations");history.migrate("history-migrations");ops.migrate("ops-migrations");
    history.script("DROP INDEX idx_market_history_pointers_block_id; DROP INDEX idx_market_history_pointers_previous_block_id;");
    history.script(`INSERT INTO market_history_blocks(id,feed,ticker,calendar_year,schema_version,codec,checksum,row_count,first_date,last_date,uncompressed_bytes,payload_base64)
      VALUES('old','sip','A',2025,1,'gzip-json-v1','fixture',1,'2025-01-02','2025-01-02',1,'fixture');
      INSERT INTO market_history_block_pointers(feed,ticker,calendar_year,block_id) VALUES('sip','A',2025,'old');`);
    return {source,target,history,ops};
}

export async function seedStorageIndexRecovery(
  {source,target,history,ops}:ReturnType<typeof createStorageIndexDatabases>,
  options:{population?:number;checkpointCount?:number;tickers?:string[];config?:FrozenInputs["config"];copyComplete?:boolean;authenticBaseline?:boolean}={}
) {
    const population=options.tickers?.length ?? options.population ?? 1,checkpointCount=options.checkpointCount ?? 4;
    const now=new Date(),stamp=now.toISOString();await createStorageMigration(ops.db,identity,now);
    let oldBlockId="old";
    if(options.authenticBaseline) {
      const block=await encodeMarketHistoryBlock([{ticker:"A",date:"2025-01-02",o:100,h:101,l:99,c:100,volume:100,feed:"sip",
        sourceProvider:"alpaca",adjustment:"split",observedAt:stamp,fetchedAt:stamp}]);
      history.script("DELETE FROM market_history_block_pointers; DELETE FROM market_history_blocks;");
      await history.db.prepare(`INSERT INTO market_history_blocks(id,feed,ticker,calendar_year,schema_version,codec,checksum,row_count,first_date,last_date,uncompressed_bytes,payload_base64)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(block.id,block.feed,block.ticker,block.calendarYear,block.schemaVersion,block.codec,block.checksum,block.rowCount,
          block.firstDate,block.lastDate,block.uncompressedBytes,block.payloadBase64).run();
      await history.db.prepare("INSERT INTO market_history_block_pointers(feed,ticker,calendar_year,block_id) VALUES('sip','A',2025,?)").bind(block.id).run();
      await history.db.prepare("UPDATE market_history_blocks SET verified_at=? WHERE id=?").bind(stamp,block.id).run();
      oldBlockId=block.id;
    }
    const captures=[];
    for(const db of [source,target,history]) {const fence=await prepareStorageSourceFence(db.db);db.script(fence.statements.map(row=>row.sql).join("\n"));
      captures.push(await freezeStorageSource(db.db,identity,fence.schemaHash,now));}
    const [sourceCapture,targetCapture,historyCapture]=captures,schemaHash=sourceCapture.schemaHash,tickers=options.tickers ?? Array.from({length:population},(_,index)=>`A${String(index).padStart(5,"0")}`);
    const analysis={version:1,measuredAt:stamp,sessionDate:identity.sessionDate,source:{snapshotSha256:"d".repeat(64),schemaSha256:schemaHash,
      capture:{kind:"logical-d1-capacity-snapshot",completeDeclared:true,partialEstimate:false}},population:{count:population,sha256:await storageHash([...tickers].sort())},
      archive:{sourceRows:population,storageRoundTripPassed:true,withAdditionalCompleteRevisionAndTransientBytes:10_000_000},
      bootstrap:{recentRowsToInsert:population,nonPriceRowsPreserved:true,database:{physicalBytes:1_000_000}},retentionModels:([260,90] as const).map(hotSessions=>({hotSessions,
        sweepHeadroomSessions:10,sharedTickers:population,modeledSipRows:population*(hotSessions+10),modeledFallbackRows:population*(hotSessions+10),fallbackTickerReserve:population,
        database:{physicalBytes:100_000_000},publicationGrowthReserveBytes:0,projectedBytes:100_000_000,under350MB:true}))};
    const snapshotSource={accountId,sourceDatabaseId:identity.sourceDatabaseId,runId:"eod:shadow:2026-09-08:daily"};
    const preflight=await prepareStoragePreflight({analysis,identity,tickers,accountId,snapshotSource,sourceSchemaHash:schemaHash,hotSessions:90,now});
    await ops.db.prepare("INSERT INTO eod_rollout_evidence VALUES(?,?,?)").bind(`storage-preflight:${identity.id}`,JSON.stringify({...preflight,tickers,calendarDates:[identity.sessionDate]}),stamp).run();
    await authorizeStorageMigrationFreeze(ops.db,identity.id,{sourceDatabaseId:identity.sourceDatabaseId,codeRevision:from,schemaHash,evidenceHash:preflight.hash},now);
    const owner=(await claimStorageMigration(ops.db,identity.id,{now}))!;await recordStorageSourceCapture(ops.db,identity.id,owner.leaseToken,sourceCapture,now);
    const baseline=options.authenticBaseline?await captureStorageHistoryBaseline({ops:ops.db,run:(await loadStorageMigration(ops.db,identity.id))!,
      leaseToken:owner.leaseToken,history:history.db,installHistoryFence:async statements=>{history.script(statements.join("\n"));}}):null;
    const baselineHash=baseline?.hash??"e".repeat(64),originalCopyCaptureHash=await storageHash([identity,sourceCapture,targetCapture,historyCapture,baselineHash,"verification-v1"]);
    await saveStorageMigrationCheckpoint(ops.db,identity.id,owner.leaseToken,{key:"verification:complete",inputHash:originalCopyCaptureHash,
      payload:{schemaVersion:1,verified:true,identity,sourceCapture,targetCapture,historyCapture,captureHash:originalCopyCaptureHash,archive:{baselineHash,...(baseline?{baselinePointerRows:baseline.pointerRows,baselineBlockRows:baseline.blockRows}:{})}}},now);
    const fields={identity,sourceCapture,targetCapture,historyCapture},capture={...fields,captureHash:await storageHash(fields)};
    const inputs:FrozenInputs={config:options.config ?? {} as FrozenInputs["config"],tickers,calendarDates:[identity.sessionDate,"2026-09-10"],methodologyVersion:EOD_METRICS_VERSION,
      memberships:["sp500","nasdaq100","nasdaq","russell2000","overall"].map(universeId=>({universeId,versionId:`v:${universeId}`,source:"official",sourceType:"official",
        sourceUrl:null,sourceAsOfDate:"2026-09-10",verifiedAt:stamp,members:tickers}))};
    const run=(await loadStorageMigration(ops.db,identity.id))!,plan=await storeStoragePopulationPlan(ops.db,run,{inputs,capture,originalCopyCaptureHash,leaseToken:owner.leaseToken,now});
    await approveStoragePopulationSizing(ops.db,run,{analysis,accountId,snapshotSource,now});
    const checks=Object.fromEntries(STORAGE_CONSUMER_CONTRACTS.map(name=>[name,{tickers:population,observations:0,hash:"f".repeat(64)}]));
    const proof={version:1,inputHash:"f".repeat(64),tickerHash:await storageHash([...tickers].sort()),tickerCount:population,nextTicker:population,outputHash:"f".repeat(64),checks,
      history:{missing:population,shorterThan520:population,shorterThan1330:population,pendingRepair:1},completedAt:stamp,captureHash:capture.captureHash,identity,readerContractVersion:MARKET_HISTORY_READER_CONTRACT_VERSION};
    await saveStorageMigrationCheckpoint(ops.db,identity.id,owner.leaseToken,{key:"consumer-parity:complete",inputHash:capture.captureHash,payload:{...proof,evidenceHash:await storageHash(proof)}},now);
    const eodId="eod:active:2026-09-10:daily";
    await saveStorageMigrationCheckpoint(ops.db,identity.id,owner.leaseToken,{key:"bootstrap:owner",inputHash:plan.planHash,payload:{runId:eodId,sessionDate:plan.sessionDate,targetDatabaseId:identity.targetDatabaseId}},now);
    if(options.copyComplete)await saveStorageMigrationCheckpoint(ops.db,identity.id,owner.leaseToken,{key:"copy-complete",inputHash:originalCopyCaptureHash,payload:{complete:true}},now);
    for(let i=3;i<checkpointCount;i++)await saveStorageMigrationCheckpoint(ops.db,identity.id,owner.leaseToken,{key:`copy:${i}`,inputHash:"f".repeat(64),payload:{copied:i}},now);
    await progressStorageMigration(ops.db,identity.id,owner.leaseToken,"bootstrap",{chunk:0},now);
    await pauseStorageMigration(ops.db,identity.id,owner.leaseToken,"storage-query-estimate-exceeded",{chunk:0},now);
    await ops.db.prepare("UPDATE market_storage_migrations SET status='awaiting-evidence' WHERE id=?").bind(identity.id).run();
    await releaseStorageVerificationFence(target.db,identity,targetCapture);await releaseStorageVerificationFence(history.db,identity,historyCapture);
    // These are legitimate partial bootstrap writes. Index repair must preserve them.
    await history.db.prepare("UPDATE market_history_blocks SET verified_at=? WHERE id=?").bind(stamp,oldBlockId).run();
    await target.db.prepare("INSERT INTO eod_adjustment_repairs(feed,ticker,status,owner_token,start_date,updated_at) VALUES('sip','QQQE','pending','expired-owner','2025-01-02',?)").bind(stamp).run();
    await ops.db.prepare(`INSERT INTO eod_runs(id,session_date,purpose,mode,status,stage,input_json,progress_json,error_code,error_message,next_attempt_at,created_at,updated_at)
      VALUES(?,'2026-09-10','daily','active','retrying','prices',?,?,'resource-budget',?,'2026-09-12T00:05:00.000Z',?,?)`)
      .bind(eodId,JSON.stringify(inputs),JSON.stringify({chunk:0,total:Math.ceil(population/25),symbols:0}),"eod-d1-query-budget-estimate-exceeded; reads=25586/20; writes=2/8; statements=1; classes=delete-other",stamp,stamp).run();
    const budgetQueries:D1PreparedStatement[]=[];
    for(let offset=0;offset<31;offset++) {
      const day=new Date(now.getTime()-offset*86_400_000).toISOString().slice(0,10);
      budgetQueries.push(ops.db.prepare("INSERT INTO eod_account_usage(usage_date,rows_read,rows_written,sampled_at,error) VALUES(?,100,10,?,NULL)").bind(day,stamp));
      budgetQueries.push(ops.db.prepare("INSERT INTO eod_usage(usage_date,rows_read,rows_written) VALUES(?,100,10)").bind(day));
    }
    await ops.db.batch(budgetQueries);
    const bytes=async(db:D1Database)=>(await db.prepare("PRAGMA page_count").first<number>("page_count"))!*(await db.prepare("PRAGMA page_size").first<number>("page_size"))!;
    // The real REST adapter removes its reviewed accounting comment before DDL
    // reaches SQLite. Preserve that transport behavior in direct SQL fixtures.
    const historyTransport={prepare:history.db.prepare.bind(history.db),batch:async(statements:D1PreparedStatement[])=>history.db.batch(statements.map(statement=>{
      const value=statement as unknown as {sql:string};return EOD_HISTORY_POINTER_INDEX_DDL.some(sql=>sql===value.sql)
        ? history.db.prepare(value.sql.replace(" /* storage-history-pointer-index */","")) : statement;
    }))} as unknown as D1Database;
    const input={ops:ops.db,source:source.db,target:target.db,history:historyTransport,migrationId:identity.id,fromRevision:from,codeRevision:next,expectedPlanHash:plan.planHash,
      changedFiles:["worker/history-migrations/0003_history_pointer_indexes.sql"],diffHash:"f".repeat(64),codeContract:validateStorageHistoryIndexCodeTrees(codeInput()),
      assertReviewedCheckout:vi.fn(async()=>undefined),assertNoWorkflowWriters:vi.fn(async()=>undefined),now,
      measurePhysical:async()=>({targetBytes:await bytes(target.db),historyBytes:await bytes(history.db),measuredAt:stamp})};
    return {input,plan,eodId,analysis,snapshotSource};
  }
