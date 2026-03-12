import { describe, expect, it } from "vitest";
import { buildPeerMetricRows } from "../src/peer-metrics-service";

describe("peer metrics service", () => {
  it("builds market cap and average volume from Alpaca-backed inputs", () => {
    const rows = buildPeerMetricRows(
      ["AAPL", "MSFT"],
      "2026-03-12T00:00:00.000Z",
      {
        AAPL: { price: 200, prevClose: 198 },
      },
      [
        { ticker: "AAPL", date: "2026-03-10", c: 199, volume: 100 },
        { ticker: "AAPL", date: "2026-03-11", c: 200, volume: 200 },
        { ticker: "MSFT", date: "2026-03-11", c: 300, volume: 300 },
      ],
      new Map([
        ["AAPL", 1000],
        ["MSFT", null],
      ]),
    );

    expect(rows[0]).toMatchObject({
      ticker: "AAPL",
      price: 200,
      marketCap: 200000,
      avgVolume: 150,
      source: "alpaca+seeded-shares",
    });
    expect(rows[1]).toMatchObject({
      ticker: "MSFT",
      price: 300,
      marketCap: null,
      avgVolume: 300,
      source: "alpaca",
    });
  });
});

