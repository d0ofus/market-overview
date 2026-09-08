import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { isUniverseInfrastructureFailure, refreshBreadthUniverseMemberships } from "../src/eod";
import { loadNasdaqTraderUniverses } from "../src/universe-constituents";
import { stageAndPromoteUniverseVersion } from "../src/universe-version-service";

vi.mock("../src/universe-constituents", () => ({
  loadNasdaqTraderUniverses: vi.fn(), loadRussell2000Universe: vi.fn(),
  loadSp500Constituents: vi.fn(), loadSp500Universe: vi.fn(),
}));
vi.mock("../src/universe-version-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/universe-version-service")>(),
  stageAndPromoteUniverseVersion: vi.fn(),
}));

describe("membership infrastructure failures are resumable run failures", () => {
  let env: Env;
  let run: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    run = vi.fn(async () => ({ success: true }));
    const db = {
      prepare: () => {
        const statement = { bind: () => statement, first: async () => null,
          all: async () => ({ results: [] }), run };
        return statement;
      },
    } as unknown as D1Database;
    env = { DB: db, MARKET_DATA_DB: db, OPS_DB: db } as Env;
    vi.mocked(loadNasdaqTraderUniverses).mockResolvedValue({
      nasdaqTickers: ["AAPL"], nyseTickers: ["IBM"], allCommonTickers: ["AAPL", "IBM"],
      allActiveEquityTickers: ["AAPL", "IBM"], sourceAsOfDate: new Date().toISOString().slice(0, 10),
    } as Awaited<ReturnType<typeof loadNasdaqTraderUniverses>>);
  });

  it.each(["D1_ERROR: Exceeded maximum DB size", "eod-d1-budget-exhausted", "eod-d1-capacity-critical", "socket disconnected"])(
    "propagates failed staging (%s) without recording a provider outage", async (message) => {
      vi.mocked(stageAndPromoteUniverseVersion).mockRejectedValueOnce(new Error(message));
      await expect(refreshBreadthUniverseMemberships(env)).rejects.toThrow(message);
      expect(loadNasdaqTraderUniverses).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("does not retry a failed status write as a source-error write", async () => {
    vi.mocked(stageAndPromoteUniverseVersion).mockResolvedValueOnce({
      versionId: "version", validation: { valid: true, memberCount: 1, previousMemberCount: 0, changePct: null, error: null },
    });
    run.mockRejectedValueOnce(new Error("D1_ERROR: write quota exhausted"));
    await expect(refreshBreadthUniverseMemberships(env)).rejects.toThrow("write quota exhausted");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("distinguishes directory HTTP failure from admission/storage failures", () => {
    expect(isUniverseInfrastructureFailure(new Error("Nasdaq source returned HTTP503"))).toBe(false);
    expect(isUniverseInfrastructureFailure(new Error("eod-query-exceeds-bounded-reservation"))).toBe(true);
    expect(isUniverseInfrastructureFailure(new Error("D1 batch exceeds40 statements"))).toBe(true);
  });
});
