import { describe, expect, it } from "vitest";
import { computeBreadthStats } from "../src/metrics";

describe("breadth computations", () => {
  it("computes breadth aggregates", () => {
    const stats = computeBreadthStats({
      AAA: Array.from({ length: 220 }, (_, i) => 100 + i),
      BBB: Array.from({ length: 220 }, (_, i) => 100 - i * 0.2),
      CCC: Array.from({ length: 220 }, () => 50),
    });
    expect(stats.advancers + stats.decliners + stats.unchanged).toBe(3);
    expect(stats.pctAbove50MA).toBeGreaterThanOrEqual(0);
    expect(stats.pctAbove50MA).toBeLessThanOrEqual(100);
  });
});
