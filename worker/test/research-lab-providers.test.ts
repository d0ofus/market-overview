import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  searchPerplexityMock: vi.fn(),
}));

vi.mock("../src/research/providers/perplexity-search", () => ({
  searchPerplexity: harness.searchPerplexityMock,
}));

import { RESEARCH_LAB_PERPLEXITY_TIMEOUT_MS } from "../src/research-lab/constants";
import { runResearchLabPerplexityQuery } from "../src/research-lab/providers";

describe("research lab providers", () => {
  it("uses the lab-specific Perplexity timeout override", async () => {
    harness.searchPerplexityMock.mockResolvedValue({
      items: [],
      usage: null,
      raw: null,
    });

    await runResearchLabPerplexityQuery({} as any, {
      key: "news_catalysts",
      label: "News & Catalysts",
      query: "AMPX recent catalysts",
      ticker: "AMPX",
      limit: 3,
      sourceKind: "news",
    });

    expect(harness.searchPerplexityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        key: "news_catalysts",
        ticker: "AMPX",
      }),
      expect.objectContaining({
        forceFresh: true,
        timeoutMs: RESEARCH_LAB_PERPLEXITY_TIMEOUT_MS,
      }),
    );
  });
});
