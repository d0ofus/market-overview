import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedBraveSearch, sanitizeInternalSourceMarkdownLinks, sourceCitationPolicyPrompt, type BraveSearchCaller } from "../src/market-report-common";
import type { Env } from "../src/types";

type FakeCacheRow = {
  cacheKey: string;
  query: string;
  freshness: string;
  dateBucket: string;
  responseJson: string;
  resultCount: number;
  fetchedAt: string;
  expiresAt: string;
  lastHitAt: string | null;
  hitCount: number;
};

type FakeUsageRow = {
  usageDay: string;
  caller: BraveSearchCaller;
  apiCallCount: number;
  apiErrorCount: number;
  cacheHitCount: number;
  lastCalledAt: string | null;
  lastErrorAt: string | null;
  updatedAt: string;
};

class FakeBraveDb {
  cache = new Map<string, FakeCacheRow>();
  usage = new Map<string, FakeUsageRow>();

  constructor(private readonly options: { failReads?: boolean; failWrites?: boolean } = {}) {}

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
        if (db.options.failReads) throw new Error("D1 read failed");
        if (normalized.includes("FROM brave_search_cache")) {
          const row = db.cache.get(String(bound[0]));
          return (row && row.expiresAt > String(bound[1]) ? { responseJson: row.responseJson, expiresAt: row.expiresAt } : null) as T;
        }
        return null as T;
      },
      async all<T>() {
        return { results: Array.from(db.usage.values()) as T[] };
      },
      async run() {
        if (db.options.failWrites) throw new Error("D1 write failed");
        if (normalized.startsWith("UPDATE brave_search_cache")) {
          const row = db.cache.get(String(bound[1]));
          if (row) {
            row.lastHitAt = String(bound[0]);
            row.hitCount += 1;
          }
          return { meta: { rows_written: row ? 1 : 0 } };
        }
        if (normalized.startsWith("INSERT INTO brave_search_cache")) {
          const row: FakeCacheRow = {
            cacheKey: String(bound[0]),
            query: String(bound[1]),
            freshness: String(bound[2]),
            dateBucket: String(bound[3]),
            responseJson: String(bound[4]),
            resultCount: Number(bound[5] ?? 0),
            fetchedAt: String(bound[6]),
            expiresAt: String(bound[7]),
            lastHitAt: null,
            hitCount: 0,
          };
          db.cache.set(row.cacheKey, row);
          return { meta: { rows_written: 1 } };
        }
        if (normalized.startsWith("INSERT INTO brave_usage_daily")) {
          const usageDay = String(bound[0]);
          const caller = bound[1] as BraveSearchCaller;
          const key = `${usageDay}|${caller}`;
          const current = db.usage.get(key) ?? {
            usageDay,
            caller,
            apiCallCount: 0,
            apiErrorCount: 0,
            cacheHitCount: 0,
            lastCalledAt: null,
            lastErrorAt: null,
            updatedAt: String(bound[7]),
          };
          current.apiCallCount += Number(bound[2] ?? 0);
          current.apiErrorCount += Number(bound[3] ?? 0);
          current.cacheHitCount += Number(bound[4] ?? 0);
          current.lastCalledAt = bound[5] == null ? current.lastCalledAt : String(bound[5]);
          current.lastErrorAt = bound[6] == null ? current.lastErrorAt : String(bound[6]);
          current.updatedAt = String(bound[7]);
          db.usage.set(key, current);
          return { meta: { rows_written: 1 } };
        }
        return { meta: { rows_written: 0 } };
      },
    };
    return statement;
  }
}

function createEnv(db: FakeBraveDb): Env {
  return {
    DB: db as unknown as D1Database,
    BRAVE_SEARCH_API_KEY: "test-key",
  } as Env;
}

function stubBraveFetch(status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    web: {
      results: [
        {
          title: "Fed leaves rates steady",
          url: "https://www.reuters.com/markets/us/fed-rates",
          description: "Policy update",
          profile: { name: "Reuters" },
          age: "2026-06-17",
        },
      ],
    },
  }), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("cached Brave Search wrapper", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls Brave on a cold miss, writes cache, and increments API calls", async () => {
    const db = new FakeBraveDb();
    const fetchMock = stubBraveFetch();
    const results = await cachedBraveSearch(createEnv(db), "  Fed   rates  ", {
      caller: "daily_commentary",
      freshness: "pd",
      count: 2,
      dateBucket: "daily:2026-06-17",
      ttlSeconds: 86400,
      now: new Date("2026-06-17T12:00:00.000Z"),
    });

    expect(results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as unknown[] | undefined;
    const requestUrl = new URL(String(firstCall?.[0]));
    expect(requestUrl.searchParams.get("q")).toBe("Fed rates");
    expect(requestUrl.searchParams.get("count")).toBe("2");
    expect(db.cache.size).toBe(1);
    expect(db.usage.get("2026-06-17|daily_commentary")).toMatchObject({ apiCallCount: 1, apiErrorCount: 0, cacheHitCount: 0 });
  });

  it("serves a cache hit without calling Brave and increments cache hits", async () => {
    const db = new FakeBraveDb();
    const fetchMock = stubBraveFetch();
    const env = createEnv(db);
    const options = {
      caller: "weekly_review" as const,
      freshness: "pw",
      dateBucket: "weekly:2026-06-08:2026-06-12",
      ttlSeconds: 86400,
      now: new Date("2026-06-17T12:00:00.000Z"),
    };
    await cachedBraveSearch(env, "market breadth", options);
    fetchMock.mockClear();

    const cached = await cachedBraveSearch(env, " market   breadth ", {
      ...options,
      now: new Date("2026-06-17T12:05:00.000Z"),
    });

    expect(cached[0]?.source).toBe("Reuters");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.usage.get("2026-06-17|weekly_review")).toMatchObject({ apiCallCount: 1, cacheHitCount: 1 });
    expect(Array.from(db.cache.values())[0]?.hitCount).toBe(1);
  });

  it("ignores an expired cache row and calls Brave again", async () => {
    const db = new FakeBraveDb();
    const fetchMock = stubBraveFetch();
    const env = createEnv(db);
    await cachedBraveSearch(env, "FOMC minutes", {
      caller: "fomc",
      freshness: "py",
      dateBucket: "fomc-hourly:minutes:2026-06-17:2026-06-17T12",
      ttlSeconds: 1,
      now: new Date("2026-06-17T12:00:00.000Z"),
    });

    await cachedBraveSearch(env, "FOMC minutes", {
      caller: "fomc",
      freshness: "py",
      dateBucket: "fomc-hourly:minutes:2026-06-17:2026-06-17T12",
      ttlSeconds: 1,
      now: new Date("2026-06-17T12:00:02.000Z"),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.usage.get("2026-06-17|fomc")).toMatchObject({ apiCallCount: 2, cacheHitCount: 0 });
  });

  it("increments API errors and rethrows Brave HTTP failures", async () => {
    const db = new FakeBraveDb();
    stubBraveFetch(429);
    await expect(cachedBraveSearch(createEnv(db), "macro news", {
      caller: "daily_commentary",
      freshness: "pd",
      dateBucket: "daily:2026-06-17",
      ttlSeconds: 86400,
      now: new Date("2026-06-17T12:00:00.000Z"),
    })).rejects.toThrow("HTTP 429");
    expect(db.usage.get("2026-06-17|daily_commentary")).toMatchObject({ apiCallCount: 1, apiErrorCount: 1 });
  });

  it("fails open when D1 cache and logging writes fail but Brave succeeds", async () => {
    const db = new FakeBraveDb({ failReads: true, failWrites: true });
    stubBraveFetch();
    const results = await cachedBraveSearch(createEnv(db), "market news", {
      caller: "daily_commentary",
      freshness: "pd",
      dateBucket: "daily:2026-06-17",
      ttlSeconds: 86400,
      now: new Date("2026-06-17T12:00:00.000Z"),
    });
    expect(results).toHaveLength(1);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("market report citation policy", () => {
  it("strips markdown links Gemini attaches to internal app sources while preserving external links", () => {
    const markdown = [
      "Breadth improved in [Daily - Above 200 SMA](https://home.treasury.gov/news/press-releases) while [Reuters](https://www.reuters.com/markets/) reported macro context.",
      "Internal app source [/scans compiled preset: Daily - Above 200 SMA](https://example.com/wrong) should be plain text.",
    ].join("\n");

    const sanitized = sanitizeInternalSourceMarkdownLinks(markdown, [
      {
        sourceName: "/scans compiled preset: Daily - Above 200 SMA",
        url: null,
        dataUsed: "Refreshed compiled scan rows for breadth, leadership, and notable trader-attention movers",
        timestamp: "2026-06-16T10:00:00.000Z",
      },
      {
        sourceName: "Reuters",
        url: "https://www.reuters.com/markets/",
        dataUsed: "News context",
        timestamp: "2026-06-16T10:00:00.000Z",
      },
    ]);

    expect(sanitized).toContain("Daily - Above 200 SMA while [Reuters](https://www.reuters.com/markets/) reported macro context.");
    expect(sanitized).toContain("Internal app source /scans compiled preset: Daily - Above 200 SMA should be plain text.");
    expect(sanitized).not.toContain("home.treasury.gov/news/press-releases");
    expect(sanitized).not.toContain("example.com/wrong");
  });

  it("tells Gemini to cite internal app sources as plain text instead of markdown links", () => {
    expect(sourceCitationPolicyPrompt()).toContain("Only create markdown links");
    expect(sourceCitationPolicyPrompt()).toContain("url");
    expect(sourceCitationPolicyPrompt()).toContain("Internal app sources");
    expect(sourceCitationPolicyPrompt()).toContain("plain text");
  });
});
