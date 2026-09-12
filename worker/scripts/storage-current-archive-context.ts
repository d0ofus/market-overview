import { createHash } from "node:crypto";
import { createReadStream,readFileSync } from "node:fs";
import { dirname,resolve } from "node:path";
import { EOD_CURRENT_ARCHIVE_FORECAST_POLICY,validateStorageCurrentArchiveContext,type StorageCurrentArchiveContext } from "../src/eod-storage-layout";
import { storageHash } from "../src/market-storage-pages";
import { loadStorageCapacityCaptureReuse } from "../src/market-storage-capacity-execution";
import { loadStorageMigrationCheckpoint,type StorageMigrationRun } from "../src/market-storage-control";
import type { StoragePopulationPlan } from "../src/market-storage-population-plan";
import type { FrozenInputs } from "../src/eod-runner";
import { storageStartSnapshotHash } from "./storage-start-snapshot";
import type { StorageExpansionHistoryReceipt } from "./eod-population-expansion-operator";
export type { StorageCurrentArchiveContext } from "../src/eod-storage-layout";
export async function storageArchiveFileHash(path:string):Promise<string> {
 const hash=createHash("sha256");for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest("hex");
}
export async function verifyStorageCapacityArtifacts(input:{receipt:StorageExpansionHistoryReceipt;sourceFile:string;
 analysisPath:string;expectedSourceSnapshotHash:string}):Promise<{historyFileHash:string;analysisFileHash:string}> {
 if(!/^history-[1-4]\.sqlite$/.test(input.receipt.file)||resolve(input.receipt.directory,"storage-analysis.json")!==resolve(input.analysisPath)
   ||storageStartSnapshotHash(input.sourceFile,dirname(input.receipt.directory))!==input.expectedSourceSnapshotHash)
   throw new Error("storage-capacity-execution-original-artifact-mismatch");
 const raw=readFileSync(input.analysisPath);
 if(raw.byteLength>8_000_000)throw new Error("storage-capacity-execution-analysis-too-large");
 return {historyFileHash:await storageArchiveFileHash(resolve(input.receipt.directory,input.receipt.file)),
   analysisFileHash:createHash("sha256").update(raw).digest("hex")};
}
export async function createStorageCurrentArchiveContext(fields:Omit<StorageCurrentArchiveContext,"version"|"policy"|"evidenceHash">):Promise<StorageCurrentArchiveContext> {
 const unsigned={version:1 as const,policy:EOD_CURRENT_ARCHIVE_FORECAST_POLICY,...fields};
 return validateStorageCurrentArchiveContext({...unsigned,evidenceHash:await storageHash(unsigned)});
}
export async function loadStorageForecastCalendar(db:D1Database,sessionDate:string):Promise<string[]> {
 const rows=(await db.prepare("SELECT session_date FROM market_calendar_sessions WHERE session_date>? ORDER BY session_date LIMIT 40")
  .bind(sessionDate).all<{session_date:string}>()).results;
 if(rows.length!==40||rows.some((row,index)=>row.session_date<=(index?rows[index-1].session_date:sessionDate)))
  throw new Error("storage-current-archive-future-calendar-incomplete");
 return rows.map(row=>row.session_date);
}
/** A stored old receipt remains historical. A separately measured forecast may
 * use it only through the approved continuation and exact source/file lineage. */
export async function prepareStorageExpansionArchiveContext(input:{ops:D1Database;target:D1Database;run:StorageMigrationRun;plan:StoragePopulationPlan;
 inputs:FrozenInputs;historyFile:string;sourceFile:string;temporaryRoot:string}):Promise<StorageCurrentArchiveContext|null> {
 const reuse=await loadStorageCapacityCaptureReuse(input.ops,input.run,input.plan);if(!reuse)return null;
 const receipt=reuse.receipt,sourceHash=storageStartSnapshotHash(input.sourceFile,input.temporaryRoot);
 if(await storageArchiveFileHash(input.historyFile)!==receipt.fileHash||sourceHash!==input.plan.sourceSnapshotHash)
   throw new Error("storage-current-archive-original-file-mismatch");
 const copy=(await loadStorageMigrationCheckpoint(input.ops,input.run.id,"verification:complete"))?.payload as {prices?:{sourceRows?:number}}|undefined;
 const count=copy?.prices?.sourceRows;
 if(!Number.isSafeInteger(count)||Number(count)<=0||count!==reuse.continuation.failure.verifiedCopySourceRows)
   throw new Error("storage-current-archive-copy-lineage-mismatch");
 if(!input.plan.populationExpansionHash&&await storageHash(input.inputs)!==reuse.continuation.nextInputsHash)
   throw new Error("storage-current-archive-expansion-inputs-mismatch");
 return createStorageCurrentArchiveContext({historySnapshotSha256:receipt.fileHash,historyCaptureHash:receipt.captureHash,
  historyCapturedAt:receipt.capturedAt,historyReceiptHash:receipt.evidenceHash,sourceSnapshotSha256:sourceHash,copySourceRows:Number(count),
  historyPhysicalBytes:reuse.continuation.physical.historyBytes,historyPhysicalMeasuredAt:reuse.continuation.physical.measuredAt,
  forecastSessionDate:input.inputs.calendarDates.at(-1)!,calendarDates:input.inputs.calendarDates,
  forecastCalendarDates:await loadStorageForecastCalendar(input.target,input.inputs.calendarDates.at(-1)!),tickerHash:await storageHash([...input.inputs.tickers].sort()),
  authorization:{kind:"population-expansion",evidenceHash:input.plan.populationExpansionHash??reuse.continuation.evidenceHash,codeRevision:input.plan.codeRevision}});
}
