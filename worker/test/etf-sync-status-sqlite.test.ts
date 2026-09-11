import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadEtfSyncStatus } from "../src/etf-sync-status";
import { createSqliteD1 } from "./helpers/sqlite-d1";

function fixture(metadata = true) {
  const sqlite = createSqliteD1();
  sqlite.script(readFileSync("migrations/0006_etf_watchlists_and_constituents.sql", "utf8").split("INSERT OR IGNORE")[0]);
  if (metadata) sqlite.script(readFileSync("migrations/0051_etf_sync_metadata.sql", "utf8"));
  return sqlite;
}

describe("indexed single-fund holdings status", () => {
  it("reuses the observed holdings count and preserves failed-attempt and full-snapshot dates", async () => {
    const sqlite = fixture();
    try {
      sqlite.script(`INSERT INTO etf_constituent_sync_status
        (etf_ticker,last_synced_at,status,error,source,records_count,coverage,last_full_synced_at)
        VALUES('XLC','2026-09-11','error','issuer unavailable','ssga:fund-data',0,'full','2026-09-09');
        WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<1000)
        INSERT INTO etf_constituents(id,etf_ticker,constituent_ticker,source)
        SELECT 'unrelated-'||n,'OTHER','S'||n,'issuer' FROM rows;`);
      const prepare = vi.spyOn(sqlite.db, "prepare");
      const row = await loadEtfSyncStatus(sqlite.db, "XLC", {
        actualRecordsCount: 26, latestConstituentUpdatedAt: "2026-09-10T02:00:00Z",
      });
      expect(row).toMatchObject({ recordsCount: 26, status: "error", error: "issuer unavailable",
        lastSyncedAt: "2026-09-11", lastFullSyncedAt: "2026-09-09" });
      expect(prepare.mock.calls).toHaveLength(1);
      const sql = prepare.mock.calls[0][0];
      expect(sql).not.toContain("FROM etf_constituents");
      const plan = await sqlite.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind("XLC").all<{ detail: string }>();
      expect(plan.results.some(item => /SEARCH etf_constituent_sync_status USING INDEX/.test(item.detail))).toBe(true);
      expect(plan.results.some(item => /SCAN/.test(item.detail))).toBe(false);
    } finally { vi.restoreAllMocks(); sqlite.dispose(); }
  });

  it("supports the real legacy metadata schema and preserves cached-only/empty behavior", async () => {
    const sqlite = fixture(false);
    try {
      sqlite.script("INSERT INTO etf_constituent_sync_status(etf_ticker,status,records_count) VALUES('XLC','partial',7);");
      expect(await loadEtfSyncStatus(sqlite.db, "XLC", { actualRecordsCount: 24, latestConstituentUpdatedAt: "2026-09-09" }))
        .toMatchObject({ status: "partial", recordsCount: 24 });
      expect(await loadEtfSyncStatus(sqlite.db, "NEW", { actualRecordsCount: 2, latestConstituentUpdatedAt: "2026-09-08" }))
        .toMatchObject({ status: "ok", recordsCount: 2, lastSyncedAt: "2026-09-08" });
      expect(await loadEtfSyncStatus(sqlite.db, "EMPTY", { actualRecordsCount: 0, latestConstituentUpdatedAt: null })).toBeNull();
    } finally { sqlite.dispose(); }
  });

  it("does not retry quota/transport errors or invalid observed counts", async () => {
    for (const message of ["D1 quota exceeded", "d1-network-error", "no such table: etf_constituent_sync_status"]) {
      const first = vi.fn().mockRejectedValue(new Error(message));
      const db = { prepare: vi.fn(() => ({ bind: () => ({ first }) })) } as unknown as D1Database;
      await expect(loadEtfSyncStatus(db, "XLC", { actualRecordsCount: 26, latestConstituentUpdatedAt: null })).rejects.toThrow(message);
      expect(first).toHaveBeenCalledTimes(1);
    }
    const db = { prepare: vi.fn() } as unknown as D1Database;
    await expect(loadEtfSyncStatus(db, "XLC", { actualRecordsCount: -1, latestConstituentUpdatedAt: null })).rejects.toThrow("holdings-observed-count-invalid");
    expect(db.prepare).not.toHaveBeenCalled();
  });
});
