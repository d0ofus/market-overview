import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { summarizeRecentDailyCommentary } from "../src/weekly-market-review-service";
import type { Env } from "../src/types";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("weekly daily-commentary source against migrated SQLite", () => {
  let storage: ReturnType<typeof createSqliteD1> | undefined;
  afterEach(() => storage?.dispose());
  it("reads the actual created_at column, limits the requested week, and preserves source observation timestamps", async () => {
    storage = createSqliteD1();
    storage.script(readFileSync(resolve("migrations/0055_market_commentary.sql"), "utf8"));
    const insert = storage.db.prepare(`INSERT INTO market_commentary_reports
      (id,session_date,as_of,market_session,market_session_label,data_basis,provider,model,status,report_markdown,created_at,updated_at)
      VALUES(?,?,?,'after_hours','After close','closing','factual','verified-stored-data-v1',?,?,?,?)`);
    for (const [id, date, status, text, timestamp] of [
      ["previous", "2026-08-21", "ready", "OUTSIDE PREVIOUS WEEK", "2026-08-22T01:00:00Z"],
      ["monday", "2026-08-24", "ready", "Monday verified facts", "2026-08-25T01:00:00Z"],
      ["friday", "2026-08-28", "ready", "Friday verified facts", "2026-08-29T01:00:00Z"],
      ["failed", "2026-08-28", "failed", "FAILED GENERATION", "2026-08-29T02:00:00Z"],
      ["next", "2026-08-31", "ready", "OUTSIDE NEXT WEEK", "2026-09-01T01:00:00Z"],
    ]) await insert.bind(id, date, timestamp, status, text, timestamp, timestamp).run();
    const audit: Parameters<typeof summarizeRecentDailyCommentary>[2] = [];
    const quality: Parameters<typeof summarizeRecentDailyCommentary>[3] = [];
    const week = { weekStart: "2026-08-24", weekEnd: "2026-08-28" } as Parameters<typeof summarizeRecentDailyCommentary>[1];

    const summary = await summarizeRecentDailyCommentary({ DB: storage.db } as Env, week, audit, quality);

    expect(summary).toContain("Friday verified facts");
    expect(summary).toContain("Monday verified facts");
    expect(summary).not.toMatch(/OUTSIDE|FAILED GENERATION|no such column/);
    expect(summary.indexOf("Friday")).toBeLessThan(summary.indexOf("Monday"));
    expect(audit[0]?.timestamp).toBe("2026-08-29T01:00:00Z");
    expect(quality).toEqual([{ metric: "Recent daily commentary", status: "ok", note: "Loaded 2 recent daily commentary reports." }]);
  });
});
