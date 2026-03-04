import { describe, expect, it } from "vitest";
import { computeBreadthStats } from "../src/metrics";

describe("breadth computations", () => {
  it("computes breadth aggregates", () => {
    const stats = computeBreadthStats({
      AAA: { closes: Array.from({ length: 260 }, (_, i) => 100 + i), volumes: Array.from({ length: 260 }, () => 1_000_000) },
      BBB: { closes: Array.from({ length: 260 }, (_, i) => 100 - i * 0.2), volumes: Array.from({ length: 260 }, () => 900_000) },
      CCC: { closes: Array.from({ length: 260 }, () => 50), volumes: Array.from({ length: 260 }, () => 700_000) },
    });
    expect(stats.advancers + stats.decliners + stats.unchanged).toBe(3);
    expect(stats.memberCount).toBe(3);
    expect(stats.pctAbove5MA).toBeGreaterThanOrEqual(0);
    expect(stats.pctAbove200MA).toBeLessThanOrEqual(100);
    expect(stats.totalVolume).toBeGreaterThan(0);
    expect(stats.new52WHighs).toBeGreaterThanOrEqual(0);
    expect(stats.pctAbove50MA).toBeGreaterThanOrEqual(0);
    expect(stats.pctAbove50MA).toBeLessThanOrEqual(100);
  });
});
