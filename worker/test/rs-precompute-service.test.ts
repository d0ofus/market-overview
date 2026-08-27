import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, WorkerScheduleSettings } from "../src/types";

const serviceMocks = vi.hoisted(() => ({
  createScheduledRelativeStrengthRun: vi.fn(),
  listActiveRelativeStrengthPrecomputePresets: vi.fn(),
  loadLatestCompletedManualRelativeStrengthRunForConfig: vi.fn(),
  loadStoredMarketSession: vi.fn(),
  loadScannerCacheCapacity: vi.fn(),
  hasMatchingRelativeStrengthPublication: vi.fn(),
  publishRelativeStrengthPresetFromCompletedRun: vi.fn(),
}));

vi.mock("../src/market-calendar", () => ({
  latestUsMarketSessionAsOfDate: () => "2026-08-25",
}));

vi.mock("../src/market-calendar-cache", () => ({
  loadStoredMarketSession: serviceMocks.loadStoredMarketSession,
}));

vi.mock("../src/scans-page-service", () => ({
  createScheduledRelativeStrengthRun: serviceMocks.createScheduledRelativeStrengthRun,
  listActiveRelativeStrengthPrecomputePresets: serviceMocks.listActiveRelativeStrengthPrecomputePresets,
  loadLatestCompletedManualRelativeStrengthRunForConfig: serviceMocks.loadLatestCompletedManualRelativeStrengthRunForConfig,
  loadScannerCacheCapacity: serviceMocks.loadScannerCacheCapacity,
  hasMatchingRelativeStrengthPublication: serviceMocks.hasMatchingRelativeStrengthPublication,
  publishRelativeStrengthPresetFromCompletedRun: serviceMocks.publishRelativeStrengthPresetFromCompletedRun,
  relativeStrengthPrecomputeBenchmarkDataTicker: () => "SPY",
  relativeStrengthPrecomputeConfigKey: () => "SPY|EMA|21|252",
  relativeStrengthPrecomputeRequiredBarCount: () => 520,
}));

import {
  groupRelativeStrengthPrecomputeConfigs,
  planScheduledRelativeStrengthPrecompute,
  postCloseBarsAreReady,
} from "../src/rs-precompute-service";
import { isPostCloseBarsWindowOpen } from "../src/worker-schedule-service";

describe("post-close relative strength precompute gates", () => {
  const completeJob = {
    id: "bars-2026-08-25",
    status: "completed",
    totalTickers: 2_900,
    processedTickers: 2_900,
    missingCurrentDateTickers: 0,
    currentDateCoveragePct: 100,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.loadStoredMarketSession.mockResolvedValue({ closeAt: "16:00" });
    serviceMocks.listActiveRelativeStrengthPrecomputePresets.mockResolvedValue([{ id: "rs", newHighLookback: 252 }]);
    serviceMocks.loadLatestCompletedManualRelativeStrengthRunForConfig.mockResolvedValue({ id: "ready" });
    serviceMocks.loadScannerCacheCapacity.mockResolvedValue({ status: "ok", sizeBytes: 1, warnBytes: 10, haltBytes: 20 });
    serviceMocks.hasMatchingRelativeStrengthPublication.mockResolvedValue(true);
  });

  it("does not open before close plus the configured offset", () => {
    expect(isPostCloseBarsWindowOpen(new Date("2026-08-25T20:34:59Z"), "2026-08-25", 35, "16:00")).toBe(false);
    expect(isPostCloseBarsWindowOpen(new Date("2026-08-25T20:35:00Z"), "2026-08-25", 35, "16:00")).toBe(true);
  });

  it("rejects no bars and incomplete coverage", () => {
    expect(postCloseBarsAreReady(null)).toBe(false);
    expect(postCloseBarsAreReady({ ...completeJob, totalTickers: 0, processedTickers: 0 })).toBe(false);
    expect(postCloseBarsAreReady({ ...completeJob, currentDateCoveragePct: 99.9 })).toBe(false);
    expect(postCloseBarsAreReady({ ...completeJob, missingCurrentDateTickers: 1 })).toBe(false);
  });

  it("accepts only the exact completed 100 percent state", () => {
    expect(postCloseBarsAreReady(completeJob)).toBe(true);
  });

  it("groups same-config presets idempotently", () => {
    const presets = [
      { id: "a", config: "SPY|EMA|21|252" },
      { id: "b", config: "SPY|EMA|21|252" },
      { id: "c", config: "QQQ|EMA|21|252" },
    ];
    const first = groupRelativeStrengthPrecomputeConfigs(presets, (preset) => preset.config);
    const second = groupRelativeStrengthPrecomputeConfigs(presets, (preset) => preset.config);
    expect([...first.keys()]).toEqual(["SPY|EMA|21|252", "QQQ|EMA|21|252"]);
    expect([...second.keys()]).toEqual([...first.keys()]);
    expect(first.get("SPY|EMA|21|252")?.id).toBe("a");
  });

  it("reads post-close state from OPS_DB and benchmark bars from MARKET_DATA_DB", async () => {
    const corePrepare = vi.fn(() => {
      throw new Error("core DB must not be queried for market-data state");
    });
    const marketPrepare = vi.fn(() => {
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => ({ latestDate: "2026-08-25", barCount: 520 })),
      };
      return statement;
    });
    const opsPrepare = vi.fn(() => {
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => completeJob),
      };
      return statement;
    });
    const env = {
      DB: { prepare: corePrepare } as unknown as D1Database,
      MARKET_DATA_DB: { prepare: marketPrepare } as unknown as D1Database,
      OPS_DB: { prepare: opsPrepare } as unknown as D1Database,
      SCANNER_CACHE_DB: {} as D1Database,
      MARKET_DATA_DB_REQUIRED: "true",
      OPS_DB_REQUIRED: "true",
    } as Env;
    const settings = {
      postCloseBarsEnabled: true,
      postCloseBarsOffsetMinutes: 35,
      rsBackgroundEnabled: true,
    } as WorkerScheduleSettings;

    const result = await planScheduledRelativeStrengthPrecompute(env, new Date("2026-08-25T21:00:00Z"), settings);

    expect(result.status).toBe("already-ready");
    expect(serviceMocks.loadLatestCompletedManualRelativeStrengthRunForConfig)
      .toHaveBeenCalledWith(env, "SPY|EMA|21|252", "2026-08-25", "scheduled");
    expect(corePrepare).not.toHaveBeenCalled();
    expect(marketPrepare).toHaveBeenCalledOnce();
    expect(opsPrepare).toHaveBeenCalledOnce();
  });

  it("does not create a scheduled run at the capacity halt threshold", async () => {
    serviceMocks.loadScannerCacheCapacity.mockResolvedValue({ status: "halt", sizeBytes: 20, warnBytes: 10, haltBytes: 20 });
    const env = { DB: {}, MARKET_DATA_DB: {}, SCANNER_CACHE_DB: {} } as Env;
    const result = await planScheduledRelativeStrengthPrecompute(env, new Date("2026-08-25T21:00:00Z"), {
      postCloseBarsEnabled: true, rsBackgroundEnabled: true,
    } as WorkerScheduleSettings);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("capacity halt");
    expect(serviceMocks.createScheduledRelativeStrengthRun).not.toHaveBeenCalled();
  });

  it("republishes every current same-config preset before declaring a completed scheduled run ready", async () => {
    const presets = [{ id: "rs-a" }, { id: "rs-b" }];
    serviceMocks.listActiveRelativeStrengthPrecomputePresets.mockResolvedValue(presets);
    serviceMocks.loadLatestCompletedManualRelativeStrengthRunForConfig.mockResolvedValue({
      id: "run-ready", status: "completed", configKey: "SPY|EMA|21|252", expectedTradingDate: "2026-08-25",
    });
    serviceMocks.hasMatchingRelativeStrengthPublication.mockImplementation(async (_env, presetId) => presetId === "rs-a");
    const marketPrepare = vi.fn(() => {
      const statement = { bind: vi.fn(() => statement), first: vi.fn(async () =>
        ({ latestDate: "2026-08-25", barCount: 520 })) };
      return statement;
    });
    const opsPrepare = vi.fn(() => {
      const statement = { bind: vi.fn(() => statement), first: vi.fn(async () => completeJob) };
      return statement;
    });
    const env = {
      MARKET_DATA_DB: { prepare: marketPrepare },
      OPS_DB: { prepare: opsPrepare },
      OPS_DB_REQUIRED: "true",
      SCANNER_CACHE_DB: {},
    } as unknown as Env;
    const result = await planScheduledRelativeStrengthPrecompute(env, new Date("2026-08-25T21:00:00Z"), {
      postCloseBarsEnabled: true, postCloseBarsOffsetMinutes: 35, rsBackgroundEnabled: true,
    } as WorkerScheduleSettings);
    expect(result.status).toBe("already-ready");
    expect(serviceMocks.publishRelativeStrengthPresetFromCompletedRun).toHaveBeenCalledOnce();
    expect(serviceMocks.publishRelativeStrengthPresetFromCompletedRun.mock.calls[0][1]).toBe(presets[1]);
  });
});
