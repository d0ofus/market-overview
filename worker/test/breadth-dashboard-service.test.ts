import { describe, expect, it } from "vitest";
import { loadBreadthDashboard } from "../src/breadth-dashboard-service";
import { encodeEodPayload } from "../src/eod-publication-codec";
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

function publication(universeId: string, sessionDate: string, revision: number, publicationId?: string) {
  const id = `${universeId}:${sessionDate}:${revision}`;
  return {
    id, scope: `breadth:${universeId}`, sessionDate, revision,
    publicationId: publicationId ?? id, createdAt: `${sessionDate}T21:00:00.000Z`, publishedAt: `${sessionDate}T21:01:00.000Z`,
    payload: JSON.stringify({
      asOfDate: sessionDate, universeId, advancers: 300, decliners: 190, unchanged: 10,
      metrics: { memberCount: 500, totalUniverseMembers: 500, dataCoveragePct: 100 },
      sourceMix: { alpaca: 490, yahoo: 10 },
      membership: { versionId: `${universeId}-frozen-v1`, source: "verified source", sourceAsOfDate: sessionDate },
    }),
  };
}

class PublicationDb extends DashboardDb {
  constructor(readonly publicationRows: ReturnType<typeof publication>[]) { super(); }
  override prepare(sql: string) {
    if (sql.includes("SELECT session_date AS date FROM market_calendar_sessions")) {
      this.statementCount += 1;
      const statement = { bind: (..._args: unknown[]) => statement,
        all: async <T>() => ({ results: Array.from(new Set(this.publicationRows.map((row) => row.sessionDate)))
          .sort().reverse().map((date) => ({date})) as T[] }) };
      return statement;
    }
    if (sql.includes("SELECT session_date as date FROM market_calendar_sessions")) {
      this.statementCount += 1;
      const statement = { bind: (..._args: unknown[]) => statement,
        first: async <T>() => ({date:this.publicationRows.map((row) => row.sessionDate).sort().at(-1)} as T),
        all: async <T>() => ({results:[] as T[]}) };
      return statement;
    }
    if (!sql.includes("WITH requested_ids AS")) return super.prepare(sql);
    this.statementCount += 1;
    expect(sql).toContain("latest.status='accepted'");
    expect(sql).toContain("ORDER BY latest.revision DESC");
    expect(sql).not.toContain("ROW_NUMBER");
    let values: unknown[] = [];
    const statement = {
      bind: (...args: unknown[]) => { values = args; return statement; },
      all: async <T>() => {
        this.historyLimit = (JSON.parse(String(values[1])) as string[]).length;
        return { results: this.publicationRows as T[] };
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

  it("serves independent universe pointers, retains accepted history, and freezes membership denominators", async () => {
    const latest = ids.map((id) => publication(id, id === "nasdaq-core" ? "2026-09-04" : "2026-09-08", 2));
    const previous = publication("sp500-core", "2026-09-04", 3, latest[0]!.id);
    const db = new PublicationDb([latest[0]!, previous, ...latest.slice(1)]);
    const dashboard = await loadBreadthDashboard({ DB: db, MARKET_DATA_DB: db, EOD_READ_ENABLED: "true" } as unknown as Env,
      120, new Date("2026-09-08T22:00:00.000Z"));
    expect(db.statementCount).toBe(3);
    expect(dashboard.overallHealth).toBe("partial");
    expect(dashboard.universes[0]).toMatchObject({
      displayedAsOfSession: "2026-09-08", freshness: "fresh", memberCount: 500, eligibleCount: 500,
      coveragePct: 100, membership: { versionId: "sp500-core-frozen-v1", status: "published-version" },
    });
    expect(dashboard.universes[0]!.history.map((row) => row.asOfDate)).toEqual(["2026-09-04", "2026-09-08"]);
    expect(dashboard.universes[1]).toMatchObject({ displayedAsOfSession: "2026-09-04", freshness: "stale", staleTradingSessions: 1 });
  });

  it("labels only missing new publications as unverified legacy during rollout", async () => {
    const db = new PublicationDb(ids.slice(0, 4).map((id) => publication(id, "2026-07-21", 1)));
    const dashboard = await loadBreadthDashboard({ DB: db, MARKET_DATA_DB: db, EOD_READ_ENABLED: "true" } as unknown as Env,
      10, new Date("2026-07-21T22:00:00.000Z"));
    expect(db.statementCount).toBe(7);
    expect(dashboard.universes[0]!.freshness).toBe("fresh");
    expect(dashboard.universes[4]).toMatchObject({
      displayedAsOfSession: "2026-07-20", freshness: "stale", isFallback: true,
      error: { code: "legacy-breadth-unverified" },
    });
  });

  it("reads compressed full publications instead of their SQL summaries and rejects corrupt codecs", async () => {
    const rows = await Promise.all(ids.map(async (id) => {
      const row = publication(id, "2026-11-27", 1);
      const encoded = await encodeEodPayload(JSON.parse(row.payload));
      return { ...row, ...encoded, payload: JSON.stringify({ asOfDate: row.sessionDate }) };
    }));
    const db = new PublicationDb(rows);
    const dashboard = await loadBreadthDashboard({ DB: db, MARKET_DATA_DB: db, EOD_READ_ENABLED: "true" } as unknown as Env,
      10, new Date("2026-11-27T18:35:00.000Z"));
    expect(dashboard.expectedAsOfSession).toBe("2026-11-27");
    expect(dashboard.overallHealth).toBe("fresh");
    expect(dashboard.universes[0]!.displayedSnapshot?.advancers).toBe(300);
    expect(dashboard.universes[0]!.membership.versionId).toBe("sp500-core-frozen-v1");
    rows[0]!.payloadBase64 = "not valid base64";
    const corrupt = await loadBreadthDashboard({ DB: db, MARKET_DATA_DB: db, EOD_READ_ENABLED: "true" } as unknown as Env,
      10, new Date("2026-11-27T18:35:00.000Z"));
    expect(corrupt.universes[0]!.error?.code).toBe("legacy-breadth-unverified");
    expect(corrupt.universes[1]!.freshness).toBe("fresh");
  });
});
