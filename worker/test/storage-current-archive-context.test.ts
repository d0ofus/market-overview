import { describe,expect,it } from "vitest";
import { createStorageCurrentArchiveContext } from "../scripts/storage-current-archive-context";
import { validateStorageCurrentArchiveContext } from "../src/eod-storage-layout";
import { authenticateStorageRenewalArchiveContext,storageAcceptedArchiveForecast,storageArchiveMonitorProjection,validateStorageCurrentArchiveReport } from "../src/eod-current-archive-validation";
import { validateStorageCapacityAnalysis } from "../src/market-storage-acceptance";
import { storageHash } from "../src/market-storage-pages";
const dates=Array.from({length:1400},(_,i)=>new Date(Date.UTC(2026,8,11)-(1399-i)*86_400_000).toISOString().slice(0,10));
const fields={historySnapshotSha256:"a".repeat(64),historyCaptureHash:"b".repeat(64),historyCapturedAt:"2026-09-12T01:49:47.344Z",
 historyPhysicalBytes:165822464,historyPhysicalMeasuredAt:"2026-09-12T01:55:00Z",historyReceiptHash:"c".repeat(64),sourceSnapshotSha256:"d".repeat(64),copySourceRows:1990234,forecastSessionDate:dates.at(-1)!,calendarDates:dates,forecastCalendarDates:Array.from({length:40},(_,i)=>new Date(Date.UTC(2026,8,14+i)).toISOString().slice(0,10)),
 tickerHash:"e".repeat(64),authorization:{kind:"population-expansion" as const,evidenceHash:"f".repeat(64),codeRevision:"a".repeat(40)}};
describe("operator current-archive context",()=>{
 it("preserves the receipt's actual date and independent copy count in the signed model input",async()=>{
  const context=await createStorageCurrentArchiveContext(fields),{evidenceHash,...unsigned}=context;
  expect(evidenceHash).toBe(await storageHash(unsigned));
  expect(context.historyCapturedAt).toBe(fields.historyCapturedAt);
  expect(context.copySourceRows).toBe(1990234);
  expect(await validateStorageCurrentArchiveContext(context)).toEqual(context);
 });
 it("authenticates persisted report context and its actual executor, population and capture dates",async()=>{
  const context=await createStorageCurrentArchiveContext(fields),report={measuredAt:"2026-09-12T02:00:00Z",source:{snapshotSha256:fields.sourceSnapshotSha256},population:{sha256:fields.tickerHash},archive:{currentArchiveForecast:{context},verifiedCopySourceRows:fields.copySourceRows,sourceOverlayApplied:false}};
  const expected={codeRevision:fields.authorization.codeRevision,tickerHash:fields.tickerHash,sourceSnapshotHash:fields.sourceSnapshotSha256,sessionDate:fields.forecastSessionDate};
  expect(await validateStorageCurrentArchiveReport(report,expected)).toEqual(context);
  await expect(validateStorageCurrentArchiveReport(report,{...expected,codeRevision:"0".repeat(40)})).rejects.toThrow("report-context-mismatch");
  await expect(validateStorageCurrentArchiveReport({...report,archive:{...report.archive,verifiedCopySourceRows:1989616}},expected)).rejects.toThrow("report-context-mismatch");
  await expect(validateStorageCurrentArchiveReport({...report,measuredAt:"2026-09-12T01:00:00Z"},expected)).rejects.toThrow("report-context-mismatch");
  expect(await validateStorageCurrentArchiveReport({archive:{}},expected)).toBeNull();
 });
 it("rejects changed source/file/count/authentication fields after construction",async()=>{
  const context=await createStorageCurrentArchiveContext(fields);
  for(const change of [{historySnapshotSha256:"0".repeat(64)},{copySourceRows:1989616},{historyCapturedAt:"2026-09-11T00:00:00Z"},
    {authorization:{...fields.authorization,evidenceHash:"0".repeat(64)}}]) {
    await expect(validateStorageCurrentArchiveContext({...context,...change})).rejects.toThrow("storage-current-archive-context-invalid");
  }
 });
 it("rejects a self-rehashed future grid that differs from the actual acceptance calendar",async()=>{
  const tickers=["AAA"],tickerHash=await storageHash(tickers);
  const context=await createStorageCurrentArchiveContext({...fields,tickerHash});
  const report={measuredAt:"2026-09-12T02:00:00Z",source:{snapshotSha256:fields.sourceSnapshotSha256},population:{sha256:tickerHash},archive:{currentArchiveForecast:{context},verifiedCopySourceRows:fields.copySourceRows,sourceOverlayApplied:false}};
  const target={prepare:()=>({bind:()=>({all:async()=>({results:fields.forecastCalendarDates.slice(1).map(session_date=>({session_date}))})})})} as unknown as D1Database;
  const input={analysis:report,publicationGrowth:{},identity:{codeRevision:fields.authorization.codeRevision},tickers,
    sourceSchemaHash:"a".repeat(64),sourceSnapshotSha256:fields.sourceSnapshotSha256,target,history:target,
    publications:{sessionDate:fields.forecastSessionDate}} as unknown as Parameters<typeof validateStorageCapacityAnalysis>[0];
  await expect(validateStorageCapacityAnalysis(input)).rejects.toThrow("capacity-forecast-calendar-mismatch");
 });
 it("binds renewal model references to the immutable receipt, prior proof and actual attempt",async()=>{
  const capture={version:1,runId:"eod:active:2026-09-11:daily",revision:25},previousProofHash="4".repeat(64),attemptId="renewal-attempt";
  const body={version:1,kind:"capacity-renewal-current-archive",codeRevision:fields.authorization.codeRevision,previousProofHash,attemptId,capture,
    historySnapshotSha256:fields.historySnapshotSha256,historyCapturedAt:fields.historyCapturedAt,
    historyPhysicalBytes:fields.historyPhysicalBytes,historyPhysicalMeasuredAt:fields.historyPhysicalMeasuredAt};
  const receipt={...body,evidenceHash:await storageHash(body)};
  const context=await createStorageCurrentArchiveContext({...fields,historyCaptureHash:await storageHash(capture),historyReceiptHash:receipt.evidenceHash,
    authorization:{kind:"capacity-renewal",evidenceHash:previousProofHash,codeRevision:fields.authorization.codeRevision}});
  const ops={prepare:()=>({bind:(id:string)=>({first:async()=>id===`storage-renewal-archive:${receipt.evidenceHash}`?JSON.stringify(receipt):null})})} as unknown as D1Database;
  const expected={previousProofHash,attemptId,capture};
  await expect(authenticateStorageRenewalArchiveContext(ops,context,expected)).resolves.toBeUndefined();
  await expect(authenticateStorageRenewalArchiveContext(ops,context,{...expected,attemptId:"different-attempt"})).rejects.toThrow("renewal-receipt-mismatch");
  const changed=await createStorageCurrentArchiveContext({...fields,historyCaptureHash:context.historyCaptureHash,historyReceiptHash:receipt.evidenceHash,
    historyPhysicalBytes:fields.historyPhysicalBytes+4096,authorization:context.authorization});
  await expect(authenticateStorageRenewalArchiveContext(ops,changed,expected)).rejects.toThrow("renewal-receipt-mismatch");
  await expect(authenticateStorageRenewalArchiveContext(ops,{...context,historyReceiptHash:"9".repeat(64)},expected)).rejects.toThrow("renewal-receipt-mismatch");
 });
 it("retains the exact accepted peak/allocation/reserve envelope and rejects altered reserve math",async()=>{
  const context=await createStorageCurrentArchiveContext(fields),reserve=4*1024*1024,projection=300_000_000+1_384_448+2*reserve;
  const report={archive:{currentArchiveForecast:{physicalPeakBytes:300_000_000,liveAllocationAllowanceBytes:1_384_448,
    failedWriteReserveBytes:reserve,transientReserveBytes:reserve}}};
  const envelope=storageAcceptedArchiveForecast(report,context,projection),horizon={anchorSession:context.forecastSessionDate,lastCoveredSession:context.forecastCalendarDates[19]};
  expect(envelope.contextHash).toBe(context.evidenceHash);
  expect(storageArchiveMonitorProjection(envelope,horizon,projection,250_000_000)).toEqual({projectedBytes:projection,additionalBytes:projection-250_000_000});
  const larger={...envelope,failedWriteReserveBytes:2*reserve,projectionBytes:projection+reserve};
  expect(storageArchiveMonitorProjection(larger,horizon,projection+reserve,250_000_000)).toEqual({projectedBytes:projection+reserve,additionalBytes:projection+reserve-250_000_000});
  expect(()=>storageArchiveMonitorProjection({...envelope,failedWriteReserveBytes:0},horizon,projection,250_000_000)).toThrow("monitor-envelope-invalid");
  expect(()=>storageArchiveMonitorProjection(envelope,{...horizon,lastCoveredSession:"2027-01-01"},projection,250_000_000)).toThrow("monitor-envelope-invalid");
 });
});
