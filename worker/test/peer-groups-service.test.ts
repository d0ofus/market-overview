import { describe, expect, it } from "vitest";
import { isUsBootstrapTickerCandidate, isUsEquityExchange, isValidBootstrapRootTicker, mergeMembershipSource, normalizePeerGroupType, slugifyPeerGroupName } from "../src/peer-groups-service";

describe("peer groups service helpers", () => {
  it("slugifies peer group names", () => {
    expect(slugifyPeerGroupName("AAPL Fundamental Peers")).toBe("aapl-fundamental-peers");
    expect(slugifyPeerGroupName("  Tech & Momentum  ")).toBe("tech-momentum");
  });

  it("normalizes peer group types", () => {
    expect(normalizePeerGroupType("technical")).toBe("technical");
    expect(normalizePeerGroupType("custom")).toBe("custom");
    expect(normalizePeerGroupType("anything-else")).toBe("fundamental");
  });

  it("preserves manual source precedence and combines seed sources into system", () => {
    expect(mergeMembershipSource("manual", "fmp_seed")).toBe("manual");
    expect(mergeMembershipSource("fmp_seed", "finnhub_seed")).toBe("system");
    expect(mergeMembershipSource(undefined, "finnhub_seed")).toBe("finnhub_seed");
  });

  it("rejects malformed bootstrap root tickers", () => {
    expect(isValidBootstrapRootTicker("AAPL")).toBe(true);
    expect(isValidBootstrapRootTicker("BRK.B")).toBe(true);
    expect(isValidBootstrapRootTicker("BF.B")).toBe(true);
    expect(isValidBootstrapRootTicker("AEM.TO")).toBe(false);
    expect(isValidBootstrapRootTicker("BOZ6")).toBe(false);
    expect(isValidBootstrapRootTicker("-")).toBe(false);
    expect(isValidBootstrapRootTicker("24.21")).toBe(false);
    expect(isValidBootstrapRootTicker("40.47")).toBe(false);
  });

  it("recognizes US exchanges for bootstrap filtering", () => {
    expect(isUsEquityExchange("NASDAQ")).toBe(true);
    expect(isUsEquityExchange("NYSE")).toBe(true);
    expect(isUsEquityExchange("NASDAQ NMS - GLOBAL MARKET")).toBe(true);
    expect(isUsEquityExchange("NEW YORK STOCK EXCHANGE, INC.")).toBe(true);
    expect(isUsEquityExchange("NYSE MKT LLC")).toBe(true);
    expect(isUsEquityExchange("TSX")).toBe(false);
    expect(isUsEquityExchange("TSXV")).toBe(false);
    expect(isUsEquityExchange("SWISS EXCHANGE")).toBe(false);
  });

  it("rejects foreign-suffixed or non-US bootstrap roots", () => {
    expect(isUsBootstrapTickerCandidate("AAPL", null)).toBe(true);
    expect(isUsBootstrapTickerCandidate("BRK.B", "NYSE")).toBe(true);
    expect(isUsBootstrapTickerCandidate("BRK.B", null)).toBe(false);
    expect(isUsBootstrapTickerCandidate("AGY.L", null)).toBe(false);
    expect(isUsBootstrapTickerCandidate("AHR.V", null)).toBe(false);
    expect(isUsBootstrapTickerCandidate("ALC", "SWISS EXCHANGE")).toBe(false);
  });
});
