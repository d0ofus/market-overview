import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ advanceScannerCacheScanRuns: vi.fn() }));
vi.mock("../src/scans-page-service", () => ({ advanceScannerCacheScanRuns: mocks.advanceScannerCacheScanRuns }));

import { consumeScannerCacheWakeUps, parseScannerCacheWakeUp, reconcileScannerCacheRuns } from "../src/scanner-cache-runner-service";

const advanceScannerCacheScanRuns = mocks.advanceScannerCacheScanRuns;

function queueMessage(body: unknown, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

describe("scanner cache native queue runner", () => {
  beforeEach(() => advanceScannerCacheScanRuns.mockReset());

  it("rejects invalid and stale-version wake-ups without touching D1 advancement", async () => {
    expect(parseScannerCacheWakeUp({ version: 2, runId: "run-1", runType: "relative-strength" })).toBeNull();
    const message = queueMessage({ version: 1, runId: "", runType: "bad" });
    await consumeScannerCacheWakeUps({ messages: [message] } as any, { DB: {} } as any);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(advanceScannerCacheScanRuns).not.toHaveBeenCalled();
  });

  it("acks when disabled or when scanner-cache D1 is not bound", async () => {
    for (const env of [{ DB: {}, SCANNER_CACHE_DB: {} }, { DB: {}, SCANNER_CACHE_QUEUE_ENABLED: "true" }]) {
      const message = queueMessage({ version: 1, runId: "run-1", runType: "relative-strength" });
      await consumeScannerCacheWakeUps({ messages: [message] } as any, env as any);
      expect(message.ack).toHaveBeenCalledOnce();
    }
    expect(advanceScannerCacheScanRuns).not.toHaveBeenCalled();
  });

  it("targets one run and safely acks terminal, advanced, and duplicate deliveries", async () => {
    advanceScannerCacheScanRuns.mockResolvedValue({ errors: [], advanced: false, hasMore: false });
    const env = { DB: {}, SCANNER_CACHE_DB: {}, SCANNER_CACHE_QUEUE_ENABLED: "true" } as any;
    for (let index = 0; index < 2; index += 1) {
      const message = queueMessage({ version: 1, runId: "run-1", runType: "relative-strength" });
      await consumeScannerCacheWakeUps({ messages: [message] } as any, env);
      expect(message.ack).toHaveBeenCalledOnce();
    }
    expect(advanceScannerCacheScanRuns).toHaveBeenNthCalledWith(1, env, { runId: "run-1", maxRuns: 1 });
    expect(advanceScannerCacheScanRuns).toHaveBeenCalledTimes(2);
  });

  it("retries transient errors with bounded exponential delay", async () => {
    advanceScannerCacheScanRuns.mockResolvedValue({ errors: ["temporary"] });
    const message = queueMessage({ version: 1, runId: "run-1", runType: "vcp" }, 20);
    await consumeScannerCacheWakeUps({ messages: [message] } as any, {
      DB: {}, SCANNER_CACHE_DB: {}, SCANNER_CACHE_QUEUE_ENABLED: "true",
    } as any);
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("uses configured multi-batch reconciliation only when native Queue is disabled", async () => {
    advanceScannerCacheScanRuns.mockResolvedValue({ errors: [], hasMore: true });
    await reconcileScannerCacheRuns({ SCANNER_CACHE_DB: {} } as any, { maxBatches: 3, timeBudgetMs: 10_000, batchSize: 17 });
    expect(advanceScannerCacheScanRuns).toHaveBeenCalledTimes(3);
    advanceScannerCacheScanRuns.mockClear();
    await reconcileScannerCacheRuns({ SCANNER_CACHE_DB: {}, SCANNER_CACHE_QUEUE_ENABLED: "true", SCANNER_CACHE_SCAN_QUEUE: {} } as any,
      { maxBatches: 3, timeBudgetMs: 10_000, batchSize: 17 });
    expect(advanceScannerCacheScanRuns).toHaveBeenCalledOnce();
  });
});
