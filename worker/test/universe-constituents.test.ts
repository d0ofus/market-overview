import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractIsharesHoldingsCsvUrl,
  parseIsharesHoldingsCsv,
  parseIsharesHoldingsCsvDetailed,
  parseNasdaqTradedActiveEquities,
  parseNasdaqTradedCommonStocks,
  parseNasdaqTraderFileCreationDate,
  parseSp500Csv,
  loadSp500Universe,
  loadRussell2000Universe,
} from "../src/universe-constituents";

afterEach(() => vi.unstubAllGlobals());

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

    expect(parseNasdaqTradedCommonStocks(sample).map((row) => row.symbol)).toEqual(["CLDT"]);
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

  it("retains class shares and beneficial-interest common shares without retaining warrants", () => {
    const sample = [
      "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares",
      "Y|BRK.B|Berkshire Hathaway Class B Common Stock|N||N|100|N||BRK.B|BRK.B|N",
      "Y|CLDT|Chatham Lodging Trust Common Shares of Beneficial Interest|N||N|100|N||CLDT|CLDT|N",
      "Y|ABCD.W|ABCD Warrant|Q||N|100|N||ABCD.W|ABCD.W|N",
      "File Creation Time: 0908202618:00",
    ].join("\n");
    expect(parseNasdaqTradedCommonStocks(sample).map((row) => row.symbol)).toEqual(["BRK.B", "CLDT"]);
  });

  it("does not remove S&P constituents missing from a secondary directory", async () => {
    const tickers = ["BRK.B", "BF.B", ...Array.from({ length: 498 }, (_, index) => `T${index}`)];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`Symbol,Security\n${tickers.map((ticker) => `${ticker},Company`).join("\n")}`)));
    const result = await loadSp500Universe(new Set(tickers.slice(2)));
    expect(result.tickers).toHaveLength(500);
    expect(result.tickers).toContain("BRK.B");
    expect(result.tickers).toContain("BF.B");
  });

  it("discovers an alternate IWM export after an HTTP200 malformed primary payload", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("<html>Temporarily unavailable</html>"))
      .mockResolvedValueOnce(new Response('<a href="/us/products/239710/alternate-holdings.csv">Holdings</a>'))
      .mockResolvedValueOnce(new Response("iShares Russell 2000 ETF\nFund Holdings as of,Sep 04, 2026\nTicker,Name,Asset Class\nAAA,Company,Equity"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await loadRussell2000Universe();
    expect(result.tickers).toEqual(["AAA"]);
    expect(result.sourceUrl).toContain("alternate-holdings.csv");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps valid IWM holdings absent from the secondary directory in the coverage population", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "iShares Russell 2000 ETF\nFund Holdings as of,Sep 04, 2026\nTicker,Name,Asset Class\nAAA,Company,Equity\nBRK-B,Berkshire,Equity",
    )));
    const result = await loadRussell2000Universe(new Set(["BRK.B"]));
    expect(result.tickers).toEqual(["AAA", "BRK.B"]);
    expect(result.unresolvedTickers).toContain("AAA");
    expect(result.memberMetadata.AAA?.sourceTicker).toBe("AAA");
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
