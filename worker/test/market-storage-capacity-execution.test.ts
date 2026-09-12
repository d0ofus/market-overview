import { describe,expect,it } from "vitest";
import { storageCapacityExecutionBoundary,validateStorageCapacityFailure } from "../src/market-storage-capacity-execution";
import { storageHash } from "../src/market-storage-pages";
import type { StoragePopulationPlan } from "../src/market-storage-population-plan";
import type { FrozenInputs } from "../src/eod-runner";
import type { StorageExpansionHistoryReceipt } from "../scripts/eod-population-expansion-operator";
const now=new Date("2026-09-12T02:00:00Z"),stamp="2026-09-12T01:30:00Z";
function boundary() {
 const run={status:"awaiting-evidence",stage:"bootstrap",error_code:"storage-population-expansion-required",next_attempt_at:null,updated_at:stamp} as const;
 const eod={id:"old",input_json:"{}",progress_json:"{}",updated_at:stamp,completed_at:stamp,status:"completed",mode:"active",purpose:"daily",stage:"finished",error_code:null,error_message:"adjustment-repair-incomplete",next_attempt_at:null,completed_input_clock:42};
 const progress={published:["a","b","c","d","e","f"],catalogPublicationId:"g",symbols:6319};
 return {run,eod,progress};
}
describe("completed capacity-model admission",()=>{
 it("accepts actual completion without rewriting a historical error message",()=>{
  const {run,eod,progress}=boundary(),before=JSON.stringify(eod);
  expect(storageCapacityExecutionBoundary(run,eod,progress,6319,now)).toEqual({status:"awaiting-evidence",errorCode:"storage-population-expansion-required",nextAttemptAt:null});
  expect(JSON.stringify(eod)).toBe(before);
 });
 it.each(["stage","status","error","future","publication","population"])("rejects invalid %s",kind=>{
  const {run,eod,progress}=boundary();
  if(kind==="stage")eod.stage="prices";
  if(kind==="status")eod.status="retrying";
  if(kind==="error")Object.assign(eod,{error_code:"resource-budget"});
  if(kind==="future")eod.completed_at="2027-01-01T00:00:00Z";
  if(kind==="publication")progress.published.pop();
  if(kind==="population")progress.symbols--;
  expect(()=>storageCapacityExecutionBoundary(run,eod,progress,6319,now)).toThrow("completed-expansion-boundary-required");
 });
 async function fixture() {
  const tickers=["AAA","BBB"],tickerHash=await storageHash(tickers),sourceHash="a".repeat(64),physical=190_000_000;
  const fallback={storage:"archive-only-bounded-v1",capacityTickers:1000,totalReservedTickers:2,existingTickers:0,existingTickersOutsidePopulation:0,modeledAdditionalTickers:2,sessions:320,modeledRows:640,roundTripPassed:true,measurementMethod:"sqlite-real-history-codec-v1",tickerHash,physicalBytesBefore:165_000_000,physicalBytesAfter:physical};
  const model={fallbackStorage:"archive-only-bounded-v1",fallbackTickerReserve:2,modeledFallbackRows:0};
  const analysis={version:1,measuredAt:"2026-09-12T01:55:00Z",sessionDate:"2026-09-08",source:{snapshotSha256:sourceHash,schemaSha256:"b".repeat(64),capture:{kind:"logical-d1-capacity-snapshot",completeDeclared:true,partialEstimate:false}},population:{count:2,sha256:tickerHash},archive:{sourceRows:10,storageRoundTripPassed:true,database:{physicalBytes:physical},fallbackReserve:fallback,withAdditionalCompleteRevisionAndTransientBytes:physical*2+4*1024*1024},retentionModels:[{...model,hotSessions:90},{...model,hotSessions:260}],storageOnlyRecommendedHotSessions:null};
  return {analysis,previous:{sourceSnapshotHash:sourceHash,capture:{identity:{sessionDate:"2026-09-08"}}} as StoragePopulationPlan,inputs:{tickers} as FrozenInputs,receipt:{capturedAt:"2026-09-12T01:49:47.344Z"} as StorageExpansionHistoryReceipt};
 }
 it("binds the actual dated legacy formula failure",async()=>{
  const f=await fixture(),result=await validateStorageCapacityFailure(f.analysis,"c".repeat(64),f.previous,f.inputs,f.receipt,now);
  expect(result).toMatchObject({projectedArchiveBytes:384_194_304,physicalArchiveBytes:190_000_000});
  expect(result.analysisHash).toBe(await storageHash(f.analysis));
 });
 it.each(["under-limit","formula","before-capture","future","source","reserve"])("rejects invalid %s failure evidence",async kind=>{
  const f=await fixture();
  if(kind==="under-limit")f.analysis.archive.withAdditionalCompleteRevisionAndTransientBytes=200_000_000;
  if(kind==="formula")f.analysis.archive.withAdditionalCompleteRevisionAndTransientBytes++;
  if(kind==="before-capture")f.analysis.measuredAt="2026-09-12T01:00:00Z";
  if(kind==="future")f.analysis.measuredAt="2027-01-01T00:00:00Z";
  if(kind==="source")f.analysis.source.snapshotSha256="d".repeat(64);
  if(kind==="reserve")f.analysis.archive.fallbackReserve.modeledRows=0;
  await expect(validateStorageCapacityFailure(f.analysis,"c".repeat(64),f.previous,f.inputs,f.receipt,now)).rejects.toThrow("actual-legacy-capacity-failure-required");
 });
});
