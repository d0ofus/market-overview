import { describe, expect, it } from "vitest";
import {
  buildVcpFeatureRow,
  requiredVcpBarCount,
  DEFAULT_VCP_CONFIG,
  type VcpDailyBar,
} from "../src/vcp";

function makeWeekdayBars(count: number): VcpDailyBar[] {
  const dates: string[] = [];
  const cursor = new Date("2026-04-24T00:00:00Z");
  while (dates.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return dates.reverse().map((date, index) => {
    const close = 50 + index * 0.09;
    const isPriorPivot = index === 430;
    return {
      ticker: "VCPX",
      date,
      o: close - 0.2,
      h: isPriorPivot ? 100 : close + 0.5,
      l: close - 1,
      c: close,
      volume: 1_500_000 - index * 1_000,
    };
  });
}

describe("VCP feature computation", () => {
  it("matches the Pine VCP checks for pivot, trend template, weekly high, higher lows, and volume dry-up", () => {
    const feature = buildVcpFeatureRow(makeWeekdayBars(520), DEFAULT_VCP_CONFIG);

    expect(feature).not.toBeNull();
    expect(feature?.tradingDate).toBe("2026-04-24");
    expect(feature?.dailyPivot).toBe(100);
    expect(feature?.weeklyHigh).toBe(100);
    expect(feature?.trendScore).toBe(10);
    expect(feature?.trendTemplate).toBe(true);
    expect(feature?.pivotStable).toBe(true);
    expect(feature?.dailyNear).toBe(true);
    expect(feature?.weeklyNear).toBe(true);
    expect(feature?.higherLows).toBe(true);
    expect(feature?.volumeContracting).toBe(true);
    expect(feature?.vcpSignal).toBe(true);
  });

  it("keeps the default required depth aligned with the shared daily bar cache depth", () => {
    expect(requiredVcpBarCount(DEFAULT_VCP_CONFIG)).toBe(520);
  });

  it("honors customizable near-pivot thresholds", () => {
    const feature = buildVcpFeatureRow(makeWeekdayBars(520), {
      ...DEFAULT_VCP_CONFIG,
      dailyNearPct: 1,
    });

    expect(feature?.dailyNear).toBe(false);
    expect(feature?.vcpSignal).toBe(false);
  });
});
