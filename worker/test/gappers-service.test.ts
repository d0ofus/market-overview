import { describe, expect, it, vi } from "vitest";
import {
  buildTradingViewPremarketPayload,
  fetchTradingViewGapCandidates,
  fallbackAnalysis,
  isSnapshotFresh,
  loadStoredGappersSnapshot,
  normalizeGappersScanFilters,
  resolveLlmConfig,
} from "../src/gappers-service";

describe("gappers service helpers", () => {
  it("builds a tradingview premarket payload with numeric filters", () => {
    const payload = buildTradingViewPremarketPayload({
      limit: 100,
      minMarketCap: 1_000_000_000,
      maxMarketCap: 10_000_000_000,
      minPrice: 2,
      maxPrice: 20,
      minGapPct: 5,
      maxGapPct: 25,
    });

    expect(payload.range).toEqual([0, 100]);
    expect(payload.sort).toEqual({ sortBy: "premarket_gap", sortOrder: "desc" });
    expect(payload.filter).toEqual([
      { left: "premarket_gap", operation: "greater", right: 0 },
      { left: "market_cap_basic", operation: "in_range", right: [1_000_000_000, 10_000_000_000] },
      { left: "close", operation: "in_range", right: [2, 20] },
      { left: "premarket_gap", operation: "in_range", right: [5, 25] },
    ]);
  });

  it("normalizes scan filters and caps the list size at 100", () => {
    const filters = normalizeGappersScanFilters({
      limit: 250,
      industries: ["Semiconductors", "Semiconductors", "Biotechnology"],
      minGapPct: 4,
    });

    expect(filters.limit).toBe(100);
    expect(filters.industries).toEqual(["Semiconductors", "Biotechnology"]);
    expect(filters.minGapPct).toBe(4);
  });

  it("enforces min price after upstream rows are parsed", async () => {
    const response = {
      data: [
        { s: "NASDAQ:LOW", d: ["Low Inc", "Tech", "Software", 1_000_000_000, 9.5, 0, 1, 10.5, 12, 500_000] },
        { s: "NASDAQ:HIGH", d: ["High Inc", "Tech", "Software", 2_000_000_000, 12, 0, 1, 13, 8, 900_000] },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => response,
    });
    vi.stubGlobal("fetch", fetchMock);

    const rows = await fetchTradingViewGapCandidates({
      limit: 10,
      minPrice: 10,
    });

    expect(rows.map((row) => row.ticker)).toEqual(["HIGH"]);
    vi.unstubAllGlobals();
  });

  it("builds rule-based analysis when llm data is unavailable", () => {
    const analysis = fallbackAnalysis({
      ticker: "AAPL",
      gapPct: 7.4,
      premarketVolume: 1500000,
      news: [
        {
          headline: "Apple beats earnings expectations",
          source: "Reuters",
          url: "https://example.com/story",
          publishedAt: new Date().toISOString(),
          snippet: "Revenue topped estimates.",
        },
      ],
    });

    expect(analysis.compositeScore).toBeGreaterThan(50);
    expect(analysis.freshnessLabel).toBe("fresh");
    expect(analysis.reasoningBullets.length).toBeGreaterThan(0);
  });

  it("checks snapshot freshness on a short cache window", () => {
    const freshAt = new Date().toISOString();
    const staleAt = new Date(Date.now() - 90_000).toISOString();

    expect(isSnapshotFresh(freshAt)).toBe(true);
    expect(isSnapshotFresh(staleAt)).toBe(false);
  });

  it("loads the public gappers payload from stored rows without providers or writes", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const writeMock = vi.fn(async () => {
      throw new Error("stored-read path must not write");
    });
    const db = {
      prepare(sql: string) {
        const statement = {
          async first<T>() {
            if (!sql.includes("FROM gappers_snapshots")) return null as T;
            return {
              id: "snapshot-1",
              marketSession: "premarket",
              providerLabel: "TradingView",
              generatedAt: new Date().toISOString(),
              rowCount: 1,
              status: "ok",
              error: null,
            } as T;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
          bind() {
            return {
              ...statement,
              async all<T>() {
                return {
                  results: [{
                    ticker: "AAPL",
                    name: "Apple",
                    sector: "Technology",
                    industry: "Consumer Electronics",
                    marketCap: 3_000_000_000_000,
                    price: 200,
                    prevClose: 190,
                    premarketPrice: 202,
                    gapPct: 6.3,
                    premarketVolume: 1_000_000,
                    newsJson: "[]",
                    analysisJson: null,
                    compositeScore: 75,
                  }] as T[],
                };
              },
            };
          },
          run: writeMock,
        };
        return statement;
      },
    } as unknown as D1Database;

    const snapshot = await loadStoredGappersSnapshot({ DB: db }, 25);

    expect(snapshot.rows.map((row) => row.ticker)).toEqual(["AAPL"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("resolves anthropic and openai llm settings from overrides and env", () => {
    const anthropic = resolveLlmConfig({
      DB: {} as D1Database,
      ANTHROPIC_API_KEY: "env-ant",
    }, {
      provider: "anthropic",
      apiKey: "override-ant",
      model: "claude-3-7-sonnet-latest",
      baseUrl: "https://api.anthropic.com/v1",
    });
    const openai = resolveLlmConfig({
      DB: {} as D1Database,
      OPENAI_API_KEY: "env-openai",
      LLM_MODEL: "gpt-4.1-mini",
    }, {
      provider: "openai",
    });

    expect(anthropic).toEqual({
      provider: "anthropic",
      apiKey: "override-ant",
      model: "claude-3-7-sonnet-latest",
      baseUrl: "https://api.anthropic.com/v1",
    });
    expect(openai?.provider).toBe("openai");
    expect(openai?.apiKey).toBe("env-openai");
    expect(openai?.model).toBe("gpt-4.1-mini");
  });
});
