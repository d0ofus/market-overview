import { describe, expect, it, vi } from "vitest";
import { createResearchProgressPump } from "../src/research/stream-progress";

describe("research stream progress pump", () => {
  it("runs progress work as a single flight until the current pass finishes", async () => {
    let resolveWork: (() => void) | null = null;
    let callCount = 0;
    const work = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<void>((resolve) => {
          resolveWork = resolve;
        });
      }
      return Promise.resolve();
    });
    const pump = createResearchProgressPump(work);

    const first = pump.start();
    const second = pump.start();

    expect(first).toBe(second);
    expect(work).toHaveBeenCalledTimes(1);
    expect(pump.isInFlight()).toBe(true);

    resolveWork?.();
    await first;

    expect(pump.isInFlight()).toBe(false);
    await pump.start();
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("captures background progress errors and rethrows them to the stream loop", async () => {
    const pump = createResearchProgressPump(async () => {
      throw new Error("synthetic progress failure");
    });

    await pump.start();

    expect(() => pump.throwIfErrored()).toThrow("synthetic progress failure");
    expect(() => pump.throwIfErrored()).not.toThrow();
  });
});
