import { describe, expect, it } from "vitest";
import { normalizeNewsCandidates } from "../src/alerts-news";

describe("alerts news normalization", () => {
  it("deduplicates by canonical URL/headline and keeps top rows", () => {
    const rows = normalizeNewsCandidates(
      "AAPL",
      "2026-03-02",
      [
        {
          headline: "Apple launches new AI feature",
          source: "Reuters",
          url: "https://example.com/story?utm_source=newsletter&id=1",
          publishedAt: "2026-03-02T15:00:00Z",
          snippet: "First copy",
        },
        {
          headline: "Apple launches new AI feature",
          source: "Reuters",
          url: "https://www.example.com/story?id=1&utm_medium=email",
          publishedAt: "2026-03-02T15:01:00Z",
          snippet: "Duplicate copy",
        },
        {
          headline: "Apple supplier update",
          source: "Bloomberg",
          url: "https://news.example.org/article/2",
          publishedAt: "2026-03-02T16:30:00Z",
          snippet: "Second story",
        },
      ],
      3,
      "2026-03-02T17:00:00Z",
    );

    expect(rows.length).toBe(2);
    expect(rows[0].ticker).toBe("AAPL");
    expect(rows[0].canonicalKey).not.toBe(rows[1].canonicalKey);
  });
});

