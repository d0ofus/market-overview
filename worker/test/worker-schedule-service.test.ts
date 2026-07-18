import { describe, expect, it, vi } from "vitest";
import {
  boundPostCloseProviderWork,
  buildPostCloseDailyBarUniverseQuery,
  classifyPostCloseError,
  isPostCloseBarsWindowOpen,
  loadWorkerScheduleSettings,
  planPostCloseBudgetProtection,
  planPostCloseProviderBatch,
  POST_CLOSE_SCOPE,
  resolvePostCloseBudgetProtection,
  updateWorkerScheduleSettings,
} from "../src/worker-schedule-service";
import type { Env, PostCloseDailyBarRefreshJob, WorkerScheduleSettings } from "../src/types";

type WorkerScheduleRowState = {
  id: string;
  rsBackgroundEnabled: number;
  rsBackgroundBatchSize: number;
  rsBackgroundMaxBatchesPerTick: number;
  rsBackgroundTimeBudgetMs: number;
  rsManualCacheReuseEnabled: number;
  rsSharedConfigSnapshotFanoutEnabled: number;
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
      rsBackgroundBatchSize: initial.rsBackgroundBatchSize ?? 50,
      rsBackgroundMaxBatchesPerTick: initial.rsBackgroundMaxBatchesPerTick ?? 20,
      rsBackgroundTimeBudgetMs: initial.rsBackgroundTimeBudgetMs ?? 15_000,
      rsManualCacheReuseEnabled: initial.rsManualCacheReuseEnabled ?? 1,
      rsSharedConfigSnapshotFanoutEnabled: initial.rsSharedConfigSnapshotFanoutEnabled ?? 1,
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
                  rsManualCacheReuseEnabled: row.rsManualCacheReuseEnabled,
                  rsSharedConfigSnapshotFanoutEnabled: row.rsSharedConfigSnapshotFanoutEnabled,
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
                    rsBackgroundBatchSize: Number(args[1] ?? 50),
                    rsBackgroundMaxBatchesPerTick: Number(args[2] ?? 20),
                    rsBackgroundTimeBudgetMs: Number(args[3] ?? 15_000),
                    rsManualCacheReuseEnabled: 1,
                    rsSharedConfigSnapshotFanoutEnabled: 1,
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
                    rsBackgroundBatchSize: Number(args[2] ?? 50),
                    rsBackgroundMaxBatchesPerTick: Number(args[3] ?? 20),
                    rsBackgroundTimeBudgetMs: Number(args[4] ?? 15_000),
                    rsManualCacheReuseEnabled: Number(args[5] ?? 1),
                    rsSharedConfigSnapshotFanoutEnabled: Number(args[6] ?? 1),
                    postCloseBarsEnabled: Number(args[7] ?? 1),
                    postCloseBarsOffsetMinutes: Number(args[8] ?? 60),
                    postCloseBarsBatchSize: Number(args[9] ?? 400),
                    postCloseBarsMaxBatchesPerTick: Number(args[10] ?? 4),
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
    } as unknown as D1Database,
  } as Env;
}

function workerScheduleSettings(overrides: Partial<WorkerScheduleSettings> = {}): WorkerScheduleSettings {
  return {
    id: "default",
    cronExpression: "*/15 * * * *",
    rsBackgroundEnabled: true,
    rsBackgroundBatchSize: 50,
    rsBackgroundMaxBatchesPerTick: 20,
    rsBackgroundTimeBudgetMs: 15_000,
    rsManualCacheReuseEnabled: true,
    rsSharedConfigSnapshotFanoutEnabled: true,
    postCloseBarsEnabled: true,
    postCloseBarsOffsetMinutes: 60,
    postCloseBarsBatchSize: 80,
    postCloseBarsMaxBatchesPerTick: 4,
    patternScanEnabled: true,
    patternScanOffsetMinutes: 75,
    patternScanBatchSize: 40,
    patternScanMaxBatchesPerTick: 4,
    ...overrides,
  };
}

function postCloseJob(overrides: Partial<PostCloseDailyBarRefreshJob> = {}): PostCloseDailyBarRefreshJob {
  return {
    id: "post-close-2026-07-16",
    tradingDate: "2026-07-16",
    scope: POST_CLOSE_SCOPE,
    status: "queued",
    startedAt: "2026-07-16T21:00:00.000Z",
    updatedAt: "2026-07-16T21:00:00.000Z",
    completedAt: null,
    error: null,
    totalTickers: 500,
    processedTickers: 0,
    cursorOffset: 0,
    fetchedRows: 0,
    writtenRows: 0,
    currentDateTickers: 0,
    missingCurrentDateTickers: 500,
    currentDateCoveragePct: 0,
    attemptCount: 0,
    nextAttemptAt: null,
    errorCode: null,
    ...overrides,
  };
}

describe("post-close budget protection", () => {
  const now = new Date("2026-07-16T21:17:00.000Z");
  const expectedTradingDate = "2026-07-16";

  it("protects missing, queued, running, and retryable post-close work", () => {
    const settings = workerScheduleSettings();

    expect(resolvePostCloseBudgetProtection({ now, expectedTradingDate, settings, job: null })).toMatchObject({
      protect: true,
      reason: "missing-job",
    });
    expect(resolvePostCloseBudgetProtection({ now, expectedTradingDate, settings, job: postCloseJob() })).toMatchObject({
      protect: true,
      reason: "actionable-job",
    });
    expect(resolvePostCloseBudgetProtection({
      now,
      expectedTradingDate,
      settings,
      job: postCloseJob({ status: "running" }),
    })).toMatchObject({ protect: true, reason: "actionable-job" });
    expect(resolvePostCloseBudgetProtection({
      now,
      expectedTradingDate,
      settings,
      job: postCloseJob({ status: "failed", errorCode: "provider-error", nextAttemptAt: "2026-07-16T21:16:00.000Z" }),
    })).toMatchObject({ protect: true, reason: "actionable-job" });
  });

  it("does not protect disabled, pre-window, completed, auth-blocked, or delayed work", () => {
    expect(resolvePostCloseBudgetProtection({
      now,
      expectedTradingDate,
      settings: workerScheduleSettings({ postCloseBarsEnabled: false }),
      job: null,
    })).toMatchObject({ protect: false, reason: "disabled" });
    expect(resolvePostCloseBudgetProtection({
      now: new Date("2026-07-16T20:45:00.000Z"),
      expectedTradingDate,
      settings: workerScheduleSettings(),
      job: null,
    })).toMatchObject({ protect: false, reason: "before-window" });
    expect(resolvePostCloseBudgetProtection({
      now,
      expectedTradingDate,
      settings: workerScheduleSettings(),
      job: postCloseJob({ status: "completed", completedAt: "2026-07-16T21:10:00.000Z" }),
    })).toMatchObject({ protect: false, reason: "completed" });
    expect(resolvePostCloseBudgetProtection({
      now,
      expectedTradingDate,
      settings: workerScheduleSettings(),
      job: postCloseJob({ status: "failed", errorCode: "auth-blocked" }),
    })).toMatchObject({ protect: false, reason: "auth-blocked" });
    expect(resolvePostCloseBudgetProtection({
      now,
      expectedTradingDate,
      settings: workerScheduleSettings(),
      job: postCloseJob({ nextAttemptAt: "2026-07-16T21:30:00.000Z" }),
    })).toMatchObject({ protect: false, reason: "retry-not-due" });
  });

  it("reads post-close state from the market-data binding without schema writes", async () => {
    const completed = postCloseJob({ status: "completed", completedAt: "2026-07-16T21:10:00.000Z" });
    let primaryPrepareCalls = 0;
    let marketPrepareCalls = 0;
    const primaryDb = {
      prepare() {
        primaryPrepareCalls += 1;
        throw new Error("primary DB should not be queried");
      },
    } as unknown as D1Database;
    const marketDataDb = {
      prepare() {
        marketPrepareCalls += 1;
        const statement = {
          bind: (..._args: unknown[]) => statement,
          async first<T>() {
            return { ...completed, leaseExpiresAt: null } as T;
          },
        };
        return statement;
      },
    } as unknown as D1Database;

    const decision = await planPostCloseBudgetProtection(
      { DB: primaryDb, MARKET_DATA_DB: marketDataDb } as Env,
      now,
      workerScheduleSettings(),
    );

    expect(decision).toMatchObject({ protect: false, reason: "completed" });
    expect(primaryPrepareCalls).toBe(0);
    expect(marketPrepareCalls).toBe(1);
  });

  it("protects post-close budget when the state diagnostic fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const brokenDb = {
      prepare() {
        throw new Error("D1 unavailable");
      },
    } as unknown as D1Database;

    const decision = await planPostCloseBudgetProtection(
      { DB: brokenDb, MARKET_DATA_DB: brokenDb } as Env,
      now,
      workerScheduleSettings(),
    );

    expect(decision).toMatchObject({
      protect: true,
      expectedTradingDate,
      reason: "diagnostic-failed",
    });
    expect(warn).toHaveBeenCalledWith(
      "post-close budget protection diagnostic failed",
      expect.objectContaining({ expectedTradingDate }),
    );
    warn.mockRestore();
  });
});

describe("worker schedule service", () => {
  it("returns default worker schedule values when no row exists yet", async () => {
    const env = createWorkerScheduleEnv();
    const settings = await loadWorkerScheduleSettings(env);

    expect(settings.id).toBe("default");
    expect(settings.cronExpression).toBe("*/15 * * * *");
    expect(settings.rsBackgroundEnabled).toBe(true);
    expect(settings.rsBackgroundBatchSize).toBe(50);
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
      rsManualCacheReuseEnabled: false,
      rsSharedConfigSnapshotFanoutEnabled: false,
      postCloseBarsEnabled: true,
      postCloseBarsOffsetMinutes: 75,
      postCloseBarsBatchSize: 600,
      postCloseBarsMaxBatchesPerTick: 6,
      patternScanEnabled: true,
      patternScanOffsetMinutes: 75,
      patternScanBatchSize: 40,
      patternScanMaxBatchesPerTick: 4,
    });

    expect(updated.rsBackgroundEnabled).toBe(false);
    expect(updated.rsBackgroundBatchSize).toBe(40);
    expect(updated.rsBackgroundMaxBatchesPerTick).toBe(8);
    expect(updated.rsManualCacheReuseEnabled).toBe(false);
    expect(updated.rsSharedConfigSnapshotFanoutEnabled).toBe(false);
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


describe("post-close daily bar universe", () => {
  it("uses an explicit overview-plus-common-stock scope and prioritizes configured overview tickers", () => {
    const query = buildPostCloseDailyBarUniverseQuery("batch");

    expect(POST_CLOSE_SCOPE).toBe("active-us-common-stocks-plus-overview");
    expect(query).toContain("dashboard_items");
    expect(query).toContain("0 as priority");
    expect(query).toContain("1 as priority");
    expect(query).toContain("UNION ALL");
    expect(query).toContain("Macro");
    expect(query).toContain("Equities");
    expect(query).toContain("ORDER BY priority ASC, ticker ASC");
  });

  it("hard-bounds Alpaca work per Worker invocation", () => {
    expect(boundPostCloseProviderWork({ batchSize: 2_000, maxBatches: 20 })).toEqual({
      batchSize: 80,
      maxBatches: 4,
    });
  });

  it("bootstraps unverified overview history in 25-symbol requests", () => {
    const items = Array.from({ length: 80 }, (_, index) => ({
      ticker: `ETF${index}`,
      historyRequired: 1,
    }));
    const plan = planPostCloseProviderBatch({
      items,
      historyStates: new Map(),
      tradingDate: "2026-07-10",
      batchSize: 80,
    });

    expect(plan.items).toHaveLength(25);
    expect(plan.refreshStartDate).toBe("2025-05-16");
  });

  it("uses incremental catch-up after overview history is verified", () => {
    const items = [{ ticker: "SPY", historyRequired: 1 }];
    const plan = planPostCloseProviderBatch({
      items,
      historyStates: new Map([[
        "SPY",
        { ticker: "SPY", lookbackStart: "2025-01-01", throughDate: "2026-07-08" },
      ]]),
      tradingDate: "2026-07-10",
      batchSize: 80,
    });

    expect(plan.items).toEqual(items);
    expect(plan.refreshStartDate).toBe("2026-07-09");
  });

  it("classifies transient limits separately from authentication failures", () => {
    expect(classifyPostCloseError(new Error("Alpaca bars fetch failed (429)"))).toBe("rate-limited");
    expect(classifyPostCloseError(new Error("Alpaca bars fetch failed (403)"))).toBe("auth-blocked");
    expect(classifyPostCloseError(new Error("network timeout"))).toBe("provider-error");
  });
});
