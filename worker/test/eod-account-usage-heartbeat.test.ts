import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshEodAccountUsageHeartbeat } from "../src/eod-account-usage-heartbeat";
import { loadEodRollingUsage, resolveEodBudgetProfile } from "../src/eod-budget-profile";
import { createSqliteD1 } from "./helpers/sqlite-d1";
import type { Env } from "../src/types";

describe("independent Paid account usage heartbeat", { timeout: 20_000 }, () => {
  let storage: ReturnType<typeof createSqliteD1>, env: Env;
  const now = new Date("2026-09-12T05:00:00Z"); // Weekend, outside US EOD windows.
  const fetcher = vi.fn<typeof fetch>();
  beforeEach(() => {
    storage = createSqliteD1(); storage.migrate("ops-migrations");
    env = { DB: storage.db, OPS_DB: storage.db, EOD_BUDGET_PROFILE: "paid", EOD_RUNNER_MODE: "disabled",
      EOD_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), EOD_ANALYTICS_TOKEN: "test-only" } as Env;
    fetcher.mockReset().mockImplementation(async () => Response.json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [
      { dimensions: { date: "2026-09-12" }, sum: { rowsRead: 100, rowsWritten: 50 } },
    ] }] } } }));
  }, 30_000);
  afterEach(() => storage.dispose());

  it("refreshes outside ingestion gates and skips fresh cached data, then refreshes stale data", async () => {
    expect(await refreshEodAccountUsageHeartbeat(env, now, fetcher)).toEqual({ status: "refreshed" });
    expect(await refreshEodAccountUsageHeartbeat(env, new Date(now.getTime() + 120_000), fetcher)).toEqual({ status: "fresh" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await refreshEodAccountUsageHeartbeat(env, new Date(now.getTime() + 300_000), fetcher)).toEqual({ status: "refreshed" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await loadEodRollingUsage(storage.db, resolveEodBudgetProfile("paid"), new Date(now.getTime() + 300_000)))?.sampledAt)
      .toBe(new Date(now.getTime() + 300_000).toISOString());
  });

  it("claims one concurrent collection and retains a durable failure cooldown without inventing usage", async () => {
    fetcher.mockImplementation(async () => new Response("private detail", { status: 403 }));
    const attempts = await Promise.all([refreshEodAccountUsageHeartbeat(env, now, fetcher), refreshEodAccountUsageHeartbeat(env, now, fetcher)]);
    expect(attempts.map((row) => row.status).sort()).toEqual(["cooldown", "unavailable"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await refreshEodAccountUsageHeartbeat(env, new Date(now.getTime() + 60_000), fetcher)).toEqual({ status: "cooldown" });
    await expect(loadEodRollingUsage(storage.db, resolveEodBudgetProfile("paid"), now)).rejects.toThrow("window-unavailable");
    const persisted = await storage.db.prepare("SELECT evidence_json FROM eod_rollout_evidence").first<string>("evidence_json");
    expect(persisted).not.toContain("private detail"); expect(persisted).not.toContain("test-only");
  });

  it("does not collect on Free or runtime candidates and fails closed when settings are absent", async () => {
    expect(await refreshEodAccountUsageHeartbeat({ ...env, EOD_BUDGET_PROFILE: undefined }, now, fetcher)).toEqual({ status: "disabled" });
    expect(await refreshEodAccountUsageHeartbeat({ ...env, EOD_RUNTIME_CANDIDATE_ONLY: "true" }, now, fetcher)).toEqual({ status: "disabled" });
    expect(await refreshEodAccountUsageHeartbeat({ ...env, EOD_ANALYTICS_TOKEN: undefined }, now, fetcher)).toMatchObject({ status: "unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
