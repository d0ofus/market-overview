import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  classifyScheduledCron,
  createScheduledBudget,
  DEPLOYED_SCHEDULED_CRONS,
  scheduledLanesForCron,
  ScheduledBudget,
  SCHEDULED_CORE_CRON,
  SCHEDULED_MAINTENANCE_CRON,
  SCHEDULED_MARKET_DATA_CRON,
  SCHEDULED_REPORTS_CRON,
  SCHEDULED_SCANS_CRON,
} from "../src/scheduled-budget";
import type { Env } from "../src/types";

function configuredCronTriggers(): string[] {
  const wranglerToml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const triggerBlock = wranglerToml.match(/\[triggers\]\s*crons\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  return [...triggerBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("scheduled budget and lane helpers", () => {
  it("routes configured crons into isolated lanes and unknown crons to core", () => {
    expect(classifyScheduledCron(SCHEDULED_CORE_CRON)).toBe("core");
    expect(classifyScheduledCron(SCHEDULED_MARKET_DATA_CRON)).toBe("market-data");
    expect(classifyScheduledCron(SCHEDULED_SCANS_CRON)).toBe("scans");
    expect(classifyScheduledCron(SCHEDULED_MAINTENANCE_CRON)).toBe("maintenance");
    expect(classifyScheduledCron(SCHEDULED_REPORTS_CRON)).toBe("reports");
    expect(classifyScheduledCron("1 * * * *")).toBe("core");
    expect(classifyScheduledCron(undefined)).toBe("core");
  });

  it("keeps the deployed cron list in sync with wrangler.toml", () => {
    expect(configuredCronTriggers()).toEqual([...DEPLOYED_SCHEDULED_CRONS]);
  });

  it("runs scans and maintenance as explicit fallback lanes from the deployed core cron", () => {
    expect(scheduledLanesForCron(SCHEDULED_CORE_CRON)).toEqual(["core", "scans", "maintenance"]);
    expect(scheduledLanesForCron(SCHEDULED_MARKET_DATA_CRON)).toEqual(["market-data"]);
    expect(scheduledLanesForCron(SCHEDULED_REPORTS_CRON)).toEqual(["reports"]);
    expect(scheduledLanesForCron(SCHEDULED_SCANS_CRON)).toEqual(["scans"]);
    expect(scheduledLanesForCron(SCHEDULED_MAINTENANCE_CRON)).toEqual(["maintenance"]);
  });

  it("claims work while preserving the configured reserve", () => {
    const budget = new ScheduledBudget("reports", 35, 10);
    expect(budget.claim("overview", 8)).toBe(true);
    expect(budget.claim("commentary", 17)).toBe(true);
    expect(budget.snapshot()).toMatchObject({ usedUnits: 25, availableUnits: 0 });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(budget.claim("weekly", 1)).toBe(false);
    expect(warn).toHaveBeenCalledWith("scheduled job skipped by budget", expect.objectContaining({ jobKey: "weekly" }));
    warn.mockRestore();
  });

  it("loads lane-specific budget values from env", () => {
    const env = {
      SCHEDULED_REPORTS_BUDGET: "50",
      SCHEDULED_SUBREQUEST_RESERVE: "12",
    } as Env;
    const budget = createScheduledBudget(env, "reports");
    expect(budget.snapshot()).toMatchObject({ lane: "reports", maxUnits: 50, reserveUnits: 12, availableUnits: 38 });
  });

  it("uses defaults when budget environment values are unset or blank", () => {
    expect(createScheduledBudget({} as Env, "reports").snapshot()).toMatchObject({
      lane: "reports",
      maxUnits: 35,
      reserveUnits: 10,
      availableUnits: 25,
    });
    expect(createScheduledBudget({ SCHEDULED_REPORTS_BUDGET: " ", SCHEDULED_SUBREQUEST_RESERVE: "" } as Env, "reports").snapshot()).toMatchObject({
      lane: "reports",
      maxUnits: 35,
      reserveUnits: 10,
      availableUnits: 25,
    });
  });

  it("keeps fallback scan jobs on the scan budget after core work spends the core budget", () => {
    const coreBudget = createScheduledBudget({} as Env, "core");
    expect(coreBudget.claim("research-queue", 8)).toBe(true);
    expect(coreBudget.claim("watchlist-compiles", 8)).toBe(true);
    expect(coreBudget.claim("earnings-calendar", 8)).toBe(true);
    expect(coreBudget.claim("earnings-surprises", 8)).toBe(true);
    expect(coreBudget.claim("earnings-gaps", 8)).toBe(true);
    expect(coreBudget.claim("earnings-fundamentals-refresh", 8)).toBe(true);
    expect(coreBudget.claim("fundamentals-seed-queue", 8)).toBe(true);
    expect(coreBudget.snapshot()).toMatchObject({ usedUnits: 56, availableUnits: 4 });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(coreBudget.claim("social-alert-scrape", 8)).toBe(false);
    const scansBudget = createScheduledBudget({} as Env, "scans");
    expect(scansBudget.claim("social-alert-scrape", 8)).toBe(true);
    expect(scansBudget.snapshot()).toMatchObject({ usedUnits: 8, availableUnits: 12 });
    warn.mockRestore();
  });
});
