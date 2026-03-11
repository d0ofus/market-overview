import { describe, expect, it } from "vitest";
import { extractPremarketSnapshotFromAlpacaSnapshot } from "../src/provider";

describe("extractPremarketSnapshotFromAlpacaSnapshot", () => {
  it("prefers minute bar data for premarket price and volume", () => {
    const snapshot = extractPremarketSnapshotFromAlpacaSnapshot({
      latestTrade: { p: 103.5 },
      minuteBar: { c: 104.25, v: 125000 },
      dailyBar: { c: 101.2, v: 3000000 },
      prevDailyBar: { c: 100 },
    });

    expect(snapshot).toEqual({
      price: 104.25,
      prevClose: 100,
      premarketPrice: 104.25,
      premarketVolume: 125000,
    });
  });

  it("falls back to latest trade when minute bar is unavailable", () => {
    const snapshot = extractPremarketSnapshotFromAlpacaSnapshot({
      latestTrade: { p: 51.1 },
      dailyBar: { c: 50.8, v: 900000 },
      prevDailyBar: { c: 48.5 },
    });

    expect(snapshot).toEqual({
      price: 51.1,
      prevClose: 48.5,
      premarketPrice: 51.1,
      premarketVolume: 0,
    });
  });

  it("returns null when required pricing fields are missing", () => {
    const snapshot = extractPremarketSnapshotFromAlpacaSnapshot({
      minuteBar: { c: 12.4, v: 5000 },
      dailyBar: { c: 12.1, v: 500000 },
    });

    expect(snapshot).toBeNull();
  });
});
