import { describe, expect, it } from "vitest";
import {
  extractReadableTextFromHtml,
  loadLatestFomcCommentary,
  normalizeBraveFomcSources,
  normalizeFomcCommentaryRow,
  parseGeminiFomcJson,
  testExports,
} from "../src/fomc-commentary-service";

const row = {
  id: "item-1",
  eventType: "minutes" as const,
  meetingDate: "2026-06-17",
  releaseDate: "2026-07-08",
  sourceUrl: "https://www.federalreserve.gov/monetarypolicy/fomcminutes20260617.htm",
  sourceTitle: "Minutes",
  sourceMode: "official_plus_brave" as const,
  status: "ready" as const,
  summaryMarkdown: "## Policy signal",
  highlightsJson: JSON.stringify(["Rates steady", "Inflation still elevated"]),
  tradingReadThrough: "Watch the curve.",
  citationSourcesJson: JSON.stringify([
    { sourceName: "Reuters", url: "https://www.reuters.com/markets/us/fomc", title: "FOMC", snippet: "Markets", usedFor: "context" },
  ]),
  generatedAt: "2026-07-08T18:00:00.000Z",
  provider: "gemini",
  model: "gemini-test",
  error: null,
};

describe("FOMC commentary service helpers", () => {
  it("loadLatestFomcCommentary returns [] when the migration has not been applied", async () => {
    const env = {
      DB: {
        prepare() {
          return {
            bind() { return this; },
            async all() { throw new Error("no such table: fomc_commentary_items"); },
          };
        },
      },
    };
    await expect(loadLatestFomcCommentary(env as never)).resolves.toEqual([]);
  });

  it("normalizes stored rows and safely parses highlights and citations", () => {
    const item = normalizeFomcCommentaryRow(row);
    expect(item.highlights).toEqual(["Rates steady", "Inflation still elevated"]);
    expect(item.citationSources).toHaveLength(1);
    expect(item.sourceMode).toBe("official_plus_brave");
  });

  it("falls back to empty arrays for malformed JSON", () => {
    const item = normalizeFomcCommentaryRow({ ...row, highlightsJson: "not json", citationSourcesJson: "{}" });
    expect(item.highlights).toEqual([]);
    expect(item.citationSources).toEqual([]);
  });

  it("extracts readable Fed-like HTML without script/style/nav noise", () => {
    const text = extractReadableTextFromHtml("<html><script>bad()</script><style>.x{}</style><nav>Menu</nav><main><h1>FOMC Minutes</h1><p>Policy stayed restrictive &amp; data-dependent.</p></main></html>");
    expect(text).toContain("FOMC Minutes");
    expect(text).toContain("Policy stayed restrictive & data-dependent.");
    expect(text).not.toContain("bad()");
    expect(text).not.toContain("Menu");
  });

  it("keeps only allowlisted Brave citations and marks Fed URLs as discovery", () => {
    const sources = normalizeBraveFomcSources([
      { title: "Fed minutes", url: "https://www.federalreserve.gov/monetarypolicy/fomcminutes.htm", description: "Official", source: null, publishedAt: null },
      { title: "Reuters take", url: "https://www.reuters.com/markets/us/fed-minutes", description: "Context", source: "Reuters", publishedAt: null },
      { title: "Random blog", url: "https://example.com/fed", description: "Nope", source: "Blog", publishedAt: null },
    ], "context");
    expect(sources.map((source) => source.sourceName)).toEqual(["Federal Reserve", "Reuters"]);
    expect(sources[0]?.usedFor).toBe("discovery");
    expect(sources[1]?.usedFor).toBe("context");
  });

  it("parses strict Gemini JSON and used citation URLs", () => {
    const parsed = parseGeminiFomcJson('```json\n{"highlights":["Rates path unchanged"],"tradingReadThrough":"Curve repricing risk.","summaryMarkdown":"## Policy signal","usedCitationUrls":["https://www.reuters.com/markets/us/fed-minutes"]}\n```');
    expect(parsed.highlights).toEqual(["Rates path unchanged"]);
    expect(parsed.usedCitationUrls).toEqual(["https://www.reuters.com/markets/us/fed-minutes"]);
  });

  it("builds a prompt that constrains Brave to cited context/fallback", () => {
    const prompt = testExports.buildFomcPrompt({
      eventType: "minutes",
      meetingDate: "2026-06-17",
      sourceMode: "fallback_context",
      officialText: "Reuters: officials sounded cautious.",
      citations: [{ sourceName: "Reuters", url: "https://www.reuters.com/markets/us/fed-minutes", title: "Fed", snippet: "Officials cautious", usedFor: "fallback" }],
    });
    expect(prompt).toContain("Primary source text is authoritative");
    expect(prompt).toContain("SECONDARY-SOURCE FALLBACK");
    expect(prompt).toContain("must be cited");
    expect(prompt).toContain("https://www.reuters.com/markets/us/fed-minutes");
  });

  it("finds the latest official press conference and minutes links from the Fed calendar", () => {
    const sources = testExports.extractOfficialFomcSourcesFromCalendar(`
      <a href="/monetarypolicy/fomcpresconf20260429.htm">Press Conference</a>
      <a href="/monetarypolicy/fomcminutes20260429.htm">HTML</a>
      <a href="/monetarypolicy/fomcpresconf20260617.htm">Future Press Conference</a>
      <a href="/monetarypolicy/fomcminutes20260617.htm">Future Minutes</a>
    `, new Date("2026-05-01T00:00:00.000Z"));
    expect(sources).toEqual([
      { eventType: "press_conference", meetingDate: "2026-04-29", sourceUrl: "https://www.federalreserve.gov/monetarypolicy/fomcpresconf20260429.htm" },
      { eventType: "minutes", meetingDate: "2026-04-29", sourceUrl: "https://www.federalreserve.gov/monetarypolicy/fomcminutes20260429.htm" },
    ]);
  });
});
