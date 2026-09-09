import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEodAdmission, createEodD1Database } from "../src/eod-d1-rest";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("EOD credit envelopes against real SQLite", { timeout: 20_000 }, () => {
  let storage: ReturnType<typeof createSqliteD1>;
  let time: Date;
  const read = [{ sql: "SELECT 1 as ok", params: [] }];
  const write = [{ sql: "INSERT INTO example(value) VALUES(?)", params: [1] }];
  beforeEach(() => {
    storage = createSqliteD1(); storage.migrate("ops-migrations");
    time = new Date("2026-09-08T20:30:00Z");
  }, 30_000);
  afterEach(() => storage.dispose());
  const usage = () => storage.db.prepare("SELECT usage_date as date,rows_read as reads,rows_written as writes,reserved_reads as reservedReads,reserved_writes as reservedWrites FROM eod_usage ORDER BY usage_date").all();

  it("reserves a larger bounded capacity sample before execution and blocks a competing sample near the daily ceiling", async () => {
    await storage.db.prepare("INSERT INTO eod_usage(usage_date,rows_read) VALUES('2026-09-08',2440000)").run();
    const admission = createEodAdmission(storage.db, "capacity-run", { now: () => time });
    const sample = [{ sql: "/* eod-capacity-row-sample */ SELECT ticker FROM alpaca_daily_bars", params: [] }];
    const finish = await admission(sample);
    await expect(admission(sample)).rejects.toThrow(/budget-exhausted/);
    await finish({ rowsRead: 40_000, rowsWritten: 0, sizeAfter: 100_000_000 });
    await admission.flush();
    expect((await usage()).results).toEqual([{ date: "2026-09-08", reads: 2_480_020, writes: 12, reservedReads: 0, reservedWrites: 0 }]);
  });

  it("meters1000 fakeREST reads with one ledger envelope rather than1000 ledger write sequences", async () => {
    const admission = createEodAdmission(storage.db, "run", { now: () => time });
    let requests = 0;
    const database = createEodD1Database({ accountId: "a".repeat(32), databaseId: "b".repeat(36), token: "test-token",
      allowedDatabaseIds: ["b".repeat(36)], admission,
      fetcher: async () => {
        requests++;
        return new Response(JSON.stringify({ success: true, result: [{ success: true, results: [{ ok: 1 }], meta: { rows_read: 1, rows_written: 0 } }] }));
      },
    });
    for (let index = 0; index < 1000; index++) await database.prepare("SELECT 1 as ok").all();
    await admission.flush();
    expect(requests).toBe(1000);
    expect((await usage()).results).toEqual([{ date: "2026-09-08", reads: 1020, writes: 12, reservedReads: 0, reservedWrites: 0 }]);
    expect(await storage.db.prepare("SELECT COUNT(*) as count FROM eod_budget_reservations").first()).toEqual({ count: 1 });
  });

  it("atomically prevents two independent runners from reserving the same remaining daily budget", async () => {
    await storage.db.prepare("INSERT INTO eod_usage(usage_date,rows_written) VALUES('2026-09-08',49976)").run();
    const left = createEodAdmission(storage.db, "left", { now: () => time });
    const right = createEodAdmission(storage.db, "right", { now: () => time });
    const results = await Promise.allSettled([left(write), right(write)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    for (const result of results) if (result.status === "fulfilled") await result.value({ rowsRead: 1, rowsWritten: 8, sizeAfter: 0 });
    await left.flush(); await right.flush();
    expect((await usage()).results).toEqual([{ date: "2026-09-08", reads: 21, writes: 49996, reservedReads: 0, reservedWrites: 0 }]);
  });

  it("reserves concurrent slices without holding a lock while provider or D1 requests are in flight", async () => {
    const admission = createEodAdmission(storage.db, "run", { now: () => time });
    const settlements = await Promise.all(Array.from({ length: 30 }, () => admission(read)));
    await Promise.all(settlements.reverse().map((settle) => settle({ rowsRead: 1, rowsWritten: 0, sizeAfter: 0 })));
    await admission.flush();
    expect((await usage()).results).toEqual([{ date: "2026-09-08", reads: 70, writes: 24, reservedReads: 0, reservedWrites: 0 }]);
  });

  it("also respects the account-wide budget consumed by other workflows", async () => {
    await storage.db.prepare("INSERT INTO market_data_daily_usage(usage_date,rows_written) VALUES('2026-09-08',89976)").run();
    const left = createEodAdmission(storage.db, "left", { now: () => time });
    const right = createEodAdmission(storage.db, "right", { now: () => time });
    const results = await Promise.allSettled([left(write), right(write)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "fulfilled") await result.value({ rowsRead: 1, rowsWritten: 8, sizeAfter: 0 });
    await left.flush(); await right.flush();
    expect(await storage.db.prepare("SELECT rows_written as writes FROM market_data_daily_usage WHERE usage_date='2026-09-08'").first())
      .toEqual({ writes: 89996 });
  });

  it("conservatively charges an ambiguous failed request and can still settle later work", async () => {
    const admission = createEodAdmission(storage.db, "run", { now: () => time });
    const database = createEodD1Database({ accountId: "a".repeat(32), databaseId: "b".repeat(36), token: "test-token",
      allowedDatabaseIds: ["b".repeat(36)], admission, fetcher: async () => { throw new Error("connection lost after send"); } });
    await expect(database.prepare(write[0].sql).bind(1).run()).rejects.toThrow(/d1-network-error/);
    const settle = await admission(read);
    await settle({ rowsRead: 1, rowsWritten: 0, sizeAfter: 0 });
    await admission.flush();
    expect((await usage()).results).toEqual([{ date: "2026-09-08", reads: 41, writes: 20, reservedReads: 0, reservedWrites: 0 }]);
  });

  it("settles a prior-day reservation against its original UTC bucket and opens a new-day envelope", async () => {
    const admission = createEodAdmission(storage.db, "run", { now: () => time });
    const previous = await admission(read);
    time = new Date("2026-09-09T00:01:00Z");
    await previous({ rowsRead: 1, rowsWritten: 0, sizeAfter: 0 });
    const next = await admission(read); await next({ rowsRead: 2, rowsWritten: 0, sizeAfter: 0 });
    await admission.flush();
    expect((await usage()).results).toEqual([
      { date: "2026-09-08", reads: 21, writes: 12, reservedReads: 0, reservedWrites: 0 },
      { date: "2026-09-09", reads: 22, writes: 12, reservedReads: 0, reservedWrites: 0 },
    ]);
  });

  it("resamples the new UTC day if account reconciliation crosses midnight before admission", async () => {
    time = new Date("2026-09-08T23:59:59.000Z");
    const samples: string[] = [];
    const admission = createEodAdmission(storage.db, "run", { now: () => time,
      reconcileAccountUsage: async () => {
        samples.push(time.toISOString().slice(0, 10));
        if (samples.length === 1) time = new Date("2026-09-09T00:00:01.000Z");
      },
    });
    const settle = await admission(read);
    expect(samples).toEqual(["2026-09-08", "2026-09-09"]);
    const reservations = await storage.db.prepare("SELECT usage_date FROM eod_budget_reservations").all();
    expect(reservations.results).toEqual([{ usage_date: "2026-09-09" }]);
    await settle({ rowsRead: 1, rowsWritten: 0, sizeAfter: 0 });
    await admission.flush();
    expect((await usage()).results).toEqual([
      { date: "2026-09-09", reads: 21, writes: 12, reservedReads: 0, reservedWrites: 0 },
    ]);
  });

  it("fails closed if repeated reconciliation cannot establish the current UTC allowance", async () => {
    const admission = createEodAdmission(storage.db, "run", { now: () => time,
      reconcileAccountUsage: async () => { time = new Date(time.getTime() + 86_400_000); },
    });
    await expect(admission(read)).rejects.toThrow("eod-account-usage-date-changed");
    expect((await usage()).results).toEqual([]);
    expect((await storage.db.prepare("SELECT * FROM eod_budget_reservations").all()).results).toEqual([]);
    await admission.flush();
  });

  it("flushes abandoned parallel branches conservatively and rejects new work after terminal flush", async () => {
    const admission = createEodAdmission(storage.db, "run", { now: () => time });
    const late = await admission(write);
    await admission.flush();
    await late({ rowsRead: 1, rowsWritten: 1, sizeAfter: 0 });
    await admission.flush();
    expect((await usage()).results).toEqual([{ date: "2026-09-08", reads: 40, writes: 20, reservedReads: 0, reservedWrites: 0 }]);
    await expect(admission(read)).rejects.toThrow(/already-flushed/);
  });

  it("records actual usage and fails closed if a query exceeds its declared bounded estimate", async () => {
    const admission = createEodAdmission(storage.db, "run", { now: () => time });
    const settle = await admission(read);
    await expect(settle({ rowsRead: 3000, rowsWritten: 0, sizeAfter: 0 })).rejects.toThrow(/estimate-exceeded/);
    await expect(admission(read)).rejects.toThrow(/estimate-exceeded/);
    await admission.flush();
    expect((await usage()).results).toEqual([{ date: "2026-09-08", reads: 3020, writes: 12, reservedReads: 0, reservedWrites: 0 }]);
  });
});
