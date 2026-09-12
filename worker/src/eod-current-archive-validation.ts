import { validateStorageCurrentArchiveContext,type StorageCurrentArchiveContext } from "./eod-storage-layout";
import { storageHash } from "./market-storage-pages";
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
export type StorageAcceptedArchiveForecast={version:1;policy:"verified-current-archive-forecast-v1";contextHash:string;
 anchorSession:string;lastForecastSession:string;physicalPeakBytes:number;liveAllocationAllowanceBytes:number;
 failedWriteReserveBytes:number;transientReserveBytes:number;projectionBytes:number};
/** Called only after the full report/context has passed capacity acceptance.
 * Retain the finite measured envelope, not a reusable growth multiplier. */
export function storageAcceptedArchiveForecast(report:unknown,context:StorageCurrentArchiveContext,projectedBytes:number):StorageAcceptedArchiveForecast {
 const value=object(object(object(report).archive).currentArchiveForecast);
 const result:StorageAcceptedArchiveForecast={version:1,policy:"verified-current-archive-forecast-v1",contextHash:context.evidenceHash,
  anchorSession:context.forecastSessionDate,lastForecastSession:context.forecastCalendarDates.at(-1)!,
  physicalPeakBytes:Number(value.physicalPeakBytes),liveAllocationAllowanceBytes:Number(value.liveAllocationAllowanceBytes),
  failedWriteReserveBytes:Number(value.failedWriteReserveBytes),transientReserveBytes:Number(value.transientReserveBytes),projectionBytes:projectedBytes};
 storageArchiveMonitorProjection(result,{anchorSession:context.forecastSessionDate,lastCoveredSession:result.lastForecastSession},projectedBytes,0);
 return result;
}
export function storageArchiveMonitorProjection(envelope:StorageAcceptedArchiveForecast,horizon:{anchorSession:string;lastCoveredSession:string},
 acceptedProjection:number,actualBytes:number):{projectedBytes:number;additionalBytes:number} {
 const fields=[envelope.physicalPeakBytes,envelope.liveAllocationAllowanceBytes,envelope.failedWriteReserveBytes,envelope.transientReserveBytes,envelope.projectionBytes,actualBytes];
 if(envelope.version!==1||envelope.policy!=="verified-current-archive-forecast-v1"||!/^[a-f0-9]{64}$/.test(envelope.contextHash)
  ||fields.some(value=>!Number.isSafeInteger(value)||value<0)||envelope.physicalPeakBytes<=0
  ||envelope.failedWriteReserveBytes<4*1024*1024||envelope.transientReserveBytes!==4*1024*1024
  ||envelope.projectionBytes!==envelope.physicalPeakBytes+envelope.liveAllocationAllowanceBytes+envelope.failedWriteReserveBytes+envelope.transientReserveBytes
  ||envelope.projectionBytes!==acceptedProjection||acceptedProjection>=350_000_000
  ||envelope.anchorSession!==horizon.anchorSession||envelope.lastForecastSession<horizon.lastCoveredSession)
  throw new Error("storage-current-archive-monitor-envelope-invalid");
 const projectedBytes=Math.max(acceptedProjection,actualBytes+envelope.failedWriteReserveBytes+envelope.transientReserveBytes);
 return {projectedBytes,additionalBytes:projectedBytes-actualBytes};
}
/** The synchronous layout predicate checks measurements. Persisted current
 * archive reports additionally authenticate their explicit signed context. */
export async function validateStorageCurrentArchiveReport(value:unknown,expected:{codeRevision:string;tickerHash:string;sourceSnapshotHash:string;sessionDate?:string}):Promise<StorageCurrentArchiveContext|null> {
 const report=object(value),archive=object(report.archive);
 if(!Object.hasOwn(archive,"currentArchiveForecast"))return null;
 const context=await validateStorageCurrentArchiveContext(object(archive.currentArchiveForecast).context);
 if(context.authorization.codeRevision!==expected.codeRevision||context.tickerHash!==expected.tickerHash
   ||context.sourceSnapshotSha256!==expected.sourceSnapshotHash||object(report.source).snapshotSha256!==context.sourceSnapshotSha256
   ||object(report.population).sha256!==context.tickerHash||archive.verifiedCopySourceRows!==context.copySourceRows
   ||archive.sourceOverlayApplied!==false||typeof report.measuredAt!=="string"
   ||!Number.isFinite(Date.parse(report.measuredAt))||Date.parse(context.historyCapturedAt)>Date.parse(report.measuredAt)||Date.parse(context.historyPhysicalMeasuredAt)>Date.parse(report.measuredAt)
   ||(expected.sessionDate!==undefined&&context.forecastSessionDate!==expected.sessionDate))throw new Error("storage-current-archive-report-context-mismatch");
 return context;
}

/** Resolve control lineage only while accepting a new capacity proof. Normal
 * readers subsequently trust that immutable accepted proof. */
export async function authenticateStoragePopulationArchiveContext(ops:D1Database,migrationId:string,context:StorageCurrentArchiveContext):Promise<void> {
 const [{loadStorageMigration},{loadStorageValidationPlan},{loadStorageCapacityCaptureReuse}]=await Promise.all([
  import("./market-storage-control"),import("./market-storage-population-plan"),import("./market-storage-capacity-execution")]);
 const run=await loadStorageMigration(ops,migrationId);
 if(!run)throw new Error("storage-current-archive-authorization-missing");
 const plan=await loadStorageValidationPlan(ops,run),reuse=await loadStorageCapacityCaptureReuse(ops,run,plan);
 if(!reuse)throw new Error("storage-current-archive-authorization-missing");
 const receipt=reuse.receipt,continuation=reuse.continuation;
 if(context.authorization.kind!=="population-expansion"||context.authorization.codeRevision!==plan.codeRevision
  ||context.authorization.evidenceHash!==(plan.populationExpansionHash??continuation.evidenceHash)
  ||context.historyReceiptHash!==receipt.evidenceHash||context.historySnapshotSha256!==receipt.fileHash
  ||context.historyCaptureHash!==receipt.captureHash||context.historyCapturedAt!==receipt.capturedAt
  ||context.historyPhysicalBytes!==continuation.physical.historyBytes||context.historyPhysicalMeasuredAt!==continuation.physical.measuredAt
  ||context.sourceSnapshotSha256!==plan.sourceSnapshotHash||context.copySourceRows!==continuation.failure.verifiedCopySourceRows
  ||context.forecastSessionDate!==plan.sessionDate||context.tickerHash!==await storageHash([...plan.tickers].sort())
  ||JSON.stringify(context.calendarDates)!==JSON.stringify(plan.inputs.calendarDates))throw new Error("storage-current-archive-authorization-mismatch");
}

export async function authenticateStorageRenewalArchiveContext(ops:D1Database,context:StorageCurrentArchiveContext,
 expected:{previousProofHash:string;attemptId:string;capture:unknown}):Promise<void> {
 const text=await ops.prepare("SELECT evidence_json FROM eod_rollout_evidence WHERE id=?")
  .bind(`storage-renewal-archive:${context.historyReceiptHash}`).first<string>("evidence_json");
 let receipt:Record<string,unknown>;try{receipt=object(JSON.parse(text??"null"));}catch{throw new Error("storage-current-archive-renewal-receipt-invalid");}
 const {evidenceHash,...unsigned}=receipt;
 if(evidenceHash!==context.historyReceiptHash||await storageHash(unsigned)!==evidenceHash||receipt.version!==1
  ||receipt.kind!=="capacity-renewal-current-archive"||receipt.codeRevision!==context.authorization.codeRevision
  ||context.authorization.kind!=="capacity-renewal"||receipt.previousProofHash!==expected.previousProofHash
  ||context.authorization.evidenceHash!==expected.previousProofHash||receipt.attemptId!==expected.attemptId
  ||await storageHash(receipt.capture)!==await storageHash(expected.capture)||await storageHash(receipt.capture)!==context.historyCaptureHash
  ||receipt.historySnapshotSha256!==context.historySnapshotSha256||receipt.historyCapturedAt!==context.historyCapturedAt
  ||receipt.historyPhysicalBytes!==context.historyPhysicalBytes||receipt.historyPhysicalMeasuredAt!==context.historyPhysicalMeasuredAt)
  throw new Error("storage-current-archive-renewal-receipt-mismatch");
}
