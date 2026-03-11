import { describe, expect, it } from "vitest";
import { compiledRowsToCsv, uniqueTickersToCsv } from "../src/scanning-service";
import type { ScanCompiledRow, ScanUniqueTickerRow } from "../src/scanning-types";

describe("scanning service helpers", () => {
  it("renders compiled rows to csv", () => {
    const rows: ScanCompiledRow[] = [
      {
        id: "1",
        runId: "run-1",
        scanId: "scan-1",
        ticker: "NVDA",
        displayName: "NVIDIA Corp",
        exchange: "NASDAQ",
        providerRowKey: "row-1",
        rankValue: 99.5,
        rankLabel: "Momentum",
        price: 120.25,
        change1d: 2.15,
        volume: 1000,
        marketCap: 1000000,
        rawJson: "{\"ticker\":\"NVDA\"}",
        canonicalKey: "NVDA|abc",
        createdAt: "2026-03-11T00:00:00.000Z",
      },
    ];

    const csv = compiledRowsToCsv(rows);
    expect(csv).toContain("ticker,display_name,exchange");
    expect(csv).toContain("NVDA,NVIDIA Corp,NASDAQ");
  });

  it("renders unique tickers with occurrence counts", () => {
    const rows: ScanUniqueTickerRow[] = [
      {
        ticker: "PLTR",
        displayName: "Palantir",
        occurrences: 3,
        latestRankValue: 87.4,
        latestRankLabel: "Strength",
        latestPrice: 31.55,
        latestChange1d: -1.2,
      },
    ];

    const csv = uniqueTickersToCsv(rows);
    expect(csv).toContain("ticker,display_name,occurrences");
    expect(csv).toContain("PLTR,Palantir,3,87.4,Strength,31.55,-1.2");
  });
});
