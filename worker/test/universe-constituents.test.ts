import { describe, expect, it } from "vitest";
import { parseDisfoldRussell2000Page, parseNasdaqTradedCommonStocks, parseSp500Csv } from "../src/universe-constituents";

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

  it("extracts Russell page tickers and page count from Disfold html", () => {
    const html = `
      <a href="/stocks/quote/AAON/">AAON</a>
      <a href="/stocks/quote/ABUS/">ABUS</a>
      <a href="/stocks/quote/AAON/">AAON</a>
      <a href="https://disfold.com/stock-index/stock-index/russell-2000/?page=2">2</a>
      <a href="https://disfold.com/stock-index/stock-index/russell-2000/?page=67">67</a>
    `;

    const parsed = parseDisfoldRussell2000Page(html);
    expect(parsed.tickers).toEqual(["AAON", "ABUS"]);
    expect(parsed.maxPage).toBe(67);
  });
});
