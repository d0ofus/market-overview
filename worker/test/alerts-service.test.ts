import { describe, expect, it, vi, type MockInstance } from "vitest";
import { buildAlertDedupeSeed, normalizeAlertFilters, queryUniqueTickerDaysByFilters } from "../src/alerts-service";

type GroupedTickerDay = {
  ticker: string;
  tradingDay: string;
  latestReceivedAt: string;
  alertCount: number;
  marketSession: "premarket" | "regular" | "after-hours";
};

type NewsRow = {
  id: string;
  ticker: string;
  tradingDay: string;
  headline: string;
  source: string;
  url: string;
  publishedAt: string | null;
  snippet: string | null;
  fetchedAt: string;
};

type SymbolIndustryRow = {
  ticker: string;
  industry: string | null;
};

function stubTradingViewMetrics(rowsByTicker: Record<string, { price: number; change1d: number; marketCap: number; avgVolume: number }>): MockInstance {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { symbols?: { tickers?: string[] } };
    const data = (body.symbols?.tickers ?? [])
      .map((symbol) => {
        const ticker = String(symbol).split(":").pop()?.toUpperCase() ?? "";
        const row = rowsByTicker[ticker];
        if (!row) return null;
        return {
          s: symbol,
          d: [row.price, row.change1d, row.marketCap, row.avgVolume],
        };
      })
      .filter(Boolean);

    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function createAlertsQueryEnv(groupedRows: GroupedTickerDay[], newsRows: NewsRow[] = [], symbolRows: SymbolIndustryRow[] = []) {
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            all<T>() {
              if (sql.includes("SELECT a.id as alertId")) {
                return Promise.resolve({ results: [] as T[] });
              }
              if (sql.includes("SELECT t1.ticker as ticker")) {
                const limit = Number(args[4] ?? 0);
                const offset = Number(args[5] ?? 0);
                return Promise.resolve({
                  results: groupedRows.slice(offset, offset + limit) as T[],
                });
              }
              if (sql.includes("FROM ticker_news WHERE trading_day IN")) {
                const tradingDays = new Set(args.map((value) => String(value)));
                return Promise.resolve({
                  results: newsRows.filter((row) => tradingDays.has(row.tradingDay)) as T[],
                });
              }
              if (sql.includes("SELECT ticker, industry FROM symbols WHERE ticker IN")) {
                const tickers = new Set(args.map((value) => String(value).toUpperCase()));
                return Promise.resolve({
                  results: symbolRows.filter((row) => tickers.has(row.ticker.toUpperCase())) as T[],
                });
              }
              throw new Error(`Unhandled all() query in alerts test: ${sql}`);
            },
            first<T>() {
              if (sql.includes("SELECT COUNT(*) as count FROM (SELECT 1 FROM tv_alerts t1")) {
                return Promise.resolve({ count: groupedRows.length } as T);
              }
              throw new Error(`Unhandled first() query in alerts test: ${sql}`);
            },
          };
        },
      };
    },
  };

  return { DB: db as unknown as D1Database } as { DB: D1Database };
}

describe("alerts service helpers", () => {
  it("normalizes filter bounds and session values", () => {
    const normalized = normalizeAlertFilters({
      startDate: "2026-03-10",
      endDate: "2026-03-01",
      session: "invalid",
      limit: 5000,
    });
    expect(normalized.startDate).toBe("2026-03-01");
    expect(normalized.endDate).toBe("2026-03-10");
    expect(normalized.session).toBe("all");
    expect(normalized.limit).toBe(3000);
  });

  it("builds deterministic dedupe seeds", () => {
    const seedA = buildAlertDedupeSeed({
      messageId: "msg-1",
      ticker: "aapl",
      tradingDay: "2026-03-02",
      marketSession: "regular",
      alertType: "buy",
      strategyName: "Breakout",
      messageBody: "AAPL crossed above level",
      receivedAtUtc: "2026-03-02T14:45:12.000Z",
    });
    const seedB = buildAlertDedupeSeed({
      messageId: "msg-1",
      ticker: "AAPL",
      tradingDay: "2026-03-02",
      marketSession: "regular",
      alertType: "buy",
      strategyName: "Breakout",
      messageBody: "AAPL crossed above level",
      receivedAtUtc: "2026-03-02T14:45:59.000Z",
    });
    expect(seedA).toBe(seedB);
  });

  it("paginates unique ticker-days and returns totals without overlaps", async () => {
    const groupedRows: GroupedTickerDay[] = [
      { ticker: "MSFT", tradingDay: "2026-03-05", latestReceivedAt: "2026-03-05T21:00:00.000Z", alertCount: 2, marketSession: "after-hours" },
      { ticker: "NVDA", tradingDay: "2026-03-05", latestReceivedAt: "2026-03-05T19:30:00.000Z", alertCount: 1, marketSession: "regular" },
      { ticker: "AAPL", tradingDay: "2026-03-04", latestReceivedAt: "2026-03-04T18:00:00.000Z", alertCount: 3, marketSession: "regular" },
      { ticker: "TSLA", tradingDay: "2026-03-04", latestReceivedAt: "2026-03-04T15:00:00.000Z", alertCount: 1, marketSession: "premarket" },
      { ticker: "META", tradingDay: "2026-03-03", latestReceivedAt: "2026-03-03T20:00:00.000Z", alertCount: 1, marketSession: "after-hours" },
    ];
    const fetchMock = stubTradingViewMetrics({
      MSFT: { price: 420, change1d: 1.25, marketCap: 3_100_000_000_000, avgVolume: 20_000_000 },
      NVDA: { price: 900, change1d: 2.5, marketCap: 2_250_000_000_000, avgVolume: 40_000_000 },
      AAPL: { price: 190, change1d: -0.5, marketCap: 2_900_000_000_000, avgVolume: 50_000_000 },
      TSLA: { price: 250, change1d: 0.8, marketCap: 800_000_000_000, avgVolume: 100_000_000 },
      META: { price: 530, change1d: 1.1, marketCap: 1_350_000_000_000, avgVolume: 12_000_000 },
    });
    const env = createAlertsQueryEnv(groupedRows, [
      {
        id: "news-1",
        ticker: "AAPL",
        tradingDay: "2026-03-04",
        headline: "Apple headline",
        source: "Test Wire",
        url: "https://example.com/apple",
        publishedAt: "2026-03-04T17:00:00.000Z",
        snippet: "Apple snippet",
        fetchedAt: "2026-03-04T17:05:00.000Z",
      },
    ], [
      { ticker: "MSFT", industry: "Software" },
      { ticker: "NVDA", industry: "Semiconductors" },
      { ticker: "AAPL", industry: "Consumer Electronics" },
      { ticker: "TSLA", industry: "Auto Manufacturers" },
      { ticker: "META", industry: "Internet Content & Information" },
    ]);

    const page1 = await queryUniqueTickerDaysByFilters(env as never, {
      startDate: "2026-03-01",
      endDate: "2026-03-05",
      session: "all",
      limit: 2,
      offset: 0,
    });
    const page2 = await queryUniqueTickerDaysByFilters(env as never, {
      startDate: "2026-03-01",
      endDate: "2026-03-05",
      session: "all",
      limit: 2,
      offset: 2,
    });
    fetchMock.mockRestore();

    expect(page1.total).toBe(5);
    expect(page1.limit).toBe(2);
    expect(page1.offset).toBe(0);
    expect(page1.rows.map((row) => `${row.ticker}|${row.tradingDay}`)).toEqual([
      "MSFT|2026-03-05",
      "NVDA|2026-03-05",
    ]);

    expect(page2.total).toBe(5);
    expect(page2.limit).toBe(2);
    expect(page2.offset).toBe(2);
    expect(page2.rows.map((row) => `${row.ticker}|${row.tradingDay}`)).toEqual([
      "AAPL|2026-03-04",
      "TSLA|2026-03-04",
    ]);
    expect(page2.rows[0]?.news.map((item) => item.headline)).toEqual(["Apple headline"]);
    expect(page2.rows[0]?.industry).toBe("Consumer Electronics");
    expect(page2.rows[0]?.marketCap).toBe(2_900_000_000_000);
    expect(page2.rows[0]?.avgVolume).toBe(50_000_000);
    expect(page2.rows[0]?.priceAvgVolume).toBe(9_500_000_000);
    expect(page2.rows[1]?.industry).toBe("Auto Manufacturers");
    expect(page2.rows[1]?.priceAvgVolume).toBe(25_000_000_000);

    const combinedKeys = [...page1.rows, ...page2.rows].map((row) => `${row.ticker}|${row.tradingDay}`);
    expect(new Set(combinedKeys).size).toBe(combinedKeys.length);
  });
});
