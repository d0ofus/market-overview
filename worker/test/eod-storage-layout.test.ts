import { describe, expect, it } from "vitest";
import { EOD_YAHOO_ARCHIVE_LAYOUT, storageFallbackModelValid } from "../src/eod-storage-layout";

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
