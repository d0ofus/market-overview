import { describe, expect, it } from "vitest";
import { deriveSeedGroupSlug, deriveSeedGroupTitle } from "../src/peer-seed-service";

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
});
