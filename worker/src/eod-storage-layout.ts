/** Bounded secondary storage never changes the primary shared ticker universe. */
export const EOD_YAHOO_ARCHIVE_TICKER_LIMIT = 1_000;
export const EOD_YAHOO_ARCHIVE_LAYOUT = "archive-only-bounded-v1";
export const EOD_YAHOO_ARCHIVE_MODEL_SESSIONS = 320;
export const EOD_CURRENT_ARCHIVE_FORECAST_POLICY = "verified-current-archive-forecast-v1";
/** Created only after the caller authenticates its durable archive receipt and
 * source/copy lineage. The offline model separately verifies this hash and the
 * actual local file; neither a local filename nor source row count is proof. */
export type StorageCurrentArchiveContext = {
  version: 1; policy: typeof EOD_CURRENT_ARCHIVE_FORECAST_POLICY;
  historySnapshotSha256: string; historyCaptureHash: string; historyCapturedAt: string; historyReceiptHash: string;
  historyPhysicalBytes: number; historyPhysicalMeasuredAt: string;
  sourceSnapshotSha256: string; copySourceRows: number; forecastSessionDate: string; calendarDates: string[]; forecastCalendarDates: string[]; tickerHash: string;
  authorization: { kind: "population-expansion" | "capacity-renewal"; evidenceHash: string; codeRevision: string };
  evidenceHash: string;
};

export async function validateStorageCurrentArchiveContext(value: unknown, now = new Date()): Promise<StorageCurrentArchiveContext> {
  const row = object(value), auth = object(row.authorization), digest = /^[a-f0-9]{64}$/;
  const { evidenceHash, ...unsigned } = row;
  const bytes = new TextEncoder().encode(JSON.stringify(unsigned));
  const calculated = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2,"0")).join("");
  const dates = row.calendarDates;
  const exactKeys = (input: Record<string, unknown>, keys: string[]) => Object.keys(input).sort().join(",") === keys.sort().join(",");
  const actualDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const actualTimestamp = (value: unknown): value is string => typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
  if (row.version !== 1 || row.policy !== EOD_CURRENT_ARCHIVE_FORECAST_POLICY || calculated !== evidenceHash
    || !exactKeys(row, ["version", "policy", "historySnapshotSha256", "historyCaptureHash", "historyCapturedAt", "historyReceiptHash", "historyPhysicalBytes", "historyPhysicalMeasuredAt", "sourceSnapshotSha256", "copySourceRows", "forecastSessionDate", "calendarDates", "forecastCalendarDates", "tickerHash", "authorization", "evidenceHash"])
    || !exactKeys(auth, ["kind", "evidenceHash", "codeRevision"])
    || ![row.historySnapshotSha256,row.historyCaptureHash,row.historyReceiptHash,row.sourceSnapshotSha256,row.tickerHash,auth.evidenceHash].every(value => typeof value === "string" && digest.test(value))
    || !integer(row.copySourceRows) || row.copySourceRows <= 0 || !actualTimestamp(row.historyCapturedAt)
    || Date.parse(row.historyCapturedAt) > now.getTime() || !Number.isFinite(now.getTime())
    || !integer(row.historyPhysicalBytes) || row.historyPhysicalBytes <= 0 || !actualTimestamp(row.historyPhysicalMeasuredAt)
    || Date.parse(row.historyPhysicalMeasuredAt) > now.getTime()
    || Date.parse(row.historyPhysicalMeasuredAt) < Date.parse(row.historyCapturedAt)
    || !["population-expansion","capacity-renewal"].includes(String(auth.kind)) || typeof auth.codeRevision !== "string" || !/^[a-f0-9]{40}$/.test(auth.codeRevision)
    || !Array.isArray(dates) || dates.length < 1400 || dates.length > 2000 || dates.some((date,index) => !actualDate(date) || (index > 0 && dates[index-1] >= date))
    || !Array.isArray(row.forecastCalendarDates) || row.forecastCalendarDates.length !== 40 || row.forecastCalendarDates.some((date,index,all) => !actualDate(date) || date <= String(row.forecastSessionDate) || (index > 0 && all[index-1] >= date))
    || dates.at(-1) !== row.forecastSessionDate) throw new Error("storage-current-archive-context-invalid");
  return value as StorageCurrentArchiveContext;
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** An omitted secondary hot window is valid only with a measured, losslessly
 * round-tripped archive fixture covering the enforced secondary capacity. Old
 * dual-hot reports remain readable; setting their fallback population to zero
 * never turns them into archive evidence. */
export function storageFallbackModelValid(reportInput: unknown, modelInput: unknown, tickerCount: number): boolean {
  const report = object(reportInput), model = object(modelInput), archive = object(report.archive);
  if (archive.currentArchiveForecast !== undefined && model.fallbackStorage !== EOD_YAHOO_ARCHIVE_LAYOUT) return false;
  if (model.fallbackStorage === undefined) {
    return model.fallbackTickerReserve === tickerCount && model.modeledFallbackRows === model.modeledSipRows;
  }
  const reserve = object(archive.fallbackReserve);
  const outside = reserve.existingTickersOutsidePopulation;
  const expected = integer(outside) ? Math.min(EOD_YAHOO_ARCHIVE_TICKER_LIMIT, tickerCount + outside) : -1;
  return model.fallbackStorage === EOD_YAHOO_ARCHIVE_LAYOUT && reserve.storage === EOD_YAHOO_ARCHIVE_LAYOUT
    && reserve.capacityTickers === EOD_YAHOO_ARCHIVE_TICKER_LIMIT && model.modeledFallbackRows === 0
    && model.fallbackTickerReserve === expected && reserve.totalReservedTickers === expected
    && integer(reserve.existingTickers) && reserve.existingTickers <= expected
    && integer(outside) && outside <= reserve.existingTickers
    && integer(reserve.modeledAdditionalTickers) && reserve.existingTickers + reserve.modeledAdditionalTickers === expected
    && integer(reserve.sessions) && reserve.sessions >= EOD_YAHOO_ARCHIVE_MODEL_SESSIONS
    && integer(reserve.modeledRows) && reserve.modeledRows === expected * reserve.sessions
    && reserve.roundTripPassed === true && reserve.measurementMethod === "sqlite-real-history-codec-v1"
    && typeof reserve.tickerHash === "string" && /^[a-f0-9]{64}$/.test(reserve.tickerHash)
    && integer(reserve.physicalBytesBefore) && reserve.physicalBytesBefore > 0
    && integer(reserve.physicalBytesAfter) && reserve.physicalBytesAfter > reserve.physicalBytesBefore
    && object(archive.database).physicalBytes === reserve.physicalBytesAfter
    && (archive.currentArchiveForecast === undefined
      ? archive.withAdditionalCompleteRevisionAndTransientBytes === reserve.physicalBytesAfter * 2 + 4 * 1024 * 1024
      : storageCurrentArchiveForecastValid(report, tickerCount));
}

/** The context hash is additionally verified by each asynchronous admission
 * consumer. This predicate checks measured allocation and forecast semantics. */
function storageCurrentArchiveForecastValid(report: Record<string, unknown>, tickerCount: number): boolean {
  const archive = object(report.archive), forecast = object(archive.currentArchiveForecast), context = object(forecast.context);
  const reserve = object(archive.fallbackReserve), phases = forecast.phases;
  const deep = object(forecast.deepHistory);
  const monday = (value: unknown) => {
    const date = new Date(String(value));
    return date.getTime() - ((date.getUTCDay() + 6) % 7) * 86_400_000;
  };
  const future = context.forecastCalendarDates;
  const weeks = Array.isArray(future) && future.length === 40
    ? (monday(future.at(-1)) - monday(context.forecastSessionDate)) / (7 * 86_400_000) + 1 : NaN;
  const page = object(archive.database).pageSize;
  const physical = [forecast.baselinePhysicalBytes, forecast.physicalPeakBytes, forecast.finalPhysicalBytes,
    forecast.failedWriteReserveBytes, forecast.transientReserveBytes, forecast.projectionBytes];
  return forecast.version === 1 && forecast.policy === EOD_CURRENT_ARCHIVE_FORECAST_POLICY
    && context.version === 1 && context.policy === EOD_CURRENT_ARCHIVE_FORECAST_POLICY
    && typeof context.evidenceHash === "string" && /^[a-f0-9]{64}$/.test(context.evidenceHash)
    && context.tickerHash === object(report.population).sha256 && context.sourceSnapshotSha256 === object(report.source).snapshotSha256
    && archive.verifiedCopySourceRows === context.copySourceRows && integer(context.copySourceRows) && context.copySourceRows > 0
    && archive.sourceOverlayApplied === false && archive.checkedSourceRows === 0
    && forecast.measurementMethod === "sqlite-current-archive-writer-forecast-v1" && forecast.vacuumUsed === false && forecast.roundTripPassed === true
    && forecast.primaryTickers === tickerCount && forecast.primaryHistorySessions === 260 && forecast.forecastSessions === 40
    && forecast.primaryModeledSessions === 300 && forecast.fallbackModeledSessions === 320 && forecast.futureRevisionGenerations === 2
    && Number.isSafeInteger(weeks) && weeks > 0 && weeks <= 20 && deep.policy === "weekly-observation-and-security-cap-v1"
    && deep.utcWeeks === weeks && deep.securitiesPerWeek === 4 && deep.observationsPerWeek === 2_500
    && deep.reservedSecurities === Math.min(tickerCount, weeks * 4) && deep.reservedRequestedObservations === weeks * 2_500
    && integer(deep.retainedSpanExtraSessionSlots) && deep.retainedSpanPreserved === true && deep.selectedHistorySessions === 1400
    && deep.reservedObservations === Math.min(Math.min(tickerCount, weeks * 4) * 1400 + deep.retainedSpanExtraSessionSlots, weeks * 2_500)
    && forecast.failedWriteChunkSecurities === 25 && physical.every(value => integer(value) && value > 0)
    && integer(page) && page > 0 && physical.every(value => Number(value) % page === 0)
    && forecast.baselinePhysicalBytes === reserve.physicalBytesBefore && forecast.finalPhysicalBytes === reserve.physicalBytesAfter
    && Number(forecast.physicalPeakBytes) >= Number(forecast.baselinePhysicalBytes) && Number(forecast.physicalPeakBytes) >= Number(forecast.finalPhysicalBytes)
    && Number(forecast.failedWriteReserveBytes) >= 4 * 1024 * 1024 && forecast.transientReserveBytes === 4 * 1024 * 1024
    && integer(context.historyPhysicalBytes) && integer(forecast.liveAllocationAllowanceBytes)
    && forecast.liveAllocationAllowanceBytes === Math.max(0, context.historyPhysicalBytes - Number(forecast.baselinePhysicalBytes))
    && forecast.projectionBytes === Number(forecast.physicalPeakBytes) + forecast.liveAllocationAllowanceBytes + Number(forecast.failedWriteReserveBytes) + Number(forecast.transientReserveBytes)
    && archive.withAdditionalCompleteRevisionAndTransientBytes === forecast.projectionBytes
    && integer(forecast.baselineFreePageBytes) && forecast.baselineFreePageBytes <= Number(forecast.baselinePhysicalBytes)
    && integer(forecast.existingBlocksVerified) && forecast.existingBlocksVerified === archive.existingBlocksVerified
    && integer(forecast.existingOrphanBlocks) && forecast.preservedOrphanBlocks === forecast.existingOrphanBlocks
    && Array.isArray(phases) && phases.length === 2 && phases.every((value, index) => {
      const phase = object(value);
      return phase.generation === index + 1 && integer(phase.physicalBytes) && phase.physicalBytes <= Number(forecast.physicalPeakBytes)
        && integer(phase.insertedBlocks) && phase.insertedBlocks > 0 && integer(phase.deletedPredecessors);
    });
}
