import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchEodAccountUsageWindow, reconcileEodAccountUsage } from "../src/eod-account-usage";
import { assertEodRollingBudget, eodBudgetWindow, loadEodRollingUsage, readEodBudgetStatus, resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { createEodAdmission } from "../src/eod-d1-rest";
import { isEodCurrentHealthReady } from "../src/eod-current-health";
import { createSqliteD1 } from "./helpers/sqlite-d1";

const paid = resolveEodBudgetProfile("paid");
const initial = new Date("2026-09-11T02:00:00.000Z");
const group = (date: string, rowsRead: number, rowsWritten: number) => ({ dimensions: { date }, sum: { rowsRead, rowsWritten } });
const body = (groups: unknown[], errors?: unknown[]) => ({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: groups }] } }, errors });
const query = [{ sql: "INSERT INTO example(value) VALUES(?)", params: [1] }];

describe("Paid D1 admission retains account-wide rolling limits", { timeout: 30_000 }, () => {
  let storage: ReturnType<typeof createSqliteD1>;
  let now: Date;
  beforeEach(() => { storage = createSqliteD1(); storage.migrate("ops-migrations"); now = new Date(initial); }, 30_000);
  afterEach(() => storage.dispose());
  const reconcile = (groups = [group("2026-09-11", 1_000, 100)]) => reconcileEodAccountUsage({
    accountId: "account", token: "test", ops: storage.db, profile: paid, now,
    fetcher: async () => Response.json(body(groups)),
  });
  const admission = (id = "paid", extra = {}) => createEodAdmission(storage.db, id, { profile: paid, now: () => now, ...extra });

  it("requires explicit Paid configuration and keeps the Free and storage-related limits unchanged", () => {
    expect(resolveEodBudgetProfile().name).toBe("free");
    expect(resolveEodBudgetProfile().eodDaily).toEqual({ reads: 2_500_000, writes: 50_000 });
    expect(paid.eodDaily).toEqual({ reads: 1_000_000_000, writes: 8_000_000 });
    expect(paid.accountDaily).toEqual({ reads: 1_500_000_000, writes: 10_000_000 });
    expect(paid.rolling31).toEqual({ reads: 20_000_000_000, writes: 35_000_000 });
    expect(paid.runtime.queriesPerInvocation).toBe(300);
    expect(() => resolveEodBudgetProfile("unlimited")).toThrow("profile-invalid");
  });

  it("admits recovery above Free ceilings, counts reconciliation overhead, and preserves historic high-water", async () => {
    await storage.db.prepare("INSERT INTO market_data_daily_usage(usage_date,rows_read,rows_written) VALUES('2026-08-20',15000000,600000)").run();
    await reconcile([group("2026-09-11", 6_000_000, 100_000)]);
    await storage.db.prepare("UPDATE eod_usage SET rows_written=100000 WHERE usage_date='2026-09-11'").run();
    const admitted = admission(), settle = await admitted(query);
    await settle({ rowsRead: 1, rowsWritten: 8, sizeAfter: 300_000_000 });
    await admitted.flush();
    const window = await loadEodRollingUsage(storage.db, paid, now);
    expect(window?.rowsRead).toBeGreaterThan(21_000_000);
    expect(window?.rowsWritten).toBeGreaterThan(700_000);
    expect(window?.reservedWrites).toBe(0);
    const before = window!.rowsWritten;
    await reconcile([group("2026-09-11", 0, 0)]);
    expect((await loadEodRollingUsage(storage.db, paid, now))!.rowsWritten).toBe(before + 256);
    expect(await storage.db.prepare("SELECT COUNT(*) AS n FROM eod_account_usage").first<number>("n")).toBe(31);
  });

  it.each(["eod", "account", "analytics"])("still rejects the Paid daily %s ceiling", async (kind) => {
    await reconcile();
    await storage.db.prepare(kind === "eod"
      ? "UPDATE eod_usage SET rows_written=8000000 WHERE usage_date='2026-09-11'"
      : kind === "account" ? "UPDATE market_data_daily_usage SET rows_written=10000000 WHERE usage_date='2026-09-11'"
      : "UPDATE eod_account_usage SET rows_written=10000000 WHERE usage_date='2026-09-11'").run();
    await expect(admission()(query)).rejects.toThrow("eod-d1-budget-exhausted");
    expect(await storage.db.prepare("SELECT COUNT(*) AS n FROM eod_budget_reservations").first<number>("n")).toBe(0);
  });

  it("atomically counts independent runner reservations and historic usage against rolling capacity", async () => {
    await reconcile();
    const rolling = (await loadEodRollingUsage(storage.db, paid, now))!;
    await storage.db.prepare("UPDATE market_data_daily_usage SET rows_written=? WHERE usage_date='2026-08-20'")
      .bind(35_000_000 - rolling.rowsWritten - 45).run();
    const left = admission("left"), right = admission("right");
    const attempts = await Promise.allSettled([left(query), right(query)]);
    expect(attempts.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((row) => row.status === "rejected")).toHaveLength(1);
    for (const row of attempts) if (row.status === "fulfilled") await row.value.abandon?.();
    await left.flush(); await right.flush();
    const final = (await assertEodRollingBudget(storage.db, paid, now))!;
    expect(final.rowsWritten).toBe(35_000_000 - 5);
    expect(final.reservedWrites).toBe(0);
    await expect(admission("last")(query)).rejects.toThrow("rolling-budget-exhausted");
  });

  it("rejects missing, stale, errored and new-UTC-day windows, including previously issued credits", async () => {
    await expect(admission()(query)).rejects.toThrow("window-unavailable");
    await reconcile();
    const admitted = admission(), settle = await admitted(query);
    await settle({ rowsRead: 1, rowsWritten: 1, sizeAfter: 0 });
    now = new Date(initial.getTime() + 300_001);
    await expect(admitted(query)).rejects.toThrow("window-unavailable");
    await admitted.flush();
    now = new Date(initial); await reconcile();
    await storage.db.prepare("UPDATE eod_account_usage SET error='source-error' WHERE usage_date='2026-08-20'").run();
    await expect(loadEodRollingUsage(storage.db, paid, now)).rejects.toThrow("window-unavailable");
    await reconcile(); now = new Date("2026-09-12T00:00:01Z");
    await expect(admission()(query)).rejects.toThrow("window-unavailable");
    const status = await readEodBudgetStatus(storage.db, paid, now);
    expect(status.rolling31).toBeNull(); expect(status.unavailableReason).toBe("eod-account-window-unavailable");
    expect(status.daily?.accountRowsRead).toBeNull();
  });

  it("publishes all 31 dates in one atomic bounded batch and leaves the old sample dated after failure", async () => {
    await reconcile();
    const before=await loadEodRollingUsage(storage.db,paid,now);
    now=new Date(now.getTime()+60_000);
    const spy=vi.spyOn(storage.db,"batch").mockRejectedValueOnce(new Error("interrupted"));
    await expect(reconcile()).rejects.toThrow("interrupted");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toHaveLength(3);
    expect(await loadEodRollingUsage(storage.db,paid,now)).toEqual(before);
    now=new Date(initial.getTime()+300_001);
    await expect(assertEodRollingBudget(storage.db,paid,now)).rejects.toThrow("window-unavailable");
  });

  it("refreshes from actual sample expiry when collection latency outlasts refresh headroom", async () => {
    const collect=vi.fn(async()=>{
      const sample=new Date(now);
      await reconcileEodAccountUsage({accountId:"account",token:"test",ops:storage.db,profile:paid,now:sample,
        fetcher:async()=>Response.json(body([group("2026-09-11",1000,100)]))});
      now=new Date(sample.getTime()+90_000);
    });
    const admitted=admission("slow",{reconcileAccountUsage:collect});
    await (await admitted(query))({rowsRead:1,rowsWritten:1,sizeAfter:0});
    now=new Date(initial.getTime()+300_001);
    await expect(admitted(query)).resolves.toBeTypeOf("function");
    expect(collect).toHaveBeenCalledTimes(2);
    await admitted.flush();
  });

  it("reconciles one stale-window rejection before submitting any business query", async () => {
    const collect=vi.fn(async()=>{await reconcile();});
    const admitted=admission("stale-credit",{reconcileAccountUsage:collect,writeCredit:40});
    await (await admitted(query))({rowsRead:20,rowsWritten:8,sizeAfter:0});
    await storage.db.prepare("UPDATE eod_account_usage SET error='concurrent-source-failure' WHERE usage_date='2026-09-11'").run();
    await expect(admitted(query)).resolves.toBeTypeOf("function");
    expect(collect).toHaveBeenCalledTimes(2);
    await admitted.flush();
  });

  it("older concurrent collectors cannot regress or poison a newer successful sample", async () => {
    let release!:()=>void;
    const pending=new Promise<void>((resolve)=>{release=resolve;});
    const earlier=reconcileEodAccountUsage({accountId:"account",token:"test",ops:storage.db,profile:paid,now,
      fetcher:async()=>{await pending;return Response.json(body([group("2026-09-11",2000,200)]));}});
    now=new Date(initial.getTime()+60_000);await reconcile();release();await earlier;
    const current=await loadEodRollingUsage(storage.db,paid,now);
    expect(current?.sampledAt).toBe(now.toISOString());
    expect(current?.rowsRead).toBeGreaterThanOrEqual(2000);
    await expect(reconcileEodAccountUsage({accountId:"account",token:"test",ops:storage.db,profile:paid,now:initial,
      fetcher:async()=>new Response(null,{status:503})})).rejects.toThrow("window-unavailable");
    expect((await loadEodRollingUsage(storage.db,paid,now))?.sampledAt).toBe(now.toISOString());
  });
});

describe("complete 31-day account analytics", () => {
  const fetchWindow = (response: unknown) => fetchEodAccountUsageWindow({ accountId: "account", token: "test", now: initial,
    fetcher: async () => Response.json(response) });
  it("accepts omitted zero-activity dates only within a complete valid nonempty grouped response", async () => {
    const window = await fetchWindow(body([group("2026-09-11", 1.1, 2.2)]));
    expect(window.size).toBe(31);
    expect(window.get(eodBudgetWindow(initial).start)).toEqual({ rowsRead: 0, rowsWritten: 0 });
    expect(window.get("2026-09-11")).toEqual({ rowsRead: 2, rowsWritten: 3 });
  });
  it.each([
    body([]), body([group("2026-09-11", 1, 1)], [{ message: "partial response" }]),
    body([group("2026-09-11", 1, 1), group("2026-09-11", 2, 2)]),
    body([group("2026-08-01", 1, 1)]), body([group("2026-09-11", -1, 1)]),
  ])("rejects incomplete or invalid windows", async (response) => {
    await expect(fetchWindow(response)).rejects.toThrow(/eod-account-(window|usage)-(unavailable|invalid)/);
  });
});

it("requires matching profile and a complete fresh rolling window for Paid current-health approval", () => {
  const window = eodBudgetWindow(initial);
  const health = { budgetProfile: "paid", checkedAt: initial.toISOString(), codeRevision: "a".repeat(40), status: "passed",
    expectedSession: "2026-09-10", publicationCount: 6, missingScopes: [], completedRunId: "actual-completed-run", inputCorrectionsPending: false,
    reasons: [], usageDate: window.end, quotaSampledAt: initial.toISOString(),
    quota: { eodRowsRead: 1_000_000, eodRowsWritten: 100_000, accountRowsRead: 10_000_000, accountRowsWritten: 1_000_000,
      reservedReads: 100, reservedWrites: 100 },
    rollingQuota: { windowStart: window.start, windowEnd: window.end, sampledAt: initial.toISOString(),
      rowsRead: 4_000_000_000, rowsWritten: 5_000_000, reservedReads: 100, reservedWrites: 100 } };
  expect(isEodCurrentHealthReady(health, initial, "paid")).toBe(true);
  expect(isEodCurrentHealthReady(health, initial, "free")).toBe(false);
  expect(isEodCurrentHealthReady({ ...health, budgetProfile: undefined }, initial, "paid")).toBe(false);
  expect(isEodCurrentHealthReady({ ...health, rollingQuota: null }, initial, "paid")).toBe(false);
  expect(isEodCurrentHealthReady({ ...health, rollingQuota: { ...health.rollingQuota, windowStart: window.end } }, initial, "paid")).toBe(false);
  expect(isEodCurrentHealthReady({ ...health, rollingQuota: { ...health.rollingQuota, rowsWritten: 35_000_000 } }, initial, "paid")).toBe(false);
  expect(isEodCurrentHealthReady(health, new Date(initial.getTime() + 300_001), "paid")).toBe(false);
});
