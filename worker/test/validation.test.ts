import { describe, expect, it } from "vitest";
import { groupPatchSchema, itemCreateSchema } from "../src/validation";

describe("validation", () => {
  it("validates group patch", () => {
    const parsed = groupPatchSchema.parse({
      title: "Sector ETFs",
      rankingWindowDefault: "1W",
      showSparkline: true,
      pinTop10: false,
      columns: ["ticker", "1W"],
    });
    expect(parsed.title).toBe("Sector ETFs");
  });

  it("uppercases ticker symbols", () => {
    const parsed = itemCreateSchema.parse({
      ticker: "spy",
      displayName: null,
      tags: [],
    });
    expect(parsed.ticker).toBe("SPY");
  });
});
