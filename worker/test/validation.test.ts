import { describe, expect, it } from "vitest";
import {
  adminWorkerSchedulePatchSchema,
  correlationMatrixQuerySchema,
  correlationPairQuerySchema,
  groupPatchSchema,
  itemCreateSchema,
  scanPresetPatchSchema,
  scanPresetRuleSchema,
} from "../src/validation";

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

  it("accepts null benchmark tickers in scan preset patches", () => {
    const parsed = scanPresetPatchSchema.parse({
      name: "Top Gainers Copy",
      benchmarkTicker: null,
    });

    expect(parsed.benchmarkTicker).toBeUndefined();
  });

  it("parses and normalizes correlation matrix queries", () => {
    const parsed = correlationMatrixQuerySchema.parse({
      tickers: "spy, qqq, spy, iwm",
      lookback: "120D",
    });

    expect(parsed).toEqual({
      tickers: ["SPY", "QQQ", "IWM"],
      lookback: "120D",
    });
  });

  it("rejects correlation pair queries when rolling window exceeds lookback", () => {
    expect(() =>
      correlationPairQuerySchema.parse({
        left: "AAPL",
        right: "MSFT",
        lookback: "60D",
        rollingWindow: "120D",
      })
    ).toThrow("Rolling window cannot be larger than the selected lookback.");
  });

  it("validates worker schedule runtime controls", () => {
    const parsed = adminWorkerSchedulePatchSchema.parse({
      id: "default",
      rsBackgroundEnabled: true,
      rsBackgroundBatchSize: 40,
      rsBackgroundMaxBatchesPerTick: 12,
      rsBackgroundTimeBudgetMs: 12000,
      postCloseBarsEnabled: true,
      postCloseBarsOffsetMinutes: 60,
      postCloseBarsBatchSize: 400,
      postCloseBarsMaxBatchesPerTick: 4,
    });

    expect(parsed.rsBackgroundBatchSize).toBe(40);
    expect(parsed.rsBackgroundMaxBatchesPerTick).toBe(12);
    expect(parsed.postCloseBarsOffsetMinutes).toBe(60);
  });
});
