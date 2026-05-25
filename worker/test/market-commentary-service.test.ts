import { describe, expect, it } from "vitest";
import {
  loadLatestMarketCommentary,
  pruneMarketCommentaryReports,
  refreshMarketCommentary,
  type MarketCommentaryReport,
} from "../src/market-commentary-service";
import type { Env } from "../src/types";

type StoredReport = Omit<MarketCommentaryReport, "sourceAudit" | "dataQuality" | "error"> & {
  createdAt: string;
  sourceAuditJson: string;
  dataQualityJson: string;
  errorMessage: string | null;
  updatedAt: string;
};

class FakeMarketCommentaryDb {
  rows: StoredReport[];

  constructor(rows: StoredReport[] = []) {
    this.rows = [...rows];
  }

  prepare(sql: string) {
    const db = this;
    let bound: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) {
        bound = args;
        return statement;
      },
      async first<T>() {
        if (sql.includes("FROM market_commentary_reports") && sql.includes("WHERE session_date = ?")) {
          const sessionDate = String(bound[0]);
          return (db.rows
            .filter((row) => row.sessionDate === sessionDate)
            .sort(sortLatest)[0] ?? null) as T;
        }
        if (sql.includes("FROM market_commentary_reports")) {
          return ([...db.rows].sort(sortLatest)[0] ?? null) as T;
        }
        return null as T;
      },
      async all<T>() {
        return { results: [] as T[] };
      },
      async run() {
        if (sql.startsWith("DELETE FROM market_commentary_reports")) {
          const cutoff = String(bound[0]);
          const before = db.rows.length;
          db.rows = db.rows.filter((row) => row.createdAt >= cutoff);
          return { meta: { rows_written: before - db.rows.length } };
        }
        if (sql.startsWith("INSERT INTO market_commentary_reports")) {
          db.rows.push({
            id: String(bound[0]),
            sessionDate: String(bound[1]),
            asOf: String(bound[2]),
            marketSession: bound[3] as StoredReport["marketSession"],
            marketSessionLabel: String(bound[4]),
            dataBasis: bound[5] as StoredReport["dataBasis"],
            provider: String(bound[6]),
            model: String(bound[7]),
            status: bound[8] as StoredReport["status"],
            reportMarkdown: String(bound[9]),
            sourceAuditJson: String(bound[10]),
            dataQualityJson: String(bound[11]),
            errorMessage: bound[12] == null ? null : String(bound[12]),
            generatedAt: String(bound[13]),
            createdAt: String(bound[13]),
            updatedAt: String(bound[14]),
          });
          return { meta: { rows_written: 1 } };
        }
        return { meta: { rows_written: 0 } };
      },
    };
    return statement;
  }
}

function sortLatest(left: StoredReport, right: StoredReport): number {
  return right.sessionDate.localeCompare(left.sessionDate) || right.createdAt.localeCompare(left.createdAt);
}

function createReport(id: string, sessionDate: string, generatedAt: string): StoredReport {
  return {
    id,
    sessionDate,
    asOf: generatedAt,
    generatedAt,
    createdAt: generatedAt,
    updatedAt: generatedAt,
    marketSession: "after_hours",
    marketSessionLabel: "Post-close",
    dataBasis: "closing",
    provider: "gemini",
    model: "gemini-3.5-flash",
    status: "ready",
    reportMarkdown: `# Report ${id}`,
    sourceAuditJson: "[]",
    dataQualityJson: "[]",
    errorMessage: null,
  };
}

function createEnv(db: FakeMarketCommentaryDb, extra?: Partial<Env>): Env {
  return {
    DB: db as unknown as D1Database,
    MARKET_COMMENTARY_RETENTION_DAYS: "30",
    ...extra,
  } as Env;
}

describe("market commentary service", () => {
  it("returns an empty state when no report exists", async () => {
    const response = await loadLatestMarketCommentary(createEnv(new FakeMarketCommentaryDb()));
    expect(response.status).toBe("empty");
    expect(response.report).toBeNull();
  });

  it("loads the latest cached report by session date and creation time", async () => {
    const db = new FakeMarketCommentaryDb([
      createReport("older", "2026-05-21", "2026-05-21T21:10:00.000Z"),
      createReport("latest", "2026-05-22", "2026-05-22T21:10:00.000Z"),
    ]);
    const response = await loadLatestMarketCommentary(createEnv(db));
    expect(response.status).toBe("ready");
    expect(response.report?.id).toBe("latest");
  });

  it("prunes reports older than the configured 30-day history", async () => {
    const db = new FakeMarketCommentaryDb([
      createReport("expired", "2026-04-20", "2026-04-20T21:10:00.000Z"),
      createReport("kept", "2026-05-20", "2026-05-20T21:10:00.000Z"),
    ]);
    const pruned = await pruneMarketCommentaryReports(createEnv(db), 30, new Date("2026-05-25T21:10:00.000Z"));
    expect(pruned).toBe(1);
    expect(db.rows.map((row) => row.id)).toEqual(["kept"]);
  });

  it("stores an isolated failed report when Gemini is not configured", async () => {
    const db = new FakeMarketCommentaryDb();
    const response = await refreshMarketCommentary(createEnv(db), {
      now: new Date("2026-05-25T15:00:00.000Z"),
      force: true,
    });

    expect(response.status).toBe("failed");
    expect(response.report?.status).toBe("failed");
    expect(response.report?.sessionDate).toBe("2026-05-22");
    expect(response.report?.marketSession).toBe("closed");
    expect(response.report?.error).toContain("GEMINI_API_KEY");
    expect(db.rows).toHaveLength(1);
  });
});
