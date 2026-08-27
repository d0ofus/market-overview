import { describe, expect, it } from "vitest";
import {
  extractIsharesHoldingsCsvUrl,
  parseIsharesHoldingsCsv,
  parseIsharesHoldingsCsvDetailed,
  parseNasdaqTradedActiveEquities,
  parseNasdaqTradedCommonStocks,
  parseNasdaqTraderFileCreationDate,
  parseSp500Csv,
} from "../src/universe-constituents";

describe("universe constituent parsers", () => {
  it("applies NasdaqTrader common-stock filters", () => {
    const sample = [
      "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares",
      "Y|AAPL|Apple Inc. Common Stock|Q|Q|N|100|N|N|AAPL|AAPL|N",
      "Y|SPY|SPDR S&P 500 ETF Trust|P||Y|100|N||SPY|SPY|N",
      "Y|ABCD.W|ABCD Warrant|Q|Q|N|100|N||ABCD.W|ABCD.W|N",
      "Y|XYZ|XYZ Preferred Shares|N||N|100|N||XYZ|XYZ|N",
      "File Creation Time: 0304202618:00",
    ].join("\n");

    const rows = parseNasdaqTradedCommonStocks(sample);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      symbol: "AAPL",
      securityName: "Apple Inc. Common Stock",
      listingExchange: "Q",
    });
    expect(parseNasdaqTraderFileCreationDate(sample)).toBe("2026-03-04");
  });

  it("fails closed when NasdaqTrader File Creation Time is absent or malformed", () => {
    expect(parseNasdaqTraderFileCreationDate("Nasdaq Traded|Symbol\nY|AAPL")).toBeNull();
    expect(parseNasdaqTraderFileCreationDate("File Creation Time: tomorrow")).toBeNull();
  });

  it("keeps active listed equities for provider resolution without the common-stock name blacklist", () => {
    const sample = [
      "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares",
      "Y|CLDT|Chatham Lodging Trust Common Shares of Beneficial Interest|N||N|100|N||CLDT|CLDT|N",
      "Y|SPY|SPDR S&P 500 ETF Trust|P||Y|100|N||SPY|SPY|N",
      "File Creation Time: 0304202618:00",
    ].join("\n");

    expect(parseNasdaqTradedCommonStocks(sample)).toEqual([]);
    expect(parseNasdaqTradedActiveEquities(sample).map((row) => row.symbol)).toEqual(["CLDT"]);
  });

  it("parses S&P 500 csv symbols", () => {
    const csv = [
      "Symbol,Security,GICS Sector",
      "AAPL,Apple Inc.,Information Technology",
      "BRK.B,Berkshire Hathaway,Financials",
      "\"BF.B\",\"Brown-Forman\",Consumer Staples",
    ].join("\n");

    const symbols = parseSp500Csv(csv);
    expect(symbols).toEqual(["AAPL", "BF.B", "BRK.B"]);
  });

  it("parses the iShares IWM holdings export used as the Russell proxy", () => {
    const csv = [
      "iShares Russell 2000 ETF",
      "Fund Holdings as of,Jul 20, 2026",
      "Ticker,Name,Sector,Asset Class,Market Value",
      "AA,ALCOA CORP,Materials,Equity,100",
      "BRK.B,BERKSHIRE HATHAWAY,Financials,Equity,200",
      "USD,USD CASH,Cash and/or Derivatives,Cash,50",
      "FUT1,RUSSELL FUTURE,Cash and/or Derivatives,Futures,25",
    ].join("\n");
    expect(parseIsharesHoldingsCsv(csv)).toEqual(["AA", "BRK.B"]);
  });

  it("preserves IWM provenance and excludes non-market residual positions", () => {
    const csv = [
      "iShares Russell 2000 ETF",
      "Fund Holdings as of,Jul 20, 2026",
      "Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Quantity,Price,Exchange",
      "AA,ALCOA CORP,Materials,Equity,100,0.10,10,10.00,NYSE",
      "AA,ALCOA CORP DUPLICATE,Materials,Equity,100,0.10,10,10.00,NYSE",
      "INH,INHIBRX INC CVR,Health Care,Equity,5,0.00,5,1.00,NO MARKET (E.G. UNLISTED)",
      "PDLI,PDL BIOPHARMA INC,Health Care,Equity,0.12,0.00,11853,0.00,NASDAQ",
      "BAD/ID,BAD IDENTIFIER,Health Care,Equity,10,0.00,10,1.00,NASDAQ",
      ",MISSING IDENTIFIER,Health Care,Equity,10,0.00,10,1.00,NASDAQ",
      "USD,USD CASH,Cash and/or Derivatives,Cash,50,0.05,50,1.00,-",
    ].join("\n");

    expect(parseIsharesHoldingsCsvDetailed(csv)).toMatchObject({
      sourceAsOfDate: "2026-07-20",
      sourceEquityCount: 6,
      duplicateTickerCount: 1,
      blankTickerCount: 1,
      tickers: ["AA"],
      excludedCount: 5,
      holdings: [{ sourceTicker: "AA", issuerName: "ALCOA CORP", exchange: "NYSE", assetClass: "Equity" }],
      invalidSourceIdentifiers: ["(blank row 9)", "BAD/ID"],
      duplicateSourceIdentifiers: ["AA"],
      excludedSourceIdentifiers: ["non-market:INH", "residual:PDLI"],
    });
  });

  it("accepts a production-shaped IWM membership and discovers only same-origin CSV links", () => {
    const rows = Array.from({ length: 1_964 }, (_, index) =>
      `R${String(index).padStart(4, "0")},Russell Member ${index},Industrials,Equity,100,0.05,10,10.00,NASDAQ`
    );
    const csv = [
      "iShares Russell 2000 ETF",
      "Fund Holdings as of,Jul 29, 2026",
      "Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Quantity,Price,Exchange",
      ...rows,
    ].join("\n");
    const parsed = parseIsharesHoldingsCsvDetailed(csv);
    expect(parsed.sourceAsOfDate).toBe("2026-07-29");
    expect(parsed.sourceEquityCount).toBe(1_964);
    expect(parsed.tickers).toHaveLength(1_964);

    expect(extractIsharesHoldingsCsvUrl('<a class="holdings-csv-link" href="/us/products/239710/ishares-russell-2000-etf/latest-holdings.csv">Download</a>'))
      .toBe("https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/latest-holdings.csv");
    expect(extractIsharesHoldingsCsvUrl('<a href="https://evil.example/holdings.csv">Download</a>')).toBeNull();
  });
});
