import { describe, expect, it, vi } from "vitest";
import { eodFailurePolicy } from "../src/eod-failure-policy";
import { loadHistoryRetentionCutoffs, projectHistoryCapacity } from "../src/eod-history-maintenance";
import { retentionDatabase } from "../src/eod-retention-database";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("daily operation boundaries", () => {
  const now = new Date("2026-09-18T01:00:00Z");
  it("separates query estimates, storage, daily quotas, rolling allowances and provider failures", () => {
    expect(eodFailurePolicy("eod-d1-query-budget-estimate-exceeded; reads=63200/50000", now)).toMatchObject({status:"failed",nextAttemptAt:null});
    expect(eodFailurePolicy("eod-d1-capacity-critical", now)).toMatchObject({code:"storage-capacity",nextAttemptAt:null});
    expect(eodFailurePolicy("d1-http-400: codes=7500; d1-capacity-exhausted", now)).toMatchObject({code:"storage-capacity"});
    expect(eodFailurePolicy("eod-d1-budget-exhausted; retry after 2026-09-18 UTC reset", now)).toMatchObject({code:"daily-quota-exhausted",nextAttemptAt:"2026-09-19T00:05:00.000Z"});
    expect(eodFailurePolicy("d1-http-400: codes=7500; d1-quota-exhausted", now)).toMatchObject({code:"daily-quota-exhausted"});
    expect(eodFailurePolicy("eod-rolling-budget-exhausted", now)).toMatchObject({nextAttemptAt:"2026-09-18T07:00:00.000Z"});
    expect(eodFailurePolicy("alpaca-http-429", now)).toMatchObject({code:"provider-error",nextAttemptAt:"2026-09-18T01:15:00.000Z"});
    expect(eodFailurePolicy("d1-http-503: query failed", now)).toMatchObject({status:"retrying",nextAttemptAt:"2026-09-18T01:15:00.000Z"});
  });
  it("uses Paid headroom without weakening the Free storage policy", () => {
    const capacity = {measuredAt:now.toISOString(),marketDatabaseBytes:600_000_000,priceTableAndIndexBytes:400_000_000,
      priceRows:900_000,retainedPriceRows:900_000,archiveDatabaseBytes:600_000_000,additionalArchiveBytes:8_000_000};
    expect(projectHistoryCapacity(capacity).underTarget).toBe(false);
    expect(projectHistoryCapacity(capacity,"paid").underTarget).toBe(true);
    expect(projectHistoryCapacity({...capacity,archiveDatabaseBytes:2_000_000_000},"paid").underTarget).toBe(false);
  });
  it("discovers a populated batch through indexed cutoff queries, including short histories and repairs", async () => {
    const storage = createSqliteD1();
    try {
      storage.script(`CREATE TABLE alpaca_daily_bars(feed TEXT,ticker TEXT,date TEXT,PRIMARY KEY(feed,ticker,date));
        CREATE TABLE eod_adjustment_repairs(feed TEXT,ticker TEXT,status TEXT,PRIMARY KEY(feed,ticker));
        WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<109)
        INSERT INTO alpaca_daily_bars SELECT 'sip','AAA',date('2026-01-01','+'||x||' days') FROM n;
        INSERT INTO alpaca_daily_bars VALUES('sip','IPO','2026-04-20');
        INSERT INTO eod_adjustment_repairs VALUES('sip','AAA','pending');`);
      expect(await loadHistoryRetentionCutoffs(storage.db,["AAA","IPO","MISSING"],"sip","2026-04-20",90)).toEqual([
        {ticker:"AAA",cutoffDate:"2026-01-21",repairStatus:"pending"},
        {ticker:"IPO",cutoffDate:null,repairStatus:null},{ticker:"MISSING",cutoffDate:null,repairStatus:null},
      ]);
    } finally { storage.dispose(); }
  });
  it("coalesces independent security writes while retaining dependent transaction order", async () => {
    const storage = createSqliteD1();
    try {
      storage.script("CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT NOT NULL);");
      const batch = vi.spyOn(storage.db,"batch");
      const db = retentionDatabase(storage.db);
      await Promise.all([1,2,3,4].map(async id => {
        await db.prepare("INSERT INTO sample VALUES(?,?)").bind(id,`value-${id}`).run();
        expect(await db.prepare("SELECT value FROM sample WHERE id=?").bind(id).first("value")).toBe(`value-${id}`);
      }));
      expect(batch.mock.calls.map(call=>call[0].length)).toEqual([4,4]);
      const attempts = await Promise.allSettled([
        db.prepare("INSERT INTO sample VALUES(5,'ok')").run(),db.prepare("INSERT INTO sample VALUES(1,'duplicate')").run(),
      ]);
      expect(attempts.every(result=>result.status==="rejected")).toBe(true);
      expect(await storage.db.prepare("SELECT id FROM sample WHERE id=5").first()).toBeNull();
    } finally { storage.dispose(); }
  });
});
