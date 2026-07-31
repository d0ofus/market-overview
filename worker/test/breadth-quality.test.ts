import { describe, expect, it } from "vitest";
import {
  breadthUniverseMemberCount,
  isCurrentUsableBreadthRow,
  isUsableBreadthRow,
  latestUsableBreadthDate,
} from "../src/breadth-quality";

describe("breadth publication quality", () => {
  it("fails closed on the production-shaped 24-member Russell snapshot", () => {
    const row = {
      universeId: "russell2000-core",
      asOfDate: "2026-04-17",
      advancers: 14,
      decliners: 10,
      unchanged: 0,
      metrics: { memberCount: 24, totalUniverseMembers: 24 },
    };
    expect(breadthUniverseMemberCount(row)).toBe(24);
    expect(isUsableBreadthRow(row)).toBe(false);
  });

  it("accepts a full Russell proxy and rejects a stale row in a current summary", () => {
    const current = {
      universeId: "russell2000-core",
      asOfDate: "2026-07-29",
      metrics: { memberCount: 1_900, totalUniverseMembers: 1_935, dataCoveragePct: 98.19 },
      provenance: { sourceAsOfDate: "2026-07-29" },
    };
    const stale = { ...current, asOfDate: "2026-07-28" };
    const latestDate = latestUsableBreadthDate([stale, current]);
    expect(latestDate).toBe("2026-07-29");
    expect(isCurrentUsableBreadthRow(current, latestDate)).toBe(true);
    expect(isCurrentUsableBreadthRow(stale, latestDate)).toBe(false);
  });

  it("rejects a valid-sized universe snapshot with insufficient current-session coverage", () => {
    expect(isUsableBreadthRow({
      universeId: "russell2000-core",
      asOfDate: "2026-07-29",
      metrics: { memberCount: 1_700, totalUniverseMembers: 1_935, dataCoveragePct: 87.86 },
    })).toBe(false);
  });

  it("rejects Russell snapshots with missing or stale source provenance", () => {
    const base = {
      universeId: "russell2000-core",
      asOfDate: "2026-07-29",
      metrics: { memberCount: 1_900, totalUniverseMembers: 1_935, dataCoveragePct: 98.19 },
    };
    expect(isUsableBreadthRow(base)).toBe(false);
    expect(isUsableBreadthRow({ ...base, provenance: { sourceAsOfDate: "2026-07-01" } })).toBe(false);
    expect(isUsableBreadthRow({ ...base, provenance: { sourceAsOfDate: "2026-07-20" } })).toBe(true);
  });
});
