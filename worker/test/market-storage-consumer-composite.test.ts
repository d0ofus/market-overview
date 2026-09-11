import { describe, expect, it } from "vitest";
import { STORAGE_CONSUMER_CONTRACTS, type StorageAcceptanceCapture, type StorageConsumerEvidence } from "../src/market-storage-acceptance";
import { composeStorageConsumerProof, validateStorageConsumerComposite, validateStorageConsumerProof } from "../src/market-storage-consumer-composite";
import { MARKET_HISTORY_READER_CONTRACT_VERSION } from "../src/eod-history-maintenance";
import { storageHash } from "../src/market-storage-pages";

const identity = { id: "market-storage:expansion", sourceDatabaseId: "10000000-0000-4000-8000-000000000001",
  targetDatabaseId: "10000000-0000-4000-8000-000000000002", historyDatabaseId: "10000000-0000-4000-8000-000000000003",
  sessionDate: "2026-09-08", codeRevision: "a".repeat(40) };
const oldDate = "2026-09-11T12:32:00.000Z", deltaDate = "2026-09-11T22:10:00.000Z", now = new Date("2026-09-11T22:11:00.000Z");
async function capture(targetRevision: number, historyRevision: number): Promise<StorageAcceptanceCapture> {
  const fields = { identity, sourceCapture: { schemaHash: "a".repeat(64), revision: 0 },
    targetCapture: { schemaHash: "b".repeat(64), revision: targetRevision },
    historyCapture: { schemaHash: "c".repeat(64), revision: historyRevision } };
  return { ...fields, captureHash: await storageHash(fields) };
}
async function evidence(tickers: string[], observed: number, captured: StorageAcceptanceCapture, completedAt: string): Promise<StorageConsumerEvidence> {
  const unsigned = { version: 1 as const, inputHash: await storageHash(tickers), tickerHash: await storageHash(tickers),
    tickerCount: tickers.length, nextTicker: tickers.length, outputHash: await storageHash([tickers, observed]),
    checks: Object.fromEntries(STORAGE_CONSUMER_CONTRACTS.map(name => [name, { tickers: tickers.length,
      observations: observed, hash: "d".repeat(64) }])) as StorageConsumerEvidence["checks"],
    history: { missing: observed ? 0 : tickers.length, shorterThan520: tickers.length, shorterThan1330: tickers.length },
    completedAt, captureHash: captured.captureHash, identity, readerContractVersion: MARKET_HISTORY_READER_CONTRACT_VERSION };
  return { ...unsigned, evidenceHash: await storageHash(unsigned) };
}
async function fixture() {
  const oldCapture = await capture(12, 75), deltaCapture = await capture(300, 600);
  const baselineTickers = Array.from({ length: 6319 }, (_, index) => `S${String(index).padStart(4, "0")}`);
  const addedTickers = ["APWC", "AVD", "EIM", "FVRR", "GFL", "HLSQ", "NEA", "NMZ", "TX", "USAS", "VIST"];
  const baseline = await evidence(baselineTickers, 500_000, oldCapture, oldDate);
  const delta = await evidence(addedTickers, 2700, deltaCapture, deltaDate);
  delta.history.missing = 6;
  const { evidenceHash: _hash, ...unsigned } = delta; delta.evidenceHash = await storageHash(unsigned);
  return { capture: oldCapture, deltaCapture, baselineTickers, baseline, addedTickers, delta, expansionHash: "e".repeat(64), now };
}
describe("dated disjoint population consumer proofs", () => {
  it("covers 6,330 distinct securities while preserving the original proof bytes, dates, and six missing new histories", async () => {
    const input = await fixture(), original = JSON.stringify(input.baseline), proof = await composeStorageConsumerProof(input);
    expect(proof).toMatchObject({ version: 2, tickerCount: 6330, nextTicker: 6330, completedAt: oldDate,
      composedAt: now.toISOString(), history: { missing: 6 } });
    expect(JSON.stringify(proof.baseline.evidence)).toBe(original);
    expect(proof.delta.evidence.completedAt).toBe(deltaDate);
    expect(proof.delta.capture).toEqual(input.deltaCapture);
    expect(Object.values(proof.checks).every(row => row.tickers === 6330 && row.observations === 502_700)).toBe(true);
    await validateStorageConsumerComposite(proof, input.capture, [...input.baselineTickers, ...input.addedTickers]);
    await expect(validateStorageConsumerProof(proof, input.capture, [...input.baselineTickers, ...input.addedTickers])).rejects.toThrow("stored-approval-required");
  });
  it("does not count overlapping, omitted, or invented population as independently validated", async () => {
    const input = await fixture();
    await expect(composeStorageConsumerProof({ ...input, addedTickers: [input.baselineTickers[0]] })).rejects.toThrow("partition-invalid");
    const proof = await composeStorageConsumerProof(input);
    await expect(validateStorageConsumerComposite(proof, input.capture, [...input.baselineTickers, ...input.addedTickers, "UNVERIFIED"])).rejects.toThrow("integrity");
    await expect(validateStorageConsumerComposite(proof, input.capture, input.baselineTickers)).rejects.toThrow("integrity");
  });
  it("rejects altered reader outputs, original capture, and a synthetic recent check date", async () => {
    const input = await fixture(), proof = await composeStorageConsumerProof(input);
    const changed = structuredClone(proof); changed.checks["ticker-max"].observations++;
    await expect(validateStorageConsumerComposite(changed, input.capture, [...input.baselineTickers, ...input.addedTickers])).rejects.toThrow("integrity");
    await expect(validateStorageConsumerComposite({ ...proof, completedAt: now.toISOString() }, input.capture,
      [...input.baselineTickers, ...input.addedTickers])).rejects.toThrow("integrity");
    await expect(composeStorageConsumerProof({ ...input, deltaCapture: { ...input.deltaCapture,
      sourceCapture: { ...input.deltaCapture.sourceCapture, revision: 1 } } })).rejects.toThrow("partition-invalid");
  });
  it("cannot relabel a failed child, future observation time, or regressed current revision as a completed delta", async () => {
    const input = await fixture();
    await expect(composeStorageConsumerProof({ ...input, delta: { ...input.delta, nextTicker: 10 } })).rejects.toThrow("consumer-proof-incomplete");
    const future = await evidence(input.addedTickers, 10, input.deltaCapture, "2026-09-12T22:00:00Z");
    await expect(composeStorageConsumerProof({ ...input, delta: future })).rejects.toThrow("child-date-invalid");
    await expect(composeStorageConsumerProof({ ...input, deltaCapture: { ...input.deltaCapture,
      historyCapture: { ...input.deltaCapture.historyCapture, revision: 74 } } })).rejects.toThrow("partition-invalid");
  });
});
