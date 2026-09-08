import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

const mocks = vi.hoisted(() => ({
  loadSnapshot: vi.fn(),
  loadBreadthDashboard: vi.fn(),
  eodStatus: vi.fn(),
  expectedEodSession: vi.fn(),
  requestEodRefresh: vi.fn(),
}));

vi.mock("../src/eod", async (original) => ({
  ...await original<typeof import("../src/eod")>(), loadSnapshot: mocks.loadSnapshot,
}));
vi.mock("../src/breadth-dashboard-service", async (original) => ({
  ...await original<typeof import("../src/breadth-dashboard-service")>(), loadBreadthDashboard: mocks.loadBreadthDashboard,
}));
vi.mock("../src/eod-coordinator", async (original) => ({
  ...await original<typeof import("../src/eod-coordinator")>(), eodStatus: mocks.eodStatus,
  expectedEodSession: mocks.expectedEodSession, requestEodRefresh: mocks.requestEodRefresh,
}));

const worker = (await import("../src/index")).default;
const db = { prepare: vi.fn(() => { throw new Error("Status and EOD routing must not query legacy storage or providers."); }) };
const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
const environment = () => ({ DB: db, MARKET_DATA_DB: db, OPS_DB: db, EOD_RUNNER_MODE: "active",
  EOD_READ_ENABLED: "true", ADMIN_SECRET: "test-only", APP_TIMEZONE: "Australia/Melbourne" }) as unknown as Env;

function request(path: string, body?: unknown, authorized = true) {
  return new Request(`https://example.test${path}`, { method: "POST",
    headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: "Bearer test-only" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("EOD API compatibility and calendar routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T18:35:00Z"));
    mocks.expectedEodSession.mockResolvedValue("2026-11-27");
    mocks.requestEodRefresh.mockResolvedValue({ id: "eod:active:2026-11-27:reconcile" });
    mocks.loadSnapshot.mockResolvedValue({ config: { id: "default", timezone: "Australia/Melbourne" },
      asOfDate: "2026-11-25", generatedAt: "2026-11-25T21:30:00Z", providerLabel: "Stored coherent EOD sources",
      servingState: "stale_fallback", staleTradingSessions: 1, freshnessStatus: "stale", freshnessCoveragePct: 0,
      freshnessCurrentCount: 0, freshnessEligibleCount: 105, sections: [],
    });
    mocks.loadBreadthDashboard.mockResolvedValue({ generatedAt: "2026-11-27T18:25:00Z",
      providerLabel: "Stored Breadth EOD sources", overallHealth: "partial", warning: "One universe remains stale.",
      universes: ["sp500-core", "nasdaq-core"].map((universeId, index) => ({
        universeId, displayedAsOfSession: index ? "2026-11-25" : "2026-11-27",
        displayedSnapshot: { generatedAt: index ? "2026-11-25T21:30:00Z" : "2026-11-27T18:25:00Z" },
        memberCount: 500, exactSessionCount: 499, coveragePct: 99.8, requiredCoveragePct: 98,
        freshness: index ? "stale" : "fresh", staleTradingSessions: index, error: null,
      })),
    });
    mocks.eodStatus.mockResolvedValue({ status: "active", ready: false, expectedSession: "2026-11-27",
      missingScopes: ["breadth:nasdaq-core"], publications: [], runs: [], quota: { status: "unknown", rowsRead: null },
    });
  });
  afterEach(() => vi.useRealTimers());

  it.each(["overview", "breadth"])("serves %s status from displayed publications and independent readiness without legacy diagnostics", async (page) => {
    const env = environment();
    const response = await worker.fetch(new Request(`https://example.test/api/status?page=${page}`), env, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const result = await response.json() as Record<string, unknown>;
    expect(result).toMatchObject({ asOfDate: "2026-11-25", dataProvider: "eod-publications",
      expectedAsOfDate: "2026-11-27", breadthLatestAsOfDate: "2026-11-27", breadthStatus: "partial",
      eodReadiness: { ready: false, missingScopes: ["breadth:nasdaq-core"], quota: { rowsRead: null } },
    });
    expect(result.servingState).toBe(page === "breadth" ? "degraded" : "stale_fallback");
    expect(mocks.loadSnapshot).toHaveBeenCalledWith(env, "default", undefined, { allowComputeOnMissing: false });
    expect(db.prepare).not.toHaveBeenCalled();
    expect(mocks.requestEodRefresh).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/admin/run-eod", undefined],
    ["/api/admin/overview-current/refresh", undefined],
    ["/api/admin/overview-current/history-refresh", undefined],
    ["/api/admin/overview-current/rebuild", undefined],
    ["/api/admin/refresh-page", { page: "overview" }],
    ["/api/admin/refresh-page", { page: "breadth" }],
  ])("routes %s to the completed early-close session", async (path, body) => {
    const env = environment();
    const response = await worker.fetch(request(path, body), env, context);
    expect(response.status).toBe(202);
    expect(mocks.expectedEodSession).toHaveBeenCalledWith(env);
    expect(mocks.requestEodRefresh).toHaveBeenCalledWith(env, "2026-11-27");
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("preserves an explicitly requested historical session", async () => {
    const env = environment();
    const response = await worker.fetch(request("/api/admin/run-eod?date=2026-11-25"), env, context);
    expect(response.status).toBe(202);
    expect(mocks.expectedEodSession).not.toHaveBeenCalled();
    expect(mocks.requestEodRefresh).toHaveBeenCalledWith(env, "2026-11-25");
  });

  it("rejects unknown calendar state and unauthenticated refreshes without dispatching", async () => {
    mocks.expectedEodSession.mockResolvedValue(null);
    const response = await worker.fetch(request("/api/admin/run-eod"), environment(), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "exchange-calendar-unavailable" });
    const unauthorized = await worker.fetch(request("/api/admin/run-eod", undefined, false), environment(), context);
    expect(unauthorized.status).toBe(401);
    expect(mocks.requestEodRefresh).not.toHaveBeenCalled();
  });
});
