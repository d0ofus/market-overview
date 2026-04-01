import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  callResearchLabSonnetJsonMock: vi.fn(),
}));

vi.mock("../src/research-lab/providers", () => ({
  callResearchLabSonnetJson: harness.callResearchLabSonnetJsonMock,
}));

import { RESEARCH_LAB_ANTHROPIC_MAX_TOKENS, RESEARCH_LAB_SYNTHESIS_MAX_PROMPT_CHARS } from "../src/research-lab/constants";
import { synthesizeResearchLabOutput } from "../src/research-lab/synthesize";

describe("research lab synthesize", () => {
  it("shrinks oversized synthesis prompts before calling Claude", async () => {
    harness.callResearchLabSonnetJsonMock.mockResolvedValue({
      data: {
        ticker: "AMZN",
        companyName: "Amazon.com, Inc.",
        opinion: "positive",
        overallSummary: "Demand remains healthy and the evidence set is constructive.",
        whyNow: "Recent execution and cloud commentary keep the setup relevant now.",
        valuationView: {
          label: "fair",
          summary: "Valuation looks fair relative to the current setup.",
        },
        earningsQualityView: {
          label: "strong",
          summary: "The evidence points to solid execution quality.",
        },
        pricedInView: {
          label: "partially_priced_in",
          summary: "Some of the improvement appears reflected, but not all of it.",
        },
        catalysts: [{
          title: "Cloud momentum",
          summary: "Cloud demand remains a key positive catalyst.",
          direction: "positive",
          timeframe: "next quarter",
          evidenceIds: ["e1"],
        }],
        risks: [{
          title: "Margin pressure",
          summary: "Margins still need to hold up.",
          severity: "medium",
          evidenceIds: ["e1"],
        }],
        contradictions: [],
        confidence: {
          label: "medium",
          score: 0.66,
          summary: "The setup is decent, but still depends on a few moving parts.",
        },
        monitoringPoints: ["Watch the next cloud growth update."],
        priorComparison: null,
        evidenceIds: ["e1"],
      },
      usage: { input_tokens: 100, output_tokens: 200 },
      model: "claude-sonnet-4-6",
    });

    const longText = "A".repeat(2_400);
    const evidence = Array.from({ length: 8 }, (_, index) => ({
      id: `evidence-${index + 1}`,
      runId: "run-1",
      runItemId: "item-1",
      ticker: "AMZN",
      providerKey: "perplexity" as const,
      evidenceKind: (index % 2 === 0 ? "news_catalysts" : "analyst_media") as "news_catalysts" | "analyst_media",
      queryLabel: "News",
      canonicalUrl: `https://example.com/${index + 1}`,
      sourceDomain: "example.com",
      title: `Evidence ${index + 1}`,
      publishedAt: "2026-04-01T00:00:00.000Z",
      summary: longText,
      excerpt: longText,
      bullets: [],
      contentHash: `hash-${index + 1}`,
      providerPayloadJson: null,
      createdAt: "2026-04-01T00:00:00.000Z",
    }));

    const result = await synthesizeResearchLabOutput({} as any, {
      identity: {
        ticker: "AMZN",
        companyName: "Amazon.com, Inc.",
        exchange: "NASDAQ",
        secCik: "0001018724",
        irDomain: "amazon.com",
      },
      evidence,
      promptConfig: {
        id: "prompt-1",
        name: "Prompt",
        description: null,
        configFamily: "research_lab_default",
        modelFamily: "claude-sonnet-4-6",
        systemPrompt: "Produce a strict JSON synthesis.",
        schemaVersion: "v1",
        isDefault: true,
        synthesisConfigJson: {},
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
      evidencePromptLimit: evidence.length,
      priorOutput: {
        id: "prior-1",
        runId: "run-0",
        runItemId: "item-0",
        ticker: "AMZN",
        profileId: "profile-1",
        profileVersionId: "profile-version-1",
        promptConfigId: "prompt-1",
        evidenceProfileId: "profile-1",
        priorOutputId: null,
        synthesisJson: {} as any,
        memorySummaryJson: {
          opinion: "positive",
          overallSummary: longText,
          pricedInLabel: "partially_priced_in",
          confidenceLabel: "medium",
          topCatalysts: [longText, longText, longText, longText],
          topRisks: [longText, longText, longText, longText],
          evidenceIds: ["old-1", "old-2", "old-3", "old-4", "old-5", "old-6", "old-7"],
        },
        deltaJson: {
          opinionChanged: false,
          previousOpinion: "positive",
          currentOpinion: "positive",
          newCatalysts: [],
          resolvedCatalysts: [],
          newRisks: [],
          resolvedRisks: [],
          confidenceChanged: false,
          previousConfidenceLabel: "medium",
          currentConfidenceLabel: "medium",
          pricedInChanged: false,
          previousPricedInLabel: "partially_priced_in",
          currentPricedInLabel: "partially_priced_in",
          summary: longText,
        },
        sourceEvidenceIds: ["old-1"],
        model: "claude-sonnet-4-6",
        usageJson: null,
        createdAt: "2026-03-31T00:00:00.000Z",
      },
    });

    expect(harness.callResearchLabSonnetJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        maxTokens: RESEARCH_LAB_ANTHROPIC_MAX_TOKENS,
      }),
    );

    const promptInput = harness.callResearchLabSonnetJsonMock.mock.calls[0]?.[1];
    expect(typeof promptInput?.user).toBe("string");
    expect(promptInput.user.length).toBeLessThanOrEqual(RESEARCH_LAB_SYNTHESIS_MAX_PROMPT_CHARS);

    const payload = JSON.parse(promptInput.user);
    expect(payload.priorDeltaSummary === null || payload.priorDeltaSummary.length <= 220).toBe(true);
    expect(payload.evidenceFamilies.every((family: { items: Array<{ summary: string; excerpt?: string | null; ref: string; canonicalId?: unknown }> }) => (
      family.items.every((item) => item.summary.length <= 220 && (!item.excerpt || item.excerpt.length <= 120) && /^e\d+$/.test(item.ref) && item.canonicalId === undefined)
    ))).toBe(true);
    expect(Array.isArray(payload.requestedSections?.base)).toBe(true);
    expect(result.synthesis.catalysts[0]?.evidenceIds).toEqual(["evidence-1"]);
    expect(result.synthesis.risks[0]?.evidenceIds).toEqual(["evidence-1"]);
    expect(result.synthesis.evidenceIds).toEqual(["evidence-1"]);
  });
});
