import { describe, expect, it } from "vitest";
import { deriveSeedGroupSlug, deriveSeedGroupTitle, shouldKeepUsPeerCandidate } from "../src/peer-seed-service";

describe("peer seed service helpers", () => {
  it("prefers industry-based titles for seeded groups", () => {
    expect(deriveSeedGroupTitle({
      industry: "Aluminium",
    })).toBe("Aluminium");
  });

  it("does not fall back to sector or ticker-based labels", () => {
    expect(deriveSeedGroupTitle({
      industry: null,
    })).toBeNull();
  });

  it("builds shared industry slugs for seeded groups", () => {
    expect(deriveSeedGroupSlug("Aluminium")).toBe("fundamental-aluminium");
  });

  it("rejects foreign-suffixed peer symbols while allowing confirmed US class shares", () => {
    expect(shouldKeepUsPeerCandidate("CCC.L", null)).toBe(false);
    expect(shouldKeepUsPeerCandidate("HIVE.V", null)).toBe(false);
    expect(shouldKeepUsPeerCandidate("AEM.TO", "TSX")).toBe(false);
    expect(shouldKeepUsPeerCandidate("BRK.B", "NYSE")).toBe(true);
    expect(shouldKeepUsPeerCandidate("BRK.B", null)).toBe(false);
    expect(shouldKeepUsPeerCandidate("AAPL", null)).toBe(true);
  });
});
