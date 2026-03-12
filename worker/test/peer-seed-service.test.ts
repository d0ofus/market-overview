import { describe, expect, it } from "vitest";
import { deriveSeedGroupSlug, deriveSeedGroupTitle, shouldKeepUsPeerCandidate } from "../src/peer-seed-service";

describe("peer seed service helpers", () => {
  it("prefers industry-based titles for seeded groups", () => {
    expect(deriveSeedGroupTitle({
      ticker: "AA",
      name: "Alcoa Corp",
      exchange: "NYSE",
      sector: "Materials",
      industry: "Aluminium",
      sharesOutstanding: null,
    }, "AA")).toBe("Aluminium");
  });

  it("falls back to sector and then ticker when source labels are missing", () => {
    expect(deriveSeedGroupTitle({
      ticker: "XYZ",
      name: "XYZ",
      exchange: "NYSE",
      sector: "Industrials",
      industry: null,
      sharesOutstanding: null,
    }, "XYZ")).toBe("Industrials");

    expect(deriveSeedGroupTitle({
      ticker: "XYZ",
      name: "XYZ",
      exchange: "NYSE",
      sector: null,
      industry: null,
      sharesOutstanding: null,
    }, "XYZ")).toBe("XYZ Fundamental Peers");
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
