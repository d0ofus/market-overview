import { describe, expect, it } from "vitest";
import { parseResearchLabTickerInput } from "../src/research-lab/schemas";

describe("research lab ticker parsing", () => {
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
});
