import { describe, expect, it } from "vitest";
import { evaluateOverviewGeneration } from "../src/overview-generation";

describe("overview generation promotion", () => {
  it("does not let lagging history block a normal generation", () => {
    expect(evaluateOverviewGeneration({
      hasReadyGeneration: true,
      criticalTickersPresent: true,
      currentCoveragePct: 96,
      historyCoveragePct: 40,
    }).publish).toBe(true);
  });

  it("publishes a degraded generation between 90 and 95 percent current coverage", () => {
    const decision = evaluateOverviewGeneration({
      hasReadyGeneration: true,
      criticalTickersPresent: true,
      currentCoveragePct: 90,
      historyCoveragePct: 100,
    });
    expect(decision).toMatchObject({ publish: true, degraded: true });
  });

  it("keeps the last-ready pointer below 90 percent current coverage", () => {
    const decision = evaluateOverviewGeneration({
      hasReadyGeneration: true,
      criticalTickersPresent: true,
      currentCoveragePct: 89.99,
      historyCoveragePct: 100,
    });
    expect(decision.publish).toBe(false);
    expect(decision.reason).toContain("last-ready generation retained");
  });

  it("never publishes without all supported critical current rows", () => {
    expect(evaluateOverviewGeneration({
      hasReadyGeneration: false,
      criticalTickersPresent: false,
      currentCoveragePct: 100,
      historyCoveragePct: 100,
    })).toMatchObject({ publish: false, bootstrap: false });
  });
});
