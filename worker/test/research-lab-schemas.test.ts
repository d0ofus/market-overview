import { describe, expect, it } from "vitest";

import { parseResearchLabTickerInput, validateResearchLabSynthesis } from "../src/research-lab/schemas";

describe("research lab schemas", () => {
  it("parses comma-separated ticker input into normalized unique symbols", () => {
    expect(parseResearchLabTickerInput(" msft, aapl; nvda\nmsft \t amd ")).toEqual([
      "MSFT",
      "AAPL",
      "NVDA",
      "AMD",
    ]);
  });

  it("rejects invalid ticker tokens", () => {
    expect(() => parseResearchLabTickerInput("AAPL, BRK/B")).toThrow(/valid US equity-style symbols/i);
  });

  it("normalizes an incomplete priorComparison object to null", () => {
    const result = validateResearchLabSynthesis({
      ticker: "GEV",
      companyName: "GE Vernova Inc.",
      opinion: "positive",
      overallSummary: "The setup still looks constructive.",
      whyNow: "Recent evidence keeps the name relevant.",
      valuationView: {
        label: "fair",
        summary: "Valuation looks fair.",
      },
      earningsQualityView: {
        label: "strong",
        summary: "Execution quality remains solid.",
      },
      pricedInView: {
        label: "partially_priced_in",
        summary: "Only part of the setup appears priced in.",
      },
      catalysts: [],
      risks: [],
      contradictions: [],
      confidence: {
        label: "medium",
        score: 0.64,
        summary: "Evidence is good but not exhaustive.",
      },
      monitoringPoints: ["Watch the next quarterly update."],
      priorComparison: {},
      evidenceIds: ["e1"],
    }, ["e1"]);

    expect(result.priorComparison).toBeNull();
  });

  it("coerces neutral catalyst directions to mixed", () => {
    const result = validateResearchLabSynthesis({
      ticker: "AA",
      companyName: "Alcoa Corporation",
      opinion: "mixed",
      overallSummary: "The setup is balanced.",
      whyNow: "Commodity and demand signals are mixed.",
      valuationView: {
        label: "fair",
        summary: "Valuation looks balanced.",
      },
      earningsQualityView: {
        label: "mixed",
        summary: "Operating quality is uneven.",
      },
      pricedInView: {
        label: "mostly_priced_in",
        summary: "Most of the current setup looks reflected.",
      },
      catalysts: [{
        title: "Aluminum pricing",
        summary: "Pricing trends are directionally uncertain.",
        direction: "neutral",
        timeframe: "next quarter",
        evidenceIds: ["e1"],
      }],
      risks: [],
      contradictions: [],
      confidence: {
        label: "medium",
        score: 0.52,
        summary: "Evidence is mixed.",
      },
      monitoringPoints: ["Watch pricing and demand updates."],
      priorComparison: null,
      evidenceIds: ["e1"],
    }, ["e1"]);

    expect(result.catalysts[0]?.direction).toBe("mixed");
  });
});
