import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileEodAccountUsage } from "../src/eod-account-usage";
import { createEodAdmission } from "../src/eod-d1-rest";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const analytics = (groups: unknown, extra: Record<string, unknown> = {}) => ({
  data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: groups }] } }, ...extra,
});
const group = (rowsRead: unknown, rowsWritten: unknown) => ({ sum: { rowsRead, rowsWritten } });

describe("account-wide EOD usage against SQLite and fake GraphQL", { timeout: 20_000 }, () => {
  let storage: ReturnType<typeof createSqliteD1>;
  const fetcher = vi.fn<typeof fetch>();
  const now = new Date("2026-09-09T00:03:00.000Z");
  beforeEach(() => {
    storage = createSqliteD1();
    storage.migrate("ops-migrations");
    fetcher.mockReset();
  }, 30_000);
  afterEach(() => storage.dispose());
  const reconcile = (time = now) => reconcileEodAccountUsage({
    accountId: "test-account", token: "test-only", ops: storage.db, fetcher, now: time,
  });
  const recorded = () => storage.db.prepare("SELECT * FROM eod_account_usage ORDER BY usage_date").all();
  const highWater = () => storage.db.prepare("SELECT * FROM market_data_daily_usage ORDER BY usage_date").all();

  it("sums account-wide groups and preserves other workflows' higher local usage and bar counts", async () => {
    await storage.db.prepare(`INSERT INTO market_data_daily_usage(usage_date,bars_written,rows_read,rows_written)
      VALUES('2026-09-09',77,4000,200)`).run();
    fetcher.mockResolvedValueOnce(Response.json(analytics([group(300,30),group(700,70)])));
    expect(await reconcile()).toEqual({ rowsRead: 1000, rowsWritten: 100 });
    expect((await highWater()).results[0]).toMatchObject({ bars_written: 77, rows_read: 4000, rows_written: 200 });
    fetcher.mockResolvedValueOnce(Response.json(analytics([group(5000,300)])));
    await reconcile();
    expect((await highWater()).results[0]).toMatchObject({ bars_written: 77, rows_read: 5010, rows_written: 308 });
    await storage.db.prepare("UPDATE market_data_daily_usage SET rows_read=rows_read+100,rows_written=rows_written+50").run();
    fetcher.mockResolvedValueOnce(Response.json(analytics([group(4000,200)])));
    await reconcile(new Date("2026-09-09T00:08:00.000Z"));
    expect((await highWater()).results[0]).toMatchObject({ bars_written: 77, rows_read: 5110, rows_written: 358 });
    expect((await recorded()).results[0]).toMatchObject({ rows_read: 5000, rows_written: 300, error: null });
    const init=fetcher.mock.calls[0]![1]!;
    const body=JSON.parse(String(init.body)) as { query:string;variables:Record<string,string> };
    expect(body.variables).toEqual({ accountTag: "test-account", start: "2026-09-09", end: "2026-09-09" });
    expect(body.query).not.toContain("databaseId");
  });

  it("keeps UTC buckets separate when New York and Sydney dates differ", async () => {
    fetcher.mockImplementation(async () => Response.json(analytics([group(100,10)])));
    await reconcile(new Date("2026-09-08T23:59:59.000Z"));
    await reconcile(new Date("2026-09-09T00:00:01.000Z"));
    expect((await recorded()).results.map((row) => row.usage_date)).toEqual(["2026-09-08","2026-09-09"]);
    expect(fetcher.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).variables.start))
      .toEqual(["2026-09-08","2026-09-09"]);
    expect((await highWater()).results.map((row) => row.rows_read)).toEqual([110,110]);
  });

  it("accepts explicit numeric zeros and rounds fractional estimates upward", async () => {
    fetcher.mockResolvedValueOnce(Response.json(analytics([group(0,0)])));
    expect(await reconcile()).toEqual({ rowsRead: 0, rowsWritten: 0 });
    fetcher.mockResolvedValueOnce(Response.json(analytics([group(1.2,2.1),group(0.1,0)])));
    expect(await reconcile()).toEqual({ rowsRead: 3, rowsWritten: 3 });
    expect((await recorded()).results[0]).toMatchObject({ rows_read: 3, rows_written: 3 });
  });

  it.each([
    ["empty groups", analytics([])],
    ["missing accounts", { data:{viewer:{accounts:[]}} }],
    ["ambiguous accounts", { data:{viewer:{accounts:[{},{}]}} }],
    ["null counters", analytics([group(null,null)])],
    ["missing sum", analytics([{}])],
    ["negative count cancelled by positive count", analytics([group(-10,0),group(10,0)])],
    ["string counters", analytics([group("100",10)])],
    ["overflowed sum", analytics([group(Number.MAX_SAFE_INTEGER,0),group(1,0)])],
    ["GraphQL partial errors", analytics([group(0,0)],{errors:[{message:"permission denied"}]})],
    ["malformed errors", analytics([group(0,0)],{errors:{message:"not an array"}})],
    ["possibly truncated group page", analytics(Array.from({length:1000},() => group(1,1)))],
  ])("fails closed for %s without inserting synthetic zero usage", async (_name, body) => {
    fetcher.mockResolvedValueOnce(Response.json(body));
    await expect(reconcile()).rejects.toThrow(/eod-account-usage-(?:invalid|unavailable)/);
    expect((await recorded()).results).toEqual([]);
    expect((await highWater()).results).toEqual([]);
  });

  it("marks prior samples unavailable after HTTP, JSON and network errors without erasing their high-water marks", async () => {
    fetcher.mockResolvedValueOnce(Response.json(analytics([group(6000,400)])));
    await reconcile();
    const measured=(await recorded()).results[0]!;
    const before=(await highWater()).results;
    for (const failure of ["http","json","network"] as const) {
      if (failure==="http") fetcher.mockResolvedValueOnce(new Response("private upstream detail",{status:403}));
      if (failure==="json") fetcher.mockResolvedValueOnce(new Response("not JSON",{status:200}));
      if (failure==="network") fetcher.mockRejectedValueOnce(new Error("private network detail"));
      await expect(reconcile(new Date("2026-09-09T00:08:00.000Z"))).rejects.toThrow("eod-account-usage-unavailable");
      expect((await recorded()).results[0]).toEqual({...measured,error:"eod-account-usage-unavailable"});
      expect((await highWater()).results).toEqual(before);
    }
    fetcher.mockResolvedValueOnce(Response.json(analytics([group(5000,300)])));
    await reconcile(new Date("2026-09-09T00:13:00.000Z"));
    expect((await recorded()).results[0]).toMatchObject({rows_read:6000,rows_written:400,error:null,
      sampled_at:"2026-09-09T00:13:00.000Z"});
  });

  it("does not admit EOD work when measured usage from all workflows has exhausted the account allowance", async () => {
    fetcher.mockResolvedValueOnce(Response.json(analytics([group(4_600_000,100)])));
    const admission=createEodAdmission(storage.db,"test-run",{now:() => now,reconcileAccountUsage:() => reconcile()});
    await expect(admission([{sql:"SELECT 1 as ok",params:[]}])).rejects.toThrow("eod-d1-budget-exhausted");
    expect((await recorded()).results[0]).toMatchObject({rows_read:4_600_000,rows_written:100});
    expect((await storage.db.prepare("SELECT * FROM eod_budget_reservations").all()).results).toEqual([]);
    await admission.flush();
  });

  it("does not reserve any EOD quota when account telemetry is unknown", async () => {
    fetcher.mockResolvedValueOnce(Response.json(analytics([])));
    const admission=createEodAdmission(storage.db,"test-run",{now:() => now,reconcileAccountUsage:() => reconcile()});
    await expect(admission([{sql:"SELECT 1 as ok",params:[]}])).rejects.toThrow("eod-account-usage-unavailable");
    expect((await storage.db.prepare("SELECT * FROM eod_usage").all()).results).toEqual([]);
    expect((await storage.db.prepare("SELECT * FROM eod_budget_reservations").all()).results).toEqual([]);
    await admission.flush();
  });
});
