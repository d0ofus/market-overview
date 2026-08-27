import { describe, expect, it } from "vitest";
import { loadBreadthDashboard } from "../src/breadth-dashboard-service";
import type { Env } from "../src/types";

const ids = ["sp500-core", "nasdaq-core", "nyse-core", "russell2000-core", "overall-market-proxy"];

class DashboardDb {
  statementCount = 0;
  historyLimit: number | null = null;

  prepare(sql: string) {
    this.statementCount += 1;
    let args: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => {
        args = values;
        return statement;
      },
      all: async <T>() => {
        if (sql.includes("WITH published AS")) {
          this.historyLimit = Number(args[1]);
          return { results: ids.map((universeId) => ({
            asOfDate: "2026-07-20",
            universeId,
            advancers: 300,
            decliners: 190,
            unchanged: 10,
            pctAbove20MA: 60,
            pctAbove50MA: 55,
            pctAbove200MA: 52,
            new20DHighs: 20,
            new20DLows: 5,
            medianReturn1D: 0.4,
            medianReturn5D: 1.2,
            sentimentJson: JSON.stringify({
              metrics: { memberCount: 490, totalUniverseMembers: 500 },
              sourceMix: { alpaca: 127_000, yahoo: 100 },
              repairedPct: 0.08,
            }),
            generatedAt: "2026-07-20T21:30:00.000Z",
            generationId: "generation-old",
            publishedGenerationId: "generation-old",
            publishedAsOfDate: "2026-07-20",
            publishedGeneratedAt: "2026-07-20T21:30:00.000Z",
            publishedProviderLabel: "Alpaca canonical",
          })) as T[] };
        }
        if (sql.includes("FROM universes u")) {
          return { results: ids.map((universeId) => ({
            universeId,
            universeName: universeId,
            memberCount: 500,
            versionId: `${universeId}-v1`,
            source: "validated proxy",
            sourceType: "public-common-stock-proxy",
            sourceUrl: "https://example.test/source",
            sourceAsOfDate: "2026-07-20",
            sourceMemberCount: 500,
            resolvedMemberCount: 500,
            unresolvedCount: 0,
            validationError: null,
          })) as T[] };
        }
        if (sql.includes("FROM data_readiness")) {
          return { results: ids.map((scope) => ({
            scope,
            expectedAsOfDate: "2026-07-21",
            sourceAsOfDate: "2026-07-21",
            status: "ready",
            coveragePct: 98,
            warning: "The current candidate has not completed publication.",
            updatedAt: "2026-07-21T21:00:00.000Z",
          })) as T[] };
        }
        return { results: [{ sessionDate: "2026-07-21" }, { sessionDate: "2026-07-20" }] as T[] };
      },
    };
    return statement;
  }
}

describe("Breadth dashboard query service", () => {
  it("serves the published fallback generation with diagnostics in four statements", async () => {
    const db = new DashboardDb();
    const env = { DB: db, MARKET_DATA_DB: db, ALPACA_DAILY_FEED: "sip" } as unknown as Env;
    const dashboard = await loadBreadthDashboard(env, 999, new Date("2026-07-21T22:00:00.000Z"));

    expect(db.statementCount).toBe(4);
    expect(db.historyLimit).toBe(450);
    expect(dashboard.generationId).toBe("generation-old");
    expect(dashboard.expectedAsOfSession).toBe("2026-07-21");
    expect(dashboard.overallHealth).toBe("stale");
    expect(dashboard.universes).toHaveLength(5);
    expect(dashboard.universes[0]).toMatchObject({
      displayedAsOfSession: "2026-07-20",
      isFallback: true,
      freshness: "stale",
      staleTradingSessions: 1,
      memberCount: 500,
      eligibleCount: 490,
      repairSourceCount: 100,
      error: { code: "breadth-generation-stale" },
    });
  });
});
