import { describe, expect, it } from "vitest";
import { parseAlpacaCalendarRows } from "../src/market-calendar-cache";

describe("Alpaca market calendar", () => {
  it("retains early closes, sorts sessions and deduplicates identical dates", () => {
    expect(parseAlpacaCalendarRows([
      { date: "2026-11-27", open: "09:30", close: "13:00" },
      { date: "2026-11-25", open: "09:30", close: "16:00" },
      { date: "2026-11-27", open: "09:30", close: "13:00" },
    ])).toEqual([{ sessionDate: "2026-11-25", openAt: "09:30", closeAt: "16:00" },
      { sessionDate: "2026-11-27", openAt: "09:30", closeAt: "13:00" }]);
  });
  it.each([
    { date: "bad", open: "09:30", close: "16:00" },
    { date: "2026-02-30", open: "09:30", close: "16:00" },
    { date: "2026-11-28", open: "09:30", close: "16:00" },
    { date: "2026-11-27", open: "24:00", close: "16:00" },
    { date: "2026-11-27", open: "09:70", close: "16:00" },
    { date: "2026-11-27", open: "16:00", close: "09:30" },
  ])("rejects an invalid calendar response %#", (row) => {
    expect(() => parseAlpacaCalendarRows([row])).toThrow(/invalid session/);
  });
  it("rejects conflicting duplicate sessions and non-array responses", () => {
    expect(() => parseAlpacaCalendarRows([
      {date:"2026-11-27",open:"09:30",close:"13:00"},
      {date:"2026-11-27",open:"09:30",close:"16:00"},
    ])).toThrow(/conflicting/);
    expect(() => parseAlpacaCalendarRows({error:"unavailable"})).toThrow(/not an array/);
  });
});
