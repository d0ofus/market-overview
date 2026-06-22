import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProviderUsageDaily, meteredFetch, recordProviderUsage } from "../src/provider-usage";
import type { Env } from "../src/types";

type UsageRow = {
  usageDay: string;
  providerKey: string;
  endpointKey: string;
  caller: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  rateLimitedCount: number;
  timeoutCount: number;
  symbolCount: number;
  rowCount: number;
  cacheHitCount: number;
  totalDurationMs: number;
  lastStatus: number | null;
  lastError: string | null;
  lastCalledAt: string | null;
  updatedAt: string;
};

class FakeProviderUsageDb {
  rows = new Map<string, UsageRow>();

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
        if (normalized.includes("SUM(request_count)")) {
          const day = String(bound[0]);
          const provider = String(bound[1]);
          const requestCount = Array.from(db.rows.values())
            .filter((row) => row.usageDay === day && row.providerKey === provider)
            .reduce((sum, row) => sum + row.requestCount, 0);
          return { requestCount } as T;
        }
        return null as T;
      },
      async all<T>() {
        if (!normalized.includes("FROM provider_usage_daily")) return { results: [] as T[] };
        const cutoff = String(bound[0]);
        return {
          results: Array.from(db.rows.values())
            .filter((row) => row.usageDay >= cutoff)
            .map((row) => ({
              usageDay: row.usageDay,
              providerKey: row.providerKey,
              endpointKey: row.endpointKey,
              caller: row.caller,
              requestCount: row.requestCount,
              successCount: row.successCount,
              errorCount: row.errorCount,
              rateLimitedCount: row.rateLimitedCount,
              timeoutCount: row.timeoutCount,
              symbolCount: row.symbolCount,
              rowCount: row.rowCount,
              cacheHitCount: row.cacheHitCount,
              totalDurationMs: row.totalDurationMs,
              lastStatus: row.lastStatus,
              lastError: row.lastError,
              lastCalledAt: row.lastCalledAt,
              updatedAt: row.updatedAt,
            })) as T[],
        };
      },
      async run() {
        if (!normalized.startsWith("INSERT INTO provider_usage_daily")) return {};
        const usageDay = String(bound[0]);
        const providerKey = String(bound[1]);
        const endpointKey = String(bound[2]);
        const caller = String(bound[3]);
        const key = `${usageDay}|${providerKey}|${endpointKey}|${caller}`;
        const current = db.rows.get(key) ?? {
          usageDay,
          providerKey,
          endpointKey,
          caller,
          requestCount: 0,
          successCount: 0,
          errorCount: 0,
          rateLimitedCount: 0,
          timeoutCount: 0,
          symbolCount: 0,
          rowCount: 0,
          cacheHitCount: 0,
          totalDurationMs: 0,
          lastStatus: null,
          lastError: null,
          lastCalledAt: null,
          updatedAt: String(bound[16]),
        };
        current.requestCount += Number(bound[4] ?? 0);
        current.successCount += Number(bound[5] ?? 0);
        current.errorCount += Number(bound[6] ?? 0);
        current.rateLimitedCount += Number(bound[7] ?? 0);
        current.timeoutCount += Number(bound[8] ?? 0);
        current.symbolCount += Number(bound[9] ?? 0);
        current.rowCount += Number(bound[10] ?? 0);
        current.cacheHitCount += Number(bound[11] ?? 0);
        current.totalDurationMs += Number(bound[12] ?? 0);
        current.lastStatus = bound[13] == null ? current.lastStatus : Number(bound[13]);
        current.lastError = bound[14] == null ? current.lastError : String(bound[14]);
        current.lastCalledAt = bound[15] == null ? current.lastCalledAt : String(bound[15]);
        current.updatedAt = String(bound[16]);
        db.rows.set(key, current);
        return {};
      },
    };
    return statement;
  }
}

function createEnv(db: FakeProviderUsageDb, extra: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    ...extra,
  } as Env;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("provider usage metering", () => {
  it("records successful, rate-limited, and cache-hit usage rows", async () => {
    const db = new FakeProviderUsageDb();
    const env = createEnv(db);
    await recordProviderUsage(env, {
      providerKey: "Alpaca",
      endpointKey: "Daily Bars IEX",
      caller: "Daily Bars",
      symbolCount: 80,
    }, {
      ok: true,
      status: 200,
      durationMs: 125,
      rowCount: 79,
    });
    await recordProviderUsage(env, {
      providerKey: "Alpaca",
      endpointKey: "Daily Bars IEX",
      caller: "Daily Bars",
      symbolCount: 80,
    }, {
      ok: false,
      status: 429,
      durationMs: 25,
      error: new Error("rate limited"),
    });
    await recordProviderUsage(env, {
      providerKey: "brave",
      endpointKey: "web-search",
      caller: "weekly_review",
    }, {
      requestCount: 0,
      cacheHitCount: 1,
    });

    const response = await loadProviderUsageDaily(env, 14);

    expect(response.totals.requestCount).toBe(2);
    expect(response.totals.successCount).toBe(1);
    expect(response.totals.errorCount).toBe(1);
    expect(response.totals.rateLimitedCount).toBe(1);
    expect(response.totals.cacheHitCount).toBe(1);
    expect(response.totalsByProvider[0]).toMatchObject({ providerKey: "alpaca", requestCount: 2, symbolCount: 160 });
    expect(response.latestSamples[0]).toMatchObject({ providerKey: "alpaca", lastStatus: 429 });
  });

  it("meters fetch successes and provider errors", async () => {
    const db = new FakeProviderUsageDb();
    const env = createEnv(db);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("too many", { status: 429 })));

    const response = await meteredFetch(env, "https://example.com/provider", {}, {
      providerKey: "fmp",
      endpointKey: "daily-bars",
      caller: "fallback",
    });

    expect(response.status).toBe(429);
    const usage = await loadProviderUsageDaily(env, 1);
    expect(usage.totals).toMatchObject({ requestCount: 1, errorCount: 1, rateLimitedCount: 1 });
  });

  it("enforces daily hard budgets before calling the provider", async () => {
    const db = new FakeProviderUsageDb();
    const env = createEnv(db, { FMP_REQUESTS_PER_DAY_HARD: "1" });
    await recordProviderUsage(env, {
      providerKey: "fmp",
      endpointKey: "daily-bars",
      caller: "fallback",
    }, { ok: true, status: 200 });
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(meteredFetch(env, "https://example.com/fmp", {}, {
      providerKey: "fmp",
      endpointKey: "daily-bars",
      caller: "fallback",
    })).rejects.toThrow("Provider budget exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
