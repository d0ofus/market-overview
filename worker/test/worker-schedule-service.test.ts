import { describe, expect, it, vi } from "vitest";
import {
  boundPostCloseProviderWork,
  buildPostCloseDailyBarUniverseQuery,
  classifyPostCloseError,
  isPostCloseJobComplete,
  isPostCloseBarsWindowOpen,
  loadWorkerScheduleSettings,
  planPostCloseBudgetProtection,
  planPostCloseProviderBatch,
  planPostCloseJobItemMaterialization,
  postCloseInvocationBatchPlan,
  postCloseJobIdentity,
  shouldUseYahooRepair,
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
    sourceProvider: "alpaca",
    sourceFeed: "sip",
    adjustment: "split",
    requestEnd: null,
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
    expect(resolvePostCloseBudgetProtection({
      now,
      expectedTradingDate,
      settings,
      job: postCloseJob({
        status: "failed",
        errorCode: "auth-blocked",
        error: "subscription does not permit querying recent SIP data",
      }),
    })).toMatchObject({ protect: true, reason: "data-not-ready" });
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

  it("reads post-close state from the operations binding without schema writes", async () => {
    const completed = postCloseJob({ status: "completed", completedAt: "2026-07-16T21:10:00.000Z" });
    let primaryPrepareCalls = 0;
    let opsPrepareCalls = 0;
    let marketPrepareCalls = 0;
    const primaryDb = {
      prepare() {
        primaryPrepareCalls += 1;
        throw new Error("primary DB should not be queried");
      },
    } as unknown as D1Database;
    const opsDb = {
      prepare() {
        opsPrepareCalls += 1;
        const statement = {
          bind: (..._args: unknown[]) => statement,
          async first<T>() {
            return { ...completed, leaseExpiresAt: null } as T;
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const marketDataDb = {
      prepare() {
        marketPrepareCalls += 1;
        const statement = {
          bind: (..._args: unknown[]) => statement,
          async first<T>() {
            return null as T;
          },
        };
        return statement;
      },
    } as unknown as D1Database;

    const decision = await planPostCloseBudgetProtection(
      {
        DB: primaryDb,
        MARKET_DATA_DB: marketDataDb,
        MARKET_DATA_DB_REQUIRED: "true",
        OPS_DB: opsDb,
        OPS_DB_REQUIRED: "true",
      } as Env,
      now,
      workerScheduleSettings(),
    );

    expect(decision).toMatchObject({ protect: false, reason: "completed" });
    expect(primaryPrepareCalls).toBe(0);
    expect(opsPrepareCalls).toBe(1);
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
      { DB: brokenDb, OPS_DB: brokenDb, OPS_DB_REQUIRED: "true" } as Env,
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

describe("post-close source identity", () => {
  it("creates a new resumable scope when the configured feed changes", () => {
    const iex = postCloseJobIdentity({ DATA_PROVIDER: "alpaca", ALPACA_DAILY_FEED: "iex", ALPACA_DAILY_ADJUSTMENT: "split" });
    const sip = postCloseJobIdentity({ DATA_PROVIDER: "alpaca", ALPACA_DAILY_FEED: "sip", ALPACA_DAILY_ADJUSTMENT: "split" });

    expect(iex.scope).not.toBe(sip.scope);
    expect(sip).toMatchObject({ provider: "alpaca", feed: "sip", adjustment: "split" });
  });
});

describe("worker schedule service", () => {
  it("returns default worker schedule values when no row exists yet", async () => {
    const env = createWorkerScheduleEnv();
    const settings = await loadWorkerScheduleSettings(env);

    expect(settings.id).toBe("default");
    expect(settings.cronExpression).toBe("*/15 * * * *");
    expect(settings.rsBackgroundEnabled).toBe(false);
    expect(settings.rsBackgroundBatchSize).toBe(50);
    expect(settings.postCloseBarsOffsetMinutes).toBe(30);
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

  it("resumes partially materialized post-close job items", () => {
    const universe = Array.from({ length: 750 }, (_, index) => ({
      ticker: `T${index}`,
      historyRequired: index < 25 ? 1 : 0,
    }));
    const existing = new Set(universe.slice(0, 500).map((row) => row.ticker));

    const missing = planPostCloseJobItemMaterialization(universe, existing);

    expect(missing).toHaveLength(250);
    expect(missing[0]).toEqual({ ticker: "T500", historyRequired: 0, ordinal: 500 });
    expect(missing.at(-1)).toEqual({ ticker: "T749", historyRequired: 0, ordinal: 749 });
  });

  it("requires the full materialized universe before completing a post-close job", () => {
    expect(isPostCloseJobComplete(5_885, 500, 0)).toBe(false);
    expect(isPostCloseJobComplete(5_885, 5_885, 1)).toBe(false);
    expect(isPostCloseJobComplete(5_885, 5_885, 0)).toBe(true);
  });

  it("opens normal and early-close sessions 35 minutes after the exchange close", () => {
    expect(isPostCloseBarsWindowOpen(new Date("2026-07-21T20:34:00Z"), "2026-07-21", 35)).toBe(false);
    expect(isPostCloseBarsWindowOpen(new Date("2026-07-21T20:35:00Z"), "2026-07-21", 35)).toBe(true);
    expect(isPostCloseBarsWindowOpen(new Date("2026-07-03T17:34:00Z"), "2026-07-03", 35, "13:00")).toBe(false);
    expect(isPostCloseBarsWindowOpen(new Date("2026-07-03T17:35:00Z"), "2026-07-03", 35, "13:00")).toBe(true);
  });

  it("reserves one bounded history slice alongside exact-session batches", () => {
    expect(postCloseInvocationBatchPlan({ batchSize: 80, maxBatches: 4 })).toEqual({
      exactBatchSize: 80,
      exactBatches: 4,
      historyBatchSize: 12,
      historyBatches: 1,
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
    expect(plan.refreshStartDate).toBe("2025-03-27");
  });

  it("always fills the exact completed session before repairing older history", () => {
    const items = [
      { ticker: "SPY", historyRequired: 1 },
      { ticker: "QQQ", historyRequired: 1 },
    ];
    const plan = planPostCloseProviderBatch({
      items,
      historyStates: new Map([["SPY", {
        ticker: "SPY",
        lookbackStart: "2025-01-01",
        throughDate: "2026-07-09",
      }]]),
      currentTickers: new Set(["SPY"]),
      tradingDate: "2026-07-10",
      batchSize: 80,
    });

    expect(plan.mode).toBe("exact");
    expect(plan.items).toEqual([{ ticker: "QQQ", historyRequired: 1 }]);
    expect(plan.refreshStartDate).toBe("2026-07-10");
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

  it("permits a bounded Yahoo repair only after three Alpaca attempts", () => {
    expect(shouldUseYahooRepair({ attemptCount: 2, hasCurrentSession: false, mode: "exact" })).toBe(false);
    expect(shouldUseYahooRepair({ attemptCount: 3, hasCurrentSession: false, mode: "exact" })).toBe(false);
    expect(shouldUseYahooRepair({ attemptCount: 3, hasCurrentSession: true, mode: "history" })).toBe(true);
    expect(shouldUseYahooRepair({ attemptCount: 3, hasCurrentSession: true, mode: "current" })).toBe(false);
  });

  it("classifies transient limits separately from authentication failures", () => {
    expect(classifyPostCloseError(new Error("Alpaca bars fetch failed (429)"))).toBe("rate-limited");
    expect(classifyPostCloseError(new Error(
      'Alpaca bars fetch failed (403): {"message":"subscription does not permit querying recent SIP data"}',
    ))).toBe("data-not-ready");
    expect(classifyPostCloseError(new Error("Alpaca bars fetch failed (403)"))).toBe("auth-blocked");
    expect(classifyPostCloseError(new Error("network timeout"))).toBe("provider-error");
  });
});
