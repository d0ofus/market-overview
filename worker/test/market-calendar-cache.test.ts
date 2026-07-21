import { describe, expect, it } from "vitest";
import { parseAlpacaCalendarRows } from "../src/market-calendar-cache";

describe("Alpaca market calendar", () => {
  it("retains early close times and rejects malformed rows", () => {
    expect(parseAlpacaCalendarRows([
      { date: "2026-11-27", open: "09:30", close: "13:00" },
      { date: "bad", open: "09:30", close: "16:00" },
    ])).toEqual([{ sessionDate: "2026-11-27", openAt: "09:30", closeAt: "13:00" }]);
  });
});
