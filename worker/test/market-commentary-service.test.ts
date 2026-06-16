import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKET_COMMENTARY_SETTINGS,
  DEFAULT_MARKET_COMMENTARY_PROMPT,
  loadMarketCommentarySettings,
  loadLatestMarketCommentary,
  maybeRunScheduledMarketCommentary,
  pruneMarketCommentaryReports,
  renderMarketCommentaryQueryTemplate,
  summarizeDailyAbove200SmaScanEvidence,
  refreshMarketCommentary,
  shouldRunScheduledMarketCommentary,
  updateMarketCommentarySettings,
  type MarketCommentaryReport,
  type MarketCommentarySettings,
} from "../src/market-commentary-service";
import type { Env } from "../src/types";

type StoredReport = Omit<MarketCommentaryReport, "sourceAudit" | "dataQuality" | "error"> & {
  createdAt: string;
  sourceAuditJson: string;
  dataQualityJson: string;
  errorMessage: string | null;
  generationTrigger: "manual" | "scheduled" | string;
  scheduledLocalDate: string | null;
  scheduledTimezone: string | null;
  scheduledLocalTime: string | null;
  updatedAt: string;
};

function freshSnapshotRow(
  asOfDate: string,
  options: {
    freshnessStatus?: "fresh" | "partial" | "stale";
    freshnessCurrentCount?: number;
    freshnessEligibleCount?: number;
    freshnessCoveragePct?: number;
    freshnessWarning?: string | null;
  } = {},
) {
  const freshnessStatus = options.freshnessStatus ?? "fresh";
  const freshnessCurrentCount = options.freshnessCurrentCount ?? 4;
  const freshnessEligibleCount = options.freshnessEligibleCount ?? 4;
  return {
    id: `snapshot-${asOfDate}`,
    asOfDate,
    generatedAt: `${asOfDate}T22:00:00.000Z`,
    providerLabel: "Stored Daily Bars",
    expectedAsOfDate: asOfDate,
    freshnessStatus,
    freshnessCurrentCount,
    freshnessEligibleCount,
    freshnessCoveragePct: options.freshnessCoveragePct ?? (freshnessEligibleCount > 0 ? (freshnessCurrentCount / freshnessEligibleCount) * 100 : 0),
    freshnessCriticalMissingJson: "[]",
    freshnessMinBarDate: asOfDate,
    freshnessMaxBarDate: asOfDate,
    freshnessWarning: options.freshnessWarning ?? null,
  };
}

class FakeMarketCommentaryDb {
  rows: StoredReport[];
  settings: MarketCommentarySettings | null;
  snapshotAsOfDate: string | null;
  snapshotFreshness: Parameters<typeof freshSnapshotRow>[1];

  constructor(rows: StoredReport[] = [], options: { snapshotAsOfDate?: string | null; snapshotFreshness?: Parameters<typeof freshSnapshotRow>[1] } = {}) {
    this.rows = [...rows];
    this.settings = null;
    this.snapshotAsOfDate = options.snapshotAsOfDate ?? null;
    this.snapshotFreshness = options.snapshotFreshness ?? {};
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
          const requestedAsOfDate = String(bound[1] ?? "");
          return (db.snapshotAsOfDate === requestedAsOfDate ? freshSnapshotRow(db.snapshotAsOfDate, db.snapshotFreshness) : null) as T;
        }
        if (sql.includes("FROM market_commentary_reports") && sql.includes("generation_trigger = 'scheduled'")) {
          const scheduledLocalDate = String(bound[0]);
          const sessionDate = String(bound[1]);
          return (db.rows
            .filter((row) => row.generationTrigger === "scheduled" && row.scheduledLocalDate === scheduledLocalDate && row.sessionDate === sessionDate)
            .sort(sortLatest)[0] ?? null) as T;
        }
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
            generatedAt: String(bound[17]),
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

function createReport(
  id: string,
  sessionDate: string,
  generatedAt: string,
  options: Partial<Pick<StoredReport, "status" | "errorMessage" | "generationTrigger" | "scheduledLocalDate" | "scheduledTimezone" | "scheduledLocalTime">> = {},
): StoredReport {
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
    status: options.status ?? "ready",
    reportMarkdown: `# Report ${id}`,
    sourceAuditJson: "[]",
    dataQualityJson: "[]",
    errorMessage: options.errorMessage ?? null,
    generationTrigger: options.generationTrigger ?? "manual",
    scheduledLocalDate: options.scheduledLocalDate ?? null,
    scheduledTimezone: options.scheduledTimezone ?? null,
    scheduledLocalTime: options.scheduledLocalTime ?? null,
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
  it("returns default configurable settings when no row exists", async () => {
    const settings = await loadMarketCommentarySettings(createEnv(new FakeMarketCommentaryDb()));
    expect(settings.enabled).toBe(true);
    expect(settings.scheduleTimezone).toBe("Australia/Melbourne");
    expect(settings.scheduleLocalTime).toBe("09:00");
    expect(settings.scheduleDays).toEqual(["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
    expect(settings.braveQueries[0]).toContain("{latestCompletedSessionDate}");
  });

  it("persists configurable prompt, sources, queries, and schedule settings", async () => {
    const db = new FakeMarketCommentaryDb();
    const updated = await updateMarketCommentarySettings(createEnv(db), {
      ...DEFAULT_MARKET_COMMENTARY_SETTINGS,
      enabled: false,
      systemPromptTemplate: `${DEFAULT_MARKET_COMMENTARY_SETTINGS.systemPromptTemplate}\nExtra instruction.`,
      braveQueries: ["markets {sessionDate} {latestCompletedSessionDate} {marketStatus}"],
      scheduleLocalTime: "10:15",
      scheduleDays: ["Wednesday"],
    });

    expect(updated.enabled).toBe(false);
    expect(updated.braveQueries).toEqual(["markets {sessionDate} {latestCompletedSessionDate} {marketStatus}"]);
    expect(updated.scheduleLocalTime).toBe("10:15");
    expect(updated.scheduleDays).toEqual(["Wednesday"]);
  });

  it("renders configured Brave query template variables", () => {
    const rendered = renderMarketCommentaryQueryTemplate(
      "market {nyDate} {sessionDate} {latestCompletedSessionDate} {marketStatus}",
      {
        nowIso: "2026-05-26T00:00:00.000Z",
        nyDate: "2026-05-25",
        nyTime: "20:00",
        sessionDate: "2026-05-25",
        latestCompletedSessionDate: "2026-05-25",
        status: "after_hours",
        label: "Post-close",
        dataBasis: "closing",
        isTradingDay: true,
        closedReason: null,
      },
    );
    expect(rendered).toBe("market 2026-05-25 2026-05-25 2026-05-25 after_hours");
  });

  it("summarizes Daily - Above 200 SMA scan evidence as notable mover and theme input", () => {
    const summary = summarizeDailyAbove200SmaScanEvidence({
      compilePresetId: "compile-above-200",
      compilePresetName: "Daily - Above 200 SMA",
      refreshedCount: 2,
      failedCount: 0,
      snapshot: {
        compilePresetId: "compile-above-200",
        compilePresetName: "Daily - Above 200 SMA",
        presetIds: ["preset-a", "preset-b"],
        presetNames: ["Leaders", "Breakouts"],
        generatedAt: "2026-06-15T22:15:00.000Z",
        rows: [
          { ticker: "NVDA", name: "NVIDIA", sector: "Technology", industry: "Semiconductors", occurrences: 2, presetIds: ["preset-a", "preset-b"], presetNames: ["Leaders", "Breakouts"], latestPrice: 130, latestChange1d: 6.4, latestMarketCap: 3_000_000_000_000, latestRelativeVolume: 2.1 },
          { ticker: "ANET", name: "Arista Networks", sector: "Technology", industry: "Computer Communications", occurrences: 1, presetIds: ["preset-a"], presetNames: ["Leaders"], latestPrice: 90, latestChange1d: 4.1, latestMarketCap: 120_000_000_000, latestRelativeVolume: 1.6 },
          { ticker: "VRT", name: "Vertiv", sector: "Industrials", industry: "Electrical Products", occurrences: 1, presetIds: ["preset-b"], presetNames: ["Breakouts"], latestPrice: 105, latestChange1d: 3.8, latestMarketCap: 40_000_000_000, latestRelativeVolume: 1.9 },
        ],
      },
      memberResults: [],
    });

    expect(summary).toContain("Daily - Above 200 SMA");
    expect(summary).toContain("Notable individual movers");
    expect(summary).toContain("NVDA (NVIDIA): 1D 6.40%");
    expect(summary).toContain("Technology / Semiconductors");
    expect(summary).toContain("Use this as trader-attention evidence");
    expect(summary).toContain("Do not infer catalysts from scan membership alone");
  });

  it("instructs final LLM synthesis to omit low-importance report content", () => {
    expect(DEFAULT_MARKET_COMMENTARY_PROMPT).toContain("omit it rather than reporting for completeness");
    expect(DEFAULT_MARKET_COMMENTARY_PROMPT).toContain("Do not include sections or source summaries just because data exists");
  });

  it("runs the configured Melbourne schedule at or after the target time on configured days", () => {
    const settings = { ...DEFAULT_MARKET_COMMENTARY_SETTINGS };
    expect(shouldRunScheduledMarketCommentary(settings, new Date("2026-06-01T23:00:00.000Z"))).toBe(true);
    expect(shouldRunScheduledMarketCommentary(settings, new Date("2026-06-01T23:14:59.000Z"))).toBe(true);
    expect(shouldRunScheduledMarketCommentary(settings, new Date("2026-06-01T23:30:00.000Z"))).toBe(true);
    expect(shouldRunScheduledMarketCommentary(settings, new Date("2026-06-01T22:59:59.000Z"))).toBe(false);
    expect(shouldRunScheduledMarketCommentary(settings, new Date("2026-05-24T23:00:00.000Z"))).toBe(false);
  });

  it("runs the May 27 2026 Melbourne 9am schedule for the May 26 US session", async () => {
    const db = new FakeMarketCommentaryDb([], { snapshotAsOfDate: "2026-05-26" });
    const response = await maybeRunScheduledMarketCommentary(createEnv(db), new Date("2026-05-26T23:00:00.000Z"));

    expect(response?.status).toBe("failed");
    expect(response?.report?.sessionDate).toBe("2026-05-26");
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      generationTrigger: "scheduled",
      scheduledLocalDate: "2026-05-27",
      scheduledTimezone: "Australia/Melbourne",
      scheduledLocalTime: "09:00",
    });
  });

  it("scheduled generation catches up after the target window when no same-day attempt exists", async () => {
    const db = new FakeMarketCommentaryDb([], { snapshotAsOfDate: "2026-05-26" });
    const response = await maybeRunScheduledMarketCommentary(createEnv(db), new Date("2026-05-26T23:30:00.000Z"));

    expect(response?.status).toBe("failed");
    expect(response?.report?.sessionDate).toBe("2026-05-26");
    expect(db.rows[0]?.scheduledLocalDate).toBe("2026-05-27");
  });

  it("defers scheduled generation until the matching overview snapshot is ready", async () => {
    const db = new FakeMarketCommentaryDb([], { snapshotAsOfDate: "2026-05-25" });
    const response = await maybeRunScheduledMarketCommentary(createEnv(db), new Date("2026-05-26T23:30:00.000Z"));

    expect(response).toBeNull();
    expect(db.rows).toHaveLength(0);
  });

  it("scheduled generation skips when a same-day ready scheduled attempt already exists", async () => {
    const db = new FakeMarketCommentaryDb([
      createReport("monday", "2026-06-01", "2026-06-01T23:00:00.000Z", {
        generationTrigger: "scheduled",
        scheduledLocalDate: "2026-06-02",
        scheduledTimezone: "Australia/Melbourne",
        scheduledLocalTime: "09:00",
      }),
    ], { snapshotAsOfDate: "2026-06-01" });
    const response = await maybeRunScheduledMarketCommentary(createEnv(db), new Date("2026-06-01T23:30:00.000Z"));
    expect(response?.status).toBe("ready");
    expect(response?.warning).toContain("scheduled attempt already exists");
    expect(db.rows).toHaveLength(1);
  });

  it("scheduled generation skips when a same-day failed scheduled attempt already exists", async () => {
    const db = new FakeMarketCommentaryDb([
      createReport("failed", "2026-05-26", "2026-05-26T23:00:00.000Z", {
        status: "failed",
        errorMessage: "Gemini failed.",
        generationTrigger: "scheduled",
        scheduledLocalDate: "2026-05-27",
        scheduledTimezone: "Australia/Melbourne",
        scheduledLocalTime: "09:00",
      }),
    ], { snapshotAsOfDate: "2026-05-26" });
    const response = await maybeRunScheduledMarketCommentary(createEnv(db), new Date("2026-05-26T23:30:00.000Z"));

    expect(response?.status).toBe("failed");
    expect(response?.report?.id).toBe("failed");
    expect(db.rows).toHaveLength(1);
  });

  it("scheduled generation stores an isolated failed report when provider config is missing", async () => {
    const db = new FakeMarketCommentaryDb([], { snapshotAsOfDate: "2026-06-01" });
    const response = await maybeRunScheduledMarketCommentary(createEnv(db), new Date("2026-06-01T23:00:00.000Z"));
    expect(response?.status).toBe("failed");
    expect(response?.report?.sessionDate).toBe("2026-06-01");
    expect(response?.report?.error).toContain("GEMINI_API_KEY");
    expect(db.rows).toHaveLength(1);
  });

  it("allows a partial overview snapshot through the commentary freshness gate", async () => {
    const db = new FakeMarketCommentaryDb([], {
      snapshotAsOfDate: "2026-06-01",
      snapshotFreshness: {
        freshnessStatus: "partial",
        freshnessCurrentCount: 80,
        freshnessEligibleCount: 224,
        freshnessCoveragePct: 35.7,
        freshnessWarning: "Partial: critical fresh; broad overview coverage is incomplete.",
      },
    });
    const response = await maybeRunScheduledMarketCommentary(createEnv(db), new Date("2026-06-01T23:00:00.000Z"));

    expect(response?.status).toBe("failed");
    expect(response?.report?.sessionDate).toBe("2026-06-01");
    expect(response?.report?.error).toContain("GEMINI_API_KEY");
    expect(response?.report?.error).not.toContain("stale");
    expect(db.rows).toHaveLength(1);
  });

  it("does not let an older holiday report for the same session block a fresh scheduled day", async () => {
    const db = new FakeMarketCommentaryDb([
      createReport("memorial-day", "2026-05-22", "2026-05-25T04:48:27.877Z"),
    ], { snapshotAsOfDate: "2026-05-22" });
    const response = await maybeRunScheduledMarketCommentary(createEnv(db), new Date("2026-05-25T23:00:00.000Z"));

    expect(response?.status).toBe("failed");
    expect(response?.report?.sessionDate).toBe("2026-05-22");
    expect(db.rows).toHaveLength(2);
    expect(db.rows[1]?.generationTrigger).toBe("scheduled");
    expect(db.rows[1]?.scheduledLocalDate).toBe("2026-05-26");
  });

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
    const db = new FakeMarketCommentaryDb([], { snapshotAsOfDate: "2026-05-22" });
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
