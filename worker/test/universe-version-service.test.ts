import { describe, expect, it } from "vitest";
import { validateUniverseCandidate } from "../src/universe-version-service";

function tickers(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

describe("universe candidate validation", () => {
  it("rejects an implausibly small Russell proxy", () => {
    const result = validateUniverseCandidate({
      universeId: "russell2000-core",
      tickers: tickers("R", 24),
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("1800-2100");
  });

  it("rejects a large S&P membership change unless explicitly approved", () => {
    const previous = tickers("OLD", 500);
    const candidate = [...previous.slice(0, 450), ...tickers("NEW", 50)];
    expect(validateUniverseCandidate({
      universeId: "sp500-core",
      tickers: candidate,
      previousTickers: previous,
    }).valid).toBe(false);
    expect(validateUniverseCandidate({
      universeId: "sp500-core",
      tickers: candidate,
      previousTickers: previous,
      approveLargeChange: true,
    }).valid).toBe(true);
  });
});
