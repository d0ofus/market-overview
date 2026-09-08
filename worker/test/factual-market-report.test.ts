import { describe, expect, it } from "vitest";
import { buildFactualDailyReport, buildFactualWeeklyReport, freeMarketReportEnv, summarizeVerifiedOverview } from "../src/factual-market-report";
import type { Env, SnapshotResponse } from "../src/types";

const evidence = { dashboardSummary: "- Sector ETFs: XLK: close 200.00, 1D N/A", fedWatchSummary: "Rate evidence unavailable.", sourceAudit: [], dataQuality: [] };
describe("factual market reports", () => {
  it("keeps every daily and weekly section without inventing missing metrics", () => {
    const daily = buildFactualDailyReport({ ...evidence, sessionDate: "2026-09-04", sessionLabel: "US close", reason: "Free AI quota exhausted." });
    const weekly = buildFactualWeeklyReport({ ...evidence, weekStart: "2026-08-31", weekEnd: "2026-09-04", reason: "Free AI unavailable.", recentDailyCommentarySummary: "" });
    expect(daily.match(/^## /gm)).toHaveLength(18);
    expect(weekly.match(/^## /gm)).toHaveLength(9);
    expect(daily).toContain("AI interpretation is unavailable");
    expect(daily).toContain("1D N/A");
    expect(daily).not.toContain("1D 0.00");
  });
  it("never falls back to the paid Gemini key or enables search grounding", () => {
    expect(() => freeMarketReportEnv({ GEMINI_API_KEY: "paid" } as Env)).toThrow("Free AI");
    expect(freeMarketReportEnv({ GEMINI_API_KEY: "paid", GEMINI_FREE_API_KEY: "free", GEMINI_SEARCH_GROUNDING_ENABLED: "true" } as Env))
      .toMatchObject({ GEMINI_API_KEY: "free", GEMINI_SEARCH_GROUNDING_ENABLED: "false" });
  });
  it("omits an older snapshot from current-session observations", () => {
    const summary = summarizeVerifiedOverview({ status: "ready", asOfDate: "2026-08-24" } as SnapshotResponse, "2026-09-04");
    expect(summary).toContain("2026-09-04 is unavailable");
    expect(summary).toContain("stored publication is dated 2026-08-24");
  });
});
