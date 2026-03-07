import { describe, expect, it } from "vitest";
import { classifyAlertTimestamp } from "../src/alerts-time";

describe("alerts session classification", () => {
  it("classifies regular session correctly", () => {
    const result = classifyAlertTimestamp("2026-03-02T14:45:00Z"); // 09:45 ET
    expect(result.marketSession).toBe("regular");
    expect(result.tradingDay).toBe("2026-03-02");
  });

  it("classifies premarket correctly", () => {
    const result = classifyAlertTimestamp("2026-03-02T12:00:00Z"); // 07:00 ET
    expect(result.marketSession).toBe("premarket");
    expect(result.tradingDay).toBe("2026-03-02");
  });

  it("classifies after-hours and rolls trading day forward after close", () => {
    const result = classifyAlertTimestamp("2026-03-02T22:30:00Z"); // 17:30 ET
    expect(result.marketSession).toBe("after-hours");
    expect(result.tradingDay).toBe("2026-03-03");
  });

  it("maps overnight alerts before 04:00 ET to prior weekday trading day", () => {
    const result = classifyAlertTimestamp("2026-03-02T07:00:00Z"); // 02:00 ET
    expect(result.marketSession).toBe("after-hours");
    expect(result.tradingDay).toBe("2026-02-27");
  });
});

