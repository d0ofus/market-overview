import { describe, expect, it } from "vitest";
import { parseGlobalXDelimitedRows } from "../src/etf";

describe("ETF constituent parsers", () => {
  it("parses Global X full holdings csv rows", () => {
    const csv = [
      "Fund Holdings as of 2026-03-09",
      'Ticker,Name,Sector,Weightings,Shares,Market Value',
      'CCJ US,Cameco Corp,Energy,24.77%,100,1000',
      'NXE CN,NexGen Energy Ltd,Energy,7.35%,100,1000',
      'URNM US,Sprott Uranium Miners ETF,Energy,5.10%,100,1000',
    ].join("\n");

    expect(parseGlobalXDelimitedRows(csv)).toEqual([
      { ticker: "CCJ", name: "Cameco Corp", weight: 24.77 },
      { ticker: "NXE", name: "NexGen Energy Ltd", weight: 7.35 },
      { ticker: "URNM", name: "Sprott Uranium Miners ETF", weight: 5.1 },
    ]);
  });

  it("normalizes slash and numeric-style Global X symbols", () => {
    const csv = [
      "Holdings",
      'Symbol,Security Name,Weightings',
      'BRK/B US,Berkshire Hathaway Inc Class B,3.20%',
      '388 HK,Hong Kong Exchanges & Clearing Ltd,2.10%',
    ].join("\n");

    expect(parseGlobalXDelimitedRows(csv)).toEqual([
      { ticker: "BRK.B", name: "Berkshire Hathaway Inc Class B", weight: 3.2 },
      { ticker: "388", name: "Hong Kong Exchanges & Clearing Ltd", weight: 2.1 },
    ]);
  });
});
