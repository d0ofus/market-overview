import { describe, expect, it } from "vitest";
import {
  normalizeNewsCandidates,
  orchestrateTickerNews,
  rankAndDedupeNews,
  scoreNewsCandidate,
  type NewsCandidate,
  type TickerNewsProvider,
} from "../src/alerts-news";

function makeProvider(def: {
  name: string;
  available?: boolean;
  rows?: NewsCandidate[];
  error?: string;
}): TickerNewsProvider {
  return {
    name: def.name,
    priority: 50,
    timeoutMs: 50,
    isAvailable: () => def.available ?? true,
    async fetch() {
      if (def.error) throw new Error(def.error);
      return def.rows ?? [];
    },
  };
}

describe("alerts news orchestration", () => {
  it("deduplicates by canonical URL/headline and keeps top rows", () => {
    const rows = normalizeNewsCandidates(
      "AAPL",
      "2026-03-02",
      [
        {
          provider: "finnhub",
          headline: "Apple launches new AI feature",
          source: "Reuters",
          url: "https://example.com/story?utm_source=newsletter&id=1",
          publishedAt: "2026-03-02T15:00:00Z",
          snippet: "First copy",
        },
        {
          provider: "google-news-rss",
          headline: "Apple launches new AI feature",
          source: "Reuters",
          url: "https://www.example.com/story?id=1&utm_medium=email",
          publishedAt: "2026-03-02T15:01:00Z",
          snippet: "Duplicate copy",
        },
        {
          provider: "finnhub",
          headline: "Apple supplier update",
          source: "Bloomberg",
          url: "https://news.example.org/article/2",
          publishedAt: "2026-03-02T16:30:00Z",
          snippet: "Second story",
        },
      ],
      3,
      "2026-03-02T17:00:00Z",
    );

    expect(rows.length).toBe(2);
    expect(rows[0].ticker).toBe("AAPL");
    expect(rows[0].canonicalKey).not.toBe(rows[1].canonicalKey);
  });

  it("strips rss html snippets and hides boilerplate duplicates", () => {
    const rows = normalizeNewsCandidates(
      "TOI",
      "2026-03-16",
      [
        {
          provider: "google-news-rss",
          headline: "B. Riley Ups TOI Price Target Amidst Positive Earnings Outlook",
          source: "timothysykes.com",
          url: "https://example.com/toi-story",
          publishedAt: "2026-03-16T03:11:00Z",
          snippet: '<a href="https://news.google.com/rss/articles/example">B. Riley Ups TOI Price Target Amidst Positive Earnings Outlook</a> <font color="#6f6f6f">timothysykes.com</font> -------------',
        },
      ],
      3,
      "2026-03-16T03:20:00Z",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.snippet).toBeNull();
  });

  it("returns deduped news newest first by default", () => {
    const rows = rankAndDedupeNews(
      "AAPL",
      "2026-03-02",
      "Apple Inc",
      [
        {
          provider: "finnhub",
          headline: "Apple announces services event and raises guidance",
          source: "Reuters",
          url: "https://example.com/apple-old",
          publishedAt: "2026-03-02T10:00:00Z",
          snippet: "Apple Inc said demand improved and management raised guidance for services revenue.",
        },
        {
          provider: "google-news-rss",
          headline: "Apple supplier update points to stronger iPhone shipments",
          source: "MarketWatch",
          url: "https://example.com/apple-new",
          publishedAt: "2026-03-02T15:30:00Z",
          snippet: "Apple Inc and its suppliers are seeing stronger iPhone demand according to the latest channel checks.",
        },
      ],
      5,
      "2026-03-02T16:00:00Z",
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.url).toBe("https://example.com/apple-new");
    expect(rows[1]?.url).toBe("https://example.com/apple-old");
  });

  it("scores exact company-specific news above generic market stories", () => {
    const specific = scoreNewsCandidate(
      { ticker: "AAPL", companyName: "Apple Inc" },
      {
        provider: "finnhub",
        headline: "Apple cuts Vision Pro output after guidance reset",
        source: "Reuters",
        url: "https://example.com/apple",
        snippet: "Apple said it is reducing output after updated demand guidance.",
      },
    );
    const generic = scoreNewsCandidate(
      { ticker: "AAPL", companyName: "Apple Inc" },
      {
        provider: "yfinance-fallback",
        headline: "Wall Street opens mixed as Treasury yields rise",
        source: "Yahoo Finance",
        url: "https://example.com/market",
        snippet: "Mega-cap tech stocks were in focus across the market.",
      },
    );

    expect(specific).toBeGreaterThan(generic);
    expect(specific).toBeGreaterThan(50);
  });

  it("rejects weak incidental mentions during ranking", () => {
    const rows = rankAndDedupeNews(
      "AAPL",
      "2026-03-02",
      "Apple Inc",
      [
        {
          provider: "yfinance-fallback",
          headline: "Stocks rise as investors await CPI print",
          source: "Yahoo Finance",
          url: "https://example.com/generic",
          snippet: "Apple and other tech giants were among many stocks watched today.",
        },
      ],
      3,
      "2026-03-02T17:00:00Z",
    );

    expect(rows).toHaveLength(0);
  });

  it("stops after higher-priority providers return enough relevant stories", async () => {
    const result = await orchestrateTickerNews(
      {} as any,
      {
        ticker: "AAPL",
        companyName: "Apple Inc",
        tradingDay: "2026-03-02",
        startIso: "2026-03-01T00:00:00Z",
        endIso: "2026-03-03T23:59:59Z",
        maxItems: 2,
      },
      [
        makeProvider({
          name: "finnhub",
          rows: [
            {
              provider: "finnhub",
              headline: "Apple announces earnings date",
              source: "Reuters",
              url: "https://example.com/apple-1",
            },
            {
              provider: "finnhub",
              headline: "Apple receives analyst upgrade ahead of earnings",
              source: "CNBC",
              url: "https://example.com/apple-2",
            },
          ],
        }),
        makeProvider({
          name: "google-news-rss",
          rows: [
            {
              provider: "google-news-rss",
              headline: "This provider should not be needed",
              source: "Google News",
              url: "https://example.com/unused",
            },
          ],
        }),
      ],
    );

    expect(result.rows).toHaveLength(2);
    expect(result.providersTried).toEqual(["finnhub"]);
  });

  it("skips providers gracefully when env-gated availability is missing", async () => {
    const result = await orchestrateTickerNews(
      {} as any,
      {
        ticker: "AAPL",
        companyName: "Apple Inc",
        tradingDay: "2026-03-02",
        startIso: "2026-03-01T00:00:00Z",
        endIso: "2026-03-03T23:59:59Z",
        maxItems: 1,
      },
      [
        makeProvider({ name: "finnhub", available: false }),
        makeProvider({
          name: "google-news-rss",
          rows: [
            {
              provider: "google-news-rss",
              headline: "Apple signs large enterprise AI deal and raises guidance",
              source: "Google News",
              url: "https://example.com/apple-deal",
            },
          ],
        }),
      ],
    );

    expect(result.providersTried).toEqual(["google-news-rss"]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.headline).toContain("Apple");
  });

  it("continues to later fallbacks when an earlier provider times out", async () => {
    const result = await orchestrateTickerNews(
      {} as any,
      {
        ticker: "AAPL",
        companyName: "Apple Inc",
        tradingDay: "2026-03-02",
        startIso: "2026-03-01T00:00:00Z",
        endIso: "2026-03-03T23:59:59Z",
        maxItems: 1,
      },
      [
        makeProvider({ name: "finnhub", error: "AbortError: timeout" }),
        makeProvider({
          name: "alpha-vantage",
          rows: [
            {
              provider: "alpha-vantage",
              headline: "Apple files 8-K after board change",
              source: "Alpha Vantage",
              url: "https://example.com/apple-8k",
            },
          ],
        }),
      ],
    );

    expect(result.providersTried).toEqual(["finnhub", "alpha-vantage"]);
    expect(result.rows).toHaveLength(1);
    expect(result.trace[0]?.status).toBe("timeout");
  });
});
