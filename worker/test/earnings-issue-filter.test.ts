import { describe, expect, it } from "vitest";
import {
  getEarningsEligibilityExclusionReasons,
  getEarningsIssueExclusionReasons,
  isEligibleEarningsCatalogSymbol,
} from "../src/earnings-issue-filter";

describe("earnings issue eligibility", () => {
  it("classifies preferred, debt, fund-like, and OTC rows with reasons", () => {
    expect(getEarningsIssueExclusionReasons({
      ticker: "FBIOP",
      companyName: "Fortress Biotech Series A Cumulative Redeemable Perpetual Preferred Stock",
    })).toEqual(expect.arrayContaining(["Preferred/security text"]));

    expect(getEarningsIssueExclusionReasons({
      ticker: "ABCN",
      companyName: "ABC Holdings 6.250% Senior Notes due 2030",
    })).toEqual(expect.arrayContaining(["Debt/bond/note security text"]));

    expect(getEarningsIssueExclusionReasons({
      ticker: "XYZW",
      companyName: "XYZ Acquisition Corp. Warrants",
    })).toEqual(expect.arrayContaining(["Fund/unit/warrant/right security text"]));

    expect(getEarningsEligibilityExclusionReasons({
      ticker: "OTCM",
      exchange: "OTC",
      companyName: "OTC Markets Group Inc.",
    }, { enforceMajorExchange: true })).toEqual(["OTC or non-major exchange"]);
  });

  it("allows ordinary common and ADR rows unless catalog validation rejects them", () => {
    expect(getEarningsEligibilityExclusionReasons({
      ticker: "BABA",
      exchange: "NYSE",
      companyName: "Alibaba Group Holding Limited American Depositary Shares",
      isActive: 1,
      catalogManaged: 1,
      assetClass: "equity",
    }, { enforceMajorExchange: true, catalogActive: true })).toEqual([]);

    expect(isEligibleEarningsCatalogSymbol({
      isActive: 1,
      catalogManaged: 1,
      assetClass: "equity",
      listingSource: "nasdaqtrader",
    })).toBe(true);

    expect(getEarningsEligibilityExclusionReasons({
      ticker: "MISSING",
      exchange: "NASDAQ",
      companyName: "Missing Catalog Inc.",
      isActive: null,
      catalogManaged: null,
      assetClass: null,
    }, { enforceMajorExchange: true, catalogActive: true })).toEqual(["Not in active Nasdaq Trader common-stock catalog"]);
  });
});
