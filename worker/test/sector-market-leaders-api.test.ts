import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import * as symbolResolverModule from "../src/symbol-resolver";
import type { Env } from "../src/types";

type LeaderRow = {
  ticker: string;
  sourcePeerGroupId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type SymbolRow = {
  ticker: string;
  name: string | null;
  exchange: string | null;
  assetClass: string | null;
};

type PeerGroupRow = {
  id: string;
  name: string;
};

function createMarketLeadersEnv(input: {
  leaders?: LeaderRow[];
  symbols?: SymbolRow[];
  peerGroups?: PeerGroupRow[];
  adminSecret?: string;
}): Env & { __leaders: LeaderRow[]; __symbols: SymbolRow[] } {
  const leaders = [...(input.leaders ?? [])];
  const symbols = [...(input.symbols ?? [])];
  const peerGroups = [...(input.peerGroups ?? [])];
  let stampCounter = 0;

  const sortedLeaders = () =>
    [...leaders].sort((left, right) =>
      left.sortOrder - right.sortOrder ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.ticker.localeCompare(right.ticker),
    );

  const env = {
    ADMIN_SECRET: input.adminSecret,
    DATA_PROVIDER: "alpaca",
    DB: {
      prepare(sql: string) {
        const makeStatement = (args: unknown[] = []) => ({
          __sql: sql,
          __args: args,
          bind(...nextArgs: unknown[]) {
            return makeStatement(nextArgs);
          },
          async all<T>() {
            if (sql.includes("FROM sector_market_leaders ml")) {
              return {
                results: sortedLeaders().map((leader) => {
                  const symbol = symbols.find((row) => row.ticker.toUpperCase() === leader.ticker.toUpperCase());
                  const peerGroup = peerGroups.find((row) => row.id === leader.sourcePeerGroupId);
                  return {
                    ticker: leader.ticker,
                    name: symbol?.name ?? null,
                    sourcePeerGroupId: leader.sourcePeerGroupId,
                    sourcePeerGroupName: peerGroup?.name ?? null,
                    sortOrder: leader.sortOrder,
                    createdAt: leader.createdAt,
                    updatedAt: leader.updatedAt,
                  };
                }) as T[],
              };
            }
            return { results: [] as T[] };
          },
          async first<T>() {
            if (sql.includes("SELECT id FROM peer_groups")) {
              const id = String(args[0] ?? "");
              return (peerGroups.find((row) => row.id === id) ?? null) as T | null;
            }
            if (sql.includes("MAX(sort_order)")) {
              return { maxSort: leaders.reduce((max, row) => Math.max(max, row.sortOrder), 0) } as T;
            }
            if (sql.includes("SELECT ticker FROM sector_market_leaders")) {
              const ticker = String(args[0] ?? "").toUpperCase();
              return (leaders.find((row) => row.ticker.toUpperCase() === ticker) ?? null) as T | null;
            }
            return null as T;
          },
          async run() {
            if (sql.includes("INSERT OR IGNORE INTO symbols")) {
              const [ticker, name, exchange, assetClass] = args;
              const normalized = String(ticker).toUpperCase();
              if (!symbols.some((row) => row.ticker.toUpperCase() === normalized)) {
                symbols.push({
                  ticker: normalized,
                  name: String(name ?? normalized),
                  exchange: exchange == null ? null : String(exchange),
                  assetClass: assetClass == null ? null : String(assetClass),
                });
              }
            }
            if (sql.includes("INSERT OR IGNORE INTO sector_market_leaders")) {
              const [ticker, sourcePeerGroupId, sortOrder] = args;
              const normalized = String(ticker).toUpperCase();
              if (!leaders.some((row) => row.ticker.toUpperCase() === normalized)) {
                const stamp = `2026-06-11T00:00:${String(++stampCounter).padStart(2, "0")}Z`;
                leaders.push({
                  ticker: normalized,
                  sourcePeerGroupId: sourcePeerGroupId == null ? null : String(sourcePeerGroupId),
                  sortOrder: Number(sortOrder ?? 0),
                  createdAt: stamp,
                  updatedAt: stamp,
                });
              }
            }
            if (sql.includes("DELETE FROM sector_market_leaders")) {
              const ticker = String(args[0] ?? "").toUpperCase();
              const index = leaders.findIndex((row) => row.ticker.toUpperCase() === ticker);
              if (index >= 0) leaders.splice(index, 1);
            }
            return {};
          },
        });
        return makeStatement();
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) {
        for (const statement of statements) {
          await statement.run();
        }
        return [];
      },
    } as unknown as D1Database,
    __leaders: leaders,
    __symbols: symbols,
  } as Env & { __leaders: LeaderRow[]; __symbols: SymbolRow[] };

  return env;
}

describe("sector market leaders API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns saved leaders with symbol names in stable order", async () => {
    const env = createMarketLeadersEnv({
      leaders: [
        { ticker: "MSFT", sourcePeerGroupId: "g-mega", sortOrder: 2, createdAt: "2026-06-11T00:00:02Z", updatedAt: "2026-06-11T00:00:02Z" },
        { ticker: "AAPL", sourcePeerGroupId: null, sortOrder: 1, createdAt: "2026-06-11T00:00:01Z", updatedAt: "2026-06-11T00:00:01Z" },
      ],
      symbols: [
        { ticker: "AAPL", name: "Apple Inc", exchange: "NASDAQ", assetClass: "equity" },
        { ticker: "MSFT", name: "Microsoft Corp", exchange: "NASDAQ", assetClass: "equity" },
      ],
      peerGroups: [{ id: "g-mega", name: "Mega Cap Tech" }],
    });

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/sectors/market-leaders"),
      env as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { rows: Array<{ ticker: string; name: string | null; sourcePeerGroupName: string | null }> };
    expect(body.rows).toMatchObject([
      { ticker: "AAPL", name: "Apple Inc", sourcePeerGroupName: null },
      { ticker: "MSFT", name: "Microsoft Corp", sourcePeerGroupName: "Mega Cap Tech" },
    ]);
  });

  it("dedupes and appends valid tickers while preserving existing rows", async () => {
    vi.spyOn(symbolResolverModule, "resolveTickerMeta").mockImplementation(async (ticker) => ({
      ticker,
      name: `${ticker} Inc.`,
      exchange: "NASDAQ",
      assetClass: "equity",
    }));
    const env = createMarketLeadersEnv({
      leaders: [
        { ticker: "AAPL", sourcePeerGroupId: null, sortOrder: 1, createdAt: "2026-06-11T00:00:01Z", updatedAt: "2026-06-11T00:00:01Z" },
      ],
      symbols: [
        { ticker: "AAPL", name: "Apple Inc", exchange: "NASDAQ", assetClass: "equity" },
      ],
      peerGroups: [{ id: "g-ai", name: "AI Leaders" }],
    });

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/sectors/market-leaders", {
        method: "POST",
        body: JSON.stringify({ tickers: [" nvda ", "AAPL", "bad space", "MSFT", "NVDA"], sourcePeerGroupId: "g-ai" }),
      }),
      env as never,
    );

    expect(response.status).toBe(200);
    expect(env.__leaders.map((row) => [row.ticker, row.sourcePeerGroupId])).toEqual([
      ["AAPL", null],
      ["NVDA", "g-ai"],
      ["MSFT", "g-ai"],
    ]);
    expect(env.__symbols.map((row) => [row.ticker, row.name])).toEqual([
      ["AAPL", "Apple Inc"],
      ["NVDA", "NVDA Inc."],
      ["MSFT", "MSFT Inc."],
    ]);
  });

  it("deletes one saved market leader", async () => {
    const env = createMarketLeadersEnv({
      leaders: [
        { ticker: "AAPL", sourcePeerGroupId: null, sortOrder: 1, createdAt: "2026-06-11T00:00:01Z", updatedAt: "2026-06-11T00:00:01Z" },
      ],
    });

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/sectors/market-leaders/AAPL", { method: "DELETE" }),
      env as never,
    );

    expect(response.status).toBe(200);
    expect(env.__leaders).toEqual([]);
  });

  it("returns 404 when deleting a missing market leader", async () => {
    const env = createMarketLeadersEnv({});

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/sectors/market-leaders/AAPL", { method: "DELETE" }),
      env as never,
    );

    expect(response.status).toBe(404);
  });

  it("requires auth for mutations when ADMIN_SECRET is configured", async () => {
    const env = createMarketLeadersEnv({ adminSecret: "secret" });

    const response = await (worker as { fetch: typeof fetch }).fetch(
      new Request("http://localhost/api/sectors/market-leaders", {
        method: "POST",
        body: JSON.stringify({ tickers: ["AAPL"] }),
      }),
      env as never,
    );

    expect(response.status).toBe(401);
    expect(env.__leaders).toEqual([]);
  });
});
