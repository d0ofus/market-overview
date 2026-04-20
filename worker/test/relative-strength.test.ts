import { describe, expect, it } from "vitest";
import { buildRelativeStrengthCacheRows } from "../src/relative-strength";

function makeBars(values: number[], ticker: string, baseDate = new Date("2024-01-02T00:00:00Z")) {
  return values.map((close, index) => {
    const date = new Date(baseDate);
    date.setUTCDate(baseDate.getUTCDate() + index);
    return {
      ticker,
      date: date.toISOString().slice(0, 10),
      o: close,
      h: close,
      l: close,
      c: close,
    };
  });
}

describe("relative strength", () => {
  it("calculates RS values, new highs, and price-leading RS signals from aligned daily bars", () => {
    const benchmarkBars = makeBars(Array.from({ length: 260 }, (_, index) => 100 + index * 0.1), "SPY");
    const stockValues = Array.from({ length: 260 }, (_, index) => 80 + index * 0.4);
    stockValues[258] = 200;
    stockValues[259] = 199;
    benchmarkBars[259] = { ...benchmarkBars[259], o: 90, h: 90, l: 90, c: 90 };
    const stockBars = makeBars(stockValues, "NVDA");

    const rows = buildRelativeStrengthCacheRows(stockBars, benchmarkBars, {
      benchmarkTicker: "SPY",
      verticalOffset: 30,
      rsMaLength: 21,
      rsMaType: "EMA",
      newHighLookback: 252,
    });

    const latest = rows.at(-1);
    expect(latest).toBeTruthy();
    expect(latest?.ticker).toBe("NVDA");
    expect(latest?.benchmarkTicker).toBe("SPY");
    expect(latest?.rsClose).toBeCloseTo((199 / 90) * 3000, 6);
    expect(latest?.rsMa).not.toBeNull();
    expect(latest?.rsAboveMa).toBe(true);
    expect(latest?.rsNewHigh).toBe(true);
    expect(latest?.rsNewHighBeforePrice).toBe(true);
    expect(latest?.change1d).toBeCloseTo(((199 - 200) / 200) * 100, 6);
    expect(latest?.approxRsRating).toBeGreaterThanOrEqual(1);
    expect(latest?.approxRsRating).toBeLessThanOrEqual(99);
  });

  it("supports SMA mode and only flags bull crosses when the RS line moves through its MA", () => {
    const benchmarkBars = makeBars(Array.from({ length: 30 }, () => 100), "SPY");
    const stockBars = makeBars([
      90, 89, 88, 87, 86,
      85, 84, 83, 82, 81,
      80, 81, 82, 83, 84,
      85, 86, 87, 88, 89,
      90, 91, 92, 93, 94,
      95, 96, 97, 98, 99,
    ], "AAPL");

    const rows = buildRelativeStrengthCacheRows(stockBars, benchmarkBars, {
      benchmarkTicker: "SPY",
      verticalOffset: 30,
      rsMaLength: 5,
      rsMaType: "SMA",
      newHighLookback: 20,
    });

    expect(rows.some((row) => row.bullCross)).toBe(true);
    const firstCross = rows.find((row) => row.bullCross);
    expect(firstCross?.rsClose).not.toBeNull();
    expect(firstCross?.rsMa).not.toBeNull();
  });
});
