import { describe, expect, it } from "vitest";
import {
  getUsMarketSessionContext,
  isUsMarketTradingDay,
  previousUsMarketTradingDay,
  usMarketHolidayName,
} from "../src/market-calendar";

describe("US market calendar", () => {
  it("recognizes Memorial Day as a closed cash-equity session", () => {
    expect(usMarketHolidayName("2026-05-25")).toBe("Memorial Day");
    expect(isUsMarketTradingDay("2026-05-25")).toBe(false);

    const context = getUsMarketSessionContext(new Date("2026-05-25T15:00:00Z"));
    expect(context.status).toBe("closed");
    expect(context.sessionDate).toBe("2026-05-22");
    expect(context.latestCompletedSessionDate).toBe("2026-05-22");
    expect(context.closedReason).toContain("Memorial Day");
  });

  it("walks back through holidays and weekends to the prior trading day", () => {
    expect(previousUsMarketTradingDay("2026-05-26")).toBe("2026-05-22");
    expect(previousUsMarketTradingDay("2026-05-31")).toBe("2026-05-29");
  });

  it("labels intraday and post-close sessions in New York time", () => {
    const intraday = getUsMarketSessionContext(new Date("2026-05-26T15:00:00Z"));
    expect(intraday.status).toBe("regular");
    expect(intraday.dataBasis).toBe("intraday");
    expect(intraday.sessionDate).toBe("2026-05-26");
    expect(intraday.latestCompletedSessionDate).toBe("2026-05-22");

    const postClose = getUsMarketSessionContext(new Date("2026-05-26T21:00:00Z"));
    expect(postClose.status).toBe("after_hours");
    expect(postClose.dataBasis).toBe("closing");
    expect(postClose.latestCompletedSessionDate).toBe("2026-05-26");
  });
});
