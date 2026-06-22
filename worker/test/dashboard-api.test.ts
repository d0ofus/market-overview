import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, SnapshotEmptyResponse, SnapshotReadyResponse } from "../src/types";

const eodMocks = vi.hoisted(() => ({
  computeAndStoreSnapshot: vi.fn(),
  computeOverviewFreshnessDiagnostics: vi.fn(),
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
  warning: "No stored overview snapshot is available. Use Admin refresh to generate one.",
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

  it("returns a load error without recomputing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    eodMocks.loadSnapshot.mockRejectedValueOnce(new Error("snapshot table unavailable"));

    const env = createEnv();
    const response = await worker.fetch(new Request("https://example.com/api/dashboard"), env, createContext());
    const body = await response.json() as { error: string };

    expect(response.status).toBe(500);
    expect(body.error).toBe("snapshot table unavailable");
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
