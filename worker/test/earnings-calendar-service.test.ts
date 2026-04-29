import { describe, expect, it } from "vitest";
import {
  dedupeProviderEvents,
  findRelevantEarningsFiling,
  hasEarningsReleaseWindowPassed,
  parseAlphaVantageEarningsCalendarCsv,
} from "../src/earnings-calendar-service";

describe("earnings calendar parsing", () => {
  it("parses Alpha Vantage earnings calendar CSV rows", () => {
    const rows = parseAlphaVantageEarningsCalendarCsv([
      "symbol,name,reportDate,fiscalDateEnding,estimate,currency",
      'AAPL,"Apple, Inc.",2026-05-01,2026-03-31,1.52,USD',
      "MSFT,Microsoft Corp,2026-05-02,2026-03-31,,USD",
    ].join("\n"));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ticker: "AAPL",
      companyName: "Apple, Inc.",
      scheduledDate: "2026-05-01",
      fiscalPeriod: "2026-03-31",
      epsEstimate: 1.52,
      provider: "alpha_vantage",
    });
    expect(rows[1]?.epsEstimate).toBeNull();
  });

  it("surfaces Alpha Vantage JSON error messages clearly", () => {
    expect(() => parseAlphaVantageEarningsCalendarCsv(JSON.stringify({
      Information: "The standard API rate limit is 25 requests per day.",
    }))).toThrow("Alpha Vantage earnings calendar error: The standard API rate limit is 25 requests per day.");
  });

  it("dedupes provider events and keeps the higher-confidence row while filling blanks", () => {
    const rows = dedupeProviderEvents([
      {
        ticker: "AAPL",
        companyName: "Apple Inc.",
        scheduledDate: "2026-05-01",
        timeHint: null,
        fiscalPeriod: "2026-03-31",
        epsEstimate: 1.5,
        revenueEstimate: null,
        epsActual: null,
        revenueActual: null,
        provider: "alpha_vantage",
        providerConfidence: 0.7,
      },
      {
        ticker: "AAPL",
        companyName: null,
        scheduledDate: "2026-05-01",
        timeHint: "amc",
        fiscalPeriod: "2026-03-31",
        epsEstimate: null,
        revenueEstimate: 100,
        epsActual: 1.6,
        revenueActual: null,
        provider: "finnhub",
        providerConfidence: 0.8,
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "finnhub",
      companyName: "Apple Inc.",
      timeHint: "amc",
      epsEstimate: 1.5,
      revenueEstimate: 100,
      epsActual: 1.6,
    });
  });
});

describe("earnings SEC readiness", () => {
  it("recognizes relevant earnings filings", () => {
    const filing = findRelevantEarningsFiling([
      {
        accessionNumber: "not-earnings",
        form: "8-K",
        filingDate: "2026-05-01",
        reportDate: "2026-03-31",
        primaryDocument: "current-report.htm",
        primaryDocDescription: "Current report",
        items: "Item 5.02",
      },
      {
        accessionNumber: "earnings",
        form: "8-K",
        filingDate: "2026-05-01",
        reportDate: "2026-03-31",
        primaryDocument: "earnings-release.htm",
        primaryDocDescription: "Results of Operations and Financial Condition",
        items: "Item 2.02",
      },
    ], "2026-05-01");

    expect(filing?.accessionNumber).toBe("earnings");
  });

  it("recognizes periodic reports as SEC-ready events", () => {
    const filing = findRelevantEarningsFiling([
      {
        accessionNumber: "ten-q",
        form: "10-Q",
        filingDate: "2026-05-03",
        reportDate: "2026-03-31",
        primaryDocument: "form10q.htm",
        primaryDocDescription: "Quarterly report",
        items: null,
      },
    ], "2026-05-01");

    expect(filing?.accessionNumber).toBe("ten-q");
  });

  it("uses release windows for bmo, amc, and unknown timings in New York time", () => {
    expect(hasEarningsReleaseWindowPassed(
      { scheduledDate: "2026-05-01", timeHint: "bmo" },
      new Date("2026-05-01T13:29:00Z"),
    )).toBe(false);
    expect(hasEarningsReleaseWindowPassed(
      { scheduledDate: "2026-05-01", timeHint: "bmo" },
      new Date("2026-05-01T13:30:00Z"),
    )).toBe(true);
    expect(hasEarningsReleaseWindowPassed(
      { scheduledDate: "2026-05-01", timeHint: "amc" },
      new Date("2026-05-01T20:14:00Z"),
    )).toBe(false);
    expect(hasEarningsReleaseWindowPassed(
      { scheduledDate: "2026-05-01", timeHint: null },
      new Date("2026-05-01T20:15:00Z"),
    )).toBe(true);
  });
});
