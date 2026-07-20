import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, SnapshotEmptyResponse, SnapshotReadyResponse } from "../src/types";

const eodMocks = vi.hoisted(() => ({
  CORE_BREADTH_UNIVERSE_IDS: ["sp500-core", "nasdaq-core"],
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
  OverviewFreshnessError: class OverviewFreshnessError extends Error {},
  recomputeBreadthFromStoredBars: vi.fn(),
  recomputeDashboardFromStoredBars: vi.fn(),
  refreshAndStoreOverviewSnapshot: vi.fn(),
  refreshSp500CoreBreadth: vi.fn(),
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
    const sp500Tickers = Array.from({ length: 100 }, (_, index) => `SP${index}`);
    const nasdaqTickers = Array.from({ length: 10 }, (_, index) => `ND${index}`);
    const membershipRows = [
      ...sp500Tickers.map((ticker) => ({ universeId: "sp500-core", ticker })),
      ...nasdaqTickers.map((ticker) => ({ universeId: "nasdaq-core", ticker })),
    ];
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
            results: sql.includes("FROM universe_symbols") ? membershipRows as T[] : [],
          }),
        };
        return statement;
      }),
    };
    const marketDataDb = {
      prepare: vi.fn((sql: string) => {
        marketDataPreparedSql.push(sql);
        if (!sql.includes("FROM alpaca_daily_bars")) {
          throw new Error("market-data DB must only be queried for breadth bars");
        }
        const statement = {
          bind: (feed: string, tickersJson: string, date: string) => {
            expect(feed).toBe("iex");
            expect(JSON.parse(tickersJson)).toEqual([...sp500Tickers, ...nasdaqTickers]);
            expect(date).toBe("2026-06-12");
            return statement;
          },
          all: async <T>() => ({
            results: sp500Tickers.slice(0, 40).map((ticker) => ({ ticker })) as T[],
          }),
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
      breadthDiagnostics: Array<{ universeId: string; status: string; latestAsOfDate: string | null; coveragePct: number }>;
    };

    expect(response.status).toBe(200);
    expect(body.breadthExpectedAsOfDate).toBe("2026-06-12");
    expect(body.breadthStatus).toBe("stale");
    expect(body.breadthLatestAsOfDate).toBe("2026-06-10");
    expect(body.breadthWarning).toContain("Breadth history is not current");
    expect(body.breadthDiagnostics[0]).toMatchObject({
      universeId: "sp500-core",
      status: "low_coverage",
      latestAsOfDate: "2026-06-10",
      coveragePct: 40,
    });
    expect(primaryPreparedSql.join("\n")).toContain("FROM universe_symbols");
    expect(primaryPreparedSql.join("\n")).not.toContain("daily_bars");
    expect(primaryPreparedSql.join("\n")).not.toContain("alpaca_daily_bars");
    expect(marketDataPreparedSql.join("\n")).toContain("FROM alpaca_daily_bars");
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
    const env = {
      ...createEnv(),
      DB: primaryDb,
      MARKET_DATA_DB: {
        prepare: vi.fn(() => {
          throw new Error("market-data unavailable");
        }),
      },
      MARKET_DATA_DB_REQUIRED: "true",
    } as unknown as Env;

    const response = await worker.fetch(new Request("https://example.com/api/status?page=breadth"), env, createContext());
    const body = await response.json() as {
      breadthStatus: string;
      breadthWarning: string | null;
      breadthDiagnostics: Array<{ status: string }>;
    };
    errorSpy.mockRestore();

    expect(response.status).toBe(200);
    expect(body.breadthStatus).toBe("stale");
    expect(body.breadthWarning).toContain("could not be verified");
    expect(body.breadthDiagnostics).toHaveLength(2);
    expect(body.breadthDiagnostics.every((row) => row.status !== "fresh")).toBe(true);
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
