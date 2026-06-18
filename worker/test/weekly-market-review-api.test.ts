import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  generateWeeklyMarketReview,
  loadLatestWeeklyMarketReview,
  loadWeeklyMarketReviewById,
  maybeRunScheduledWeeklyMarketReview,
  publishWeeklyMarketReview,
  type WeeklyMarketReviewReport,
} from "../src/weekly-market-review-service";
import type { Env } from "../src/types";

type StoredWeeklyReview = {
  id: string;
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  asOf: string;
  provider: string;
  model: string;
  generationProvider: "hermes_gpt" | "gemini_fallback";
  generationMode: "external_publish" | "scheduled_fallback" | "manual_retry";
  status: "ready" | "failed";
  title: string;
  marketTone: string | null;
  reviewMarkdown: string;
  sectionsJson: string;
  keyTickersJson: string;
  sourceAuditJson: string;
  dataQualityJson: string;
  sourceSnapshotJson: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

type StoredBraveUsage = {
  usageDay: string;
  caller: "daily_commentary" | "weekly_review" | "fomc";
  apiCallCount: number;
  apiErrorCount: number;
  cacheHitCount: number;
  lastCalledAt: string | null;
  lastErrorAt: string | null;
  updatedAt: string;
};

const HERMES_PAYLOAD = {
  id: "weekly-market-review-2026-06-08-2026-06-12",
  weekStart: "2026-06-08",
  weekEnd: "2026-06-12",
  generatedAt: "2026-06-13T10:00:00+10:00",
  asOf: "2026-06-12T20:00:00-04:00",
  provider: "openai-codex",
  model: "gpt-5.5",
  generationProvider: "hermes_gpt",
  generationMode: "external_publish",
  title: "Weekly Market Review - Jun 8-12",
  marketTone: "Risk-on but leadership concentrated",
  reviewMarkdown: "## Executive Summary\n\nLeadership broadened but still needs confirmation.\n\n## Market Tone & Breadth\n\nBreadth improved.",
  sections: { executiveSummary: ["Leadership broadened"] },
  keyTickers: [{ ticker: "CAT", companyName: "Caterpillar Inc.", theme: "Industrial breakout" }],
  sourceAudit: [{ sourceName: "Market Overview sectors", url: null, dataUsed: "Sector focus context", timestamp: "2026-06-13T10:00:00+10:00" }],
  dataQuality: [{ metric: "latest_market_date", status: "ok", note: "Latest completed US session included." }],
  sourceSnapshot: { latestMarketDate: "2026-06-12" },
} as const;

class FakeWeeklyReviewDb {
  rows: StoredWeeklyReview[] = [];
  braveUsageRows: StoredBraveUsage[] = [];

  prepare(sql: string) {
    const db = this;
    let bound: unknown[] = [];
    const normalized = sql.replace(/\s+/g, " ");
    const statement = {
      bind(...args: unknown[]) {
        bound = args;
        return statement;
      },
      async first<T>() {
        if (normalized.includes("FROM weekly_market_reviews")) {
          if (normalized.includes("WHERE id = ?")) {
            return (db.rows.find((row) => row.id === String(bound[0])) ?? null) as T;
          }
          if (normalized.includes("generation_provider = 'gemini_fallback'") && normalized.includes("generation_mode = 'scheduled_fallback'")) {
            return (db.rows
              .filter((row) => row.weekEnd === String(bound[0]) && row.generationProvider === "gemini_fallback" && row.generationMode === "scheduled_fallback")
              .sort(sortLatest)[0] ?? null) as T;
          }
          if (normalized.includes("week_end = ?") && normalized.includes("status = 'ready'")) {
            return (db.rows
              .filter((row) => row.weekEnd === String(bound[0]) && row.status === "ready")
              .sort(sortPreferred)[0] ?? null) as T;
          }
          if (normalized.includes("week_end = ?")) {
            return (db.rows
              .filter((row) => row.weekEnd === String(bound[0]))
              .sort(sortPreferred)[0] ?? null) as T;
          }
        }
        return null as T;
      },
      async all<T>() {
        if (normalized.includes("FROM brave_usage_daily")) {
          const cutoff = String(bound[0]);
          return { results: db.braveUsageRows.filter((row) => row.usageDay >= cutoff).sort((left, right) => (
            right.usageDay.localeCompare(left.usageDay) || left.caller.localeCompare(right.caller)
          )) as T[] };
        }
        if (normalized.includes("FROM weekly_market_reviews")) {
          const limit = Math.max(1, Math.min(100, Number(bound[0] ?? 20)));
          return { results: db.rows.slice().sort(sortList).slice(0, limit) as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (normalized.startsWith("INSERT INTO weekly_market_reviews")) {
          const row: StoredWeeklyReview = {
            id: String(bound[0]),
            weekStart: String(bound[1]),
            weekEnd: String(bound[2]),
            generatedAt: String(bound[3]),
            asOf: String(bound[4]),
            provider: String(bound[5]),
            model: String(bound[6]),
            generationProvider: bound[7] as StoredWeeklyReview["generationProvider"],
            generationMode: bound[8] as StoredWeeklyReview["generationMode"],
            status: bound[9] as StoredWeeklyReview["status"],
            title: String(bound[10]),
            marketTone: bound[11] == null ? null : String(bound[11]),
            reviewMarkdown: String(bound[12]),
            sectionsJson: String(bound[13]),
            keyTickersJson: String(bound[14]),
            sourceAuditJson: String(bound[15]),
            dataQualityJson: String(bound[16]),
            sourceSnapshotJson: String(bound[17]),
            errorMessage: bound[18] == null ? null : String(bound[18]),
            createdAt: String(bound[19]),
            updatedAt: String(bound[20]),
          };
          const existingIndex = db.rows.findIndex((existing) => existing.id === row.id);
          if (existingIndex >= 0) {
            db.rows[existingIndex] = { ...row, createdAt: db.rows[existingIndex].createdAt };
          } else {
            db.rows.push(row);
          }
          return { meta: { rows_written: 1 } };
        }
        return { meta: { rows_written: 0 } };
      },
    };
    return statement;
  }
}

function sortLatest(left: StoredWeeklyReview, right: StoredWeeklyReview): number {
  return right.generatedAt.localeCompare(left.generatedAt) || right.createdAt.localeCompare(left.createdAt);
}

function sortPreferred(left: StoredWeeklyReview, right: StoredWeeklyReview): number {
  const leftProvider = left.generationProvider === "hermes_gpt" ? 0 : 1;
  const rightProvider = right.generationProvider === "hermes_gpt" ? 0 : 1;
  return leftProvider - rightProvider || sortLatest(left, right);
}

function sortList(left: StoredWeeklyReview, right: StoredWeeklyReview): number {
  return right.weekEnd.localeCompare(left.weekEnd) || sortPreferred(left, right);
}

function createEnv(db = new FakeWeeklyReviewDb(), extra?: Partial<Env>): Env {
  return {
    DB: db as unknown as D1Database,
    ADMIN_SECRET: "secret",
    HERMES_WEEKLY_MARKET_REVIEW_SECRET: "hermes-secret",
    ...extra,
  } as Env;
}

function pushReadyGeminiFallback(db: FakeWeeklyReviewDb, overrides: Partial<StoredWeeklyReview> = {}) {
  db.rows.push({
    id: "weekly-market-review-2026-06-08-2026-06-12-manual-ready",
    weekStart: "2026-06-08",
    weekEnd: "2026-06-12",
    generatedAt: "2026-06-13T11:00:00.000Z",
    asOf: "2026-06-13T11:00:00.000Z",
    provider: "gemini",
    model: "gemini-3.5-flash",
    generationProvider: "gemini_fallback",
    generationMode: "manual_retry",
    status: "ready",
    title: "Weekly Market Review - 2026-06-08 to 2026-06-12",
    marketTone: null,
    reviewMarkdown: "## Executive Summary\n\nGemini fallback review.",
    sectionsJson: "{}",
    keyTickersJson: "[]",
    sourceAuditJson: "[]",
    dataQualityJson: "[]",
    sourceSnapshotJson: "{}",
    errorMessage: null,
    createdAt: "2026-06-13T11:00:00.000Z",
    updatedAt: "2026-06-13T11:00:00.000Z",
    ...overrides,
  });
}

describe("weekly market review API and service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-14T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an empty latest weekly review state", async () => {
    const response = await loadLatestWeeklyMarketReview(createEnv());
    expect(response).toMatchObject({ status: "empty", report: null });
    expect(response.warning).toContain("2026-06-08 to 2026-06-12");
  });

  it("requires Hermes/admin auth for publish", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/api/admin/weekly-market-review/publish", {
        method: "POST",
        body: JSON.stringify(HERMES_PAYLOAD),
      }),
      createEnv(),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(401);
  });

  it("publishes, lists, and loads a Hermes weekly review", async () => {
    const db = new FakeWeeklyReviewDb();
    const env = createEnv(db);
    const response = await worker.fetch(
      new Request("https://example.com/api/admin/weekly-market-review/publish", {
        method: "POST",
        headers: { Authorization: "Bearer hermes-secret" },
        body: JSON.stringify(HERMES_PAYLOAD),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as { ok: boolean; report: WeeklyMarketReviewReport };
    expect(payload.ok).toBe(true);
    expect(payload.report.generationProvider).toBe("hermes_gpt");

    const latest = await worker.fetch(new Request("https://example.com/api/weekly-market-review/latest"), env, {} as ExecutionContext);
    expect(await latest.json()).toMatchObject({ status: "ready", report: { id: HERMES_PAYLOAD.id } });

    const list = await worker.fetch(new Request("https://example.com/api/weekly-market-review?limit=5"), env, {} as ExecutionContext);
    expect(await list.json()).toMatchObject({ rows: [{ id: HERMES_PAYLOAD.id }] });

    const detail = await worker.fetch(new Request(`https://example.com/api/weekly-market-review/${HERMES_PAYLOAD.id}`), env, {} as ExecutionContext);
    expect(await detail.json()).toMatchObject({ report: { title: HERMES_PAYLOAD.title } });
  });

  it("rejects malformed publish payloads", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/api/admin/weekly-market-review/publish", {
        method: "POST",
        headers: { Authorization: "Bearer hermes-secret" },
        body: JSON.stringify({ ...HERMES_PAYLOAD, reviewMarkdown: "" }),
      }),
      createEnv(),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(400);
  });

  it("prefers Hermes over Gemini fallback for the same week", async () => {
    const db = new FakeWeeklyReviewDb();
    const env = createEnv(db);
    await generateWeeklyMarketReview(env, { mode: "manual_retry", now: new Date("2026-06-14T00:00:00.000Z") });
    await publishWeeklyMarketReview(env, HERMES_PAYLOAD);

    const latest = await loadLatestWeeklyMarketReview(env, new Date("2026-06-14T00:00:00.000Z"));
    expect(latest.report?.generationProvider).toBe("hermes_gpt");
    expect(db.rows.some((row) => row.generationProvider === "gemini_fallback")).toBe(true);
  });

  it("requires admin auth for fallback generation", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/api/admin/weekly-market-review/generate", {
        method: "POST",
        body: JSON.stringify({ force: false, mode: "manual_retry" }),
      }),
      createEnv(),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(401);
  });

  it("manual retry returns Hermes when a current Hermes review exists", async () => {
    const db = new FakeWeeklyReviewDb();
    const env = createEnv(db);
    await publishWeeklyMarketReview(env, HERMES_PAYLOAD);

    const response = await worker.fetch(
      new Request("https://example.com/api/admin/weekly-market-review/generate", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: JSON.stringify({ force: false, mode: "manual_retry" }),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, report: { generationProvider: "hermes_gpt" } });
    expect(db.rows).toHaveLength(1);
  });

  it("stores a failed Gemini fallback when fallback provider config is missing", async () => {
    const db = new FakeWeeklyReviewDb();
    const response = await generateWeeklyMarketReview(createEnv(db), {
      mode: "manual_retry",
      now: new Date("2026-06-14T00:00:00.000Z"),
    });
    expect(response.ok).toBe(false);
    expect(response.status).toBe("failed");
    expect(response.report?.generationProvider).toBe("gemini_fallback");
    expect(response.report?.generationMode).toBe("manual_retry");
    expect(response.warning).toContain("GEMINI_API_KEY");
    expect(db.rows).toHaveLength(1);
  });

  it("does not duplicate an existing current Gemini fallback when force is false", async () => {
    const db = new FakeWeeklyReviewDb();
    const env = createEnv(db);
    pushReadyGeminiFallback(db);
    const second = await generateWeeklyMarketReview(env, { mode: "manual_retry", now: new Date("2026-06-14T00:05:00.000Z") });
    expect(second.report?.id).toBe(db.rows[0].id);
    expect(db.rows).toHaveLength(1);
  });

  it("skips scheduled fallback before grace and records one attempt after grace", async () => {
    const db = new FakeWeeklyReviewDb();
    const env = createEnv(db);
    const beforeGrace = await maybeRunScheduledWeeklyMarketReview(env, new Date("2026-06-13T02:30:00.000Z"));
    expect(beforeGrace).toBeNull();

    const afterGrace = await maybeRunScheduledWeeklyMarketReview(env, new Date("2026-06-13T04:30:00.000Z"));
    expect(afterGrace?.status).toBe("failed");
    expect(db.rows).toHaveLength(1);

    const duplicate = await maybeRunScheduledWeeklyMarketReview(env, new Date("2026-06-13T04:45:00.000Z"));
    expect(duplicate?.warning).toContain("scheduled fallback attempt already exists");
    expect(db.rows).toHaveLength(1);
  });

  it("does not run scheduled fallback when Hermes is already ready", async () => {
    const db = new FakeWeeklyReviewDb();
    const env = createEnv(db);
    await publishWeeklyMarketReview(env, HERMES_PAYLOAD);
    const response = await maybeRunScheduledWeeklyMarketReview(env, new Date("2026-06-13T04:30:00.000Z"));
    expect(response?.ok).toBe(true);
    expect(response?.report?.generationProvider).toBe("hermes_gpt");
    expect(db.rows).toHaveLength(1);
  });

  it("requires admin auth for Brave Search usage", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/api/admin/brave-usage?days=14"),
      createEnv(),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(401);
  });

  it("returns Brave Search usage rows, totals, and clamped days for admin", async () => {
    const db = new FakeWeeklyReviewDb();
    db.braveUsageRows.push(
      {
        usageDay: "2026-06-13",
        caller: "daily_commentary",
        apiCallCount: 4,
        apiErrorCount: 1,
        cacheHitCount: 2,
        lastCalledAt: "2026-06-13T12:00:00.000Z",
        lastErrorAt: "2026-06-13T12:01:00.000Z",
        updatedAt: "2026-06-13T12:01:00.000Z",
      },
      {
        usageDay: "2026-06-13",
        caller: "fomc",
        apiCallCount: 3,
        apiErrorCount: 0,
        cacheHitCount: 6,
        lastCalledAt: "2026-06-13T18:00:00.000Z",
        lastErrorAt: null,
        updatedAt: "2026-06-13T18:00:00.000Z",
      },
    );

    const response = await worker.fetch(
      new Request("https://example.com/api/admin/brave-usage?days=500", {
        headers: { Authorization: "Bearer secret" },
      }),
      createEnv(db),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      days: 90,
      rows: [
        { usageDay: "2026-06-13", caller: "daily_commentary", apiCallCount: 4, apiErrorCount: 1, cacheHitCount: 2 },
        { usageDay: "2026-06-13", caller: "fomc", apiCallCount: 3, apiErrorCount: 0, cacheHitCount: 6 },
      ],
      totals: { apiCallCount: 7, apiErrorCount: 1, cacheHitCount: 8 },
    });
  });

  it("returns not found for missing report IDs", async () => {
    const report = await loadWeeklyMarketReviewById(createEnv(), "missing");
    expect(report).toBeNull();
  });
});
