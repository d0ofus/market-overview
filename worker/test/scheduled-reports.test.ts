import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

const scheduledMocks = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    eod: {
      CORE_BREADTH_UNIVERSE_IDS: ["sp500-core", "nasdaq-core"],
      computeAndStoreBreadth: vi.fn(),
      computeAndStoreSnapshot: vi.fn(),
      computeOverviewFreshnessDiagnostics: vi.fn(),
      isOverviewFreshnessSufficientForScheduledSnapshot: vi.fn(() => true),
      loadSnapshot: vi.fn(),
      OverviewFreshnessError: class OverviewFreshnessError extends Error {
        diagnostics: unknown;
        constructor(diagnostics: unknown) {
          super("overview freshness error");
          this.diagnostics = diagnostics;
        }
      },
      recomputeBreadthFromStoredBars: vi.fn(async () => {
        calls.push("breadth");
        throw new Error("breadth recompute failed");
      }),
      recomputeDashboardFromStoredBars: vi.fn(),
      refreshAndStoreOverviewSnapshot: vi.fn(async () => {
        calls.push("overview");
      }),
      refreshMissingBreadthBarsForCoverage: vi.fn(),
    },
    commentary: {
      loadMarketCommentarySettings: vi.fn(),
      loadLatestMarketCommentary: vi.fn(),
      maybeRunScheduledMarketCommentary: vi.fn(async () => {
        calls.push("commentary");
        return null;
      }),
      refreshMarketCommentary: vi.fn(),
      resetMarketCommentarySettings: vi.fn(),
      updateMarketCommentarySettings: vi.fn(),
    },
    weekly: {
      generateWeeklyMarketReview: vi.fn(),
      listWeeklyMarketReviews: vi.fn(),
      loadLatestWeeklyMarketReview: vi.fn(),
      loadWeeklyMarketReviewById: vi.fn(),
      maybeRunScheduledWeeklyMarketReview: vi.fn(async () => {
        calls.push("weekly");
        return { status: "skipped" };
      }),
      publishWeeklyMarketReview: vi.fn(),
    },
    fomc: {
      loadOrRefreshLatestFomcCommentary: vi.fn(),
      refreshFomcCommentary: vi.fn(),
      refreshLatestFomcCommentary: vi.fn(),
      shouldRunScheduledFomcRefresh: vi.fn(async () => false),
    },
  };
});

vi.mock("../src/eod", () => scheduledMocks.eod);
vi.mock("../src/market-commentary-service", () => scheduledMocks.commentary);
vi.mock("../src/weekly-market-review-service", () => scheduledMocks.weekly);
vi.mock("../src/fomc-commentary-service", () => scheduledMocks.fomc);

const worker = (await import("../src/index")).default;

class FakeScheduledReportsDb {
  prepare(sql: string) {
    const statement = {
      bind: (..._args: unknown[]) => statement,
      async first<T>() {
        if (sql.includes("FROM dashboard_configs")) {
          return {
            id: "default",
            timezone: "Australia/Melbourne",
            eodRunLocalTime: "08:15",
            eodRunTimeLabel: "08:15 Australia/Melbourne (prev US close)",
          } as T;
        }
        if (sql.includes("FROM snapshots_meta")) {
          return {
            asOfDate: "2026-06-29",
            freshnessStatus: "fresh",
            freshnessCoveragePct: 100,
          } as T;
        }
        if (sql.includes("FROM universe_symbols")) {
          return { count: 2 } as T;
        }
        if (sql.includes("FROM breadth_snapshots")) {
          return { count: 0 } as T;
        }
        return null as T;
      },
      async all<T>() {
        return { results: [] as T[] };
      },
      async run() {
        return { meta: { rows_written: 1 } };
      },
    };
    return statement;
  }
}

function createEnv(): Env {
  return {
    DB: new FakeScheduledReportsDb() as unknown as D1Database,
    APP_TIMEZONE: "Australia/Melbourne",
    SCHEDULED_REPORTS_BUDGET: "50",
    SCHEDULED_SUBREQUEST_RESERVE: "0",
  } as Env;
}

describe("scheduled reports lane", () => {
  it("runs commentary before breadth and still advances weekly when breadth fails", async () => {
    scheduledMocks.calls.length = 0;
    scheduledMocks.eod.recomputeBreadthFromStoredBars.mockClear();
    scheduledMocks.commentary.maybeRunScheduledMarketCommentary.mockClear();
    scheduledMocks.weekly.maybeRunScheduledWeeklyMarketReview.mockClear();

    await worker.scheduled(
      { cron: "11,26,41,56 * * * *", scheduledTime: Date.parse("2026-06-29T23:11:00.000Z") } as ScheduledEvent,
      createEnv(),
      { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext,
    );

    expect(scheduledMocks.calls).toEqual(["commentary", "breadth", "weekly"]);
    expect(scheduledMocks.weekly.maybeRunScheduledWeeklyMarketReview).toHaveBeenCalled();
  });
});
