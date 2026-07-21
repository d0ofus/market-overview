import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, WorkerScheduleSettings } from "../src/types";
import worker from "../src/index";

const scheduledMocks = vi.hoisted(() => ({
  overviewCurrent: vi.fn(async () => undefined),
  postClose: vi.fn(async () => null),
  planPostClose: vi.fn(),
  symbolCatalog: vi.fn(async () => undefined),
  startAudit: vi.fn(async (_env: unknown, input: { jobKey: string }) => `audit-${input.jobKey}`),
  finishAudit: vi.fn(async () => undefined),
}));

const workerSchedule: WorkerScheduleSettings = {
  id: "default",
  cronExpression: "*/15 * * * *",
  rsBackgroundEnabled: true,
  rsBackgroundBatchSize: 50,
  rsBackgroundMaxBatchesPerTick: 20,
  rsBackgroundTimeBudgetMs: 15_000,
  rsManualCacheReuseEnabled: true,
  rsSharedConfigSnapshotFanoutEnabled: true,
  postCloseBarsEnabled: true,
  postCloseBarsOffsetMinutes: 20,
  postCloseBarsBatchSize: 80,
  postCloseBarsMaxBatchesPerTick: 4,
  patternScanEnabled: true,
  patternScanOffsetMinutes: 75,
  patternScanBatchSize: 40,
  patternScanMaxBatchesPerTick: 4,
};

vi.mock("../src/overview-current-data", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/overview-current-data")>(),
  maybeRunScheduledOverviewCurrentRefresh: scheduledMocks.overviewCurrent,
}));

vi.mock("../src/worker-schedule-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/worker-schedule-service")>(),
  loadWorkerScheduleSettings: vi.fn(async () => workerSchedule),
  maybeRunScheduledPostCloseDailyBarRefresh: scheduledMocks.postClose,
  planPostCloseBudgetProtection: scheduledMocks.planPostClose,
}));

vi.mock("../src/symbol-directory-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/symbol-directory-service")>(),
  maybeRunScheduledSymbolCatalogSync: scheduledMocks.symbolCatalog,
}));

vi.mock("../src/scheduled-job-audit", () => ({
  startScheduledJobRun: scheduledMocks.startAudit,
  finishScheduledJobRun: scheduledMocks.finishAudit,
}));

class FakeScheduledMarketDataDb {
  prepare(_sql: string) {
    const statement = {
      bind: (..._args: unknown[]) => statement,
      async first<T>() {
        return null as T;
      },
      async all<T>() {
        return { results: [] as T[] };
      },
      async run() {
        return { meta: { rows_written: 1 } };
      },
    };
    return statement;
  }
}

function scheduledEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    DB: new FakeScheduledMarketDataDb() as unknown as Env["DB"],
    ...overrides,
  } as unknown as Env;
}

async function runMarketDataLane(env = scheduledEnv()): Promise<void> {
  await worker.scheduled(
    {
      cron: "*/5 * * * *",
      scheduledTime: Date.parse("2026-07-16T21:00:00.000Z"),
    } as Parameters<typeof worker.scheduled>[0],
    env,
  );
}

describe("scheduled market-data lane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reserves a constrained lane budget for actionable post-close bars", async () => {
    scheduledMocks.planPostClose.mockResolvedValue({
      protect: true,
      expectedTradingDate: "2026-07-16",
      reason: "missing-job",
    });

    await runMarketDataLane(scheduledEnv({
      SCHEDULED_MARKET_DATA_BUDGET: "35",
      SCHEDULED_SUBREQUEST_RESERVE: "10",
    }));

    expect(scheduledMocks.overviewCurrent).not.toHaveBeenCalled();
    expect(scheduledMocks.postClose).toHaveBeenCalledOnce();
    expect(scheduledMocks.finishAudit).toHaveBeenCalledWith(
      expect.anything(),
      "audit-overview-current-data",
      "skipped",
      "Skipped to preserve market-data budget for actionable post-close daily bars.",
      expect.objectContaining({ postCloseReason: "missing-job" }),
    );
  });

  it("keeps overview-current running when the lane cannot afford post-close bars", async () => {
    scheduledMocks.planPostClose.mockResolvedValue({
      protect: true,
      expectedTradingDate: "2026-07-16",
      reason: "missing-job",
    });

    await runMarketDataLane(scheduledEnv({
      SCHEDULED_MARKET_DATA_BUDGET: "30",
      SCHEDULED_SUBREQUEST_RESERVE: "10",
    }));

    expect(scheduledMocks.overviewCurrent).toHaveBeenCalledOnce();
    expect(scheduledMocks.postClose).not.toHaveBeenCalled();
    expect(scheduledMocks.finishAudit).toHaveBeenCalledWith(
      expect.anything(),
      "audit-post-close-daily-bars",
      "skipped",
      "Skipped by scheduled budget.",
      expect.objectContaining({ postCloseReason: "missing-job", estimatedUnits: 24 }),
    );
  });

  it.each(["completed", "auth-blocked", "retry-not-due"] as const)(
    "does not charge budget for non-actionable post-close work (%s)",
    async (reason) => {
      scheduledMocks.planPostClose.mockResolvedValue({
        protect: false,
        expectedTradingDate: "2026-07-16",
        reason,
      });

      await runMarketDataLane(scheduledEnv({
        SCHEDULED_MARKET_DATA_BUDGET: "70",
        SCHEDULED_SUBREQUEST_RESERVE: "10",
      }));

      expect(scheduledMocks.overviewCurrent).toHaveBeenCalledOnce();
      expect(scheduledMocks.postClose).not.toHaveBeenCalled();
      expect(scheduledMocks.symbolCatalog).toHaveBeenCalledOnce();
      expect(scheduledMocks.finishAudit).toHaveBeenCalledWith(
        expect.anything(),
        "audit-post-close-daily-bars",
        "skipped",
        "Skipped because post-close daily bars are not actionable.",
        expect.objectContaining({ postCloseReason: reason }),
      );
      expect(scheduledMocks.finishAudit).toHaveBeenCalledWith(
        expect.anything(),
        "audit-etf-constituent-slice",
        "completed",
        null,
        expect.objectContaining({ budget: expect.objectContaining({ usedUnits: 48 }) }),
      );
    },
  );

  it("runs both critical jobs when the configured budget can fit both", async () => {
    scheduledMocks.planPostClose.mockResolvedValue({
      protect: true,
      expectedTradingDate: "2026-07-16",
      reason: "actionable-job",
    });

    await runMarketDataLane(scheduledEnv({
      SCHEDULED_MARKET_DATA_BUDGET: "70",
      SCHEDULED_SUBREQUEST_RESERVE: "10",
    }));

    expect(scheduledMocks.overviewCurrent).toHaveBeenCalledOnce();
    expect(scheduledMocks.postClose).toHaveBeenCalledOnce();
    expect(scheduledMocks.postClose.mock.invocationCallOrder[0]).toBeLessThan(
      scheduledMocks.overviewCurrent.mock.invocationCallOrder[0]!,
    );
    expect(scheduledMocks.finishAudit).toHaveBeenCalledWith(
      expect.anything(),
      "audit-refresh-job",
      "skipped",
      "Deferred while exact-session post-close bars are actionable.",
      expect.objectContaining({ postCloseReason: "actionable-job" }),
    );
  });
});
