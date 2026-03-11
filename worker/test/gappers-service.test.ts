import { describe, expect, it } from "vitest";
import { buildRankedGapCandidates, fallbackAnalysis, isSnapshotFresh } from "../src/gappers-service";

describe("gappers service helpers", () => {
  it("ranks positive premarket gappers by gap percent", () => {
    const rows = buildRankedGapCandidates({
      NVDA: { price: 121, prevClose: 100, premarketPrice: 121, premarketVolume: 500000 },
      PLTR: { price: 33, prevClose: 30, premarketPrice: 33, premarketVolume: 250000 },
      MSFT: { price: 395, prevClose: 400, premarketPrice: 395, premarketVolume: 900000 },
    }, 5);

    expect(rows.map((row) => row.ticker)).toEqual(["NVDA", "PLTR"]);
    expect(rows[0]?.gapPct).toBeGreaterThan(rows[1]?.gapPct ?? 0);
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
});
