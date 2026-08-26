import { describe, expect, it, vi } from "vitest";
import { enqueueScannerCacheScanRun } from "../src/scans-page-service";

function d1() {
  return { prepare: () => ({ bind: () => ({ run: vi.fn().mockResolvedValue({}) }) }) };
}

describe("scanner cache native queue enqueue", () => {
  it("keeps native delivery disabled by default and tolerates a missing binding", async () => {
    const send = vi.fn();
    expect(await enqueueScannerCacheScanRun({ DB: {} as any, SCANNER_CACHE_DB: d1() as any,
      SCANNER_CACHE_SCAN_QUEUE: { send } as any } as any, "run-1", "relative-strength")).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("retains successful D1 work when native Queue send fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    await expect(enqueueScannerCacheScanRun({ DB: {} as any, SCANNER_CACHE_DB: d1() as any,
      SCANNER_CACHE_QUEUE_ENABLED: "true", SCANNER_CACHE_SCAN_QUEUE: { send } as any } as any,
    "run-1", "relative-strength", "scheduled")).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith({ version: 1, runId: "run-1", runType: "relative-strength" }, undefined);
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });
});
