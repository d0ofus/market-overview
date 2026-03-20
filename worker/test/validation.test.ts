import { describe, expect, it } from "vitest";
import { groupPatchSchema, itemCreateSchema, scanPresetRuleSchema } from "../src/validation";

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

  it("accepts scan rules that compare against another field with an optional multiplier", () => {
    const parsed = scanPresetRuleSchema.parse({
      id: "ema5-below-price",
      field: "EMA5",
      operator: "gte",
      value: {
        type: "field",
        field: "close",
        multiplier: 0.97,
      },
    });

    expect(parsed.value).toMatchObject({
      type: "field",
      field: "close",
      multiplier: 0.97,
    });
  });

  it("coerces field-comparison multipliers sent as strings", () => {
    const parsed = scanPresetRuleSchema.parse({
      id: "ema5-below-price-string",
      field: "EMA5",
      operator: "gte",
      value: {
        type: "field",
        field: " close ",
        multiplier: "0.97",
      },
    });

    expect(parsed.value).toMatchObject({
      type: "field",
      field: "close",
      multiplier: 0.97,
    });
  });
});
