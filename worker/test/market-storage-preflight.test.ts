import { describe, expect, it } from "vitest";
import { prepareStoragePreflight } from "../src/market-storage-preflight";
import { storageHash } from "../src/market-storage-pages";
import { EOD_YAHOO_ARCHIVE_LAYOUT, EOD_YAHOO_ARCHIVE_MODEL_SESSIONS } from "../src/eod-storage-layout";

const identity={id:"market-storage:test",sourceDatabaseId:"10000000-0000-4000-8000-000000000001",
  targetDatabaseId:"10000000-0000-4000-8000-000000000002",historyDatabaseId:"10000000-0000-4000-8000-000000000003",
  sessionDate:"2026-09-08",codeRevision:"a".repeat(40)};
async function fixture() {
  const tickers=["AAPL","SPY"],now=new Date("2026-09-09T12:00:00Z");
  const model=(hotSessions:260|90,physicalBytes:number)=>({hotSessions,sweepHeadroomSessions:10,sharedTickers:2,
    modeledSipRows:2*(hotSessions+10),modeledFallbackRows:2*(hotSessions+10),fallbackTickerReserve:2,
    database:{physicalBytes},publicationGrowthReserveBytes:0,projectedBytes:physicalBytes,under350MB:true});
  const analysis={version:1,measuredAt:now.toISOString(),sessionDate:identity.sessionDate,
    source:{snapshotSha256:"b".repeat(64),schemaSha256:"c".repeat(64),capture:{kind:"logical-d1-capacity-snapshot",completeDeclared:true,partialEstimate:false}},
    population:{count:2,sha256:await storageHash(tickers)},archive:{sourceRows:500,storageRoundTripPassed:true,withAdditionalCompleteRevisionAndTransientBytes:10_000_000},
    bootstrap:{recentRowsToInsert:2,nonPriceRowsPreserved:true,database:{physicalBytes:1_000_000}},
    retentionModels:[model(260,300_000_000),model(90,100_000_000)]};
  return {analysis,identity,tickers,now,sourceSchemaHash:"d".repeat(64),accountId:"e".repeat(32),
    snapshotSource:{accountId:"e".repeat(32),sourceDatabaseId:identity.sourceDatabaseId,runId:"eod:shadow:2026-09-08:daily"}};
}
describe("relocation-only capacity preflight",()=>{
  it("chooses90 when260 lacks reserved headroom without claiming production readiness",async()=>{
    const result=await prepareStoragePreflight(await fixture());
    expect(result.evidence).toMatchObject({hotSessions:90,planningReserveBytes:64_000_000,productionAcceptance:false,sourceCaptureComplete:false});
    expect(result.hash).toBe(await storageHash(result.evidence));
  });
  it("prefers260 only when both provider windows and reserves fit",async()=>{
    const input=await fixture();input.analysis.retentionModels[0].database.physicalBytes=200_000_000;
    input.analysis.retentionModels[0].projectedBytes=200_000_000;
    expect((await prepareStoragePreflight(input)).evidence.hotSessions).toBe(260);
  });
  it("rejects incomplete snapshots, copied-row failures and mismatched identities",async()=>{
    const input=await fixture();input.analysis.source.capture.completeDeclared=false;
    await expect(prepareStoragePreflight(input)).rejects.toThrow("complete-analysis-required");
    input.analysis.source.capture.completeDeclared=true;input.analysis.archive.storageRoundTripPassed=false;
    await expect(prepareStoragePreflight(input)).rejects.toThrow("complete-analysis-required");
    input.analysis.archive.storageRoundTripPassed=true;input.snapshotSource.sourceDatabaseId=identity.targetDatabaseId;
    await expect(prepareStoragePreflight(input)).rejects.toThrow("identity-mismatch");
  });
  it("rejects reduced fallback population and fabricated physical projection",async()=>{
    const input=await fixture();input.analysis.retentionModels[1].fallbackTickerReserve=1;
    await expect(prepareStoragePreflight(input)).rejects.toThrow("insufficient-headroom");
    input.analysis.retentionModels[1].fallbackTickerReserve=2;input.analysis.retentionModels[1].projectedBytes=1;
    await expect(prepareStoragePreflight(input)).rejects.toThrow("insufficient-headroom");
  });
  it("rejects changed or duplicated shared tickers and expired measurements",async()=>{
    const input=await fixture();input.tickers=["SPY","SPY"];
    await expect(prepareStoragePreflight(input)).rejects.toThrow("population-mismatch");
    input.tickers=["AAPL","SPY"];input.now=new Date("2026-09-20T00:00:00Z");
    await expect(prepareStoragePreflight(input)).rejects.toThrow("measurement-expired");
  });
  it("admits measured bounded Yahoo archives without reducing primary coverage or planning headroom",async()=>{
    const input=await fixture();
    const fallbackReserve={storage:EOD_YAHOO_ARCHIVE_LAYOUT,capacityTickers:1000,existingTickers:0,
      existingTickersOutsidePopulation:0,modeledAdditionalTickers:2,totalReservedTickers:2,tickerHash:await storageHash(input.tickers),
      sessions:EOD_YAHOO_ARCHIVE_MODEL_SESSIONS,modeledRows:2*EOD_YAHOO_ARCHIVE_MODEL_SESSIONS,
      physicalBytesBefore:1_000_000,physicalBytesAfter:2_000_000,roundTripPassed:true,measurementMethod:"sqlite-real-history-codec-v1"};
    const analysis={...input.analysis,archive:{...input.analysis.archive,database:{physicalBytes:2_000_000},fallbackReserve,
      withAdditionalCompleteRevisionAndTransientBytes:4_000_000+4*1024*1024},
      retentionModels:input.analysis.retentionModels.map((row)=>({...row,fallbackStorage:EOD_YAHOO_ARCHIVE_LAYOUT,modeledFallbackRows:0}))};
    const result=await prepareStoragePreflight({...input,analysis});
    expect(result.evidence).toMatchObject({hotSessions:90,planningReserveBytes:64_000_000,projectedRecentBytes:164_000_000});
    fallbackReserve.roundTripPassed=false;
    await expect(prepareStoragePreflight({...input,analysis})).rejects.toThrow("insufficient-headroom");
    fallbackReserve.roundTripPassed=true;fallbackReserve.modeledRows--;
    await expect(prepareStoragePreflight({...input,analysis})).rejects.toThrow("insufficient-headroom");
  });
});
