import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  queryCalls: [] as any[],
}));

vi.mock("../src/research-lab/providers", () => ({
  runResearchLabPerplexityQuery: vi.fn(async (_env: unknown, query: any) => {
    harness.queryCalls.push(query);
    return {
      items: Array.from({ length: query.limit }, (_, index) => ({
        title: `${query.label} ${index + 1}`,
        url: `https://example.com/${query.key}/${index + 1}`,
        summary: `${query.label} summary ${index + 1}`,
        excerpt: null,
        bullets: [],
        publishedAt: "2026-03-31T09:00:00.000Z",
        sourceDomain: "example.com",
      })),
      usage: { total_tokens: 10 },
      raw: { model: "sonar-pro" },
    };
  }),
}));

import { gatherResearchLabEvidence } from "../src/research-lab/gather";

describe("research lab gather", () => {
  beforeEach(() => {
    harness.queryCalls.length = 0;
  });

  it("stops after enough evidence instead of running every configured family", async () => {
    const result = await gatherResearchLabEvidence({ PERPLEXITY_MODEL: "sonar-pro" } as any, {
      runId: "run-1",
      runItemId: "item-1",
      identity: {
        ticker: "NVDA",
        companyName: "NVIDIA Corporation",
        exchange: "NASDAQ",
        secCik: "1045810",
        irDomain: "investor.nvidia.com",
      },
      evidenceProfile: {
        id: "profile-1",
        name: "Test",
        description: null,
        configFamily: "test",
        isDefault: true,
        queryConfigJson: {
          maxItemsPerQuery: 2,
          evidenceTarget: 4,
          maxQueryFamilies: 6,
          families: [
            { key: "key_metrics", label: "Key Metrics", queryTemplate: "{ticker}", sourceKind: "news", limit: 2 },
            { key: "news_catalysts", label: "News", queryTemplate: "{ticker}", sourceKind: "news", limit: 2 },
            { key: "investor_relations", label: "IR", queryTemplate: "{ticker}", sourceKind: "ir_page", limit: 2 },
            { key: "transcripts", label: "Transcripts", queryTemplate: "{ticker}", sourceKind: "earnings_transcript", limit: 2 },
          ],
        },
        createdAt: "2026-03-31T09:00:00.000Z",
        updatedAt: "2026-03-31T09:00:00.000Z",
      },
    });

    expect(result.evidence).toHaveLength(4);
    expect(harness.queryCalls).toHaveLength(2);
  });

  it("filters stale or undated evidence when the profile requires fresh dated items", async () => {
    harness.queryCalls.length = 0;
    const staleItems = [
      {
        title: "Old catalyst",
        url: "https://example.com/news/old",
        summary: "Old summary",
        excerpt: null,
        bullets: [],
        publishedAt: "2025-10-01T09:00:00.000Z",
        sourceDomain: "example.com",
      },
      {
        title: "Undated catalyst",
        url: "https://example.com/news/undated",
        summary: "Undated summary",
        excerpt: null,
        bullets: [],
        publishedAt: null,
        sourceDomain: "example.com",
      },
      {
        title: "Fresh catalyst",
        url: "https://example.com/news/fresh",
        summary: "Fresh summary",
        excerpt: null,
        bullets: [],
        publishedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        sourceDomain: "example.com",
      },
    ];

    const provider = await import("../src/research-lab/providers");
    vi.mocked(provider.runResearchLabPerplexityQuery).mockResolvedValueOnce({
      items: staleItems,
      usage: { total_tokens: 10 },
      raw: { model: "sonar-pro" },
    });

    const result = await gatherResearchLabEvidence({ PERPLEXITY_MODEL: "sonar-pro" } as any, {
      runId: "run-2",
      runItemId: "item-2",
      identity: {
        ticker: "ZM",
        companyName: "Zoom Communications, Inc.",
        exchange: "NASDAQ",
        secCik: "1585521",
        irDomain: "investors.zoom.us",
      },
      evidenceProfile: {
        id: "profile-2",
        name: "Freshness",
        description: null,
        configFamily: "test",
        isDefault: false,
        queryConfigJson: {
          maxItemsPerQuery: 3,
          evidenceTarget: 3,
          maxQueryFamilies: 1,
          families: [
            {
              key: "news_catalysts",
              label: "News",
              queryTemplate: "{ticker}",
              sourceKind: "news",
              limit: 3,
              maxAgeDays: 21,
              requirePublishedAt: true,
            },
          ],
        },
        createdAt: "2026-04-05T09:00:00.000Z",
        updatedAt: "2026-04-05T09:00:00.000Z",
      },
    });

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.title).toBe("Fresh catalyst");
    expect(harness.queryCalls[0]).toMatchObject({
      key: "news_catalysts",
      maxAgeDays: 21,
      requirePublishedAt: true,
    });
  });
});
