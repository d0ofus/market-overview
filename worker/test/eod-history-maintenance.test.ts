import { describe, expect, it, vi } from "vitest";
import {
  archiveAndPruneMarketHistory, assertHistoryPruneEvidence, cleanupUnpointedHistoryBlocks,
  MARKET_HISTORY_REQUIRED_CONSUMERS, projectHistoryCapacity,
  type HistoryCapacityEvidence, type HistoryReaderEvidence,
} from "../src/eod-history-maintenance";
import * as history from "../src/market-history";
import * as catalog from "../src/eod-catalog-service";
import { eodHash } from "../src/eod-publication-service";
import type { Env } from "../src/types";

const now = new Date("2026-09-08T00:00:00Z");
const capacity: HistoryCapacityEvidence = {
  measuredAt: now.toISOString(), marketDatabaseBytes: 371_000_000, priceTableAndIndexBytes: 330_000_000,
  priceRows: 2_000_000, retainedPriceRows: 1_539_200, archiveDatabaseBytes: 10_000_000, additionalArchiveBytes: 130_000_000,
};
const readers: HistoryReaderEvidence = {
  contractVersion: 1, checkedAt: now.toISOString(), parityPassed: true, consumers: [...MARKET_HISTORY_REQUIRED_CONSUMERS],
};
const oldBar: history.MarketHistoryBar = {
  ticker: "AAA", feed: "sip", date: "2024-01-02", o: 10, h: 11, l: 9, c: 10.5,
  volume: 100, reportedVolume: 5000, sourceProvider: "alpaca", adjustment: "split",
  observedAt: "2024-01-03T00:00:00Z", fetchedAt: "2026-09-08T00:00:00Z",
};
async function mockCatalog() {
  const payload = { rows: [["AAA"]] };
  return { payload: JSON.stringify(payload), checksum: await eodHash(payload) };
}

describe("bounded history maintenance", () => {
  it("requires measured capacity and all consumer parity evidence before enabling deletion", () => {
    expect(projectHistoryCapacity(capacity)).toEqual({ marketBytes: 294_968_000, archiveBytes: 140_000_000, underTarget: true });
    expect(() => assertHistoryPruneEvidence(capacity, readers, now)).not.toThrow();
    expect(() => assertHistoryPruneEvidence({ ...capacity, retainedPriceRows: 2_000_000 }, readers, now)).toThrow(/350 MB/);
    expect(() => assertHistoryPruneEvidence({ ...capacity, additionalArchiveBytes: 350_000_000 }, readers, now)).toThrow(/350 MB/);
    expect(() => assertHistoryPruneEvidence(capacity, { ...readers, consumers: ["overview"] }, now)).toThrow(/Every historical consumer/);
    expect(() => assertHistoryPruneEvidence({ ...capacity, measuredAt: "2026-09-06T00:00:00Z" }, readers, now)).toThrow(/last UTC day/);
    expect(() => projectHistoryCapacity({ ...capacity, priceTableAndIndexBytes: 0 })).toThrow(/incomplete/);
  });

  it("does not read, archive or delete anything with the default disabled gate", async () => {
    const prepare = vi.fn(() => { throw new Error("must not read"); });
    const env = { DB: { prepare } } as unknown as Env;
    expect(await archiveAndPruneMarketHistory(env, { tickers: ["AAA"], endDate: "2026-09-04", capacity, readers, now }))
      .toMatchObject({ status: "disabled", deletedRows: 0 });
    expect(await cleanupUnpointedHistoryBlocks(env)).toMatchObject({ status: "disabled", deletedBlocks: 0 });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("retains hot rows when archive-only parity is incomplete, even after an archive write succeeds", async () => {
    const catalogData = await mockCatalog();
    const catalogRead = vi.spyOn(catalog, "loadEodCatalogRows").mockResolvedValue(new Map());
    const archive = vi.spyOn(history, "archiveMarketHistoryBars").mockResolvedValue({ blocks: [], rowsRead: 0, rowsWritten: 0, revisionChanges: [] });
    const read = vi.spyOn(history, "loadVerifiedArchivedMarketHistory").mockResolvedValue([]);
    const batch = vi.fn();
    const db = {
      prepare(sql: string) {
        const statement = {
          bind: (..._args: unknown[]) => statement,
          first: async () => sql.includes("inputClock") ? { id: "catalog", checksum: catalogData.checksum, inputClock: 1 }
            : sql.includes("payload_json") ? { payload: catalogData.payload, codec: "json" }
              : { cutoffDate: "2025-08-01", retainedRows: 260 },
          all: async () => ({ results: [oldBar] }),
        };
        return statement;
      }, batch,
    };
    try {
      const env = { DB: db, MARKET_DATA_DB: db, MARKET_HISTORY_DB: {}, EOD_RUNNER_MODE: "shadow", EOD_ARCHIVE_PRUNE_ENABLED: "true", ALPACA_DAILY_FEED: "sip" } as unknown as Env;
      await expect(archiveAndPruneMarketHistory(env, { tickers: ["AAA"], endDate: "2026-09-04", capacity, readers, now }))
        .rejects.toThrow(/Archive parity failed/);
      expect(archive).toHaveBeenCalledOnce();
      expect(batch).not.toHaveBeenCalled();
    } finally { archive.mockRestore(); read.mockRestore(); catalogRead.mockRestore(); }
  });

  it("bounds progress and leaves a concurrent hot correction for a future maintenance pass", async () => {
    const catalogData = await mockCatalog();
    const catalogRead = vi.spyOn(catalog, "loadEodCatalogRows").mockResolvedValue(new Map());
    const archive = vi.spyOn(history, "archiveMarketHistoryBars").mockResolvedValue({ blocks: [], rowsRead: 0, rowsWritten: 0, revisionChanges: [] });
    const read = vi.spyOn(history, "loadVerifiedArchivedMarketHistory").mockResolvedValue([oldBar]);
    const writes: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          sql, args: [] as unknown[],
          bind(...args: unknown[]) { statement.args = args; return statement; },
          first: async () => sql.includes("inputClock") ? { id: "catalog", checksum: catalogData.checksum, inputClock: 1 }
            : sql.includes("payload_json") ? { payload: catalogData.payload, codec: "json" }
              : { cutoffDate: "2025-08-01", retainedRows: 260 },
          all: async () => ({ results: [oldBar] }),
        };
        return statement;
      },
      batch: async (statements: Array<{ sql: string; args: unknown[] }>) => {
        writes.push(...statements);
        // SQLite reports no match when a value changed since the archived read.
        return statements.map(() => ({ meta: { changes: 0 } }));
      },
    };
    try {
      const env = { DB: db, MARKET_DATA_DB: db, MARKET_HISTORY_DB: {}, EOD_RUNNER_MODE: "shadow", EOD_ARCHIVE_PRUNE_ENABLED: "true", ALPACA_DAILY_FEED: "sip" } as unknown as Env;
      expect(await archiveAndPruneMarketHistory(env, {
        tickers: ["AAA"], endDate: "2026-09-04", maxRows: 1, capacity, readers, now,
      })).toEqual({ status: "partial", cursor: { tickerIndex: 0, afterDate: oldBar.date }, archivedRows: 1, deletedRows: 0, concurrentCorrections: 1 });
      expect(writes).toHaveLength(3);
      expect(writes[0].sql).toContain("reported_volume IS json_extract");
      expect(writes[0].sql).toContain("observed_at IS json_extract");
      expect(String(writes[0].args[1])).toContain('"reportedVolume":5000');
      expect(writes[1].sql).toContain("relocation.bar_identity IS json_array");
      expect(writes[2].sql).toContain("eod-history-relocation-cleanup");
      expect(archive).toHaveBeenCalledWith(env, [oldBar], { verifiedHotRelocation: true });
    } finally { archive.mockRestore(); read.mockRestore(); catalogRead.mockRestore(); }
  });
});
