import { describe, expect, it } from "vitest";
import { mergeMembershipSource, normalizePeerGroupType, slugifyPeerGroupName } from "../src/peer-groups-service";

describe("peer groups service helpers", () => {
  it("slugifies peer group names", () => {
    expect(slugifyPeerGroupName("AAPL Fundamental Peers")).toBe("aapl-fundamental-peers");
    expect(slugifyPeerGroupName("  Tech & Momentum  ")).toBe("tech-momentum");
  });

  it("normalizes peer group types", () => {
    expect(normalizePeerGroupType("technical")).toBe("technical");
    expect(normalizePeerGroupType("custom")).toBe("custom");
    expect(normalizePeerGroupType("anything-else")).toBe("fundamental");
  });

  it("preserves manual source precedence and combines seed sources into system", () => {
    expect(mergeMembershipSource("manual", "fmp_seed")).toBe("manual");
    expect(mergeMembershipSource("fmp_seed", "finnhub_seed")).toBe("system");
    expect(mergeMembershipSource(undefined, "finnhub_seed")).toBe("finnhub_seed");
  });
});

