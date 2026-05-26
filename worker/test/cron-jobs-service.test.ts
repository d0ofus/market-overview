import { describe, expect, it } from "vitest";
import {
  loadCentralCronJobSettings,
  loadCentralCronJobSettingsMap,
  shouldRunCentralCronLocalTime,
  updateCentralCronJobSettings,
} from "../src/cron-jobs-service";
import type { Env } from "../src/types";

function createCronSettingsEnv(initial: Record<string, Record<string, unknown>> = {}): Env {
  const rows = new Map<string, Record<string, unknown>>(Object.entries(initial));
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (!sql.includes("FROM cron_job_settings")) return null as T;
                const key = String(args[0] ?? "");
                const values = rows.get(key);
                return values ? { key, valuesJson: JSON.stringify(values) } as T : null as T;
              },
              async all<T>() {
                if (!sql.includes("FROM cron_job_settings")) return { results: [] as T[] };
                return {
                  results: Array.from(rows.entries()).map(([key, values]) => ({
                    key,
                    valuesJson: JSON.stringify(values),
                  })) as T[],
                };
              },
              async run() {
                if (sql.includes("INSERT INTO cron_job_settings")) {
                  rows.set(String(args[0] ?? ""), JSON.parse(String(args[1] ?? "{}")) as Record<string, unknown>);
                }
                return {};
              },
            };
          },
          async run() {
            return {};
          },
        };
      },
    } as D1Database,
  } as Env;
}

describe("central cron job settings", () => {
  it("returns defaults when no cron settings rows exist", async () => {
    const env = createCronSettingsEnv();
    const settings = await loadCentralCronJobSettings(env, "earnings-gaps");

    expect(settings).toMatchObject({
      enabled: true,
      timezone: "America/New_York",
      localTime: "20:00",
      days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    });
  });

  it("normalizes persisted updates by field type", async () => {
    const env = createCronSettingsEnv();
    const updated = await updateCentralCronJobSettings(env, "etf-constituent-slice", {
      enabled: "false",
      staleDays: 120,
      batchLimit: 50,
    });

    expect(updated.enabled).toBe(false);
    expect(updated.staleDays).toBe(90);
    expect(updated.batchLimit).toBe(25);
  });

  it("loads all central cron jobs with stored overrides merged into defaults", async () => {
    const env = createCronSettingsEnv({
      "research-queue": { enabled: false, batchLimit: 4 },
    });
    const map = await loadCentralCronJobSettingsMap(env);

    expect(map.get("research-queue")).toMatchObject({ enabled: false, batchLimit: 4 });
    expect(map.get("social-alerts-housekeeping")).toMatchObject({ enabled: true, retentionDays: 10 });
  });

  it("checks local-time schedules with the selected timezone and weekday list", () => {
    const due = shouldRunCentralCronLocalTime(new Date("2026-05-22T00:00:00Z"), {
      enabled: true,
      timezone: "America/New_York",
      localTime: "20:00",
      days: ["Thursday"],
    }, { timezone: "America/New_York", localTime: "20:00" });

    expect(due).toBe(true);
  });
});

