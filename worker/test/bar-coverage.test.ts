import { describe, expect, it } from "vitest";
import {
  countExpectedUsMarketSessions,
  coverageSatisfiesHistory,
  firstExpectedUsMarketSession,
} from "../src/bar-coverage";

describe("canonical bar coverage", () => {
  it("counts market sessions rather than calendar days", () => {
    expect(countExpectedUsMarketSessions("2026-07-02", "2026-07-06")).toBe(2);
  });

  it("uses the first expected trading session when a requested range starts on a weekend", () => {
    expect(firstExpectedUsMarketSession("2026-04-05", "2026-04-10")).toBe("2026-04-06");
  });

  it("does not treat internal gaps as complete history", () => {
    expect(coverageSatisfiesHistory({
      ticker: "SPY",
      feed: "sip",
      requestedStart: "2026-07-01",
      observedStart: "2026-07-01",
      observedEnd: "2026-07-10",
      observedSessions: 6,
      expectedSessions: 7,
      missingSessions: 1,
      status: "gaps",
    })).toBe(false);
  });

  it("accepts a contiguous shorter listing history", () => {
    expect(coverageSatisfiesHistory({
      ticker: "NEW",
      feed: "sip",
      requestedStart: "2025-01-01",
      observedStart: "2026-07-01",
      observedEnd: "2026-07-10",
      observedSessions: 7,
      expectedSessions: 7,
      missingSessions: 0,
      status: "short-history",
    })).toBe(true);
  });

  it("does not let a lone current bar certify an incomplete history", () => {
    expect(coverageSatisfiesHistory({
      ticker: "SPY",
      feed: "sip",
      requestedStart: "2025-01-01",
      observedStart: "2026-07-10",
      observedEnd: "2026-07-10",
      observedSessions: 1,
      expectedSessions: 385,
      missingSessions: 384,
      status: "short-history",
    })).toBe(false);
  });
});
