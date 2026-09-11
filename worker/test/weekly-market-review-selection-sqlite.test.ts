import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLatestWeeklyMarketReview } from "../src/weekly-market-review-service";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("weekly report and current attempt selection against migrated SQLite", () => {
  let storage: ReturnType<typeof createSqliteD1>;
  const now = new Date("2026-09-12T05:00:00Z");
  beforeEach(() => {
    storage = createSqliteD1();
    storage.script(readFileSync(resolve("migrations/0071_weekly_market_reviews.sql"), "utf8"));
  });
  afterEach(() => storage.dispose());
  const insert = async (id: string, weekStart: string, weekEnd: string, generatedAt: string, status = "ready", provider = "gemini_fallback") => {
    await storage.db.prepare(`INSERT INTO weekly_market_reviews
      (id,week_start,week_end,generated_at,as_of,provider,model,generation_provider,generation_mode,status,title,
       review_markdown,error_message,created_at,updated_at)
      VALUES(?,?,?,?,?,'factual','verified',?,'manual_retry',?,?,?, ?,?,?)`)
      .bind(id, weekStart, weekEnd, generatedAt, generatedAt, provider, status, `Weekly ${id}`, `Report ${id}`,
        status === "failed" ? "Generation timed out" : null, generatedAt, generatedAt).run();
  };

  it("keeps a current-week failed attempt separate from the dated last successful week", async () => {
    await insert("last-good", "2026-08-31", "2026-09-04", "2026-09-05T04:30:00Z");
    await insert("failed-current", "2026-09-07", "2026-09-11", "2026-09-12T04:30:00Z", "failed");
    const result = await loadLatestWeeklyMarketReview({ DB: storage.db } as Env, now);
    expect(result).toMatchObject({ status: "failed", report: { id: "last-good", weekEnd: "2026-09-04", generatedAt: "2026-09-05T04:30:00Z" },
      expectedWeek: { weekStart: "2026-09-07", weekEnd: "2026-09-11" },
      latestAttempt: { status: "failed", weekStart: "2026-09-07", weekEnd: "2026-09-11", attemptedAt: "2026-09-12T04:30:00Z" } });
    expect(result.warning).toContain("2026-09-07 to 2026-09-11 failed");
    expect(result.warning).toContain("successful report for 2026-08-31 to 2026-09-04");
  });

  it("retains a preferred current report while exposing a later failed retry", async () => {
    await insert("current-ready", "2026-09-07", "2026-09-11", "2026-09-12T04:00:00Z", "ready", "hermes_gpt");
    await insert("failed-retry", "2026-09-07", "2026-09-11", "2026-09-12T04:30:00Z", "failed");
    const result = await loadLatestWeeklyMarketReview({ DB: storage.db } as Env, now);
    expect(result).toMatchObject({ status: "ready", report: { id: "current-ready" }, latestAttempt: { status: "failed" } });
    expect(result.warning).toContain("Generation timed out");
  });

  it("does not relabel an older success as a generated current week or select a future report", async () => {
    await insert("last-good", "2026-08-31", "2026-09-04", "2026-09-05T04:30:00Z");
    await insert("future", "2026-09-14", "2026-09-18", "2026-09-12T04:30:00Z");
    const result = await loadLatestWeeklyMarketReview({ DB: storage.db } as Env, now);
    expect(result).toMatchObject({ status: "empty", report: { id: "last-good", weekEnd: "2026-09-04" }, latestAttempt: null });
    expect(result.warning).toContain("No successful weekly report is available for 2026-09-07 to 2026-09-11");
  });

  it("clears the failed-attempt warning after a later successful retry", async () => {
    await insert("failed", "2026-09-07", "2026-09-11", "2026-09-12T04:00:00Z", "failed");
    await insert("recovered", "2026-09-07", "2026-09-11", "2026-09-12T04:30:00Z");
    const result = await loadLatestWeeklyMarketReview({ DB: storage.db } as Env, now);
    expect(result).toMatchObject({ status: "ready", report: { id: "recovered" }, latestAttempt: { status: "ready" } });
    expect(result.warning).not.toContain("failed");
  });
});
