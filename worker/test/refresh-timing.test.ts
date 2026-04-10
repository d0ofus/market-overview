import { describe, expect, it } from "vitest";
import { latestUsSessionAsOfDate, shouldRunScheduledEod } from "../src/refresh-timing";

describe("refresh timing", () => {
  it("treats Saturday 08:15 Melbourne as the Friday US close refresh window", () => {
    const saturdayMelbourne = new Date("2026-03-21T08:15:00+11:00");
    expect(shouldRunScheduledEod(saturdayMelbourne, "Australia/Melbourne", "08:15")).toBe(true);
    expect(latestUsSessionAsOfDate(saturdayMelbourne)).toBe("2026-03-20");
  });

  it("does not open the window outside the configured 15 minute run slot", () => {
    const beforeWindow = new Date("2026-03-21T08:14:59+11:00");
    const afterWindow = new Date("2026-03-21T08:30:00+11:00");
    expect(shouldRunScheduledEod(beforeWindow, "Australia/Melbourne", "08:15")).toBe(false);
    expect(shouldRunScheduledEod(afterWindow, "Australia/Melbourne", "08:15")).toBe(false);
  });

  it("treats New York midnight as before the next US close", () => {
    const afterMidnightNewYork = new Date("2026-04-10T04:09:00Z");
    expect(latestUsSessionAsOfDate(afterMidnightNewYork)).toBe("2026-04-09");
  });
});
