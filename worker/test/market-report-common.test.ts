import { describe, expect, it } from "vitest";
import { sanitizeInternalSourceMarkdownLinks, sourceCitationPolicyPrompt } from "../src/market-report-common";

describe("market report citation policy", () => {
  it("strips markdown links Gemini attaches to internal app sources while preserving external links", () => {
    const markdown = [
      "Breadth improved in [Daily - Above 200 SMA](https://home.treasury.gov/news/press-releases) while [Reuters](https://www.reuters.com/markets/) reported macro context.",
      "Internal app source [/scans compiled preset: Daily - Above 200 SMA](https://example.com/wrong) should be plain text.",
    ].join("\n");

    const sanitized = sanitizeInternalSourceMarkdownLinks(markdown, [
      {
        sourceName: "/scans compiled preset: Daily - Above 200 SMA",
        url: null,
        dataUsed: "Refreshed compiled scan rows for breadth, leadership, and notable trader-attention movers",
        timestamp: "2026-06-16T10:00:00.000Z",
      },
      {
        sourceName: "Reuters",
        url: "https://www.reuters.com/markets/",
        dataUsed: "News context",
        timestamp: "2026-06-16T10:00:00.000Z",
      },
    ]);

    expect(sanitized).toContain("Daily - Above 200 SMA while [Reuters](https://www.reuters.com/markets/) reported macro context.");
    expect(sanitized).toContain("Internal app source /scans compiled preset: Daily - Above 200 SMA should be plain text.");
    expect(sanitized).not.toContain("home.treasury.gov/news/press-releases");
    expect(sanitized).not.toContain("example.com/wrong");
  });

  it("tells Gemini to cite internal app sources as plain text instead of markdown links", () => {
    expect(sourceCitationPolicyPrompt()).toContain("Only create markdown links");
    expect(sourceCitationPolicyPrompt()).toContain("url");
    expect(sourceCitationPolicyPrompt()).toContain("Internal app sources");
    expect(sourceCitationPolicyPrompt()).toContain("plain text");
  });
});
