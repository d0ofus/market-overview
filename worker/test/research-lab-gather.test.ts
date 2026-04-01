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
});
