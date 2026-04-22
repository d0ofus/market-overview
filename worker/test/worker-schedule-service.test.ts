import { describe, expect, it } from "vitest";
import { isPostCloseBarsWindowOpen, loadWorkerScheduleSettings, updateWorkerScheduleSettings } from "../src/worker-schedule-service";
import type { Env } from "../src/types";

type WorkerScheduleRowState = {
  id: string;
  rsBackgroundEnabled: number;
  rsBackgroundBatchSize: number;
  rsBackgroundMaxBatchesPerTick: number;
  rsBackgroundTimeBudgetMs: number;
  postCloseBarsEnabled: number;
  postCloseBarsOffsetMinutes: number;
  postCloseBarsBatchSize: number;
  postCloseBarsMaxBatchesPerTick: number;
};

function createWorkerScheduleEnv(initial?: Partial<WorkerScheduleRowState>): Env {
  let row: WorkerScheduleRowState | null = initial
    ? {
      id: initial.id ?? "default",
      rsBackgroundEnabled: initial.rsBackgroundEnabled ?? 1,
      rsBackgroundBatchSize: initial.rsBackgroundBatchSize ?? 20,
      rsBackgroundMaxBatchesPerTick: initial.rsBackgroundMaxBatchesPerTick ?? 20,
      rsBackgroundTimeBudgetMs: initial.rsBackgroundTimeBudgetMs ?? 15_000,
      postCloseBarsEnabled: initial.postCloseBarsEnabled ?? 1,
      postCloseBarsOffsetMinutes: initial.postCloseBarsOffsetMinutes ?? 60,
      postCloseBarsBatchSize: initial.postCloseBarsBatchSize ?? 400,
      postCloseBarsMaxBatchesPerTick: initial.postCloseBarsMaxBatchesPerTick ?? 4,
    }
    : null;

  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (!sql.includes("FROM worker_schedule_settings")) {
                  return null as T;
                }
                if (!row) {
                  return null as T;
                }
                return {
                  id: row.id,
                  rsBackgroundEnabled: row.rsBackgroundEnabled,
                  rsBackgroundBatchSize: row.rsBackgroundBatchSize,
                  rsBackgroundMaxBatchesPerTick: row.rsBackgroundMaxBatchesPerTick,
                  rsBackgroundTimeBudgetMs: row.rsBackgroundTimeBudgetMs,
                  postCloseBarsEnabled: row.postCloseBarsEnabled,
                  postCloseBarsOffsetMinutes: row.postCloseBarsOffsetMinutes,
                  postCloseBarsBatchSize: row.postCloseBarsBatchSize,
                  postCloseBarsMaxBatchesPerTick: row.postCloseBarsMaxBatchesPerTick,
                } as T;
              },
              async run() {
                if (sql.includes("INSERT OR IGNORE INTO worker_schedule_settings") && !row) {
                  row = {
                    id: String(args[0] ?? "default"),
                    rsBackgroundEnabled: 1,
                    rsBackgroundBatchSize: Number(args[1] ?? 20),
                    rsBackgroundMaxBatchesPerTick: Number(args[2] ?? 20),
                    rsBackgroundTimeBudgetMs: Number(args[3] ?? 15_000),
                    postCloseBarsEnabled: 1,
                    postCloseBarsOffsetMinutes: Number(args[4] ?? 60),
                    postCloseBarsBatchSize: Number(args[5] ?? 400),
                    postCloseBarsMaxBatchesPerTick: Number(args[6] ?? 4),
                  };
                }
                if (sql.includes("INSERT INTO worker_schedule_settings")) {
                  row = {
                    id: String(args[0] ?? "default"),
                    rsBackgroundEnabled: Number(args[1] ?? 1),
                    rsBackgroundBatchSize: Number(args[2] ?? 20),
                    rsBackgroundMaxBatchesPerTick: Number(args[3] ?? 20),
                    rsBackgroundTimeBudgetMs: Number(args[4] ?? 15_000),
                    postCloseBarsEnabled: Number(args[5] ?? 1),
                    postCloseBarsOffsetMinutes: Number(args[6] ?? 60),
                    postCloseBarsBatchSize: Number(args[7] ?? 400),
                    postCloseBarsMaxBatchesPerTick: Number(args[8] ?? 4),
                  };
                }
                return {};
              },
            };
          },
          async first<T>() {
            return null as T;
          },
          async run() {
            return {};
          },
        };
      },
      async batch() {
        return [];
      },
    } as D1Database,
  } as Env;
}

describe("worker schedule service", () => {
  it("returns default worker schedule values when no row exists yet", async () => {
    const env = createWorkerScheduleEnv();
    const settings = await loadWorkerScheduleSettings(env);

    expect(settings.id).toBe("default");
    expect(settings.cronExpression).toBe("*/15 * * * *");
    expect(settings.rsBackgroundEnabled).toBe(true);
    expect(settings.rsBackgroundBatchSize).toBe(20);
    expect(settings.postCloseBarsOffsetMinutes).toBe(60);
  });

  it("persists worker schedule updates", async () => {
    const env = createWorkerScheduleEnv();
    const updated = await updateWorkerScheduleSettings(env, {
      id: "default",
      rsBackgroundEnabled: false,
      rsBackgroundBatchSize: 40,
      rsBackgroundMaxBatchesPerTick: 8,
      rsBackgroundTimeBudgetMs: 12_000,
      postCloseBarsEnabled: true,
      postCloseBarsOffsetMinutes: 75,
      postCloseBarsBatchSize: 600,
      postCloseBarsMaxBatchesPerTick: 6,
    });

    expect(updated.rsBackgroundEnabled).toBe(false);
    expect(updated.rsBackgroundBatchSize).toBe(40);
    expect(updated.rsBackgroundMaxBatchesPerTick).toBe(8);
    expect(updated.postCloseBarsBatchSize).toBe(600);
    expect(updated.postCloseBarsOffsetMinutes).toBe(75);
  });

  it("opens the post-close bar window only after the configured offset", () => {
    const beforeOffset = new Date("2026-04-20T20:45:00Z");
    const afterOffset = new Date("2026-04-20T21:05:00Z");

    expect(isPostCloseBarsWindowOpen(beforeOffset, "2026-04-20", 60)).toBe(false);
    expect(isPostCloseBarsWindowOpen(afterOffset, "2026-04-20", 60)).toBe(true);
    expect(isPostCloseBarsWindowOpen(new Date("2026-04-21T12:00:00Z"), "2026-04-20", 60)).toBe(true);
  });
});
