import { describe, expect, it } from "vitest";
import { EOD_CURRENT_ARCHIVE_FORECAST_POLICY, EOD_YAHOO_ARCHIVE_LAYOUT, storageFallbackModelValid, validateStorageCurrentArchiveContext } from "../src/eod-storage-layout";
import { storageHash } from "../src/market-storage-pages";
import { EOD_DEEP_HISTORY_MAX_OBSERVATIONS, EOD_DEEP_HISTORY_MAX_SECURITIES } from "../src/eod-deep-history-admission";

function fixture() {
  const model={fallbackStorage:EOD_YAHOO_ARCHIVE_LAYOUT,fallbackTickerReserve:1000,modeledFallbackRows:0,modeledSipRows:592100};
  const fallbackReserve={storage:EOD_YAHOO_ARCHIVE_LAYOUT,capacityTickers:1000,existingTickers:10,existingTickersOutsidePopulation:2,
    modeledAdditionalTickers:990,totalReservedTickers:1000,sessions:320,modeledRows:320000,tickerHash:"a".repeat(64),
    roundTripPassed:true,measurementMethod:"sqlite-real-history-codec-v1",physicalBytesBefore:1000000,physicalBytesAfter:2000000};
  const report={archive:{fallbackReserve,database:{physicalBytes:2000000},withAdditionalCompleteRevisionAndTransientBytes:4000000+4*1024*1024}};
  return {model,report};
}
describe("bounded secondary archive storage proof",()=>{
  it("keeps all primary members with bounded fallback capacity and a complete archive revision reserve",()=>{
    const {model,report}=fixture();expect(storageFallbackModelValid(report,model,5921)).toBe(true);
    report.archive.withAdditionalCompleteRevisionAndTransientBytes--;
    expect(storageFallbackModelValid(report,model,5921)).toBe(false);
  });
  it("does not accept arbitrary population reductions, too-short forecasts, or mismatched allocations",()=>{
    for(const change of [
      {capacityTickers:500},{modeledAdditionalTickers:989},{sessions:260},{modeledRows:319999},
      {physicalBytesAfter:1900000},{existingTickersOutsidePopulation:11},{roundTripPassed:false},
    ]) {
      const {model,report}=fixture();Object.assign(report.archive.fallbackReserve,change);
      expect(storageFallbackModelValid(report,model,5921)).toBe(false);
    }
  });
  it("preserves legacy full dual-hot evidence but rejects its silent conversion to zero fallback",()=>{
    expect(storageFallbackModelValid({}, {fallbackTickerReserve:2,modeledFallbackRows:200,modeledSipRows:200},2)).toBe(true);
    expect(storageFallbackModelValid({}, {fallbackTickerReserve:0,modeledFallbackRows:0,modeledSipRows:200},2)).toBe(false);
    expect(storageFallbackModelValid({}, {...fixture().model},5921)).toBe(false);
  });
});

describe("verified current archive forecast", () => {
  it("matches the enforced weekly deep history envelope", () => {
    expect(EOD_DEEP_HISTORY_MAX_SECURITIES).toBe(4);
    expect(EOD_DEEP_HISTORY_MAX_OBSERVATIONS).toBe(2500);
  });
  async function context() {
    const calendarDates = Array.from({ length: 1400 }, (_, index) => new Date(Date.UTC(2021, 0, index + 1)).toISOString().slice(0, 10));
    const forecastCalendarDates = Array.from({ length: 40 }, (_, index) => new Date(Date.parse(calendarDates.at(-1)!) + (index + 1) * 86_400_000).toISOString().slice(0, 10));
    const unsigned = { version: 1, policy: EOD_CURRENT_ARCHIVE_FORECAST_POLICY, historySnapshotSha256: "a".repeat(64),
      historyCaptureHash: "b".repeat(64), historyCapturedAt: "2026-09-01T00:00:00.000Z", historyReceiptHash: "c".repeat(64),
      historyPhysicalBytes: 4096 * 101, historyPhysicalMeasuredAt: "2026-09-01T01:00:00.000Z",
      sourceSnapshotSha256: "d".repeat(64), copySourceRows: 1990234, forecastSessionDate: calendarDates.at(-1), calendarDates, forecastCalendarDates,
      tickerHash: "e".repeat(64), authorization: { kind: "population-expansion", evidenceHash: "f".repeat(64), codeRevision: "a".repeat(40) } };
    return { ...unsigned, evidenceHash: await storageHash(unsigned) };
  }
  it("authenticates exact context keys, actual dates and immutable capture time", async () => {
    const value = await context();
    await expect(validateStorageCurrentArchiveContext(value, new Date("2026-09-12"))).resolves.toEqual(value);
    for (const patch of [{ unexpected: true }, { historyCapturedAt: "2026-09-13T00:00:00Z" },
      { calendarDates: ["2024-02-31", ...value.calendarDates.slice(1)] }, { authorization: { ...value.authorization, extra: true } }]) {
      const { evidenceHash: _hash, ...unsigned } = { ...value, ...patch };
      await expect(validateStorageCurrentArchiveContext({ ...unsigned, evidenceHash: await storageHash(unsigned) }, new Date("2026-09-12"))).rejects.toThrow("storage-current-archive-context-invalid");
    }
    await expect(validateStorageCurrentArchiveContext({ ...value, copySourceRows: 1989616 })).rejects.toThrow();
  });
  it("accepts measured writer peak with preserved orphans and refuses blanket or incomplete forecast substitutions", async () => {
    const ctx = await context(), { model, report: old } = fixture();
    const forecast = { version: 1, policy: EOD_CURRENT_ARCHIVE_FORECAST_POLICY, context: ctx,
      baselinePhysicalBytes: 4096 * 100, baselineFreePageBytes: 4096 * 10, physicalPeakBytes: 4096 * 500, finalPhysicalBytes: 4096 * 490,
      existingBlocksVerified: 10, existingOrphanBlocks: 1, preservedOrphanBlocks: 1, primaryTickers: 5921,
      primaryHistorySessions: 260, forecastSessions: 40, primaryModeledSessions: 300, fallbackModeledSessions: 320,
      deepHistory: { policy: "weekly-observation-and-security-cap-v1", utcWeeks: 7, securitiesPerWeek: 4,
        observationsPerWeek: 2500, reservedSecurities: 28, reservedRequestedObservations: 17500, reservedObservations: 17500,
        selectedHistorySessions: 1400, retainedSpanExtraSessionSlots: 0, retainedSpanPreserved: true },
      futureRevisionGenerations: 2, failedWriteChunkSecurities: 25, failedWriteReserveBytes: 4 * 1024 * 1024,
      transientReserveBytes: 4 * 1024 * 1024, liveAllocationAllowanceBytes: 4096, projectionBytes: 4096 * 501 + 8 * 1024 * 1024,
      phases: [{ generation: 1, physicalBytes: 4096 * 400, insertedBlocks: 10, deletedPredecessors: 1 },
        { generation: 2, physicalBytes: 4096 * 490, insertedBlocks: 20, deletedPredecessors: 11 }],
      measurementMethod: "sqlite-current-archive-writer-forecast-v1", vacuumUsed: false, roundTripPassed: true };
    const report = { source: { snapshotSha256: ctx.sourceSnapshotSha256 }, population: { sha256: ctx.tickerHash }, archive: {
      ...old.archive, database: { physicalBytes: forecast.finalPhysicalBytes, pageSize: 4096 },
      fallbackReserve: { ...old.archive.fallbackReserve, physicalBytesBefore: forecast.baselinePhysicalBytes, physicalBytesAfter: forecast.finalPhysicalBytes },
      verifiedCopySourceRows: 1990234, sourceRows: 1989616, checkedSourceRows: 0, sourceOverlayApplied: false,
      existingBlocksVerified: 10, currentArchiveForecast: forecast, withAdditionalCompleteRevisionAndTransientBytes: forecast.projectionBytes } };
    expect(storageFallbackModelValid(report, model, 5921)).toBe(true);
    for (const patch of [{ primaryHistorySessions: 520 }, { futureRevisionGenerations: 1 }, { preservedOrphanBlocks: 0 },
      { vacuumUsed: true }, { failedWriteReserveBytes: 0 }, { physicalPeakBytes: forecast.finalPhysicalBytes - 4096 }]) {
      expect(storageFallbackModelValid({ ...report, archive: { ...report.archive, currentArchiveForecast: { ...forecast, ...patch } } }, model, 5921)).toBe(false);
    }
    expect(storageFallbackModelValid(report, { fallbackTickerReserve: 5921, modeledFallbackRows: 200, modeledSipRows: 200 }, 5921)).toBe(false);
    expect(storageFallbackModelValid({ ...report, archive: { ...report.archive, verifiedCopySourceRows: 1989616 } }, model, 5921)).toBe(false);
  });
});
