/** Bounded secondary storage never changes the primary shared ticker universe. */
export const EOD_YAHOO_ARCHIVE_TICKER_LIMIT = 1_000;
export const EOD_YAHOO_ARCHIVE_LAYOUT = "archive-only-bounded-v1";
export const EOD_YAHOO_ARCHIVE_MODEL_SESSIONS = 320;

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** An omitted secondary hot window is valid only with a measured, losslessly
 * round-tripped archive fixture covering the enforced secondary capacity. Old
 * dual-hot reports remain readable; setting their fallback population to zero
 * never turns them into archive evidence. */
export function storageFallbackModelValid(reportInput: unknown, modelInput: unknown, tickerCount: number): boolean {
  const report = object(reportInput), model = object(modelInput), archive = object(report.archive);
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
    && archive.withAdditionalCompleteRevisionAndTransientBytes === reserve.physicalBytesAfter * 2 + 4 * 1024 * 1024;
}
