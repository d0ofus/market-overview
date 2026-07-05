import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  refreshOptionsForWatchlist,
  loadOptionsStatus,
} from "../src/options-service";
import type { Env } from "../src/types";

type MockStatement = {
  __sql: string;
  __args: unknown[];
  bind: (...args: unknown[]) => MockStatement;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
  run: () => Promise<{ meta: { changes: number } }>;
};

function createOptionsEnv(overrides: Partial<Env> = {}) {
  const batchStatements: MockStatement[] = [];
  const runStatements: MockStatement[] = [];
  const makeStatement = (sql: string, args: unknown[] = []): MockStatement => ({
    __sql: sql,
    __args: args,
    bind: (...nextArgs: unknown[]) => makeStatement(sql, nextArgs),
    async first<T>() {
      return null as T | null;
    },
    async all<T>() {
      return { results: [] as T[] };
    },
    async run() {
      runStatements.push(makeStatement(sql, args));
      return { meta: { changes: 0 } };
    },
  });
  const env = {
    IBKR_OPTIONS_ENABLED: "true",
    IBKR_OPTIONS_ENDPOINT: "https://bridge.example.test",
    IBKR_OPTIONS_TOKEN: "secret",
    OPTIONS_HISTORICAL_SPREAD_MAX_CONTRACTS: "10",
    DB: {
      prepare(sql: string) {
        return makeStatement(sql);
      },
      async batch(statements: MockStatement[]) {
        batchStatements.push(...statements);
        return statements.map(() => ({ success: true }));
      },
    } as unknown as D1Database,
    ...overrides,
  } as Env;
  return { env, batchStatements, runStatements };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("options service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns a disabled response without calling the bridge", async () => {
    const { env } = createOptionsEnv({ IBKR_OPTIONS_ENABLED: "false" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await refreshOptionsForWatchlist(env, { tickers: ["AAPL"] });

    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).toContain("disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("normalizes bridge chains, probes historical BID_ASK spreads, scores, and persists candidates", async () => {
    const { env, batchStatements } = createOptionsEnv();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/options/chains")) {
        return jsonResponse({
          results: [{
            ticker: "AAPL",
            underlyingPrice: 212.5,
            optionsAvailable: true,
            ivRank52w: 0.22,
            dataMode: "realtime",
            contracts: [
              { contractKey: "AAPL-C-20260821-220", localSymbol: "AAPL  260821C00220000", expiry: "2026-08-21", right: "C", strike: 220, bid: 5.1, ask: 5.3, volume: 240, openInterest: 1500, delta: 0.42, iv: 0.31 },
              { contractKey: "AAPL-C-20260821-230", localSymbol: "AAPL  260821C00230000", expiry: "2026-08-21", right: "C", strike: 230, bid: 2.1, ask: 2.25, volume: 120, openInterest: 800, delta: 0.28, iv: 0.32 },
              { contractKey: "AAPL-P-20260821-200", localSymbol: "AAPL  260821P00200000", expiry: "2026-08-21", right: "P", strike: 200, bid: 4.8, ask: 5.0, volume: 180, openInterest: 1200, delta: -0.38, iv: 0.34 },
            ],
          }],
        });
      }
      if (url.endsWith("/v1/options/historical-bid-ask")) {
        return jsonResponse({
          contracts: [
            {
              contractKey: "AAPL-C-20260821-220",
              sessionDate: "2026-07-02",
              ticks: [
                { time: "2026-07-02T14:00:00Z", bid: 5.05, ask: 5.25 },
                { time: "2026-07-02T19:45:00Z", bid: 5.10, ask: 5.30 },
              ],
            },
            {
              contractKey: "AAPL-C-20260821-230",
              sessionDate: "2026-07-02",
              medianSpreadPct: 5.3,
              p75SpreadPct: 6.2,
              sampleCount: 150,
            },
            {
              contractKey: "AAPL-P-20260821-200",
              sessionDate: "2026-07-02",
              medianSpreadPct: 4.1,
              p75SpreadPct: 5.0,
              sampleCount: 180,
            },
          ],
        });
      }
      return jsonResponse({ ok: true });
    }));

    const result = await refreshOptionsForWatchlist(env, { tickers: ["AAPL"], minDte: 1, maxDte: 120 });

    expect(result.ok).toBe(true);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].ivRank52w).toBe(22);
    expect(result.candidates.some((row) => row.strategy === "long_call")).toBe(true);
    expect(result.candidates.some((row) => row.strategy === "long_put")).toBe(true);
    expect(result.candidates.some((row) => row.strategy === "call_debit_spread")).toBe(true);
    expect(result.candidates[0].spreadBasis).not.toBe("unavailable");
    expect(result.candidates[0].score).toBeGreaterThan(0);
    expect(batchStatements.some((statement) => statement.__sql.includes("INSERT INTO option_chain_snapshots"))).toBe(true);
    expect(batchStatements.some((statement) => statement.__sql.includes("INSERT INTO option_contract_quotes"))).toBe(true);
  });

  it("parses bridge health into troubleshooting status", async () => {
    const { env } = createOptionsEnv();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      ok: true,
      version: "1.0.0",
      ibkr: { authenticated: true, running: true },
      marketData: { entitled: true, quoteMode: "realtime" },
      latestTickAt: "2026-07-02T19:45:00Z",
      historicalPacing: { status: "ok" },
    })));

    const status = await loadOptionsStatus(env);

    expect(status.bridge.reachable).toBe(true);
    expect(status.bridge.authenticated).toBe(true);
    expect(status.bridge.quoteMode).toBe("realtime");
    expect(status.troubleshooting.find((row) => row.key === "auth")?.ok).toBe(true);
  });

  it("sends bridge bearer and Cloudflare Access headers", async () => {
    const { env } = createOptionsEnv({
      IBKR_OPTIONS_CF_ACCESS_CLIENT_ID: "access-id",
      IBKR_OPTIONS_CF_ACCESS_CLIENT_SECRET: "access-secret",
    });
    const fetchSpy = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);

    await loadOptionsStatus(env);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("CF-Access-Client-Id")).toBe("access-id");
    expect(headers.get("CF-Access-Client-Secret")).toBe("access-secret");
  });

  it("requires admin auth for options routes", async () => {
    const { env } = createOptionsEnv({ ADMIN_SECRET: "secret" });

    const response = await worker.fetch(new Request("https://worker.test/api/admin/options/status"), env);

    expect(response.status).toBe(401);
  });
});
