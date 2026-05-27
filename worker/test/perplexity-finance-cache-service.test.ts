import { describe, expect, it } from "vitest";
import {
  loadPerplexityFinanceCache,
  PerplexityFinanceCacheInputError,
  upsertPerplexityFinanceCache,
  type PerplexityFinanceCacheLookup,
} from "../src/perplexity-finance-cache-service";
import type { Env } from "../src/types";

type CacheRow = {
  ticker: string;
  fetchedAt: string;
  storedAt: string;
  status: string;
  profileStatus: string;
  peersStatus: string;
  warning: string | null;
  profileUrl: string;
  peersUrl: string;
  companyName: string | null;
  companyExchange: string | null;
  companySector: string | null;
  companyIndustry: string | null;
  companyDescription: string | null;
  peersJson: string;
  payloadVersion: number;
};

function lookup(overrides: Partial<PerplexityFinanceCacheLookup> = {}): PerplexityFinanceCacheLookup {
  return {
    ticker: "AAPL",
    fetchedAt: "2026-05-27T08:00:00.000Z",
    source: "perplexity_finance_dashboard",
    peersUrl: "https://www.perplexity.ai/finance/lists?preset=peers&symbol=AAPL",
    profileUrl: "https://www.perplexity.ai/finance/AAPL",
    company: {
      name: "Apple Inc.",
      exchange: "NASDAQ",
      sector: "Technology",
      industry: "Consumer Electronics",
      description: "Apple designs consumer electronics.",
    },
    peers: [{
      ticker: "MSFT",
      name: "Microsoft Corporation",
      exchange: "NASDAQ",
      rawText: "Microsoft Corporation MSFT NASDAQ",
    }],
    warning: null,
    status: "ready",
    profileStatus: "ready",
    peersStatus: "ready",
    ...overrides,
  };
}

function createCacheEnv() {
  const rows = new Map<string, CacheRow>();
  const db = {
    prepare(_sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              return (rows.get(String(args[0]).toUpperCase()) ?? null) as T | null;
            },
            async run() {
              rows.set(String(args[0]).toUpperCase(), {
                ticker: String(args[0]),
                fetchedAt: String(args[1]),
                storedAt: String(args[2]),
                status: String(args[3]),
                profileStatus: String(args[4]),
                peersStatus: String(args[5]),
                warning: args[6] == null ? null : String(args[6]),
                profileUrl: String(args[7]),
                peersUrl: String(args[8]),
                companyName: args[9] == null ? null : String(args[9]),
                companyExchange: args[10] == null ? null : String(args[10]),
                companySector: args[11] == null ? null : String(args[11]),
                companyIndustry: args[12] == null ? null : String(args[12]),
                companyDescription: args[13] == null ? null : String(args[13]),
                peersJson: String(args[14]),
                payloadVersion: 1,
              });
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return {
    env: { DB: db, PERPLEXITY_CACHE_DB: db } as Env,
    rows,
  };
}

describe("Perplexity Finance cache service", () => {
  it("returns a cache miss when no row exists", async () => {
    const { env } = createCacheEnv();
    await expect(loadPerplexityFinanceCache(env, "AAPL")).resolves.toEqual({ hit: false });
  });

  it("upserts and reads a compact lookup row", async () => {
    const { env } = createCacheEnv();
    const write = await upsertPerplexityFinanceCache(env, "aapl", lookup());
    expect(write.cached).toBe(true);
    const read = await loadPerplexityFinanceCache(env, "AAPL");
    expect(read.hit).toBe(true);
    if (read.hit) {
      expect(read.lookup.ticker).toBe("AAPL");
      expect(read.lookup.company.name).toBe("Apple Inc.");
      expect(read.lookup.peers).toEqual([{
        ticker: "MSFT",
        name: "Microsoft Corporation",
        exchange: "NASDAQ",
        rawText: "Microsoft Corporation MSFT NASDAQ",
      }]);
      expect(read.storedAt).toBe(write.storedAt);
      expect(typeof read.ageSeconds === "number" || read.ageSeconds === null).toBe(true);
    }
  });

  it("rejects invalid tickers", async () => {
    const { env } = createCacheEnv();
    await expect(loadPerplexityFinanceCache(env, "AAPL/../../")).rejects.toBeInstanceOf(PerplexityFinanceCacheInputError);
  });

  it("does not overwrite a good row with a blocked or empty result", async () => {
    const { env } = createCacheEnv();
    await upsertPerplexityFinanceCache(env, "AAPL", lookup());
    const badWrite = await upsertPerplexityFinanceCache(env, "AAPL", lookup({
      fetchedAt: "2026-05-27T09:00:00.000Z",
      peers: [],
      status: "blocked",
      profileStatus: "blocked",
      peersStatus: "blocked",
      warning: "Blocked",
    }));
    expect(badWrite.cached).toBe(false);
    const read = await loadPerplexityFinanceCache(env, "AAPL");
    expect(read.hit).toBe(true);
    if (read.hit) {
      expect(read.lookup.fetchedAt).toBe("2026-05-27T08:00:00.000Z");
      expect(read.lookup.status).toBe("ready");
      expect(read.lookup.peers).toHaveLength(1);
    }
  });

  it("degrades gracefully when the cache binding is missing", async () => {
    const { env } = createCacheEnv();
    const read = await loadPerplexityFinanceCache({ DB: env.DB } as Env, "AAPL");
    expect(read).toEqual({
      hit: false,
      warning: "PERPLEXITY_CACHE_DB binding is not configured.",
    });
  });
});
