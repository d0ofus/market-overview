import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshBreadthUniverseMemberships, shouldRefreshUniverseSource } from "../src/eod";
import { isMembershipInfrastructureFailure, membershipRetryNotBefore } from "../src/membership-source-policy";
import { ProviderBudgetExceededError, ProviderBudgetUnavailableError, ProviderRequestFailureError } from "../src/provider-usage";
import { loadNasdaqTraderUniverses, loadRussell2000Universe, loadSp500Universe } from "../src/universe-constituents";
import { stageAndPromoteUniverseVersion } from "../src/universe-version-service";
import type { Env } from "../src/types";

vi.mock("../src/universe-constituents", () => ({
  loadNasdaqTraderUniverses: vi.fn(), loadRussell2000Universe: vi.fn(),
  loadSp500Constituents: vi.fn(), loadSp500Universe: vi.fn(),
}));
vi.mock("../src/universe-version-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/universe-version-service")>(), stageAndPromoteUniverseVersion: vi.fn(),
}));

const ids = ["nasdaq-core", "nyse-core", "sp500-core", "russell2000-core", "overall-market-proxy"];
const sourceType = (id: string) => id === "sp500-core" ? "wikipedia-derived-public-proxy"
  : id === "russell2000-core" ? "official-etf-holdings-proxy" : "public-common-stock-proxy";
const members = (id: string) => Array.from({ length: id === "russell2000-core" ? 1_900 : 500 }, (_, index) => `T${index}`);
function environment(cache?: { sourceDate?: string; verifiedAt?: string; status?: string; nextAttemptAt?: string; unverified?: boolean; failureCount?: number }) {
  const writes: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind: (...values: unknown[]) => { args = values; return statement; },
        first: async () => {
          if (sql.includes("FROM universe_source_sync_state")) {
            if (!cache) return null;
            const id = String(args[0]).replace("universe:", "").replace("overall-market-core", "overall-market-proxy");
            return { status: cache.status ?? "ok", sourceType: cache.unverified ? "bundled-fallback" : sourceType(id),
              sourceAsOfDate: cache.sourceDate ?? "2026-09-09", lastVerifiedAt: cache.verifiedAt ?? "2026-09-10 21:00:00",
              nextAttemptAt: cache.nextAttemptAt ?? null, failureCount: cache.failureCount ?? 0 };
          }
          if (sql.includes("active_version_id as activeVersionId")) return { activeVersionId: "verified-version" };
          throw new Error(`Unexpected first query: ${sql}`);
        },
        all: async () => {
          if (sql.includes("JOIN universe_version_members") || sql.includes("FROM universe_symbols")) {
            return { results: cache ? members(String(args[0])).map((ticker) => ({ ticker })) : [] };
          }
          throw new Error(`Unexpected all query: ${sql}`);
        },
        run: async () => { writes.push(args); return { success: true }; },
      };
      return statement;
    },
  };
  return { env: { DB: db, MARKET_DATA_DB: db, OPS_DB: db } as unknown as Env, writes };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T22:00:00Z"));
  vi.clearAllMocks();
  vi.mocked(stageAndPromoteUniverseVersion).mockResolvedValue({ versionId: "verified-version",
    validation: { valid: true, memberCount: 500, previousMemberCount: 0, changePct: null, error: null } });
  vi.mocked(loadSp500Universe).mockResolvedValue({ tickers: members("sp500-core"), sourceAsOfDate: "2026-09-10",
    sourceType: "wikipedia-derived-public-proxy", sourceUrl: "https://example.test/sp500", contentHash: "hash", etag: null, lastModified: null });
  vi.mocked(loadRussell2000Universe).mockResolvedValue({ tickers: members("russell2000-core"), sourceAsOfDate: "2026-09-09",
    sourceType: "official-etf-holdings-proxy", sourceUrl: "https://example.test/iwm", sourceMemberCount: 1_900,
    normalizedMemberCount: 1_900, unresolvedCount: 0, unresolvedTickers: [], memberMetadata: {}, contentHash: "hash" });
});
afterEach(() => vi.useRealTimers());

describe("bounded independent membership refresh", () => {
  it("does not repeatedly refresh an undated S&P proxy verified on the current New York day", () => {
    expect(shouldRefreshUniverseSource({existingCount:503,status:"ok",sourceAsOfDate:null,
      sourceType:"wikipedia-derived-public-proxy",verifiedAt:"2026-09-10T21:00:00Z",nextAttemptAt:null,refreshAfterDays:1})).toBe(false);
    expect(shouldRefreshUniverseSource({existingCount:503,status:"ok",sourceAsOfDate:null,
      sourceType:"wikipedia-derived-public-proxy",verifiedAt:"2026-09-09T21:00:00Z",nextAttemptAt:null,refreshAfterDays:1})).toBe(true);
  });
  it("isolates one exhausted Nasdaq allowance and still refreshes S&P and official IWM", async () => {
    const exhausted = new ProviderBudgetExceededError("nasdaqtrader", 4, "day");
    vi.mocked(loadNasdaqTraderUniverses).mockRejectedValue(exhausted);
    const { env, writes } = environment();
    const result = await refreshBreadthUniverseMemberships(env);
    expect(loadNasdaqTraderUniverses).toHaveBeenCalledTimes(1);
    expect(loadSp500Universe).toHaveBeenCalledWith(undefined, env);
    expect(loadRussell2000Universe).toHaveBeenCalledWith(undefined, env);
    expect([...result.universeTickers.keys()].sort()).toEqual(["russell2000-core", "sp500-core"]);
    expect(result.unavailable.map((row) => row.id)).toEqual(expect.arrayContaining(["nasdaq-core", "nyse-core", "overall-market-proxy"]));
    const failures = writes.filter((args) => args[1] === "error");
    expect(failures).toHaveLength(3);
    expect(failures.every((args) => args[17] === "2026-09-11T00:05:00.000Z")).toBe(true);
  });

  it("reuses today's verified lists with yesterday's source footer without any provider request or membership write", async () => {
    const { env, writes } = environment({});
    const result = await refreshBreadthUniverseMemberships(env);
    expect(result.universeTickers.size).toBe(5);
    expect(loadNasdaqTraderUniverses).not.toHaveBeenCalled();
    expect(loadSp500Universe).not.toHaveBeenCalled();
    expect(loadRussell2000Universe).not.toHaveBeenCalled();
    expect(stageAndPromoteUniverseVersion).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("resumes a repeatedly exhausted source after UTC reset rather than retaining a full-day source backoff", async () => {
    vi.mocked(loadNasdaqTraderUniverses).mockRejectedValue(new ProviderBudgetExceededError("nasdaqtrader", 4, "day"));
    const { env, writes } = environment({ status: "error", failureCount: 6 });
    const result = await refreshBreadthUniverseMemberships(env);
    expect(result.universeTickers.size).toBe(5);
    expect(writes.filter((args) => args[1] === "error").every((args) => args[17] === "2026-09-11T00:05:00.000Z")).toBe(true);
  });

  it("reuses valid cached lists during provider cooldown with explicit degradation", async () => {
    const { env } = environment({ status: "error", nextAttemptAt: "2026-09-11T00:05:00Z" });
    const result = await refreshBreadthUniverseMemberships(env);
    expect(result.universeTickers.size).toBe(5);
    expect([...result.sourceByUniverse.values()].every((value) => value.includes("cached universe reused"))).toBe(true);
    expect(loadNasdaqTraderUniverses).not.toHaveBeenCalled();
  });

  it.each([{ sourceDate: "2026-08-31" }, { unverified: true }])("never lets cooldown revive expired or unverified membership %j", async (cache) => {
    const { env } = environment({ ...cache, status: "error", nextAttemptAt: "2026-09-11T00:05:00Z" });
    const result = await refreshBreadthUniverseMemberships(env);
    expect(result.universeTickers.size).toBe(0);
    expect(result.unavailable.map((row) => row.id)).toEqual(expect.arrayContaining(ids));
    expect(loadNasdaqTraderUniverses).not.toHaveBeenCalled();
  });

  it("does not downgrade an unavailable provider admission ledger into an isolated provider outage", async () => {
    vi.mocked(loadNasdaqTraderUniverses).mockRejectedValue(new ProviderBudgetUnavailableError("nasdaqtrader"));
    const { env, writes } = environment();
    await expect(refreshBreadthUniverseMemberships(env)).rejects.toThrow("budget storage is unavailable");
    expect(writes).toHaveLength(0);
    expect(loadSp500Universe).not.toHaveBeenCalled();
  });
});

describe("verification dates and provider failure classification", () => {
  const refresh = (verifiedAt: string, now: string) => shouldRefreshUniverseSource({ existingCount: 500, status: "ok",
    sourceAsOfDate: "2026-09-09", nextAttemptAt: null, refreshAfterDays: 1, verifiedAt, now: new Date(now) });
  it("shares the New York verification day across UTC midnight and refreshes on the next exchange date", () => {
    expect(refresh("2026-09-10 21:00:00", "2026-09-11T00:15:00Z")).toBe(false);
    expect(refresh("2026-09-10 21:00:00", "2026-09-11T14:00:00Z")).toBe(true);
    expect(refresh("2026-09-11T01:00:00Z", "2026-09-11T00:15:00Z")).toBe(true);
    expect(refresh("invalid", "2026-09-11T00:15:00Z")).toBe(true);
  });
  it("keeps provider budget exhaustion separate from D1 budgets and database errors", () => {
    const exhausted = new ProviderBudgetExceededError("nasdaqtrader", 4, "day");
    expect(isMembershipInfrastructureFailure(exhausted)).toBe(false);
    expect(isMembershipInfrastructureFailure(new ProviderRequestFailureError("provider-http-error", "quota exceeded", 429))).toBe(false);
    expect(isMembershipInfrastructureFailure(new ProviderBudgetUnavailableError("nasdaqtrader"))).toBe(true);
    expect(isMembershipInfrastructureFailure(new Error("eod-d1-budget-exhausted"))).toBe(true);
    expect(isMembershipInfrastructureFailure(new Error("D1_ERROR: database is full"))).toBe(true);
    expect(membershipRetryNotBefore(exhausted, new Date("2026-12-31T23:58:00Z"))).toBe("2027-01-01T00:05:00.000Z");
  });
});
