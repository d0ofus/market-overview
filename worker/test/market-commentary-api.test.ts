import { describe, expect, it } from "vitest";
import { DEFAULT_MARKET_COMMENTARY_SETTINGS, type MarketCommentarySettings } from "../src/market-commentary-service";
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
  generationTrigger: "manual" | "scheduled" | string;
  scheduledLocalDate: string | null;
  scheduledTimezone: string | null;
  scheduledLocalTime: string | null;
  createdAt: string;
  updatedAt: string;
};

class FakeMarketCommentaryDb {
  rows: StoredReport[] = [];
  settings: MarketCommentarySettings | null = null;
  snapshotAvailable: boolean;

  constructor(options: { snapshotAvailable?: boolean } = {}) {
    this.snapshotAvailable = options.snapshotAvailable ?? false;
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
        if (sql.includes("FROM market_commentary_settings")) {
          return (db.settings ? settingsToRow(db.settings) : null) as T;
        }
        if (sql.includes("FROM snapshots_meta")) {
          const asOfDate = String(bound[1] ?? "2026-06-12");
          return (db.snapshotAvailable
            ? {
                id: `snapshot-${asOfDate}`,
                asOfDate,
                generatedAt: `${asOfDate}T22:00:00.000Z`,
                providerLabel: "Stored Daily Bars",
                expectedAsOfDate: asOfDate,
                freshnessStatus: "fresh",
                freshnessCurrentCount: 4,
                freshnessEligibleCount: 4,
                freshnessCoveragePct: 100,
                freshnessCriticalMissingJson: "[]",
                freshnessMinBarDate: asOfDate,
                freshnessMaxBarDate: asOfDate,
                freshnessWarning: null,
              }
            : null) as T;
        }
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
        if (sql.startsWith("ALTER TABLE market_commentary_reports") || sql.startsWith("CREATE INDEX")) {
          return { meta: { rows_written: 0 } };
        }
        if (sql.startsWith("INSERT INTO market_commentary_settings")) {
          const now = "2026-05-25 00:00:00";
          db.settings = {
            id: String(bound[0]),
            enabled: Number(bound[1]) === 1,
            systemPromptTemplate: String(bound[2]),
            staticSources: JSON.parse(String(bound[3])),
            braveQueries: JSON.parse(String(bound[4])),
            scheduleEnabled: Number(bound[5]) === 1,
            scheduleTimezone: String(bound[6]),
            scheduleLocalTime: String(bound[7]),
            scheduleDays: JSON.parse(String(bound[8])),
            createdAt: db.settings?.createdAt ?? now,
            updatedAt: now,
          };
          return { meta: { rows_written: 1 } };
        }
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
            generationTrigger: String(bound[13]),
            scheduledLocalDate: bound[14] == null ? null : String(bound[14]),
            scheduledTimezone: bound[15] == null ? null : String(bound[15]),
            scheduledLocalTime: bound[16] == null ? null : String(bound[16]),
            createdAt: String(bound[17]),
            updatedAt: String(bound[18]),
          });
          return { meta: { rows_written: 1 } };
        }
        return { meta: { rows_written: 0 } };
      },
    };
    return statement;
  }
}

function settingsToRow(settings: MarketCommentarySettings) {
  return {
    id: settings.id,
    enabled: settings.enabled ? 1 : 0,
    systemPromptTemplate: settings.systemPromptTemplate,
    staticSourcesJson: JSON.stringify(settings.staticSources),
    braveQueriesJson: JSON.stringify(settings.braveQueries),
    scheduleEnabled: settings.scheduleEnabled ? 1 : 0,
    scheduleTimezone: settings.scheduleTimezone,
    scheduleLocalTime: settings.scheduleLocalTime,
    scheduleDaysJson: JSON.stringify(settings.scheduleDays),
    createdAt: settings.createdAt,
    updatedAt: settings.updatedAt,
  };
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
  it("requires admin auth for commentary settings", async () => {
    const response = await worker.fetch(new Request("https://example.com/api/admin/market-commentary/settings"), createEnv(), {} as ExecutionContext);
    expect(response.status).toBe(401);
  });

  it("returns, updates, and resets commentary settings", async () => {
    const db = new FakeMarketCommentaryDb();
    const env = createEnv(db);
    const authed = { Authorization: "Bearer secret" };

    const initial = await worker.fetch(new Request("https://example.com/api/admin/market-commentary/settings", { headers: authed }), env, {} as ExecutionContext);
    expect(initial.status).toBe(200);
    const initialPayload = await initial.json() as MarketCommentarySettings;
    expect(initialPayload.scheduleLocalTime).toBe("09:00");

    const patch = await worker.fetch(
      new Request("https://example.com/api/admin/market-commentary/settings", {
        method: "PATCH",
        headers: authed,
        body: JSON.stringify({
          ...DEFAULT_MARKET_COMMENTARY_SETTINGS,
          scheduleLocalTime: "10:15",
          scheduleDays: ["Wednesday"],
        }),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(patch.status).toBe(200);
    const patchPayload = await patch.json() as { settings: MarketCommentarySettings };
    expect(patchPayload.settings.scheduleLocalTime).toBe("10:15");
    expect(patchPayload.settings.scheduleDays).toEqual(["Wednesday"]);

    const reset = await worker.fetch(
      new Request("https://example.com/api/admin/market-commentary/settings/reset", { method: "POST", headers: authed }),
      env,
      {} as ExecutionContext,
    );
    expect(reset.status).toBe(200);
    const resetPayload = await reset.json() as { settings: MarketCommentarySettings };
    expect(resetPayload.settings.scheduleLocalTime).toBe("09:00");
  });

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
    const db = new FakeMarketCommentaryDb({ snapshotAvailable: true });
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
