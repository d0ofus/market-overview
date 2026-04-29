import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isEligibleTradingViewMarketCapRow,
  parseTradingViewMarketCapRows,
  processFundamentalSeedQueue,
} from "../src/fundamentals-seed-service";

function factsResponse(revenue = 100, netIncome = 20) {
  return {
    facts: {
      "us-gaap": {
        Revenues: {
          units: {
            USD: [
              { val: revenue, start: "2025-01-01", end: "2025-03-31", fy: 2025, fp: "Q1", form: "10-Q", filed: "2025-05-01", accn: "rev-q1" },
              { val: revenue * 4, start: "2025-01-01", end: "2025-12-31", fy: 2025, fp: "FY", form: "10-K", filed: "2026-02-01", accn: "rev-fy" },
            ],
          },
        },
        NetIncomeLoss: {
          units: {
            USD: [
              { val: netIncome, start: "2025-01-01", end: "2025-03-31", fy: 2025, fp: "Q1", form: "10-Q", filed: "2025-05-01", accn: "ni-q1" },
              { val: netIncome * 4, start: "2025-01-01", end: "2025-12-31", fy: 2025, fp: "FY", form: "10-K", filed: "2026-02-01", accn: "ni-fy" },
            ],
          },
        },
      },
    },
  };
}

function createSeedDb() {
  const queue = [
    { ticker: "OK", cik: "0000000001", companyName: "OK Inc", exchange: "NASDAQ", marketCap: 100, priorityRank: 1, status: "queued", attempts: 0 },
    { ticker: "EMPTY", cik: "0000000002", companyName: "Empty Inc", exchange: "NYSE", marketCap: 90, priorityRank: 2, status: "queued", attempts: 0 },
    { ticker: "ERR", cik: "0000000003", companyName: "Err Inc", exchange: "AMEX", marketCap: 80, priorityRank: 3, status: "queued", attempts: 0 },
  ];
  const updates: Array<{ ticker: string; status: string; error: string | null }> = [];
  const batchedStatements: Array<unknown> = [];

  const db = {
    prepare(sql: string) {
      return {
        async first<T>() {
          if (sql.includes("sqlite_master")) return { count: 4 } as T;
          throw new Error(`Unhandled first query: ${sql}`);
        },
        bind(...args: unknown[]) {
          return {
            async all<T>() {
              if (sql.includes("FROM fundamental_seed_queue")) return { results: queue } as T;
              throw new Error(`Unhandled all query: ${sql}`);
            },
            async run() {
              if (sql.includes("UPDATE fundamental_seed_queue") && sql.includes("status = 'running'")) {
                updates.push({ ticker: String(args[1]), status: "running", error: null });
              } else if (sql.includes("UPDATE fundamental_seed_queue") && sql.includes("status = ?")) {
                updates.push({ ticker: String(args[6]), status: String(args[0]), error: args[5] == null ? null : String(args[5]) });
              } else if (sql.includes("UPDATE fundamental_seed_queue") && sql.includes("status = 'error'")) {
                updates.push({ ticker: String(args[2]), status: "error", error: String(args[0]) });
              }
              return {};
            },
          };
        },
      };
    },
    async batch(statements: unknown[]) {
      batchedStatements.push(...statements);
      return [];
    },
  } as unknown as D1Database;

  return { db, updates, batchedStatements };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fundamentals seed TradingView parsing", () => {
  it("normalizes and filters market-cap rows", () => {
    const rows = parseTradingViewMarketCapRows({
      data: [
        { s: "NASDAQ:AAPL", d: ["Apple Inc.", 3_000_000_000_000, "NASDAQ", "stock", "United States"] },
        { s: "AMEX:SPY", d: ["SPDR S&P 500 ETF", 500_000_000_000, "AMEX", "fund", "United States"] },
        { s: "NYSE:BABA", d: ["Alibaba", 200_000_000_000, "NYSE", "stock", "China"] },
      ],
    });

    expect(rows[0]).toMatchObject({ ticker: "AAPL", exchange: "NASDAQ", type: "stock" });
    expect(rows.map(isEligibleTradingViewMarketCapRow)).toEqual([true, false, false]);
  });
});

describe("fundamentals seed queue processing", () => {
  it("marks queued rows as ok, no_supported_rows, or error", async () => {
    const { db, updates, batchedStatements } = createSeedDb();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("0000000001")) {
        return { ok: true, json: async () => factsResponse(), text: async () => "" };
      }
      if (url.includes("0000000002")) {
        return { ok: true, json: async () => ({ facts: {} }), text: async () => "" };
      }
      return { ok: false, status: 503, text: async () => "busy" };
    }));

    const result = await processFundamentalSeedQueue(
      { DB: db, FUNDAMENTALS_DB: db, SEC_USER_AGENT: "market-overview-test contact:test@example.com" } as never,
      { limit: 3, now: new Date("2026-04-29T00:00:00.000Z") },
    );

    expect(result.rows.map((row) => [row.ticker, row.status])).toEqual([
      ["OK", "ok"],
      ["EMPTY", "no_supported_rows"],
      ["ERR", "error"],
    ]);
    expect(updates.some((row) => row.ticker === "OK" && row.status === "ok")).toBe(true);
    expect(updates.some((row) => row.ticker === "EMPTY" && row.status === "no_supported_rows")).toBe(true);
    expect(updates.some((row) => row.ticker === "ERR" && row.status === "error")).toBe(true);
    expect(batchedStatements.length).toBeGreaterThan(0);
  });
});
