import { describe, expect, it, vi } from "vitest";
import {
  classifyScheduledCron,
  createScheduledBudget,
  ScheduledBudget,
  SCHEDULED_CORE_CRON,
  SCHEDULED_MAINTENANCE_CRON,
  SCHEDULED_MARKET_DATA_CRON,
  SCHEDULED_REPORTS_CRON,
  SCHEDULED_SCANS_CRON,
} from "../src/scheduled-budget";
import type { Env } from "../src/types";

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
});
