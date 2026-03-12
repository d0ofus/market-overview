import { describe, expect, it } from "vitest";
import { normalizeEtfSyncStatusRow } from "../src/etf-sync-status";

describe("normalizeEtfSyncStatusRow", () => {
  it("treats a failed refresh as ok when cached constituents still exist", () => {
    expect(normalizeEtfSyncStatusRow({
      etfTicker: "SMH",
      lastSyncedAt: "2026-03-12T01:00:00.000Z",
      status: "error",
      error: "Failed to fetch .",
      source: "official:vaneck.com",
      recordsCount: 0,
      updatedAt: "2026-03-12T01:00:00.000Z",
      actualRecordsCount: 25,
      latestConstituentUpdatedAt: "2026-03-11T23:00:00.000Z",
    })).toMatchObject({
      status: "ok",
      error: null,
      recordsCount: 25,
      lastSyncedAt: "2026-03-12T01:00:00.000Z",
      updatedAt: "2026-03-11T23:00:00.000Z",
    });
  });
});
