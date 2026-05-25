import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

type StoredReport = {
  id: string;
  sessionDate: string;
  asOf: string;
  marketSession: "pre_market" | "regular" | "after_hours" | "closed";
  marketSessionLabel: string;
  dataBasis: "intraday" | "closing" | "pre_market" | "closed_market";
  provider: string;
  model: string;
  status: "ready" | "failed";
  reportMarkdown: string;
  sourceAuditJson: string;
  dataQualityJson: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

class FakeMarketCommentaryDb {
  rows: StoredReport[] = [];

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
          return (db.rows.filter((row) => row.sessionDate === String(bound[0])).sort(sortLatest)[0] ?? null) as T;
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

function createEnv(db = new FakeMarketCommentaryDb(), extra?: Partial<Env>): Env {
  return {
    DB: db as unknown as D1Database,
    ADMIN_SECRET: "secret",
    MARKET_COMMENTARY_RETENTION_DAYS: "30",
    ...extra,
  } as Env;
}

describe("market commentary API", () => {
  it("returns an empty cached commentary state without affecting health", async () => {
    const env = createEnv();
    const commentary = await worker.fetch(new Request("https://example.com/api/market-commentary"), env, {} as ExecutionContext);
    expect(commentary.status).toBe(200);
    expect(await commentary.json()).toMatchObject({ status: "empty", report: null });

    const health = await worker.fetch(new Request("https://example.com/api/health"), env, {} as ExecutionContext);
    expect(health.status).toBe(200);
  });

  it("requires admin auth for manual commentary refresh", async () => {
    const response = await worker.fetch(new Request("https://example.com/api/admin/market-commentary/refresh", { method: "POST" }), createEnv(), {} as ExecutionContext);
    expect(response.status).toBe(401);
  });

  it("stores and returns an isolated failed report when provider config is missing", async () => {
    const db = new FakeMarketCommentaryDb();
    const response = await worker.fetch(
      new Request("https://example.com/api/admin/market-commentary/refresh", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
      }),
      createEnv(db),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as { ok: boolean; status: string; report: { status: string; error: string | null } };
    expect(payload.ok).toBe(false);
    expect(payload.status).toBe("failed");
    expect(payload.report.status).toBe("failed");
    expect(payload.report.error).toContain("GEMINI_API_KEY");
    expect(db.rows).toHaveLength(1);
  });
});
