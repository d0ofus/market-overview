import { describe, expect, it } from "vitest";
import { evaluateOverviewGeneration } from "../src/overview-generation";

describe("overview generation promotion", () => {
  it("publishes only complete normal generations", () => {
    expect(evaluateOverviewGeneration({
      hasReadyGeneration: true,
      criticalTickersPresent: true,
      currentCoveragePct: 96,
      historyCoveragePct: 97,
    }).publish).toBe(true);
  });

  it("keeps the last-ready pointer when a replacement is partial", () => {
    const decision = evaluateOverviewGeneration({
      hasReadyGeneration: true,
      criticalTickersPresent: true,
      currentCoveragePct: 90,
      historyCoveragePct: 100,
    });
    expect(decision.publish).toBe(false);
    expect(decision.reason).toContain("last-ready generation retained");
  });

  it("allows only the documented first-generation bootstrap", () => {
    expect(evaluateOverviewGeneration({
      hasReadyGeneration: false,
      criticalTickersPresent: true,
      currentCoveragePct: 82,
      historyCoveragePct: 90,
    })).toMatchObject({ publish: true, bootstrap: true });
  });
});
