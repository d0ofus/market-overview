import { describe, expect, it } from "vitest";
import {
  advanceRelativeStrengthState,
  bootstrapRelativeStrengthStateFromRatioRows,
  buildRelativeStrengthCacheRows,
  buildRelativeStrengthCacheRowsFromRatioRows,
  buildRelativeStrengthRatioRows,
} from "../src/relative-strength";

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

  it("keeps EMA incremental state in parity with the full-history recomputation", () => {
    const benchmarkBars = makeBars(Array.from({ length: 270 }, (_, index) => 100 + index * 0.15), "SPY");
    const stockBars = makeBars(Array.from({ length: 270 }, (_, index) => 75 + index * 0.38), "MSFT");
    const config = {
      benchmarkTicker: "SPY",
      verticalOffset: 0.01,
      rsMaLength: 21,
      rsMaType: "EMA" as const,
      newHighLookback: 252,
    };
    const ratioRows = buildRelativeStrengthRatioRows(stockBars, benchmarkBars, "SPY");
    const bootstrap = bootstrapRelativeStrengthStateFromRatioRows(
      ratioRows.slice(0, -1),
      config,
      { configKey: "SPY|EMA|21|252" },
    );
    expect(bootstrap).toBeTruthy();

    const advanced = advanceRelativeStrengthState(bootstrap!.state, ratioRows.at(-1)!, config);
    const expected = buildRelativeStrengthCacheRowsFromRatioRows(ratioRows, config).at(-1);

    expect(expected).toBeTruthy();
    expect(advanced.latestCacheRow.rsClose).toBeCloseTo(expected!.rsClose ?? 0, 10);
    expect(advanced.latestCacheRow.rsMa).toBeCloseTo(expected!.rsMa ?? 0, 10);
    expect(advanced.latestCacheRow.rsNewHigh).toBe(expected!.rsNewHigh);
    expect(advanced.latestCacheRow.rsNewHighBeforePrice).toBe(expected!.rsNewHighBeforePrice);
    expect(advanced.latestCacheRow.bullCross).toBe(expected!.bullCross);
    expect(advanced.latestCacheRow.approxRsRating).toBe(expected!.approxRsRating);
  });

  it("keeps SMA incremental state in parity with the full-history recomputation", () => {
    const benchmarkBars = makeBars(Array.from({ length: 70 }, () => 100), "SPY");
    const stockBars = makeBars(Array.from({ length: 70 }, (_, index) => 50 + Math.sin(index / 4) * 3 + index * 0.2), "AMD");
    const config = {
      benchmarkTicker: "SPY",
      verticalOffset: 0.01,
      rsMaLength: 10,
      rsMaType: "SMA" as const,
      newHighLookback: 30,
    };
    const ratioRows = buildRelativeStrengthRatioRows(stockBars, benchmarkBars, "SPY");
    const bootstrap = bootstrapRelativeStrengthStateFromRatioRows(
      ratioRows.slice(0, -1),
      config,
      { configKey: "SPY|SMA|10|30" },
    );
    expect(bootstrap).toBeTruthy();

    const advanced = advanceRelativeStrengthState(bootstrap!.state, ratioRows.at(-1)!, config);
    const expected = buildRelativeStrengthCacheRowsFromRatioRows(ratioRows, config).at(-1);

    expect(expected).toBeTruthy();
    expect(advanced.latestCacheRow.rsClose).toBeCloseTo(expected!.rsClose ?? 0, 10);
    expect(advanced.latestCacheRow.rsMa).toBeCloseTo(expected!.rsMa ?? 0, 10);
    expect(advanced.latestCacheRow.rsAboveMa).toBe(expected!.rsAboveMa);
    expect(advanced.latestCacheRow.bullCross).toBe(expected!.bullCross);
    expect(advanced.latestCacheRow.approxRsRating).toBe(expected!.approxRsRating);
  });
});
