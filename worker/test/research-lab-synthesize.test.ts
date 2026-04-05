import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  callResearchLabSonnetJsonMock: vi.fn(),
}));

vi.mock("../src/research-lab/providers", () => ({
  callResearchLabSonnetJson: harness.callResearchLabSonnetJsonMock,
}));

import { RESEARCH_LAB_ANTHROPIC_MAX_TOKENS, RESEARCH_LAB_SYNTHESIS_MAX_PROMPT_CHARS } from "../src/research-lab/constants";
import { synthesizeResearchLabOutput } from "../src/research-lab/synthesize";

function buildMockResponse() {
  return {
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
  };
}

function buildEvidence() {
  const longText = "A".repeat(2_400);
  return [
    {
      id: "evidence-1",
      runId: "run-1",
      runItemId: "item-1",
      ticker: "AMZN",
      providerKey: "perplexity" as const,
      evidenceKind: "transcripts" as const,
      queryLabel: "Transcripts",
      canonicalUrl: "https://example.com/transcript",
      sourceDomain: "example.com",
      title: "Transcript evidence",
      publishedAt: "2026-04-01T00:00:00.000Z",
      summary: longText,
      excerpt: longText,
      bullets: [],
      contentHash: "hash-1",
      providerPayloadJson: null,
      createdAt: "2026-04-01T00:00:00.000Z",
    },
    {
      id: "evidence-2",
      runId: "run-1",
      runItemId: "item-1",
      ticker: "AMZN",
      providerKey: "perplexity" as const,
      evidenceKind: "analyst_media" as const,
      queryLabel: "Analyst / Media",
      canonicalUrl: "https://example.com/analyst",
      sourceDomain: "example.com",
      title: "Analyst evidence",
      publishedAt: "2026-04-01T00:00:00.000Z",
      summary: longText,
      excerpt: longText,
      bullets: [],
      contentHash: "hash-2",
      providerPayloadJson: null,
      createdAt: "2026-04-01T00:00:00.000Z",
    },
    {
      id: "evidence-3",
      runId: "run-1",
      runItemId: "item-1",
      ticker: "AMZN",
      providerKey: "perplexity" as const,
      evidenceKind: "investor_relations" as const,
      queryLabel: "Investor Relations",
      canonicalUrl: "https://example.com/ir",
      sourceDomain: "example.com",
      title: "IR evidence",
      publishedAt: "2026-04-01T00:00:00.000Z",
      summary: longText,
      excerpt: longText,
      bullets: [],
      contentHash: "hash-3",
      providerPayloadJson: null,
      createdAt: "2026-04-01T00:00:00.000Z",
    },
    {
      id: "evidence-4",
      runId: "run-1",
      runItemId: "item-1",
      ticker: "AMZN",
      providerKey: "perplexity" as const,
      evidenceKind: "news_catalysts" as const,
      queryLabel: "News",
      canonicalUrl: "https://example.com/news",
      sourceDomain: "example.com",
      title: "News evidence",
      publishedAt: "2026-04-01T00:00:00.000Z",
      summary: longText,
      excerpt: longText,
      bullets: [],
      contentHash: "hash-4",
      providerPayloadJson: null,
      createdAt: "2026-04-01T00:00:00.000Z",
    },
  ];
}

function buildPriorOutput() {
  const longText = "A".repeat(2_400);
  return {
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
  };
}

function buildPromptConfig(synthesisConfigJson: Record<string, unknown> = {}) {
  return {
    id: "prompt-1",
    name: "Prompt",
    description: null,
    configFamily: "research_lab_default",
    modelFamily: "claude-sonnet-4-6",
    systemPrompt: "Produce a strict JSON synthesis.",
    schemaVersion: "v1",
    isDefault: true,
    synthesisConfigJson,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

async function runSynthesis(synthesisConfigJson: Record<string, unknown> = {}) {
  const evidence = buildEvidence();
  const priorOutput = buildPriorOutput();
  const result = await synthesizeResearchLabOutput({} as any, {
    identity: {
      ticker: "AMZN",
      companyName: "Amazon.com, Inc.",
      exchange: "NASDAQ",
      secCik: "0001018724",
      irDomain: "amazon.com",
    },
    evidence,
    promptConfig: buildPromptConfig(synthesisConfigJson),
    evidencePromptLimit: evidence.length,
    priorOutput,
  });

  const promptInput = harness.callResearchLabSonnetJsonMock.mock.calls.at(-1)?.[1];
  return {
    result,
    promptInput,
    payload: JSON.parse(String(promptInput?.user ?? "{}")),
  };
}

describe("research lab synthesize", () => {
  beforeEach(() => {
    harness.callResearchLabSonnetJsonMock.mockReset();
    harness.callResearchLabSonnetJsonMock.mockResolvedValue(buildMockResponse());
  });

  it("builds a smaller default synthesis payload while preserving evidence remapping", async () => {
    const { result, promptInput, payload } = await runSynthesis();

    expect(harness.callResearchLabSonnetJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        maxTokens: RESEARCH_LAB_ANTHROPIC_MAX_TOKENS,
      }),
    );
    expect(typeof promptInput?.user).toBe("string");
    expect(promptInput.user.length).toBeLessThanOrEqual(RESEARCH_LAB_SYNTHESIS_MAX_PROMPT_CHARS);

    expect(payload.requestedSections?.base).toBeUndefined();
    expect(payload.evidenceFamilies.every((family: { label?: unknown }) => family.label === undefined)).toBe(true);
    expect(payload.priorMemorySummary).toBeTruthy();
    expect(payload.priorDeltaSummary).toBeUndefined();
    expect(payload.evidenceFamilies.every((family: { items: Array<{
      summary: string;
      excerpt?: string | null;
      ref: string;
      canonicalId?: unknown;
      sourceDomain?: unknown;
      publishedAt?: unknown;
    }> }) => (
      family.items.every((item) => (
        item.summary.length <= 160
        && /^e\d+$/.test(item.ref)
        && item.canonicalId === undefined
        && item.sourceDomain === undefined
        && item.publishedAt === undefined
      ))
    ))).toBe(true);

    const transcriptItem = payload.evidenceFamilies.find((family: { kind: string }) => family.kind === "transcripts")?.items[0];
    const irItem = payload.evidenceFamilies.find((family: { kind: string }) => family.kind === "investor_relations")?.items[0];
    const analystItem = payload.evidenceFamilies.find((family: { kind: string }) => family.kind === "analyst_media")?.items[0];
    expect(transcriptItem?.excerpt?.length).toBeLessThanOrEqual(100);
    expect(irItem?.excerpt?.length).toBeLessThanOrEqual(100);
    expect(analystItem?.excerpt).toBeUndefined();

    expect(result.synthesis.catalysts[0]?.evidenceIds).toEqual(["evidence-4"]);
    expect(result.synthesis.risks[0]?.evidenceIds).toEqual(["evidence-4"]);
    expect(result.synthesis.evidenceIds).toEqual(["evidence-4"]);
  });

  it("supports config overrides and keeps module payloads when enabled", async () => {
    const baseline = await runSynthesis();
    const overridden = await runSynthesis({
      includeRequestedSections: true,
      includeFamilyLabels: true,
      includeSourceDomain: true,
      includePublishedAt: true,
      excerptFamilies: ["transcripts", "investor_relations", "analyst_media", "news_catalysts"],
      includePriorDelta: true,
      summaryCharsByShape: { full: 220, medium: 180, compact: 140 },
      excerptCharsByShape: { full: 120, medium: 40, compact: 0 },
      modules: {
        keyDrivers: {
          enabled: true,
          maxDrivers: 2,
          requirePriceRelationship: true,
          priceWindow: "30d",
        },
      },
    });

    expect(overridden.promptInput.user.length).toBeGreaterThan(baseline.promptInput.user.length);
    expect(Array.isArray(overridden.payload.requestedSections?.base)).toBe(true);
    expect(overridden.payload.requestedSections?.modules?.keyDrivers).toEqual({
      maxDrivers: 2,
      requirePriceRelationship: true,
      priceWindow: "30d",
    });
    expect(overridden.payload.evidenceFamilies.some((family: { label?: unknown }) => typeof family.label === "string")).toBe(true);
    expect(overridden.payload.priorDeltaSummary).toBeTruthy();

    const analystItem = overridden.payload.evidenceFamilies.find((family: { kind: string }) => family.kind === "analyst_media")?.items[0];
    expect(analystItem?.sourceDomain).toBe("example.com");
    expect(analystItem?.publishedAt).toBe("2026-04-01T00:00:00.000Z");
    expect(analystItem?.excerpt?.length).toBeLessThanOrEqual(120);

    expect(String(overridden.promptInput.promptConfig.systemPrompt)).toContain("modules.keyDrivers");
  });

  it("can omit prior memory entirely when configured", async () => {
    const withoutMemory = await runSynthesis({
      includePriorMemory: false,
    });

    expect(withoutMemory.payload.priorMemorySummary).toBeUndefined();
    expect(withoutMemory.payload.priorDeltaSummary).toBeUndefined();
  });
});
