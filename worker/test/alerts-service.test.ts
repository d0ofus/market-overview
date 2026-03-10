import { describe, expect, it } from "vitest";
import { buildAlertDedupeSeed, normalizeAlertFilters } from "../src/alerts-service";

describe("alerts service helpers", () => {
  it("normalizes filter bounds and session values", () => {
    const normalized = normalizeAlertFilters({
      startDate: "2026-03-10",
      endDate: "2026-03-01",
      session: "invalid",
      limit: 5000,
    });
    expect(normalized.startDate).toBe("2026-03-01");
    expect(normalized.endDate).toBe("2026-03-10");
    expect(normalized.session).toBe("all");
    expect(normalized.limit).toBe(3000);
  });

  it("builds deterministic dedupe seeds", () => {
    const seedA = buildAlertDedupeSeed({
      messageId: "msg-1",
      ticker: "aapl",
      tradingDay: "2026-03-02",
      marketSession: "regular",
      alertType: "buy",
      strategyName: "Breakout",
      messageBody: "AAPL crossed above level",
      receivedAtUtc: "2026-03-02T14:45:12.000Z",
    });
    const seedB = buildAlertDedupeSeed({
      messageId: "msg-1",
      ticker: "AAPL",
      tradingDay: "2026-03-02",
      marketSession: "regular",
      alertType: "buy",
      strategyName: "Breakout",
      messageBody: "AAPL crossed above level",
      receivedAtUtc: "2026-03-02T14:45:59.000Z",
    });
    expect(seedA).toBe(seedB);
  });
});

