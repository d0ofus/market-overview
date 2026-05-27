import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, SnapshotEmptyResponse, SnapshotReadyResponse } from "../src/types";

const eodMocks = vi.hoisted(() => ({
  computeAndStoreSnapshot: vi.fn(),
  loadSnapshot: vi.fn(),
  recomputeBreadthFromStoredBars: vi.fn(),
  recomputeDashboardFromStoredBars: vi.fn(),
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
});
