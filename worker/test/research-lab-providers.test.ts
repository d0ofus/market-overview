import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  searchPerplexityMock: vi.fn(),
  buildAnthropicSonnetModelsMock: vi.fn(),
  callAnthropicJsonMock: vi.fn(),
}));

vi.mock("../src/research/providers/perplexity-search", () => ({
  searchPerplexity: harness.searchPerplexityMock,
}));

vi.mock("../src/research/providers/anthropic", () => ({
  buildAnthropicSonnetModels: harness.buildAnthropicSonnetModelsMock,
  callAnthropicJson: harness.callAnthropicJsonMock,
}));

import {
  RESEARCH_LAB_ANTHROPIC_MAX_ATTEMPTS,
  RESEARCH_LAB_ANTHROPIC_MAX_TOKENS,
  RESEARCH_LAB_ANTHROPIC_TIMEOUT_MS,
  RESEARCH_LAB_PERPLEXITY_TIMEOUT_MS,
} from "../src/research-lab/constants";
import { callResearchLabSonnetJson, runResearchLabPerplexityQuery } from "../src/research-lab/providers";

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
        forceFresh: false,
        timeoutMs: RESEARCH_LAB_PERPLEXITY_TIMEOUT_MS,
      }),
    );
  });

  it("reuses shared Anthropic model fallback logic for lab synthesis", async () => {
    harness.buildAnthropicSonnetModelsMock.mockReturnValue({
      model: "claude-sonnet-4-6",
      fallbackModels: ["claude-sonnet-4-5", "claude-3-5-sonnet-20241022"],
    });
    harness.callAnthropicJsonMock.mockResolvedValue({
      data: { ok: true },
      usage: { input_tokens: 1, output_tokens: 2 },
      model: "claude-sonnet-4-5",
    });

    await callResearchLabSonnetJson({ ANTHROPIC_API_KEY: "test" } as any, {
      promptConfig: {
        id: "prompt",
        name: "Prompt",
        description: null,
        configFamily: "research_lab_default",
        modelFamily: "claude-3-7-sonnet-latest",
        systemPrompt: "Return strict JSON only.",
        schemaVersion: "v1",
        isDefault: true,
        synthesisConfigJson: {},
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
      user: "{}",
    });

    expect(harness.buildAnthropicSonnetModelsMock).toHaveBeenCalledWith(
      expect.anything(),
      "claude-3-7-sonnet-latest",
    );
    expect(harness.callAnthropicJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        fallbackModels: ["claude-sonnet-4-5", "claude-3-5-sonnet-20241022"],
        maxTokens: RESEARCH_LAB_ANTHROPIC_MAX_TOKENS,
        requestTimeoutMs: RESEARCH_LAB_ANTHROPIC_TIMEOUT_MS,
        maxAttemptsPerModel: RESEARCH_LAB_ANTHROPIC_MAX_ATTEMPTS,
      }),
    );
  });
});
