import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, SnapshotEmptyResponse, SnapshotReadyResponse } from "../src/types";

const eodMocks = vi.hoisted(() => ({
  CORE_BREADTH_UNIVERSE_IDS: [
    "sp500-core",
    "nasdaq-core",
    "nyse-core",
    "russell2000-core",
    "overall-market-proxy",
  ],
  computeAndStoreSnapshot: vi.fn(),
  computeOverviewFreshnessDiagnostics: vi.fn(),
  emptySnapshotResponse: vi.fn((warning = "No stored overview snapshot is available. Use Refresh Overview Data to generate one.") => ({
    status: "empty",
    warning,
    asOfDate: null,
    generatedAt: null,
    providerLabel: null,
    freshnessStatus: "stale",
    freshnessCoveragePct: 0,
    freshnessCurrentCount: 0,
    freshnessEligibleCount: 0,
    freshnessCriticalMissingTickers: [],
    freshnessMinBarDate: null,
    freshnessMaxBarDate: null,
    freshnessWarning: warning,
    quoteOverlayRequestedCount: null,
    quoteOverlayReturnedCount: null,
    quoteOverlayError: null,
    quoteOverlayMissingSample: [],
    config: null,
    sections: [],
  })),
  loadSnapshot: vi.fn(),
  minBreadthCoveragePct: vi.fn((universeId: string) => universeId === "sp500-core" ? 98 : 95),
  OverviewFreshnessError: class OverviewFreshnessError extends Error {},
  recomputeBreadthFromStoredBars: vi.fn(),
  recomputeDashboardFromStoredBars: vi.fn(),
  refreshAndStoreOverviewSnapshot: vi.fn(),
  refreshSp500CoreBreadth: vi.fn(),
  publishReadyBreadthUniverses: vi.fn(),
}));

vi.mock("../src/eod", () => eodMocks);

const worker = (await import("../src/index")).default;

function createEnv(): Env {
  return {
    DB: {
      prepare: vi.fn(() => {
        throw new Error("GET /api/dashboard should not query D1 directly.");
      }),
    },
    APP_TIMEZONE: "Australia/Melbourne",
    DATA_PROVIDER: "alpaca",
    ALPACA_FEED: "iex",
  } as unknown as Env;
}

function createContext(): ExecutionContext {
  return {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

const readySnapshot: SnapshotReadyResponse = {
  asOfDate: "2026-05-26",
  generatedAt: "2026-05-27T01:08:37.085Z",
  providerLabel: "Stored Daily Bars",
  config: {
    id: "default",
    name: "Default Swing Dashboard",
    timezone: "Australia/Melbourne",
    eodRunLocalTime: "08:15",
    eodRunTimeLabel: "08:15 Australia/Melbourne (prev US close)",
    sections: [],
  },
  sections: [],
};

const emptySnapshot: SnapshotEmptyResponse = {
  status: "empty",
  warning: "No stored overview snapshot is available. Use Refresh Overview Data to generate one.",
  asOfDate: null,
  generatedAt: null,
  providerLabel: null,
  config: null,
  sections: [],
};

describe("dashboard API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the latest stored snapshot without running maintenance", async () => {
    eodMocks.loadSnapshot.mockResolvedValueOnce(readySnapshot);

    const env = createEnv();
    const response = await worker.fetch(new Request("https://example.com/api/dashboard"), env, createContext());
    const body = await response.json() as SnapshotReadyResponse;

    expect(response.status).toBe(200);
    expect(body.asOfDate).toBe("2026-05-26");
    expect(eodMocks.loadSnapshot).toHaveBeenCalledWith(env, "default", undefined, { allowComputeOnMissing: false });
    expect(eodMocks.computeAndStoreSnapshot).not.toHaveBeenCalled();
    expect(eodMocks.recomputeDashboardFromStoredBars).not.toHaveBeenCalled();
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });

  it("exposes recovery diagnostics separately from the pointed dashboard generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T22:00:00.000Z"));
    eodMocks.loadSnapshot.mockResolvedValueOnce(readySnapshot);
    const db = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          bind: (..._args: unknown[]) => statement,
          first: async <T>() => {
            if (sql.includes("JOIN overview_snapshot_pointer")) {
              return {
                generationId: "generation-2026-05-26",
                asOfDate: "2026-05-26",
                generatedAt: "2026-05-27T01:08:37.085Z",
                providerLabel: "Stored Daily Bars",
                expectedAsOfDate: "2026-05-26",
                status: "ready",
                publicationQuality: "ready",
                freshnessStatus: "fresh",
                freshnessCoveragePct: 100,
                freshnessCurrentCount: 225,
                freshnessEligibleCount: 225,
                freshnessCriticalMissingJson: "[]",
                freshnessMinBarDate: "2026-05-26",
                freshnessMaxBarDate: "2026-05-26",
                freshnessWarning: null,
                quoteOverlayRequestedCount: 225,
                quoteOverlayReturnedCount: 225,
                quoteOverlayError: null,
                quoteOverlayMissingSampleJson: "[]",
                sourceCycleId: "cycle-2026-05-26",
                publicationCoveragePct: 100,
                publicationCriticalMissingJson: "[]",
              } as T;
            }
            return null as T;
          },
        };
        return statement;
      }),
    };
    const marketDb = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          bind: (..._args: unknown[]) => statement,
          first: async <T>() => sql.includes("JOIN overview_snapshot_pointer") ? {
            generationId: "generation-2026-05-26",
            asOfDate: "2026-05-26",
            generatedAt: "2026-05-27T01:08:37.085Z",
            providerLabel: "Stored Daily Bars",
            expectedAsOfDate: "2026-05-26",
            status: "ready",
            publicationQuality: "ready",
            freshnessStatus: "fresh",
            freshnessCoveragePct: 100,
            freshnessCurrentCount: 225,
            freshnessEligibleCount: 225,
            freshnessCriticalMissingJson: "[]",
            freshnessMinBarDate: "2026-05-26",
            freshnessMaxBarDate: "2026-05-26",
            freshnessWarning: null,
            quoteOverlayRequestedCount: 225,
            quoteOverlayReturnedCount: 225,
            quoteOverlayError: null,
            quoteOverlayMissingSampleJson: "[]",
            sourceCycleId: "cycle-2026-05-26",
            publicationCoveragePct: 100,
            publicationCriticalMissingJson: "[]",
          } as T : null as T,
        };
        return statement;
      }),
    };
    const env = {
      ...createEnv(),
      DB: db,
      MARKET_DATA_DB: marketDb,
      OVERVIEW_PUBLICATION_RECOVERY_ENABLED: "true",
    } as unknown as Env;

    const response = await worker.fetch(new Request("https://example.com/api/dashboard"), env, createContext());
    const body = await response.json() as SnapshotReadyResponse;

    expect(body.asOfDate).toBe("2026-05-26");
    expect(body.overviewRecovery).toMatchObject({
      expectedAsOfDate: "2026-05-27",
      status: "idle",
      servingState: "stale_fallback",
      staleTradingSessions: 1,
    });
  });

  it("passes explicit config and date through the read-only loader", async () => {
    eodMocks.loadSnapshot.mockResolvedValueOnce(readySnapshot);

    const env = createEnv();
    const response = await worker.fetch(
      new Request("https://example.com/api/dashboard?configId=custom&date=2026-05-26"),
      env,
      createContext(),
    );

    expect(response.status).toBe(200);
    expect(eodMocks.loadSnapshot).toHaveBeenCalledWith(env, "custom", "2026-05-26", { allowComputeOnMissing: false });
    expect(eodMocks.computeAndStoreSnapshot).not.toHaveBeenCalled();
    expect(eodMocks.recomputeDashboardFromStoredBars).not.toHaveBeenCalled();
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });

  it("returns an empty snapshot response without recomputing when no stored snapshot exists", async () => {
    eodMocks.loadSnapshot.mockResolvedValueOnce(emptySnapshot);

    const env = createEnv();
    const response = await worker.fetch(new Request("https://example.com/api/dashboard"), env, createContext());
    const body = await response.json() as SnapshotEmptyResponse;

    expect(response.status).toBe(200);
    expect(body).toEqual(emptySnapshot);
    expect(eodMocks.computeAndStoreSnapshot).not.toHaveBeenCalled();
    expect(eodMocks.recomputeDashboardFromStoredBars).not.toHaveBeenCalled();
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });

  it("returns a degraded empty snapshot on load errors without recomputing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    eodMocks.loadSnapshot.mockRejectedValueOnce(new Error("snapshot table unavailable"));

    const env = createEnv();
    const response = await worker.fetch(new Request("https://example.com/api/dashboard"), env, createContext());
    const body = await response.json() as SnapshotEmptyResponse;

    expect(response.status).toBe(200);
    expect(body.status).toBe("empty");
    expect(body.warning).toBe("snapshot table unavailable");
    expect(errorSpy).toHaveBeenCalledWith(
      "dashboard read-only load failed",
      expect.objectContaining({
        configId: "default",
        date: undefined,
      }),
    );
    expect(eodMocks.computeAndStoreSnapshot).not.toHaveBeenCalled();
    expect(eodMocks.recomputeDashboardFromStoredBars).not.toHaveBeenCalled();
    expect(env.DB.prepare).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns a stale cached dashboard body when D1 resets after a successful load", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    eodMocks.loadSnapshot
      .mockResolvedValueOnce(readySnapshot)
      .mockRejectedValueOnce(new Error("D1_ERROR: D1 DB exceeded its CPU time limit and was reset."));

    const env = createEnv();
    const first = await worker.fetch(new Request("https://example.com/api/dashboard?date=2026-05-26"), env, createContext());
    expect(first.status).toBe(200);

    const second = await worker.fetch(new Request("https://example.com/api/dashboard?date=2026-05-26"), env, createContext());
    const body = await second.json() as SnapshotReadyResponse;

    expect(second.status).toBe(200);
    expect(second.headers.get("X-Dashboard-Stale-Fallback")).toBe("1");
    expect(body.asOfDate).toBe("2026-05-26");
    expect(body.freshnessWarning).toContain("most recent successful cached response");
    expect(eodMocks.computeAndStoreSnapshot).not.toHaveBeenCalled();
    expect(eodMocks.recomputeDashboardFromStoredBars).not.toHaveBeenCalled();
    expect(env.DB.prepare).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("does not trust stored overview freshness from an older snapshot date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T12:00:00.000Z"));
    eodMocks.computeOverviewFreshnessDiagnostics.mockResolvedValueOnce({
      expectedAsOfDate: "2026-06-12",
      status: "stale",
      eligibleCount: 4,
      currentCount: 0,
      staleCount: 4,
      coveragePct: 0,
      criticalMissingTickers: ["SPY", "QQQ"],
      minBarDate: "2026-06-05",
      maxBarDate: "2026-06-05",
      warning: "Stale: SPY, QQQ last updated 2026-06-05; expected 2026-06-12.",
    });
    const db = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          bind: (..._args: unknown[]) => statement,
          first: async <T>() => {
            if (sql.includes("FROM dashboard_configs WHERE is_default = 1")) {
              return {
                id: "default",
                name: "Default Swing Dashboard",
                timezone: "Australia/Melbourne",
                eodRunLocalTime: "08:15",
                eodRunTimeLabel: "08:15 Australia/Melbourne (prev US close)",
              } as T;
            }
            if (sql.includes("FROM snapshots_meta")) {
              return {
                asOfDate: "2026-06-05",
                generatedAt: "2026-06-13T00:15:00.000Z",
                providerLabel: "Stored Daily Bars",
                expectedAsOfDate: "2026-06-05",
                freshnessStatus: "fresh",
                freshnessCoveragePct: 100,
                freshnessCurrentCount: 4,
                freshnessEligibleCount: 4,
                freshnessCriticalMissingJson: "[]",
                freshnessMinBarDate: "2026-06-05",
                freshnessMaxBarDate: "2026-06-05",
                freshnessWarning: null,
              } as T;
            }
            if (sql.includes("FROM breadth_snapshots")) return null as T;
            return null as T;
          },
        };
        return statement;
      }),
    };

    const env = {
      ...createEnv(),
      DB: db,
    } as unknown as Env;
    const response = await worker.fetch(new Request("https://example.com/api/status?page=overview"), env, createContext());
    const body = await response.json() as { expectedAsOfDate: string; freshnessStatus: string; freshnessMaxBarDate: string | null };

    expect(response.status).toBe(200);
    expect(body.expectedAsOfDate).toBe("2026-06-12");
    expect(body.freshnessStatus).toBe("stale");
    expect(body.freshnessMaxBarDate).toBe("2026-06-05");
    expect(eodMocks.computeOverviewFreshnessDiagnostics).toHaveBeenCalledWith(env, "2026-06-12", "default");
  });

  it("keeps status pointed at the published generation while exposing a newer recovery candidate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00.000Z"));
    let snapshotsMetaQueried = false;
    const db = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          bind: (..._args: unknown[]) => statement,
          first: async <T>() => {
            if (sql.includes("FROM dashboard_configs")) {
              return {
                id: "default",
                name: "Default Swing Dashboard",
                timezone: "Australia/Melbourne",
                eodRunLocalTime: "08:15",
                eodRunTimeLabel: "08:15 Australia/Melbourne (prev US close)",
              } as T;
            }
            if (sql.includes("JOIN overview_snapshot_pointer")) {
              return {
                generationId: "published-2026-08-13",
                asOfDate: "2026-08-13",
                generatedAt: "2026-08-13T22:00:00.000Z",
                providerLabel: "Stored Daily Bars",
                expectedAsOfDate: "2026-08-13",
                status: "ready",
                publicationQuality: "ready",
                freshnessStatus: "fresh",
                freshnessCoveragePct: 88.9,
                freshnessCurrentCount: 200,
                freshnessEligibleCount: 225,
                freshnessCriticalMissingJson: "[]",
                freshnessMinBarDate: "2026-08-13",
                freshnessMaxBarDate: "2026-08-13",
                freshnessWarning: null,
                quoteOverlayRequestedCount: 225,
                quoteOverlayReturnedCount: 200,
                quoteOverlayError: null,
                quoteOverlayMissingSampleJson: "[]",
                sourceCycleId: "cycle-2026-08-13",
                publicationCoveragePct: 88.9,
                publicationCriticalMissingJson: "[]",
              } as T;
            }
            if (sql.includes("FROM snapshots_meta")) {
              snapshotsMetaQueried = true;
              return { asOfDate: "2026-08-14", generatedAt: "2026-08-14T22:00:00.000Z" } as T;
            }
            return null as T;
          },
          all: async <T>() => ({ results: [] as T[] }),
        };
        return statement;
      }),
    };
    const marketDb = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          bind: (..._args: unknown[]) => statement,
          first: async <T>() => {
            if (sql.includes("JOIN overview_snapshot_pointer")) {
              return {
                generationId: "published-2026-08-13",
                asOfDate: "2026-08-13",
                generatedAt: "2026-08-13T22:00:00.000Z",
                providerLabel: "Stored Daily Bars",
                expectedAsOfDate: "2026-08-13",
                status: "ready",
                publicationQuality: "ready",
                freshnessStatus: "fresh",
                freshnessCoveragePct: 88.9,
                freshnessCurrentCount: 200,
                freshnessEligibleCount: 225,
                freshnessCriticalMissingJson: "[]",
                freshnessMinBarDate: "2026-08-13",
                freshnessMaxBarDate: "2026-08-13",
                freshnessWarning: null,
                quoteOverlayRequestedCount: 225,
                quoteOverlayReturnedCount: 200,
                quoteOverlayError: null,
                quoteOverlayMissingSampleJson: "[]",
                sourceCycleId: "cycle-2026-08-13",
                publicationCoveragePct: 88.9,
                publicationCriticalMissingJson: "[]",
              } as T;
            }
            if (sql.includes("FROM overview_current_refresh_jobs")) {
              return {
                configId: "default",
                sessionDate: "2026-08-14",
                status: "completed",
                attemptCount: 3,
                nextAttemptAt: null,
                updatedAt: "2026-08-14T22:05:00.000Z",
                cycleId: "cycle-2026-08-14",
                cycleStartedAt: "2026-08-14T21:30:00.000Z",
                cursorOffset: 0,
                processedTickers: 225,
                requestedTickers: 225,
                freshTickers: 220,
                unavailableTickers: 5,
                leaseExpiresAt: null,
                lastError: null,
                lastErrorCode: null,
              } as T;
            }
            return null as T;
          },
          all: async <T>() => ({ results: [] as T[] }),
        };
        return statement;
      }),
    };
    const env = {
      ...createEnv(),
      DB: db,
      MARKET_DATA_DB: marketDb,
      OVERVIEW_PUBLICATION_RECOVERY_ENABLED: "true",
    } as unknown as Env;

    const response = await worker.fetch(new Request("https://example.com/api/status?page=overview"), env, createContext());
    const body = await response.json() as {
      asOfDate: string;
      freshnessStatus: string;
      freshnessCurrentCount: number;
      freshnessEligibleCount: number;
      servingState: string;
      overviewRecovery: { expectedAsOfDate: string; status: string; sourceCycleId: string };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      asOfDate: "2026-08-13",
      freshnessStatus: "stale",
      freshnessCurrentCount: 200,
      freshnessEligibleCount: 225,
      servingState: "stale_fallback",
      overviewRecovery: {
        expectedAsOfDate: "2026-08-14",
        status: "ready_to_publish",
        sourceCycleId: "cycle-2026-08-14",
      },
    });
    expect(snapshotsMetaQueried).toBe(false);
  });

  it("reports matching legacy overview snapshots with 0/0 diagnostics as stale unknown displayed data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T12:00:00.000Z"));
    const db = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          bind: (..._args: unknown[]) => statement,
          first: async <T>() => {
            if (sql.includes("FROM dashboard_configs WHERE is_default = 1")) {
              return {
                id: "default",
                name: "Default Swing Dashboard",
                timezone: "Australia/Melbourne",
                eodRunLocalTime: "08:15",
                eodRunTimeLabel: "08:15 Australia/Melbourne (prev US close)",
              } as T;
            }
            if (sql.includes("FROM snapshots_meta")) {
              return {
                asOfDate: "2026-06-12",
                generatedAt: "2026-06-12T22:16:17.521Z",
                providerLabel: "Stored Daily Bars",
                expectedAsOfDate: null,
                freshnessStatus: "stale",
                freshnessCoveragePct: 0,
                freshnessCurrentCount: 0,
                freshnessEligibleCount: 0,
                freshnessCriticalMissingJson: "[]",
                freshnessMinBarDate: null,
                freshnessMaxBarDate: null,
                freshnessWarning: null,
              } as T;
            }
            if (sql.includes("FROM breadth_snapshots")) return null as T;
            return null as T;
          },
        };
        return statement;
      }),
    };

    const env = {
      ...createEnv(),
      DB: db,
    } as unknown as Env;
    const response = await worker.fetch(new Request("https://example.com/api/status?page=overview"), env, createContext());
    const body = await response.json() as {
      expectedAsOfDate: string;
      freshnessStatus: string;
      freshnessCoveragePct: number | null;
      freshnessCurrentCount: number | null;
      freshnessEligibleCount: number | null;
      freshnessMinBarDate: string | null;
      freshnessMaxBarDate: string | null;
      freshnessWarning: string | null;
    };

    expect(response.status).toBe(200);
    expect(body.expectedAsOfDate).toBe("2026-06-12");
    expect(body.freshnessStatus).toBe("stale");
    expect(body.freshnessCoveragePct).toBeNull();
    expect(body.freshnessCurrentCount).toBeNull();
    expect(body.freshnessEligibleCount).toBeNull();
    expect(body.freshnessMinBarDate).toBeNull();
    expect(body.freshnessMaxBarDate).toBeNull();
    expect(body.freshnessWarning).toContain("Snapshot freshness diagnostics are unavailable");
    expect(eodMocks.computeOverviewFreshnessDiagnostics).not.toHaveBeenCalled();
  });

  it("includes read-only breadth diagnostics when breadth is behind overview", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T12:00:00.000Z"));
    const primaryPreparedSql: string[] = [];
    const marketDataPreparedSql: string[] = [];
    const sharedTicker = "SHARED";
    const sp500Tickers = [
      ...Array.from({ length: 99 }, (_, index) => `SP${index}`),
      sharedTicker,
    ];
    const nasdaqTickers = [
      ...Array.from({ length: 9 }, (_, index) => `ND${index}`),
      sharedTicker,
    ];
    const nyseTickers = ["NYSE0", sharedTicker];
    const russellTickers = ["R2K0"];
    const overallTickers = [sharedTicker, "OVERALL0"];
    const primaryDb = {
      prepare: vi.fn((sql: string) => {
        primaryPreparedSql.push(sql);
        if (sql.includes("daily_bars") || sql.includes("alpaca_daily_bars")) {
          throw new Error("primary DB must not be queried for breadth bars");
        }
        const statement = {
          bind: (..._args: unknown[]) => statement,
          first: async <T>() => {
            if (sql.includes("FROM dashboard_configs WHERE is_default = 1")) {
              return {
                id: "default",
                name: "Default Swing Dashboard",
                timezone: "Australia/Melbourne",
                eodRunLocalTime: "08:15",
                eodRunTimeLabel: "08:15 Australia/Melbourne (prev US close)",
              } as T;
            }
            if (sql.includes("FROM snapshots_meta")) {
              return {
                asOfDate: "2026-06-12",
                generatedAt: "2026-06-12T22:16:17.521Z",
                providerLabel: "Stored Daily Bars",
                expectedAsOfDate: "2026-06-12",
                freshnessStatus: "fresh",
                freshnessCoveragePct: 100,
                freshnessCurrentCount: 4,
                freshnessEligibleCount: 4,
                freshnessCriticalMissingJson: "[]",
                freshnessMinBarDate: "2026-06-12",
                freshnessMaxBarDate: "2026-06-12",
                freshnessWarning: null,
              } as T;
            }
            if (sql.includes("FROM breadth_snapshots")) {
              return { asOfDate: "2026-06-10", generatedAt: "2026-06-11T03:27:00.000Z" } as T;
            }
            return null as T;
          },
          all: async <T>() => ({
            results: [] as T[],
          }),
        };
        return statement;
      }),
    };
    const marketDataDb = {
      prepare: vi.fn((sql: string) => {
        marketDataPreparedSql.push(sql);
        const statement = {
          bind: (..._args: unknown[]) => statement,
          all: async <T>() => {
            if (sql.includes("WITH published AS")) {
              const eligibleByUniverse: Record<string, number> = {
                "sp500-core": 41,
                "nasdaq-core": 1,
                "nyse-core": 1,
                "russell2000-core": 1,
                "overall-market-proxy": 1,
              };
              return {
                results: Object.entries(eligibleByUniverse).map(([universeId, eligible]) => ({
                  asOfDate: "2026-06-10",
                  universeId,
                  advancers: eligible,
                  decliners: 0,
                  unchanged: 0,
                  pctAbove20MA: 50,
                  pctAbove50MA: 50,
                  pctAbove200MA: 50,
                  new20DHighs: 0,
                  new20DLows: 0,
                  medianReturn1D: 0,
                  medianReturn5D: 0,
                  sentimentJson: JSON.stringify({ metrics: { memberCount: eligible } }),
                  generatedAt: "2026-06-11T03:27:00.000Z",
                  generationId: "breadth-2026-06-10",
                  publishedGenerationId: "breadth-2026-06-10",
                  publishedAsOfDate: "2026-06-10",
                  publishedGeneratedAt: "2026-06-11T03:27:00.000Z",
                  publishedProviderLabel: "Alpaca SIP split-adjusted completed daily bars; Alpaca IEX exact-session fallback.",
                })) as T[],
              };
            }
            if (sql.includes("FROM universes u")) {
              const memberCountByUniverse: Record<string, number> = {
                "sp500-core": sp500Tickers.length,
                "nasdaq-core": nasdaqTickers.length,
                "nyse-core": nyseTickers.length,
                "russell2000-core": russellTickers.length,
                "overall-market-proxy": overallTickers.length,
              };
              return {
                results: Object.entries(memberCountByUniverse).map(([universeId, memberCount]) => ({
                  universeId,
                  universeName: universeId,
                  memberCount,
                  versionId: `${universeId}-v1`,
                  source: "validated-proxy",
                  sourceType: "public-common-stock-proxy",
                  sourceUrl: "https://example.test/source",
                  sourceAsOfDate: "2026-06-10",
                  sourceMemberCount: memberCount,
                  resolvedMemberCount: memberCount,
                  unresolvedCount: 0,
                  validationError: null,
                })) as T[],
              };
            }
            if (sql.includes("FROM data_readiness")) return { results: [] as T[] };
            return {
              results: [
                { sessionDate: "2026-06-12" },
                { sessionDate: "2026-06-11" },
                { sessionDate: "2026-06-10" },
              ] as T[],
            };
          },
        };
        return statement;
      }),
    };

    const env = {
      ...createEnv(),
      DB: primaryDb,
      MARKET_DATA_DB: marketDataDb,
      MARKET_DATA_DB_REQUIRED: "true",
    } as unknown as Env;
    const response = await worker.fetch(new Request("https://example.com/api/status?page=overview"), env, createContext());
    const body = await response.json() as {
      breadthExpectedAsOfDate: string;
      breadthStatus: string;
      breadthLatestAsOfDate: string | null;
      breadthWarning: string | null;
      breadthDiagnostics: Array<{
        universeId: string;
        status: string;
        latestAsOfDate: string | null;
        memberCount: number;
        currentDateTickers: number;
        coveragePct: number;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.breadthExpectedAsOfDate).toBe("2026-06-12");
    expect(body.breadthStatus).toBe("stale");
    expect(body.breadthLatestAsOfDate).toBe("2026-06-10");
    expect(body.breadthWarning).toContain("Breadth universes are not current");
    expect(body.breadthDiagnostics).toMatchObject([
      {
        universeId: "sp500-core",
        status: "low_coverage",
        latestAsOfDate: "2026-06-10",
        memberCount: 100,
        currentDateTickers: 41,
        coveragePct: 41,
      },
      {
        universeId: "nasdaq-core",
        status: "low_coverage",
        latestAsOfDate: "2026-06-10",
        memberCount: 10,
        currentDateTickers: 1,
        coveragePct: 10,
      },
      {
        universeId: "nyse-core",
        status: "low_coverage",
        latestAsOfDate: "2026-06-10",
        memberCount: 2,
        currentDateTickers: 1,
        coveragePct: 50,
      },
      {
        universeId: "russell2000-core",
        status: "low_coverage",
        latestAsOfDate: "2026-06-10",
        memberCount: 1,
        currentDateTickers: 1,
        coveragePct: 100,
      },
      {
        universeId: "overall-market-proxy",
        status: "low_coverage",
        latestAsOfDate: "2026-06-10",
        memberCount: 2,
        currentDateTickers: 1,
        coveragePct: 50,
      },
    ]);
    expect(primaryPreparedSql.join("\n")).not.toContain("FROM universe_symbols");
    expect(primaryPreparedSql.join("\n")).not.toContain("daily_bars");
    expect(primaryPreparedSql.join("\n")).not.toContain("alpaca_daily_bars");
    expect(marketDataPreparedSql.join("\n")).toContain("FROM breadth_snapshots");
    expect(marketDataPreparedSql.join("\n")).toContain("FROM universes u");
    expect(marketDataPreparedSql.join("\n")).not.toContain("FROM alpaca_daily_bars");
  });

  it("fails breadth coverage diagnostics safely when MARKET_DATA_DB is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T12:00:00.000Z"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const primaryDb = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          bind: (..._args: unknown[]) => statement,
          first: async <T>() => {
            if (sql.includes("FROM dashboard_configs WHERE is_default = 1")) {
              return {
                id: "default",
                name: "Default Swing Dashboard",
                timezone: "Australia/Melbourne",
                eodRunLocalTime: "08:15",
                eodRunTimeLabel: "08:15 Australia/Melbourne (prev US close)",
              } as T;
            }
            if (sql.includes("FROM snapshots_meta")) {
              return {
                asOfDate: "2026-06-12",
                generatedAt: "2026-06-12T22:16:17.521Z",
                providerLabel: "Stored Daily Bars",
                expectedAsOfDate: "2026-06-12",
                freshnessStatus: "fresh",
                freshnessCoveragePct: 100,
                freshnessCurrentCount: 2,
                freshnessEligibleCount: 2,
                freshnessCriticalMissingJson: "[]",
                freshnessMinBarDate: "2026-06-12",
                freshnessMaxBarDate: "2026-06-12",
                freshnessWarning: null,
              } as T;
            }
            if (sql.includes("FROM breadth_snapshots")) {
              return { asOfDate: "2026-06-11", generatedAt: "2026-06-12T03:27:00.000Z" } as T;
            }
            return null as T;
          },
          all: async <T>() => ({
            results: sql.includes("FROM universe_symbols")
              ? [
                  { universeId: "sp500-core", ticker: "SPY" },
                  { universeId: "nasdaq-core", ticker: "QQQ" },
                ] as T[]
              : [],
          }),
        };
        return statement;
      }),
    };
    const unavailableBindings = [
      undefined,
      {
        prepare: vi.fn(() => {
          throw new Error("market-data unavailable");
        }),
      },
    ];

    for (const marketDataDb of unavailableBindings) {
      const env = {
        ...createEnv(),
        DB: primaryDb,
        MARKET_DATA_DB: marketDataDb,
        MARKET_DATA_DB_REQUIRED: "true",
      } as unknown as Env;

      const response = await worker.fetch(new Request("https://example.com/api/status?page=breadth"), env, createContext());
      const body = await response.json() as {
        breadthStatus: string;
        breadthWarning: string | null;
        breadthDiagnostics: Array<{
          status: string;
          latestAsOfDate: string | null;
          latestGeneratedAt: string | null;
        }>;
      };

      expect(response.status).toBe(200);
      expect(body.breadthStatus).toBe("stale");
      expect(body.breadthWarning).toContain("could not be verified");
      expect(body.breadthDiagnostics).toHaveLength(5);
      expect(body.breadthDiagnostics.every((row) => row.status !== "fresh")).toBe(true);
      expect(body.breadthDiagnostics.every((row) => row.latestAsOfDate === null)).toBe(true);
      expect(body.breadthDiagnostics.every((row) => row.latestGeneratedAt === null)).toBe(true);
    }

    expect(primaryDb.prepare.mock.calls.map(([sql]) => sql).join("\n")).not.toContain("alpaca_daily_bars");
    errorSpy.mockRestore();
  });

  it("returns a recoverable overview refresh response when D1 resets during the refresh request", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = {
      ...createEnv(),
      ADMIN_SECRET: "secret",
      DB: {
        prepare: vi.fn(() => {
          throw new Error("D1_ERROR: D1 DB exceeded its CPU time limit and was reset.");
        }),
      },
    } as unknown as Env;

    const response = await worker.fetch(
      new Request("https://example.com/api/admin/refresh-page", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: JSON.stringify({ page: "overview" }),
      }),
      env,
      createContext(),
    );
    const body = await response.json() as { ok: boolean; page: string; refreshedTickers: number; notes: string };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      page: "overview",
      refreshedTickers: 0,
    });
    expect(body.notes).toContain("Existing overview data remains available");
    errorSpy.mockRestore();
  });

  it("runs stored-bars-only overview recompute when admin run-eod has storedOnly=1", async () => {
    eodMocks.recomputeDashboardFromStoredBars.mockResolvedValueOnce({
      snapshotId: "snapshot-1",
      asOfDate: "2026-06-18",
      freshness: {
        expectedAsOfDate: "2026-06-18",
        status: "partial",
        eligibleCount: 10,
        currentCount: 8,
        staleCount: 2,
        coveragePct: 80,
        criticalMissingTickers: [],
        minBarDate: "2026-06-12",
        maxBarDate: "2026-06-18",
        warning: null,
      },
    });
    const env = {
      ...createEnv(),
      ADMIN_SECRET: "secret",
    } as Env;

    const response = await worker.fetch(
      new Request("https://example.com/api/admin/run-eod?date=2026-06-18&configId=default&storedOnly=1", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
      }),
      env,
      createContext(),
    );
    const body = await response.json() as { ok: boolean; snapshotId: string; asOfDate: string };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, snapshotId: "snapshot-1", asOfDate: "2026-06-18" });
    expect(eodMocks.recomputeDashboardFromStoredBars).toHaveBeenCalledWith(env, "2026-06-18", "default");
    expect(eodMocks.computeAndStoreSnapshot).not.toHaveBeenCalled();
  });
});
